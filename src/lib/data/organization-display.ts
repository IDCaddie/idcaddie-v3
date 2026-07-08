// Pure, server-safe org-reference display. NO DB access — operates on the caller's already-fetched, RLS-visible
// organizations (id + name only). Turns a raw org id into a safe display string and NEVER returns the raw UUID:
// a visible id → its name; an id present but outside the caller's visible set → "Assigned"; null/undefined → "—".
import type { OrgOption } from "./organizations";

export function buildOrgNameLookup(orgs: readonly OrgOption[]): Map<string, string> {
  return new Map(orgs.map((o) => [o.id, o.name]));
}

export function orgDisplayName(id: string | null | undefined, lookup: Map<string, string>): string {
  if (id == null) return "—";
  return lookup.get(id) ?? "Assigned"; // present but not visible to the caller → "Assigned", never the raw id
}
