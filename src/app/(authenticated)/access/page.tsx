import Link from "next/link";
import { loadAccessOverview } from "@/lib/data/access-loaders";
import { StatCard, StatGrid } from "@/components/stat-card";
import { Badge } from "@/components/badge";
import { parseAccessFilters, returnParams, SEVERITY_OPTIONS } from "@/lib/data/access-filters";

export const metadata = { title: "Access · ID Caddie" };

// Read-only access overview (Phase 15 Part 1). Owner/admin only — the loader gates via the migration-0061 RPCs (canonical tables stay
// deny-all; no browser DB/RPC access). Effective access is resolved by the Phase-13 engine and governance findings by the Phase-14 engine
// (never reimplemented here). It shows only assignments REPRESENTED in the connected directory — it does not claim application usage,
// license state, cost, savings, inactivity, or safe removal. No mutation controls. Server-rendered; dynamic (cookies-bound), never cached.
export default async function AccessOverviewPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams;
  const filters = parseAccessFilters(sp);
  const includeStale = filters.includeStale;
  const ret = returnParams("overview", filters).toString();
  const result = await loadAccessOverview(includeStale);
  const findingsBase = includeStale ? "/access/findings?stale=1" : "/access/findings";

  return (
    <main className="flex flex-1 flex-col gap-6 p-8">
      <header className="space-y-1">
        <h1 className="text-xl font-semibold">Access</h1>
        <p className="text-sm text-zinc-600 dark:text-zinc-400">
          Review application access represented in your connected directory.
        </p>
      </header>

      {!result.ok && result.error === "forbidden" ? (
        <div className="rounded border border-zinc-300 p-4 text-sm dark:border-zinc-700">
          <div className="font-medium">Not available</div>
          <p className="mt-1 text-zinc-600 dark:text-zinc-400">You don’t have access to this area.</p>
        </div>
      ) : !result.ok ? (
        <p className="text-sm text-red-600" role="alert">Access data could not be loaded. Please try again later.</p>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-3 text-xs text-zinc-500">
            <span>{includeStale ? "Showing current and stale directory evidence" : "Showing current directory evidence"}</span>
            <Link href={includeStale ? "/access" : "/access?stale=1"} className="underline">
              {includeStale ? "Show current only" : "Include stale evidence"}
            </Link>
          </div>

          <StatGrid>
            {/* Phase 2: the three node counts now open the Directory list that produced them. The edge counts below have no list page
                of their own and stay unlinked rather than pointing somewhere approximate. */}
            <StatCard label="Identities" value={result.data.counts.identities} href="/directory/people" />
            <StatCard label="Groups" value={result.data.counts.groups} href="/directory/groups" />
            <StatCard label="Applications" value={result.data.counts.applications} href="/directory/applications" />
            <StatCard label="Group memberships" value={result.data.counts.memberships} />
            <StatCard label="Direct assignments" value={result.data.counts.directAssignments} />
            <StatCard label="Group assignments" value={result.data.counts.groupAssignments} />
          </StatGrid>

          {result.data.status === "too_large" ? (
            <div className="rounded border border-amber-400 bg-amber-50 p-4 text-sm dark:border-amber-700 dark:bg-amber-950/30" role="status">
              <div className="font-medium">Too large to evaluate in this view</div>
              <p className="mt-1 text-zinc-700 dark:text-zinc-300">
                The full access graph was not evaluated within the current safety limits, so effective-access and governance results are
                not shown. Counts above remain accurate. Open a specific identity or application to review its access.
              </p>
            </div>
          ) : (() => {
            if (result.data.status !== "complete") return null; // narrows to the complete variant as a const for closures below
            const data = result.data;
            const bySeverity = data.summary.bySeverity;
            return (
            <>
              <section className="space-y-2">
                <h2 className="text-sm font-medium">Effective access breakdown</h2>
                <StatGrid>
                  <StatCard label="Effective access relationships" value={data.effectiveRelationships} />
                  <StatCard label="Direct only" value={data.breakdown.directOnly} />
                  <StatCard label="Through group only" value={data.breakdown.groupOnly} />
                  <StatCard label="Direct and through group" value={data.breakdown.both} />
                </StatGrid>
              </section>

              <section className="space-y-2">
                <div className="flex items-center justify-between">
                  <h2 className="text-sm font-medium">Governance findings ({data.governanceFindingsTotal})</h2>
                  <Link href={findingsBase} className="text-xs underline">View all findings</Link>
                </div>

                {/* Findings by severity — links straight to the filtered findings list (counts only; no risk score). */}
                <div className="flex flex-wrap items-center gap-2 text-xs">
                  {SEVERITY_OPTIONS.map((o) => (
                    <Link key={o.value} href={`/access/findings?${includeStale ? "stale=1&" : ""}severity=${o.value}`}
                      className="rounded-full border border-zinc-300 px-2 py-0.5 text-zinc-600 hover:underline dark:border-zinc-700 dark:text-zinc-400">
                      {o.label}: <span className="tabular-nums">{bySeverity[o.value]}</span>
                    </Link>
                  ))}
                </div>

                {/* Search shortcut into the findings list. */}
                <form method="get" action="/access/findings" className="flex flex-wrap items-center gap-2 text-sm">
                  {includeStale ? <input type="hidden" name="stale" value="1" /> : null}
                  <label className="sr-only" htmlFor="overview-finding-search">Search findings</label>
                  <input id="overview-finding-search" type="search" name="q" placeholder="Search findings"
                    className="rounded border border-zinc-300 px-2 py-1 dark:border-zinc-700 dark:bg-zinc-900" />
                  <button type="submit" className="rounded border border-zinc-400 px-3 py-1 dark:border-zinc-600">Search</button>
                </form>

                {data.findings.length === 0 ? (
                  <div className="rounded border border-zinc-300 p-4 text-sm dark:border-zinc-700">
                    <div className="font-medium">No findings</div>
                    <p className="mt-1 text-zinc-600 dark:text-zinc-400">No governance findings were produced for the selected scope.</p>
                  </div>
                ) : (
                  <ul className="space-y-2">
                    {data.findings.slice(0, 10).map((f) => (
                      <li key={f.id} className="rounded border border-zinc-200 p-3 text-sm dark:border-zinc-800">
                        <div className="flex flex-wrap items-center gap-2">
                          <Badge tone={f.severityTone}>{f.severityLabel}</Badge>
                          <span className="text-zinc-500">{f.confidenceLabel}</span>
                          {f.staleEvidence ? <Badge tone="neutral">Stale evidence</Badge> : null}
                          <span className="font-medium">{f.title}</span>
                        </div>
                        <p className="mt-1 text-zinc-600 dark:text-zinc-400">{f.summary}</p>
                        {f.subject ? (
                          <Link href={`${f.subject.href}?${ret}`} className="mt-1 inline-block text-xs underline">
                            View access details: {f.subject.label}
                          </Link>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            </>
            );
          })()}

          <section className="rounded border border-zinc-200 p-4 text-xs text-zinc-500 dark:border-zinc-800">
            This view reflects assignments represented in the connected directory. It does not show application usage or guarantee that a
            paid license is active. Findings are for review only; no access is changed here.
          </section>
        </>
      )}
    </main>
  );
}
