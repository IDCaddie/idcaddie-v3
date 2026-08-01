// Phase 7A — the executive Home view model.
//
// PURE. Every number here is derived from data the page already loads; nothing is fetched, computed twice, or invented.
//
// The cost discipline that shapes this file: `loadAccessOverview` already pays for a counts RPC plus six bounded sweeps AND
// already returns the complete findings list. So the risk panel and the attention queue are FREE — they are projections of a
// result Home was fetching anyway. Adding a findings-summary RPC would have bought nothing and cost a round trip.
//
// What this file refuses to do:
//   * no composite risk score — none exists and inventing one would be a number with no definition behind it;
//   * no trend or "up this week" — there is no historical series to compare against;
//   * no percentage of anything that would divide by a count the graph could not evaluate.

import type { AccessOverviewData, CountsView } from "./access-loaders";
import type { GovernanceFindingView, GovernanceSummaryView } from "./access-view-models";
import type { ConnectorSummary } from "./connector-management";

export type Posture =
  | { readonly status: "complete"; readonly counts: CountsView; readonly directOnly: number; readonly groupOnly: number; readonly both: number; readonly effective: number }
  // The graph could not be evaluated within safety limits. Counts are still true; the distribution is withheld rather than
  // rendered as zeros, because "0 effective access" and "we could not work it out" are opposite claims.
  | { readonly status: "too_large"; readonly counts: CountsView }
  | { readonly status: "unavailable"; readonly reason: "forbidden" | "query_failed" };

export const posture = (r: { ok: true; data: AccessOverviewData } | { ok: false; error: "forbidden" | "query_failed" }): Posture => {
  if (!r.ok) return { status: "unavailable", reason: r.error };
  if (r.data.status === "too_large") return { status: "too_large", counts: r.data.counts };
  return {
    status: "complete", counts: r.data.counts,
    directOnly: r.data.breakdown.directOnly, groupOnly: r.data.breakdown.groupOnly, both: r.data.breakdown.both,
    effective: r.data.effectiveRelationships,
  };
};

// ── risk ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
// Bounded, real categories only: severity buckets the engine already assigns, plus evidence freshness it already flags. No
// weighting, no score, no ranking beyond the engine's own severity order.
export type RiskBreakdown = {
  readonly high: number; readonly medium: number; readonly low: number; readonly info: number;
  readonly staleEvidence: number;         // findings whose evidence is itself stale
  readonly total: number;
  readonly topSubjects: readonly GovernanceFindingView[];   // highest-severity findings that have a SAFE canonical subject
};

// The severity counts come from the ENGINE'S OWN SUMMARY, not from re-counting the array. The engine already computed them; a
// second derivation here would be a place for the two to disagree, and the summary is the documented single source of truth.
// The array is used only to pick subjects to link to.
export function riskBreakdown(summary: GovernanceSummaryView, findings: readonly GovernanceFindingView[], limit = 5): RiskBreakdown {
  const by = (s: keyof GovernanceSummaryView["bySeverity"]) => summary.bySeverity[s] ?? 0;
  return {
    high: by("high"), medium: by("medium"), low: by("low"), info: by("info"),
    staleEvidence: findings.filter((f) => f.staleEvidence).length,
    total: summary.total,
    // Only findings with a resolved subject can be acted on from here. One without a link would be a row the customer cannot
    // follow — the engine's order is already severity-first, so this is a filter, not a re-rank.
    topSubjects: findings.filter((f) => f.subject !== null).slice(0, limit),
  };
}

// ── the attention queue ──────────────────────────────────────────────────────────────────────────────────────────────────────
// One bounded list, assembled from two sources the page already has: governance findings and connector health. Ordered by the
// priority the GO specifies, and every item carries a link that works.
export type AttentionKind = "finding" | "connector";
export type AttentionSeverity = "high" | "medium" | "low" | "info";
export type AttentionRow = {
  readonly key: string;
  readonly kind: AttentionKind;
  readonly severity: AttentionSeverity;
  readonly badge: string;
  readonly title: string;
  readonly detail: string;
  readonly subject: string | null;
  readonly href: string;
  readonly actionLabel: string;
};

