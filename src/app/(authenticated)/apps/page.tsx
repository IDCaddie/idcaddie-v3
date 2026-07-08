import Link from "next/link";
import { listAppsWithCountsForCurrentUser } from "@/lib/data/apps";
import {
  filterSortApps,
  appChips,
  isAppFilter,
  isAppSort,
  type AppFilter,
  type AppSort,
} from "@/lib/data/apps-inventory";
import { ExportCsvButton } from "./export-csv-button";
import { StatusBadge } from "@/components/badge";

export const metadata = { title: "Apps · ID Caddie" };

// Read-only app inventory. It renders only what the user-scoped server DAL returns; RLS is the
// authorization boundary. Search/filter/sort run SERVER-SIDE over the rows the user may ALREADY read
// (no new query, no client-supplied tenant filter). Counts/owner are RLS-scoped booleans; no raw owner
// ids, no connector sync, no AI.
function Chip({ label }: { label: string }) {
  return (
    <span className="ml-2 rounded-full border border-zinc-400 px-1.5 py-0.5 text-[10px] text-zinc-500">{label}</span>
  );
}

export default async function AppsPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const sp = await searchParams;
  const q = typeof sp.q === "string" ? sp.q : "";
  const filters: AppFilter[] = (Array.isArray(sp.filter) ? sp.filter : sp.filter ? [sp.filter] : []).filter(isAppFilter);
  const sort: AppSort = typeof sp.sort === "string" && isAppSort(sp.sort) ? sp.sort : "name";

  const result = await listAppsWithCountsForCurrentUser();
  const rows = result.ok ? filterSortApps(result.data, { q, filters, sort }) : [];

  // CSV export = the SAME filtered/sorted rows, projected to safe display columns ONLY (no id/raw fields).
  const exportHeaders = ["Name", "Vendor", "Category", "Status", "Linked contracts", "App users", "Owner assigned"];
  const exportRows = rows.map((a) => [
    a.name,
    a.vendorName ?? "",
    a.category ?? "",
    a.status,
    String(a.linkedContractCount),
    String(a.appUserCount),
    a.hasOwner ? "Yes" : "No",
  ]);

  // Build a URL that toggles a filter or sets a sort, preserving the current search text + other state.
  const hrefWith = (over: { filter?: AppFilter; sort?: AppSort }) => {
    const params = new URLSearchParams();
    if (q) params.set("q", q);
    const f = new Set(filters);
    if (over.filter) {
      if (f.has(over.filter)) f.delete(over.filter);
      else f.add(over.filter);
    }
    for (const x of f) params.append("filter", x);
    params.set("sort", over.sort ?? sort);
    return `/apps?${params.toString()}`;
  };
  const pill = (active: boolean) =>
    `rounded-full border px-2 py-0.5 text-xs ${active ? "border-amber-500 text-amber-700 dark:text-amber-400" : "border-zinc-300 text-zinc-500 dark:border-zinc-700"}`;

  return (
    <main className="flex flex-1 flex-col gap-6 p-8">
      <header className="space-y-1">
        <div className="text-sm">
          <Link href="/dashboards" className="text-zinc-500 hover:underline">
            ← Back
          </Link>
        </div>
        <h1 className="text-xl font-semibold">Apps</h1>
        <p className="text-sm text-zinc-600 dark:text-zinc-400">
          Read-only inventory of the apps you may see (RLS-scoped). Search, filters, and sort operate over
          exactly those rows. Contract/user counts and owner presence are RLS-scoped; no raw owner ids.
        </p>
      </header>

      {result.ok ? (
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <form method="get" action="/apps" className="flex gap-2">
            <input
              type="search"
              name="q"
              defaultValue={q}
              placeholder="Search name or vendor"
              className="rounded border border-zinc-300 px-2 py-1 text-sm dark:border-zinc-700 dark:bg-zinc-900"
            />
            {filters.map((f) => (
              <input key={f} type="hidden" name="filter" value={f} />
            ))}
            <input type="hidden" name="sort" value={sort} />
            <button type="submit" className="rounded border border-zinc-300 px-2 py-1 dark:border-zinc-700">
              Search
            </button>
          </form>
          <span className="text-zinc-500">Filter:</span>
          <Link href={hrefWith({ filter: "missing_owner" })} className={pill(filters.includes("missing_owner"))}>
            Missing owner
          </Link>
          <Link href={hrefWith({ filter: "missing_contract" })} className={pill(filters.includes("missing_contract"))}>
            Missing contract
          </Link>
          <span className="ml-2 text-zinc-500">Sort:</span>
          {(["name", "status", "users"] as AppSort[]).map((s) => (
            <Link key={s} href={hrefWith({ sort: s })} className={pill(sort === s)}>
              {s}
            </Link>
          ))}
          {(q || filters.length > 0 || sort !== "name") ? (
            <Link href="/apps" className="text-xs text-zinc-500 underline">
              clear
            </Link>
          ) : null}
          {rows.length > 0 ? (
            <span className="ml-auto flex items-center gap-2">
              <ExportCsvButton headers={exportHeaders} rows={exportRows} filename="apps-export.csv" />
              <span className="text-xs text-zinc-400">
                Exports the rows currently shown with safe display columns only.
              </span>
            </span>
          ) : null}
        </div>
      ) : null}

      {!result.ok ? (
        <p className="text-sm text-red-600">Could not load apps right now. Please try again later.</p>
      ) : result.data.length === 0 ? (
        <div className="rounded border border-zinc-300 p-4 text-sm dark:border-zinc-700">
          <div className="font-medium">No apps to show</div>
          <p className="mt-1 text-zinc-600 dark:text-zinc-400">
            Your tenant has no apps visible to you yet. For local development, seed sample data with{" "}
            <code className="rounded bg-zinc-100 px-1 dark:bg-zinc-800">bash scripts/seed-local-demo.sh</code>.
          </p>
        </div>
      ) : rows.length === 0 ? (
        <div className="rounded border border-zinc-300 p-4 text-sm dark:border-zinc-700">
          <div className="font-medium">No apps match your search/filters</div>
          <p className="mt-1 text-zinc-600 dark:text-zinc-400">
            {result.data.length} app{result.data.length === 1 ? "" : "s"} visible to you — adjust the search or
            filters above, or <Link href="/apps" className="underline">clear them</Link>.
          </p>
        </div>
      ) : (
        <section className="space-y-2 text-sm">
          <div className="text-zinc-500">
            {rows.length} of {result.data.length} app{result.data.length === 1 ? "" : "s"} visible to you
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
                {rows.map((app) => (
                  <tr key={app.id} className="border-b border-zinc-200 dark:border-zinc-800">
                    <td className="py-2 pr-4 font-medium">
                      <Link href={`/apps/${app.id}`} className="underline">
                        {app.name}
                      </Link>
                      {appChips(app).map((c) => (
                        <Chip key={c.key} label={c.label} />
                      ))}
                    </td>
                    <td className="py-2 pr-4 text-zinc-600 dark:text-zinc-400">{app.vendorName ?? "—"}</td>
                    <td className="py-2 pr-4 text-zinc-600 dark:text-zinc-400">{app.category ?? "—"}</td>
                    <td className="py-2 pr-4">
                      <StatusBadge value={app.status} />
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
            Counts and owner presence are “visible to you” (RLS-scoped), not absolute totals. Connector-synced
            inventory, spend/license intelligence, imports, and exports are not built yet.
          </p>
        </section>
      )}
    </main>
  );
}
