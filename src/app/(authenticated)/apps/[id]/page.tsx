import Link from "next/link";
import { getAppDetailForCurrentUser } from "@/lib/data/apps";
import { DEMO_MODE } from "@/app/(authenticated)/nav-items";
import { listContractsLinkedToApp } from "@/lib/data/links";
import { listAppUsersForApp } from "@/lib/data/app-users";
import { listMatchesForAppUsers } from "@/lib/data/app-user-matches";
import {
  summarizeAccountIntelligence,
  STALE_CANDIDATE_DAYS,
} from "@/lib/data/app-account-intelligence";
import { classifySlackSync, SLACK_SYNC_COPY } from "@/lib/data/slack-sync-display";
import { getLatestSlackSyncRunForCurrentTenant } from "@/lib/data/manual-sync-runs";
import { appAttentionFlags } from "@/lib/data/apps-inventory";
import { getCatalogMappingForApp } from "@/lib/data/catalog";
import { listOrganizationsForCurrentUser } from "@/lib/data/organizations";
import { buildOrgNameLookup, orgDisplayName } from "@/lib/data/organization-display";
import { matchRateSummary, statusDistributionSegments } from "@/lib/data/account-match-summary";
import { MatchRateMeter, StatusDistributionBar } from "@/components/match-rate-meter";

export const metadata = { title: "App · ID Caddie" };

// Read-only app detail (build-sequence Stage 4b). The [id] route param is ONLY a lookup key —
// RLS decides whether the signed-in user may read the row, so an id for another tenant's app
// returns the same "not found" as a non-existent id (no enumeration). Linked contracts are
// read-only via RLS-backed app_contracts (org-scoped read, 0006 / PR #20); the app-user roster is
// read-only via RLS-backed app_users (org-scoped read, 0007 / PR #21), with a minimal matched/
// unmatched status from RLS-backed app_user_identity_matches (org-scoped read, 0008 / PR #23) —
// status only, NO person/identity PII. No create/edit/delete, no provisioning, no identity matching
// algorithm, no merge, no invoices/files/license. No client filtering. Server-rendered.
function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-zinc-500">{label}</div>
      <div className="font-medium">{value}</div>
    </div>
  );
}

