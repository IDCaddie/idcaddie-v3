// Server-only CONTROLLED INTERNAL trigger for the manual Slack sync (docs/47 PR 6+). Lets an authorized internal
// operator start a Slack sync WITHOUT the terminal command — gated by an allowlist env flag + an authenticated, active,
// write-role tenant membership. It reuses the existing chain end-to-end (token source #187 → Slack client #188 →
// emitter #189 → resolver store #190 → recorder + lock/stale-reconcile #194/#195) and adds NO chain logic.
//
// Because it runs in a Next.js REQUEST context (a server action), it uses the cookie-scoped `createClient()` — the
// authenticated operator's own user-scoped client — so every write is RLS-governed AS THAT USER (never service-role,
// never a dev JWT). tenant_id is resolved server-side from the auth context (resolveTenantContext), NEVER from the
// request; connector_id is a fixed server-side label. NOT a scheduler, NOT OAuth/runner, NOT customer-facing.
//
// SERVER-ONLY: under `src/lib/server/`, the runtime browser sentinel below, and `no-client-import.test.ts`.

import { recordedSlackSyncRun } from "./recorded-slack-sync-run";
import type { RunSlackSyncSummary } from "./run-slack-sync-dev";
import { createProviderTokenSource } from "./provider-token-source-selector";
import { createSupabaseSlackResolverStore } from "./supabase-slack-resolver-store";
import { createSupabaseManualSyncRunRecorder } from "./manual-sync-run-recorder";
import { slackFetchHttpClient } from "./slack-fetch-http-client";
import { getSessionUser } from "@/lib/auth/session";
import { resolveTenantContext, type ResolvedTenantContext } from "@/lib/auth/tenant-context";
import { createClient } from "@/lib/supabase/server";

if (typeof (globalThis as { window?: unknown }).window !== "undefined") {
  throw new Error("server/sync/internal-slack-trigger is server-only and must not be imported in client code");
}

const TRIGGER_OPT_IN = "ID_CADDIE_INTERNAL_SLACK_TRIGGER_ENABLED";
const CONNECTOR_ID = "slack-internal-dev"; // server-derived label — NEVER caller-supplied
const WRITE_ROLES = ["owner", "admin", "editor"] as const;

// ALLOWLIST-shaped, fail-closed env guard (mirrors the run guard). The internal trigger is enabled ONLY in positively
// confirmed local development AND with its OWN explicit opt-in. unknown/unset/test/preview/production all refuse; a
// request header/query/body/cookie CANNOT enable it (reads the trusted env map only). A DISTINCT flag from the run/token
// opt-ins, so enabling the CLI run never enables the trigger.
export function isInternalSlackTriggerEnabled(env: Record<string, string | undefined> = process.env): boolean {
  const localDev = env.NODE_ENV === "development" && (env.VERCEL_ENV === undefined || env.VERCEL_ENV === "development");
  return localDev && env[TRIGGER_OPT_IN] === "1";
}

export type InternalTriggerAuthz = { ok: true; tenantId: string } | { ok: false; errorCode: string };

// PURE authorization decision: env flag + authenticated user + a SINGLE active write-role tenant membership. The tenant
// comes ONLY from the resolved auth context — there is no request input to trust/spoof. Multiple active tenants refuse
// (ambiguous for a write trigger); viewer refuses.
export function authorizeInternalTrigger(
  env: Record<string, string | undefined>,
  user: { id?: string | null } | null,
  context: ResolvedTenantContext | null,
): InternalTriggerAuthz {
  if (!isInternalSlackTriggerEnabled(env)) return { ok: false, errorCode: "trigger_disabled" };
  if (!user?.id) return { ok: false, errorCode: "unauthenticated" };
  const active = context?.activeTenant ?? null;
  if (!active) return { ok: false, errorCode: "no_active_tenant" };
  if (context?.tenantSwitchingRequired) return { ok: false, errorCode: "tenant_switch_required" };
  if (!(WRITE_ROLES as readonly string[]).includes(active.role)) return { ok: false, errorCode: "insufficient_role" };
  return { ok: true, tenantId: active.id };
}

// IO seam (injected in tests so no Next request / network is needed).
export type InternalTriggerIo = {
  env: Record<string, string | undefined>;
  getUser: () => Promise<{ id: string } | null>;
  getContext: () => Promise<ResolvedTenantContext | null>;
  runChain: (tenantId: string) => Promise<RunSlackSyncSummary>;
};

// Build + run the existing chain as the authenticated operator (cookie user-scoped client → RLS; never service-role).
async function defaultRunChain(tenantId: string): Promise<RunSlackSyncSummary> {
  const supabase = await createClient();
  const env = process.env;
  const { summary } = await recordedSlackSyncRun(
    {
      env,
      tokenSource: createProviderTokenSource(env), // selector: dev source in local-dev+opt-in, else the fail-closed vault source
      httpClient: slackFetchHttpClient,
      store: createSupabaseSlackResolverStore(supabase),
      identity: { tenantId, connectorId: CONNECTOR_ID },
      observedAt: new Date().toISOString(),
    },
    createSupabaseManualSyncRunRecorder(supabase),
  );
  return summary;
}

function defaultIo(): InternalTriggerIo {
  return {
    env: process.env,
    getUser: () => getSessionUser().then((u) => (u ? { id: u.id } : null)),
    getContext: resolveTenantContext,
    runChain: defaultRunChain,
  };
}

// Orchestrate: authorize (env + auth + write-role tenant) → run the existing chain → return the SAFE summary. A refused
// trigger NEVER touches the chain (no Slack call, no resolver write, no record). The summary is safe aggregates only.
export async function runInternalSlackSync(io: InternalTriggerIo = defaultIo()): Promise<RunSlackSyncSummary> {
  const [user, context] = await Promise.all([io.getUser(), io.getContext()]);
  const authz = authorizeInternalTrigger(io.env, user, context);
  if (!authz.ok) return { ok: false, errorCode: authz.errorCode };
  return io.runChain(authz.tenantId);
}
