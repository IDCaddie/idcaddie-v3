import Link from "next/link";
import { Badge } from "@/components/badge";
import { loadConnectorManagement, type ConnectorSummary } from "@/lib/data/connector-management";
import { connectorActions, type ConnectorHealth } from "@/lib/data/connector-health";
import { RowLifecycleActions } from "./connector-actions";

export const metadata = { title: "Directories · ID Caddie" };

// Phase 5 — Connector Management. Every directory in the workspace, active and retired, with the evidence behind each.
//
// This is the ONE surface that shows inactive connectors. Everywhere else they are excluded; here, hiding them would make
// disconnect and replace look like deletion, which is exactly the misunderstanding this page has to prevent.
//
// Counts are per directory and are never summed. Two Okta organizations are two directories: adding their headcounts would
// produce a number that is true of nothing.

const HEALTH_TONE: Record<ConnectorHealth, "success" | "attention" | "danger" | "neutral"> = {
  healthy: "success", pending: "attention", attention: "attention", failed: "danger", inactive: "neutral",
};

const fmtDate = (iso: string | null) => (iso ? new Date(iso).toISOString().slice(0, 10) : "—");

function Row({ c }: { c: ConnectorSummary }) {
  const { kinds, nextStep } = connectorActions(c);
  return (
    <tr className={`border-b border-zinc-200 dark:border-zinc-800 ${c.active ? "" : "opacity-70"}`}>
      <td className="py-2 pr-4">
        <Link href={`/connectors/manage/${c.id}`} className="font-medium underline-offset-2 hover:underline">{c.name}</Link>
        {c.organization && c.organization !== c.name && <div className="text-xs text-zinc-500">{c.organization}</div>}
        {/* The truthful next step, on the row, so an operator does not have to open a connector to learn it is waiting on them. */}
        <div className="text-xs text-zinc-500">{nextStep}</div>
      </td>
      <td className="py-2 pr-4 text-zinc-600 dark:text-zinc-400">{c.provider}</td>
      <td className="py-2 pr-4"><Badge tone={c.active ? "neutral" : "attention"}>{c.lifecycleLabel}</Badge></td>
      <td className="py-2 pr-4"><span title={c.health.reason}><Badge tone={HEALTH_TONE[c.health.state]}>{c.health.label}</Badge></span></td>
      <td className="py-2 pr-4 tabular-nums text-zinc-600 dark:text-zinc-400">{fmtDate(c.lastVerifiedAt)}</td>
      <td className="py-2 pr-4 tabular-nums text-zinc-600 dark:text-zinc-400">{fmtDate(c.lastDiscoveryAt)}</td>
      {/* Counts stay per directory. A workspace total would merge organizations that are deliberately kept apart. */}
      <td className="py-2 pr-4 text-right tabular-nums">{c.counts.people}</td>
      <td className="py-2 pr-4 text-right tabular-nums">{c.counts.groups}</td>
      <td className="py-2 pr-4 text-right tabular-nums">{c.counts.applications}</td>
      {/* Actions come from the persisted lifecycle, never from the row merely existing. "View access" in particular is offered
          only once discovery has produced records — otherwise it is a link to an empty page that reads as a broken product. */}
      <td className="py-2 pr-4 text-right">
        <div className="flex flex-wrap items-center justify-end gap-2 text-xs">
          <Link href={`/connectors/manage/${c.id}`} className="underline">Open</Link>
          {kinds.includes("directory") && <Link href={`/directory/people?connection=${c.id}`} className="underline">Directory</Link>}
          {kinds.includes("access") && <Link href={`/access?connection=${c.id}`} className="underline">Access</Link>}
          {kinds.includes("setup") && <Link href={`/connectors/${c.provider}`} className="underline">Setup</Link>}
          {kinds.includes("replacement") && c.supersededBy && <Link href={`/connectors/manage/${c.supersededBy}`} className="underline">Replacement</Link>}
          <RowLifecycleActions connector={c} kinds={kinds} />
        </div>
      </td>
    </tr>
  );
}

