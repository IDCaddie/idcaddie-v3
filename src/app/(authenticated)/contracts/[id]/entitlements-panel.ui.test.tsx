// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { EntitlementsPanel } from "./entitlements-panel";
import { reconcileEntitlement, type EntitlementInput, type DiscoveredCounts } from "@/lib/server/commercial-analytics/reconcile";
import type { CapabilityStatus } from "@/lib/canonical/capabilities";
import type { ConceptCapabilities } from "@/lib/server/commercial-analytics/types";
import type { ContractCommercialView } from "@/lib/data/commercial-loader";

afterEach(cleanup);

const cap = (state: CapabilityStatus["state"], explanation: string): CapabilityStatus => ({
  capability: "app_accounts", label: "L", provider: "slack", connectorId: "c", support: "implemented",
  state, lastObservedAt: null, confidence: "high", explanation,
});
const CAPS: ConceptCapabilities = {
  assigned: cap("unavailable", "Application assignments is not available for slack yet."),
  provisioned: cap("available", "Application accounts is current."),
  billable: cap("unavailable", "Licenses is not available for slack yet."),
  active: cap("unavailable", "Usage is not available for slack yet."),
};

const line: EntitlementInput = {
  id: "e1", contractId: "c1", sku: "SLACK-BUSINESS-PLUS", planName: null, vendorId: null, appProductId: null,
  termStart: null, termEnd: null, purchasedQuantity: 3200, minimumQuantity: null, quantityUnit: "seat",
  unitAmount: 12.5, currency: "USD", billingFrequency: "monthly", measuredByConnectionId: "conn-1",
  source: "order_form", confidence: "high", hasEvidenceDocument: true,
};
const counts: DiscoveredCounts = { current: 3011, stale: 0, inactive: 0, lastSeenAt: null };

const view = (over: Partial<ContractCommercialView> = {}): ContractCommercialView => ({
  reconciliations: [reconcileEntitlement(line, counts, CAPS)],
  findings: [],
  summary: { total: 0, bySeverity: { info: 0, low: 0, medium: 0, high: 0 }, annualOpportunityByCurrency: {} },
  entitlementCount: 1,
  discoveredEvidenceReadable: true,
  ...over,
});

describe("the entitlements panel", () => {
  it("shows the measured quantities and the estimate, with the arithmetic beside it", () => {
    const { container } = render(<EntitlementsPanel view={view()} contractId="c1" />);
    const text = container.textContent ?? "";

    expect(text).toContain("3,200");
    expect(text).toContain("3,011");
    // 189 × $12.50 × 12
    expect(text).toContain("$28,350 / year");
    expect(text).toContain("189");   // the basis string carries the working
  });

  it("renders a sentence — never a number and never a bare dash — for a quantity with no source", () => {
    const { container } = render(<EntitlementsPanel view={view()} contractId="c1" />);
    const text = container.textContent ?? "";

    // The two quantities nothing produces today.
    expect(text).toContain("Licenses is not available for slack yet.");
    expect(text).toContain("Usage is not available for slack yet.");
    // And they are NOT rendered as zero. A "0" anywhere in the panel would be the regression this whole phase exists to
    // prevent, so assert on the rendered cells rather than trusting the copy.
    const cells = Array.from(container.querySelectorAll("div")).map((d) => d.textContent ?? "");
    for (const label of ["Billable", "Active", "Assigned"]) {
      const cell = cells.find((c) => c.startsWith(label));
      expect(cell, label).toBeTruthy();
      expect(cell, `${label} must not render a number`).not.toMatch(/\d/);
    }
  });

  it("says a contract with no purchased line is unrecorded, not zero", () => {
    render(<EntitlementsPanel view={view({ reconciliations: [], entitlementCount: 0 })} contractId="c1" />);
    expect(screen.getByText(/This is not a quantity of zero/)).toBeTruthy();
  });

  it("explains an unreadable comparison instead of showing an empty one", () => {
    const unreadable = reconcileEntitlement(line, null, CAPS);
    render(<EntitlementsPanel view={view({ reconciliations: [unreadable], discoveredEvidenceReadable: false })} contractId="c1" />);
    expect(screen.getByText(/not readable with your access/)).toBeTruthy();
    // Three times, deliberately: the Provisioned cell, the comparison row, and the estimate row. Every place a reader might
    // look for a number carries the explanation instead of a blank — repetition is the cheaper mistake here.
    expect(screen.getAllByText(/This is not a statement that there are none/)).toHaveLength(3);
  });

  it("carries the truthfulness disclaimer about usage and inactive accounts", () => {
    const { container } = render(<EntitlementsPanel view={view()} contractId="c1" />);
    const text = container.textContent ?? "";
    expect(text).toContain("do not represent application usage");
    expect(text).toContain("not evidence that a licence is being charged for");
  });

  it("offers the write affordances that make the panel reachable", () => {
    // Shown to any reader for usability; RLS decides whether the save lands (the contract form's posture).
    const { container } = render(<EntitlementsPanel view={view()} contractId="c1" />);
    expect(container.querySelector('a[href="/contracts/c1/entitlements/new"]')).toBeTruthy();
    expect(container.querySelector('a[href="/contracts/c1/entitlements/e1/edit"]')).toBeTruthy();
  });

  it("renders a load failure as a failure, never as an empty contract", () => {
    render(<EntitlementsPanel view={null} contractId="c1" />);
    expect(screen.getByText(/Could not load the purchased lines/)).toBeTruthy();
  });
});
