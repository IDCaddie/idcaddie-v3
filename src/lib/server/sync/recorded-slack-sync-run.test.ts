import { describe, it, expect, vi, beforeEach } from "vitest";
import type { RunSlackSyncSummary, RunSlackSyncDeps } from "./run-slack-sync-dev";
import type { ManualSyncRunRecorder } from "./manual-sync-run-recorder";

// Wrapper lifecycle test — runSlackSyncDev + the guard are mocked so we test ONLY the orchestration: refused runs make
// no record; a run opens 'running' BEFORE the chain and closes from the SAFE summary AFTER.
const mockRun = vi.fn<(d: RunSlackSyncDeps) => Promise<RunSlackSyncSummary>>();
const mockGuard = vi.fn<(e: Record<string, string | undefined>) => boolean>();
vi.mock("./run-slack-sync-dev", () => ({
  runSlackSyncDev: (d: RunSlackSyncDeps) => mockRun(d),
  isDevSlackSyncRunEnabled: (e: Record<string, string | undefined>) => mockGuard(e),
}));
import { recordedSlackSyncRun } from "./recorded-slack-sync-run";

function fakeRecorder(startResult: Awaited<ReturnType<ManualSyncRunRecorder["start"]>> = { ok: true, runId: "run-1" }) {
  const events: string[] = [];
  const finished: { runId: string; summary: RunSlackSyncSummary }[] = [];
  const reconciled: { staleBeforeIso: string }[] = [];
  const recorder: ManualSyncRunRecorder = {
    async reconcileStaleRuns(i) { events.push("reconcile"); reconciled.push(i); return { reconciled: 0 }; },
    async start(i) { events.push(`start:${i.tenantId}:${i.source}:${i.connectorId}`); return startResult; },
    async finish(i) { events.push(`finish:${i.summary.ok ? "ok" : "fail"}`); finished.push(i); },
  };
  return { recorder, events, finished, reconciled };
}
const deps = (env: Record<string, string | undefined>): RunSlackSyncDeps =>
  ({ env, identity: { tenantId: "tenant-A", connectorId: "slack-dev" } } as unknown as RunSlackSyncDeps);
const ok: RunSlackSyncSummary = { ok: true, teamPresent: true, usersFetched: 1, factsEmitted: 6, factsRejected: 0, appUsersWritten: 1, peopleWritten: 1, matchesWritten: 1, matchConflicts: 0, skipped: 2, staleMarked: 0 };

beforeEach(() => { mockRun.mockReset(); mockGuard.mockReset(); });

describe("recordedSlackSyncRun", () => {
  it("a disabled run makes NO record and never touches the chain", async () => {
    mockGuard.mockReturnValue(false);
    const r = fakeRecorder();
    const res = await recordedSlackSyncRun(deps({ NODE_ENV: "production" }), r.recorder);
    expect(res.summary).toEqual({ ok: false, errorCode: "run_disabled" });
    expect(r.events).toEqual([]);
    expect(mockRun).not.toHaveBeenCalled();
  });

  it("a duplicate active run is refused (run_already_active) and NEVER touches the chain", async () => {
    mockGuard.mockReturnValue(true);
    const r = fakeRecorder({ ok: false, reason: "run_already_active" });
    const res = await recordedSlackSyncRun(deps({ NODE_ENV: "development" }), r.recorder);
    expect(res.summary).toEqual({ ok: false, errorCode: "run_already_active" });
    expect(mockRun).not.toHaveBeenCalled(); // no Slack client / emitter / resolver
    expect(r.events).toEqual(["reconcile", "start:tenant-A:slack:slack-dev"]); // reconcile + lock attempt, then stop (no finish, no record)
    expect(r.finished).toEqual([]);
  });

  it("a reconcile DB error is best-effort — it does NOT abort an otherwise-valid run", async () => {
    mockGuard.mockReturnValue(true);
    mockRun.mockResolvedValue(ok);
    const r = fakeRecorder();
    r.recorder.reconcileStaleRuns = async () => { throw new Error("reconcile db blip"); };
    const res = await recordedSlackSyncRun(deps({ NODE_ENV: "development" }), r.recorder);
    expect(res.summary).toEqual(ok); // proceeded to start + chain + finish
    expect(mockRun).toHaveBeenCalled();
  });

  it("reconciles stale runs BEFORE acquiring the lock (cutoff ~30m ago)", async () => {
    mockGuard.mockReturnValue(true);
    mockRun.mockResolvedValue(ok);
    const r = fakeRecorder();
    await recordedSlackSyncRun(deps({ NODE_ENV: "development" }), r.recorder);
    expect(r.events[0]).toBe("reconcile"); // stale reconcile happens first
    expect(typeof r.reconciled[0].staleBeforeIso).toBe("string"); // a real ISO cutoff was passed
  });

  it("a successful run records succeeded with the SAFE summary, start BEFORE chain, finish AFTER", async () => {
    mockGuard.mockReturnValue(true);
    mockRun.mockResolvedValue(ok);
    const r = fakeRecorder();
    const res = await recordedSlackSyncRun(deps({ NODE_ENV: "development" }), r.recorder);
    expect(res).toEqual({ runId: "run-1", summary: ok });
    expect(r.events).toEqual(["reconcile", "start:tenant-A:slack:slack-dev", "finish:ok"]); // reconcile, then running opened, closed after
    expect(r.finished[0].summary).toBe(ok);
  });

  it("a failed run records failed (the chain's safe failure summary is what gets persisted)", async () => {
    mockGuard.mockReturnValue(true);
    const fail: RunSlackSyncSummary = { ok: false, errorCode: "resolve_failed", failedStage: "upsert_app", safeReason: "rls_denied" };
    mockRun.mockResolvedValue(fail);
    const r = fakeRecorder();
    const res = await recordedSlackSyncRun(deps({ NODE_ENV: "development" }), r.recorder);
    expect(res.summary).toEqual(fail);
    expect(r.events).toEqual(["reconcile", "start:tenant-A:slack:slack-dev", "finish:fail"]);
  });

  it("a defensive chain throw still closes the run (failed: run_crashed), never left misleadingly open as succeeded", async () => {
    mockGuard.mockReturnValue(true);
    mockRun.mockRejectedValue(new Error("boom"));
    const r = fakeRecorder();
    const res = await recordedSlackSyncRun(deps({ NODE_ENV: "development" }), r.recorder);
    expect(res.summary).toEqual({ ok: false, errorCode: "run_crashed" });
    expect(r.finished[0].summary).toEqual({ ok: false, errorCode: "run_crashed" });
  });
});
