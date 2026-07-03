import { describe, it, expect, vi } from "vitest";
import {
  isSlackSchedulerEnabled, classifyTargetEligibility, parseSchedulerTargets, schedulerSecretMatches,
  handleSlackSchedulerRequest, runSlackSyncSchedulerTick, type SchedulerDeps, type SchedulerTickResult,
} from "./slack-sync-scheduler";
import type { RunSlackSyncSummary } from "./run-slack-sync-dev";

const DEV = { NODE_ENV: "development", ID_CADDIE_SLACK_SCHEDULER_ENABLED: "1" } as Record<string, string | undefined>;
const INTERVAL = 30 * 60 * 1000;
const NOW = Date.parse("2026-06-27T12:00:00Z");
const ok: RunSlackSyncSummary = { ok: true, teamPresent: true, usersFetched: 1, factsEmitted: 6, factsRejected: 0, appUsersWritten: 1, peopleWritten: 1, matchesWritten: 1, matchConflicts: 0, skipped: 2, staleMarked: 0 };

describe("isSlackSchedulerEnabled — allowlist-shaped, fail-closed", () => {
  it("enables ONLY local dev + the distinct scheduler opt-in", () => {
    expect(isSlackSchedulerEnabled(DEV)).toBe(true);
    for (const env of [
      {}, { NODE_ENV: "production", ID_CADDIE_SLACK_SCHEDULER_ENABLED: "1" },
      { NODE_ENV: "development", VERCEL_ENV: "preview", ID_CADDIE_SLACK_SCHEDULER_ENABLED: "1" },
      { NODE_ENV: "development", VERCEL_ENV: "production", ID_CADDIE_SLACK_SCHEDULER_ENABLED: "1" },
      { NODE_ENV: "test", ID_CADDIE_SLACK_SCHEDULER_ENABLED: "1" }, { NODE_ENV: "development" },
      { NODE_ENV: "development", ID_CADDIE_SLACK_SCHEDULER_ENABLED: "true" },
    ]) expect(isSlackSchedulerEnabled(env)).toBe(false);
  });
});

describe("classifyTargetEligibility — eligibility + retry/backoff policy", () => {
  it("first run (no prior) is eligible", () => {
    expect(classifyTargetEligibility(null, NOW, INTERVAL)).toEqual({ eligible: true, reason: "first_run" });
  });
  it("a non-retryable last failure is NOT retried — auth/scope/config AND any UNKNOWN/permanent code (fail closed)", () => {
    // not just the named codes — permanent Slack token errors + an unrecognized code must also fail closed
    for (const code of ["invalid_auth", "missing_scope", "run_disabled", "missing_tenant", "account_inactive", "token_revoked", "token_expired", "not_authed", "some_future_unknown_code"])
      expect(classifyTargetEligibility({ status: "failed", startedAt: "2026-06-27T09:00:00Z", finishedAt: "2026-06-27T09:00:01Z", errorCode: code }, NOW, INTERVAL))
        .toEqual({ eligible: false, reason: "non_retryable_failure" });
  });
  it("a recent run is in backoff (no rapid re-run); 'running' uses started_at", () => {
    expect(classifyTargetEligibility({ status: "succeeded", startedAt: "2026-06-27T11:50:00Z", finishedAt: "2026-06-27T11:55:00Z", errorCode: null }, NOW, INTERVAL).reason).toBe("backoff");
    expect(classifyTargetEligibility({ status: "running", startedAt: "2026-06-27T11:55:00Z", finishedAt: null, errorCode: null }, NOW, INTERVAL).reason).toBe("backoff");
  });
  it("a transient failure or a success past the backoff is eligible; a stale 'running' is eligible (chain re-locks it)", () => {
    for (const code of ["ratelimited", "slack_error", "malformed_response", "run_crashed", "stale_run_reconciled"])
      expect(classifyTargetEligibility({ status: "failed", startedAt: "2026-06-27T10:00:00Z", finishedAt: "2026-06-27T10:00:05Z", errorCode: code }, NOW, INTERVAL)).toEqual({ eligible: true, reason: "retry_transient" });
    expect(classifyTargetEligibility({ status: "succeeded", startedAt: "2026-06-27T11:00:00Z", finishedAt: "2026-06-27T11:00:05Z", errorCode: null }, NOW, INTERVAL)).toEqual({ eligible: true, reason: "scheduled" });
    expect(classifyTargetEligibility({ status: "running", startedAt: "2026-06-27T10:00:00Z", finishedAt: null, errorCode: null }, NOW, INTERVAL).eligible).toBe(true);
  });
});

describe("parseSchedulerTargets — explicit tenant-scoped connector allowlist", () => {
  it("builds (tenant, connector) targets from the env allowlist; empty without tenant or connectors", () => {
    expect(parseSchedulerTargets({ SLACK_SYNC_TENANT_ID: "tA", ID_CADDIE_SLACK_SCHEDULER_CONNECTORS: "c1, c2 " }))
      .toEqual([{ tenantId: "tA", connectorId: "c1" }, { tenantId: "tA", connectorId: "c2" }]);
    expect(parseSchedulerTargets({ ID_CADDIE_SLACK_SCHEDULER_CONNECTORS: "c1" })).toEqual([]); // no tenant
    expect(parseSchedulerTargets({ SLACK_SYNC_TENANT_ID: "tA" })).toEqual([]); // no connectors
  });
});

