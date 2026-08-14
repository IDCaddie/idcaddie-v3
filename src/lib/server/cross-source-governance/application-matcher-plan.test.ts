import { describe, expect, it } from "vitest";
import { MATCHER_METHOD, planApplicationMatches, type CandidateRow } from "./application-matcher-plan";

const row = (d: string, p: string, a: string | null): CandidateRow =>
  ({ directoryApplicationId: d, appProductId: p, appId: a });

describe("application matcher plan — the four evidence states", () => {
  it("proposes nothing for an application the candidate feed never mentions", () => {
    const r = planApplicationMatches(["d1", "d2"], [row("d1", "p1", "a1")]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // d2 is in the census and absent from the feed: its product is UNRESOLVED. Nothing may be proposed for it, and
    // crucially it is still COUNTED — a matcher that forgot it would report a smaller estate than it examined.
    expect(r.plan.counts.unresolvedProductCount).toBe(1);
    expect(r.plan.counts.directoryApplicationCount).toBe(2);
    expect(r.plan.proposals.map(p => p.directoryApplicationId)).toEqual(["d1"]);
  });

  it("proposes nothing for a resolved product with zero operational instances", () => {
    const r = planApplicationMatches(["d1"], [row("d1", "p1", null)]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.plan.counts.zeroInstanceCount).toBe(1);
    expect(r.plan.counts.unresolvedProductCount).toBe(0);   // resolved — a different fact from unresolved
    expect(r.plan.proposals).toHaveLength(0);
  });

  it("proposes ONE candidate at MEDIUM", () => {
    const r = planApplicationMatches(["d1"], [row("d1", "p1", "a1")]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.plan.proposals).toEqual([{ directoryApplicationId: "d1", appId: "a1", confidence: "medium" }]);
    expect(r.plan.counts.oneCandidateCount).toBe(1);
  });

  it("proposes EVERY candidate of an ambiguous group, all at LOW, none ranked", () => {
    const r = planApplicationMatches(["d1"], [row("d1", "p1", "a3"), row("d1", "p1", "a1"), row("d1", "p1", "a2")]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.plan.proposals).toHaveLength(3);
    expect(new Set(r.plan.proposals.map(p => p.confidence))).toEqual(new Set(["low"]));
    expect(r.plan.counts.ambiguousApplicationCount).toBe(1);
    expect(r.plan.counts.oneCandidateCount).toBe(0);
  });

  // CONFIDENCE IS NOT CARDINALITY. This is the assertion that dies if somebody "improves" a lone candidate to `high`
  // because it is unambiguous. The identifier proved the product in both cases; a second instance appearing tomorrow
  // must not retroactively falsify a claim already recorded.
  it("never emits `high`, however unambiguous the evidence", () => {
    const one = planApplicationMatches(["d1"], [row("d1", "p1", "a1")]);
    const many = planApplicationMatches(["d2"], [row("d2", "p2", "a1"), row("d2", "p2", "a2")]);
    expect(one.ok && many.ok).toBe(true);
    if (!one.ok || !many.ok) return;
    for (const p of [...one.plan.proposals, ...many.plan.proposals]) {
      expect(p.confidence === "medium" || p.confidence === "low").toBe(true);
    }
  });

  it("pins the only method this matcher may ever produce", () => {
    expect(MATCHER_METHOD).toBe("canonical_product");
  });
});

describe("application matcher plan — inconsistent evidence FAILS rather than resolves", () => {
  it("fails when the feed names an application the census did not return", () => {
    // Contract drift: the two feeds disagree about which applications exist. Dropping the row would hide it.
    const r = planApplicationMatches(["d1"], [row("d9", "p1", "a1")]);
    expect(r).toEqual({ ok: false, error: "candidate_absent_from_census" });
  });

  it("fails when one directory application resolves to two canonical products", () => {
    const r = planApplicationMatches(["d1"], [row("d1", "p1", "a1"), row("d1", "p2", "a2")]);
    expect(r).toEqual({ ok: false, error: "conflicting_products" });
  });

  it("fails on a NULL instance row alongside a concrete one", () => {
    // "This product has no instances" and "here is one" cannot both be read from the database.
    const r = planApplicationMatches(["d1"], [row("d1", "p1", null), row("d1", "p1", "a1")]);
    expect(r).toEqual({ ok: false, error: "mixed_null_and_concrete" });
  });

  it("fails on a concrete row arriving after a NULL for the same parent, in either order", () => {
    const r = planApplicationMatches(["d1"], [row("d1", "p1", "a1"), row("d1", "p1", null)]);
    expect(r).toEqual({ ok: false, error: "mixed_null_and_concrete" });
  });

  it("fails on a duplicated candidate row rather than deduplicating it", () => {
    const r = planApplicationMatches(["d1"], [row("d1", "p1", "a1"), row("d1", "p1", "a1")]);
    expect(r).toEqual({ ok: false, error: "duplicate_candidate_row" });
  });

  it("fails on a repeated NULL row for one parent", () => {
    const r = planApplicationMatches(["d1"], [row("d1", "p1", null), row("d1", "p1", null)]);
    expect(r).toEqual({ ok: false, error: "mixed_null_and_concrete" });
  });
});

describe("application matcher plan — counters and determinism", () => {
  it("counts an estate with all four states at once", () => {
    const r = planApplicationMatches(
      ["d1", "d2", "d3", "d4"],
      [row("d1", "p1", "a1"), row("d2", "p2", null), row("d3", "p3", "a2"), row("d3", "p3", "a3")],
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.plan.counts).toEqual({
      directoryApplicationCount: 4,
      unresolvedProductCount: 1,      // d4
      zeroInstanceCount: 1,           // d2
      oneCandidateCount: 1,           // d1
      ambiguousApplicationCount: 1,   // d3
      candidateCount: 3,              // a1 + a2 + a3
    });
  });

  it("is a total order, so a replayed run issues identical calls in identical sequence", () => {
    const rows = [row("d2", "p2", "b"), row("d1", "p1", "z"), row("d1", "p1", "a"), row("d2", "p2", "a")];
    const a = planApplicationMatches(["d1", "d2"], rows);
    const b = planApplicationMatches(["d1", "d2"], [...rows].reverse());
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(a.plan.proposals).toEqual(b.plan.proposals);
    expect(a.plan.proposals.map(p => `${p.directoryApplicationId}/${p.appId}`))
      .toEqual(["d1/a", "d1/z", "d2/a", "d2/b"]);
  });

  it("completes over an empty estate — nothing to examine is a valid answer", () => {
    const r = planApplicationMatches([], []);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.plan.proposals).toHaveLength(0);
    expect(r.plan.counts.directoryApplicationCount).toBe(0);
  });

  it("completes over a census where nothing resolves — a real, reportable state", () => {
    const r = planApplicationMatches(["d1", "d2", "d3"], []);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.plan.counts.unresolvedProductCount).toBe(3);
    expect(r.plan.proposals).toHaveLength(0);
  });
});
