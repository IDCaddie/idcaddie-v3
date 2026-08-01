import Link from "next/link";
import { loadAccessOverview } from "@/lib/data/access-loaders";
import { DEMO_MODE } from "@/app/(authenticated)/nav-items";
import { loadConnectorManagement } from "@/lib/data/connector-management";
import { resolveConnectorScope } from "@/lib/data/connector-scope";
import { parseAccessFilters, type SearchParamsInput } from "@/lib/data/access-filters";
import { attentionQueue, healthRollup, posture, riskBreakdown } from "@/lib/data/executive-home";
import { AccessPosture, AttentionPanel, HealthPanel, Metric, RiskPanel, Section } from "./executive-panels";
import { CapabilityMatrix } from "./capability-panel";
import { resolveAll, type ConnectorFacts } from "@/lib/canonical/capabilities";
import { getDashboardSummaryForCurrentUser } from "@/lib/data/dashboard";
import { accessGate, getSaasCounts } from "@/lib/data/saas-accounts";
import {
  getDashboardOverviewForCurrentUser,
  type DashboardOverview,
} from "@/lib/data/dashboard-overview-loader";
import { StatCard, StatGrid } from "@/components/stat-card";
import {
  buildSpendBarSegments,
  buildRenewalSegmentSummary,
  buildUpcomingRenewalRows,
} from "@/lib/data/dashboard-charts";
import { SpendBars, RenewalSegmentBar, UpcomingRenewalRows } from "@/components/simple-bars";

export const metadata = { title: "Dashboards · ID Caddie" };

// Read-only Dashboards view. It renders only what the server DALs return (RLS-scoped reports + audit
// counts, plus a contract spend/renewal overview from existing `contracts` fields); RLS is the
// authorization boundary. Every number is "visible to you", not an absolute total. Spend/renewals use
// ONLY contract data (total_cost / currency / renewal_date / end_date / notice_deadline) — NO
// invoices/license tables (default-deny), no connectors, no AI, no exports. Visuals are dependency-free
// Tailwind/div bars over the already-fetched overview (no chart library).
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
          <SpendBars segments={buildSpendBarSegments(spend)} />
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
          <RenewalSegmentBar summary={buildRenewalSegmentSummary(r)} />
          <UpcomingRenewalRows rows={buildUpcomingRenewalRows(r.topUpcoming)} />
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
  "Connector-driven spend / license dashboards",
  "AI dashboard insights",
  "Dashboard export",
  "Scheduled dashboard delivery",
];

