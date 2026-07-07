// Pure, server-safe aggregation for the /dashboards executive overview. Operates on already-fetched,
// RLS-scoped contract rows (see ./dashboard-overview-loader) — NO DB access here, so it is unit-testable
// with a fixed `now`. Uses ONLY existing `contracts` fields (total_cost / currency / renewal_date /
// end_date / notice_deadline). It reads NO invoices/license/identity tables (those are default-deny —
// RISK-002) and touches no connector_secrets / discovery_facts.

export type OverviewRow = {
  id: string;
  contractName: string;
  vendorName: string | null;
  status: string;
  totalCost: number | null;
  currency: string | null;
  renewalDate: string | null; // date (YYYY-MM-DD)
  endDate: string | null;
  noticeDeadline: string | null;
};

// ── Spend ──────────────────────────────────────────────────────────────────────────────────────────
export type SpendByCurrency = { currency: string; total: number; contractCount: number };
export type SpendSummary = { byCurrency: SpendByCurrency[]; contractsWithCost: number };

export function aggregateSpend(rows: OverviewRow[]): SpendSummary {
  const map = new Map<string, { total: number; count: number }>();
  let contractsWithCost = 0;
  for (const r of rows) {
    if (r.totalCost == null) continue;
    const cost = Number(r.totalCost); // numeric may arrive as number or string; coerce + guard
    if (!Number.isFinite(cost)) continue;
    contractsWithCost++;
    const cur = r.currency && r.currency.trim() ? r.currency : "unspecified";
    const e = map.get(cur) ?? { total: 0, count: 0 };
    e.total += cost;
    e.count++;
    map.set(cur, e);
  }
  const byCurrency = [...map.entries()]
    .map(([currency, v]) => ({ currency, total: v.total, contractCount: v.count }))
    .sort((a, b) => b.total - a.total);
  return { byCurrency, contractsWithCost };
}

// Currency-aware formatting; falls back safely for a non-ISO/"unspecified" currency (never throws).
export function formatMoney(total: number, currency: string): string {
  if (currency === "unspecified") return `${total.toLocaleString()} (currency unspecified)`;
  try {
    return new Intl.NumberFormat(undefined, { style: "currency", currency }).format(total);
  } catch {
    return `${total.toLocaleString()} ${currency}`;
  }
}

// ── Renewals ───────────────────────────────────────────────────────────────────────────────────────
export type RenewalItem = {
  id: string;
  contractName: string;
  vendorName?: string;
  date: string; // the effective renewal/end date used for bucketing
  daysUntil: number;
  basis: "renewal" | "end"; // whether the date came from renewal_date or (fallback) end_date
  noticeDeadline?: string;
};
export type RenewalBuckets = {
  due30: RenewalItem[]; // upcoming in the next 30 days (inclusive)
  due90: RenewalItem[]; // upcoming in 31..90 days
  missing: number; // contracts with neither a renewal_date nor an end_date
  topUpcoming: RenewalItem[]; // the 5 soonest upcoming (>= today)
};

const DAY_MS = 86_400_000;
function daysUntil(dateStr: string, now: Date): number {
  const target = Date.parse(`${dateStr}T00:00:00Z`);
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return Math.round((target - today) / DAY_MS);
}

export function bucketRenewals(rows: OverviewRow[], now: Date): RenewalBuckets {
  const due30: RenewalItem[] = [];
  const due90: RenewalItem[] = [];
  const upcoming: RenewalItem[] = [];
  let missing = 0;

  for (const r of rows) {
    const dateStr = r.renewalDate ?? r.endDate;
    const basis: "renewal" | "end" | null = r.renewalDate ? "renewal" : r.endDate ? "end" : null;
    if (!dateStr || !basis) {
      missing++;
      continue;
    }
    const days = daysUntil(dateStr, now);
    const item: RenewalItem = {
      id: r.id,
      contractName: r.contractName,
      vendorName: r.vendorName ?? undefined,
      date: dateStr,
      daysUntil: days,
      basis,
      noticeDeadline: r.noticeDeadline ?? undefined,
    };
    if (days >= 0) {
      upcoming.push(item);
      if (days <= 30) due30.push(item);
      else if (days <= 90) due90.push(item);
    }
    // days < 0 (already past) is not shown as "upcoming"; overdue tracking is a future enhancement.
  }

  upcoming.sort((a, b) => a.daysUntil - b.daysUntil);
  return { due30, due90, missing, topUpcoming: upcoming.slice(0, 5) };
}
