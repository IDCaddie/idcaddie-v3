// Pure, server-safe search/filter for the read-only Audit list. NO DB access — operates on the already-fetched,
// RLS-scoped AuditEntry[] and can only NARROW what is already permitted (never widens, never re-queries, never
// widens the projection). Searches ONLY the safe displayed fields (action + entity/resourceType); the date
// filter is over createdAt. There is NO raw-JSON/before-after/actor/ip search — those fields never leave the DAL.
import type { AuditEntry } from "./audit";

export type AuditDays = 7 | 30 | 90;
export const AUDIT_DAYS: readonly AuditDays[] = [7, 30, 90];

// Unrecognized / missing input → null = "all time" (fail-safe: a bad value never narrows to a misleading window).
export function parseAuditDays(v: string | undefined): AuditDays | null {
  const n = Number(v);
  return (AUDIT_DAYS as readonly number[]).includes(n) ? (n as AuditDays) : null;
}

export type AuditFilterOpts = { q?: string; action?: string; entity?: string; days?: AuditDays | null };

const DAY_MS = 86_400_000;

export function filterAuditEntries(entries: readonly AuditEntry[], opts: AuditFilterOpts, now: Date): AuditEntry[] {
  const q = (opts.q ?? "").trim().toLowerCase();
  const cutoff = opts.days ? now.getTime() - opts.days * DAY_MS : null;
  return entries.filter((e) => {
    if (q && !(e.action.toLowerCase().includes(q) || e.resourceType.toLowerCase().includes(q))) return false;
    if (opts.action && e.action !== opts.action) return false;
    if (opts.entity && e.resourceType !== opts.entity) return false;
    if (cutoff != null) {
      const t = Date.parse(e.createdAt);
      if (Number.isNaN(t) || t < cutoff) return false; // unparseable timestamp → excluded from a dated window (fail-safe)
    }
    return true;
  });
}

// Distinct action + entity values present in the visible set — safe labels only, for the filter dropdowns.
export function auditFacets(entries: readonly AuditEntry[]): { actions: string[]; entities: string[] } {
  return {
    actions: [...new Set(entries.map((e) => e.action))].sort(),
    entities: [...new Set(entries.map((e) => e.resourceType))].sort(),
  };
}
