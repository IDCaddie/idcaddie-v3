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

function fakeRecorder() {
  const events: string[] = [];
  const finished: { runId: string; summary: RunSlackSyncSummary }[] = [];
  const recorder: ManualSyncRunRecorder = {
    async start(i) { events.push(`start:${i.tenantId}:${i.source}:${i.connectorId}`); return { runId: "run-1" }; },
    async finish(i) { events.push(`finish:${i.summary.ok ? "ok" : "fail"}`); finished.push(i); },
  };
  return { recorder, events, finished };
}
const deps = (env: Record<string, string | undefined>): RunSlackSyncDeps =>
  ({ env, identity: { tenantId: "tenant-A", connectorId: "slack-dev" } } as unknown as RunSlackSyncDeps);
const ok: RunSlackSyncSummary = { ok: true, teamPresent: true, usersFetched: 1, factsEmitted: 6, factsRejected: 0, appUsersWritten: 1, peopleWritten: 1, matchesWritten: 1, matchConflicts: 0, skipped: 2 };

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

  it("a successful run records succeeded with the SAFE summary, start BEFORE chain, finish AFTER", async () => {
    mockGuard.mockReturnValue(true);
    mockRun.mockResolvedValue(ok);
    const r = fakeRecorder();
    const res = await recordedSlackSyncRun(deps({ NODE_ENV: "development" }), r.recorder);
    expect(res).toEqual({ runId: "run-1", summary: ok });
    expect(r.events).toEqual(["start:tenant-A:slack:slack-dev", "finish:ok"]); // running opened first, closed after
    expect(r.finished[0].summary).toBe(ok);
  });

  it("a failed run records failed (the chain's safe failure summary is what gets persisted)", async () => {
    mockGuard.mockReturnValue(true);
    const fail: RunSlackSyncSummary = { ok: false, errorCode: "resolve_failed", failedStage: "upsert_app", safeReason: "rls_denied" };
    mockRun.mockResolvedValue(fail);
    const r = fakeRecorder();
    const res = await recordedSlackSyncRun(deps({ NODE_ENV: "development" }), r.recorder);
    expect(res.summary).toEqual(fail);
    expect(r.events).toEqual(["start:tenant-A:slack:slack-dev", "finish:fail"]);
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
