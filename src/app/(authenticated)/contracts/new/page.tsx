import Link from "next/link";
import { listOrganizationsForCurrentUser } from "@/lib/data/organizations";
import { ContractForm } from "../contract-form";
import { emptyContractForm } from "../contract-form-shared";

export const metadata = { title: "New contract · ID Caddie" };

// Create-contract route (PR #31). Server-rendered shell + the RLS-scoped org list; the form
// (Client Component) posts to the PR #30 `createContractAction`. No authorization here — RLS decides
// whether the save lands. Deliberately NOT built: the legacy PDF-upload/AI-extraction tab, linked
// apps, files, invoices, delete (docs/15). Org names come from the user's own RLS-visible orgs only.
export default async function NewContractPage() {
  const orgsResult = await listOrganizationsForCurrentUser();
  const orgs = orgsResult.ok ? orgsResult.data : [];

  return (
    <main className="flex flex-1 flex-col gap-6 p-8">
      <header className="space-y-1">
        <div className="text-sm">
          <Link href="/contracts" className="text-zinc-500 hover:underline">
            ← Back to contracts
          </Link>
        </div>
        <h1 className="text-xl font-semibold">New contract</h1>
        <p className="text-sm text-zinc-600 dark:text-zinc-400">
          Create a contract. Write access is enforced by Postgres RLS — if you can’t save, you don’t
          have permission in this workspace. PDF upload / AI extraction, linked apps, invoices, files,
          and deletion are not part of this form.
        </p>
      </header>
      <div className="max-w-2xl">
        <ContractForm mode="create" initial={emptyContractForm()} orgs={orgs} />
      </div>
    </main>
  );
}
