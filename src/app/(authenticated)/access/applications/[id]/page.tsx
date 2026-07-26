import Link from "next/link";
import { loadApplicationAccessDetail } from "@/lib/data/access-loaders";
import { StatCard, StatGrid } from "@/components/stat-card";
import { Badge } from "@/components/badge";
import {
  parseAccessFilters, filterApplicationIdentities, paginate, accessHref, accessQueryString, detailActiveFilters, backLink, returnParams,
  CLASSIFICATION_OPTIONS,
} from "@/lib/data/access-filters";

export const metadata = { title: "Application access · ID Caddie" };

const MAX_GROUPS_SHOWN = 50;   // bounded reveal for the assigned-groups list
const MAX_FINDINGS_SHOWN = 50; // per-entity findings scale with the subgraph; cap the rendered list (bounded by SUBGRAPH_MAX_ROWS above it)

// Read-only application access explanation (Phase 15 Part 2). Owner/admin only (loader-gated). The [id] param is ONLY a lookup key — a
// foreign, missing, or unauthorized id all return the same "not found". Effective identities + classification come from the Phase-13
// engine; findings from Phase-14. Identity filters/search/pagination act on the already-computed relationships only. A group assignment
// with zero members stays visibly distinct from effective identity access (Phase 13 never inflates the effective count). Never claims the
// app is unused/used, license state, savings, or safe removal. No mutation controls. The app's UUID appears only in hrefs, never as text.
export default async function ApplicationAccessPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { id } = await params;
  const sp = await searchParams;
  const filters = parseAccessFilters(sp);
  const result = await loadApplicationAccessDetail(id, filters.includeStale);
  const back = backLink(sp);
  const base = `/access/applications/${id}`;

  return (
    <main className="flex flex-1 flex-col gap-6 p-8">
      <div className="text-sm">
        <Link href={back?.href ?? "/access"} className="text-zinc-500 hover:underline">← {back?.label ?? "Back to Access"}</Link>
      </div>

      {!result.ok && result.error === "query_failed" ? (
        <div><h1 className="text-xl font-semibold">Access</h1><p className="mt-1 text-sm text-red-600" role="alert">Could not load this right now. Please try again later.</p></div>
      ) : !result.ok ? (
        <div className="rounded border border-zinc-300 p-4 text-sm dark:border-zinc-700">
          <h1 className="text-xl font-semibold">Not found</h1>
          <p className="mt-1 text-zinc-600 dark:text-zinc-400">This doesn’t exist or you don’t have access to it.</p>
        </div>
      ) : result.data.bounded ? (
        <>
          <header className="space-y-1">
            <h1 className="text-xl font-semibold">{result.data.displayName}</h1>
            <p className="text-sm text-zinc-600 dark:text-zinc-400">Application in the {result.data.providerLabel} directory.</p>
          </header>
          <div className="rounded border border-amber-400 bg-amber-50 p-4 text-sm dark:border-amber-700 dark:bg-amber-950/30" role="status">
            <div className="font-medium">Too large to display in full</div>
            <p className="mt-1 text-zinc-700 dark:text-zinc-300">This application’s access graph is too large to evaluate in this view within the current safety limits.</p>
          </div>
        </>
      ) : (() => {
        const filtered = filterApplicationIdentities(result.data.identities, filters);
        const paged = paginate(filtered, filters.page, filters.pageSize);
        const active = detailActiveFilters(filters);
        const ret = returnParams("application", filters, id).toString();
        const groups = result.data.assignedGroups.slice(0, MAX_GROUPS_SHOWN);
        const shownFindings = result.data.findings.slice(0, MAX_FINDINGS_SHOWN);
        return (
        <>
          <header className="space-y-1">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-xl font-semibold">{result.data.displayName}</h1>
              <Badge tone={result.data.syncState === "current" ? "success" : "neutral"}>
                {result.data.syncState === "current" ? "Current" : "Stale evidence"}
              </Badge>
              {result.data.catalogMatchStatus && result.data.catalogMatchStatus !== "matched" ? (
                <Badge tone="neutral">Catalog match {result.data.catalogMatchStatus === "unmatched" ? "unavailable" : result.data.catalogMatchStatus}</Badge>
              ) : null}
            </div>
            <p className="text-sm text-zinc-600 dark:text-zinc-400">
              Application in the {result.data.providerLabel} directory. Access below reflects what is represented in the connected directory.
            </p>
          </header>

          <StatGrid>
            <StatCard label="Effective identities" value={result.data.effectiveIdentityCount} />
            <StatCard label="Direct only" value={result.data.directOnlyCount} />
            <StatCard label="Through group only" value={result.data.groupOnlyCount} />
            <StatCard label="Direct and through group" value={result.data.bothCount} />
          </StatGrid>

          <section className="space-y-2">
            <h2 className="text-sm font-medium">Assigned groups ({result.data.assignedGroups.length})</h2>
            {result.data.assignedGroups.length === 0 ? (
              <p className="text-sm text-zinc-600 dark:text-zinc-400">No groups are assigned to this application in the selected scope.</p>
            ) : (
              <ul className="flex flex-wrap gap-2 text-sm">
                {groups.map((g, i) => <li key={i}><Badge tone="neutral">{g.groupLabel}{g.staleEvidence ? " · stale" : ""}</Badge></li>)}
                {result.data.assignedGroups.length > MAX_GROUPS_SHOWN ? <li className="self-center text-xs text-zinc-400">+{result.data.assignedGroups.length - MAX_GROUPS_SHOWN} more</li> : null}
              </ul>
            )}
            <p className="text-xs text-zinc-500">A group assigned here grants access only to its members; a group with no members adds no effective identity access.</p>
          </section>

          <section className="space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 className="text-sm font-medium">Effective identities ({result.data.effectiveIdentityCount})</h2>
              {paged.total > 0 ? (
                <a href={`${base}/export${accessQueryString(filters) ? `?${accessQueryString(filters)}` : ""}`} className="text-sm underline" rel="nofollow">Export CSV</a>
              ) : null}
            </div>

            <form method="get" action={base} className="flex flex-wrap items-end gap-3 text-sm" aria-label="Filter identities">
              <label className="flex flex-col gap-1">
                <span className="text-zinc-500">Search</span>
                <input type="search" name="q" defaultValue={filters.query ?? ""} placeholder="Identity"
                  className="rounded border border-zinc-300 px-2 py-1 dark:border-zinc-700 dark:bg-zinc-900" />
              </label>
              <label className="flex flex-col gap-1">
                <span className="text-zinc-500">Access path</span>
                <select name="classification" defaultValue={filters.classification ?? ""} className="rounded border border-zinc-300 px-2 py-1 dark:border-zinc-700 dark:bg-zinc-900">
                  <option value="">All</option>
                  {CLASSIFICATION_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                </select>
              </label>
              <label className="flex items-center gap-2 self-end pb-1.5">
                <input type="checkbox" name="stale" value="1" defaultChecked={filters.includeStale} />
                <span className="text-zinc-500">Include stale evidence</span>
              </label>
              <button type="submit" className="rounded border border-zinc-400 px-3 py-1.5 font-medium dark:border-zinc-600">Apply</button>
              {active > 0 ? <Link href={base} className="px-1 py-1.5 text-zinc-500 underline">Clear {active} filter{active === 1 ? "" : "s"}</Link> : null}
            </form>

            {paged.total === 0 ? (
              <div className="rounded border border-zinc-300 p-4 text-sm dark:border-zinc-700">
                <div className="font-medium">{active > 0 ? "No identities match the selected filters" : "No effective identity access represented"}</div>
                <p className="mt-1 text-zinc-600 dark:text-zinc-400">
                  {active > 0 ? <>No identities match the selected filters — <Link href={base} className="underline">clear filters</Link>.</> : "No effective identity access is represented for this application in the selected directory scope."}
                </p>
              </div>
            ) : (
              <>
                <p className="text-xs text-zinc-500">Showing {paged.startIndex}–{paged.endIndex} of {paged.total}{active > 0 ? " matching" : ""}.</p>
                <div className="overflow-x-auto text-sm">
                  <table className="w-full border-collapse text-left">
                    <thead>
                      <tr className="border-b border-zinc-300 text-zinc-500 dark:border-zinc-700">
                        <th className="py-2 pr-4 font-medium">Identity</th>
                        <th className="py-2 pr-4 font-medium">Access path</th>
                      </tr>
                    </thead>
                    <tbody>
                      {paged.rows.map((i) => (
                        <tr key={i.identityId} className="border-b border-zinc-200 dark:border-zinc-800">
                          <td className="py-2 pr-4 font-medium"><Link href={`/access/identities/${i.identityId}?${ret}`} className="underline">{i.identityLabel}</Link></td>
                          <td className="py-2 pr-4">
                            <span className="flex flex-wrap items-center gap-2">
                              <Badge tone="neutral">{i.classificationLabel}</Badge>
                              {i.staleEvidence ? <Badge tone="neutral">Stale evidence</Badge> : null}
                            </span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                {paged.totalPages > 1 ? (
                  <nav aria-label="Identities pagination" className="flex flex-wrap items-center justify-between gap-2 pt-1 text-sm">
                    {paged.hasPrev ? <Link href={accessHref(base, filters, { page: paged.page - 1 })} className="rounded border border-zinc-300 px-2 py-1 dark:border-zinc-700">← Previous</Link> : <span className="rounded border border-zinc-200 px-2 py-1 text-zinc-400 dark:border-zinc-800">← Previous</span>}
                    <span className="text-zinc-500" aria-current="page">Page {paged.page} of {paged.totalPages}</span>
                    {paged.hasNext ? <Link href={accessHref(base, filters, { page: paged.page + 1 })} className="rounded border border-zinc-300 px-2 py-1 dark:border-zinc-700">Next →</Link> : <span className="rounded border border-zinc-200 px-2 py-1 text-zinc-400 dark:border-zinc-800">Next →</span>}
                  </nav>
                ) : null}
              </>
            )}
          </section>

          <section className="space-y-2">
            <h2 className="text-sm font-medium">Findings for this application ({result.data.findings.length})</h2>
            {result.data.findings.length === 0 ? (
              <p className="text-sm text-zinc-600 dark:text-zinc-400">No governance findings for this application in the selected scope.</p>
            ) : (
              <>
                <ul className="space-y-2 text-sm">
                  {shownFindings.map((f) => (
                    <li key={f.id} className="rounded border border-zinc-200 p-3 dark:border-zinc-800">
                      <div className="flex flex-wrap items-center gap-2">
                        <Badge tone={f.severityTone}>{f.severityLabel}</Badge>
                        <span className="text-zinc-500">{f.confidenceLabel}</span>
                        <span className="font-medium">{f.title}</span>
                      </div>
                      <p className="mt-1 text-zinc-600 dark:text-zinc-400">{f.summary}</p>
                    </li>
                  ))}
                </ul>
                {result.data.findings.length > MAX_FINDINGS_SHOWN ? (
                  <p className="text-xs text-zinc-400">Showing the first {MAX_FINDINGS_SHOWN} of {result.data.findings.length} findings for this application.</p>
                ) : null}
              </>
            )}
          </section>

          <section className="rounded border border-zinc-200 p-4 text-xs text-zinc-500 dark:border-zinc-800">
            Access is represented from the connected directory. “No effective identity access represented” does not mean the application is
            unused or safe to remove — it reflects only what the directory represents.
          </section>
        </>
        );
      })()}
    </main>
  );
}