describe("schedulerSecretMatches + handleSlackSchedulerRequest — cron-secret + env-flag gate", () => {
  const SEC = { ...DEV, ID_CADDIE_SLACK_SCHEDULER_SECRET: "s3cr3t-cron" };
  it("constant-time secret compare: only an exact non-empty match passes", () => {
    expect(schedulerSecretMatches("s3cr3t-cron", "s3cr3t-cron")).toBe(true);
    for (const [p, e] of [["wrong", "s3cr3t-cron"], ["", "s3cr3t-cron"], ["s3cr3t-cron", undefined], [null, "s3cr3t-cron"], ["s3cr3t-cron", ""]] as [string | null, string | undefined][])
      expect(schedulerSecretMatches(p, e)).toBe(false);
  });
  it("disabled env → 404 hidden, tick NOT called (a request header cannot enable it)", async () => {
    const runTick = vi.fn();
    const res = await handleSlackSchedulerRequest({ env: { NODE_ENV: "production", ID_CADDIE_SLACK_SCHEDULER_SECRET: "s3cr3t-cron" }, secretHeader: "s3cr3t-cron", runTick });
    expect(res.status).toBe(404);
    expect(runTick).not.toHaveBeenCalled();
  });
  it("missing / wrong cron secret → 401, tick NOT called", async () => {
    const runTick = vi.fn();
    expect((await handleSlackSchedulerRequest({ env: SEC, secretHeader: null, runTick })).status).toBe(401);
    expect((await handleSlackSchedulerRequest({ env: SEC, secretHeader: "nope", runTick })).status).toBe(401);
    expect(runTick).not.toHaveBeenCalled();
  });
  it("enabled + correct secret → 200 with the safe tick result", async () => {
    const tick: SchedulerTickResult = { ok: true, ticked: 1, results: [{ connectorId: "c1", status: "succeeded" }] };
    const res = await handleSlackSchedulerRequest({ env: SEC, secretHeader: "s3cr3t-cron", runTick: async () => tick });
    expect(res).toEqual({ status: 200, body: tick });
  });
  it("a tick throw is a SAFE 500 (no raw error)", async () => {
    const res = await handleSlackSchedulerRequest({ env: SEC, secretHeader: "s3cr3t-cron", runTick: async () => { throw new Error("boom secret xoxb-123"); } });
    expect(res.status).toBe(500);
    expect(JSON.stringify(res.body)).not.toContain("xoxb");
  });
});

describe("runSlackSyncSchedulerTick — reconcile/lock/record per eligible target (injected deps)", () => {
  const deps = (over: Partial<SchedulerDeps>): SchedulerDeps =>
    ({ env: DEV, targets: [{ tenantId: "tA", connectorId: "c1" }], nowMs: NOW, intervalMs: INTERVAL, getLatest: async () => null, runOne: async () => ok, ...over });

  it("disabled → no work, no runOne", async () => {
    const runOne = vi.fn(async () => ok);
    expect(await runSlackSyncSchedulerTick(deps({ env: {}, runOne }))).toEqual({ ok: false, errorCode: "scheduler_disabled", ticked: 0, results: [] });
    expect(runOne).not.toHaveBeenCalled();
  });
  it("an eligible target runs the chain and records a safe succeeded result", async () => {
    const runOne = vi.fn(async () => ok);
    const res = await runSlackSyncSchedulerTick(deps({ runOne }));
    expect(runOne).toHaveBeenCalledWith({ tenantId: "tA", connectorId: "c1" });
    expect(res.results).toEqual([{ connectorId: "c1", status: "succeeded", appUsersWritten: 1, peopleWritten: 1, matchesWritten: 1, skippedFacts: 2 }]);
  });
  it("an ineligible (non-retryable / backoff) target is SKIPPED — the chain is NEVER called", async () => {
    const runOne = vi.fn(async () => ok);
    const res = await runSlackSyncSchedulerTick(deps({ runOne, getLatest: async () => ({ status: "failed", startedAt: "2026-06-27T09:00:00Z", finishedAt: "2026-06-27T09:00:01Z", errorCode: "invalid_auth" }) }));
    expect(res.results).toEqual([{ connectorId: "c1", skipped: "non_retryable_failure" }]);
    expect(runOne).not.toHaveBeenCalled();
  });
  it("a duplicate active run is recorded as run_already_active (the chain short-circuits before Slack)", async () => {
    const res = await runSlackSyncSchedulerTick(deps({ runOne: async () => ({ ok: false, errorCode: "run_already_active" }) }));
    expect(res.results).toEqual([{ connectorId: "c1", status: "failed", errorCode: "run_already_active" }]);
  });
  it("results carry no token/JWT/email/name/raw", async () => {
    const blob = JSON.stringify(await runSlackSyncSchedulerTick(deps({})));
    for (const bad of ["xoxb", "Bearer", "@", "profile", "members", "eyJ"]) expect(blob).not.toContain(bad);
  });
});
