import Link from "next/link";
import { listAppsForCurrentUser } from "@/lib/data/apps";

export const metadata = { title: "Apps · ID Caddie" };

// Read-only app inventory (build-sequence Stage 4) — the first real product surface. It renders
// only what the user-scoped server DAL returns; RLS is the authorization boundary. No create/edit/
// delete, no import/export, no app-detail, no contracts UI. Server-rendered; no client filtering.
export default async function AppsPage() {
  const result = await listAppsForCurrentUser();

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
          page lists exactly what your tenant/org access allows. No editing here yet.
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
            Your tenant has no apps visible to you yet. For local development, seed sample data with{" "}
            <code className="rounded bg-zinc-100 px-1 dark:bg-zinc-800">
              bash scripts/seed-local-demo.sh
            </code>
            .
          </p>
        </div>
      ) : (
        <section className="space-y-2 text-sm">
          <div className="text-zinc-500">
            {result.data.length} app{result.data.length === 1 ? "" : "s"}
          </div>
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-left">
              <thead>
                <tr className="border-b border-zinc-300 text-zinc-500 dark:border-zinc-700">
                  <th className="py-2 pr-4 font-medium">Name</th>
                  <th className="py-2 pr-4 font-medium">Vendor</th>
                  <th className="py-2 pr-4 font-medium">Category</th>
                  <th className="py-2 pr-4 font-medium">Status</th>
                </tr>
              </thead>
              <tbody>
                {result.data.map((app) => (
                  <tr
                    key={app.id}
                    className="border-b border-zinc-200 dark:border-zinc-800"
                  >
                    <td className="py-2 pr-4 font-medium">{app.name}</td>
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
