// Server-only MANUAL Slack P0 sync orchestrator (PR 6) — LOCAL/DEV-ONLY. Wires the already-merged pieces into one run:
//   dev-token source (#187) → Slack client (#188) → discovery-fact emitter (#189) → tenant-scoped resolver (#190).
//
// It is a pure wiring CORE with INJECTED deps (token source, http client, resolver store, env, identity) — so it is
// fully unit-testable with synthetic deps and NO live Slack/DB call. The actual live run is operator-driven in local dev
// (it needs a real dev Slack token + a real user-scoped Supabase store); the agent never runs it. This is NOT
// customer-facing OAuth, NOT the production runner, NOT a scheduler, NOT a UI/route/server action.
//
// SAFETY: structurally disabled outside local dev (allowlist-shaped guard + explicit run opt-in; request input cannot
// enable it). The token comes ONLY via the #187 ProviderTokenSource seam (never a direct env read here) and is NEVER
// returned, logged, or placed in the summary/errors. The summary is SAFE AGGREGATES ONLY — no token / auth header /
// raw Slack response / email / name / payload. tenant_id is the caller's authenticated arg, never a Slack payload.
//
// SERVER-ONLY: under `src/lib/server/`, the runtime browser sentinel below, and `no-client-import.test.ts`.

import { createSlackClient, SlackApiError, type SlackHttpClient } from "./slack/slack-client";
import type { ProviderTokenSource } from "./provider-token-source";
import { emitSlackDiscoveryFacts } from "../connector-vault/slack-discovery-emitter";
import { applySlackDiscoveryResolution, type SlackResolverStore } from "../connector-vault/slack-resolver-write";

// Runtime server-only sentinel — throw if evaluated in a browser.
if (typeof (globalThis as { window?: unknown }).window !== "undefined") {
  throw new Error("server/sync/run-slack-sync-dev is server-only and must not be imported in client code");
}

const RUN_OPT_IN = "ID_CADDIE_DEV_SLACK_SYNC_ENABLED";

// ALLOWLIST-shaped, fail-closed guard (mirrors provider-token-source.ts): the manual run is enabled ONLY in positively
// confirmed local development AND with an explicit, distinct run opt-in. unknown/unset/test/staging/preview/production
// all refuse. Reads TRUSTED server config (the env map) ONLY — never a request header/query/cookie/body/url.
export function isDevSlackSyncRunEnabled(env: Record<string, string | undefined> = process.env): boolean {
  const isLocalDev = env.NODE_ENV === "development" && (env.VERCEL_ENV === undefined || env.VERCEL_ENV === "development");
  if (!isLocalDev) return false;
  return env[RUN_OPT_IN] === "1";
}

export type RunSlackSyncDeps = {
  env: Record<string, string | undefined>;
  tokenSource: ProviderTokenSource; // #187 seam — the ONLY token path
  httpClient: SlackHttpClient; // #188 injected http — the ONLY Slack-calling path
  store: SlackResolverStore; // #190 user-scoped resolver store (RLS-enforced; never service-role)
  identity: { tenantId: string; connectorId: string };
  observedAt: string; // server-provided ISO timestamp (not generated here)
  sourceRunId?: string;
};

export type FailedStage = "upsert_app" | "upsert_app_user" | "upsert_person" | "upsert_match" | "unknown";
export type SafeReason = "rls_denied" | "missing_membership" | "constraint_violation" | "schema_mismatch" | "unknown";
export type FailedTable = "apps" | "app_users" | "people" | "app_user_identity_matches";

// SAFE aggregate run summary — NO token / auth header / raw Slack response / email / name / payload.
export type RunSlackSyncSummary =
  | {
      ok: true;
      teamPresent: boolean;
      usersFetched: number;
      factsEmitted: number;
      factsRejected: number;
      appUsersWritten: number;
      peopleWritten: number;
      matchesWritten: number;
      matchConflicts: number;
      skipped: number;
      staleMarked: number; // 0040 absence marking — app_users flipped active→stale this run (post-success only)
    }
  | {
      ok: false;
      errorCode: string; // a SAFE Slack error code or a static reason — never a token/raw body
      // resolver-failure diagnostics — SAFE enums/codes/counts ONLY (never token/JWT/email/name/raw):
      failedStage?: FailedStage; // which store stage failed (from the store's value-free failure)
      table?: FailedTable;
      safeDbCode?: string; // the SQLSTATE / PostgREST code only (e.g. "42501")
      safeReason?: SafeReason;
      usersFetched?: number;
      factsEmitted?: number;
      factsRejected?: number;
    };

