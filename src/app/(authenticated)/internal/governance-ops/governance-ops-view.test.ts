// Phase 18F-C — what the operator surface is allowed to say.
//
// These are not display tests. Each one pins a reading an operator would ACT on: whether the matcher needs running,
// whether rule 5 is firing, whether a failure is being hidden behind a surviving timestamp, and whether anything on
// screen could have come from outside our own bounded vocabulary.

import { describe, expect, it } from "vitest";
import type { MatcherState } from "@/lib/data/governance-ops";
import {
  UNRECOGNISED_REASON, failureReasonLabel, isGovernanceOpsEnabled, matcherCountRows, syncCountRows,
  toMatcherStateView, withheldClosureNote,
} from "./governance-ops-view";

const state = (over: Partial<MatcherState> = {}): MatcherState => ({
  hasEverRun: true, status: "completed", startedAt: "2026-08-15T09:00:00Z", lastCompletedAt: "2026-08-15T09:14:00Z",
  ...over,
});

describe("matcher state — the four states an operator must tell apart", () => {
  it("never run is its own state, not a clean run", () => {
    const v = toMatcherStateView(state({ hasEverRun: false, status: null, startedAt: null, lastCompletedAt: null }));
    expect(v.headline).toBe("never_run");
    expect(v.rule5Licensed).toBe(false);
    expect(v.consequence).toMatch(/unknown rather than unmanaged/);
    // No run has started, so there is no start time to imply one has.
    expect(v.startedAt).toBeNull();
  });

  it("running withholds rule 5 rather than licensing it early", () => {
    const v = toMatcherStateView(state({ status: "running", lastCompletedAt: null }));
    expect(v.headline).toBe("running");
    expect(v.rule5Licensed).toBe(false);
  });

  it("completed licenses rule 5", () => {
    const v = toMatcherStateView(state());
    expect(v.headline).toBe("completed");
    expect(v.rule5Licensed).toBe(true);
    expect(v.historicalCompletionNote).toBeNull(); // the completion IS current; nothing to disambiguate
  });

  it("failed with no prior completion withholds rule 5", () => {
    const v = toMatcherStateView(state({ status: "failed", lastCompletedAt: null }));
    expect(v.headline).toBe("failed");
    expect(v.rule5Licensed).toBe(false);
    expect(v.historicalCompletionNote).toBeNull(); // nothing ever completed, so nothing can be misread as current
  });
});

// ── The mutant this whole file exists for ────────────────────────────────────────────────────────────────────────────
describe("a surviving completion never presents as the current state", () => {
  const failedAfterCompleting = state({ status: "failed" }); // lastCompletedAt is non-null and SURVIVED the failure

  it("the headline is the failure, not the completion", () => {
    const v = toMatcherStateView(failedAfterCompleting);
    expect(v.headline).toBe("failed");
    expect(v.headlineLabel).toBe("Failed");
  });

  it("rule 5 is withheld even though last_completed_at is set", () => {
    // 0085 keeps the timestamp on failure deliberately, and evaluate.ts gates on `status === 'completed'` rather than
    // on the timestamp. A view that derived licensing from the timestamp would claim rule 5 is firing while it is not.
    expect(toMatcherStateView(failedAfterCompleting).rule5Licensed).toBe(false);
    expect(failedAfterCompleting.lastCompletedAt).not.toBeNull();
  });

  it("the surviving timestamp is labelled as historical", () => {
    const v = toMatcherStateView(failedAfterCompleting);
    expect(v.historicalCompletionNote).toMatch(/does NOT describe the current state/);
    expect(v.lastCompletedAt).toBe("2026-08-15T09:14:00Z");
  });

  it("running after a completion is disambiguated the same way", () => {
    const v = toMatcherStateView(state({ status: "running" }));
    expect(v.rule5Licensed).toBe(false);
    expect(v.historicalCompletionNote).not.toBeNull();
  });
});

// ── Bounded reasons ──────────────────────────────────────────────────────────────────────────────────────────────────
describe("failure reasons are an allowlist, not an echo", () => {
  it.each([
    "not_authorized", "query_failed", "pagination_contract_violated", "page_limit_exceeded",
    "proposal_rejected", "state_transition_failed",
    "candidate_absent_from_census", "conflicting_products", "mixed_null_and_concrete", "duplicate_candidate_row",
  ])("%s has reviewed copy", (reason) => {
    const label = failureReasonLabel(reason);
    expect(label).not.toBe(UNRECOGNISED_REASON);
    expect(label.length).toBeGreaterThan(0);
  });

  it("an unrecognised reason is reported WITHOUT echoing its content", () => {
    // The stand-in for what a widened union could carry: a predicate, a row value, a token, a stack.
    const leak = "select * from connectors where token = 'xoxb-REDACT-ME'";
    const label = failureReasonLabel(leak);
    expect(label).toBe(UNRECOGNISED_REASON);
    expect(label).not.toContain("xoxb");
    expect(label).not.toContain("select");
  });

  it("the failure is still reported when the reason is unrecognised", () => {
    // Dropping the string must not drop the fact that something failed — silence is the worse outcome.
    expect(failureReasonLabel("anything")).toMatch(/failed/i);
  });
});

