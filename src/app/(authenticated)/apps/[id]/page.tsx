import Link from "next/link";
import { getAppDetailForCurrentUser } from "@/lib/data/apps";
import { listContractsLinkedToApp } from "@/lib/data/links";

export const metadata = { title: "App · ID Caddie" };

// Read-only app detail (build-sequence Stage 4b). The [id] route param is ONLY a lookup key —
// RLS decides whether the signed-in user may read the row, so an id for another tenant's app
// returns the same "not found" as a non-existent id (no enumeration). Linked contracts are
// read-only via RLS-backed app_contracts (org-scoped read, 0006 / PR #20) — only contracts the
// user may read are shown. No create/edit/delete, no app users/invoices/files, no client
// filtering. Server-rendered.
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

          <p className="text-xs text-zinc-500">
            App users, invoices, files, and license rules are not shown yet (tenant-only or
            default-deny — RISK-002).
          </p>
        </>
      )}
    </main>
  );
}