// Map a SQLSTATE / PostgREST code to a SAFE reason enum. The code is safe; this never inspects values/messages.
function safeReasonFor(code: string | null): SafeReason {
  switch (code) {
    // RLS WITH CHECK / insufficient_privilege. On upsert_app this almost always means the dev-user JWT is NOT an
    // owner/admin/editor member of SLACK_SYNC_TENANT_ID (or the membership is inactive).
    case "42501":
      return "rls_denied";
    case "23502": // not_null
    case "23503": // foreign_key
    case "23505": // unique
    case "23514": // check
      return "constraint_violation";
    case "42703": // undefined_column
    case "42P01": // undefined_table
    case "PGRST204": // column not in PostgREST schema cache
    case "PGRST205": // table not found
      return "schema_mismatch";
    default:
      return "unknown";
  }
}

export async function runSlackSyncDev(deps: RunSlackSyncDeps): Promise<RunSlackSyncSummary> {
  // Fail closed outside local dev + opt-in (defense in depth; the token source #187 also refuses outside dev).
  if (!isDevSlackSyncRunEnabled(deps.env)) return { ok: false, errorCode: "run_disabled" };
  if (!deps.identity?.tenantId) return { ok: false, errorCode: "missing_tenant" };
  if (!deps.observedAt) return { ok: false, errorCode: "missing_observed_at" };

  const client = createSlackClient({ tokenSource: deps.tokenSource, httpClient: deps.httpClient, identity: deps.identity });
  let workspace, users;
  try {
    workspace = await client.authTest(); // token rides the Authorization header inside the client; never surfaced here
    users = await client.listUsers();
  } catch (e) {
    // ONLY the safe Slack error code escapes — never the caught error body / token / raw response.
    return { ok: false, errorCode: e instanceof SlackApiError ? e.code : "slack_error" };
  }

  let emit, resolution;
  try {
    emit = emitSlackDiscoveryFacts({ workspace, users }, deps.identity.tenantId, { observedAt: deps.observedAt, ...(deps.sourceRunId ? { sourceRunId: deps.sourceRunId } : {}) });
    resolution = await applySlackDiscoveryResolution(deps.store, deps.identity.tenantId, emit.facts);
  } catch (e) {
    // a resolver/store failure → SAFE structured diagnostics: stage/table/code/reason ONLY. The concrete store attaches a
    // value-free `.failure` (table+op+SQLSTATE code, never a message that could embed an email); we never read a raw
    // error/row. Plus the counts gathered BEFORE the failure (emit may be undefined if emission itself threw).
    const failure = (e as { failure?: { table?: string; op?: string; code?: string | null } } | null | undefined)?.failure;
    const code = failure && typeof failure.code === "string" ? failure.code : null;
    return {
      ok: false,
      errorCode: "resolve_failed",
      failedStage: (failure?.op as FailedStage | undefined) ?? "unknown",
      ...(failure?.table ? { table: failure.table as FailedTable } : {}),
      ...(code ? { safeDbCode: code } : {}),
      safeReason: failure ? safeReasonFor(code) : "unknown",
      usersFetched: users.length,
      factsEmitted: emit ? emit.built - emit.rejected : 0,
      factsRejected: emit ? emit.rejected : 0,
    };
  }

  return {
    ok: true,
    teamPresent: typeof workspace.teamId === "string" && workspace.teamId.length > 0,
    usersFetched: users.length, // bots already filtered by the client (#188); records carry no token
    factsEmitted: emit.built - emit.rejected,
    factsRejected: emit.rejected,
    appUsersWritten: resolution.appUsersUpserted,
    peopleWritten: resolution.peopleUpserted,
    matchesWritten: resolution.matchesUpserted,
    matchConflicts: resolution.matchConflicts,
    skipped: resolution.skipped,
    staleMarked: resolution.staleMarked,
  };
}
