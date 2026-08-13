import { describe, it, expect } from "vitest";
import { evaluateCommercial, summarize, type CommercialInput, type ContractFacts, type ConnectionFacts } from "./evaluate";
import { reconcileEntitlement, type EntitlementInput, type DiscoveredCounts } from "./reconcile";
import type { CapabilityStatus } from "@/lib/canonical/capabilities";
import type { ConceptCapabilities } from "./types";
import { COMMERCIAL_RULE_IDS } from "./types";

const NOW = new Date("2026-08-12T12:00:00Z");
const DETECTED_AT = "2026-08-12T12:00:00.000Z";

const cap = (state: CapabilityStatus["state"]): CapabilityStatus => ({
  capability: "app_accounts", label: "Application accounts", provider: "slack", connectorId: "conn-1",
  support: "implemented", state, lastObservedAt: null, confidence: "high", explanation: "…",
});
const CAPS: ConceptCapabilities = {
  assigned: cap("unavailable"), provisioned: cap("available"), billable: cap("unavailable"), active: cap("unavailable"),
};

const line = (over: Partial<EntitlementInput> = {}): EntitlementInput => ({
  id: "e1", contractId: "c1", sku: "SLACK", planName: null, vendorId: null, appProductId: null,
  termStart: null, termEnd: null, purchasedQuantity: 3200, minimumQuantity: null, quantityUnit: "seat",
  unitAmount: 12.5, currency: "USD", billingFrequency: "monthly", measuredByConnectionId: "conn-1",
  source: "order_form", confidence: "high", hasEvidenceDocument: true, ...over,
});
const contract = (over: Partial<ContractFacts> = {}): ContractFacts => ({
  id: "c1", renewalDate: null, endDate: null, noticeDeadline: null, autoRenew: false, ...over,
});
const counts = (over: Partial<DiscoveredCounts> = {}): DiscoveredCounts => ({
  current: 3011, stale: 0, inactive: 0, totalEvidence: 3011, lastSeenAt: null, ...over,
});

// Assemble an input the way a loader would: reconcile first, then evaluate over the result.
function build(
  entitlements: EntitlementInput[],
  contracts: ContractFacts[],
  discovered: Record<string, DiscoveredCounts | null> = { "conn-1": counts() },
  connections: ConnectionFacts[] = [{ connectionId: "conn-1", currentAccounts: 3011, inactiveAccounts: 0, staleAccounts: 0 }],
): CommercialInput {
  return {
    contracts, entitlements, connections, now: NOW, detectedAt: DETECTED_AT,
    reconciliations: entitlements.map((e) =>
      reconcileEntitlement(e, e.measuredByConnectionId ? (discovered[e.measuredByConnectionId] ?? null) : null, CAPS)),
  };
}

const ids = (fs: readonly { ruleId: string }[]) => fs.map((f) => f.ruleId);

describe("reconciliation rules", () => {
  it("reports a purchase larger than the discovered accounts, and values it", () => {
    const f = evaluateCommercial(build([line()], [contract()]));
    expect(ids(f)).toContain("purchase_exceeds_discovered");
    expect(ids(f)).toContain("reducible_purchased_quantity");

    const money = f.find((x) => x.ruleId === "reducible_purchased_quantity")!.evidence.money!;
    expect(money).toMatchObject({ amount: 28350, currency: "USD" });
    expect(money.basis).toBeTruthy();
  });

  it("treats more accounts than were bought as the high-severity case — money owed, not money available", () => {
    const f = evaluateCommercial(build([line({ purchasedQuantity: 2000 })], [contract()]));
    const excess = f.find((x) => x.ruleId === "discovered_exceeds_purchase")!;
    expect(excess.severity).toBe("high");
    expect(excess.evidence.counts).toMatchObject({ purchased: 2000, provisioned: 3011, excess: 1011 });
    // Nothing is claimed as recoverable in this direction.
    expect(ids(f)).not.toContain("reducible_purchased_quantity");
  });

  it("emits no reconciliation finding when the quantities agree", () => {
    const f = evaluateCommercial(build([line({ purchasedQuantity: 3011 })], [contract()]));
    expect(ids(f)).not.toContain("purchase_exceeds_discovered");
    expect(ids(f)).not.toContain("discovered_exceeds_purchase");
    expect(ids(f)).not.toContain("reducible_purchased_quantity");
  });
});

