import Link from "next/link";
import { listAppsWithCountsForCurrentUser } from "@/lib/data/apps";

export const metadata = { title: "Apps · ID Caddie" };

// Read-only app inventory. It renders only what the user-scoped server DAL returns; RLS is the
// authorization boundary. Each row shows the app's name/vendor/category/status plus its RLS-scoped
// linked-contract + app-user counts (rows you may read — never an absolute total you can't see). No
// create/edit/delete, no import/export, no connector sync, no AI. Server-rendered. Search/sort beyond
// the server name-sort is a future enhancement.
export default async function AppsPage() {
  const result = await listAppsWithCountsForCurrentUser();

  return (
    <main className="flex flex-1 flex-col gap-6 p-8">
      <header className="space-y-1">
        <div className="text-sm">
          <Link href="/" className="text-zinc-500 hover:underline">
            ← Back
          </Link>
        </div>
        <h1 className="text-xl font-semibold">Apps</h1>
        <p className="text-sm text-zinc-600 dark:text-zinc-400">
          Read-only inventory of the apps you may see. Visibility is enforced by Postgres RLS — this
          page lists exactly what your tenant/org access allows. The contract/user counts are also
          RLS-scoped (only what you may read). No editing, importing, connector sync, or AI here yet.
        </p>
      </header>

      {!result.ok ? (
        <p className="text-sm text-red-600">
          Could not load apps right now. Please try again later.
        </p>
      ) : result.data.length === 0 ? (
        <div className="rounded border border-zinc-300 p-4 text-sm dark:border-zinc-700">
          <div className="font-medium">No apps to show</div>
          <p className="mt-1 text-zinc-600 dark:text-zinc-400">
            Your tenant has no apps visible to you yet — either none exist for your tenant or your
            tenant/org access does not include any. Apps are populated by an administrator or, later,
            by connectors (not built yet). For local development, seed sample data with{" "}
            <code className="rounded bg-zinc-100 px-1 dark:bg-zinc-800">
              bash scripts/seed-local-demo.sh
            </code>
            .
          </p>
        </div>
      ) : (
        <section className="space-y-2 text-sm">
          <div className="text-zinc-500">
            {result.data.length} app{result.data.length === 1 ? "" : "s"} visible to you
          </div>
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-left">
              <thead>
                <tr className="border-b border-zinc-300 text-zinc-500 dark:border-zinc-700">
                  <th className="py-2 pr-4 font-medium">Name</th>
                  <th className="py-2 pr-4 font-medium">Vendor</th>
                  <th className="py-2 pr-4 font-medium">Category</th>
                  <th className="py-2 pr-4 font-medium">Status</th>
                  <th className="py-2 pr-4 text-right font-medium" title="Linked contracts you may read">
                    Contracts
                  </th>
                  <th className="py-2 pr-4 text-right font-medium" title="App users you may read">
                    Users
                  </th>
                </tr>
              </thead>
              <tbody>
                {result.data.map((app) => (
                  <tr key={app.id} className="border-b border-zinc-200 dark:border-zinc-800">
                    <td className="py-2 pr-4 font-medium">
                      <Link href={`/apps/${app.id}`} className="underline">
                        {app.name}
                      </Link>
                    </td>
                    <td className="py-2 pr-4 text-zinc-600 dark:text-zinc-400">
                      {app.vendorName ?? "—"}
                    </td>
                    <td className="py-2 pr-4 text-zinc-600 dark:text-zinc-400">
                      {app.category ?? "—"}
                    </td>
                    <td className="py-2 pr-4">
                      <span className="rounded-full border border-zinc-300 px-2 py-0.5 text-xs text-zinc-600 dark:border-zinc-700 dark:text-zinc-400">
                        {app.status}
                      </span>
                    </td>
                    <td className="py-2 pr-4 text-right tabular-nums text-zinc-600 dark:text-zinc-400">
                      {app.linkedContractCount}
                    </td>
                    <td className="py-2 pr-4 text-right tabular-nums text-zinc-600 dark:text-zinc-400">
                      {app.appUserCount}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="text-xs text-zinc-500">
            Counts are “visible to you” (RLS-scoped), not absolute totals. Connector-synced inventory,
            spend/license intelligence, imports, exports, and reports are not built yet.
          </p>
        </section>
      )}
    </main>
  );
}
