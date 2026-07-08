import Link from "next/link";
import { listFilesForCurrentUser, fileStatusLabel, formatFileSize } from "@/lib/data/files";
import { Badge } from "@/components/badge";
import { statusColor } from "@/components/status-tokens";
import { summarizeFiles } from "@/lib/data/files-summary";
import { StatCard, StatGrid } from "@/components/stat-card";
import {
  filterSortFiles,
  isFileFilter,
  isFileSort,
  type FileFilter,
  type FileSort,
} from "@/lib/data/files-inventory";

export const metadata = { title: "Files / Documents · ID Caddie" };

const FILTER_LABEL: Record<FileFilter, string> = {
  uploaded: "Uploaded",
  pending: "Pending",
  failed: "Failed",
  has_contract: "Has contract",
  no_contract: "No contract",
};
const SORT_LABEL: Record<FileSort, string> = {
  newest: "Newest",
  oldest: "Oldest",
  largest: "Largest",
  smallest: "Smallest",
  name: "Name A–Z",
};

// Read-only Files / Documents view. It renders only what the user-scoped server DAL returns; RLS is the
// authorization boundary (`files` SELECT = tenant member). It shows safe file metadata (name, related
// contract, status, type, size, date) and links to the related contract — NO storage paths, object
// names, signed URLs, bucket internals, tenant ids, or secrets. Search/filter/sort run SERVER-SIDE over
// the rows the user may ALREADY read (no new query, no client-supplied tenant filter). Standalone
// upload/delete/export/open-download are NOT built here; contract-level attachment remains the path.
export default async function FilesPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const sp = await searchParams;
  const q = typeof sp.q === "string" ? sp.q : "";
  const filters: FileFilter[] = (Array.isArray(sp.filter) ? sp.filter : sp.filter ? [sp.filter] : []).filter(isFileFilter);
  const sort: FileSort = typeof sp.sort === "string" && isFileSort(sp.sort) ? sp.sort : "newest";

  const result = await listFilesForCurrentUser();
  const rows = result.ok ? filterSortFiles(result.data, { q, filters, sort }) : [];

  // Build a URL that toggles a filter or sets a sort, preserving the current search text + other state.
  const hrefWith = (over: { filter?: FileFilter; sort?: FileSort }) => {
    const params = new URLSearchParams();
    if (q) params.set("q", q);
    const f = new Set(filters);
    if (over.filter) {
      if (f.has(over.filter)) f.delete(over.filter);
      else f.add(over.filter);
    }
    for (const x of f) params.append("filter", x);
    params.set("sort", over.sort ?? sort);
    return `/files?${params.toString()}`;
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
        <h1 className="text-xl font-semibold">Files / Documents</h1>
        <p className="text-sm text-zinc-600 dark:text-zinc-400">
          Read-only list of the contract files you may see (RLS-scoped). Search, filters, and sort operate over
          exactly those rows. To upload or open a file, use its contract. There is no standalone upload, delete,
          export, or download here.
        </p>
      </header>

      {!result.ok ? (
        <p className="text-sm text-red-600">Could not load files right now. Please try again later.</p>
      ) : result.data.length === 0 ? (
        <div className="rounded border border-zinc-300 p-4 text-sm dark:border-zinc-700">
          <div className="font-medium">No files to show</div>
          <p className="mt-1 text-zinc-600 dark:text-zinc-400">
            No files are visible to you yet. Files are attached to a contract from its detail page.
          </p>
        </div>
      ) : (
        <section className="space-y-3 text-sm">
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <form method="get" action="/files" className="flex gap-2">
              <input
                type="search"
                name="q"
                defaultValue={q}
                placeholder="Search name, contract, or type"
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
            {(["uploaded", "pending", "failed", "has_contract", "no_contract"] as FileFilter[]).map((f) => (
              <Link key={f} href={hrefWith({ filter: f })} className={pill(filters.includes(f))}>
                {FILTER_LABEL[f]}
              </Link>
            ))}
            <span className="ml-2 text-zinc-500">Sort:</span>
            {(["newest", "oldest", "largest", "smallest", "name"] as FileSort[]).map((s) => (
              <Link key={s} href={hrefWith({ sort: s })} className={pill(sort === s)}>
                {SORT_LABEL[s]}
              </Link>
            ))}
            {q || filters.length > 0 || sort !== "newest" ? (
              <Link href="/files" className="text-xs text-zinc-500 underline">
                clear
              </Link>
            ) : null}
          </div>

          {(() => {
            const stats = summarizeFiles(rows);
            return (
              <>
                <StatGrid>
                  <StatCard label="Total files" value={stats.total} sub={`${stats.distinctTypes} type${stats.distinctTypes === 1 ? "" : "s"}`} />
                  <StatCard label="Uploaded" value={stats.uploaded} tone="success" />
                  <StatCard label="Pending" value={stats.pending} tone={stats.pending > 0 ? "attention" : "neutral"} />
                  <StatCard label="Failed" value={stats.failed} tone={stats.failed > 0 ? "danger" : "success"} />
                  <StatCard label="Total size" value={formatFileSize(stats.totalBytes)} />
                </StatGrid>
                <p className="text-xs text-zinc-500">
                  KPIs reflect the rows currently shown. File metadata only (upload status, type, size) — no file
                  content, extraction, or AI analysis.
                </p>
              </>
            );
          })()}

          {rows.length === 0 ? (
            <div className="rounded border border-zinc-300 p-4 text-sm dark:border-zinc-700">
              <div className="font-medium">No files match your search/filters</div>
              <p className="mt-1 text-zinc-600 dark:text-zinc-400">
                {result.data.length} file{result.data.length === 1 ? "" : "s"} visible to you — adjust the search or
                filters above, or <Link href="/files" className="underline">clear them</Link>.
              </p>
            </div>
          ) : (
            <>
              <div className="text-zinc-500">
                {rows.length} of {result.data.length} file{result.data.length === 1 ? "" : "s"} visible to you
              </div>
              <div className="overflow-x-auto">
                <table className="w-full border-collapse text-left">
                  <thead>
                    <tr className="border-b border-zinc-300 text-zinc-500 dark:border-zinc-700">
                      <th className="py-2 pr-4 font-medium">File</th>
                      <th className="py-2 pr-4 font-medium">Contract</th>
                      <th className="py-2 pr-4 font-medium">Status</th>
                      <th className="py-2 pr-4 font-medium">Type</th>
                      <th className="py-2 pr-4 font-medium">Size</th>
                      <th className="py-2 pr-4 font-medium">Added</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((f) => (
                      <tr key={f.id} className="border-b border-zinc-200 dark:border-zinc-800">
                        <td className="py-2 pr-4 font-medium">{f.filename}</td>
                        <td className="py-2 pr-4">
                          {f.contractId && f.contractName ? (
                            <Link href={`/contracts/${f.contractId}`} className="underline">
                              {f.contractName}
                            </Link>
                          ) : (
                            <span className="text-zinc-500">—</span>
                          )}
                        </td>
                        <td className="py-2 pr-4">
                          <Badge tone={statusColor(f.uploadStatus)}>{fileStatusLabel(f.uploadStatus)}</Badge>
                        </td>
                        <td className="py-2 pr-4">
                          {f.contentType ? (
                            <Badge tone="neutral">{f.contentType}</Badge>
                          ) : (
                            <span className="text-zinc-500">—</span>
                          )}
                        </td>
                        <td className="py-2 pr-4 tabular-nums text-zinc-600 dark:text-zinc-400">
                          {formatFileSize(f.byteSize)}
                        </td>
                        <td className="py-2 pr-4 text-zinc-600 dark:text-zinc-400">{f.createdAt.slice(0, 10)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="text-xs text-zinc-500">
                Open a file from its contract (the verified open path). No storage paths, object names, or
                signed URLs are shown here.
              </p>
            </>
          )}
        </section>
      )}

      <section className="space-y-2 text-sm">
        <h2 className="font-medium">File actions</h2>
        <p className="text-xs text-zinc-500">
          These standalone file capabilities are not implemented in v3 yet — shown so the gap is
          explicit, not hidden. This surface is read-only.
        </p>
        <ul className="flex flex-wrap gap-2">
          {[
            "Standalone upload",
            "Standalone open / download",
            "Delete",
            "Export",
            "Connector ingestion",
            "AI document analysis",
          ].map((label) => (
            <li key={label}>
              <span
                aria-disabled="true"
                title="Not built yet"
                className="inline-flex items-center gap-2 rounded border border-zinc-300 px-2.5 py-1 text-xs text-zinc-400 dark:border-zinc-700"
              >
                {label}
                <span className="rounded-full border border-zinc-300 px-1.5 text-[10px] dark:border-zinc-700">
                  Not built yet
                </span>
              </span>
            </li>
          ))}
        </ul>
      </section>
    </main>
  );
}
