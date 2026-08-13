import { describe, it, expect } from "vitest";
import { reconcileEntitlement, type EntitlementInput, type DiscoveredCounts } from "./reconcile";
import type { CapabilityStatus } from "@/lib/canonical/capabilities";
import type { ConceptCapabilities, Measure } from "./types";

// Review of PR #409 — the three ways a fabricated zero could still reach a customer.

const capability = (over: Partial<CapabilityStatus> = {}): CapabilityStatus => ({
  capability: "app_accounts", label: "Application accounts", provider: "slack", connectorId: "conn-1",
  support: "implemented", state: "available", lastObservedAt: null, confidence: "high",
  explanation: "Application accounts is current from the connected directory.", ...over,
});

const line = (over: Partial<EntitlementInput> = {}): EntitlementInput => ({
  id: "e1", contractId: "c1", sku: "SLACK", planName: null, vendorId: null, appProductId: null,
  termStart: null, termEnd: null, purchasedQuantity: 3200, minimumQuantity: null, quantityUnit: "seat",
  unitAmount: 12.5, currency: "USD", billingFrequency: "monthly", measuredByConnectionId: "conn-okta",
  source: "order_form", confidence: "high", hasEvidenceDocument: true, ...over,
});

const value = (m: Measure): number | null => (m.state === "measured" ? m.value : null);

describe("a connector that cannot answer must not answer zero", () => {
  // The attack: the workspace has BOTH a Slack connector (app_accounts implemented) and an Okta connector
  // (app_accounts merely 'planned'). The line declares the OKTA one. A workspace-wide capability verdict says
  // "available" because Slack exists, the counts RPC returns 0 rows for the Okta connection, and the whole purchase
  // becomes a savings opportunity that no evidence supports.
  it("reports provisioned as unavailable when the DECLARED connector's provider has no account evidence capability", () => {
    const caps: ConceptCapabilities = {
      assigned: capability({ state: "unavailable", explanation: "x" }),
      // Resolved against the declared connector — Okta does not implement app_accounts, so this is unavailable.
      provisioned: capability({ state: "unavailable", provider: "okta", support: "planned", explanation: "Application accounts is not available for okta yet." }),
      billable: capability({ state: "unavailable", explanation: "y" }),
      active: capability({ state: "unavailable", explanation: "z" }),
    };
    const counts: DiscoveredCounts = { current: 0, stale: 0, inactive: 0, totalEvidence: 0, lastSeenAt: null };

    const r = reconcileEntitlement(line(), counts, caps);
    expect(r.measures.provisioned.state).toBe("unavailable");
    expect(value(r.measures.provisioned)).toBeNull();
    expect(r.gap.state).toBe("not_comparable");
    expect(r.opportunity.state).toBe("not_estimable");
  });

  it("reports provisioned as unavailable when the declared connector holds NO account evidence at all", () => {
    // Capability is genuinely available for this connector, but the connector has produced zero account rows —
    // current 0 AND totalEvidence 0. "Discovery has not produced accounts" and "there are no accounts" are different
    // claims, and only the first is supported.
    const caps: ConceptCapabilities = {
      assigned: capability({ state: "unavailable", explanation: "x" }),
      provisioned: capability(),
      billable: capability({ state: "unavailable", explanation: "y" }),
      active: capability({ state: "unavailable", explanation: "z" }),
    };
    const counts: DiscoveredCounts = { current: 0, stale: 0, inactive: 0, totalEvidence: 0, lastSeenAt: null };

    const r = reconcileEntitlement(line({ measuredByConnectionId: "conn-1" }), counts, caps);
    expect(r.measures.provisioned.state).toBe("unavailable");
    expect(r.opportunity.state).toBe("not_estimable");
  });

  it("still reports a real zero-current reading when retained evidence proves discovery ran", () => {
    // Every account went stale: current 0 but totalEvidence 12. That IS a supported reading of "0 current".
    const caps: ConceptCapabilities = {
      assigned: capability({ state: "unavailable", explanation: "x" }),
      provisioned: capability({ state: "stale" }),
      billable: capability({ state: "unavailable", explanation: "y" }),
      active: capability({ state: "unavailable", explanation: "z" }),
    };
    const counts: DiscoveredCounts = { current: 0, stale: 12, inactive: 0, totalEvidence: 12, lastSeenAt: null };
    const r = reconcileEntitlement(line({ measuredByConnectionId: "conn-1" }), counts, caps);
    expect(r.measures.provisioned.state).toBe("measured");
    expect(value(r.measures.provisioned)).toBe(0);
    expect(r.staleEvidence).toBe(true);
  });
});

describe("an unsupported quantity must never echo an availability claim", () => {
  // The attack: Okta IS connected and DOES implement `assignments`, so resolveCapability("assignments") returns
  // state 'available' with "Application assignments is current from the connected directory." Assigned is still not
  // readable here (it needs an accepted application_match, and no matcher exists) — so echoing that sentence under a
  // cell showing no number tells the customer assigned counts are available when they are not.
  it("does not tell the customer assigned is current when it cannot be read", () => {
    const caps: ConceptCapabilities = {
      assigned: capability({ capability: "assignments", label: "Application assignments", provider: "okta", state: "available", explanation: "Application assignments is current from the connected directory." }),
      provisioned: capability(),
      billable: capability({ state: "unavailable", explanation: "Licenses is not available for slack yet." }),
      active: capability({ state: "unavailable", explanation: "Usage is not available for slack yet." }),
    };
    const counts: DiscoveredCounts = { current: 3011, stale: 0, inactive: 0, totalEvidence: 3011, lastSeenAt: null };
    const r = reconcileEntitlement(line({ measuredByConnectionId: "conn-1" }), counts, caps);

    const assigned = r.measures.assigned as Extract<Measure, { state: "unavailable" }>;
    expect(assigned.state).toBe("unavailable");
    for (const claim of ["is current", "available from", "connected directory"]) {
      expect(assigned.explanation.toLowerCase(), claim).not.toContain(claim);
    }
    // It must say why it cannot be read instead.
    expect(assigned.explanation.toLowerCase()).toMatch(/match|not represented|no source|cannot/);
  });

  it("keeps echoing the capability's own sentence when the capability really is unavailable", () => {
    const caps: ConceptCapabilities = {
      assigned: capability({ state: "unavailable", explanation: "Application assignments is not available for slack yet." }),
      provisioned: capability(),
      billable: capability({ state: "unavailable", explanation: "Licenses is not available for slack yet." }),
      active: capability({ state: "unavailable", explanation: "Usage is not available for slack yet." }),
    };
    const counts: DiscoveredCounts = { current: 10, stale: 0, inactive: 0, totalEvidence: 10, lastSeenAt: null };
    const r = reconcileEntitlement(line({ measuredByConnectionId: "conn-1" }), counts, caps);
    expect((r.measures.billable as Extract<Measure, { state: "unavailable" }>).explanation).toBe("Licenses is not available for slack yet.");
  });
});