const RANK: Record<AttentionSeverity, number> = { high: 0, medium: 1, low: 2, info: 3 };

export function attentionQueue(
  findings: readonly GovernanceFindingView[],
  connectors: readonly ConnectorSummary[],
  limit = 8,
): readonly AttentionRow[] {
  const rows: AttentionRow[] = [];

  // 2. A broken connector outranks a medium finding: while it is failing, every finding derived from it is suspect.
  for (const c of connectors.filter((x) => x.active && x.health.state === "failed")) {
    rows.push({
      key: `c-fail-${c.id}`, kind: "connector", severity: "high", badge: "Connector",
      title: `${c.name} needs attention`, detail: c.health.reason, subject: c.organization ?? c.provider,
      href: `/connectors/manage/${c.id}`, actionLabel: "Open connector",
    });
  }
  for (const c of connectors.filter((x) => x.active && x.health.state === "attention")) {
    rows.push({
      key: `c-att-${c.id}`, kind: "connector", severity: "medium", badge: "Connector",
      title: `${c.name}: last run did not complete`, detail: c.health.reason, subject: c.organization ?? c.provider,
      href: `/connectors/manage/${c.id}`, actionLabel: "View history",
    });
  }
  // 5. Setup/discovery still required — real, but the least urgent thing on the list.
  for (const c of connectors.filter((x) => x.active && x.health.state === "pending")) {
    rows.push({
      key: `c-pend-${c.id}`, kind: "connector", severity: "low", badge: "Setup",
      title: `${c.name} is not discovering yet`, detail: c.health.reason, subject: c.organization ?? c.provider,
      href: `/connectors/manage/${c.id}`, actionLabel: "Open connector",
    });
  }

  // 1 & 4. Findings, at the severity the engine assigned. Info is deliberately excluded from an ATTENTION queue — it is
  // observational, and padding the queue with it would train people to ignore the queue.
  for (const f of findings) {
    if (f.severity === "info") continue;
    rows.push({
      key: `f-${f.id}`, kind: "finding", severity: f.severity as AttentionSeverity, badge: f.severityLabel,
      title: f.title, detail: f.summary, subject: f.subject?.label ?? null,
      href: f.subject?.href ?? "/access/findings?severity=high",
      actionLabel: f.subject ? "Open subject" : "View in findings",
    });
  }

  return rows.sort((a, b) => RANK[a.severity] - RANK[b.severity] || a.key.localeCompare(b.key)).slice(0, limit);
}

// ── connector health rollup ──────────────────────────────────────────────────────────────────────────────────────────────────
// In all-active mode the header must not flatten several connectors into one green tick. The worst active connector defines the
// headline, and the per-connector list is rendered beside it.
export type HealthRollup = { readonly state: ConnectorSummary["health"]["state"]; readonly label: string; readonly reason: string };
const WORST: ConnectorSummary["health"]["state"][] = ["failed", "attention", "pending", "healthy", "inactive"];

export function healthRollup(active: readonly ConnectorSummary[]): HealthRollup | null {
  if (active.length === 0) return null;
  if (active.length === 1) return active[0].health;
  for (const s of WORST) {
    const hit = active.filter((c) => c.health.state === s);
    if (hit.length === 0) continue;
    return s === "healthy"
      ? { state: "healthy", label: "All directories healthy", reason: `${active.length} active directories, all verified and discovered.` }
      : { state: s, label: hit[0].health.label, reason: `${hit.length} of ${active.length} active ${hit.length === 1 ? "directory needs" : "directories need"} attention: ${hit.map((c) => c.name).join(", ")}.` };
  }
  return active[0].health;
}
