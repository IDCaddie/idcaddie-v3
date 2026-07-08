// Pure, deterministic shaping for the account-MATCH-COVERAGE visuals on /people and /apps/[id]. NO DB, no new query.
// Operates only on counts the pages already computed from RLS-scoped app_user + match rows (via the existing
// listIdentityAccountsForCurrentUser / summarizeAccountIntelligence). This is match COVERAGE only — NOT UAR, NOT
// identity_accounts, NOT people PII, NOT license/discovery data.
import type { StatusTone } from "@/components/status-tokens";

export type MatchRateSummary = {
  matched: number;
  unmatched: number;
  total: number;
  ratePct: number; // floor(matched/total*100); 0 when total is 0. Floored so it never shows 100% while unmatched > 0.
};

export function matchRateSummary(matched: number, unmatched: number): MatchRateSummary {
  const total = matched + unmatched;
  return { matched, unmatched, total, ratePct: total > 0 ? Math.floor((matched / total) * 100) : 0 };
}

export type DistributionSegment = { key: string; label: string; count: number; tone: StatusTone; pct: number };

// Generic count buckets → segments (pct of the sum, rounded). Used for the active/inactive/unknown status bar.
export function statusDistributionSegments(
  buckets: readonly { key: string; label: string; count: number; tone: StatusTone }[],
): { total: number; segments: DistributionSegment[] } {
  const total = buckets.reduce((s, b) => s + b.count, 0);
  return { total, segments: buckets.map((b) => ({ ...b, pct: total > 0 ? Math.round((b.count / total) * 100) : 0 })) };
}
