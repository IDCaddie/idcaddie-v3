import Link from "next/link";
import { listContractsForCurrentUser } from "@/lib/data/contracts";

export const metadata = { title: "Contracts · ID Caddie" };

// Read-only contracts list (build-sequence Stage 5 — read-only slice). Renders only what the
// user-scoped server DAL returns; RLS is the authorization boundary (tenant members + related
// procurement/paying org). No create/edit/delete, no import/export, no file upload, no invoices,
// no linked-apps column here (the list stays minimal; linked apps appear read-only on the detail
// page via 0006 org-scoped app_contracts read). Server-rendered; no client filtering. Dynamic via
// cookies() in the server client (like /apps).
export default async function ContractsPage() {
  const result = await listContractsForCurrentUser();

  return (
    <main className="flex flex-1 flex-col gap-6 p-8">
      <header className="space-y-1">
        <div className="text-sm">
          <Link href="/" className="text-zinc-500 hover:underline">
            ← Back
          </Link>
        </div>
        <h1 className="text-xl font-semibold">Contracts</h1>
        <p className="text-sm text-zinc-600 dark:text-zinc-400">
          Read-only list of the contracts you may see. Visibility is enforced by Postgres RLS — this
          page lists exactly what your tenant/related-org access allows. No editing here yet; linked
          apps, invoices, and files are deferred.
        </p>
      </header>

      {!result.ok ? (
        <p className="text-sm text-red-600">
          Could not load contracts right now. Please try again later.
        </p>
      ) : result.data.length === 0 ? (
        <div className="rounded border border-zinc-300 p-4 text-sm dark:border-zinc-700">
          <div className="font-medium">No contracts to show</div>
          <p className="mt-1 text-zinc-600 dark:text-zinc-400">
            Your tenant has no contracts visible to you yet. For local development, seed sample data
            with{" "}
            <code className="rounded bg-zinc-100 px-1 dark:bg-zinc-800">
              bash scripts/seed-local-demo.sh
            </code>
            .
          </p>
        </div>
      ) : (
        <section className="space-y-2 text-sm">
          <div className="text-zinc-500">
            {result.data.length} contract{result.data.length === 1 ? "" : "s"}
          </div>
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-left">
              <thead>
                <tr className="border-b border-zinc-300 text-zinc-500 dark:border-zinc-700">
                  <th className="py-2 pr-4 font-medium">Name</th>
                  <th className="py-2 pr-4 font-medium">Vendor</th>
                  <th className="py-2 pr-4 font-medium">Status</th>
                  <th className="py-2 pr-4 font-medium">Renewal</th>
                  <th className="py-2 pr-4 font-medium">End</th>
                </tr>
              </thead>
              <tbody>
                {result.data.map((contract) => (
                  <tr
                    key={contract.id}
                    className="border-b border-zinc-200 dark:border-zinc-800"
                  >
                    <td className="py-2 pr-4 font-medium">
                      <Link href={`/contracts/${contract.id}`} className="underline">
                        {contract.contractName}
                      </Link>
                    </td>
                    <td className="py-2 pr-4 text-zinc-600 dark:text-zinc-400">
                      {contract.vendorName ?? "—"}
                    </td>
                    <td className="py-2 pr-4">
                      <span className="rounded-full border border-zinc-300 px-2 py-0.5 text-xs text-zinc-600 dark:border-zinc-700 dark:text-zinc-400">
                        {contract.status}
                      </span>
                    </td>
                    <td className="py-2 pr-4 text-zinc-600 dark:text-zinc-400">
                      {contract.renewalDate ?? "—"}
                    </td>
                    <td className="py-2 pr-4 text-zinc-600 dark:text-zinc-400">
                      {contract.endDate ?? "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </main>
  );
}
