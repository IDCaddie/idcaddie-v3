import Link from "next/link";
import { loadApplicationAccessDetail } from "@/lib/data/access-loaders";
import { StatCard, StatGrid } from "@/components/stat-card";
import { Badge } from "@/components/badge";

export const metadata = { title: "Application access · ID Caddie" };

// Read-only application access explanation (Phase 15 Part 1). Owner/admin only (loader-gated). The [id] param is ONLY a lookup key — a
// foreign, missing, or unauthorized id all return the same "not found". Effective identities + classification come from the Phase-13
// engine; findings from Phase-14. Shows access REPRESENTED in the directory; never claims the app is unused/used, license state, savings,
// or safe removal. No mutation controls. The app's canonical UUID appears only in hrefs, never as visible text.
export default async function ApplicationAccessPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ stale?: string }> }) {
  const { id } = await params;
  const includeStale = (await searchParams).stale === "1";
  const result = await loadApplicationAccessDetail(id, includeStale);

  return (
    <main className="flex flex-1 flex-col gap-6 p-8">
      <div className="text-sm">
        <Link href="/access" className="text-zinc-500 hover:underline">← Back to Access</Link>
      </div>

      {!result.ok && result.error === "query_failed" ? (
        <div><h1 className="text-xl font-semibold">Access</h1><p className="mt-1 text-sm text-red-600">Could not load this right now. Please try again later.</p></div>
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
      ) : (
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
                {result.data.assignedGroups.map((g, i) => (
                  <li key={i}><Badge tone="neutral">{g.groupLabel}{g.staleEvidence ? " · stale" : ""}</Badge></li>
                ))}
              </ul>
            )}
          </section>

          <section className="space-y-2">
            <h2 className="text-sm font-medium">Effective identities ({result.data.effectiveIdentityCount})</h2>
            {result.data.identities.length === 0 ? (
              <div className="rounded border border-zinc-300 p-4 text-sm dark:border-zinc-700">
                <div className="font-medium">No effective identity access represented</div>
                <p className="mt-1 text-zinc-600 dark:text-zinc-400">No effective identity access is represented for this application in the selected directory scope.</p>
              </div>
            ) : (
              <div className="overflow-x-auto text-sm">
                <table className="w-full border-collapse text-left">
                  <thead>
                    <tr className="border-b border-zinc-300 text-zinc-500 dark:border-zinc-700">
                      <th className="py-2 pr-4 font-medium">Identity</th>
                      <th className="py-2 pr-4 font-medium">Access path</th>
                    </tr>
                  </thead>
                  <tbody>
                    {result.data.identities.map((i) => (
                      <tr key={i.identityId} className="border-b border-zinc-200 dark:border-zinc-800">
                        <td className="py-2 pr-4 font-medium"><Link href={`/access/identities/${i.identityId}`} className="underline">{i.identityLabel}</Link></td>
                        <td className="py-2 pr-4"><Badge tone="neutral">{i.classificationLabel}</Badge></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <section className="space-y-2">
            <h2 className="text-sm font-medium">Findings for this application ({result.data.findings.length})</h2>
            {result.data.findings.length === 0 ? (
              <p className="text-sm text-zinc-600 dark:text-zinc-400">No governance findings for this application in the selected scope.</p>
            ) : (
              <ul className="space-y-2 text-sm">
                {result.data.findings.map((f) => (
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
            )}
          </section>

          <section className="rounded border border-zinc-200 p-4 text-xs text-zinc-500 dark:border-zinc-800">
            Access is represented from the connected directory. “No effective identity access represented” does not mean the application is
            unused or safe to remove — it reflects only what the directory represents.
          </section>
        </>
      )}
    </main>
  );
}
