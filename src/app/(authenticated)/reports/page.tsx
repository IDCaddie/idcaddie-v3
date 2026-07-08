import Link from "next/link";
import { getReportsSummaryForCurrentUser } from "@/lib/data/reports";
import { StatCard, StatGrid } from "@/components/stat-card";

export const metadata = { title: "Reports · ID Caddie" };

// Read-only Reports view = simple "visible to you" summary counts from existing RLS-backed read surfaces.
// It invents NO report capability: every number is an RLS-scoped count of rows the signed-in user may
// already read. No generation workflow, no export/download, no scheduling, no AI, no connector data.
// Tiles deep-link to the implemented page that owns each count (accounts/matched/unmatched → /people).

const NOT_BUILT = [
  "Export / download (CSV, PDF)",
  "Scheduled reports",
  "Emailed reports",
  "AI report insights",
  "Connector-driven spend / license reporting",
  "The 7 legacy report types",
];

export default async function ReportsPage() {
  const s = await getReportsSummaryForCurrentUser();

  return (
    <main className="flex flex-1 flex-col gap-6 p-8">
      <header className="space-y-1">
        <div className="text-sm">
          <Link href="/dashboards" className="text-zinc-500 hover:underline">
            ← Back
          </Link>
        </div>
        <h1 className="text-xl font-semibold">Reports</h1>
        <p className="text-sm text-zinc-600 dark:text-zinc-400">
          Read-only summary of what is <strong>visible to you</strong> (RLS-scoped) — not absolute
          tenant-wide totals. A “—” means that count is temporarily unavailable. This is a simple summary,
          not a report builder: there is no generation, export, scheduling, AI, or connector data here.
        </p>
      </header>

      <StatGrid>
        <StatCard label="Apps visible" value={s.appsVisible} href="/apps" />
        <StatCard label="Contracts visible" value={s.contractsVisible} href="/contracts" />
        <StatCard label="App-user accounts visible" value={s.accountsVisible} href="/people" />
        <StatCard label="Accounts matched" value={s.accountsMatched} href="/people" />
        <StatCard label="Accounts unmatched" value={s.accountsUnmatched} href="/people" />
        <StatCard label="Files visible" value={s.filesVisible} href="/files" />
      </StatGrid>
      <p className="text-xs text-zinc-500">
        Counts reflect only rows your tenant/org access allows; matched/unmatched is the identity-account
        match status only (no person/IdP detail, no spend, no license intelligence).
      </p>

      <section className="space-y-2 text-sm">
        <h2 className="font-medium">Reporting capabilities</h2>
        <p className="text-xs text-zinc-500">
          These old-app reporting capabilities are not implemented in v3 yet — shown so the gap is
          explicit, not hidden. This surface is read-only.
        </p>
        <ul className="flex flex-wrap gap-2">
          {NOT_BUILT.map((label) => (
            <li key={label}>
              <span
                aria-disabled="true"
                title="Not built yet"
                className="inline-flex items-center gap-2 rounded border border-zinc-300 px-2.5 py-1 text-xs text-zinc-400 dark:border-zinc-700"
              >
                {label}
                <span className="rounded-full border border-zinc-300 px-1.5 text-[10px] dark:border-zinc-700">
                  Not built yet
                </span>
              </span>
            </li>
          ))}
        </ul>
      </section>
    </main>
  );
}
