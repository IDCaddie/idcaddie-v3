import Link from "next/link";
import { getDashboardSummaryForCurrentUser } from "@/lib/data/dashboard";

export const metadata = { title: "Dashboards · ID Caddie" };

// Read-only Dashboards view. It renders only what the server DAL returns (which composes the existing
// RLS-scoped reports + audit-count helpers); RLS is the authorization boundary. Every number is a
// "visible to you" count, not an absolute total. It links ONLY to implemented read-only pages. No
// report builder, no charts, no connector/spend/license analytics, no AI insights, no exports.
function StatCard({
  label,
  value,
  href,
  sub,
}: {
  label: string;
  value: number | null;
  href: string;
  sub?: string;
}) {
  return (
    <Link
      href={href}
      className="rounded border border-zinc-200 p-4 transition hover:border-zinc-400 dark:border-zinc-800 dark:hover:border-zinc-600"
    >
      <div className="text-xs text-zinc-500">{label}</div>
      <div className="text-2xl font-semibold tabular-nums">{value ?? "—"}</div>
      {sub ? <div className="mt-1 text-xs text-zinc-500">{sub}</div> : null}
      <div className="mt-2 text-xs text-zinc-500 underline">Open →</div>
    </Link>
  );
}

const NOT_BUILT = [
  "Custom dashboard builder",
  "Charts / visualizations",
  "Connector-driven spend / license dashboards",
  "AI dashboard insights",
  "Dashboard export",
  "Scheduled dashboard delivery",
];

export default async function DashboardsPage() {
  const s = await getDashboardSummaryForCurrentUser();

  const matchSub =
    s.accountsMatched != null && s.accountsUnmatched != null
      ? `${s.accountsMatched} matched · ${s.accountsUnmatched} unmatched`
      : undefined;

  return (
    <main className="flex flex-1 flex-col gap-6 p-8">
      <header className="space-y-1">
        <h1 className="text-xl font-semibold">Dashboards</h1>
        <p className="text-sm text-zinc-600 dark:text-zinc-400">
          Read-only summary of what is <strong>visible to you</strong> (RLS-scoped) — not absolute
          tenant-wide totals. A “—” means a count is temporarily unavailable. Each card opens an
          implemented page. There is no report builder, charts, connector/spend analytics, AI, or export
          here.
        </p>
      </header>

      <section className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <StatCard label="Apps visible" value={s.appsVisible} href="/apps" />
        <StatCard label="Contracts visible" value={s.contractsVisible} href="/contracts" />
        <StatCard label="Files visible" value={s.filesVisible} href="/files" />
        <StatCard
          label="App-user accounts visible"
          value={s.accountsVisible}
          href="/people"
          sub={matchSub}
        />
        <StatCard label="Recent audit entries" value={s.recentActivityCount} href="/audit" sub="latest window" />
        <Link
          href="/reports"
          className="flex flex-col justify-center rounded border border-zinc-200 p-4 transition hover:border-zinc-400 dark:border-zinc-800 dark:hover:border-zinc-600"
        >
          <div className="text-xs text-zinc-500">Reports</div>
          <div className="text-sm font-medium">Visible-to-you summary counts</div>
          <div className="mt-2 text-xs text-zinc-500 underline">Open →</div>
        </Link>
      </section>
      <p className="text-xs text-zinc-500">
        Counts reflect only rows your tenant/org access allows (RLS-scoped). Matched/unmatched is the
        identity-account match status only (no person/IdP detail). “Recent audit entries” is a capped,
        RLS-scoped count — no audit detail, actor, or IP is shown here.
      </p>

      <section className="space-y-2 text-sm">
        <h2 className="font-medium">Dashboard capabilities</h2>
        <p className="text-xs text-zinc-500">
          These old-app dashboard capabilities are not implemented in v3 yet — shown so the gap is
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
