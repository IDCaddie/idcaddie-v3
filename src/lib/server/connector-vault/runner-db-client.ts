// Server-only RUNNER DB CLIENT — wires the verified `connector_runner` DB execution boundary to the existing
// Slack `oauth_pending` seams (docs/42 §54, gated vault). It backs the PR #128 `SlackPendingInserter`
// (authorize-time INSERT) and the PR #120/#116 `OAuthPendingConsumer` (callback consume) with a real
// runner-role session — executing `SET ROLE connector_runner` before every runner operation, against the
// staging+production-verified `0021`/`0022` grants. **Slack remains non-functional for real connections.**
// It exchanges NO code, stores NO token/credential, touches NO `connector_secrets`, calls NO Slack API, and
// runs NO sync.
//
// THE CONNECTION IS AN INJECTED SEAM (no DB driver dependency, no service-role/global client). The runner
// connects as `connector_runner_login` (LOGIN + NOINHERIT, no direct grants — §53) and `SET ROLE
// connector_runner`s into the narrow grants. That real connection (a server-only Postgres pool bound to
// `connector_runner_login`) is provided by the FUTURE hosted runner via the injected `RunnerConnection`;
// this module owns only the SET-ROLE-wrapping + the parameterized statement shapes. Tests inject a mock, so
// there is NO live DB call, NO credentials, and NO global client here.
//
// LEAST PRIVILEGE BY CONSTRUCTION. The authorize INSERT names ONLY the 9 `0022`-granted authorize-time
// columns (never `consumed_at`/`attempt_count`/`last_rejected_code`); the consume reuses the §38 executor
// (SELECT + the `consumed_at`/attempt UPDATE only). Every statement is parameterized; raw query execution is
// not exposed to app/browser code. Errors are redacted to safe labels (a fixed message / a safe reason) —
// never a raw DB error/secret.
//
// SERVER-ONLY: under `src/lib/server/`, the runtime browser sentinel below, and `no-client-import.test.ts`.
// Library/server-only — NO app route, NO connect button, NO browser-accessible service-role path.

import {
  createOAuthPendingExecutor,
  type RunnerDbClient,
} from "./oauth-pending-executor";
import type { OAuthPendingConsumer } from "./oauth-pending-consume";
import type { SlackPendingInserter } from "./providers/slack-authorize-pending";

// Runtime server-only sentinel — throw if evaluated in a browser.
if (typeof (globalThis as { window?: unknown }).window !== "undefined") {
  throw new Error("connector-vault/runner-db-client is server-only and must not be imported in client code");
}

export class RunnerDbError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RunnerDbError";
  }
}

// The low-level injected runner connection — a server-only Postgres session bound to `connector_runner_login`
// that the FUTURE hosted runner provides. `runSequence` runs the given parameterized statements IN ORDER on
// ONE connection (so a leading `set role connector_runner` applies to the statements after it). NEVER a
// service-role / global client; NEVER reachable from request/browser code. Tests inject a mock.
export interface RunnerConnection {
  runSequence(
    statements: ReadonlyArray<{ sql: string; params: readonly unknown[] }>,
  ): Promise<Array<{ rows: ReadonlyArray<Record<string, unknown>> }>>;
}

// The role the runner SET ROLEs into before every operation (NOINHERIT login → no ambient privilege).
const SET_ROLE_STMT = { sql: "set role connector_runner", params: [] as readonly unknown[] };

// The authorize-time INSERT — ONLY the 9 `0022`-granted columns. It NEVER names `consumed_at`,
// `attempt_count`, or `last_rejected_code` (those fall to their defaults / are set only by the consume path).
const INSERT_OAUTH_PENDING_SQL =
  "insert into public.oauth_pending " +
  "(tenant_id, organization_id, connector_id, provider, subject, state_jti, nonce_hash, intent, expires_at) " +
  "values ($1, $2, $3, $4, $5, $6, $7, $8, $9)";

function isUniqueViolation(e: unknown): boolean {
  const code = (e as { code?: unknown } | null)?.code;
  if (code === "23505") return true; // Postgres unique_violation
  const msg = (e as { message?: unknown } | null)?.message;
  return typeof msg === "string" && /duplicate key|unique constraint/i.test(msg);
}

function assertConn(conn: RunnerConnection): void {
  if (!conn || typeof conn.runSequence !== "function")
    throw new RunnerDbError("missing or invalid runner connection");
}

// The PR #120 `RunnerDbClient` (`run(sql, params)`) backed by the runner connection — it prepends
// `SET ROLE connector_runner` and returns the LAST statement's rows. Fails closed (redacted) on DB error.
export function createRunnerDbClient(conn: RunnerConnection): RunnerDbClient {
  assertConn(conn);
  return {
    async run(sql, params) {
      let results: Array<{ rows: ReadonlyArray<Record<string, unknown>> }>;
      try {
        results = await conn.runSequence([SET_ROLE_STMT, { sql, params }]);
      } catch {
        // swallow the raw DB error — never surface its body / a bound value.
        throw new RunnerDbError("runner db operation failed");
      }
      return results[results.length - 1] ?? { rows: [] };
    },
  };
}

// The PR #128 `SlackPendingInserter` backed by the runner connection — `SET ROLE connector_runner` + the
// parameterized authorize-time INSERT of ONLY the 9 allowed columns. Fails closed: a UNIQUE(state_jti|
// nonce_hash) conflict → `duplicate`; any other failure → `db_error` (redacted; never a raw error/value).
export function createRunnerPendingInserter(conn: RunnerConnection): SlackPendingInserter {
  assertConn(conn);
  return {
    async insertPending(row) {
      try {
        await conn.runSequence([
          SET_ROLE_STMT,
          {
            sql: INSERT_OAUTH_PENDING_SQL,
            params: [
              row.tenantId,
              row.organizationId,
              row.connectorId,
              row.provider,
              row.subject,
              row.stateJti,
              row.nonceHash,
              row.intent,
              row.expiresAt,
            ],
          },
        ]);
        return { ok: true };
      } catch (e) {
        return { ok: false, reason: isUniqueViolation(e) ? "duplicate" : "db_error" };
      }
    },
  };
}

// The PR #116/#120 `OAuthPendingConsumer` backed by the runner connection — the §38 single-use consume +
// read-only classify, each running as `connector_runner` (the executor uses the SET-ROLE-wrapping client).
export function createRunnerOAuthPendingConsumer(conn: RunnerConnection): OAuthPendingConsumer {
  return createOAuthPendingExecutor(createRunnerDbClient(conn));
}
