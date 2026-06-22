// Server-only RUNNER executor wiring for the OAuth `oauth_pending` single-use consume (docs/42
// §16/§32.3/§38/§42, gated vault).
//
// This is the concrete `OAuthPendingConsumer` (the PR #116 boundary) backed by an INJECTED runner DB
// client — the wiring a FUTURE connector runner uses to perform the atomic single-use consume through the
// `connector_runner` role (NOLOGIN + BYPASSRLS, granted ONLY `oauth_pending` SELECT + a column-scoped
// UPDATE — migration `0021`, T43, staging-verified). It does NOT exchange OAuth codes, store any
// token/credential, touch `connector_secrets`, import a Supabase client, use a service-role / global
// admin client, or import a provider connector. **The vault stays NOT usable for real credentials.**
//
// DENY-ALL / BROWSER POSTURE PRESERVED. `oauth_pending`/`connector_secrets` stay deny-all to anon/
// authenticated (`0017`/`0020`/`0021`). This executor is reached ONLY from the server-only runner
// entrypoint — NEVER an app route, server action, or browser/request path (the `no-client-import` guard +
// the static route scan enforce it). The runner DB client is **explicitly injected** (no global
// service-role client is created here); `createOAuthPendingExecutor` **fails closed** if it is missing.
//
// IT ONLY DOES THE CONSUME. `runAtomicConsume` issues ONE parameterized statement that matches on
// tenant_id/provider/state_jti/nonce_hash/connector_id (null-safe) + `consumed_at is null` +
// `expires_at > now`, and updates ONLY `consumed_at` (within the `0021` 3-column grant; the immutable
// identity columns are never set). `readPendingState` is a read-only classify lookup. Both delegate to the
// injected client — tests inject a MOCK, so there is NO live DB call and NO credentials in tests.
//
// REDACTION (docs/42 §11): a DB failure throws a typed `OAuthPendingExecutorError` with a fixed safe
// message — NEVER the raw DB error, a raw nonce, raw state, OAuth code, provider payload, token, or secret.
// The SQL carries the nonce HASH + ids as bound PARAMETERS (never the raw nonce; nothing is logged).
//
// SERVER-ONLY: under `src/lib/server/`, the runtime browser sentinel below, and `no-client-import.test.ts`.
// Its only import is the TYPES from `./oauth-pending-consume` (erased at runtime) — no DB, no Supabase, no
// service-role, no `process.env`, no provider connector.

import type {
  OAuthPendingConsumer,
  OAuthPendingRowState,
} from "./oauth-pending-consume";

// Runtime server-only sentinel — throw if evaluated in a browser.
if (typeof (globalThis as { window?: unknown }).window !== "undefined") {
  throw new Error("connector-vault/oauth-pending-executor is server-only and must not be imported in client code");
}

export class OAuthPendingExecutorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OAuthPendingExecutorError";
  }
}

// The minimal runner DB boundary this executor needs (the future runner provides a server-only Postgres
// connection bound to the `connector_runner` role — NOLOGIN + BYPASSRLS, narrow `0021` grants). It is
// EXPLICITLY INJECTED — this module creates NO global service-role / admin client. Tests inject a mock.
export interface RunnerDbClient {
  // Run a parameterized statement as `connector_runner` and return the result rows. MUST be a server-only
  // connection, NEVER reachable from request/browser code.
  run(sql: string, params: readonly unknown[]): Promise<{ rows: ReadonlyArray<Record<string, unknown>> }>;
}

// The two statements the consume needs. They set ONLY `consumed_at` (within the `0021` grant) and read only
// the safe classify columns. The nonce HASH + ids are bound parameters, never inlined / logged.
const CONSUME_SQL =
  "update public.oauth_pending set consumed_at = $1 " +
  "where state_jti = $2 and nonce_hash = $3 and tenant_id = $4 and provider = $5 " +
  "and connector_id is not distinct from $6 and consumed_at is null and expires_at > $1 " +
  "returning state_jti, consumed_at";

const READ_STATE_SQL =
  "select tenant_id, provider, connector_id, nonce_hash, consumed_at, expires_at " +
  "from public.oauth_pending where state_jti = $1";

function asNullableString(v: unknown): string | null {
  return v == null ? null : String(v);
}

// Build the runner-backed `OAuthPendingConsumer` for the pure `consumeOAuthPending` (PR #116). FAILS CLOSED
// when the runner DB client is missing/invalid — an unconfigured runner can never silently no-op.
export function createOAuthPendingExecutor(client: RunnerDbClient): OAuthPendingConsumer {
  if (!client || typeof client.run !== "function")
    throw new OAuthPendingExecutorError("missing or invalid runner DB client");

  return {
    async runAtomicConsume(params: {
      tenantId: string;
      provider: string;
      connectorId: string | null;
      stateJti: string;
      nonceHash: string;
      nowIso: string;
    }): Promise<{ stateJti: string; consumedAt: string } | null> {
      let res: { rows: ReadonlyArray<Record<string, unknown>> };
      try {
        res = await client.run(CONSUME_SQL, [
          params.nowIso,
          params.stateJti,
          params.nonceHash,
          params.tenantId,
          params.provider,
          params.connectorId,
        ]);
      } catch {
        // swallow the raw DB error — never surface its body / a bound value.
        throw new OAuthPendingExecutorError("oauth_pending consume failed");
      }
      const rows = res?.rows ?? [];
      if (rows.length === 0) return null; // 0 rows changed → the pure consume classifies why
      if (rows.length > 1)
        // state_jti is UNIQUE — >1 changed rows is impossible; fail closed rather than report success.
        throw new OAuthPendingExecutorError("oauth_pending consume matched multiple rows");
      const row = rows[0];
      const stateJti = asNullableString(row.state_jti);
      const consumedAt = asNullableString(row.consumed_at);
      if (!stateJti || !consumedAt)
        throw new OAuthPendingExecutorError("oauth_pending consume returned a malformed row");
      return { stateJti, consumedAt };
    },

    async readPendingState(stateJti: string): Promise<OAuthPendingRowState | null> {
      let res: { rows: ReadonlyArray<Record<string, unknown>> };
      try {
        res = await client.run(READ_STATE_SQL, [stateJti]);
      } catch {
        throw new OAuthPendingExecutorError("oauth_pending read failed");
      }
      const rows = res?.rows ?? [];
      if (rows.length === 0) return null;
      const r = rows[0];
      return {
        tenantId: String(r.tenant_id),
        provider: String(r.provider),
        connectorId: asNullableString(r.connector_id),
        nonceHash: String(r.nonce_hash), // a sha256 hash — never the raw nonce
        consumedAt: asNullableString(r.consumed_at),
        expiresAt: String(r.expires_at),
      };
    },
  };
}
