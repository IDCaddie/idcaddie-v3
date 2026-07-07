import Link from "next/link";
import { listRecentAuditEntriesForCurrentUser } from "@/lib/data/audit";

export const metadata = { title: "Audit / Logs · ID Caddie" };

// Read-only Audit / Logs view. It renders only what the user-scoped server DAL returns; RLS is the
// authorization boundary (tenant-member SELECT on audit_logs). Shows the most recent entries the user
// may read — action, entity/table, timestamp, and a "actor recorded" label — with NO tenant id, no raw
// actor/resource id, no ip/user-agent, and no before/after diff blobs. audit_logs is append-only
// (reject_audit_mutation), so there is no edit/delete here by design. No exports.
export default async function AuditPage() {
  const result = await listRecentAuditEntriesForCurrentUser();

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
          before/after detail. The log is append-only; there is no edit, delete, or export here.
        </p>
      </header>

      {!result.ok ? (
        <p className="text-sm text-red-600">
          Could not load the audit log right now. Please try again later.
        </p>
      ) : result.data.length === 0 ? (
        <div className="rounded border border-zinc-300 p-4 text-sm dark:border-zinc-700">
          <div className="font-medium">No audit entries to show</div>
          <p className="mt-1 text-zinc-600 dark:text-zinc-400">
            No audit activity is visible to you yet. Audited actions (e.g. contract writes) appear here as
            they happen.
          </p>
        </div>
      ) : (
        <section className="space-y-2 text-sm">
          <div className="text-zinc-500">{result.data.length} recent entries</div>
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
                {result.data.map((e) => (
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
            “Actor” shows only whether an actor was recorded, not who. Before/after diff, full audit
            search/filter/export, and the legacy retention/purge controls are not built yet. Audit
            mutation/delete remains not built (the log is append-only by design).
          </p>
        </section>
      )}
    </main>
  );
}
