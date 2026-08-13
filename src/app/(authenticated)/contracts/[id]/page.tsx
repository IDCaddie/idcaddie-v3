import Link from "next/link";
import { getContractDetailForCurrentUser } from "@/lib/data/contracts";
import { listContractFilesForCurrentUser } from "@/lib/data/contract-files";
import { listAppsLinkedToContract } from "@/lib/data/links";
import { formatMoney } from "@/lib/data/dashboard-overview";
import { contractAttentionFlags } from "@/lib/data/contract-attention";
import { listOrganizationsForCurrentUser } from "@/lib/data/organizations";
import { buildOrgNameLookup, orgDisplayName } from "@/lib/data/organization-display";
import { loadContractCommercialView } from "@/lib/data/commercial-loader";
import { ContractFiles } from "./contract-files";
import { EntitlementsPanel } from "./entitlements-panel";

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
  const files = result.ok ? await listContractFilesForCurrentUser(id) : null;
  // RLS-visible organizations (id+name only) → id-to-name lookup for safe org display (never a raw UUID).
  const orgs = result.ok ? await listOrganizationsForCurrentUser() : null;
  const orgLookup = buildOrgNameLookup(orgs && orgs.ok ? orgs.data : []);

  // Phase 10 — the commercial view. It is passed the contract facts this page has ALREADY fetched rather than re-reading
  // them, the same discipline Phase 7A's Home follows: a projection of a result we were paying for anyway.
  const commercial = result.ok
    ? await loadContractCommercialView({
        id: result.data.id,
        renewalDate: result.data.renewalDate,
        endDate: result.data.endDate,
        noticeDeadline: result.data.noticeDeadline,
        autoRenew: result.data.autoRenew,
      })
    : null;

  // hasLinkedApp: true = ≥1 linked app, false = known-none, null = unknown (read failed) → not flagged.
  const hasLinkedApp = linkedApps && linkedApps.ok ? linkedApps.data.length > 0 : null;
  const flags = result.ok
    ? contractAttentionFlags(
        {
          renewalDate: result.data.renewalDate,
          endDate: result.data.endDate,
          hasOwner: result.data.hasOwner,
          hasLinkedApp,
        },
        new Date(),
      )
    : [];

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
              Contract detail. You can edit the fields below and attach PDF documents.
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
                  : formatMoney(result.data.totalCost, result.data.currency ?? "unspecified")
              }
            />
            <Field label="Billing frequency" value={result.data.billingFrequency ?? "—"} />
            <Field
              label="Renewal responsibility"
              value={result.data.renewalResponsibility ?? "—"}
            />
            <Field label="Owner assigned" value={result.data.hasOwner ? "Yes" : "No"} />
            <Field label="Category" value={result.data.category ?? "—"} />
            <Field label="Procurement date" value={result.data.procurementDate ?? "—"} />
            <Field label="PO number" value={result.data.poNumber ?? "—"} />
            <Field label="Auto renew" value={result.data.autoRenew ? "Yes" : "No"} />
            <Field label="Month-to-month" value={result.data.monthToMonth ? "Yes" : "No"} />
          </section>

          {flags.length > 0 ? (
            <section className="space-y-2 text-sm">
              <h2 className="font-medium">Needs attention</h2>
              <ul className="flex flex-wrap gap-2">
                {flags.map((f) => (
                  <li key={f.key}>
                    <span className="rounded-full border border-amber-500 px-2 py-0.5 text-xs text-amber-700 dark:text-amber-400">
                      {f.label}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          {result.data.notes ? (
            <section className="space-y-1 text-sm">
              <div className="text-zinc-500">Notes</div>
              <p className="whitespace-pre-wrap font-medium">{result.data.notes}</p>
            </section>
          ) : null}

          <section className="space-y-2 text-sm">
            <h2 className="font-medium">Ownership</h2>
            <p className="text-xs text-zinc-500">
              Organizations shown by name where you have access, otherwise “Assigned”.
            </p>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Field label="Procurement org" value={orgDisplayName(result.data.procurementOrgId, orgLookup)} />
              <Field label="Paying org" value={orgDisplayName(result.data.payingOrgId, orgLookup)} />
            </div>
          </section>

          <section className="grid grid-cols-1 gap-4 text-sm sm:grid-cols-2">
            <Field label="Created" value={result.data.createdAt.slice(0, 10)} />
            <Field label="Updated" value={result.data.updatedAt.slice(0, 10)} />
          </section>

          <section className="space-y-2 text-sm">
            <h2 className="font-medium">Linked apps</h2>
            <p className="text-xs text-zinc-500">
              Applications linked to this contract.
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

          <EntitlementsPanel view={commercial && commercial.ok ? commercial.data : null} />

          <ContractFiles
            contractId={result.data.id}
            files={files?.ok ? files.data : []}
            listError={!files || !files.ok}
          />

          <p className="text-xs text-zinc-500">
            Invoices are not part of this view
            (RISK-002).
          </p>
        </>
      )}
    </main>
  );
}
