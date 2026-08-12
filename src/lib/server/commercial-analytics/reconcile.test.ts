import { describe, it, expect } from "vitest";
import { reconcileEntitlement, estimateOpportunity, compareGap, type EntitlementInput, type DiscoveredCounts } from "./reconcile";
import type { CapabilityStatus } from "@/lib/canonical/capabilities";
import type { ConceptCapabilities, Measure } from "./types";

// The whole point of this engine is that five different quantities never become one. These tests exist to fail loudly the day
// someone "simplifies" an unavailable measure into a zero, or values a surplus without the cadence that makes it annual.

const capability = (state: CapabilityStatus["state"], explanation: string): CapabilityStatus => ({
  capability: "app_accounts", label: "Application accounts", provider: "slack", connectorId: "conn-1",
  support: state === "unavailable" ? "planned" : "implemented", state, lastObservedAt: null,
  confidence: state === "available" ? "high" : "none", explanation,
});

// Today's real posture: app_accounts is implemented for Slack; licenses and usage are `planned`, so both resolve unavailable.
const CAPS: ConceptCapabilities = {
  assigned: capability("unavailable", "Application assignments is not available for slack yet."),
  provisioned: capability("available", "Application accounts is current from the connected directory."),
  billable: capability("unavailable", "Licenses is not available for slack yet."),
  active: capability("unavailable", "Usage is not available for slack yet."),
};

const line = (over: Partial<EntitlementInput> = {}): EntitlementInput => ({
  id: "e1", contractId: "c1", sku: "SLACK-BUSINESS-PLUS", planName: null,
  vendorId: null, appProductId: null, termStart: null, termEnd: null,
  purchasedQuantity: 3200, minimumQuantity: null, quantityUnit: "seat",
  unitAmount: 12.5, currency: "USD", billingFrequency: "monthly",
  measuredByConnectionId: "conn-1", source: "order_form", confidence: "high", hasEvidenceDocument: true,
  ...over,
});

const counts = (over: Partial<DiscoveredCounts> = {}): DiscoveredCounts => ({
  current: 3011, stale: 0, inactive: 0, lastSeenAt: "2026-08-12T00:00:00Z", ...over,
});

describe("the five quantities stay apart", () => {
  it("measures purchased and provisioned, and reports billable and active as unavailable — never zero", () => {
    const r = reconcileEntitlement(line(), counts(), CAPS);

    expect(r.measures.purchased).toEqual({ state: "measured", value: 3200, asOf: null, basis: expect.any(String) });
    expect(r.measures.provisioned.state).toBe("measured");
    expect(r.measures.provisioned).toMatchObject({ value: 3011 });

    // The two that have no source. If either of these ever becomes `measured`, a source was invented.
    expect(r.measures.billable.state).toBe("unavailable");
    expect(r.measures.active.state).toBe("unavailable");
    expect(r.measures.assigned.state).toBe("unavailable");

    // And none of them carries a number, at the type level and at runtime.
    for (const c of ["billable", "active", "assigned"] as const) {
      expect(r.measures[c]).not.toHaveProperty("value");
    }
  });

  it("carries the capability model's own explanation, so the product has one vocabulary for 'we cannot know'", () => {
    const r = reconcileEntitlement(line(), counts(), CAPS);
    expect((r.measures.active as Extract<Measure, { state: "unavailable" }>).explanation).toBe("Usage is not available for slack yet.");
  });

  it("an unrecorded purchase is not_recorded, and it is not comparable to anything", () => {
    const r = reconcileEntitlement(line({ purchasedQuantity: null }), counts(), CAPS);
    expect(r.measures.purchased.state).toBe("not_recorded");
    expect(r.gap.state).toBe("not_comparable");
    expect(r.opportunity.state).toBe("not_estimable");
  });

  it("a line with no declared measurement source is not_measured — distinct from a capability being unavailable", () => {
    const r = reconcileEntitlement(line({ measuredByConnectionId: null }), counts(), CAPS);
    expect(r.measures.provisioned.state).toBe("not_measured");
    expect(r.gap.state).toBe("not_comparable");
  });

  it("a failed read of the declared connector is unavailable, not zero provisioned", () => {
    const r = reconcileEntitlement(line(), null, CAPS);
    expect(r.measures.provisioned.state).toBe("unavailable");
    expect(r.gap.state).toBe("not_comparable");
  });

  it("flags stale evidence without hiding the number", () => {
    const r = reconcileEntitlement(line(), counts({ stale: 12 }), CAPS);
    expect(r.staleEvidence).toBe(true);
    expect(r.measures.provisioned.state).toBe("measured");
  });
});