describe("what it refuses to emit", () => {
  it("never claims usage or billable, whatever the provider lifecycle counts say", () => {
    const f = evaluateCommercial(
      build([line()], [contract()], { "conn-1": counts({ inactive: 400 }) },
        [{ connectionId: "conn-1", currentAccounts: 3011, inactiveAccounts: 400, staleAccounts: 0 }]),
    );
    // The inactive count IS reported…
    const inactive = f.find((x) => x.ruleId === "inactive_provisioned_accounts")!;
    expect(inactive.evidence.counts).toMatchObject({ inactive: 400 });
    // …and it carries NO money, because whether a suspended account is billed has no source.
    expect(inactive.evidence.money).toBeUndefined();
    expect(inactive.severity).toBe("low");

    // The only money in the result is the purchased-vs-provisioned surplus.
    const withMoney = f.filter((x) => x.evidence.money !== undefined);
    expect(withMoney.map((x) => x.ruleId)).toEqual(["reducible_purchased_quantity"]);
  });

  it("emits no rule outside the closed catalog", () => {
    const f = evaluateCommercial(build([line()], [contract({ renewalDate: "2026-08-20", autoRenew: true, noticeDeadline: "2026-08-15" })]));
    for (const finding of f) expect(COMMERCIAL_RULE_IDS).toContain(finding.ruleId);
  });
});

describe("coverage rules", () => {
  it("flags a purchased line with no declared measurement source", () => {
    const f = evaluateCommercial(build([line({ measuredByConnectionId: null })], [contract()]));
    expect(ids(f)).toContain("entitlement_not_measured");
  });

  it("flags a contract with no purchased line at all", () => {
    const f = evaluateCommercial(build([], [contract()], {}, []));
    expect(ids(f)).toContain("contract_without_entitlement");
  });

  it("flags a connector holding accounts that no line accounts for", () => {
    const f = evaluateCommercial(
      build([], [], {}, [{ connectionId: "conn-9", currentAccounts: 240, inactiveAccounts: 0, staleAccounts: 0 }]),
    );
    const untracked = f.find((x) => x.ruleId === "discovered_source_without_entitlement")!;
    expect(untracked.subjectType).toBe("connection");
    expect(untracked.evidence.counts).toMatchObject({ provisioned: 240 });
  });

  it("does not flag a connector that a line already measures", () => {
    const f = evaluateCommercial(build([line()], [contract()]));
    expect(ids(f)).not.toContain("discovered_source_without_entitlement");
  });
});

describe("commitment rules", () => {
  it("raises renewal severity as the date closes, using the shared 30/90 buckets", () => {
    const soon = evaluateCommercial(build([line()], [contract({ renewalDate: "2026-08-20" })]));
    expect(soon.find((x) => x.ruleId === "renewal_approaching")!.severity).toBe("high");

    const later = evaluateCommercial(build([line()], [contract({ renewalDate: "2026-10-25" })]));
    expect(later.find((x) => x.ruleId === "renewal_approaching")!.severity).toBe("medium");

    const far = evaluateCommercial(build([line()], [contract({ renewalDate: "2027-06-01" })]));
    expect(ids(far)).not.toContain("renewal_approaching");
  });

  it("flags a closing auto-renewal notice as high severity, and ignores one already passed", () => {
    const open = evaluateCommercial(build([line()], [contract({ autoRenew: true, noticeDeadline: "2026-08-30" })]));
    const notice = open.find((x) => x.ruleId === "auto_renewal_notice_approaching")!;
    expect(notice.severity).toBe("high");
    expect(notice.evidence.counts.daysRemaining).toBe(18);

    const passed = evaluateCommercial(build([line()], [contract({ autoRenew: true, noticeDeadline: "2026-08-01" })]));
    expect(ids(passed)).not.toContain("auto_renewal_notice_approaching");

    // A notice date on a contract that does NOT auto-renew is not the same problem.
    const manual = evaluateCommercial(build([line()], [contract({ autoRenew: false, noticeDeadline: "2026-08-30" })]));
    expect(ids(manual)).not.toContain("auto_renewal_notice_approaching");
  });
});

