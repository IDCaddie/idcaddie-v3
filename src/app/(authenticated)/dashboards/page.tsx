import Link from "next/link";
import { getDashboardSummaryForCurrentUser } from "@/lib/data/dashboard";
import {
  getDashboardOverviewForCurrentUser,
  formatMoney,
  type DashboardOverview,
} from "@/lib/data/dashboard-overview-loader";

export const metadata = { title: "Dashboards · ID Caddie" };

// Read-only Dashboards view. It renders only what the server DALs return (RLS-scoped reports + audit
// counts, plus a contract spend/renewal overview from existing `contracts` fields); RLS is the
// authorization boundary. Every number is "visible to you", not an absolute total. Spend/renewals use
// ONLY contract data (total_cost / currency / renewal_date / end_date / notice_deadline) — NO
// invoices/license tables (default-deny), no connectors, no charts, no AI, no exports.
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

function SpendCard({ overview }: { overview: DashboardOverview }) {
  const spend = overview.spend;
  return (
    <section className="space-y-2 rounded border border-zinc-200 p-4 dark:border-zinc-800">
      <h2 className="font-medium">Tracked contract spend</h2>
      {spend == null ? (
        <p className="text-sm text-zinc-500">Temporarily unavailable — try again later.</p>
      ) : spend.byCurrency.length === 0 ? (
        <p className="text-sm text-zinc-500">No tracked contract spend yet.</p>
      ) : (
        <>
          <ul className="space-y-1 text-sm">
            {spend.byCurrency.map((c) => (
              <li key={c.currency} className="tabular-nums">
                <span className="font-semibold">{formatMoney(c.total, c.currency)}</span>{" "}
                <span className="text-zinc-500">
                  · {c.contractCount} contract{c.contractCount === 1 ? "" : "s"}
                </span>
              </li>
            ))}
          </ul>
          <p className="text-xs text-zinc-500">
            Total contract value visible to you, grouped by currency ({spend.contractsWithCost} contract
            {spend.contractsWithCost === 1 ? "" : "s"} with a recorded cost). Contract totals only — no
            invoice/actual-spend data.
          </p>
        </>
      )}
    </section>
  );
}

function RenewalsCard({ overview }: { overview: DashboardOverview }) {
  const r = overview.renewals;
  return (
    <section className="space-y-2 rounded border border-zinc-200 p-4 dark:border-zinc-800">
      <h2 className="font-medium">Upcoming renewals</h2>
      {r == null ? (
        <p className="text-sm text-zinc-500">Temporarily unavailable — try again later.</p>
      ) : (
        <>
          <div className="flex flex-wrap gap-2 text-xs">
            <span className="rounded-full border border-amber-500 px-2 py-0.5 text-amber-700 dark:text-amber-400">
              {r.due30.length} due in 30 days
            </span>
            <span className="rounded-full border border-zinc-400 px-2 py-0.5 text-zinc-500">
              {r.due90.length} in 90 days
            </span>
            {r.missing > 0 ? (
              <Link
                href="/needs-attention"
                className="rounded-full border border-zinc-400 px-2 py-0.5 text-zinc-500 hover:border-zinc-600"
              >
                {r.missing} missing a renewal date →
              </Link>
            ) : null}
          </div>
          {r.topUpcoming.length === 0 ? (
            <p className="text-sm text-zinc-500">No upcoming renewals.</p>
          ) : (
            <ul className="space-y-1 text-sm">
              {r.topUpcoming.map((it) => (
                <li key={it.id}>
                  <Link href={`/contracts/${it.id}`} className="underline">
                    {it.contractName}
                  </Link>{" "}
                  <span className="text-zinc-500">
                    — {it.date} ({it.daysUntil === 0 ? "today" : `in ${it.daysUntil}d`}
                    {it.basis === "end" ? ", end date" : ""}
                    {it.noticeDeadline ? `, notice by ${it.noticeDeadline}` : ""})
                  </span>
                </li>
              ))}
            </ul>
          )}
          <p className="text-xs text-zinc-500">
            Soonest renewals visible to you, by renewal date (or end date). The full missing-renewal list is on
            Needs Attention.
          </p>
        </>
      )}
    </section>
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
  const [s, overview] = await Promise.all([
    getDashboardSummaryForCurrentUser(),
    getDashboardOverviewForCurrentUser(),
  ]);

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
        <Link
          href="/needs-attention"
          className="flex flex-col justify-center rounded border border-zinc-200 p-4 transition hover:border-zinc-400 dark:border-zinc-800 dark:hover:border-zinc-600"
        >
          <div className="text-xs text-zinc-500">Needs Attention</div>
          <div className="text-sm font-medium">Cleanup queue (RLS-scoped)</div>
          <div className="mt-2 text-xs text-zinc-500 underline">Open →</div>
        </Link>
      </section>
      <p className="text-xs text-zinc-500">
        Counts reflect only rows your tenant/org access allows (RLS-scoped). Matched/unmatched is the
        identity-account match status only (no person/IdP detail). “Recent audit entries” is a capped,
        RLS-scoped count — no audit detail, actor, or IP is shown here.
      </p>

      <section className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <SpendCard overview={overview} />
        <RenewalsCard overview={overview} />
      </section>

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
