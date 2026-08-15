import Link from "next/link";
import { loadCrossSourceFindings } from "@/lib/data/cross-source-findings-reader";
import { Badge } from "@/components/badge";

export const metadata = { title: "Cross-system governance · ID Caddie" };

// Phase 18F Lane A — the FIRST customer surface for persisted cross-source governance findings (0083).
//
// WHY THIS IS NOT /access/findings. That page renders the Phase-14 engine over the live access graph: how access is
// arranged INSIDE one directory, evaluated fresh on every request, with no lifecycle. These findings are a different
// thing — they span connected systems, they are PERSISTED, and they have an age, a status and a reopen count that
// 0083 owns. Folding them into that page would have meant widening its view models, filters and CSV allowlist, and
// would have merged "your access topology" with "what is unowned across your estate" into one undifferentiated list.
// They sit side by side in the same nav section instead, and link to each other.
//
// Read-only. Owner/admin, enforced server-side by `accessGate()` and re-checked by the RPC. No mutation, no export,
// no client component, no browser-side tenant id. Server-rendered, dynamic, uncached.
//
// TRUTHFULNESS. Every sentence a customer reads comes from `crossSourceProse` (the single copy authority) via the
// reader — this file interpolates no governance prose of its own and never renders an internal enum. It states what
// is known, and does not claim contract, spend or licence facts that these rules do not establish.
export default async function CrossSystemGovernancePage() {
  const result = await loadCrossSourceFindings();

  return (
    <main className="flex flex-1 flex-col gap-6 p-8">
      <header className="space-y-1">
        <div className="text-sm">
          <Link href="/access" className="text-zinc-500 hover:underline">← Back to Access</Link>
        </div>
        <h1 className="text-xl font-semibold">Cross-system governance</h1>
        <p className="max-w-3xl text-sm text-zinc-600 dark:text-zinc-400">
          Ownership and coverage gaps found by comparing your connected systems with each other. These are separate
          from{" "}
          <Link href="/access/findings" className="underline">access findings</Link>, which describe how access is
          arranged inside your directory.
        </p>
      </header>

      {!result.ok && result.error === "forbidden" ? (
        <div className="rounded border border-zinc-300 p-4 text-sm dark:border-zinc-700">
          <div className="font-medium">Not available</div>
          <p className="mt-1 text-zinc-600 dark:text-zinc-400">You don’t have access to this area.</p>
        </div>
      ) : !result.ok ? (
        <p className="text-sm text-red-600" role="alert">
          Governance findings could not be loaded. Please try again later.
        </p>
      ) : result.data.total === 0 ? (
        <div className="rounded border border-zinc-300 p-4 text-sm dark:border-zinc-700">
          <div className="font-medium">No open findings</div>
          <p className="mt-1 text-zinc-600 dark:text-zinc-400">
            Nothing is currently flagged across your connected systems. Findings appear here after a governance
            evaluation runs.
          </p>
        </div>
      ) : (
        <>
          {/* A dropped row is reported, never swallowed: a short list must not read as a clean estate. */}
          {result.data.unreadable > 0 ? (
            <p className="rounded border border-amber-400 bg-amber-50 p-3 text-sm dark:border-amber-700 dark:bg-amber-950/30" role="status">
              {result.data.unreadable} finding{result.data.unreadable === 1 ? "" : "s"} could not be displayed. The list
              below is incomplete.
            </p>
          ) : null}

          <p className="text-sm text-zinc-500" role="status">
            {result.data.total} open finding{result.data.total === 1 ? "" : "s"}.
          </p>

          <ul className="flex flex-col gap-3" aria-label="Cross-system governance findings">
            {result.data.findings.map((f) => (
              <li key={f.id} className="rounded border border-zinc-300 p-4 dark:border-zinc-700">
                <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
                  <div className="min-w-0">
                    {/* h2 under the page h1 — one heading level per nesting step, so the list is navigable by heading. */}
                    <h2 className="font-medium">{f.title}</h2>
                    <p className="mt-1 max-w-3xl text-sm text-zinc-600 dark:text-zinc-400">{f.summary}</p>
                  </div>
                  {/* Severity carries a WORD, not just a colour — the badge tone is reinforcement, never the signal. */}
                  <div className="flex shrink-0 flex-wrap items-center gap-2">
                    <Badge tone={f.severityTone}>{f.severityLabel}</Badge>
                    <Badge tone="neutral">{f.subjectKind}</Badge>
                    <Badge tone={f.lifecycleLabel === "Returned" ? "attention" : "neutral"}>{f.lifecycleLabel}</Badge>
                  </div>
                </div>

                <dl className="mt-3 flex flex-wrap gap-x-6 gap-y-1 text-sm text-zinc-600 dark:text-zinc-400">
                  {f.firstSeenLabel ? (
                    <div className="flex gap-1"><dt className="sr-only">Age</dt><dd>{f.firstSeenLabel}</dd></div>
                  ) : null}
                  <div className="flex gap-1"><dt className="sr-only">Confidence</dt><dd>{f.confidenceLabel}</dd></div>
                  {f.evidenceRows.map((e) => (
                    <div key={e.label} className="flex gap-1">
                      <dt>{e.label}:</dt><dd>{e.value}</dd>
                    </div>
                  ))}
                </dl>

                {f.guidance ? (
                  <p className="mt-3 text-sm text-zinc-700 dark:text-zinc-300">{f.guidance}</p>
                ) : null}

                <div className="mt-3">
                  {f.action ? (
                    <Link
                      href={f.action.href}
                      className="inline-block rounded border border-zinc-400 px-3 py-1.5 text-sm font-medium hover:bg-zinc-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 dark:border-zinc-600 dark:hover:bg-zinc-900"
                    >
                      {f.action.label}
                    </Link>
                  ) : (
                    // Lane B owns the match-review surface. Until it exists we say so plainly rather than linking to a
                    // route that would 404 — an honest disabled affordance beats a broken promise.
                    <p className="text-sm text-zinc-500">
                      Review this application’s matches in your application records. A dedicated review screen is not
                      available yet.
                    </p>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </>
      )}
    </main>
  );
}