export default async function ConnectorManagePage() {
  const r = await loadConnectorManagement();

  if (!r.ok) {
    return (
      <main className="flex flex-1 flex-col gap-6 p-8">
        <h1 className="text-xl font-semibold">Directories</h1>
        <div role="status" className="max-w-2xl rounded border border-zinc-300 p-4 text-sm dark:border-zinc-700">
          <div className="font-medium">{r.error === "forbidden" ? "Not available" : "Could not load"}</div>
          <p className="mt-1 text-zinc-600 dark:text-zinc-400">
            {r.error === "forbidden" ? "You don’t have access to this area." : "Directories could not be loaded. Please try again later."}
          </p>
        </div>
      </main>
    );
  }

  const { connectors, activeCount, inactiveCount } = r.data;
  const active = connectors.filter((c) => c.active);
  const retired = connectors.filter((c) => !c.active);

  return (
    <main className="flex flex-1 flex-col gap-6 p-8">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <h1 className="text-xl font-semibold">Directories</h1>
          <p className="max-w-3xl text-sm text-zinc-600 dark:text-zinc-400">
            Every identity directory connected to this workspace. Each one owns its own people, groups and applications — separate
            organizations are never merged, so counts are shown per directory.
          </p>
        </div>
        <Link href="/connectors" className="rounded-md bg-zinc-900 px-3 py-2 text-sm font-medium text-white hover:bg-zinc-800 dark:bg-white dark:text-zinc-900 dark:hover:bg-zinc-200">
          Add a directory
        </Link>
      </header>

      {connectors.length === 0 ? (
        <div role="status" className="max-w-2xl rounded border border-zinc-300 p-4 text-sm dark:border-zinc-700">
          <div className="font-medium">No directories connected</div>
          <p className="mt-1 text-zinc-600 dark:text-zinc-400">
            Connect an identity provider to discover people, groups and the applications they can reach.{" "}
            <Link href="/connectors" className="underline">Add a directory</Link>.
          </p>
        </div>
      ) : (
        <>
          <section aria-labelledby="active-heading" className="space-y-2">
            <h2 id="active-heading" className="text-sm font-medium">Active ({activeCount})</h2>
            {active.length === 0 ? (
              <p className="text-sm text-zinc-600 dark:text-zinc-400">
                No active directory. Every connector in this workspace has been disconnected or replaced, so identity surfaces are empty.
              </p>
            ) : (
              <div className="overflow-x-auto text-sm">
                <table className="w-full border-collapse text-left">
                  <thead>
                    <tr className="border-b border-zinc-300 text-zinc-500 dark:border-zinc-700">
                      <th scope="col" className="py-2 pr-4 font-medium">Directory</th>
                      <th scope="col" className="py-2 pr-4 font-medium">Provider</th>
                      <th scope="col" className="py-2 pr-4 font-medium">Lifecycle</th>
                      <th scope="col" className="py-2 pr-4 font-medium">Health</th>
                      <th scope="col" className="py-2 pr-4 font-medium">Verified</th>
                      <th scope="col" className="py-2 pr-4 font-medium">Discovered</th>
                      <th scope="col" className="py-2 pr-4 font-medium text-right">People</th>
                      <th scope="col" className="py-2 pr-4 font-medium text-right">Groups</th>
                      <th scope="col" className="py-2 pr-4 font-medium text-right">Apps</th>
                      <th scope="col" className="py-2 pr-4 font-medium text-right"></th>
                    </tr>
                  </thead>
                  <tbody>{active.map((c) => <Row key={c.id} c={c} />)}</tbody>
                </table>
              </div>
            )}
          </section>

          {retired.length > 0 && (
            <section aria-labelledby="retired-heading" className="space-y-2">
              <h2 id="retired-heading" className="text-sm font-medium">Retired ({inactiveCount})</h2>
              <p className="max-w-3xl text-sm text-zinc-600 dark:text-zinc-400">
                Disconnected or replaced. Their people, groups, applications, discovery runs and audit history are all retained —
                they are excluded from active views, not deleted. A disconnected directory can be reconnected at any time.
              </p>
              <div className="overflow-x-auto text-sm">
                <table className="w-full border-collapse text-left">
                  <thead>
                    <tr className="border-b border-zinc-300 text-zinc-500 dark:border-zinc-700">
                      <th scope="col" className="py-2 pr-4 font-medium">Directory</th>
                      <th scope="col" className="py-2 pr-4 font-medium">Provider</th>
                      <th scope="col" className="py-2 pr-4 font-medium">Lifecycle</th>
                      <th scope="col" className="py-2 pr-4 font-medium">Health</th>
                      <th scope="col" className="py-2 pr-4 font-medium">Verified</th>
                      <th scope="col" className="py-2 pr-4 font-medium">Discovered</th>
                      <th scope="col" className="py-2 pr-4 font-medium text-right">People</th>
                      <th scope="col" className="py-2 pr-4 font-medium text-right">Groups</th>
                      <th scope="col" className="py-2 pr-4 font-medium text-right">Apps</th>
                      <th scope="col" className="py-2 pr-4 font-medium text-right"></th>
                    </tr>
                  </thead>
                  <tbody>{retired.map((c) => <Row key={c.id} c={c} />)}</tbody>
                </table>
              </div>
            </section>
          )}
        </>
      )}
    </main>
  );
}
