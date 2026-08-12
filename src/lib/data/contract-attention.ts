// Pure, server-safe renewal/attention helpers for the contracts list + detail. NO DB access — operate on
// already-fetched, RLS-scoped fields (renewal_date / end_date / a hasOwner boolean / whether a linked app
// exists). Unit-testable with a fixed `now`. No PII, no ids, no secrets. Consistent with the dashboard
// renewal buckets (30/90 days).

const DAY_MS = 86_400_000;
// Exported so the Phase-10 commercial engine measures notice deadlines with the SAME arithmetic the renewal buckets use. A second
// implementation of "how many days until" is exactly how two surfaces come to disagree about whether something renews this month.
export function daysUntil(dateStr: string, now: Date): number {
  const target = Date.parse(`${dateStr}T00:00:00Z`);
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return Math.round((target - today) / DAY_MS);
}

export type RenewalFlag = "missing" | "due30" | "due90" | null;

// A single list-row flag: "missing" (no renewal/end date), "due30"/"due90" (upcoming), or null (not soon /
// already past). Uses renewal_date, falling back to end_date.
export function renewalFlag(renewalDate: string | null, endDate: string | null, now: Date): RenewalFlag {
  const eff = renewalDate ?? endDate;
  if (!eff) return "missing";
  const days = daysUntil(eff, now);
  if (days < 0) return null; // already past — not surfaced as "soon"
  if (days <= 30) return "due30";
  if (days <= 90) return "due90";
  return null;
}

export type AttentionFlag = { key: string; label: string };

// Detail-page attention flags. `hasLinkedApp`: true = has ≥1 linked app, false = known-none (flag it),
// null = unknown/read-failed (do NOT flag — fail safe).
export function contractAttentionFlags(
  input: { renewalDate: string | null; endDate: string | null; hasOwner: boolean; hasLinkedApp: boolean | null },
  now: Date,
): AttentionFlag[] {
  const flags: AttentionFlag[] = [];
  const rf = renewalFlag(input.renewalDate, input.endDate, now);
  if (rf === "missing") flags.push({ key: "missing_renewal", label: "No renewal or end date" });
  else if (rf === "due30") flags.push({ key: "renewal_soon", label: "Renews within 30 days" });
  if (!input.hasOwner) flags.push({ key: "missing_owner", label: "No owner assigned" });
  if (input.hasLinkedApp === false) flags.push({ key: "no_linked_app", label: "No linked app" });
  return flags;
}
