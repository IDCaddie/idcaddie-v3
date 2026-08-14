// Phase 18C — the pure planner.
//
// The property this suite protects: the planner must keep "no product evidence yet" and "a product with nothing
// operational under it" apart, and must never invent a preference between ambiguous candidates. Those are the two
// places a matcher launders uncertainty into something a reviewer would trust.

import { describe, expect, it } from "vitest";
import { planApplicationMatches, classify, MATCHER_METHOD, type CandidateRow, type CensusRow } from "./plan";

const census = (...ids: string[]): CensusRow[] => ids.map(id => ({ id }));
const row = (directoryApplicationId: string, appProductId: string, appId: string | null): CandidateRow =>
  ({ directoryApplicationId, appProductId, appId });

const ok = (p: ReturnType<typeof planApplicationMatches>) => {
  expect(p.ok).toBe(true);
  if (!p.ok) throw new Error("expected a plan");
  return p;
};

describe("classification of the four states", () => {
  it("P11 an application in the census but absent from the feed is PRODUCT UNRESOLVED", () => {
    const p = ok(planApplicationMatches(census("d1"), []));
    expect(p.counts.unresolvedProducts).toBe(1);
    expect(p.proposals).toHaveLength(0);
    expect(classify(census("d1"), [], "d1")).toBe("product_unresolved");
  });

  it("P12 a NULL app row is RESOLVED WITH ZERO INSTANCES — a different fact, and still no proposal", () => {
    const c = [row("d1", "p1", null)];
    const p = ok(planApplicationMatches(census("d1"), c));
    expect(p.counts.resolvedZeroInstances).toBe(1);
    expect(p.counts.unresolvedProducts).toBe(0);
    expect(p.proposals).toHaveLength(0);
    expect(classify(census("d1"), c, "d1")).toBe("resolved_zero_instances");
  });

  it("P13 one concrete candidate yields one proposal at MEDIUM", () => {
    const p = ok(planApplicationMatches(census("d1"), [row("d1", "p1", "a1")]));
    expect(p.proposals).toEqual([
      { directoryApplicationId: "d1", appId: "a1", method: MATCHER_METHOD, confidence: "medium" },
    ]);
    expect(p.counts.oneCandidateApplications).toBe(1);
  });

  it("P14/P22 many candidates yield a proposal for EVERY one, all at LOW", () => {
    const c = [row("d1", "p1", "a3"), row("d1", "p1", "a1"), row("d1", "p1", "a2")];
    const p = ok(planApplicationMatches(census("d1"), c));
    expect(p.proposals.map(x => x.appId)).toEqual(["a1", "a2", "a3"]);
    expect(p.proposals.every(x => x.confidence === "low")).toBe(true);
    expect(p.counts.ambiguousApplications).toBe(1);
    expect(p.counts.candidateCount).toBe(3);
    expect(classify(census("d1"), c, "d1")).toBe("many_candidates");
  });

  it("P23 no candidate in an ambiguous group is preferred — none is medium, none is marked best", () => {
    const p = ok(planApplicationMatches(census("d1"), [row("d1", "p1", "a1"), row("d1", "p1", "a2")]));
    expect(new Set(p.proposals.map(x => x.confidence))).toEqual(new Set(["low"]));
    // Every proposal carries exactly the same shape; there is no rank, score or order field to prefer one.
    expect(Object.keys(p.proposals[0]).sort()).toEqual(["appId", "confidence", "directoryApplicationId", "method"]);
  });

  it("N=1 never becomes high — one instance is a fact about the estate, not about the evidence", () => {
    const p = ok(planApplicationMatches(census("d1"), [row("d1", "p1", "a1")]));
    expect(p.proposals[0].confidence).toBe("medium");
  });

  it("P24 ordering is deterministic and independent of feed order", () => {
    const forward = planApplicationMatches(census("d1", "d2"), [row("d2", "p2", "b1"), row("d1", "p1", "a2"), row("d1", "p1", "a1")]);
    const reverse = planApplicationMatches(census("d2", "d1"), [row("d1", "p1", "a1"), row("d1", "p1", "a2"), row("d2", "p2", "b1")]);
    expect(JSON.stringify(reverse)).toBe(JSON.stringify(forward));
  });

  it("P19/P20 a mixed estate proposes only for resolved applications that have instances", () => {
    const p = ok(planApplicationMatches(
      census("d1", "d2", "d3", "d4"),
      [row("d2", "p2", null), row("d3", "p3", "a1"), row("d4", "p4", "b1"), row("d4", "p4", "b2")],
    ));
    expect(p.counts).toEqual({
      directoryApplications: 4, unresolvedProducts: 1, resolvedZeroInstances: 1,
      oneCandidateApplications: 1, ambiguousApplications: 1, candidateCount: 3,
    });
    expect(p.proposals.map(x => `${x.directoryApplicationId}:${x.appId}:${x.confidence}`))
      .toEqual(["d3:a1:medium", "d4:b1:low", "d4:b2:low"]);
  });
});

