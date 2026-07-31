import Link from "next/link";
import { loadAccessOverview } from "@/lib/data/access-loaders";
import { Badge } from "@/components/badge";
import {
  parseAccessFilters, filterFindings, paginate, accessHref, accessQueryString, findingsActiveFilters, returnParams,
  SEVERITY_OPTIONS, CONFIDENCE_OPTIONS, SUBJECT_TYPE_OPTIONS, RULE_OPTIONS,
  groupFindingsBySubject, subjectBucket, SUBJECT_BUCKET_OPTIONS,
} from "@/lib/data/access-filters";

export const metadata = { title: "Access findings · ID Caddie" };

// Read-only governance findings list (Phase 15 Part 2). Owner/admin only (loader-gated). Findings come from the Phase-14 engine over the
// complete evaluated graph; filtering/search/pagination happen server-side over the ALREADY-EVALUATED safe view models (never raw rows,
// never before Phase 13/14 — filters cannot change graph meaning). No mutation/resolve/remove/export actions here. Never claims
// usage/license/savings/safe-removal. Server-rendered, dynamic, uncached. Filtered totals are shown ONLY when evaluation is complete.
export default async function AccessFindingsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams;
  const filters = parseAccessFilters(sp);
  const result = await loadAccessOverview(filters.includeStale);
  const base = "/access/findings";

  return (
    <main className="flex flex-1 flex-col gap-6 p-8">
      <header className="space-y-1">
        <div className="text-sm"><Link href="/access" className="text-zinc-500 hover:underline">← Back to Access</Link></div>
        <h1 className="text-xl font-semibold">Governance findings</h1>
        <p className="text-sm text-zinc-600 dark:text-zinc-400">
          Findings represent access topology in your connected directory. They do not indicate application usage, license state, or savings.
        </p>
      </header>

      {!result.ok && result.error === "forbidden" ? (
        <div className="rounded border border-zinc-300 p-4 text-sm dark:border-zinc-700">
          <div className="font-medium">Not available</div>
          <p className="mt-1 text-zinc-600 dark:text-zinc-400">You don’t have access to this area.</p>
        </div>
      ) : !result.ok ? (
        <p className="text-sm text-red-600" role="alert">Access data could not be loaded. Please try again later.</p>
      ) : result.data.status === "too_large" ? (
        <div className="rounded border border-amber-400 bg-amber-50 p-4 text-sm dark:border-amber-700 dark:bg-amber-950/30" role="status">
          <div className="font-medium">Findings unavailable for this directory size</div>
          <p className="mt-1 text-zinc-700 dark:text-zinc-300">
            The full access graph was not evaluated within the current safety limits, so findings are not shown. Open a specific identity or
            application to review its access.
          </p>
        </div>
      ) : (() => {
        const filtered = filterFindings(result.data.findings, filters);
        const paged = paginate(filtered, filters.page, filters.pageSize);
        const total = result.data.governanceFindingsTotal;
        const active = findingsActiveFilters(filters);
        const ret = returnParams("findings", filters).toString();
        return (
        <>
          {/* GET filter form: native controls, no JS required, resets to page 1 on submit (page omitted). */}
          <form method="get" action={base} className="flex flex-wrap items-end gap-3 text-sm" aria-label="Filter findings">
            {filters.includeStale ? <input type="hidden" name="stale" value="1" /> : null}
            <label className="flex flex-col gap-1">
              <span className="text-zinc-500">Search</span>
              <input type="search" name="q" defaultValue={filters.query ?? ""} placeholder="Title, summary, or subject"
                className="rounded border border-zinc-300 px-2 py-1 dark:border-zinc-700 dark:bg-zinc-900" />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-zinc-500">Severity</span>
              <select name="severity" defaultValue={filters.severity ?? ""} className="rounded border border-zinc-300 px-2 py-1 dark:border-zinc-700 dark:bg-zinc-900">
                <option value="">All</option>
                {SEVERITY_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-zinc-500">Confidence</span>
              <select name="confidence" defaultValue={filters.confidence ?? ""} className="rounded border border-zinc-300 px-2 py-1 dark:border-zinc-700 dark:bg-zinc-900">
                <option value="">All</option>
                {CONFIDENCE_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-zinc-500">Finding type</span>
              <select name="rule" defaultValue={filters.ruleId ?? ""} className="rounded border border-zinc-300 px-2 py-1 dark:border-zinc-700 dark:bg-zinc-900">
                <option value="">All</option>
                {RULE_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </label>
            {/* The customer-facing bucket. The finer engine `subjectType` filter is kept beside it — the two compose, and an
                existing link carrying `subjectType` keeps working. */}
            <label className="flex flex-col gap-1">
              <span className="text-zinc-500">Subject</span>
              <select name="subject" defaultValue={filters.subject ?? ""} className="rounded border border-zinc-300 px-2 py-1 dark:border-zinc-700 dark:bg-zinc-900">
                <option value="">All</option>
                {SUBJECT_BUCKET_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-zinc-500">Subject type</span>
              <select name="subjectType" defaultValue={filters.subjectType ?? ""} className="rounded border border-zinc-300 px-2 py-1 dark:border-zinc-700 dark:bg-zinc-900">
                <option value="">All</option>
                {SUBJECT_TYPE_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-zinc-500">Evidence</span>
              <select name="staleEvidence" defaultValue={filters.staleEvidence === null ? "" : filters.staleEvidence ? "1" : "0"} className="rounded border border-zinc-300 px-2 py-1 dark:border-zinc-700 dark:bg-zinc-900">
                <option value="">All</option>
                <option value="1">Stale evidence</option>
                <option value="0">Current evidence</option>
              </select>
            </label>
            <button type="submit" className="rounded border border-zinc-400 px-3 py-1.5 font-medium dark:border-zinc-600">Apply filters</button>
            {active > 0 ? <Link href={base} className="px-1 py-1.5 text-zinc-500 underline">Clear {active} filter{active === 1 ? "" : "s"}</Link> : null}
          </form>

          {/* Completeness diagnostic + truthful filtered total + bounded CSV export of the current (filtered) findings. */}
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-sm text-zinc-500" role="status">
              The full represented access graph was evaluated for this scope.{" "}
              {active > 0
                ? <>Showing {filtered.length} of {total} finding{total === 1 ? "" : "s"} matching your filters.</>
                : <>{total} finding{total === 1 ? "" : "s"} total.</>}
            </p>
            {filtered.length > 0 ? (
              <a href={`${base}/export${accessQueryString(filters) ? `?${accessQueryString(filters)}` : ""}`} className="text-sm underline" rel="nofollow">Export CSV</a>
            ) : null}
          </div>

          {paged.total === 0 ? (
            <div className="rounded border border-zinc-300 p-4 text-sm dark:border-zinc-700">
              <div className="font-medium">{active > 0 ? "No findings match the selected filters" : "No findings"}</div>
              <p className="mt-1 text-zinc-600 dark:text-zinc-400">
                {active > 0
                  ? <>No findings match the selected filters — <Link href={base} className="underline">clear filters</Link>.</>
                  : "No governance findings were produced for the selected scope."}
              </p>
            </div>
          ) : (
            <section className="space-y-6 text-sm">
              {/* Grouped by SUBJECT, ordered by the worst severity each bucket contains — so the subject area needing attention
                  first is first, and severity still leads within each. Nothing is hidden: this changes order and grouping only.
                  Buckets with no findings on this page are omitted rather than rendered as zeros. */}
              {groupFindingsBySubject(paged.rows).map((bucket) => (
                <div key={bucket.bucket} className="space-y-2">
                  <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-zinc-200 pb-1 dark:border-zinc-800">
                    <h2 className="text-sm font-semibold">{bucket.label}</h2>
                    <Link href={accessHref(base, filters, { subject: bucket.bucket, page: 1 })} className="text-xs text-zinc-500 underline">
                      Show only {bucket.label.toLowerCase()}
                    </Link>
                  </div>
                  <ul className="space-y-2">
                    {bucket.findings.map((f) => (
                      <li key={f.id} className="rounded border border-zinc-200 dark:border-zinc-800">
                        <details className="group">
                          <summary className="flex cursor-pointer flex-wrap items-center gap-2 p-3">
                            <Badge tone={f.severityTone}>{f.severityLabel}</Badge>
                            <span className="text-zinc-500">{f.confidenceLabel}</span>
                            {f.staleEvidence ? <Badge tone="neutral">Stale evidence</Badge> : null}
                            <span className="font-medium">{f.title}</span>
                            {/* The subject label, when one resolved safely. Never a bare id, never a fabricated name. */}
                            {f.subject ? <span className="text-zinc-500">· {f.subject.label}</span> : null}
                          </summary>
                          <div className="space-y-2 border-t border-zinc-100 p-3 dark:border-zinc-800">
                            <p className="text-zinc-600 dark:text-zinc-400">{f.summary}</p>
                            {f.guidance ? <p className="text-xs text-zinc-500">{f.guidance}</p> : null}
                            <p className="text-xs text-zinc-500">Scope: access represented in your connected directory{f.staleEvidence ? ", including stale evidence" : ""}.</p>
                            {f.evidenceRows.length > 0 ? (
                              <dl className="flex flex-wrap gap-x-6 gap-y-1 text-xs text-zinc-500">
                                {f.evidenceRows.map((e) => (
                                  <div key={e.label} className="flex gap-1"><dt>{e.label}:</dt><dd className="tabular-nums text-zinc-700 dark:text-zinc-300">{e.value}</dd></div>
                                ))}
                              </dl>
                            ) : null}
                            {/* PRIMARY ACTION. A link exists only when the subject id resolved to a known object in the evaluated
                                scope; a superseded connector's row never resolves, so it can never become a route. Where there is
                                no safe object — a structural finding about the directory as a whole — say so rather than invent a
                                destination. */}
                            {f.subject ? (
                              <Link href={`${f.subject.href}?${ret}`} className="inline-block text-xs underline">
                                {f.subject.kind === "group" ? "Open group" : f.subject.kind === "application" ? "Open application" : "Open person"}: {f.subject.label}
                              </Link>
                            ) : (
                              <p className="text-xs text-zinc-500">
                                {subjectBucket(f.subjectType) === "directory"
                                  ? "This describes your directory connection as a whole rather than one record, so there is no object to open."
                                  : "The subject of this finding is outside the currently evaluated directory scope, so it cannot be opened from here."}
                              </p>
                            )}
                            <p className="text-xs text-zinc-400">
                              This reflects access topology represented in your connected directory. It does not indicate application usage,
                              license state, or that access is safe to remove.
                            </p>
                          </div>
                        </details>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}

              {paged.totalPages > 1 ? (
                <nav aria-label="Findings pagination" className="flex flex-wrap items-center justify-between gap-2 pt-2 text-sm">
                  {paged.hasPrev
                    ? <Link href={accessHref(base, filters, { page: paged.page - 1 })} className="rounded border border-zinc-300 px-2 py-1 dark:border-zinc-700">← Previous</Link>
                    : <span className="rounded border border-zinc-200 px-2 py-1 text-zinc-400 dark:border-zinc-800">← Previous</span>}
                  <span className="text-zinc-500" aria-current="page">Page {paged.page} of {paged.totalPages} ({paged.startIndex}–{paged.endIndex} of {paged.total})</span>
                  {paged.hasNext
                    ? <Link href={accessHref(base, filters, { page: paged.page + 1 })} className="rounded border border-zinc-300 px-2 py-1 dark:border-zinc-700">Next →</Link>
                    : <span className="rounded border border-zinc-200 px-2 py-1 text-zinc-400 dark:border-zinc-800">Next →</span>}
                </nav>
              ) : null}
            </section>
          )}
        </>
        );
      })()}
    </main>
  );
}
