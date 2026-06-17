import Link from "next/link";
import { getContractDetailForCurrentUser } from "@/lib/data/contracts";
import { listAppsLinkedToContract } from "@/lib/data/links";

export const metadata = { title: "Contract · ID Caddie" };

// Read-only contract detail (build-sequence Stage 5 — read-only slice). The [id] route param is
// ONLY a lookup key — RLS decides whether the signed-in user may read the row, so an id for
// another tenant's contract returns the same "not found" as a non-existent id (no enumeration).
// Linked apps are read-only via RLS-backed app_contracts (org-scoped read, 0006 / PR #20) — only
// apps the user may read are shown. No create/edit/delete/archive, no upload/import/export, no
// linking/unlinking. Invoices and files stay deferred (default-deny — RISK-002). Server-rendered.
function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-zinc-500">{label}</div>
      <div className="font-medium">{value}</div>
    </div>
  );
}

export default async function ContractDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const result = await getContractDetailForCurrentUser(id);
  const linkedApps = result.ok ? await listAppsLinkedToContract(id) : null;

  return (
    <main className="flex flex-1 flex-col gap-6 p-8">
      <div className="text-sm">
        <Link href="/contracts" className="text-zinc-500 hover:underline">
          ← Back to contracts
        </Link>
      </div>

      {!result.ok && result.error === "query_failed" ? (
        <p className="text-sm text-red-600">
          Could not load this contract right now. Please try again later.
        </p>
      ) : !result.ok ? (
        <div className="rounded border border-zinc-300 p-4 text-sm dark:border-zinc-700">
          <div className="font-medium">Contract not found</div>
          <p className="mt-1 text-zinc-600 dark:text-zinc-400">
            This contract doesn’t exist or you don’t have access to it.
          </p>
        </div>
      ) : (
        <>
          <header className="space-y-1">
            <div className="flex items-center justify-between gap-4">
              <h1 className="text-xl font-semibold">{result.data.contractName}</h1>
              <Link
                href={`/contracts/${result.data.id}/edit`}
                className="rounded border border-zinc-300 px-3 py-1.5 text-sm dark:border-zinc-700"
              >
                Edit
              </Link>
            </div>
            <p className="text-sm text-zinc-600 dark:text-zinc-400">
              Contract detail. Visibility is enforced by Postgres RLS. You can edit the supported
              fields (RLS decides whether a save is allowed); linked apps, invoices, files, deletion,
              and PDF/AI extraction are not built here.
            </p>
          </header>

          <section className="grid grid-cols-1 gap-4 text-sm sm:grid-cols-2">
            <Field label="Vendor" value={result.data.vendorName ?? "—"} />
            <Field label="Status" value={result.data.status} />
            <Field label="Start" value={result.data.startDate ?? "—"} />
            <Field label="End" value={result.data.endDate ?? "—"} />
            <Field label="Renewal" value={result.data.renewalDate ?? "—"} />
            <Field label="Notice deadline" value={result.data.noticeDeadline ?? "—"} />
            <Field
              label="Total cost"
              value={
                result.data.totalCost === null
                  ? "—"
                  : `${result.data.totalCost} ${result.data.currency ?? ""}`.trim()
              }
            />
            <Field label="Billing frequency" value={result.data.billingFrequency ?? "—"} />
            <Field
              label="Renewal responsibility"
              value={result.data.renewalResponsibility ?? "—"}
            />
          </section>

          <section className="space-y-2 text-sm">
            <h2 className="font-medium">Ownership (organization IDs)</h2>
            <p className="text-xs text-zinc-500">
              Organization names are not enriched yet (deferred); IDs shown for now.
            </p>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Field label="Procurement org" value={result.data.procurementOrgId ?? "—"} />
              <Field label="Paying org" value={result.data.payingOrgId ?? "—"} />
            </div>
          </section>

          <section className="grid grid-cols-1 gap-4 text-sm sm:grid-cols-2">
            <Field label="Created" value={result.data.createdAt.slice(0, 10)} />
            <Field label="Updated" value={result.data.updatedAt.slice(0, 10)} />
          </section>

          <section className="space-y-2 text-sm">
            <h2 className="font-medium">Linked apps</h2>
            <p className="text-xs text-zinc-500">
              Apps linked to this contract that you may read (RLS-scoped). Read-only — no
              linking/unlinking here.
            </p>
            {!linkedApps || !linkedApps.ok ? (
              <p className="text-zinc-600 dark:text-zinc-400">
                Could not load linked apps right now.
              </p>
            ) : linkedApps.data.length === 0 ? (
              <p className="text-zinc-600 dark:text-zinc-400">No linked apps you can access.</p>
            ) : (
              <ul className="list-inside list-disc">
                {linkedApps.data.map((app) => (
                  <li key={app.id}>
                    <Link href={`/apps/${app.id}`} className="underline">
                      {app.name}
                    </Link>
                    {app.vendorName ? (
                      <span className="text-zinc-500"> — {app.vendorName}</span>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
          </section>

          <p className="text-xs text-zinc-500">
            Invoices and files are not shown yet — those tables are default-deny and not safe to
            surface (RISK-002).
          </p>
        </>
      )}
    </main>
  );
}
