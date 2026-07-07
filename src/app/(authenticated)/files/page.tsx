import Link from "next/link";
import { listFilesForCurrentUser, fileStatusLabel, formatFileSize } from "@/lib/data/files";

export const metadata = { title: "Files / Documents · ID Caddie" };

// Read-only Files / Documents view. It renders only what the user-scoped server DAL returns; RLS is the
// authorization boundary (`files` SELECT = tenant member). It shows safe file metadata (name, related
// contract, status, type, size, date) and links to the related contract — NO storage paths, object
// names, signed URLs, bucket internals, tenant ids, or secrets. Standalone upload/delete/export/
// open-download are NOT built here; contract-level attachment remains the implemented upload/open path.
export default async function FilesPage() {
  const result = await listFilesForCurrentUser();

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
          Read-only list of the contract files you may see (RLS-scoped). To upload or open a file, use
          its contract. There is no standalone upload, delete, export, or download here.
        </p>
      </header>

      {!result.ok ? (
        <p className="text-sm text-red-600">
          Could not load files right now. Please try again later.
        </p>
      ) : result.data.length === 0 ? (
        <div className="rounded border border-zinc-300 p-4 text-sm dark:border-zinc-700">
          <div className="font-medium">No files to show</div>
          <p className="mt-1 text-zinc-600 dark:text-zinc-400">
            No files are visible to you yet. Files are attached to a contract from its detail page.
          </p>
        </div>
      ) : (
        <section className="space-y-2 text-sm">
          <div className="text-zinc-500">
            {result.data.length} file{result.data.length === 1 ? "" : "s"} visible to you
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
                {result.data.map((f) => (
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
                    <td className="py-2 pr-4 text-zinc-600 dark:text-zinc-400">
                      {fileStatusLabel(f.uploadStatus)}
                    </td>
                    <td className="py-2 pr-4 text-zinc-600 dark:text-zinc-400">
                      {f.contentType ?? "—"}
                    </td>
                    <td className="py-2 pr-4 tabular-nums text-zinc-600 dark:text-zinc-400">
                      {formatFileSize(f.byteSize)}
                    </td>
                    <td className="py-2 pr-4 text-zinc-600 dark:text-zinc-400">
                      {f.createdAt.slice(0, 10)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="text-xs text-zinc-500">
            Open a file from its contract (the verified open path). No storage paths, object names, or
            signed URLs are shown here.
          </p>
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
