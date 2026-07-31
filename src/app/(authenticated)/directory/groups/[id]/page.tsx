import Link from "next/link";
import { Badge } from "@/components/badge";
import { StatCard, StatGrid } from "@/components/stat-card";
import { accessHref, parseAccessFilters, returnParams, type SearchParamsInput } from "@/lib/data/access-filters";
import { loadGroupAccessDetail, type GroupAccessDetailData } from "@/lib/data/access-loaders";
import { appStatusLabel, formatStaleSince, groupTypeLabel, signOnLabel } from "@/lib/data/directory-display";

export const metadata = { title: "Group · ID Caddie" };

// Phase 3 — Group detail. The one place group-mediated access is explained end to end: who is in the group, what it grants, and
// which of those grants the member would still have without it.
//
// Everything comes from ONE call to loadGroupAccessDetail (one RPC, then the existing access + governance engines). There is no
// per-row query, and there is no second data source: `app_users` and `public.apps` are not consulted.

const EvidenceBadge = ({ state, label }: { state: "current" | "stale"; label?: string }) =>
  state === "current" ? <Badge tone="success">{label ?? "Current"}</Badge> : <Badge tone="attention">{label ?? "Stale"}</Badge>;

const Notice = ({ heading, children, tone = "plain" }: { heading: string; children: React.ReactNode; tone?: "plain" | "warn" }) => (
  <div role="status" className={tone === "warn"
    ? "max-w-2xl rounded border border-amber-400 bg-amber-50 p-4 text-sm dark:border-amber-700 dark:bg-amber-950/30"
    : "max-w-2xl rounded border border-zinc-300 p-4 text-sm dark:border-zinc-700"}>
    <div className="font-medium">{heading}</div>
    <div className="mt-1 text-zinc-600 dark:text-zinc-400">{children}</div>
  </div>
);

function Header({ d, backHref }: { d: GroupAccessDetailData; backHref: string }) {
  return (
    <header className="space-y-2">
      <div className="text-sm"><Link href={backHref} className="text-zinc-500 hover:underline">← Groups</Link></div>
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="text-xl font-semibold">{d.displayName}</h1>
        {/* Built-in is toned to stand out: "Everyone" granting an application is a materially different fact from a group
            somebody deliberately created. Rendered once, here — the type is not repeated further down. */}
        <Badge tone={d.isBuiltIn ? "attention" : "neutral"}>{groupTypeLabel(d.typeCategory) ?? "Group"}</Badge>
        <EvidenceBadge state={d.syncState} />
      </div>
      {d.description && <p className="max-w-3xl text-sm text-zinc-600 dark:text-zinc-400">{d.description}</p>}
      {d.syncState === "stale" && (
        <p className="text-sm text-amber-700 dark:text-amber-400">
          This group was not seen in the latest complete discovery{formatStaleSince(d.staleSince) ? ` — last seen ${formatStaleSince(d.staleSince)}` : ""}.
          Its record is kept, not deleted.
        </p>
      )}
    </header>
  );
}