describe("cross-feed disagreements fail rather than being repaired", () => {
  it("P15 a candidate whose application is not in the census is invalid", () => {
    const p = planApplicationMatches(census("d1"), [row("dX", "p1", "a1")]);
    expect(p.ok).toBe(false);
    expect(p.ok === false && p.violation).toBe("candidate_absent_from_census");
  });

  it("P16 two products for one application is invalid — picking either would be a coin toss recorded as fact", () => {
    const p = planApplicationMatches(census("d1"), [row("d1", "p1", "a1"), row("d1", "p2", "a2")]);
    expect(p.ok === false && p.violation).toBe("conflicting_app_product");
  });

  it.each([
    ["NULL then concrete", [["d1", "p1", null], ["d1", "p1", "a1"]]],
    ["concrete then NULL", [["d1", "p1", "a1"], ["d1", "p1", null]]],
    ["two NULLs", [["d1", "p1", null], ["d1", "p1", null]]],
  ] as const)("P17 %s is invalid — a group cannot claim both zero and some instances", (_l, rows) => {
    const p = planApplicationMatches(census("d1"), rows.map(r => row(r[0], r[1], r[2])));
    expect(p.ok === false && p.violation).toBe("null_and_concrete_candidates");
  });

  it("P18 a duplicated concrete candidate is invalid — deduplicating would hide a broken read", () => {
    const p = planApplicationMatches(census("d1"), [row("d1", "p1", "a1"), row("d1", "p1", "a1")]);
    expect(p.ok === false && p.violation).toBe("duplicate_candidate");
  });
});

describe("empty and negative estates are valid plans, not failures", () => {
  it("P1/P2 an empty estate plans nothing and violates nothing", () => {
    const p = ok(planApplicationMatches([], []));
    expect(p.proposals).toHaveLength(0);
    expect(p.counts.directoryApplications).toBe(0);
  });

  it("an entirely unresolved estate is a valid plan with zero proposals", () => {
    const p = ok(planApplicationMatches(census("d1", "d2", "d3"), []));
    expect(p.counts.unresolvedProducts).toBe(3);
    expect(p.proposals).toHaveLength(0);
  });

  it("an estate where every product has zero instances is a valid plan with zero proposals", () => {
    const p = ok(planApplicationMatches(census("d1", "d2"), [row("d1", "p1", null), row("d2", "p2", null)]));
    expect(p.counts.resolvedZeroInstances).toBe(2);
    expect(p.proposals).toHaveLength(0);
  });
});

describe("provider neutrality", () => {
  it("an unknown provider is not representable in the planner's inputs at all", () => {
    // The planner sees only canonical row ids. There is no provider field to branch on, which is the strongest form
    // of neutrality available: not "we do not branch", but "there is nothing to branch on".
    const p = ok(planApplicationMatches(census("d1"), [row("d1", "p1", "a1")]));
    expect(JSON.stringify(p)).not.toMatch(/okta|slack|google|entra|github|microsoft/i);
  });
});
