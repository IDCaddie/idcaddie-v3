// Server-only SCHEDULER/RETRY worker for the manual Slack sync (docs/47 PR 7+). A "tick" reconciles stale runs, selects
// eligible tenant/connector targets, acquires the per-target run lock, runs the existing chain, and records safe
// status/counts/errors — reusing the PR #194/#195 recorder + lock + stale-reconcile. It adds NO chain logic.
//
// WRITE IDENTITY (a scheduled tick has NO browser session): it uses the EXISTING dev-user-JWT client (PR #192,
// createDevUserScopedClient) — a USER-SCOPED (RLS) client, NEVER service-role. So every write is RLS-governed as that
// dev tenant member; tenant isolation is the DB's, exactly like the manual run. NOT a service-role shortcut.
//
// Local/dev/internal ONLY: disabled by default; the underlying chain itself only runs in local dev. Production cron
// INFRA (a Vercel cron + the guarded route) is NOT enabled here — see docs/47. NOT OAuth, NOT a runner, NOT KMS.
//
// SERVER-ONLY: under `src/lib/server/`, the runtime browser sentinel below, and `no-client-import.test.ts`.

import { timingSafeEqual } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/database.types";
import { createDevUserScopedClient } from "./dev-user-scoped-client";
import { recordedSlackSyncRun } from "./recorded-slack-sync-run";
import type { RunSlackSyncSummary } from "./run-slack-sync-dev";
import { createProviderTokenSource } from "./provider-token-source-selector";
import { createSupabaseSlackResolverStore } from "./supabase-slack-resolver-store";
import { createSupabaseManualSyncRunRecorder } from "./manual-sync-run-recorder";
import { slackFetchHttpClient } from "./slack-fetch-http-client";

if (typeof (globalThis as { window?: unknown }).window !== "undefined") {
  throw new Error("server/sync/slack-sync-scheduler is server-only and must not be imported in client code");
}

const SCHEDULER_OPT_IN = "ID_CADDIE_SLACK_SCHEDULER_ENABLED";
export const SCHEDULER_INTERVAL_MS = 30 * 60 * 1000; // backoff: don't re-run a target more often than this. ponytail: a constant.
// Only KNOWN-transient failures are retried; EVERY other failure (auth/scope/config — and any UNKNOWN code, e.g. a
// permanent Slack token error like token_revoked/account_inactive) fails CLOSED = not retried. An allowlist, not a
// denylist, so an unrecognized permanent error is never retried indefinitely. (stale_run_reconciled is retryable: a
// stuck run that got cleared should run again next window.)
const RETRYABLE_FAILURES = new Set(["ratelimited", "slack_error", "http_error", "malformed_response", "run_crashed", "resolve_failed", "store_write_failed", "stale_run_reconciled"]);

// ALLOWLIST-shaped, fail-closed guard (mirrors the run/trigger guards): local dev + a DISTINCT scheduler opt-in.
// unknown/unset/test/preview/production refuse; a request cannot enable it.
export function isSlackSchedulerEnabled(env: Record<string, string | undefined> = process.env): boolean {
  const localDev = env.NODE_ENV === "development" && (env.VERCEL_ENV === undefined || env.VERCEL_ENV === "development");
  return localDev && env[SCHEDULER_OPT_IN] === "1";
}

export type SchedulerTarget = { tenantId: string; connectorId: string };
export type SchedulerLatest = { status: string; startedAt: string; finishedAt: string | null; errorCode: string | null } | null;
export type Eligibility = { eligible: boolean; reason: string };

// Eligibility + retry/backoff policy (PURE). first run → eligible; a non-retryable last failure (auth/scope) → skipped;
// within the backoff window → skipped; otherwise eligible (a transient failure retries, a success re-runs on schedule).
// 'running' uses started_at for the window, so a recent active run is skipped (backoff) and a stale one becomes eligible
// (the chain then reconciles + re-locks it).
export function classifyTargetEligibility(latest: SchedulerLatest, nowMs: number, intervalMs: number): Eligibility {
  if (!latest) return { eligible: true, reason: "first_run" };
  if (latest.status === "failed" && !RETRYABLE_FAILURES.has(latest.errorCode ?? ""))
    return { eligible: false, reason: "non_retryable_failure" }; // fail closed: auth/scope/config/unknown not retried
  const ref = Date.parse(latest.finishedAt ?? latest.startedAt);
  if (Number.isFinite(ref) && nowMs - ref < intervalMs) return { eligible: false, reason: "backoff" };
  return { eligible: true, reason: latest.status === "failed" ? "retry_transient" : "scheduled" };
}

