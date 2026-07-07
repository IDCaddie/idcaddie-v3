"use client";
import { toCsv } from "@/lib/data/to-csv";

// Client "Export CSV" button for the Apps inventory. It receives ONLY pre-projected, safe display data
// (headers + already-stringified rows built server-side) — never a source DTO, never an id/tenant/org/owner
// id, never a secret/token field. It does NO data fetching; it only serializes what it is given and triggers
// a Blob download. So the client can leak nothing the server did not already render.
export function ExportCsvButton({
  headers,
  rows,
  filename,
}: {
  headers: string[];
  rows: string[][];
  filename: "apps-export.csv";
}) {
  const download = () => {
    const blob = new Blob([toCsv(headers, rows)], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  };
  return (
    <button
      type="button"
      onClick={download}
      title="Exports the rows currently shown with safe display columns only."
      className="rounded border border-zinc-300 px-2 py-1 text-sm dark:border-zinc-700"
    >
      Export CSV
    </button>
  );
}
