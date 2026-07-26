import Link from "next/link";
import { loadIdentityAccessDetail } from "@/lib/data/access-loaders";
import { Badge } from "@/components/badge";
import {
  parseAccessFilters, filterIdentityApplications, paginate, accessHref, detailActiveFilters, backLink, returnParams,
  CLASSIFICATION_OPTIONS,
} from "@/lib/data/access-filters";

export const metadata = { title: "Identity access · ID Caddie" };

const MAX_GROUP_PATHS = 20;    // bounded reveal: never render an unbounded group-path list into the browser
const MAX_FINDINGS_SHOWN = 50; // per-entity findings scale with the subgraph; cap the rendered list (bounded by SUBGRAPH_MAX_ROWS above it)

// Read-only identity access explanation (Phase 15 Part 2). Owner/admin only (loader-gated). The [id] param is ONLY a lookup key — a
// foreign, missing, or unauthorized id all return the same "not found". Effective access + classification come from the Phase-13 engine;
// findings from Phase-14. Application filters/search/pagination act on the already-computed relationships only (never re-resolving the
// graph). Shows access REPRESENTED in the directory; never claims usage/license/savings/safe removal; no remove-access control. The
// identity's canonical UUID appears only in hrefs, never as visible text.
export default async function IdentityAccessPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { id } = await params;
  const sp = await searchParams;
  const filters = parseAccessFilters(sp);
  const result = await loadIdentityAccessDetail(id, filters.includeStale);
  const back = backLink(sp);
  const base = `/access/identities/${id}`;

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
            <p className="text-sm text-zinc-600 dark:text-zinc-400">Identity in the {result.data.providerLabel} directory.</p>
          </header>
          <div className="rounded border border-amber-400 bg-amber-50 p-4 text-sm dark:border-amber-700 dark:bg-amber-950/30" role="status">
            <div className="font-medium">Too large to display in full</div>
            <p className="mt-1 text-zinc-700 dark:text-zinc-300">This identity’s access graph is too large to evaluate in this view within the current safety limits.</p>
          </div>
        </>
      ) : (() => {
        const filtered = filterIdentityApplications(result.data.applications, filters);
        const paged = paginate(filtered, filters.page, filters.pageSize);
        const active = detailActiveFilters(filters);
        const ret = returnParams("identity", filters, id).toString();
        const shownFindings = result.data.findings.slice(0, MAX_FINDINGS_SHOWN);
        return (
        <>
          <header className="space-y-1">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-xl font-semibold">{result.data.displayName}</h1>
              <Badge tone={result.data.syncState === "current" ? "success" : "neutral"}>
                {result.data.syncState === "current" ? "Current" : "Stale evidence"}
              </Badge>
            </div>
            <p className="text-sm text-zinc-600 dark:text-zinc-400">
              Identity in the {result.data.providerLabel} directory. Access below reflects what is represented in the connected directory.
            </p>
          </header>

          <section className="space-y-3">
            <h2 className="text-sm font-medium">Effective application access ({result.data.effectiveApplicationCount})</h2>

            <form method="get" action={base} className="flex flex-wrap items-end gap-3 text-sm" aria-label="Filter applications">
              <label className="flex flex-col gap-1">
                <span className="text-zinc-500">Search</span>
                <input type="search" name="q" defaultValue={filters.query ?? ""} placeholder="Application"
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
                <div className="font-medium">{active > 0 ? "No applications match the selected filters" : "No application access represented"}</div>
                <p className="mt-1 text-zinc-600 dark:text-zinc-400">
                  {active > 0 ? <>No applications match the selected filters — <Link href={base} className="underline">clear filters</Link>.</> : "No effective application access is represented for this identity."}
                </p>
              </div>
            ) : (
              <>
                <p className="text-xs text-zinc-500">Showing {paged.startIndex}–{paged.endIndex} of {paged.total}{active > 0 ? " matching" : ""}.</p>
                <ul className="space-y-2 text-sm">
                  {paged.rows.map((a) => {
                    const shownPaths = a.groupPaths.slice(0, MAX_GROUP_PATHS);
                    return (
                      <li key={a.applicationId} className="rounded border border-zinc-200 p-3 dark:border-zinc-800">
                        <div className="flex flex-wrap items-center gap-2">
                          <Link href={`/access/applications/${a.applicationId}?${ret}`} className="font-medium underline">{a.applicationLabel}</Link>
                          <Badge tone="neutral">{a.classificationLabel}</Badge>
                          {a.staleEvidence ? <Badge tone="neutral">Stale evidence</Badge> : null}
                        </div>
                        <p className="mt-1 text-zinc-600 dark:text-zinc-400">{a.explanation}</p>
                        {shownPaths.length > 0 ? (
                          <ul className="mt-1 list-disc pl-5 text-xs text-zinc-500">
                            {shownPaths.map((p, i) => <li key={i}>Through {p.groupLabel}{p.staleEvidence ? " (stale evidence)" : ""}</li>)}
                            {a.groupPaths.length > MAX_GROUP_PATHS ? <li className="list-none text-zinc-400">+{a.groupPaths.length - MAX_GROUP_PATHS} more group path{a.groupPaths.length - MAX_GROUP_PATHS === 1 ? "" : "s"}</li> : null}
                          </ul>
                        ) : null}
                      </li>
                    );
                  })}
                </ul>

                {paged.totalPages > 1 ? (
                  <nav aria-label="Applications pagination" className="flex flex-wrap items-center justify-between gap-2 pt-1 text-sm">
                    {paged.hasPrev ? <Link href={accessHref(base, filters, { page: paged.page - 1 })} className="rounded border border-zinc-300 px-2 py-1 dark:border-zinc-700">← Previous</Link> : <span className="rounded border border-zinc-200 px-2 py-1 text-zinc-400 dark:border-zinc-800">← Previous</span>}
                    <span className="text-zinc-500" aria-current="page">Page {paged.page} of {paged.totalPages}</span>
                    {paged.hasNext ? <Link href={accessHref(base, filters, { page: paged.page + 1 })} className="rounded border border-zinc-300 px-2 py-1 dark:border-zinc-700">Next →</Link> : <span className="rounded border border-zinc-200 px-2 py-1 text-zinc-400 dark:border-zinc-800">Next →</span>}
                  </nav>
                ) : null}
              </>
            )}
          </section>

          <section className="space-y-2">
            <h2 className="text-sm font-medium">Findings for this identity ({result.data.findings.length})</h2>
            {result.data.findings.length === 0 ? (
              <p className="text-sm text-zinc-600 dark:text-zinc-400">No governance findings for this identity in the selected scope.</p>
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
                      {f.guidance ? <p className="mt-1 text-xs text-zinc-500">{f.guidance}</p> : null}
                    </li>
                  ))}
                </ul>
                {result.data.findings.length > MAX_FINDINGS_SHOWN ? (
                  <p className="text-xs text-zinc-400">Showing the first {MAX_FINDINGS_SHOWN} of {result.data.findings.length} findings for this identity.</p>
                ) : null}
              </>
            )}
          </section>

          <section className="rounded border border-zinc-200 p-4 text-xs text-zinc-500 dark:border-zinc-800">
            Access is represented from the connected directory. It does not indicate application usage or license state, and “potentially
            redundant” access should be reviewed before any change is made.
          </section>
        </>
        );
      })()}
    </main>
  );
}
