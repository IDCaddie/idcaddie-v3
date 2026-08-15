// Phase 18F-C — what the two triggers do, and what they refuse to do.
//
// The static guards prove the flag CHECK is written; these prove it BITES — that a disabled surface does not reach the
// engine at all, rather than reaching it and discarding the result. And that a failure is reported as a failure, with a
// bounded reason, instead of being smoothed into a success an operator would not investigate.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const runTenantApplicationMatcher = vi.fn();
const evaluateTenantCrossSourceGovernance = vi.fn();
const revalidatePath = vi.fn();
const readTenantMatcherState = vi.fn();

// The evaluation's precondition. Defaulted to `completed` so the tests below exercise the reporting they are about;
// the precondition itself is proven in `evaluation-gate.regression.test.ts` against the real reader and real engine.
const COMPLETED_STATE = {
  ok: true as const,
  state: { hasEverRun: true, status: "completed" as const, startedAt: "2026-08-15T09:00:00Z", lastCompletedAt: "2026-08-15T09:14:00Z" },
};

vi.mock("next/cache", () => ({ revalidatePath: (p: string) => revalidatePath(p) }));
vi.mock("@/lib/data/application-matcher", () => ({
  runTenantApplicationMatcher: () => runTenantApplicationMatcher(),
}));
vi.mock("@/lib/data/cross-source-governance-loader", () => ({
  evaluateTenantCrossSourceGovernance: () => evaluateTenantCrossSourceGovernance(),
}));
vi.mock("@/lib/data/governance-ops", () => ({
  readTenantMatcherState: () => readTenantMatcherState(),
}));

const { runEvaluationAction, runMatcherAction } = await import("./actions");

const FLAG = "ID_CADDIE_INTERNAL_GOVERNANCE_OPS_ENABLED";
const completedRun = {
  status: "completed" as const,
  counts: {
    directoryApplicationCount: 4, unresolvedProductCount: 1, zeroInstanceCount: 1,
    oneCandidateCount: 2, ambiguousApplicationCount: 0, candidateCount: 3,
  },
  createdProposalCount: 2, existingProposalCount: 0, acceptedExistingCount: 0, rejectedExistingCount: 0,
};
const okSummary = {
  reported: 3, opened: 1, reopened: 0, refreshed: 2, closed: 0, withheldFromClosure: 0,
  evaluatedRules: ["r1", "r2"], withheldRules: [] as { ruleId: string; reason: string }[],
};

beforeEach(() => {
  vi.clearAllMocks();
  process.env[FLAG] = "1";
  readTenantMatcherState.mockResolvedValue(COMPLETED_STATE);
});
afterEach(() => {
  delete process.env[FLAG];
});

describe("the flag is a refusal, not a display condition", () => {
  it.each(["0", "", undefined])("with the flag %o the matcher is never reached", async (value) => {
    if (value === undefined) delete process.env[FLAG];
    else process.env[FLAG] = value;

    const state = await runMatcherAction(null);

    expect(runTenantApplicationMatcher).not.toHaveBeenCalled();
    expect(state?.ok).toBe(false);
    expect(state?.message).toMatch(/not enabled/);
  });

  it.each(["0", "", undefined])("with the flag %o the evaluation is never reached", async (value) => {
    if (value === undefined) delete process.env[FLAG];
    else process.env[FLAG] = value;

    const state = await runEvaluationAction(null);

    expect(evaluateTenantCrossSourceGovernance).not.toHaveBeenCalled();
    // The flag is checked BEFORE the precondition, so not even the matcher state is read.
    expect(readTenantMatcherState).not.toHaveBeenCalled();
    expect(state?.ok).toBe(false);
  });
});