describe("compareGap", () => {
  const measured = (v: number): Measure => ({ state: "measured", value: v, asOf: null, basis: "x" });
  const missing: Measure = { state: "not_measured", explanation: "none" };

  it("names the direction rather than returning a signed number", () => {
    expect(compareGap(measured(3200), measured(3011))).toMatchObject({ state: "purchase_exceeds_discovered", surplus: 189 });
    expect(compareGap(measured(3000), measured(3011))).toMatchObject({ state: "discovered_exceeds_purchase", excess: 11 });
    expect(compareGap(measured(50), measured(50))).toMatchObject({ state: "aligned", quantity: 50 });
    expect(compareGap(measured(1), missing).state).toBe("not_comparable");
    expect(compareGap(missing, measured(1)).state).toBe("not_comparable");
  });
});

describe("the savings estimate", () => {
  it("values only the surplus, at the recorded price and cadence", () => {
    const gap = compareGap(
      { state: "measured", value: 3200, asOf: null, basis: "x" },
      { state: "measured", value: 3011, asOf: null, basis: "y" },
    );
    const o = estimateOpportunity(line(), gap);
    expect(o.state).toBe("estimated");
    // 189 surplus × $12.50/seat/month × 12 months
    expect(o).toMatchObject({ reducibleQuantity: 189, annualAmount: 28350, currency: "USD" });
    // The arithmetic is always available — a money figure with no basis is not shippable.
    expect((o as { basis: string }).basis).toContain("189");
  });

  it("stops at the contracted minimum instead of overstating the saving", () => {
    const gap = compareGap(
      { state: "measured", value: 3200, asOf: null, basis: "x" },
      { state: "measured", value: 2000, asOf: null, basis: "y" },
    );
    // Only 3200 → 3000 is reducible, not 3200 → 2000, because 3000 is committed.
    const o = estimateOpportunity(line({ minimumQuantity: 3000 }), gap);
    expect(o).toMatchObject({ state: "estimated", reducibleQuantity: 200, annualAmount: 30000, floor: 3000 });
    expect((o as { basis: string }).basis).toContain("contracted minimum");
  });

  it("returns none when the minimum already covers the whole surplus", () => {
    const gap = compareGap(
      { state: "measured", value: 3200, asOf: null, basis: "x" },
      { state: "measured", value: 3000, asOf: null, basis: "y" },
    );
    expect(estimateOpportunity(line({ minimumQuantity: 3200 }), gap).state).toBe("none");
  });

  it("annualizes quarterly and annual cadences correctly", () => {
    const gap = compareGap(
      { state: "measured", value: 110, asOf: null, basis: "x" },
      { state: "measured", value: 100, asOf: null, basis: "y" },
    );
    expect(estimateOpportunity(line({ billingFrequency: "quarterly", unitAmount: 30 }), gap)).toMatchObject({ annualAmount: 1200 });
    expect(estimateOpportunity(line({ billingFrequency: "annual", unitAmount: 120 }), gap)).toMatchObject({ annualAmount: 1200 });
  });

  it("refuses to annualize a cadence a unit price cannot express", () => {
    const gap = compareGap(
      { state: "measured", value: 110, asOf: null, basis: "x" },
      { state: "measured", value: 100, asOf: null, basis: "y" },
    );
    for (const f of ["multi_year", "one_time"]) {
      const o = estimateOpportunity(line({ billingFrequency: f }), gap);
      expect(o.state).toBe("not_estimable");
    }
  });

  it("refuses to value a surplus with no recorded price", () => {
    const gap = compareGap(
      { state: "measured", value: 110, asOf: null, basis: "x" },
      { state: "measured", value: 100, asOf: null, basis: "y" },
    );
    expect(estimateOpportunity(line({ unitAmount: null, currency: null, billingFrequency: null }), gap).state).toBe("not_estimable");
  });

  it("claims nothing when more accounts exist than were bought", () => {
    const gap = compareGap(
      { state: "measured", value: 100, asOf: null, basis: "x" },
      { state: "measured", value: 120, asOf: null, basis: "y" },
    );
    expect(estimateOpportunity(line(), gap).state).toBe("none");
  });
});