export default async function GroupDetailPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<SearchParamsInput> }) {
  const { id } = await params;
  const sp = await searchParams;
  const filters = parseAccessFilters(sp);
  const r = await loadGroupAccessDetail(id, filters.includeStale);

  const backHref = accessHref("/directory/groups", filters);

  if (!r.ok) {
    return (
      <main className="flex flex-1 flex-col gap-6 p-8">
        <div className="text-sm"><Link href="/directory/groups" className="text-zinc-500 hover:underline">← Groups</Link></div>
        {r.error === "not_found" ? (
          // Missing, another tenant's, and owned by a superseded connector are one answer. Distinguishing them would confirm
          // the existence of records the caller may not see.
          <Notice heading="Not found">This group doesn’t exist or you don’t have access to it.</Notice>
        ) : (
          <Notice heading="Could not load">This group could not be loaded. Please try again later.</Notice>
        )}
      </main>
    );
  }

  const d = r.data;
  const identityHref = (i: string) => `/access/identities/${i}?${returnParams("groups", filters).toString()}`;
  const applicationHref = (a: string) => `/access/applications/${a}?${returnParams("groups", filters).toString()}`;
  // Filter by the group SUBJECT BUCKET plus the group's own label. The bucket is the structural filter; the label narrows within it.
  // Neither is used to route — the primary actions on this page all use canonical ids.
  const findingsHref = accessHref("/access/findings", filters, { query: d.displayName.toLowerCase(), subject: "groups", subjectType: null, page: 1 });

  return (
    <main className="flex flex-1 flex-col gap-6 p-8">
      <Header d={d} backHref={backHref} />

      {d.bounded ? (
        <Notice tone="warn" heading="Too large to evaluate in this view">
          This group’s membership is above the current safety limit, so members, application grants and findings were not evaluated.
          No partial list is shown, because one would read as the whole group. Open a specific person or application from{" "}
          <Link href="/access" className="underline">Access</Link> to review their access individually.
        </Notice>
      ) : (
        <>
          <StatGrid>
            <StatCard label="Members" value={d.memberCount} />
            <StatCard label="Applications granted" value={d.applicationCount} />
            <StatCard label="Findings" value={d.findings.length} href={d.findings.length > 0 ? findingsHref : undefined} />
          </StatGrid>

          {/* ── Members ─────────────────────────────────────────────────────────────────────────────────────────── */}
          <section aria-labelledby="members-heading" className="space-y-2">
            <h2 id="members-heading" className="text-sm font-medium">Members</h2>
            {d.members.length === 0 ? (
              <Notice heading="No members represented">
                No current membership is represented for this group in the selected directory scope.
                {!filters.includeStale && <> Stale memberships are excluded — <Link href={accessHref(`/directory/groups/${d.id}`, filters, { includeStale: true })} className="underline">include stale evidence</Link>.</>}
              </Notice>
            ) : (
              <div className="overflow-x-auto text-sm">
                <table className="w-full border-collapse text-left">
                  <thead>
                    <tr className="border-b border-zinc-300 text-zinc-500 dark:border-zinc-700">
                      <th scope="col" className="py-2 pr-4 font-medium">Person</th>
                      <th scope="col" className="py-2 pr-4 font-medium">Identifier</th>
                      <th scope="col" className="py-2 pr-4 font-medium">Account</th>
                      <th scope="col" className="py-2 pr-4 font-medium">Membership evidence</th>
                      <th scope="col" className="py-2 pr-4 font-medium text-right"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {d.members.map((m) => (
                      <tr key={m.identityId} className="border-b border-zinc-200 dark:border-zinc-800">
                        <td className="py-2 pr-4"><Link href={identityHref(m.identityId)} className="font-medium underline-offset-2 hover:underline">{m.displayName}</Link></td>
                        <td className="py-2 pr-4 text-zinc-600 dark:text-zinc-400">{m.identifier ?? <span className="text-zinc-400">—</span>}</td>
                        <td className="py-2 pr-4">{m.isActive === null ? <span className="text-zinc-400">—</span> : <Badge tone={m.isActive ? "success" : "neutral"}>{m.isActive ? "Active" : "Inactive"}</Badge>}</td>
                        {/* The membership edge and the person's own record go stale independently — a person can still be current
                            while the evidence that they belong here is not. Both are shown rather than merged. */}
                        <td className="py-2 pr-4"><EvidenceBadge state={m.membershipState} /></td>
                        <td className="py-2 pr-4 text-right"><Link href={identityHref(m.identityId)} className="underline">View access</Link></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          {/* ── Applications granted ────────────────────────────────────────────────────────────────────────────── */}
          <section aria-labelledby="apps-heading" className="space-y-2">
            <h2 id="apps-heading" className="text-sm font-medium">Applications granted through this group</h2>
            {d.applications.length === 0 ? (
              <Notice heading="No application assignments represented">
                Belonging to this group does not currently grant access to any application in the selected directory scope. Members
                may still reach applications through a direct assignment or another group.
              </Notice>
            ) : (
              <div className="overflow-x-auto text-sm">
                <table className="w-full border-collapse text-left">
                  <thead>
                    <tr className="border-b border-zinc-300 text-zinc-500 dark:border-zinc-700">
                      <th scope="col" className="py-2 pr-4 font-medium">Application</th>
                      <th scope="col" className="py-2 pr-4 font-medium">Status</th>
                      <th scope="col" className="py-2 pr-4 font-medium">Sign-on</th>
                      <th scope="col" className="py-2 pr-4 font-medium">Also held directly</th>
                      <th scope="col" className="py-2 pr-4 font-medium">Assignment evidence</th>
                      <th scope="col" className="py-2 pr-4 font-medium text-right"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {d.applications.map((a) => (
                      <tr key={a.applicationId} className="border-b border-zinc-200 dark:border-zinc-800">
                        <td className="py-2 pr-4"><Link href={applicationHref(a.applicationId)} className="font-medium underline-offset-2 hover:underline">{a.label}</Link></td>
                        <td className="py-2 pr-4">{appStatusLabel(a.statusCategory) ?? <span className="text-zinc-400">—</span>}</td>
                        <td className="py-2 pr-4 text-zinc-600 dark:text-zinc-400">{signOnLabel(a.signOnCategory) ?? <span className="text-zinc-400">—</span>}</td>
                        {/* The question this page exists to answer: would removing the group actually remove the access? A member
                            who also holds the application directly would keep it. Counted from the same subgraph, not guessed. */}
                        <td className="py-2 pr-4 tabular-nums text-zinc-600 dark:text-zinc-400">
                          {a.alsoDirectFor === 0 ? <span className="text-zinc-400">none</span> : `${a.alsoDirectFor} of ${d.memberCount}`}
                        </td>
                        <td className="py-2 pr-4"><EvidenceBadge state={a.assignmentState} /></td>
                        <td className="py-2 pr-4 text-right"><Link href={applicationHref(a.applicationId)} className="underline">View access</Link></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          {/* ── Findings ────────────────────────────────────────────────────────────────────────────────────────── */}
          <section aria-labelledby="findings-heading" className="space-y-2">
            <h2 id="findings-heading" className="text-sm font-medium">Findings</h2>
            {d.findings.length === 0 ? (
              <p className="text-sm text-zinc-600 dark:text-zinc-400">No governance findings relate to this group in the selected directory scope.</p>
            ) : (
              <>
                <ul className="space-y-2">
                  {d.findings.map((f) => (
                    <li key={f.id} className="rounded border border-zinc-200 p-3 text-sm dark:border-zinc-800">
                      <div className="flex flex-wrap items-center gap-2">
                        <Badge tone={f.severityTone}>{f.severityLabel}</Badge>
                        <span className="font-medium">{f.title}</span>
                        {f.staleEvidence && <Badge tone="attention">Stale evidence</Badge>}
                      </div>
                      <p className="mt-1 text-zinc-600 dark:text-zinc-400">{f.summary}</p>
                      {f.guidance && <p className="mt-1 text-xs text-zinc-500">{f.guidance}</p>}
                    </li>
                  ))}
                </ul>
                <Link href={findingsHref} className="text-sm underline">Open these in Findings</Link>
              </>
            )}
          </section>
        </>
      )}

      {/* ── Evidence and trust ──────────────────────────────────────────────────────────────────────────────────── */}
      <section aria-labelledby="evidence-heading" className="space-y-2 border-t border-zinc-200 pt-4 dark:border-zinc-800">
        <h2 id="evidence-heading" className="text-sm font-medium">Evidence</h2>
        <dl className="max-w-xl divide-y divide-zinc-200 rounded border border-zinc-200 text-sm dark:divide-zinc-800 dark:border-zinc-800">
          <div className="flex items-start justify-between gap-4 px-3 py-2"><dt className="text-zinc-500">Source</dt><dd className="text-zinc-700 dark:text-zinc-300">{d.providerLabel}</dd></div>
          <div className="flex items-start justify-between gap-4 px-3 py-2"><dt className="text-zinc-500">Last seen in discovery</dt><dd className="text-zinc-700 dark:text-zinc-300">{formatStaleSince(d.lastSeenAt) ?? "—"}</dd></div>
          <div className="flex items-start justify-between gap-4 px-3 py-2"><dt className="text-zinc-500">Record state</dt><dd>{d.syncState === "current" ? "Current" : `Stale${formatStaleSince(d.staleSince) ? ` since ${formatStaleSince(d.staleSince)}` : ""}`}</dd></div>
          {!d.bounded && <div className="flex items-start justify-between gap-4 px-3 py-2"><dt className="text-zinc-500">Rows with stale evidence</dt><dd className="tabular-nums text-zinc-700 dark:text-zinc-300">{d.staleEvidenceCount}</dd></div>}
        </dl>
        <p className="max-w-3xl text-xs text-zinc-500">
          Records that stop appearing in discovery are marked stale and kept, never deleted — the history of what access existed
          stays reviewable. Everything on this page comes from the connector that currently owns this group; a connector that has
          been superseded by another reading the same organization contributes nothing here.
        </p>
      </section>
    </main>
  );
}
