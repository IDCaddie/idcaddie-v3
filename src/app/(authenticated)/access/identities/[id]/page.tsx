import Link from "next/link";
import { loadIdentityAccessDetail } from "@/lib/data/access-loaders";
import { Badge } from "@/components/badge";

export const metadata = { title: "Identity access · ID Caddie" };

// Read-only identity access explanation (Phase 15 Part 1). Owner/admin only (loader-gated). The [id] param is ONLY a lookup key — a
// foreign, missing, or unauthorized id all return the same "not found" (no existence disclosure). Effective access + classification come
// from the Phase-13 engine; findings from Phase-14. Shows access REPRESENTED in the directory; never claims usage/license/savings/safe
// removal, and offers no remove-access control. The identity's canonical UUID appears only in hrefs, never as visible text.
export default async function IdentityAccessPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ stale?: string }> }) {
  const { id } = await params;
  const includeStale = (await searchParams).stale === "1";
  const result = await loadIdentityAccessDetail(id, includeStale);

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
            <p className="text-sm text-zinc-600 dark:text-zinc-400">Identity in the {result.data.providerLabel} directory.</p>
          </header>
          <div className="rounded border border-amber-400 bg-amber-50 p-4 text-sm dark:border-amber-700 dark:bg-amber-950/30" role="status">
            <div className="font-medium">Too large to display in full</div>
            <p className="mt-1 text-zinc-700 dark:text-zinc-300">This identity’s access graph is too large to evaluate in this view within the current safety limits.</p>
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
            </div>
            <p className="text-sm text-zinc-600 dark:text-zinc-400">
              Identity in the {result.data.providerLabel} directory. Access below reflects what is represented in the connected directory.
            </p>
          </header>

          <section className="space-y-2">
            <h2 className="text-sm font-medium">Effective application access ({result.data.effectiveApplicationCount})</h2>
            {result.data.applications.length === 0 ? (
              <div className="rounded border border-zinc-300 p-4 text-sm dark:border-zinc-700">
                <div className="font-medium">No application access represented</div>
                <p className="mt-1 text-zinc-600 dark:text-zinc-400">No effective application access is represented for this identity.</p>
              </div>
            ) : (
              <ul className="space-y-2 text-sm">
                {result.data.applications.map((a) => (
                  <li key={a.applicationId} className="rounded border border-zinc-200 p-3 dark:border-zinc-800">
                    <div className="flex flex-wrap items-center gap-2">
                      <Link href={`/access/applications/${a.applicationId}`} className="font-medium underline">{a.applicationLabel}</Link>
                      <Badge tone="neutral">{a.classificationLabel}</Badge>
                      {a.staleEvidence ? <Badge tone="neutral">Stale evidence</Badge> : null}
                    </div>
                    <p className="mt-1 text-zinc-600 dark:text-zinc-400">{a.explanation}</p>
                    {a.groupPaths.length > 0 ? (
                      <ul className="mt-1 list-disc pl-5 text-xs text-zinc-500">
                        {a.groupPaths.map((p, i) => (
                          <li key={i}>Through {p.groupLabel}{p.staleEvidence ? " (stale evidence)" : ""}</li>
                        ))}
                      </ul>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="space-y-2">
            <h2 className="text-sm font-medium">Findings for this identity ({result.data.findings.length})</h2>
            {result.data.findings.length === 0 ? (
              <p className="text-sm text-zinc-600 dark:text-zinc-400">No governance findings for this identity in the selected scope.</p>
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
                    {f.guidance ? <p className="mt-1 text-xs text-zinc-500">{f.guidance}</p> : null}
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="rounded border border-zinc-200 p-4 text-xs text-zinc-500 dark:border-zinc-800">
            Access is represented from the connected directory. It does not indicate application usage or license state, and “potentially
            redundant” access should be reviewed before any change is made.
          </section>
        </>
      )}
    </main>
  );
}
