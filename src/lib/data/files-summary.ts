import type { FileSummary } from "./files";

// Pure summary over the ALREADY-FETCHED /files rows — NO DB, no new query, no widened projection. File METADATA only
// (upload_status/byte_size/content_type already on each row); NO storage paths, object names, file bytes/content, or
// secrets. The real upload_status enum is pending/uploaded/failed.
export type FileSummaryStats = {
  total: number;
  uploaded: number;
  pending: number;
  failed: number;
  totalBytes: number; // sum of non-null, non-negative byteSize; format at the view with the existing formatFileSize
  distinctTypes: number;
};

export function summarizeFiles(rows: readonly FileSummary[]): FileSummaryStats {
  let uploaded = 0;
  let pending = 0;
  let failed = 0;
  let totalBytes = 0;
  const types = new Set<string>();

  for (const f of rows) {
    if (f.uploadStatus === "uploaded") uploaded++;
    else if (f.uploadStatus === "pending") pending++;
    else if (f.uploadStatus === "failed") failed++;
    if (f.byteSize != null && f.byteSize > 0) totalBytes += f.byteSize;
    if (f.contentType) types.add(f.contentType);
  }

  return { total: rows.length, uploaded, pending, failed, totalBytes, distinctTypes: types.size };
}
