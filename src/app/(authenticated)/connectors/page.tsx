import Link from "next/link";
import {
  listConnectorsForCurrentUser,
  connectorStatusLabel,
  runStatusLabel,
  runCountsLabel,
} from "@/lib/data/connectors";
import {
  getLatestSlackSyncRunForCurrentTenant,
  getSlackAppUserPresenceCountsForCurrentTenant,
} from "@/lib/data/manual-sync-runs";
import { Badge } from "@/components/badge";
import { statusColor } from "@/components/status-tokens";
import { slackRunStatusLabel } from "@/lib/data/slack-sync-display";

export const metadata = { title: "Connectors · ID Caddie" };

// Read-only connector metadata view (gated vault PR E, docs/42 §30). It renders only what the
// user-scoped server DAL returns; RLS is the authorization boundary (`connectors`/`connector_runs`
// SELECT = tenant member). It shows ONLY safe Tier-1 metadata (provider, label, status, safe scopes,
// timestamps + the latest run's status/timestamps/safe failure code+label/safe counters). It NEVER
// queries or displays `connector_secrets` — no ciphertext, wrapped keys, key ids, tokens, API keys,
// PATs, webhook secrets, or callback secrets. Connecting, credentials, OAuth, sync, disconnect, and
// real health are NOT built — shown explicitly below so the gap is visible, not hidden.
export default async function ConnectorsPage() {
  const result = await listConnectorsForCurrentUser();
  // Read-only Slack sync status — the latest manual run + active/stale presence counts, RLS-scoped. Safe aggregates only.
  const syncRun = await getLatestSlackSyncRunForCurrentTenant();
  const presence = await getSlackAppUserPresenceCountsForCurrentTenant();

  return (
    <main className="flex flex-1 flex-col gap-6 p-8">
      <header className="space-y-1">
        <div className="text-sm">
          <Link href="/dashboards" className="text-zinc-500 hover:underline">
            ← Back
          </Link>
        </div>
        <h1 className="text-xl font-semibold">Connectors</h1>
        <p className="text-sm text-zinc-600 dark:text-zinc-400">
          Read-only list of the connectors you may see (RLS-scoped). This shows safe metadata only.
          Connecting a provider, storing credentials, and running a sync are not built yet — connector
          credentials cannot be stored or used here.
        </p>
      </header>

      {!result.ok ? (
        <p className="text-sm text-red-600">
          Could not load connectors right now. Please try again later.
        </p>
      ) : result.data.length === 0 ? (
        <div className="rounded border border-zinc-300 p-4 text-sm dark:border-zinc-700">
          <div className="font-medium">No connectors to show</div>
          <p className="mt-1 text-zinc-600 dark:text-zinc-400">
            No connectors are visible to you yet. Connecting a provider is not built yet — see below.
          </p>
        </div>
      ) : (
        <section className="space-y-2 text-sm">
          <div className="text-zinc-500">
            {result.data.length} connector{result.data.length === 1 ? "" : "s"} visible to you
          </div>
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-left">
              <thead>
                <tr className="border-b border-zinc-300 text-zinc-500 dark:border-zinc-700">
                  <th className="py-2 pr-4 font-medium">Provider</th>
                  <th className="py-2 pr-4 font-medium">Label</th>
                  <th className="py-2 pr-4 font-medium">Status</th>
                  <th className="py-2 pr-4 font-medium">Scopes</th>
                  <th className="py-2 pr-4 font-medium">Last run</th>
                  <th className="py-2 pr-4 font-medium">Added</th>
                </tr>
              </thead>
              <tbody>
                {result.data.map((c) => (
                  <tr key={c.id} className="border-b border-zinc-200 align-top dark:border-zinc-800">
                    <td className="py-2 pr-4 font-medium">{c.provider}</td>
                    <td className="py-2 pr-4">{c.displayName ?? <span className="text-zinc-500">—</span>}</td>
                    <td className="py-2 pr-4">
                      <Badge tone={statusColor(c.status)}>{connectorStatusLabel(c.status)}</Badge>
                    </td>
                    <td className="py-2 pr-4 text-zinc-600 dark:text-zinc-400">
                      {c.safeScopes.length > 0 ? c.safeScopes.join(", ") : "—"}
                    </td>
                    <td className="py-2 pr-4 text-zinc-600 dark:text-zinc-400">
                      {c.lastRun ? (
                        <span>
                          <Badge tone={statusColor(c.lastRun.status)}>{runStatusLabel(c.lastRun.status)}</Badge>
                          {c.lastRun.completedAt ? ` · ${c.lastRun.completedAt.slice(0, 10)}` : ""}
                          {runCountsLabel(c.lastRun) ? ` · ${runCountsLabel(c.lastRun)}` : ""}
                          {c.lastRun.failureLabel ? ` · ${c.lastRun.failureLabel}` : ""}
                        </span>
                      ) : (
                        "—"
                      )}
                    </td>
                    <td className="py-2 pr-4 text-zinc-600 dark:text-zinc-400">{c.createdAt.slice(0, 10)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="text-xs text-zinc-500">
            Safe metadata only. No credentials, tokens, API keys, secrets, or encrypted material are
            stored or shown here.
          </p>
        </section>
      )}

      <section className="space-y-3 text-sm">
        <h2 className="font-medium">Slack sync status</h2>
        <p className="text-xs text-zinc-500">
          Read-only status of the last Slack sync for your tenant (RLS-scoped). Safe aggregate counts only — no Slack
          credentials or personal data are shown or stored here. Running a sync is not built here yet.
        </p>

        {/* latest run */}
        {!syncRun.ok ? (
          <p className="text-sm text-red-600">Could not load the last Slack sync right now. Please try again later.</p>
        ) : syncRun.data === null ? (
          <div className="rounded border border-zinc-300 p-4 text-sm dark:border-zinc-700">
            <div className="font-medium">No Slack sync has run yet</div>
            <p className="mt-1 text-zinc-600 dark:text-zinc-400">
              Slack sync status and counts will appear here after the first sync run.
            </p>
          </div>
        ) : (
          <div className="rounded border border-zinc-300 p-4 dark:border-zinc-700">
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone={statusColor(syncRun.data.status)}>{slackRunStatusLabel(syncRun.data.status)}</Badge>
              <span className="text-zinc-500">
                Started {syncRun.data.startedAt.slice(0, 16).replace("T", " ")}
                {syncRun.data.finishedAt ? ` · finished ${syncRun.data.finishedAt.slice(0, 16).replace("T", " ")}` : ""}
              </span>
              {syncRun.data.errorCode ? (
                <span className="text-zinc-500">· {syncRun.data.failedStage ?? "error"}: {syncRun.data.errorCode}</span>
              ) : null}
            </div>
            <dl className="mt-3 grid grid-cols-2 gap-x-6 gap-y-1 text-zinc-600 sm:grid-cols-4 dark:text-zinc-400">
              {[
                ["App users written", syncRun.data.appUsersWritten],
                ["People written", syncRun.data.peopleWritten],
                ["Matches written", syncRun.data.matchesWritten],
                ["Skipped", syncRun.data.skipped],
                ["Marked stale", syncRun.data.appUsersMarkedStale],
              ].map(([label, value]) => (
                <div key={label as string} className="flex justify-between gap-2 border-b border-zinc-100 py-1 dark:border-zinc-800">
                  <dt>{label}</dt>
                  <dd className="font-medium text-zinc-800 dark:text-zinc-200">{value ?? "—"}</dd>
                </div>
              ))}
            </dl>
          </div>
        )}

        {/* presence counts */}
        {presence.ok ? (
          <p className="text-xs text-zinc-500">
            Slack app users: <span className="font-medium text-zinc-700 dark:text-zinc-300">{presence.data.active} active</span>
            {" · "}
            <span className="font-medium text-zinc-700 dark:text-zinc-300">{presence.data.stale} stale</span>
            {" "}(stale = not seen in the most recent successful sync; marked, never deleted).
          </p>
        ) : null}
      </section>

      <section className="space-y-2 text-sm">
        <h2 className="font-medium">Connector actions</h2>
        <p className="text-xs text-zinc-500">
          These connector capabilities are not implemented in v3 yet — shown so the gap is explicit, not
          hidden. This surface is read-only; connector credentials cannot be stored or used.
        </p>
        <ul className="flex flex-wrap gap-2">
          {[
            "Connect a provider",
            "Store credentials",
            "OAuth callback",
            "API key / PAT entry",
            "Run sync",
            "Provider connectors",
            "Disconnect / revoke",
            "Manual run",
            "Scheduled run",
            "Real connector health",
          ].map((label) => (
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
