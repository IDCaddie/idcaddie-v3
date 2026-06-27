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

export type RecordedRunResult = { runId?: string; summary: RunSlackSyncSummary };

export async function recordedSlackSyncRun(deps: RunSlackSyncDeps, recorder: ManualSyncRunRecorder): Promise<RecordedRunResult> {
  // Refused runs never touch the chain → no run record.
  if (!isDevSlackSyncRunEnabled(deps.env)) return { summary: { ok: false, errorCode: "run_disabled" } };
  if (!deps.identity?.tenantId) return { summary: { ok: false, errorCode: "missing_tenant" } };

  const { runId } = await recorder.start({ tenantId: deps.identity.tenantId, source: "slack", connectorId: deps.identity.connectorId });
  let summary: RunSlackSyncSummary;
  try {
    summary = await runSlackSyncDev(deps); // returns {ok:false,...} on any chain failure; the catch is defensive only
  } catch {
    summary = { ok: false, errorCode: "run_crashed" };
  }
  await recorder.finish({ runId, summary });
  return { runId, summary };
}