describe("the matcher trigger", () => {
  it("runs the engine exactly once per press", async () => {
    runTenantApplicationMatcher.mockResolvedValue(completedRun);
    await runMatcherAction(null);
    expect(runTenantApplicationMatcher).toHaveBeenCalledTimes(1);
  });

  it("reports the run's counts", async () => {
    runTenantApplicationMatcher.mockResolvedValue(completedRun);
    const state = await runMatcherAction(null);
    expect(state?.ok).toBe(true);
    const byLabel = Object.fromEntries((state?.counts ?? []).map((c) => [c.label, c.value]));
    expect(byLabel["Directory applications seen"]).toBe(4);
    expect(byLabel["Proposals created"]).toBe(2);
  });

  it("a re-run over settled decisions is a SUCCESS that leaves them counted as human decisions", async () => {
    // The mutant: treating `already_accepted`/`already_rejected` as an error, which would push someone toward
    // re-proposing around a rejection — the one thing the review boundary exists to prevent.
    runTenantApplicationMatcher.mockResolvedValue({
      ...completedRun, createdProposalCount: 0, acceptedExistingCount: 3, rejectedExistingCount: 1,
    });
    const state = await runMatcherAction(null);
    expect(state?.ok).toBe(true);
    const byLabel = Object.fromEntries((state?.counts ?? []).map((c) => [c.label, c.value]));
    expect(byLabel["Already accepted by a human"]).toBe(3);
    expect(byLabel["Already rejected by a human"]).toBe(1);
  });

  it("reports a failure as a failure, with its bounded reason", async () => {
    runTenantApplicationMatcher.mockResolvedValue({ status: "failed", reason: "conflicting_products" });
    const state = await runMatcherAction(null);
    expect(state?.ok).toBe(false);
    expect(state?.message).toMatch(/failed/i);
    expect(state?.message).toMatch(/more than one canonical product/);
    expect(state?.counts).toEqual([]); // a failed run produced no counts; it must not show a zeroed table as if it had
  });

  it("an unrecognised reason is reported without echoing it", async () => {
    runTenantApplicationMatcher.mockResolvedValue({ status: "failed", reason: "PGRST202 token=xoxb-1 at line 40" });
    const state = await runMatcherAction(null);
    expect(state?.ok).toBe(false);
    expect(state?.message).not.toContain("xoxb");
    expect(state?.message).not.toContain("PGRST202");
  });

  it("never retries a failed run — retrying is the operator's decision, not the surface's", async () => {
    // An automatic retry is the first step toward unattended execution, and it would also hide an intermittent failure
    // behind an eventual success. One press, one run.
    runTenantApplicationMatcher.mockResolvedValue({ status: "failed", reason: "query_failed" });
    await runMatcherAction(null);
    expect(runTenantApplicationMatcher).toHaveBeenCalledTimes(1);
  });

  it("revalidates on failure too — the state moved to failed and must be shown", async () => {
    runTenantApplicationMatcher.mockResolvedValue({ status: "failed", reason: "query_failed" });
    await runMatcherAction(null);
    expect(revalidatePath).toHaveBeenCalledWith("/internal/governance-ops");
  });
});

describe("the evaluation trigger", () => {
  it("reports the sync summary", async () => {
    evaluateTenantCrossSourceGovernance.mockResolvedValue({ ok: true, summary: okSummary });
    const state = await runEvaluationAction(null);
    expect(state?.ok).toBe(true);
    const byLabel = Object.fromEntries((state?.counts ?? []).map((c) => [c.label, c.value]));
    expect(byLabel["Refreshed"]).toBe(2);
    expect(byLabel["Withheld from closure"]).toBe(0);
    expect(state?.notes).toEqual([]);
  });

  it("surfaces a withheld closure as a note rather than burying it in a count", async () => {
    evaluateTenantCrossSourceGovernance.mockResolvedValue({
      ok: true, summary: { ...okSummary, closed: 1, withheldFromClosure: 4 },
    });
    const state = await runEvaluationAction(null);
    expect(state?.ok).toBe(true);
    expect(state?.notes.join(" ")).toMatch(/4 finding\(s\) stayed open/);
    expect(state?.notes.join(" ")).toMatch(/correct behaviour, not a failure/);
  });

  it("surfaces a withheld RULE separately from a withheld closure", async () => {
    // Two different silences. A rule that never ran cannot be inferred from a closure count of zero.
    evaluateTenantCrossSourceGovernance.mockResolvedValue({
      ok: true,
      summary: {
        ...okSummary, evaluatedRules: ["r1"],
        withheldRules: [{ ruleId: "inactive_identity_with_active_saas_account", reason: "both sources must be complete" }],
      },
    });
    const state = await runEvaluationAction(null);
    expect(state?.notes.join(" ")).toMatch(/inactive_identity_with_active_saas_account/);
    expect(state?.notes.join(" ")).toMatch(/both sources must be complete/);
  });

  it("a load failure is reported, and nothing is presented as synced", async () => {
    evaluateTenantCrossSourceGovernance.mockResolvedValue({ ok: false, error: "page_limit_exceeded" });
    const state = await runEvaluationAction(null);
    expect(state?.ok).toBe(false);
    expect(state?.message).toMatch(/exceeded its page limit/);
    expect(state?.counts).toEqual([]);
  });
});
