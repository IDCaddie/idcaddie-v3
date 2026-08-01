import Link from "next/link";
import { Badge } from "@/components/badge";
import { StatCard, StatGrid } from "@/components/stat-card";
import { loadConnectorDetail, loadConnectorManagement } from "@/lib/data/connector-management";
import type { ConnectorHealth } from "@/lib/data/connector-health";
import { DisconnectForm, ReconnectForm, ReplaceForm } from "../connector-actions";

export const metadata = { title: "Directory · ID Caddie" };

// Phase 5 — one directory: status, verification, discovery, history, settings, health.
//
// Everything is read from two RPCs (inventory row + run history). No per-run query, and no write happens on this page except
// through the three explicit operator actions, each of which is a definer RPC that audits itself.

const HEALTH_TONE: Record<ConnectorHealth, "success" | "attention" | "danger" | "neutral"> = {
  healthy: "success", pending: "attention", attention: "attention", failed: "danger", inactive: "neutral",
};
const fmt = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : "—");

export default async function ConnectorDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const [detail, all] = await Promise.all([loadConnectorDetail(id), loadConnectorManagement()]);

  if (!detail.ok) {
    return (
      <main className="flex flex-1 flex-col gap-6 p-8">
        <div className="text-sm"><Link href="/connectors/manage" className="text-zinc-500 hover:underline">← Directories</Link></div>
        <div role="status" className="max-w-2xl rounded border border-zinc-300 p-4 text-sm dark:border-zinc-700">
          <div className="font-medium">{detail.error === "not_found" ? "Not found" : "Could not load"}</div>
          <p className="mt-1 text-zinc-600 dark:text-zinc-400">
            {detail.error === "not_found" ? "This directory doesn’t exist or you don’t have access to it." : "This directory could not be loaded. Please try again later."}
          </p>
        </div>
      </main>
    );
  }

  const { connector: c, runs } = detail.data;
  // Only ACTIVE connectors of the SAME provider can take over — the RPC enforces both, and offering an impossible option would
  // just produce an error the operator cannot act on.
  const candidates = (all.ok ? all.data.connectors : []).filter((x) => x.active && x.id !== c.id && x.provider === c.provider);

  return (
    <main className="flex flex-1 flex-col gap-6 p-8">
      <header className="space-y-2">
        <div className="text-sm"><Link href="/connectors/manage" className="text-zinc-500 hover:underline">← Directories</Link></div>
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-xl font-semibold">{c.name}</h1>
          <Badge tone={c.active ? "neutral" : "attention"}>{c.lifecycleLabel}</Badge>
          <Badge tone={HEALTH_TONE[c.health.state]}>{c.health.label}</Badge>
        </div>
        <p className="max-w-3xl text-sm text-zinc-600 dark:text-zinc-400">{c.health.reason}</p>
        {!c.active && (
          <p className="max-w-3xl text-sm text-amber-700 dark:text-amber-400">
            This directory is excluded from Home, Directory, Access and Findings. Everything it discovered is retained.
            {c.disconnectedReason && <> Reason given: “{c.disconnectedReason}”.</>}
          </p>
        )}
      </header>

      {/* ── Directory contents. Per connector, never summed with another organization's. ─────────────────────────── */}
      <section aria-labelledby="contents-heading" className="space-y-2">
        <h2 id="contents-heading" className="text-sm font-medium">What this directory contains</h2>
        <StatGrid>
          <StatCard label="People" value={c.counts.people} href={c.active ? `/directory/people?connection=${c.id}` : undefined} />
          <StatCard label="Groups" value={c.counts.groups} href={c.active ? `/directory/groups?connection=${c.id}` : undefined} />
          <StatCard label="Applications" value={c.counts.applications} href={c.active ? `/directory/applications?connection=${c.id}` : undefined} />
          <StatCard label="Group memberships" value={c.counts.memberships} />
          <StatCard label="Direct assignments" value={c.counts.userAssignments} />
          <StatCard label="Group assignments" value={c.counts.groupAssignments} />
        </StatGrid>
        <p className="text-xs text-zinc-500">
          Current records only. Counts belong to this directory alone — a workspace with more than one organization keeps them
          separate, because a person in one is not the same person as an account in another.
        </p>
      </section>

      {/* ── Status and settings ──────────────────────────────────────────────────────────────────────────────────── */}
      <section aria-labelledby="status-heading" className="space-y-2">
        <h2 id="status-heading" className="text-sm font-medium">Status</h2>
        <dl className="max-w-2xl divide-y divide-zinc-200 rounded border border-zinc-200 text-sm dark:divide-zinc-800 dark:border-zinc-800">
          <div className="flex items-start justify-between gap-4 px-3 py-2"><dt className="text-zinc-500">Provider</dt><dd className="text-zinc-700 dark:text-zinc-300">{c.provider}</dd></div>
          <div className="flex items-start justify-between gap-4 px-3 py-2"><dt className="text-zinc-500">Organization</dt><dd className="text-zinc-700 dark:text-zinc-300">{c.organization ?? <span className="text-zinc-400">not recorded</span>}</dd></div>
          <div className="flex items-start justify-between gap-4 px-3 py-2"><dt className="text-zinc-500">Lifecycle</dt><dd className="text-zinc-700 dark:text-zinc-300">{c.lifecycleLabel}</dd></div>
          <div className="flex items-start justify-between gap-4 px-3 py-2"><dt className="text-zinc-500">Last verified</dt><dd className="text-zinc-700 dark:text-zinc-300">{fmt(c.lastVerifiedAt)}</dd></div>
          <div className="flex items-start justify-between gap-4 px-3 py-2"><dt className="text-zinc-500">Last discovery</dt><dd className="text-zinc-700 dark:text-zinc-300">{fmt(c.lastDiscoveryAt)}</dd></div>
          <div className="flex items-start justify-between gap-4 px-3 py-2"><dt className="text-zinc-500">Connected</dt><dd className="text-zinc-700 dark:text-zinc-300">{fmt(c.createdAt)}</dd></div>
          <div className="flex items-start justify-between gap-4 px-3 py-2"><dt className="text-zinc-500">Production synchronization</dt><dd className="text-zinc-700 dark:text-zinc-300">Disabled</dd></div>
        </dl>
        {c.provider === "okta" && c.active && (
          <Link href="/connectors/okta/status" className="inline-block text-sm underline">Open verification detail</Link>
        )}
      </section>

      {/* ── Discovery history ────────────────────────────────────────────────────────────────────────────────────── */}
      <section aria-labelledby="history-heading" className="space-y-2">
        <h2 id="history-heading" className="text-sm font-medium">Discovery history</h2>
        {runs.length === 0 ? (
          <p className="text-sm text-zinc-600 dark:text-zinc-400">No discovery run has been recorded for this directory yet.</p>
        ) : (
          <div className="overflow-x-auto text-sm">
            <table className="w-full border-collapse text-left">
              <thead>
                <tr className="border-b border-zinc-300 text-zinc-500 dark:border-zinc-700">
                  <th scope="col" className="py-2 pr-4 font-medium">Started</th>
                  <th scope="col" className="py-2 pr-4 font-medium">Status</th>
                  <th scope="col" className="py-2 pr-4 font-medium">Completeness</th>
                  <th scope="col" className="py-2 pr-4 font-medium text-right">Seen</th>
                  <th scope="col" className="py-2 pr-4 font-medium text-right">Imported</th>
                  <th scope="col" className="py-2 pr-4 font-medium text-right">Failed</th>
                  <th scope="col" className="py-2 pr-4 font-medium">Outcome</th>
                </tr>
              </thead>
              <tbody>
                {runs.map((r) => (
                  <tr key={r.id} className="border-b border-zinc-200 dark:border-zinc-800">
                    <td className="py-2 pr-4 tabular-nums text-zinc-600 dark:text-zinc-400">{fmt(r.started_at)}</td>
                    <td className="py-2 pr-4"><Badge tone={r.status === "succeeded" ? "success" : r.status === "failed" ? "danger" : "neutral"}>{r.status ?? "—"}</Badge></td>
                    {/* A run that did not prove completeness cannot promote anything, so this is the column that explains why a
                        successful-looking run changed nothing. */}
                    <td className="py-2 pr-4">
                      {r.completeness === null ? <span className="text-zinc-400">not recorded</span>
                        : r.completeness ? <Badge tone="success">Complete</Badge> : <Badge tone="attention">Incomplete</Badge>}
                      {r.review_required ? <span className="ml-1"><Badge tone="attention">Review</Badge></span> : null}
                    </td>
                    <td className="py-2 pr-4 text-right tabular-nums text-zinc-600 dark:text-zinc-400">{r.records_seen ?? "—"}</td>
                    <td className="py-2 pr-4 text-right tabular-nums text-zinc-600 dark:text-zinc-400">{r.records_imported ?? "—"}</td>
                    <td className="py-2 pr-4 text-right tabular-nums text-zinc-600 dark:text-zinc-400">{r.records_failed ?? "—"}</td>
                    {/* Bounded codes only — never a provider error string. */}
                    <td className="py-2 pr-4 text-zinc-600 dark:text-zinc-400">
                      {r.failure_code ? r.failure_code.replace(/_/g, " ") : r.termination_reason ? r.termination_reason.replace(/_/g, " ") : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="text-xs text-zinc-500">Discovery runs are retained permanently, including for disconnected and replaced directories.</p>
      </section>

      {/* ── Operator actions ─────────────────────────────────────────────────────────────────────────────────────── */}
      <section aria-labelledby="manage-heading" className="max-w-2xl space-y-3 border-t border-zinc-200 pt-4 dark:border-zinc-800">
        <h2 id="manage-heading" className="text-sm font-medium">Manage</h2>
        {c.supersededBy ? (
          <div className="rounded border border-zinc-200 p-4 text-sm dark:border-zinc-800">
            <h3 className="font-medium">Replaced</h3>
            <p className="mt-1 text-zinc-600 dark:text-zinc-400">
              Another directory took over this organization, so this one is excluded from active views. Its records, discovery runs
              and audit history are retained.{" "}
              <Link href={`/connectors/manage/${c.supersededBy}`} className="underline">Open the replacement</Link>.
            </p>
          </div>
        ) : c.active ? (
          <>
            <DisconnectForm connector={c} />
            <ReplaceForm connector={c} candidates={candidates} />
          </>
        ) : (
          <ReconnectForm connector={c} />
        )}
      </section>
    </main>
  );
}
