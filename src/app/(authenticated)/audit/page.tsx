import Link from "next/link";
import { listRecentAuditEntriesForCurrentUser } from "@/lib/data/audit";
import { filterAuditEntries, auditFacets, parseAuditDays, AUDIT_DAYS } from "@/lib/data/audit-filter";

export const metadata = { title: "Audit / Logs · ID Caddie" };

// Read-only Audit / Logs view. It renders only what the user-scoped server DAL returns; RLS is the
// authorization boundary (tenant-member SELECT on audit_logs). Shows the most recent entries the user
// may read — action, entity/table, timestamp, and a "actor recorded" label — with NO tenant id, no raw
// actor/resource id, no ip/user-agent, and no before/after diff blobs. Search/filter run SERVER-SIDE over
// exactly those already-fetched, RLS-scoped rows (they can only NARROW; no new query, no projection widening,
// no client tenant filter, no raw-JSON search). audit_logs is append-only (reject_audit_mutation) — no
// edit/delete/export here by design.
export default async function AuditPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const sp = await searchParams;
  const q = typeof sp.q === "string" ? sp.q : "";
  const action = typeof sp.action === "string" ? sp.action : "";
  const entity = typeof sp.entity === "string" ? sp.entity : "";
  const days = parseAuditDays(typeof sp.days === "string" ? sp.days : undefined);

  const result = await listRecentAuditEntriesForCurrentUser();
  const facets = result.ok ? auditFacets(result.data) : { actions: [], entities: [] };
  const rows = result.ok
    ? filterAuditEntries(result.data, { q, action, entity, days }, new Date())
    : [];
  const total = result.ok ? result.data.length : 0;
  const hasFilters = q !== "" || action !== "" || entity !== "" || days !== null;

  return (
    <main className="flex flex-1 flex-col gap-6 p-8">
      <header className="space-y-1">
        <div className="text-sm">
          <Link href="/dashboards" className="text-zinc-500 hover:underline">
            ← Back
          </Link>
        </div>
        <h1 className="text-xl font-semibold">Audit / Logs</h1>
        <p className="text-sm text-zinc-600 dark:text-zinc-400">
          Read-only view of the most recent audit entries you may see (RLS-scoped to your tenant). Shows
          the action, entity, and time only — <strong>not</strong> the actor identity, IP / user-agent, or
          before/after detail. Search and filters narrow only these recent, already-visible rows. The log is
          append-only; there is no edit, delete, or export here.
        </p>
      </header>

      {result.ok && total > 0 ? (
        <form method="get" action="/audit" className="flex flex-wrap items-end gap-2 text-sm">
          <label className="flex flex-col gap-1">
            <span className="text-xs text-zinc-500">Search</span>
            <input
              type="search"
              name="q"
              defaultValue={q}
              placeholder="action or entity"
              className="rounded border border-zinc-300 px-2 py-1 dark:border-zinc-700 dark:bg-zinc-900"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs text-zinc-500">Action</span>
            <select name="action" defaultValue={action} className="rounded border border-zinc-300 px-2 py-1 dark:border-zinc-700 dark:bg-zinc-900">
              <option value="">All actions</option>
              {facets.actions.map((a) => (
                <option key={a} value={a}>
                  {a}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs text-zinc-500">Entity</span>
            <select name="entity" defaultValue={entity} className="rounded border border-zinc-300 px-2 py-1 dark:border-zinc-700 dark:bg-zinc-900">
              <option value="">All entities</option>
              {facets.entities.map((en) => (
                <option key={en} value={en}>
                  {en}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs text-zinc-500">Window</span>
            <select name="days" defaultValue={days ? String(days) : ""} className="rounded border border-zinc-300 px-2 py-1 dark:border-zinc-700 dark:bg-zinc-900">
              <option value="">All time</option>
              {AUDIT_DAYS.map((d) => (
                <option key={d} value={String(d)}>
                  Last {d} days
                </option>
              ))}
            </select>
          </label>
          <button type="submit" className="rounded border border-zinc-300 px-3 py-1 dark:border-zinc-700">
            Apply
          </button>
          {hasFilters ? (
            <Link href="/audit" className="px-1 py-1 text-xs text-zinc-500 underline">
              Clear filters
            </Link>
          ) : null}
        </form>
      ) : null}

      {!result.ok ? (
        <p className="text-sm text-red-600">Could not load the audit log right now. Please try again later.</p>
      ) : total === 0 ? (
        <div className="rounded border border-zinc-300 p-4 text-sm dark:border-zinc-700">
          <div className="font-medium">No audit entries to show</div>
          <p className="mt-1 text-zinc-600 dark:text-zinc-400">
            No audit activity is visible to you yet. Audited actions (e.g. contract writes) appear here as
            they happen.
          </p>
        </div>
      ) : rows.length === 0 ? (
        <div className="rounded border border-zinc-300 p-4 text-sm dark:border-zinc-700">
          <div className="font-medium">No audit events match these filters.</div>
          <p className="mt-1 text-zinc-600 dark:text-zinc-400">
            {total} recent event{total === 1 ? "" : "s"} visible to you — adjust the search or filters, or{" "}
            <Link href="/audit" className="underline">
              clear them
            </Link>
            .
          </p>
        </div>
      ) : (
        <section className="space-y-2 text-sm">
          <div className="text-zinc-500">
            {rows.length} of {total} recent entr{total === 1 ? "y" : "ies"}
          </div>
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-left">
              <thead>
                <tr className="border-b border-zinc-300 text-zinc-500 dark:border-zinc-700">
                  <th className="py-2 pr-4 font-medium">Action</th>
                  <th className="py-2 pr-4 font-medium">Entity</th>
                  <th className="py-2 pr-4 font-medium">When</th>
                  <th className="py-2 pr-4 font-medium">Actor</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((e) => (
                  <tr key={e.id} className="border-b border-zinc-200 dark:border-zinc-800">
                    <td className="py-2 pr-4 font-medium">{e.action}</td>
                    <td className="py-2 pr-4 text-zinc-600 dark:text-zinc-400">{e.resourceType}</td>
                    <td className="py-2 pr-4 text-zinc-600 dark:text-zinc-400">
                      {e.createdAt.replace("T", " ").slice(0, 16)}
                    </td>
                    <td className="py-2 pr-4 text-zinc-600 dark:text-zinc-400">
                      {e.actorRecorded ? "recorded" : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="text-xs text-zinc-500">
            “Actor” shows only whether an actor was recorded, not who. Search/filter narrow the recent window
            only. Before/after diff, raw-payload search, export, and the legacy retention/purge controls are
            not built yet. Audit mutation/delete remains not built (the log is append-only by design).
          </p>
        </section>
      )}
    </main>
  );
}
