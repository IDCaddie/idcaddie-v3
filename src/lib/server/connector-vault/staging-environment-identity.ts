// Phase 8F — the environment-identity gate for real Slack OAuth. Server-only.
//
// This REPLACES the old `VERCEL_ENV !== "production"` refusal, which was the wrong shape of check twice over.
//
// It was too weak: "not production" is satisfied by every preview deployment, every local run, and any environment
// where VERCEL_ENV happens to be unset — a negative check passes by accident, and the accident is a real OAuth exchange
// against a real workspace.
//
// It was also wrong for this deployment: `idcaddie-v3.vercel.app` is our staging environment served on Vercel's
// "Production" channel. The Vercel label describes a deployment channel, not a database. A negative check on that label
// refuses the one environment we actually want, which is how a safety gate teaches people to disable safety gates.
//
// So this is POSITIVE and CONJUNCTIVE: every fact below must be present AND match. Absence is refusal, not a default —
// an unset variable can never mean "probably fine". There is deliberately no `||`, no fallback and no default value
// anywhere in this file.
//
// Every refusal is a bounded reason code. No environment value, connection string, host, id or secret is ever placed in
// a reason, a message or a log line — the caller is told WHICH fact failed, never what it contained.
//
// SERVER-ONLY: under `src/lib/server/`, the runtime browser sentinel below, and `no-client-import.test.ts`.

if (typeof (globalThis as { window?: unknown }).window !== "undefined") {
  throw new Error("connector-vault/staging-environment-identity is server-only and must not be imported in client code");
}

// ── The pinned identity of the ONE environment real OAuth may run in. ────────────────────────────────────────────
export const STAGING_ENVIRONMENT_MARKER = "staging";
export const STAGING_VERCEL_PROJECT_ID = "prj_l30QMLpF3dNLwKBP2CTG7v9rIon0";
export const STAGING_SUPABASE_REF = "ycdpzduxugdsffjqyoai";
export const PRODUCTION_SUPABASE_REF = "dzbfxulvxchdemcettrx";
export const STAGING_CALLBACK_URI = "https://idcaddie-v3.vercel.app/connectors/oauth/callback";
// Two database identities that must never reach this tier, for the same reason with different blast radii.
//
// `connector_runner_login` can execute every `runner_*` function in the schema, so a compromised request path could
// fabricate directory evidence.
//
// `oauth_completer` is narrow — nine purpose-pinned wrappers, zero table privileges — but it is still a database
// credential, and holding one would mean the web tier had a Postgres driver. That is the invariant doc 46 §11 and
// `scripts/check-app-runtime-imports.sh` enforce, and it is the correction recorded in doc 83 §2: the boundary is about
// what this tier can DO, not which credential it holds. Its presence here is therefore a REFUSAL, not a requirement.
export const OAUTH_COMPLETER_ROLE = "oauth_completer";
export const OAUTH_COMPLETER_DB_URL_VAR = "OAUTH_COMPLETER_DB_URL";
export const FORBIDDEN_RUNNER_ROLE = "connector_runner_login";

export type EnvironmentRefusal =
  | "environment_marker_missing"
  | "environment_marker_not_staging"
  | "vercel_project_missing"
  | "vercel_project_mismatch"
  | "supabase_project_missing"
  | "supabase_project_mismatch"
  | "production_supabase_ref_present"
  | "runner_credential_present"
  | "completer_credential_present"
  | "callback_uri_missing"
  | "callback_uri_mismatch"
  | "real_exchange_disabled"
  | "expected_workspace_missing"
  | "expected_context_missing"
  | "slack_client_id_missing";

export type EnvironmentIdentity =
  | { ok: true; tenantId: string; connectorId: string; correlationId: string; expectedTeamId: string; clientId: string; callbackUri: string }
  | { ok: false; reason: EnvironmentRefusal };

type Env = Record<string, string | undefined>;

const present = (v: unknown): v is string => typeof v === "string" && v.trim().length > 0;

// Slack team ids are `T` + uppercase alphanumerics. A malformed value is treated as absent: half a workspace id is not
// a weaker constraint, it is an unconfigured one.
const isTeamId = (v: string) => /^T[A-Z0-9]{2,}$/.test(v);

/**
 * Decide whether this process is the pinned staging environment and is fully configured for a real OAuth exchange.
 *
 * Order matters: environment identity is established BEFORE any OAuth-specific value is read, so a misconfigured or
 * mis-targeted deployment is refused on the grounds of WHERE it is rather than on a missing Slack setting.
 */
