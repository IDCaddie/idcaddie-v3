import { describe, it, expect } from "vitest";
import { summarizeContracts } from "./contracts-summary";
import type { ContractSummary } from "./contracts";

const NOW = new Date("2026-07-08T00:00:00Z");
const row = (o: Partial<ContractSummary>): ContractSummary => ({
  id: "c",
  contractName: "C",
  vendorName: null,
  status: "active",
  category: null,
  renewalDate: null,
  endDate: null,
  totalCost: null,
  currency: null,
  hasOwner: true,
  renewalResponsibility: null,
  ...o,
});

const rows: ContractSummary[] = [
  row({ status: "active", hasOwner: true, renewalDate: "2026-07-20", totalCost: 1000, currency: "USD" }), // due30
  row({ status: "active", hasOwner: true, renewalDate: "2026-09-01", totalCost: 500, currency: "USD" }), // due90
  row({ status: "expired", hasOwner: false, totalCost: 200, currency: "EUR" }), // missing renewal + missing owner
  row({ status: "active", hasOwner: true, renewalDate: "2026-06-01" }), // past renewal → not "soon", no cost
];

describe("summarizeContracts", () => {
  it("counts total, active, missing owner, missing renewal date", () => {
    const s = summarizeContracts(rows, NOW);
    expect(s.total).toBe(4);
    expect(s.active).toBe(3);
    expect(s.missingOwner).toBe(1);
    expect(s.missingRenewalDate).toBe(1);
  });

  it("buckets renewals into 30/90 day windows deterministically with an injected now", () => {
    const s = summarizeContracts(rows, NOW);
    expect(s.dueWithin30).toBe(1); // 2026-07-20 (12d)
    expect(s.dueWithin90).toBe(2); // + 2026-09-01 (~55d); cumulative
  });

  it("groups tracked value by currency, sorted by total desc", () => {
    const s = summarizeContracts(rows, NOW);
    expect(s.contractsWithCost).toBe(3);
    expect(s.byCurrency).toEqual([
      { currency: "USD", total: 1500, count: 2 },
      { currency: "EUR", total: 200, count: 1 },
    ]);
  });

  it("empty input → all zeros, no currencies, never throws", () => {
    const s = summarizeContracts([], NOW);
    expect(s).toEqual({
      total: 0,
      active: 0,
      byCurrency: [],
      contractsWithCost: 0,
      dueWithin30: 0,
      dueWithin90: 0,
      missingRenewalDate: 0,
      missingOwner: 0,
    });
  });
});
