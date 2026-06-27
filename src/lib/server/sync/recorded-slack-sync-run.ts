// Server-only run-lifecycle wrapper: records a manual Slack sync run (running → succeeded/failed) around the chain
// orchestrator (docs/47 PR 6+). Opens a 'running' record, runs runSlackSyncDev, then closes it from the SAFE summary.
// A refused run (disabled / missing tenant) creates NO record. A process crash between start and finish leaves the
// record 'running' — never a misleading 'succeeded'. No service-role; the recorder writes as the tenant member via RLS.
//
// SERVER-ONLY: under `src/lib/server/`, the runtime browser sentinel below, and `no-client-import.test.ts`.

import { runSlackSyncDev, isDevSlackSyncRunEnabled, type RunSlackSyncDeps, type RunSlackSyncSummary } from "./run-slack-sync-dev";
import type { ManualSyncRunRecorder } from "./manual-sync-run-recorder";

if (typeof (globalThis as { window?: unknown }).window !== "undefined") {
  throw new Error("server/sync/recorded-slack-sync-run is server-only and must not be imported in client code");
}

// A run still 'running' past this is considered stale and reconciled to failed (never a scheduler — done inline at the
// start of the next run). ponytail: a code constant, not configurable until there's a reason to tune it.
export const STALE_RUN_MS = 30 * 60 * 1000; // 30 minutes

export type RecordedRunResult = { runId?: string; summary: RunSlackSyncSummary };

export async function recordedSlackSyncRun(deps: RunSlackSyncDeps, recorder: ManualSyncRunRecorder): Promise<RecordedRunResult> {
  // Refused runs never touch the chain → no run record.
  if (!isDevSlackSyncRunEnabled(deps.env)) return { summary: { ok: false, errorCode: "run_disabled" } };
  if (!deps.identity?.tenantId) return { summary: { ok: false, errorCode: "missing_tenant" } };
  const lockKey = { tenantId: deps.identity.tenantId, source: "slack" as const, connectorId: deps.identity.connectorId };

  // 1) reconcile a stuck run so it never blocks new runs (marked failed/stale_run_reconciled, never succeeded).
  //    BEST-EFFORT: a reconcile DB error must NOT abort an otherwise-valid run — start() below is the authoritative
  //    lock and fails closed on a still-held lock anyway.
  try {
    await recorder.reconcileStaleRuns({ ...lockKey, staleBeforeIso: new Date(Date.now() - STALE_RUN_MS).toISOString() });
  } catch {
    // swallow — proceed to the authoritative lock acquisition
  }

  // 2) acquire the active-run lock (DB partial unique index). A concurrent active run → run_already_active, and the
  //    chain is NEVER touched: no Slack call, no emitter, no resolver write, no new record.
  const started = await recorder.start(lockKey);
  if (!started.ok) return { summary: { ok: false, errorCode: started.reason } };

  // 3) run the chain and finalize the run (running → succeeded/failed), releasing the lock.
  let summary: RunSlackSyncSummary;
  try {
    summary = await runSlackSyncDev(deps); // returns {ok:false,...} on any chain failure; the catch is defensive only
  } catch {
    summary = { ok: false, errorCode: "run_crashed" };
  }
  await recorder.finish({ runId: started.runId, summary });
  return { runId: started.runId, summary };
}
