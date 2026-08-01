// Phase 2 — SERVER-ONLY loaders for the three Directory list pages (People, Groups, Applications).
//
// Each page reads exactly ONE node table through the migration-0061 product RPCs, via the same owner/admin-gated repository the /access
// surface uses. There is no second data source: `app_users` and `public.apps` are the SaaS-management spoke and are never consulted here.
//
// Why the whole table is paged before rendering a page of rows
// ------------------------------------------------------------
// The 0061 list RPCs order by `x.id` — a uuid — and take no text-search parameter. So the database cannot answer "the first 50 people by
// name" or "people matching 'chen'". Cursor-paging straight to the UI would give the customer an alphabetically random page and a search
// box that only searched that page. Instead we page the one node table in full (bounded, see below), then sort/filter/paginate in memory —
// the same shape `/access` already uses for its detail lists, reusing the same `paginate()`.
//
// This is bounded, not unbounded: `getAccessCounts` is consulted FIRST and a table larger than MAX_LIST_NODES returns `too_large` without
// reading a single row, exactly as the /access overview does. Adding `p_search` + a name-ordered cursor to the three RPCs would remove the
// need for this; that is a migration and is deferred (reported as Phase 3).
//
// Counts (group members, assignment counts, effective access) are DELIBERATELY ABSENT. The three edge RPCs return only row-id references,
// so every such number would require paging entire edge tables per page load. Omitted rather than approximated.

import {
  accessGate, getAccessCounts, listDirectoryIdentities, listDirectoryGroups, listDirectoryApplications, type ListResult,
} from "./access-repository";
import type { Counts } from "./access-rpc-types";
import { identityLabel, groupLabel, applicationLabel } from "./access-view-models";
import { paginate, type AccessFilters, type Paged } from "./access-filters";
import { type SyncState } from "./directory-display";

// Re-exported so a server caller has one import; the display helpers themselves are pure and live in ./directory-display so the list
// components can use them without dragging the server-only repository into the browser bundle.
export * from "./directory-display";

// One RPC round trip is 100 rows (the RPC's own hard cap). MAX_LIST_NODES bounds a single list at the same node ceiling the /access
// overview uses, so a tenant that is too large for the graph is also too large here — one consistent cliff, explained the same way.
const PAGE = 100;
export const MAX_LIST_NODES = 2000;

export type DirectoryKind = "people" | "groups" | "applications";

// `syncState` narrows the four-value database vocabulary to the two states a customer needs. Anything that is not `current` is evidence we
// have not re-seen the record in the latest complete discovery, which is what "stale" communicates.
const syncState = (s: string): SyncState => (s === "current" ? "current" : "stale");

// `staleSince` is populated ONLY for a row that is actually stale.
//
// This began as a workaround: `runner_promote_okta_directory_users` (0053) and `..._groups` (0054) restored a row to `current` without
// clearing `stale_since`, unlike the other four promoters, so a person who disappeared and came back was `current` carrying a leftover
// timestamp. Migration 0070 fixed both functions, repaired the existing rows, and added a CHECK enforcing
// `sync_status = 'current' -> stale_since is null` on all six tables, so the contradictory state can no longer be written.
//
// The gate stays anyway. It costs one comparison, it is correct for every sync state rather than just the two that were broken, and it
// means the display does not depend on a database constraint being present to be truthful.
const staleSince = (state: SyncState, raw: string | null): string | null => (state === "stale" ? raw : null);

export type PersonRow = {
  readonly id: string;
  readonly name: string;
  readonly secondaryId: string | null;   // login (else email) — shown only when it differs from the displayed name
  readonly isActive: boolean | null;
  readonly provider: string;
  readonly syncState: SyncState;
  readonly staleSince: string | null;
};

export type DirectoryGroupRow = {
  readonly id: string;
  readonly name: string;
  readonly typeCategory: string | null;
  readonly isBuiltIn: boolean;
  readonly provider: string;
  readonly syncState: SyncState;
  readonly staleSince: string | null;
};

export type DirectoryApplicationRow = {
  readonly id: string;
  readonly name: string;
  readonly statusCategory: string | null;
  readonly signOnCategory: string | null;
  readonly catalogMatch: string | null;  // null unless a real match exists — see the note on catalog matching below
  readonly provider: string;
  readonly syncState: SyncState;
  readonly staleSince: string | null;
};

// `catalog_match_status` currently reads `unmatched` for every row: migration 0057 deliberately does not write it ("catalog matching is a
// separate, deferred, human-reviewable concern") and no writer exists in either repository. Surfacing "Unmatched" on every row would invent
// a problem — it would read as "we tried and failed", when in truth matching has not run. So an unmatched row carries NO catalog value, and
// the page says once, in prose, that matching is not part of this surface.
const catalogMatch = (raw: string | null): string | null => (raw === null || raw === "unmatched" ? null : raw);

// Okta's built-in groups (Everyone, and the admin roles) are provider-managed and cannot be edited. Worth marking, because "Everyone"
// granting access is a materially different fact from a deliberately-created group granting it.
const isBuiltIn = (typeCategory: string | null): boolean => typeCategory === "built_in";

export type DirectoryListData<T> =
  | { readonly status: "too_large"; readonly total: number }
  | { readonly status: "complete"; readonly paged: Paged<T>; readonly totalBeforeFilter: number; readonly staleShown: boolean };

