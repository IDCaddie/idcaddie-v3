import Link from "next/link";
import { getReportsSummaryForCurrentUser } from "@/lib/data/reports";

export const metadata = { title: "Reports · ID Caddie" };

// Read-only Reports view = simple "visible to you" summary counts from existing RLS-backed read surfaces.
// It invents NO report capability: every number is an RLS-scoped count of rows the signed-in user may
// already read. No generation workflow, no export/download, no scheduling, no AI, no connector data.
function Stat({ label, value }: { label: string; value: number | null }) {
  return (
    <div className="rounded border border-zinc-200 p-3 dark:border-zinc-800">
      <div className="text-xs text-zinc-500">{label}</div>
      <div className="text-lg font-semibold tabular-nums">{value ?? "—"}</div>
    </div>
  );
}

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

      <section className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <Stat label="Apps visible" value={s.appsVisible} />
        <Stat label="Contracts visible" value={s.contractsVisible} />
        <Stat label="App-user accounts visible" value={s.accountsVisible} />
        <Stat label="Accounts matched" value={s.accountsMatched} />
        <Stat label="Accounts unmatched" value={s.accountsUnmatched} />
        <Stat label="Files visible" value={s.filesVisible} />
      </section>
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
