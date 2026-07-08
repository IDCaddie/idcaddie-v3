import { describe, it, expect } from "vitest";
import { buildSpendBarSegments, buildRenewalSegmentSummary, buildUpcomingRenewalRows } from "./dashboard-charts";
import type { RenewalItem } from "./dashboard-overview";

const item = (o: Partial<RenewalItem>): RenewalItem => ({
  id: "c",
  contractName: "C",
  date: "2026-07-20",
  daysUntil: 10,
  basis: "renewal",
  ...o,
});

describe("buildSpendBarSegments", () => {
  it("null or empty spend → []", () => {
    expect(buildSpendBarSegments(null)).toEqual([]);
    expect(buildSpendBarSegments({ byCurrency: [], contractsWithCost: 0 })).toEqual([]);
  });
  it("scales widthPct to the largest total, preserves order, formats labels", () => {
    const segs = buildSpendBarSegments({
      byCurrency: [
        { currency: "USD", total: 3000, contractCount: 2 },
        { currency: "EUR", total: 1000, contractCount: 1 },
      ],
      contractsWithCost: 3,
    });
    expect(segs.map((s) => s.currency)).toEqual(["USD", "EUR"]);
    expect(segs[0].widthPct).toBe(100);
    expect(segs[1].widthPct).toBe(33);
    expect(segs[0].label).toMatch(/3,000/);
  });
  it("zero totals are safe (no NaN, widthPct 0)", () => {
    const segs = buildSpendBarSegments({ byCurrency: [{ currency: "USD", total: 0, contractCount: 1 }], contractsWithCost: 1 });
    expect(segs[0].widthPct).toBe(0);
  });
});

describe("buildRenewalSegmentSummary", () => {
  it("null → total 0, no segments", () => {
    expect(buildRenewalSegmentSummary(null)).toEqual({ total: 0, segments: [] });
  });
  it("segment counts sum to total, pct add up, missing bucket represented", () => {
    const s = buildRenewalSegmentSummary({
      due30: [item({}), item({})],
      due90: [item({})],
      missing: 1,
      topUpcoming: [],
    });
    expect(s.total).toBe(4);
    expect(s.segments.reduce((n, x) => n + x.count, 0)).toBe(4);
    expect(s.segments.find((x) => x.key === "missing")?.count).toBe(1);
    expect(s.segments.map((x) => x.pct)).toEqual([50, 25, 25]); // due30 2/4, due90 1/4, missing 1/4
  });
});

describe("buildUpcomingRenewalRows", () => {
  it("tones by urgency and labels today/in Nd", () => {
    const rows = buildUpcomingRenewalRows([
      item({ id: "a", daysUntil: 0 }),
      item({ id: "b", daysUntil: 5 }),
      item({ id: "c", daysUntil: 20 }),
      item({ id: "d", daysUntil: 60 }),
    ]);
    expect(rows.map((r) => r.tone)).toEqual(["danger", "danger", "attention", "neutral"]);
    expect(rows.map((r) => r.urgencyLabel)).toEqual(["today", "in 5d", "in 20d", "in 60d"]);
  });
  it("empty input → []", () => {
    expect(buildUpcomingRenewalRows([])).toEqual([]);
  });
});