describe("duplication", () => {
  const a = line({ id: "e1", contractId: "c1", appProductId: "p1", termStart: "2026-01-01", termEnd: "2026-12-31" });

  it("pairs the same product on two contracts with overlapping terms", () => {
    const b = line({ id: "e2", contractId: "c2", appProductId: "p1", termStart: "2026-06-01", termEnd: "2027-05-31" });
    const f = evaluateCommercial(build([a, b], [contract({ id: "c1" }), contract({ id: "c2" })]));
    const dup = f.find((x) => x.ruleId === "possible_duplicate_entitlement")!;
    expect(dup.relatedIds).toContain("e2");
    // A heuristic, and labelled as one.
    expect(dup.confidence).toBe("low");
  });

  it("does not pair non-overlapping terms, the same contract, or rows that merely share a name", () => {
    const sequential = line({ id: "e2", contractId: "c2", appProductId: "p1", termStart: "2027-01-01", termEnd: "2027-12-31" });
    expect(ids(evaluateCommercial(build([a, sequential], [contract({ id: "c1" }), contract({ id: "c2" })]))))
      .not.toContain("possible_duplicate_entitlement");

    const sameContract = line({ id: "e2", contractId: "c1", appProductId: "p1", termStart: "2026-06-01", termEnd: "2026-12-31" });
    expect(ids(evaluateCommercial(build([a, sameContract], [contract({ id: "c1" })]))))
      .not.toContain("possible_duplicate_entitlement");

    // Same SKU string, no shared canonical row → no finding. Names are not evidence.
    const namesake = line({ id: "e2", contractId: "c2", appProductId: null, sku: "SLACK", termStart: "2026-06-01", termEnd: "2026-12-31" });
    expect(ids(evaluateCommercial(build([a, namesake], [contract({ id: "c1" }), contract({ id: "c2" })]))))
      .not.toContain("possible_duplicate_entitlement");
  });
});

describe("provenance and determinism", () => {
  it("caps a finding's confidence at the provenance of the record it came from", () => {
    const high = evaluateCommercial(build([line({ confidence: "high" })], [contract()]));
    expect(high.find((x) => x.ruleId === "purchase_exceeds_discovered")!.confidence).toBe("high");

    // Same arithmetic, hand-entered figure → the finding cannot be more certain than its input.
    const low = evaluateCommercial(build([line({ source: "manual_entry", confidence: "low" })], [contract()]));
    expect(low.find((x) => x.ruleId === "purchase_exceeds_discovered")!.confidence).toBe("low");
  });

  it("is deterministic: identical input yields identical findings, ids and order", () => {
    const input = () => build([line()], [contract({ renewalDate: "2026-08-20" })]);
    expect(evaluateCommercial(input())).toEqual(evaluateCommercial(input()));
  });

  it("orders by severity first", () => {
    const f = evaluateCommercial(build([line({ purchasedQuantity: 2000 })], [contract({ renewalDate: "2026-08-20" })]));
    expect(f[0].severity).toBe("high");
  });
});

describe("summarize", () => {
  it("totals opportunity per currency and never across them", () => {
    const usd = line({ id: "e1", contractId: "c1" });
    const gbp = line({ id: "e2", contractId: "c2", currency: "GBP", unitAmount: 10, billingFrequency: "annual" });
    const f = evaluateCommercial(build([usd, gbp], [contract({ id: "c1" }), contract({ id: "c2" })]));
    const s = summarize(f);

    expect(Object.keys(s.annualOpportunityByCurrency).sort()).toEqual(["GBP", "USD"]);
    expect(s.annualOpportunityByCurrency.USD).toBe(28350);
    expect(s.annualOpportunityByCurrency.GBP).toBe(1890);
    expect(s.total).toBe(f.length);
    expect(s.bySeverity.high + s.bySeverity.medium + s.bySeverity.low + s.bySeverity.info).toBe(f.length);
  });
});