export type DirectoryListResult<T> =
  | { readonly ok: true; readonly data: DirectoryListData<T> }
  | { readonly ok: false; readonly error: "forbidden" | "query_failed" };

// Page one list RPC to completion on the deterministic id cursor. The count pre-gate bounds this; the loop guard is a backstop only.
async function pageAll<T extends { id: string }>(fetch: (afterId: string | null) => Promise<ListResult<T[]>>): Promise<{ ok: true; rows: T[] } | { ok: false; error: "query_failed" }> {
  const rows: T[] = [];
  let afterId: string | null = null;
  for (let guard = 0; guard < 1000; guard++) {
    const r = await fetch(afterId);
    if (!r.ok) return { ok: false, error: "query_failed" };
    rows.push(...r.data);
    if (r.data.length < PAGE) return { ok: true, rows };
    afterId = r.data[r.data.length - 1].id;
  }
  return { ok: true, rows };
}

const norm = (s: string) => s.normalize("NFKC").toLowerCase();

// Sort by display label, tie-broken by id. Deterministic — the same data always renders in the same order, which uuid ordering could not
// promise across pages.
function byLabel<T extends { name: string; id: string }>(a: T, b: T): number {
  return a.name.localeCompare(b.name) || a.id.localeCompare(b.id);
}

// The shared body of all three loaders: gate -> count pre-check -> page one table -> map -> sort -> search -> paginate.
async function loadList<Row extends { id: string }, View extends { id: string; name: string }>(
  countKey: keyof Counts,
  fetchPage: (tenantId: string, afterId: string | null, includeStale: boolean, connectionId: string | null) => Promise<ListResult<Row[]>>,
  toView: (r: Row) => View,
  searchable: (v: View) => readonly (string | null)[],
  f: AccessFilters,
): Promise<DirectoryListResult<View>> {
  const g = await accessGate();
  if (!g.ok) return { ok: false, error: "forbidden" };

  // Counts are stale-agnostic (all rows), which is the conservative bound: we never start paging a table that could exceed the ceiling.
  const counts = await getAccessCounts(g.tenantId, f.connectionId);
  if (!counts.ok) return { ok: false, error: "query_failed" };
  const total = counts.data[countKey];
  if (total > MAX_LIST_NODES) return { ok: true, data: { status: "too_large", total } };

  const r = await pageAll((afterId) => fetchPage(g.tenantId, afterId, f.includeStale, f.connectionId));
  if (!r.ok) return { ok: false, error: "query_failed" };

  const all = r.rows.map(toView).sort(byLabel);
  const q = f.query;
  const matched = q === null ? all : all.filter((v) => searchable(v).some((s) => s !== null && norm(s).includes(q)));

  return { ok: true, data: { status: "complete", paged: paginate(matched, f.page, f.pageSize), totalBeforeFilter: all.length, staleShown: f.includeStale } };
}

export function loadDirectoryPeople(f: AccessFilters): Promise<DirectoryListResult<PersonRow>> {
  return loadList(
    "identities",
    (t, afterId, includeStale, connectionId) => listDirectoryIdentities(t, { afterId, includeStale, limit: PAGE, connectionId }),
    (r) => {
      const name = identityLabel(r);
      // `identityLabel` already falls back display_name -> login -> email, so the secondary column would otherwise repeat the primary one.
      const secondary = r.login ?? r.email ?? null;
      return {
        id: r.id, name, secondaryId: secondary !== null && secondary !== name ? secondary : null,
        isActive: r.is_active, provider: r.provider,
        // `status` is NOT surfaced: the runner writes Okta's raw lifecycle token (PROVISIONED, PASSWORD_EXPIRED, …) with no bounded
        // vocabulary and no label map, unlike directory_applications.status_category which is CHECK-constrained. `is_active` is the
        // safe, bounded equivalent.
        syncState: syncState(r.sync_status), staleSince: staleSince(syncState(r.sync_status), r.stale_since),
      };
    },
    (v) => [v.name, v.secondaryId],
    f,
  );
}

export function loadDirectoryGroups(f: AccessFilters): Promise<DirectoryListResult<DirectoryGroupRow>> {
  return loadList(
    "groups",
    (t, afterId, includeStale, connectionId) => listDirectoryGroups(t, { afterId, includeStale, limit: PAGE, connectionId }),
    (r) => ({
      id: r.id, name: groupLabel(r), typeCategory: r.group_type_category, isBuiltIn: isBuiltIn(r.group_type_category),
      provider: r.provider, syncState: syncState(r.sync_status), staleSince: staleSince(syncState(r.sync_status), r.stale_since),
    }),
    (v) => [v.name],
    f,
  );
}

export function loadDirectoryApplications(f: AccessFilters): Promise<DirectoryListResult<DirectoryApplicationRow>> {
  return loadList(
    "applications",
    (t, afterId, includeStale, connectionId) => listDirectoryApplications(t, { afterId, includeStale, limit: PAGE, connectionId }),
    (r) => ({
      id: r.id, name: applicationLabel(r), statusCategory: r.status_category, signOnCategory: r.sign_on_category,
      catalogMatch: catalogMatch(r.catalog_match_status), provider: r.provider,
      syncState: syncState(r.sync_status), staleSince: staleSince(syncState(r.sync_status), r.stale_since),
    }),
    (v) => [v.name],
    f,
  );
}
