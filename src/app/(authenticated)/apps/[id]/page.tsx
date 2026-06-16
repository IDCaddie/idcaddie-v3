import Link from "next/link";
import { getAppDetailForCurrentUser } from "@/lib/data/apps";
import { listContractsLinkedToApp } from "@/lib/data/links";
import { listAppUsersForApp } from "@/lib/data/app-users";

export const metadata = { title: "App · ID Caddie" };

// Read-only app detail (build-sequence Stage 4b). The [id] route param is ONLY a lookup key —
// RLS decides whether the signed-in user may read the row, so an id for another tenant's app
// returns the same "not found" as a non-existent id (no enumeration). Linked contracts are
// read-only via RLS-backed app_contracts (org-scoped read, 0006 / PR #20); the app-user roster is
// read-only via RLS-backed app_users (org-scoped read, 0007 / PR #21). No create/edit/delete, no
// provisioning, no identity matching, no invoices/files/license. No client filtering. Server-rendered.
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
              Read-only app detail. Visibility is enforced by Postgres RLS. No editing here yet.
            </p>
          </header>

          <section className="grid grid-cols-1 gap-4 text-sm sm:grid-cols-2">
            <Field label="Vendor" value={result.data.vendorName ?? "—"} />
            <Field label="Category" value={result.data.category ?? "—"} />
            <Field label="Status" value={result.data.status} />
            <Field label="Created" value={result.data.createdAt.slice(0, 10)} />
            <Field label="Updated" value={result.data.updatedAt.slice(0, 10)} />
          </section>

          <section className="space-y-2 text-sm">
            <h2 className="font-medium">Ownership (organization IDs)</h2>
            <p className="text-xs text-zinc-500">
              Organization names are not enriched yet (deferred); IDs shown for now.
            </p>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
              <Field label="Responsible org" value={result.data.responsibleOrgId ?? "—"} />
              <Field label="Paying org" value={result.data.payingOrgId ?? "—"} />
              <Field label="Procurement org" value={result.data.procurementOrgId ?? "—"} />
            </div>
          </section>

          <section className="space-y-2 text-sm">
            <h2 className="font-medium">Linked contracts</h2>
            <p className="text-xs text-zinc-500">
              Contracts linked to this app that you may read (RLS-scoped). Read-only — no
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

          <section className="space-y-2 text-sm">
            <h2 className="font-medium">App users</h2>
            <p className="text-xs text-zinc-500">
              Accounts on this app that you may read (RLS-scoped). Read-only — direct roster fields
              only; no identity matching, license utilization, or provisioning.
            </p>
            {!appUsers || !appUsers.ok ? (
              <p className="text-zinc-600 dark:text-zinc-400">
                Could not load app users right now.
              </p>
            ) : appUsers.data.length === 0 ? (
              <p className="text-zinc-600 dark:text-zinc-400">No app users you can access.</p>
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
                    </tr>
                  </thead>
                  <tbody>
                    {appUsers.data.map((u) => (
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
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <p className="text-xs text-zinc-500">
            Identity matches, license rules/utilization, invoices, and files are not shown yet
            (default-deny — RISK-002). No identity merge, provisioning, or deprovisioning.
          </p>
        </>
      )}
    </main>
  );
}
