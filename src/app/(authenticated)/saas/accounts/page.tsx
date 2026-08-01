import Link from "next/link";
import { Badge } from "@/components/badge";
import { StatCard } from "@/components/stat-card";
import { accessGate, listSaasAccounts, getSaasCounts, type SaasAccountRow } from "@/lib/data/saas-accounts";
import { Shell, Notice, Card, EvidenceCell, formatDate, Pager } from "../saas-page-shell";

export const metadata = { title: "Application accounts · ID Caddie" };

const PAGE = 50;
const one = (v: string | string[] | undefined): string | null => (Array.isArray(v) ? v[0] : v) ?? null;

// How each account is classified, in the customer's words. `unknown` is a real answer — a provider that does not say
// whether an account is a person gets "Unclassified", never a guessed "Person".
const KIND_LABEL: Record<string, string> = { human: "Person", bot: "Bot", service: "Service account", unknown: "Unclassified" };
const STATUS_LABEL: Record<string, string> = { active: "Active", inactive: "Inactive", deleted: "Deactivated", unknown: "Unknown" };

function MatchCell({ row }: { row: SaasAccountRow }) {
  if (row.match_state === "matched") return <Badge tone="success">Matched</Badge>;
  if (row.match_state === "proposed") return <Badge tone="attention">Suggested</Badge>;
  // Deliberately not "orphaned" or "unauthorized". An account with no directory match may simply be a contractor, a
  // shared mailbox, or someone whose Slack address differs from their directory address.
  if (row.account_kind === "bot" || row.account_kind === "service") return <span className="text-zinc-400">Not applicable</span>;
  return <Badge tone="neutral">No match</Badge>;
}

