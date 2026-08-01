import Link from "next/link";
import { getContractDetailForCurrentUser } from "@/lib/data/contracts";
import { listOrganizationsForCurrentUser } from "@/lib/data/organizations";
import { ContractForm } from "../../contract-form";
import { contractDetailToForm } from "../../contract-form-shared";

export const metadata = { title: "Edit contract · ID Caddie" };

// Edit-contract route (PR #31). v3 uses a dedicated /edit route; legacy edited inline on the detail
// page (docs/15 §2) — same workflow, different placement. The [id] param is only a lookup key: the
// read DAL is RLS-scoped, so a contract you can't see returns the same "not found" as a non-existent
// id (no enumeration). Prefill comes from the read DTO; READ access does not imply WRITE access — a
// denied save is reported generically by the form (RLS is the boundary). No delete/archive, no linked
// apps/files here.
export default async function EditContractPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const result = await getContractDetailForCurrentUser(id);
  const orgsResult = await listOrganizationsForCurrentUser();
  const orgs = orgsResult.ok ? orgsResult.data : [];

  return (
    <main className="flex flex-1 flex-col gap-6 p-8">
      <div className="text-sm">
        <Link
          href={result.ok ? `/contracts/${id}` : "/contracts"}
          className="text-zinc-500 hover:underline"
        >
          ← Back
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
            <h1 className="text-xl font-semibold">Edit {result.data.contractName}</h1>
            <p className="text-sm text-zinc-600 dark:text-zinc-400">
              Edit this contract. You need edit permission in this workspace to save.
            </p>
          </header>
          <div className="max-w-2xl">
            <ContractForm
              mode="edit"
              contractId={id}
              initial={contractDetailToForm(result.data)}
              orgs={orgs}
            />
          </div>
        </>
      )}
    </main>
  );
}
