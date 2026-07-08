// Pure, deterministic chart-shaping helpers over the ALREADY-FETCHED dashboard overview (spend + renewals).
// NO DB, no new data source, no React, no dates (daysUntil is already computed on each RenewalItem). Reuses the
// pure formatMoney. Contract totals only — no invoices/actual-spend. Safe on null/empty/zero inputs.
import { formatMoney, type SpendSummary, type RenewalBuckets, type RenewalItem } from "./dashboard-overview";
import type { StatusTone } from "@/components/status-tokens";

export type SpendBarSegment = {
  currency: string;
  total: number;
  contractCount: number;
  label: string; // formatMoney(total, currency)
  widthPct: number; // 0..100, relative to the largest currency total
};

export function buildSpendBarSegments(spend: SpendSummary | null): SpendBarSegment[] {
  if (!spend || spend.byCurrency.length === 0) return [];
  const max = Math.max(...spend.byCurrency.map((c) => c.total), 0);
  return spend.byCurrency.map((c) => ({
    currency: c.currency,
    total: c.total,
    contractCount: c.contractCount,
    label: formatMoney(c.total, c.currency),
    widthPct: max > 0 ? Math.round((c.total / max) * 100) : 0,
  }));
}

export type RenewalSegment = { key: string; label: string; count: number; tone: StatusTone; pct: number };
export type RenewalSegmentSummary = { total: number; segments: RenewalSegment[] };

export function buildRenewalSegmentSummary(r: RenewalBuckets | null): RenewalSegmentSummary {
  if (!r) return { total: 0, segments: [] };
  const raw: Omit<RenewalSegment, "pct">[] = [
    { key: "due30", label: "Due ≤30 days", count: r.due30.length, tone: "danger" },
    { key: "due90", label: "Due 31–90 days", count: r.due90.length, tone: "attention" },
    { key: "missing", label: "No renewal/end date", count: r.missing, tone: "neutral" },
  ];
  const total = raw.reduce((s, x) => s + x.count, 0);
  const segments = raw.map((x) => ({ ...x, pct: total > 0 ? Math.round((x.count / total) * 100) : 0 }));
  return { total, segments };
}

export type UpcomingRenewalRow = RenewalItem & { tone: StatusTone; urgencyLabel: string };

export function buildUpcomingRenewalRows(items: readonly RenewalItem[]): UpcomingRenewalRow[] {
  return items.map((it) => ({
    ...it,
    tone: it.daysUntil <= 7 ? "danger" : it.daysUntil <= 30 ? "attention" : "neutral",
    urgencyLabel: it.daysUntil === 0 ? "today" : `in ${it.daysUntil}d`,
  }));
}