export default async function SaasAccountsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams;
  const gate = await accessGate();
  if (!gate.ok) {
    return <Shell title="Application accounts" intro="Accounts discovered in your connected applications."><Notice heading="Not available">You don’t have access to this area.</Notice></Shell>;
  }

  const search = one(sp.q);
  const kind = one(sp.kind);
  const status = one(sp.status);
  const matchState = one(sp.match);
  const connectionId = one(sp.connection);
  const includeStale = one(sp.includeStale) !== "0";
  const offset = Math.max(0, Number(one(sp.offset) ?? 0) || 0);

  const [accounts, counts] = await Promise.all([
    listSaasAccounts(gate.tenantId, { connectionId, includeStale, search, kind, status, matchState, limit: PAGE, offset }),
    getSaasCounts(gate.tenantId, connectionId),
  ]);

  const intro = "People, bots and service accounts discovered in the applications you have connected. Each one shows whether it is matched to someone in your identity directory.";

  if (!accounts.ok) {
    return <Shell title="Application accounts" intro={intro}><Notice heading="Could not load">Account information could not be loaded. Please try again in a moment.</Notice></Shell>;
  }

  const { rows, total } = accounts.data;
  const c = counts.ok ? counts.data : null;
  const filtering = Boolean(search || kind || status || matchState) || !includeStale;

  const params = new URLSearchParams();
  if (search) params.set("q", search);
  if (kind) params.set("kind", kind);
  if (status) params.set("status", status);
  if (matchState) params.set("match", matchState);
  if (connectionId) params.set("connection", connectionId);
  if (!includeStale) params.set("includeStale", "0");

  return (
    <Shell
      title="Application accounts"
      intro={intro}
      actions={<Link href={`/saas/groups${connectionId ? `?connection=${connectionId}` : ""}`} className="rounded-md border border-zinc-300 px-3 py-1.5 text-sm hover:bg-zinc-50 dark:border-zinc-700 dark:hover:bg-zinc-900">View user groups</Link>}
    >
      {c ? (
        <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
          <StatCard label="Accounts" value={c.accounts.current.toLocaleString()} sub={c.accounts.stale > 0 ? `${c.accounts.stale.toLocaleString()} not seen recently` : "All confirmed by the last sync"} />
          <StatCard label="People" value={c.accounts.humans.toLocaleString()} />
          <StatCard label="Bots and service accounts" value={c.accounts.bots.toLocaleString()} />
          <StatCard label="Administrators" value={c.accounts.admins.toLocaleString()} tone={c.accounts.admins > 0 ? "attention" : "neutral"} />
          <StatCard
            label="Matched to a person"
            value={c.matching.humans > 0 ? `${Math.round((c.matching.matched / c.matching.humans) * 100)}%` : "—"}
            sub={c.matching.humans > 0 ? `${c.matching.matched} of ${c.matching.humans} people` : "No people discovered yet"}
          />
        </div>
      ) : null}

      <form method="GET" className="mb-4 flex flex-wrap items-end gap-2">
        {connectionId ? <input type="hidden" name="connection" value={connectionId} /> : null}
        <label className="flex-1 min-w-56">
          <span className="mb-1 block text-xs text-zinc-500">Search</span>
          <input name="q" defaultValue={search ?? ""} placeholder="Name or email address"
            className="w-full rounded-md border border-zinc-300 px-3 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-950" />
        </label>
        <label>
          <span className="mb-1 block text-xs text-zinc-500">Type</span>
          <select name="kind" defaultValue={kind ?? ""} className="rounded-md border border-zinc-300 px-3 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-950">
            <option value="">All types</option>
            <option value="human">People</option>
            <option value="bot">Bots</option>
            <option value="service">Service accounts</option>
            <option value="unknown">Unclassified</option>
          </select>
        </label>
        <label>
          <span className="mb-1 block text-xs text-zinc-500">Status</span>
          <select name="status" defaultValue={status ?? ""} className="rounded-md border border-zinc-300 px-3 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-950">
            <option value="">Any status</option>
            <option value="active">Active</option>
            <option value="inactive">Inactive</option>
            <option value="deleted">Deactivated</option>
          </select>
        </label>
        <label>
          <span className="mb-1 block text-xs text-zinc-500">Identity match</span>
          <select name="match" defaultValue={matchState ?? ""} className="rounded-md border border-zinc-300 px-3 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-950">
            <option value="">Any</option>
            <option value="matched">Matched</option>
            <option value="proposed">Suggested</option>
            <option value="unmatched">No match</option>
          </select>
        </label>
        <button type="submit" className="rounded-md border border-zinc-300 px-3 py-1.5 text-sm hover:bg-zinc-50 dark:border-zinc-700 dark:hover:bg-zinc-900">Apply</button>
        {filtering ? <Link href={`/saas/accounts${connectionId ? `?connection=${connectionId}` : ""}`} className="px-2 py-1.5 text-sm underline">Clear</Link> : null}
      </form>

      {rows.length === 0 ? (
        <Notice heading={filtering ? "No accounts match these filters" : "No accounts discovered yet"}>
          {filtering
            ? "Try widening your search, or clear the filters to see every account."
            : <>Connect an application and run its first sync to discover accounts. <Link href="/connectors" className="underline">Go to connectors</Link>.</>}
        </Notice>
      ) : (
        <Card>
          <table className="w-full text-sm">
            <thead className="border-b border-zinc-200 bg-zinc-50 text-left text-xs uppercase tracking-wide text-zinc-500 dark:border-zinc-800 dark:bg-zinc-900/50">
              <tr>
                <th className="px-4 py-2 font-medium">Account</th>
                <th className="px-4 py-2 font-medium">Type</th>
                <th className="px-4 py-2 font-medium">Status</th>
                <th className="px-4 py-2 font-medium">Identity match</th>
                <th className="px-4 py-2 font-medium">Record</th>
                <th className="px-4 py-2 font-medium">Last seen</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="border-b border-zinc-100 last:border-0 dark:border-zinc-900">
                  <td className="px-4 py-2.5">
                    <div className="font-medium">{r.display_name ?? r.email ?? "Unnamed account"}</div>
                    {r.email && r.display_name ? <div className="text-xs text-zinc-500">{r.email}</div> : null}
                  </td>
                  <td className="px-4 py-2.5">
                    <span className="inline-flex flex-wrap items-center gap-1.5">
                      <span>{KIND_LABEL[r.account_kind] ?? KIND_LABEL.unknown}</span>
                      {r.is_admin ? <Badge tone="attention">Administrator</Badge> : null}
                    </span>
                  </td>
                  <td className="px-4 py-2.5">
                    {r.account_status === "active"
                      ? <Badge tone="success">Active</Badge>
                      : <Badge tone={r.account_status === "unknown" ? "neutral" : "attention"}>{STATUS_LABEL[r.account_status] ?? "Unknown"}</Badge>}
                  </td>
                  <td className="px-4 py-2.5"><MatchCell row={r} /></td>
                  <td className="px-4 py-2.5"><EvidenceCell syncStatus={r.sync_status} staleSince={r.stale_since} /></td>
                  <td className="px-4 py-2.5 text-zinc-500">{formatDate(r.last_seen_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <Pager base="/saas/accounts" params={params} offset={offset} limit={PAGE} total={total} />
        </Card>
      )}

      {c && c.matching.withoutEmail > 0 ? (
        <p className="mt-4 text-xs text-zinc-500">
          {c.matching.withoutEmail === 1 ? "One person’s account has" : `${c.matching.withoutEmail} people’s accounts have`} no email address,
          so {c.matching.withoutEmail === 1 ? "it" : "they"} cannot be matched to your directory automatically.
        </p>
      ) : null}
    </Shell>
  );
}
