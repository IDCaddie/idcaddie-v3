import { loadIdentityAccessDetail } from "@/lib/data/access-loaders";
import { parseAccessFilters, filterIdentityApplications } from "@/lib/data/access-filters";
import { buildIdentityAccessCsv, csvResponse, exportError, exportFilename, EXPORT_ROW_CAP } from "@/lib/data/access-export";

// Read-only bounded CSV export of one identity's effective application access (Phase 15 Part 2 PR D). Same loader + owner/admin gate as the
// identity detail page; the [id] is only a lookup key, so a foreign/missing/unauthorized id returns the SAME 404 (no existence disclosure).
// Same filters as the page; refuses when the subgraph is too large or above the row cap. Private, no-store, nosniff. No id/raw evidence out.
export const dynamic = "force-dynamic";

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const filters = parseAccessFilters(Object.fromEntries(new URL(request.url).searchParams));
  const result = await loadIdentityAccessDetail(id, filters.includeStale);
  if (!result.ok) return result.error === "not_found" ? exportError(404, "Not found.") : exportError(503, "Could not load this right now. Please try again later.");
  if (result.data.bounded) return exportError(409, "Export is unavailable because this identity’s access graph is too large to evaluate within the current safety limits.");
  const filtered = filterIdentityApplications(result.data.applications, filters);
  if (filtered.length > EXPORT_ROW_CAP) {
    return exportError(413, `This export has ${filtered.length.toLocaleString()} rows, above the ${EXPORT_ROW_CAP.toLocaleString()}-row limit. Narrow the filters and try again.`);
  }
  const date = new Date().toISOString().slice(0, 10);
  return csvResponse(buildIdentityAccessCsv(result.data.displayName, result.data.providerLabel, filtered), exportFilename("identity-access", date));
}
