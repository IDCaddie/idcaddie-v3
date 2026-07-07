// Pure, server-safe helpers for the Apps inventory list + detail. NO DB access — operate on already-fetched,
// RLS-scoped rows. Search/filter/sort run over the rows the user may ALREADY read (no new query, no
// tenant filter). No ids, no PII, no secrets. Unit-testable.

export type AppFilter = "missing_owner" | "missing_contract";
export type AppSort = "name" | "status" | "users";
export type AppInventoryOpts = { q?: string; filters?: readonly AppFilter[]; sort?: AppSort };

// The row shape these helpers need — a structural subset of the DAL's AppInventoryRow (decoupled from it).
export type InventoryRow = {
  id: string;
  name: string;
  vendorName: string | null;
  category: string | null;
  status: string;
  linkedContractCount: number;
  appUserCount: number;
  hasOwner: boolean;
};

export const APP_FILTERS: readonly AppFilter[] = ["missing_owner", "missing_contract"];
export const APP_SORTS: readonly AppSort[] = ["name", "status", "users"];
export function isAppFilter(v: string): v is AppFilter {
  return (APP_FILTERS as readonly string[]).includes(v);
}
export function isAppSort(v: string): v is AppSort {
  return (APP_SORTS as readonly string[]).includes(v);
}

// Search (name/vendor, case-insensitive) + filter (missing owner/contract) + sort. Pure; stable tie-break by name.
export function filterSortApps<T extends InventoryRow>(rows: readonly T[], opts: AppInventoryOpts): T[] {
  const q = (opts.q ?? "").trim().toLowerCase();
  const filters = new Set(opts.filters ?? []);
  const filtered = rows.filter((r) => {
    if (q && !(r.name.toLowerCase().includes(q) || (r.vendorName ?? "").toLowerCase().includes(q))) return false;
    if (filters.has("missing_owner") && r.hasOwner) return false;
    if (filters.has("missing_contract") && r.linkedContractCount > 0) return false;
    return true;
  });
  const sort = opts.sort ?? "name";
  return [...filtered].sort((a, b) =>
    sort === "status"
      ? a.status.localeCompare(b.status) || a.name.localeCompare(b.name)
      : sort === "users"
        ? b.appUserCount - a.appUserCount || a.name.localeCompare(b.name)
        : a.name.localeCompare(b.name),
  );
}

export type AttentionChip = { key: string; label: string };

// Compact list-row chips.
export function appChips(row: Pick<InventoryRow, "hasOwner" | "linkedContractCount">): AttentionChip[] {
  const chips: AttentionChip[] = [];
  if (!row.hasOwner) chips.push({ key: "missing_owner", label: "no owner" });
  if (row.linkedContractCount === 0) chips.push({ key: "missing_contract", label: "no contract" });
  return chips;
}

// Detail-page attention flags. `hasLinkedContract` / `hasDiscoveredAccounts`: true = present, false = known-none
// (flag it), null = unknown/read-failed (do NOT flag — fail safe).
export function appAttentionFlags(input: {
  hasOwner: boolean;
  hasLinkedContract: boolean | null;
  hasDiscoveredAccounts: boolean | null;
}): AttentionChip[] {
  const flags: AttentionChip[] = [];
  if (!input.hasOwner) flags.push({ key: "missing_owner", label: "No owner assigned" });
  if (input.hasLinkedContract === false) flags.push({ key: "missing_contract", label: "No linked contract" });
  if (input.hasDiscoveredAccounts === false) flags.push({ key: "no_accounts", label: "No discovered accounts" });
  return flags;
}