// Tenant/connector eligibility config — an explicit allowlist for local/dev/internal use: connectors within the single
// dev tenant (SLACK_SYNC_TENANT_ID, the dev-JWT's tenant). Tenant-scoped + connector-scoped; never "run all tenants".
export function parseSchedulerTargets(env: Record<string, string | undefined>): SchedulerTarget[] {
  const tenantId = env.SLACK_SYNC_TENANT_ID;
  const connectors = (env.ID_CADDIE_SLACK_SCHEDULER_CONNECTORS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (!tenantId || connectors.length === 0) return [];
  return connectors.map((connectorId) => ({ tenantId, connectorId }));
}

export type SchedulerTickResult = {
  ok: boolean;
  errorCode?: string;
  ticked: number;
  results: Array<{ connectorId: string; skipped?: string; status?: string; errorCode?: string; appUsersWritten?: number; peopleWritten?: number; matchesWritten?: number; skippedFacts?: number }>;
};

export type SchedulerDeps = {
  env: Record<string, string | undefined>;
  targets: SchedulerTarget[];
  nowMs: number;
  intervalMs: number;
  getLatest: (t: SchedulerTarget) => Promise<SchedulerLatest>;
  runOne: (t: SchedulerTarget) => Promise<RunSlackSyncSummary>; // reconcile + lock + chain + record (recordedSlackSyncRun)
};

// SAFE per-target projection — connector label + status/error/counts ONLY (never token/JWT/email/name/raw).
function safeResult(connectorId: string, summary: RunSlackSyncSummary) {
  return summary.ok
    ? { connectorId, status: "succeeded", appUsersWritten: summary.appUsersWritten, peopleWritten: summary.peopleWritten, matchesWritten: summary.matchesWritten, skippedFacts: summary.skipped }
    : { connectorId, status: "failed", errorCode: summary.errorCode };
}

// One scheduler tick. Disabled → no work. Otherwise, per eligible target: run the chain (which reconciles stale + locks,
// so a duplicate active run is skipped as run_already_active before any Slack call) and record the safe outcome.
export async function runSlackSyncSchedulerTick(deps: SchedulerDeps): Promise<SchedulerTickResult> {
  if (!isSlackSchedulerEnabled(deps.env)) return { ok: false, errorCode: "scheduler_disabled", ticked: 0, results: [] };
  const results: SchedulerTickResult["results"] = [];
  for (const target of deps.targets) {
    const latest = await deps.getLatest(target);
    const elig = classifyTargetEligibility(latest, deps.nowMs, deps.intervalMs);
    if (!elig.eligible) {
      results.push({ connectorId: target.connectorId, skipped: elig.reason });
      continue;
    }
    const summary = await deps.runOne(target); // run_already_active short-circuits before Slack inside the chain
    results.push(safeResult(target.connectorId, summary));
  }
  return { ok: true, ticked: results.length, results };
}

// ── default wiring (used by the guarded route; injected in tests) ──────────────────────────────────────────────────
async function readLatestRun(client: SupabaseClient<Database>, t: SchedulerTarget): Promise<SchedulerLatest> {
  const { data, error } = await client
    .from("manual_sync_runs")
    .select("status, started_at, finished_at, error_code")
    .eq("tenant_id", t.tenantId)
    .eq("source", "slack")
    .eq("connector_id", t.connectorId)
    .order("started_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error || !data) return null;
  return { status: data.status, startedAt: data.started_at, finishedAt: data.finished_at, errorCode: data.error_code };
}

async function runOneTarget(env: Record<string, string | undefined>, client: SupabaseClient<Database>, t: SchedulerTarget): Promise<RunSlackSyncSummary> {
  const { summary } = await recordedSlackSyncRun(
    {
      env,
      tokenSource: createProviderTokenSource(env), // selector: dev source in local-dev+opt-in, else the fail-closed vault source
      httpClient: slackFetchHttpClient,
      store: createSupabaseSlackResolverStore(client),
      identity: { tenantId: t.tenantId, connectorId: t.connectorId },
      observedAt: new Date().toISOString(),
    },
    createSupabaseManualSyncRunRecorder(client),
  );
  return summary;
}

// ── route entrypoint (cron-secret + env-flag gated; the route.ts is a thin wrapper over this) ──────────────────────
// Constant-time compare of the cron secret. Both must be present + equal; an unset expected secret fails closed.
export function schedulerSecretMatches(provided: string | null | undefined, expected: string | undefined): boolean {
  if (!provided || !expected) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

// HTTP-shaped handler (no next/server dependency → fully testable). Disabled env → 404 (the endpoint stays hidden);
// missing/wrong cron secret → 401; otherwise run the tick and return its SAFE result. `runTick` is injected so tests
// never touch the real chain.
export async function handleSlackSchedulerRequest(input: {
  env: Record<string, string | undefined>;
  secretHeader: string | null;
  runTick: () => Promise<SchedulerTickResult>;
}): Promise<{ status: number; body: unknown }> {
  if (!isSlackSchedulerEnabled(input.env)) return { status: 404, body: { ok: false, errorCode: "not_found" } };
  if (!schedulerSecretMatches(input.secretHeader, input.env.ID_CADDIE_SLACK_SCHEDULER_SECRET))
    return { status: 401, body: { ok: false, errorCode: "unauthorized" } };
  try {
    return { status: 200, body: await input.runTick() };
  } catch {
    return { status: 500, body: { ok: false, errorCode: "scheduler_error", ticked: 0, results: [] } }; // safe, no raw
  }
}

export function defaultSchedulerDeps(): SchedulerDeps {
  const env = process.env;
  const client = createDevUserScopedClient(env); // dev-JWT user-scoped client — RLS, NEVER service-role
  return {
    env,
    targets: parseSchedulerTargets(env),
    nowMs: Date.now(),
    intervalMs: SCHEDULER_INTERVAL_MS,
    getLatest: (t) => readLatestRun(client, t),
    runOne: (t) => runOneTarget(env, client, t),
  };
}