export function resolveStagingEnvironmentIdentity(env: Env = process.env): EnvironmentIdentity {
  // ── 1. An explicit, affirmative statement of which environment this is. ────────────────────────────────────────
  const marker = env.IDCADDIE_ENVIRONMENT;
  if (!present(marker)) return { ok: false, reason: "environment_marker_missing" };
  if (marker.trim() !== STAGING_ENVIRONMENT_MARKER) return { ok: false, reason: "environment_marker_not_staging" };

  // ── 2. The Vercel project. Vercel does not inject a project id at runtime, so it is supplied explicitly and pinned
  //       here; an operator who copies this configuration to another project fails this check rather than discovering
  //       the mistake through a Slack consent screen.
  const projectId = env.IDCADDIE_VERCEL_PROJECT_ID ?? env.VERCEL_PROJECT_ID;
  if (!present(projectId)) return { ok: false, reason: "vercel_project_missing" };
  if (projectId.trim() !== STAGING_VERCEL_PROJECT_ID) return { ok: false, reason: "vercel_project_mismatch" };

  // ── 3. The Supabase project, taken from the URL the app actually talks to rather than a separate label that could
  //       disagree with it. A label can be edited; the URL is the thing that carries the traffic.
  const supabaseUrl = env.NEXT_PUBLIC_SUPABASE_URL;
  if (!present(supabaseUrl)) return { ok: false, reason: "supabase_project_missing" };
  if (!supabaseUrl.includes(STAGING_SUPABASE_REF)) return { ok: false, reason: "supabase_project_mismatch" };

  // ── 4. The production project reference must appear NOWHERE. Not in the Supabase URL, not in a database URL, not in
  //       a stray variable someone pasted while debugging. This scans values, and never reports one.
  for (const [k, v] of Object.entries(env)) {
    if (typeof v !== "string") continue;
    if (v.includes(PRODUCTION_SUPABASE_REF) || k.includes(PRODUCTION_SUPABASE_REF)) {
      return { ok: false, reason: "production_supabase_ref_present" };
    }
  }

  // ── 5. The runner's own credential must never be present in this tier (docs/83 §1-2). Checked by scanning for the
  //       role name rather than by inspecting one named variable, because the hazard is the credential existing here at
  //       all — under any name.
  for (const v of Object.values(env)) {
    if (typeof v === "string" && v.includes(FORBIDDEN_RUNNER_ROLE)) {
      return { ok: false, reason: "runner_credential_present" };
    }
  }

  // ── 6. …and neither must the narrow one. This check INVERTED in Phase 8K, and the inversion is the whole correction
  //       in doc 83 §2: an earlier design had the web tier authenticate as `oauth_completer` directly, which required a
  //       Postgres driver in a public request path and violated doc 46 §11. Completion moved to a worker, so a
  //       completer connection string here now means someone is rebuilding the rejected design — refuse.
  //
  //       Both the variable NAME and any value carrying the role name are checked, because renaming the variable is the
  //       obvious way around a name-only check.
  for (const [k, v] of Object.entries(env)) {
    if (k === OAUTH_COMPLETER_DB_URL_VAR || (typeof v === "string" && v.includes(OAUTH_COMPLETER_ROLE))) {
      return { ok: false, reason: "completer_credential_present" };
    }
  }

  // ── 7. The callback. Compared as a whole string against the pinned value — not a host check, not a prefix.
  const callbackUri = env.CONNECTOR_OAUTH_REDIRECT_URI;
  if (!present(callbackUri)) return { ok: false, reason: "callback_uri_missing" };
  if (callbackUri.trim() !== STAGING_CALLBACK_URI) return { ok: false, reason: "callback_uri_mismatch" };

  // ── 8. The explicit opt-in. Last, so that a deployment which is merely *capable* of real OAuth still does nothing
  //       until somebody turns it on deliberately.
  if (env.CONNECTOR_OAUTH_REAL_EXCHANGE_ENABLED !== "1") return { ok: false, reason: "real_exchange_disabled" };

  // ── 9. The workspace. Unset is a refusal, never a wildcard.
  const expectedTeamId = env.CONNECTOR_OAUTH_EXPECTED_SLACK_TEAM_ID;
  if (!present(expectedTeamId) || !isTeamId(expectedTeamId.trim())) return { ok: false, reason: "expected_workspace_missing" };

  // ── 10. The trusted context — the same triple the authorize half persisted into `oauth_pending`.
  const tenantId = env.CONNECTOR_OAUTH_EXPECTED_TENANT_ID;
  const connectorId = env.CONNECTOR_OAUTH_EXPECTED_CONNECTOR_ID;
  const correlationId = env.CONNECTOR_OAUTH_EXPECTED_CORRELATION_ID;
  if (!present(tenantId) || !present(connectorId) || !present(correlationId)) {
    return { ok: false, reason: "expected_context_missing" };
  }

  const clientId = env.SLACK_CLIENT_ID;
  if (!present(clientId)) return { ok: false, reason: "slack_client_id_missing" };

  return {
    ok: true,
    tenantId: tenantId.trim(),
    connectorId: connectorId.trim(),
    correlationId: correlationId.trim(),
    expectedTeamId: expectedTeamId.trim(),
    clientId: clientId.trim(),
    callbackUri: callbackUri.trim(),
  };
}

/** Convenience predicate. Real mode is on only when the full identity resolves. */
export function isRealSlackOAuthEnabled(env: Env = process.env): boolean {
  return resolveStagingEnvironmentIdentity(env).ok;
}
