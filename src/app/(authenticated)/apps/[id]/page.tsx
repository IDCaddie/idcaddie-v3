import Link from "next/link";
import { getAppDetailForCurrentUser } from "@/lib/data/apps";

export const metadata = { title: "App · ID Caddie" };

// Read-only app detail (build-sequence Stage 4b). The [id] route param is ONLY a lookup key —
// RLS decides whether the signed-in user may read the row, so an id for another tenant's app
// returns the same "not found" as a non-existent id (no enumeration). No create/edit/delete, no
// users/contracts/invoices/files, no client filtering. Server-rendered.
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

          <p className="text-xs text-zinc-500">
            App users, linked contracts, invoices, files, and license rules are not shown yet.
          </p>
        </>
      )}
    </main>
  );
}
