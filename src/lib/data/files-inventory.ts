import type { FileSummary } from "./files";

// Pure search / filter / sort over the ALREADY-FETCHED, RLS-scoped /files rows. NO DB, no new query, type-only import
// (no DAL dependency). Operates ONLY on safe display fields (filename / contract name / content type / upload status /
// byte size / created date) — never storage paths, ids, hashes, tenant_id, uploaded_by, or secrets.
export type FileFilter = "uploaded" | "pending" | "failed" | "has_contract" | "no_contract";
export type FileSort = "newest" | "oldest" | "largest" | "smallest" | "name";
export type FileInventoryOpts = { q?: string; filters?: readonly FileFilter[]; sort?: FileSort };

export const FILE_FILTERS: readonly FileFilter[] = ["uploaded", "pending", "failed", "has_contract", "no_contract"];
export const FILE_SORTS: readonly FileSort[] = ["newest", "oldest", "largest", "smallest", "name"];
const STATUS_FILTERS: readonly FileFilter[] = ["uploaded", "pending", "failed"];

export function isFileFilter(v: string): v is FileFilter {
  return (FILE_FILTERS as readonly string[]).includes(v);
}
export function isFileSort(v: string): v is FileSort {
  return (FILE_SORTS as readonly string[]).includes(v);
}

// Search matches filename / contract name / content type / raw upload status (case-insensitive). Status filters OR
// among the selected statuses; contract filters AND. Pure; stable filename tie-break. `now` not needed (dates are ISO).
export function filterSortFiles<T extends FileSummary>(rows: readonly T[], opts: FileInventoryOpts): T[] {
  const q = (opts.q ?? "").trim().toLowerCase();
  const active = new Set(opts.filters ?? []);
  const statusSel = STATUS_FILTERS.filter((s) => active.has(s));

  const filtered = rows.filter((r) => {
    if (q) {
      const hay = `${r.filename} ${r.contractName ?? ""} ${r.contentType ?? ""} ${r.uploadStatus}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    if (statusSel.length > 0 && !statusSel.includes(r.uploadStatus as FileFilter)) return false;
    if (active.has("has_contract") && !r.contractId) return false;
    if (active.has("no_contract") && r.contractId) return false;
    return true;
  });

  const size = (r: T) => (r.byteSize == null ? -1 : r.byteSize);
  const sort = opts.sort ?? "newest";
  return [...filtered].sort((a, b) => {
    switch (sort) {
      case "oldest":
        return a.createdAt.localeCompare(b.createdAt) || a.filename.localeCompare(b.filename);
      case "largest":
        return size(b) - size(a) || a.filename.localeCompare(b.filename);
      case "smallest":
        return size(a) - size(b) || a.filename.localeCompare(b.filename);
      case "name":
        return a.filename.localeCompare(b.filename);
      case "newest":
      default:
        return b.createdAt.localeCompare(a.createdAt) || a.filename.localeCompare(b.filename);
    }
  });
}
