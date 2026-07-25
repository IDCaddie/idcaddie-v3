import Link from "next/link";
import { loadAccessOverview } from "@/lib/data/access-loaders";
import { Badge } from "@/components/badge";
import type { GovernanceSeverity } from "@/lib/server/governance-analytics/types";

export const metadata = { title: "Access findings · ID Caddie" };

const SEVERITIES: readonly GovernanceSeverity[] = ["high", "medium", "low", "info"];
const isSeverity = (v: string): v is GovernanceSeverity => (SEVERITIES as readonly string[]).includes(v);

// Read-only governance findings list (Phase 15 Part 1). Owner/admin only (loader-gated). Findings come from the Phase-14 engine over the
// current directory scope. Server-side severity filter (strict allowlist). No mutation/resolve/remove/export actions — "View access
// details" only. Never claims usage/license/savings/safe-removal. Server-rendered, dynamic, uncached.
export default async function AccessFindingsPage({ searchParams }: { searchParams: Promise<{ stale?: string; severity?: string }> }) {
  const sp = await searchParams;
  const includeStale = sp.stale === "1";
  const severity = typeof sp.severity === "string" && isSeverity(sp.severity) ? sp.severity : null;
  const result = await loadAccessOverview(includeStale);

  const hrefWith = (over: { severity?: GovernanceSeverity | null }) => {
    const params = new URLSearchParams();
    if (includeStale) params.set("stale", "1");
    const nextSev = over.severity === undefined ? severity : over.severity;
    if (nextSev) params.set("severity", nextSev);
    const qs = params.toString();
    return `/access/findings${qs ? `?${qs}` : ""}`;
  };
  const pill = (active: boolean) =>
    `rounded-full border px-2 py-0.5 text-xs ${active ? "border-amber-500 text-amber-700 dark:text-amber-400" : "border-zinc-300 text-zinc-500 dark:border-zinc-700"}`;

  return (
    <main className="flex flex-1 flex-col gap-6 p-8">
      <header className="space-y-1">
        <div className="text-sm">
          <Link href="/access" className="text-zinc-500 hover:underline">← Back to Access</Link>
        </div>
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
        <p className="text-sm text-red-600">Access data could not be loaded. Please try again later.</p>
      ) : result.data.status === "too_large" ? (
        <div className="rounded border border-amber-400 bg-amber-50 p-4 text-sm dark:border-amber-700 dark:bg-amber-950/30" role="status">
          <div className="font-medium">Findings unavailable for this directory size</div>
          <p className="mt-1 text-zinc-700 dark:text-zinc-300">
            The full access graph was not evaluated within the current safety limits, so findings are not shown. Open a specific identity or
            application to review its access.
          </p>
        </div>
      ) : (() => {
        const allFindings = result.data.findings;
        const findings = severity ? allFindings.filter((f) => f.severity === severity) : allFindings;
        const total = result.data.governanceFindingsTotal;
        return (
        <>
          <nav aria-label="Filter by severity" className="flex flex-wrap items-center gap-2 text-sm">
            <Link href={hrefWith({ severity: null })} aria-current={severity === null ? "page" : undefined} className={pill(severity === null)}>All</Link>
            {SEVERITIES.map((s) => (
              <Link key={s} href={hrefWith({ severity: s })} aria-current={severity === s ? "page" : undefined} className={pill(severity === s)}>
                {s[0].toUpperCase() + s.slice(1)}
              </Link>
            ))}
          </nav>

          {findings.length === 0 ? (
            <div className="rounded border border-zinc-300 p-4 text-sm dark:border-zinc-700">
              <div className="font-medium">{severity ? "No findings match this filter" : "No findings"}</div>
              <p className="mt-1 text-zinc-600 dark:text-zinc-400">
                {severity ? (
                  <>No {severity} findings for the selected scope — <Link href={hrefWith({ severity: null })} className="underline">clear the filter</Link>.</>
                ) : (
                  "No governance findings were produced for the selected scope."
                )}
              </p>
            </div>
          ) : (
            <section className="space-y-2 text-sm">
              <div className="text-zinc-500">{findings.length} finding{findings.length === 1 ? "" : "s"}{severity ? "" : ` across ${total} total`}</div>
              <ul className="space-y-2">
                {findings.map((f) => (
                  <li key={f.id} className="rounded border border-zinc-200 p-3 dark:border-zinc-800">
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge tone={f.severityTone}>{f.severityLabel}</Badge>
                      <span className="text-zinc-500">{f.confidenceLabel}</span>
                      {f.staleEvidence ? <Badge tone="neutral">Stale evidence</Badge> : null}
                      <span className="font-medium">{f.title}</span>
                    </div>
                    <p className="mt-1 text-zinc-600 dark:text-zinc-400">{f.summary}</p>
                    {f.guidance ? <p className="mt-1 text-xs text-zinc-500">{f.guidance}</p> : null}
                    {f.evidenceRows.length > 0 ? (
                      <dl className="mt-2 flex flex-wrap gap-x-6 gap-y-1 text-xs text-zinc-500">
                        {f.evidenceRows.map((e) => (
                          <div key={e.label} className="flex gap-1"><dt>{e.label}:</dt><dd className="tabular-nums text-zinc-700 dark:text-zinc-300">{e.value}</dd></div>
                        ))}
                      </dl>
                    ) : null}
                    {f.subject ? (
                      <Link href={f.subject.href} className="mt-2 inline-block text-xs underline">View access details: {f.subject.label}</Link>
                    ) : null}
                  </li>
                ))}
              </ul>
            </section>
          )}
        </>
        );
      })()}
    </main>
  );
}
