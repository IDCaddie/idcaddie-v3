import type { ContractSummary } from "./contracts";
import { renewalFlag } from "./contract-attention";

// Pure summary over the ALREADY-FETCHED /contracts rows — NO DB, no new query, no widened projection. `now` is
// injected for deterministic tests. Reuses renewalFlag for the same 30/90-day buckets as the list rows + dashboard.
// Contract totals only (total_cost/currency already on each row) — NO invoices/license/actual-spend data.
export type ContractSummaryStats = {
  total: number;
  active: number;
  byCurrency: { currency: string; total: number; count: number }[]; // sorted by total desc
  contractsWithCost: number;
  dueWithin30: number;
  dueWithin90: number; // cumulative — includes dueWithin30
  missingRenewalDate: number; // neither a renewal_date nor an end_date
  missingOwner: number;
};

export function summarizeContracts(rows: readonly ContractSummary[], now: Date): ContractSummaryStats {
  const byCur = new Map<string, { total: number; count: number }>();
  let active = 0;
  let contractsWithCost = 0;
  let dueWithin30 = 0;
  let dueWithin90 = 0;
  let missingRenewalDate = 0;
  let missingOwner = 0;

  for (const r of rows) {
    if (r.status.toLowerCase() === "active") active++;
    if (r.totalCost != null) {
      const cur = r.currency ?? "unspecified";
      const e = byCur.get(cur) ?? { total: 0, count: 0 };
      byCur.set(cur, { total: e.total + r.totalCost, count: e.count + 1 });
      contractsWithCost++;
    }
    const rf = renewalFlag(r.renewalDate, r.endDate, now);
    if (rf === "missing") missingRenewalDate++;
    else if (rf === "due30") {
      dueWithin30++;
      dueWithin90++;
    } else if (rf === "due90") dueWithin90++;
    if (!r.hasOwner) missingOwner++;
  }

  const byCurrency = [...byCur.entries()]
    .map(([currency, v]) => ({ currency, total: v.total, count: v.count }))
    .sort((a, b) => b.total - a.total);

  return { total: rows.length, active, byCurrency, contractsWithCost, dueWithin30, dueWithin90, missingRenewalDate, missingOwner };
}