// ── Enablement ───────────────────────────────────────────────────────────────────────────────────────────────────────
describe("the surface is fail-closed", () => {
  it.each([
    {},
    { ID_CADDIE_INTERNAL_GOVERNANCE_OPS_ENABLED: "" },
    { ID_CADDIE_INTERNAL_GOVERNANCE_OPS_ENABLED: "0" },
    { ID_CADDIE_INTERNAL_GOVERNANCE_OPS_ENABLED: "true" },
    { ID_CADDIE_INTERNAL_GOVERNANCE_OPS_ENABLED: "1 " },
  ])("refuses %o", (env) => {
    expect(isGovernanceOpsEnabled(env as Record<string, string | undefined>)).toBe(false);
  });

  it("enables only on an exact opt-in", () => {
    expect(isGovernanceOpsEnabled({ ID_CADDIE_INTERNAL_GOVERNANCE_OPS_ENABLED: "1" })).toBe(true);
  });

  it("no other internal opt-in can enable it", () => {
    expect(isGovernanceOpsEnabled({ ID_CADDIE_INTERNAL_SLACK_TRIGGER_ENABLED: "1", NODE_ENV: "development" })).toBe(false);
  });
});

// ── Counts ───────────────────────────────────────────────────────────────────────────────────────────────────────────
describe("run counts", () => {
  const counts = {
    directoryApplicationCount: 12, unresolvedProductCount: 5, zeroInstanceCount: 2,
    oneCandidateCount: 3, ambiguousApplicationCount: 2, candidateCount: 9,
  };

  it("reports every operator count the run produced", () => {
    const rows = matcherCountRows(counts, {
      createdProposalCount: 3, existingProposalCount: 1, acceptedExistingCount: 2, rejectedExistingCount: 1,
    });
    const byLabel = Object.fromEntries(rows.map((r) => [r.label, r.value]));
    expect(byLabel["Product unresolved"]).toBe(5);
    expect(byLabel["Resolved, zero instances"]).toBe(2);
    expect(byLabel["Ambiguous candidates"]).toBe(2);
    expect(byLabel["Proposals created"]).toBe(3);
  });

  it("a re-run over settled decisions reports them as human decisions, not as matcher output", () => {
    const rows = matcherCountRows(counts, {
      createdProposalCount: 0, existingProposalCount: 0, acceptedExistingCount: 4, rejectedExistingCount: 2,
    });
    const byLabel = Object.fromEntries(rows.map((r) => [r.label, r.value]));
    expect(byLabel["Already accepted by a human"]).toBe(4);
    expect(byLabel["Already rejected by a human"]).toBe(2);
    // Nothing here reads as an error or as the matcher having decided anything.
    expect(rows.every((r) => !/error|failed|reset/i.test(r.label))).toBe(true);
  });

  it("sync counts surface withheld closures alongside the rest", () => {
    const rows = syncCountRows({ reported: 7, opened: 2, reopened: 1, refreshed: 4, closed: 3, withheldFromClosure: 2 });
    expect(rows.map((r) => r.label)).toContain("Withheld from closure");
    expect(rows.find((r) => r.label === "Withheld from closure")?.value).toBe(2);
  });
});

describe("a withheld closure reads as correct behaviour, not as a failure", () => {
  it("says nothing when nothing was withheld", () => {
    expect(withheldClosureNote(0)).toBeNull();
  });

  it("explains the incomplete evidence and the remedy", () => {
    const note = withheldClosureNote(3);
    expect(note).toContain("3");
    expect(note).toMatch(/correct behaviour, not a failure/);
    expect(note).toMatch(/re-run once those connectors have synced/);
  });

  it("never tells an operator to widen what counts as complete", () => {
    // The dangerous "fix" for a withheld closure is to relax the completeness test, which closes findings on evidence
    // that proved nothing. The copy must not suggest it.
    expect(withheldClosureNote(3)).not.toMatch(/force|override|ignore|disable|bypass/i);
  });
});
