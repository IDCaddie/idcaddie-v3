import { describe, it, expect } from "vitest";
import { matchRateSummary, statusDistributionSegments } from "./account-match-summary";

describe("matchRateSummary", () => {
  it("0 total → 0%, no NaN", () => {
    expect(matchRateSummary(0, 0)).toEqual({ matched: 0, unmatched: 0, total: 0, ratePct: 0 });
  });
  it("all matched → 100%", () => {
    expect(matchRateSummary(5, 0)).toMatchObject({ total: 5, ratePct: 100 });
  });
  it("mixed → floors (never rounds up while unmatched > 0)", () => {
    expect(matchRateSummary(2, 1).ratePct).toBe(66); // 2/3 = 66.67 → 66
    expect(matchRateSummary(1, 2).ratePct).toBe(33);
    expect(matchRateSummary(99, 1).ratePct).toBe(99); // never shows 100% with an unmatched account
  });
});

describe("statusDistributionSegments", () => {
  it("empty buckets → total 0, no segments", () => {
    expect(statusDistributionSegments([])).toEqual({ total: 0, segments: [] });
  });
  it("computes pct of the sum and preserves the buckets", () => {
    const { total, segments } = statusDistributionSegments([
      { key: "active", label: "Active", count: 3, tone: "success" },
      { key: "inactive", label: "Inactive", count: 1, tone: "attention" },
    ]);
    expect(total).toBe(4);
    expect(segments.map((s) => s.pct)).toEqual([75, 25]);
    expect(segments[0].label).toBe("Active");
  });
  it("zero counts are safe (pct 0)", () => {
    const { segments } = statusDistributionSegments([{ key: "a", label: "A", count: 0, tone: "neutral" }]);
    expect(segments[0].pct).toBe(0);
  });
});
