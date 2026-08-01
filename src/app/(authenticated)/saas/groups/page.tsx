import Link from "next/link";
import { Badge } from "@/components/badge";
import { StatCard } from "@/components/stat-card";
import { accessGate, listSaasGroups, getSaasCounts } from "@/lib/data/saas-accounts";
import { Shell, Notice, Card, EvidenceCell, formatDate, Pager } from "../saas-page-shell";

export const metadata = { title: "User groups · ID Caddie" };

const PAGE = 50;
const one = (v: string | string[] | undefined): string | null => (Array.isArray(v) ? v[0] : v) ?? null;

export default async function SaasGroupsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams;
  const gate = await accessGate();
  if (!gate.ok) {
    return <Shell title="User groups" intro="Groups discovered in your connected applications."><Notice heading="Not available">You don’t have access to this area.</Notice></Shell>;
  }

  const search = one(sp.q);
  const connectionId = one(sp.connection);
  const includeStale = one(sp.includeStale) !== "0";
  const offset = Math.max(0, Number(one(sp.offset) ?? 0) || 0);

  const [groups, counts] = await Promise.all([
    listSaasGroups(gate.tenantId, { connectionId, includeStale, search, limit: PAGE, offset }),
    getSaasCounts(gate.tenantId, connectionId),
  ]);

  const intro = "Groups defined inside your connected applications. These are separate from your identity directory’s groups — an application group grants access within that application only.";

  if (!groups.ok) {
    return <Shell title="User groups" intro={intro}><Notice heading="Could not load">Group information could not be loaded. Please try again in a moment.</Notice></Shell>;
  }

  const { rows, total } = groups.data;
  const c = counts.ok ? counts.data : null;
  const filtering = Boolean(search) || !includeStale;

  const params = new URLSearchParams();
  if (search) params.set("q", search);
  if (connectionId) params.set("connection", connectionId);
  if (!includeStale) params.set("includeStale", "0");

  // Whether we hold membership evidence at all. Slack reports a usergroup's own member count, but reading the MEMBERS is
  // a separate call that this connector does not make yet — so the two numbers are shown as two different facts rather
  // than one merged number that would imply we verified something we did not.
  const anyKnownMembers = rows.some((g) => (g.known_member_count ?? 0) > 0);

  return (
    <Shell
      title="User groups"
      intro={intro}
      actions={<Link href={`/saas/accounts${connectionId ? `?connection=${connectionId}` : ""}`} className="rounded-md border border-zinc-300 px-3 py-1.5 text-sm hover:bg-zinc-50 dark:border-zinc-700 dark:hover:bg-zinc-900">View accounts</Link>}
    >
      {c ? (
        <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-3">
          <StatCard label="User groups" value={c.groups.current.toLocaleString()} sub={c.groups.stale > 0 ? `${c.groups.stale.toLocaleString()} not seen recently` : "All confirmed by the last sync"} />
          <StatCard label="Accounts in this application" value={c.accounts.current.toLocaleString()} href="/saas/accounts" />
          <StatCard label="Last confirmed" value={formatDate(c.groups.lastSeenAt ?? null)} />
        </div>
      ) : null}

      <form method="GET" className="mb-4 flex flex-wrap items-end gap-2">
        {connectionId ? <input type="hidden" name="connection" value={connectionId} /> : null}
        <label className="flex-1 min-w-56">
          <span className="mb-1 block text-xs text-zinc-500">Search</span>
          <input name="q" defaultValue={search ?? ""} placeholder="Group name or handle"
            className="w-full rounded-md border border-zinc-300 px-3 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-950" />
        </label>
        <button type="submit" className="rounded-md border border-zinc-300 px-3 py-1.5 text-sm hover:bg-zinc-50 dark:border-zinc-700 dark:hover:bg-zinc-900">Search</button>
        {filtering ? <Link href={`/saas/groups${connectionId ? `?connection=${connectionId}` : ""}`} className="px-2 py-1.5 text-sm underline">Clear</Link> : null}
      </form>

      {rows.length === 0 ? (
        <Notice heading={filtering ? "No groups match this search" : "No user groups discovered yet"}>
          {filtering
            ? "Try a different search, or clear it to see every group."
            : <>Connect an application and run its first sync to discover its groups. <Link href="/connectors" className="underline">Go to connectors</Link>.</>}
        </Notice>
      ) : (
        <Card>
          <table className="w-full text-sm">
            <thead className="border-b border-zinc-200 bg-zinc-50 text-left text-xs uppercase tracking-wide text-zinc-500 dark:border-zinc-800 dark:bg-zinc-900/50">
              <tr>
                <th className="px-4 py-2 font-medium">Group</th>
                <th className="px-4 py-2 font-medium">Members</th>
                {anyKnownMembers ? <th className="px-4 py-2 font-medium">Confirmed members</th> : null}
                <th className="px-4 py-2 font-medium">Record</th>
                <th className="px-4 py-2 font-medium">Last seen</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((g) => (
                <tr key={g.id} className="border-b border-zinc-100 last:border-0 dark:border-zinc-900">
                  <td className="px-4 py-2.5">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium">{g.name ?? g.handle ?? "Unnamed group"}</span>
                      {g.is_active === false ? <Badge tone="neutral">Disabled</Badge> : null}
                    </div>
                    {g.handle && g.name ? <div className="text-xs text-zinc-500">@{g.handle}</div> : null}
                    {g.description ? <div className="mt-0.5 max-w-md text-xs text-zinc-500">{g.description}</div> : null}
                  </td>
                  <td className="px-4 py-2.5 tabular-nums">{g.reported_member_count ?? "—"}</td>
                  {anyKnownMembers ? <td className="px-4 py-2.5 tabular-nums">{g.known_member_count ?? 0}</td> : null}
                  <td className="px-4 py-2.5"><EvidenceCell syncStatus={g.sync_status} staleSince={g.stale_since} /></td>
                  <td className="px-4 py-2.5 text-zinc-500">{formatDate(g.last_seen_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <Pager base="/saas/groups" params={params} offset={offset} limit={PAGE} total={total} />
        </Card>
      )}

      {rows.length > 0 && !anyKnownMembers ? (
        <p className="mt-4 text-xs text-zinc-500">
          Member counts are reported by the application. Group membership itself has not been synchronized, so ID Caddie
          does not yet list who is in each group.
        </p>
      ) : null}
    </Shell>
  );
}