export default async function DashboardsPage({ searchParams }: { searchParams?: Promise<SearchParamsInput> } = {}) {
  const sp = searchParams ? await searchParams : {};
  const filters = parseAccessFilters(sp);

  // FOUR reads, all in parallel, and no more. loadAccessOverview already pays for a counts RPC plus six bounded sweeps AND
  // already returns the complete findings list — so the risk panel and the attention queue are projections of a result Home was
  // fetching anyway, not new work. A findings-summary RPC would have bought nothing and cost a round trip.
  //
  // Each read fails independently: one unavailable widget must not blank the page, so every result is narrowed and rendered on
  // its own. What must never happen is a failure rendering as healthy or as zero.
  const [scopeR, overviewR, s, saas] = await Promise.all([
    resolveConnectorScope(filters.connectionId).catch(() => null),
    loadAccessOverview(filters.includeStale, filters.connectionId).then((r) => r).catch(() => ({ ok: false as const, error: "query_failed" as const })),
    getDashboardSummaryForCurrentUser(),
    getDashboardOverviewForCurrentUser(),
  ]);
  const inventoryR = await loadConnectorManagement().catch(() => null);

  // The SaaS section is unchanged from the previous Home and reads its own loaders.
  const overview = saas;
  const matchSub =
    s.accountsMatched != null && s.accountsUnmatched != null
      ? `${s.accountsMatched} matched · ${s.accountsUnmatched} unmatched`
      : undefined;

  const scope = scopeR?.ok ? scopeR.scope : null;
  const selected = scope?.selected ?? null;
  const scopeQuery = selected ? `?connection=${selected.id}` : "";

  const allConnectors = inventoryR?.ok ? inventoryR.data.connectors : [];
  const activeConnectors = allConnectors.filter((c) => c.active);

  // Onboarding is shown only when we KNOW there is no directory — which the cheap scope read can answer on its own. If the
  // inventory read failed we know nothing about the estate, and "No directory connected" would be a false claim about a
  // workspace that may have several. In that case the posture renders and only the health panel reports itself unavailable.
  const noDirectory = scope !== null && scope.active.length === 0;

  // In a scoped view the health panel describes ONE directory; unscoped it describes every active one, and must not flatten them.
  const shown = selected ? activeConnectors.filter((c) => c.id === selected.id) : activeConnectors;
  const rollup = healthRollup(shown);

  // Phase 7B — resolve what each SOURCE can tell this workspace, from facts already loaded. This is what stops an unbuilt or
  // unconnected capability rendering as a zero: the panel below reports a state and a sentence, never a number it cannot support.
  // `hasCurrentData` must reflect EVERY kind of evidence a connector produces, not just the directory kind. The connector
  // inventory counts identity/directory rows only, so a Slack connector holding real application accounts scored zero here
  // and Home told the customer application accounts had "not been discovered yet" for the connector that had just
  // discovered them. The SaaS counts are read per connector and folded in.
  //
  // Home is visible to every role and the SaaS counts are owner/admin-only, so a viewer gets the directory-only answer —
  // exactly what they saw before, never an error and never a claim the read did not support.
  const saasGate = await accessGate().catch(() => ({ ok: false as const }));
  const saasByConnector = new Map<string, { current: number; stale: number }>();
  if (saasGate.ok) {
    await Promise.all(shown.map(async (c) => {
      const r = await getSaasCounts(saasGate.tenantId, c.id).catch(() => null);
      if (r?.ok) saasByConnector.set(c.id, {
        current: r.data.accounts.current + r.data.groups.current,
        stale: r.data.accounts.stale + r.data.groups.stale,
      });
    }));
  }

  const facts: readonly ConnectorFacts[] = shown.map((c) => {
    const saasCounts = saasByConnector.get(c.id) ?? { current: 0, stale: 0 };
    return {
      id: c.id, provider: c.provider, active: c.active, lifecycle: c.lifecycle,
      healthState: c.health.state, lastDiscoveryAt: c.lastDiscoveryAt,
      hasCurrentData: c.counts.people + c.counts.groups + c.counts.applications + saasCounts.current > 0,
      hasStaleData: saasCounts.stale > 0,
    };
  });
  const capabilities = resolveAll(facts, inventoryR !== null && !inventoryR.ok);

  const p = posture(overviewR);
  const complete = overviewR.ok && overviewR.data.status === "complete" ? overviewR.data : null;
  const findings = complete?.findings ?? [];
  const risk = riskBreakdown(complete?.summary ?? { total: 0, bySeverity: { high: 0, medium: 0, low: 0, info: 0 } }, findings);
  const attention = attentionQueue(findings, shown);

  const c = p.status === "unavailable" ? null : p.counts;
  const lastDiscovery = shown.map((x) => x.lastDiscoveryAt).filter(Boolean).sort().at(-1) ?? null;

  return (
    <main className="flex flex-1 flex-col gap-8 p-8">
      {/* ── Context header ──────────────────────────────────────────────────────────────────────────────────── */}
      <header className="space-y-2">
        <div className="flex flex-wrap items-baseline justify-between gap-3">
          <div>
            <h1 className="text-xl font-semibold">Home</h1>
            <p className="text-sm text-zinc-600 dark:text-zinc-400">Identity first. SaaS intelligence. Business impact.</p>
          </div>
          {rollup && (
            <div className="text-right text-xs text-zinc-500">
              {/* The selector itself lives in the global shell — this states the scope rather than duplicating the control. */}
              <div className="font-medium text-zinc-700 dark:text-zinc-300">
                {selected ? selected.label : `All active directories (${activeConnectors.length})`}
              </div>
              <div>{rollup.label}{lastDiscovery ? ` · last discovery ${new Date(lastDiscovery).toISOString().slice(0, 10)}` : " · no discovery yet"}</div>
              {shown.length === 1 && <Link href={`/connectors/manage/${shown[0].id}`} className="underline">View connector</Link>}
            </div>
          )}
        </div>
      </header>

      {noDirectory ? (
        // No directory: onboarding, never a wall of zeros. Zeros here read as "the product found nothing", which is a different
        // and much worse claim than "nothing is connected yet".
        <div role="status" className="max-w-2xl rounded border border-zinc-300 p-4 text-sm dark:border-zinc-700">
          <div className="font-medium">No directory connected</div>
          <p className="mt-1 text-zinc-600 dark:text-zinc-400">
            Connect an identity provider to see who exists, what they can reach, and what needs attention.{" "}
            <Link href="/connectors" className="underline">Connect a directory</Link>.
          </p>
        </div>
      ) : (
        <>
          {/* ── Identity summary. CURRENT counts only — totalEvidence is a safety bound, never an active number. ─── */}
          <Section id="summary-heading" title="Identity summary" action={{ label: "Open Access", href: `/access${scopeQuery}` }}>
            {c === null ? (
              <p className="text-sm text-zinc-600 dark:text-zinc-400">
                {p.status === "unavailable" && p.reason === "forbidden"
                  ? "You don’t have access to identity data."
                  : "Identity counts could not be loaded. This is not a statement that none exist."}
              </p>
            ) : (
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
                <Metric label="People" value={c.identities} href={`/directory/people${scopeQuery}`} />
                <Metric label="Groups" value={c.groups} href={`/directory/groups${scopeQuery}`} />
                <Metric label="Directory applications" value={c.applications} href={`/directory/applications${scopeQuery}`} />
                {p.status === "complete" ? (
                  <>
                    <Metric label="Effective access" value={p.effective} href={`/access${scopeQuery}`} />
                    <Metric label="Through group only" value={p.groupOnly} href={`/access${scopeQuery}`} />
                    <Metric label="High findings" value={risk.high} href={`/access/findings?severity=high`} tone="danger" />
                  </>
                ) : (
                  <>
                    <Metric label="Group memberships" value={c.memberships} />
                    <Metric label="Direct assignments" value={c.directAssignments} />
                    {/* No findings metric while the graph is unevaluated: 0 would be a false all-clear. */}
                    <Metric label="Findings" value="—" sub="not evaluated" />
                  </>
                )}
              </div>
            )}
          </Section>

          {/* ── Three-column insight layout on large screens ───────────────────────────────────────────────────── */}
          <div className="grid grid-cols-1 gap-8 lg:grid-cols-3">
            <Section id="posture-heading" title="Access posture">
              <AccessPosture p={p} scopeQuery={scopeQuery} />
            </Section>
            <Section id="risk-heading" title="Risk and findings" action={{ label: "View all", href: "/access/findings" }}>
              {p.status === "complete"
                ? <RiskPanel r={risk} scopeQuery={scopeQuery} />
                : <p className="text-sm text-zinc-600 dark:text-zinc-400">Findings are produced from whole-graph evaluation, which was not performed for this directory.</p>}
            </Section>
            <Section id="health-heading" title="Connector and evidence health" action={{ label: "Directories", href: "/connectors/manage" }}>
              {inventoryR === null || !inventoryR.ok
                ? <p className="text-sm text-zinc-600 dark:text-zinc-400">Connector health could not be loaded. This is not a statement that everything is healthy.</p>
                : <HealthPanel rollup={rollup} connectors={shown} stale={null} />}
            </Section>
          </div>

          {/* ── What each source can tell us. Unsupported is a STATE, never a zero. ────────────────────────────── */}
          <Section id="sources-heading" title="Source capabilities" action={{ label: "Connectors", href: "/connectors" }}>
            <CapabilityMatrix statuses={capabilities} />
          </Section>

          {/* ── Needs attention ─────────────────────────────────────────────────────────────────────────────────── */}
          <Section id="attention-heading" title="Needs attention" action={{ label: "All findings", href: "/access/findings" }}>
            <AttentionPanel rows={attention} />
          </Section>
        </>
      )}

      <section aria-labelledby="saas-heading" className="space-y-3">
        <div className="flex items-baseline justify-between gap-3">
          <h2 id="saas-heading" className="text-sm font-medium">SaaS intelligence</h2>
          <span className="text-xs text-zinc-500 dark:text-zinc-400">Normalized software records — separate from directory applications</span>
        </div>
      <StatGrid>
        <StatCard label="SaaS inventory" value={s.appsVisible} href="/apps" />
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
          <div className="text-sm font-medium">Cleanup queue</div>
          <div className="mt-2 text-xs text-zinc-500 underline">Open →</div>
        </Link>
      </StatGrid>
      </section>
      <p className="text-xs text-zinc-500">
        Counts reflect only what you have access to.
      </p>

      <section className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <SpendCard overview={overview} />
        <RenewalsCard overview={overview} />
      </section>

      {!DEMO_MODE && (
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
      )}
    </main>
  );
}