export default async function AppDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const result = await getAppDetailForCurrentUser(id);
  const linkedContracts = result.ok ? await listContractsLinkedToApp(id) : null;
  const appUsers = result.ok ? await listAppUsersForApp(id) : null;
  const catalogMapping = result.ok ? await getCatalogMappingForApp(id) : null;
  // RLS-visible organizations (id+name only) → id-to-name lookup for safe org display (never a raw UUID).
  const orgs = result.ok ? await listOrganizationsForCurrentUser() : null;
  const orgLookup = buildOrgNameLookup(orgs && orgs.ok ? orgs.data : []);
  // Minimal matched/unmatched status, derived server-side from RLS-scoped match rows for THIS roster's
  // app_users. Empty/failed map ⇒ status shown as "—" (unknown), never a misleading "unmatched".
  const matches =
    appUsers && appUsers.ok
      ? await listMatchesForAppUsers(appUsers.data.map((u) => u.id))
      : null;
  const matchesOk = !!matches?.ok;
  const matchByUser = new Map(
    (matches && matches.ok ? matches.data : []).map((m) => [m.appUserId, m]),
  );
  // Read-only account intelligence summary, computed PURELY from the already-fetched, RLS-scoped roster
  // + match rows (no people / identity_accounts / license / PII). Only shown when both reads succeeded.
  const summary =
    appUsers && appUsers.ok && matchesOk && matches && matches.ok
      ? summarizeAccountIntelligence(appUsers.data, matches.data)
      : null;
  // Read-only Slack-sync classification from the app's non-secret connector markers (external_instance_id + vendor).
  const slackSync = classifySlackSync(result.ok ? result.data : null);
  // Latest manual-sync run status (RLS-scoped, safe aggregates) — only for a Slack-synced app.
  const slackRun = slackSync.isSlackSynced ? await getLatestSlackSyncRunForCurrentTenant() : null;

  // Read-only attention flags from already-fetched, RLS-scoped data (booleans only — never raw ids/PII).
  const hasOwner = result.ok ? result.data.hasBusinessOwner || result.data.hasTechnicalOwner : false;
  const hasLinkedContract = linkedContracts && linkedContracts.ok ? linkedContracts.data.length > 0 : null;
  const hasDiscoveredAccounts = appUsers && appUsers.ok ? appUsers.data.length > 0 : null;
  const attentionFlags = result.ok
    ? appAttentionFlags({ hasOwner, hasLinkedContract, hasDiscoveredAccounts })
    : [];

  return (
    <main className="flex flex-1 flex-col gap-6 p-8">
      <div className="text-sm">
        <Link href="/apps" className="text-zinc-500 hover:underline">
          ← Back to apps
        </Link>
      </div>

      {!result.ok && result.error === "query_failed" ? (
        <p className="text-sm text-red-600">
          Could not load this app right now. Please try again later.
        </p>
      ) : !result.ok ? (
        <div className="rounded border border-zinc-300 p-4 text-sm dark:border-zinc-700">
          <div className="font-medium">App not found</div>
          <p className="mt-1 text-zinc-600 dark:text-zinc-400">
            This app doesn’t exist or you don’t have access to it.
          </p>
        </div>
      ) : (
        <>
          <header className="space-y-1">
            <h1 className="text-xl font-semibold">{result.data.name}</h1>
            <p className="text-sm text-zinc-600 dark:text-zinc-400">
              Application detail.
            </p>
            {slackSync.isSlackSynced ? (
              <div className="mt-2 inline-flex flex-wrap items-center gap-2 rounded border border-violet-300 bg-violet-50 px-3 py-2 text-xs text-violet-900 dark:border-violet-800 dark:bg-violet-950 dark:text-violet-200">
                <span className="rounded-full bg-violet-200 px-2 py-0.5 font-medium dark:bg-violet-900">
                  {SLACK_SYNC_COPY.badge}
                </span>
                <span>{SLACK_SYNC_COPY.description}</span>
                {slackSync.workspaceId ? (
                  <span className="text-violet-500">workspace {slackSync.workspaceId}</span>
                ) : null}
              </div>
            ) : null}
          </header>

          {attentionFlags.length > 0 ? (
            <section className="space-y-2 text-sm">
              <h2 className="font-medium">Needs attention</h2>
              <ul className="flex flex-wrap gap-2">
                {attentionFlags.map((f) => (
                  <li key={f.key}>
                    <span className="rounded-full border border-amber-500 px-2 py-0.5 text-xs text-amber-700 dark:text-amber-400">
                      {f.label}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          {slackSync.isSlackSynced ? (
            <section className="space-y-2 text-sm">
              <h2 className="font-medium">Last Slack sync</h2>
              <p className="text-xs text-zinc-500">
                Status of the most recent Slack sync for this application. Summary counts
                only — no token, account emails/names, or raw data.
              </p>
              {!slackRun || !slackRun.ok ? (
                <p className="text-zinc-600 dark:text-zinc-400">Could not load sync status right now.</p>
              ) : slackRun.data === null ? (
                <p className="text-zinc-600 dark:text-zinc-400">
                  No sync runs yet. {SLACK_SYNC_COPY.comingNext}
                </p>
              ) : (
                <div className="space-y-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <span
                      className={
                        slackRun.data.status === "succeeded"
                          ? "rounded-full bg-green-100 px-2 py-0.5 text-xs font-medium text-green-800 dark:bg-green-950 dark:text-green-300"
                          : slackRun.data.status === "failed"
                            ? "rounded-full bg-red-100 px-2 py-0.5 text-xs font-medium text-red-800 dark:bg-red-950 dark:text-red-300"
                            : "rounded-full bg-zinc-100 px-2 py-0.5 text-xs font-medium text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300"
                      }
                    >
                      {slackRun.data.status}
                    </span>
                    <span className="text-zinc-500">
                      {slackRun.data.status === "succeeded" && slackRun.data.finishedAt
                        ? `last successful sync ${slackRun.data.finishedAt.slice(0, 16).replace("T", " ")} UTC`
                        : `started ${slackRun.data.startedAt.slice(0, 16).replace("T", " ")} UTC`}
                    </span>
                    {slackRun.data.status === "failed" && slackRun.data.errorCode ? (
                      <span className="text-red-700 dark:text-red-400">
                        error: {slackRun.data.errorCode}
                        {slackRun.data.failedStage ? ` (${slackRun.data.failedStage})` : ""}
                      </span>
                    ) : null}
                  </div>
                  <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                    <Field label="Users fetched" value={String(slackRun.data.usersFetched ?? "—")} />
                    <Field label="Facts emitted" value={String(slackRun.data.factsEmitted ?? "—")} />
                    <Field label="App users written" value={String(slackRun.data.appUsersWritten ?? "—")} />
                    <Field label="People written" value={String(slackRun.data.peopleWritten ?? "—")} />
                    <Field label="Matches written" value={String(slackRun.data.matchesWritten ?? "—")} />
                    <Field label="Match conflicts" value={String(slackRun.data.matchConflicts ?? "—")} />
                    <Field label="Facts rejected" value={String(slackRun.data.factsRejected ?? "—")} />
                    <Field label="Skipped" value={String(slackRun.data.skipped ?? "—")} />
                  </div>
                </div>
              )}
            </section>
          ) : null}

          <section className="grid grid-cols-1 gap-4 text-sm sm:grid-cols-2">
            <Field label="Vendor" value={result.data.vendorName ?? "—"} />
            <Field label="Category" value={result.data.category ?? "—"} />
            <Field label="Status" value={result.data.status} />
            <Field label="Created" value={result.data.createdAt.slice(0, 10)} />
            <Field label="Updated" value={result.data.updatedAt.slice(0, 10)} />
          </section>

          <section className="space-y-2 text-sm">
            <h2 className="font-medium">Ownership</h2>
            <p className="text-xs text-zinc-500">
              Owners shown as Yes/No (no user ids). Organizations shown by name where visible to you, otherwise
              “Assigned”.
            </p>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
              <Field label="Business owner assigned" value={result.data.hasBusinessOwner ? "Yes" : "No"} />
              <Field label="Technical owner assigned" value={result.data.hasTechnicalOwner ? "Yes" : "No"} />
              <Field label="Owner assigned (any)" value={hasOwner ? "Yes" : "No"} />
              <Field label="Responsible org" value={orgDisplayName(result.data.responsibleOrgId, orgLookup)} />
              <Field label="Paying org" value={orgDisplayName(result.data.payingOrgId, orgLookup)} />
              <Field label="Procurement org" value={orgDisplayName(result.data.procurementOrgId, orgLookup)} />
            </div>
          </section>

          <section className="space-y-2 text-sm">
            <h2 className="font-medium">Catalog mapping</h2>
            {!catalogMapping || !catalogMapping.ok ? (
              <p className="text-zinc-600 dark:text-zinc-400">Could not load catalog mapping.</p>
            ) : !catalogMapping.data.mapped ? (
              <p className="text-zinc-600 dark:text-zinc-400">
                This app is not mapped to the canonical catalog yet.{" "}
                <Link href="/catalog" className="underline">
                  View catalog
                </Link>
              </p>
            ) : (
              <>
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                  <Field label="Canonical product" value={catalogMapping.data.productName} />
                  <Field label="Vendor" value={catalogMapping.data.vendorName ?? "—"} />
                  <Field label="Category" value={catalogMapping.data.category ?? "—"} />
                  <Field label="Aliases" value={String(catalogMapping.data.aliasCount)} />
                </div>
                <p className="text-xs text-zinc-500">
                  <Link href="/catalog" className="underline">
                    Open the App Catalog
                  </Link>
                </p>
              </>
            )}
          </section>

          <section className="space-y-2 text-sm">
            <h2 className="font-medium">Linked contracts</h2>
            <p className="text-xs text-zinc-500">
              Contracts linked to this application. Read-only — no
              linking/unlinking here.
            </p>
            {!linkedContracts || !linkedContracts.ok ? (
              <p className="text-zinc-600 dark:text-zinc-400">
                Could not load linked contracts right now.
              </p>
            ) : linkedContracts.data.length === 0 ? (
              <p className="text-zinc-600 dark:text-zinc-400">
                No linked contracts you can access.
              </p>
            ) : (
              <ul className="list-inside list-disc">
                {linkedContracts.data.map((contract) => (
                  <li key={contract.id}>
                    <Link href={`/contracts/${contract.id}`} className="underline">
                      {contract.contractName}
                    </Link>
                    {contract.vendorName ? (
                      <span className="text-zinc-500"> — {contract.vendorName}</span>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
          </section>

          {summary && summary.totalVisibleAccounts > 0 ? (
            <section className="space-y-2 text-sm">
              <h2 className="font-medium">Account summary</h2>
              <p className="text-xs text-zinc-500">
                Based only on the app roster + visible match status. <strong>This is not UAR.</strong>{" "}
                It does not use people, identity accounts, IdP status, license data, invoices, or files.
              </p>
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                <Field label="Visible accounts" value={String(summary.totalVisibleAccounts)} />
                <Field label="Matched accounts" value={String(summary.matchedAccounts)} />
                <Field label="Unmatched accounts" value={String(summary.unmatchedAccounts)} />
                <Field
                  label="Match rate"
                  value={`${Math.floor(summary.matchRate * 100)}%`}
                />{/* floor, never round up — avoids showing 100% while unmatched > 0 */}
                <Field
                  label="Status: active / inactive / unknown"
                  value={`${summary.activeAccounts} / ${summary.inactiveAccounts} / ${summary.unknownStatusAccounts}`}
                />
                <Field
                  label={`Stale candidates (>${STALE_CANDIDATE_DAYS}d)`}
                  value={String(summary.staleCandidates)}
                />
              </div>
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <MatchRateMeter summary={matchRateSummary(summary.matchedAccounts, summary.unmatchedAccounts)} />
                <StatusDistributionBar
                  label="Account status"
                  {...statusDistributionSegments([
                    { key: "active", label: "Active", count: summary.activeAccounts, tone: "success" },
                    { key: "inactive", label: "Inactive", count: summary.inactiveAccounts, tone: "attention" },
                    { key: "unknown", label: "Unknown", count: summary.unknownStatusAccounts, tone: "neutral" },
                  ])}
                />
              </div>
              <p className="text-xs text-zinc-500">
                &ldquo;Unmatched&rdquo; = no visible match row for a visible account. &ldquo;Stale
                candidate&rdquo; = the account&rsquo;s own last-active date looks older than{" "}
                {STALE_CANDIDATE_DAYS} days — not confirmed stale, orphaned, deactivated, or managed.
              </p>
            </section>
          ) : null}

          <section className="space-y-2 text-sm">
            <h2 className="font-medium">{slackSync.isSlackSynced ? SLACK_SYNC_COPY.usersHeading : "App users"}</h2>
            <p className="text-xs text-zinc-500">
              {slackSync.isSlackSynced ? `${SLACK_SYNC_COPY.preview}. ` : ""}Accounts held in this application.
              The identity column shows whether a match exists, not who it matched.
            </p>
            {!appUsers || !appUsers.ok ? (
              <p className="text-zinc-600 dark:text-zinc-400">
                Could not load app users right now.
              </p>
            ) : appUsers.data.length === 0 ? (
              <p className="text-zinc-600 dark:text-zinc-400">
                {slackSync.isSlackSynced ? SLACK_SYNC_COPY.emptyUsers : "No app users you can access."}
              </p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full border-collapse text-left">
                  <thead>
                    <tr className="border-b border-zinc-300 text-zinc-500 dark:border-zinc-700">
                      <th className="py-2 pr-4 font-medium">Name</th>
                      <th className="py-2 pr-4 font-medium">Email</th>
                      <th className="py-2 pr-4 font-medium">External ID</th>
                      <th className="py-2 pr-4 font-medium">Status</th>
                      <th className="py-2 pr-4 font-medium">License</th>
                      <th className="py-2 pr-4 font-medium">Last active</th>
                      <th className="py-2 pr-4 font-medium">Match</th>
                    </tr>
                  </thead>
                  <tbody>
                    {appUsers.data.map((u) => {
                      const match = matchByUser.get(u.id);
                      return (
                        <tr key={u.id} className="border-b border-zinc-200 dark:border-zinc-800">
                          <td className="py-2 pr-4">{u.displayName ?? "—"}</td>
                          <td className="py-2 pr-4 text-zinc-600 dark:text-zinc-400">
                            {u.email ?? "—"}
                          </td>
                          <td className="py-2 pr-4 text-zinc-600 dark:text-zinc-400">
                            {u.externalUserId ?? "—"}
                          </td>
                          <td className="py-2 pr-4 text-zinc-600 dark:text-zinc-400">
                            {u.status ?? "—"}
                          </td>
                          <td className="py-2 pr-4 text-zinc-600 dark:text-zinc-400">
                            {u.licenseType ?? "—"}
                          </td>
                          <td className="py-2 pr-4 text-zinc-600 dark:text-zinc-400">
                            {u.lastActiveAt ? u.lastActiveAt.slice(0, 10) : "—"}
                          </td>
                          <td className="py-2 pr-4">
                            {!matchesOk ? (
                              <span className="text-zinc-500">—</span>
                            ) : match ? (
                              <span className="text-green-700 dark:text-green-400">
                                matched
                                {match.matchMethod ? (
                                  <span className="text-zinc-500"> · {match.matchMethod}</span>
                                ) : null}
                                {match.confidence !== null ? (
                                  <span className="text-zinc-500"> ({match.confidence})</span>
                                ) : null}
                              </span>
                            ) : (
                              <span className="text-zinc-500">unmatched</span>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          {!DEMO_MODE && (
            <section className="space-y-2 text-sm">
              <h2 className="font-medium">Actions</h2>
              <p className="text-xs text-zinc-500">
                These old-app actions are not implemented in v3 yet — shown so the gap is explicit, not
                hidden. This surface is read-only.
              </p>
              <ul className="flex flex-wrap gap-2">
                {[
                  "Link / unlink contracts",
                  "Edit / archive app",
                  "Connector sync",
                  "AI app / license analysis",
                  "Export",
                ].map((action) => (
                  <li key={action}>
                    <span
                      aria-disabled="true"
                      title="Not built yet"
                      className="inline-flex items-center gap-2 rounded border border-zinc-300 px-2.5 py-1 text-xs text-zinc-400 dark:border-zinc-700"
                    >
                      {action}
                      <span className="rounded-full border border-zinc-300 px-1.5 text-[10px] dark:border-zinc-700">
                        Not built yet
                      </span>
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          )}

          <p className="text-xs text-zinc-500">
            Only whether a match exists is shown here, not who it matched.
          </p>
        </>
      )}
    </main>
  );
}
