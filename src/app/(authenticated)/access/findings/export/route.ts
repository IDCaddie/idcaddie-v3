import { loadAccessOverview } from "@/lib/data/access-loaders";
import { parseAccessFilters, filterFindings } from "@/lib/data/access-filters";
import { buildFindingsCsv, csvResponse, exportError, exportFilename, EXPORT_ROW_CAP } from "@/lib/data/access-export";

// Read-only bounded CSV export of governance findings (Phase 15 Part 2 PR D). Authorization is IDENTICAL to the /access/findings page:
// it calls the same server-only loader (owner/admin gate via accessGate → the 0061 RPCs; canonical tables stay deny-all). No mutation, no
// service-role, no browser RPC. Uses the SAME filters as the page. Exports ONLY when the whole-graph evaluation is complete; refuses (never
// truncates) above the row cap. Private, no-store, nosniff, attachment. No external/canonical/tenant id or raw evidence in the output.
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const filters = parseAccessFilters(Object.fromEntries(new URL(request.url).searchParams));
  const result = await loadAccessOverview(filters.includeStale, filters.connectionId);
  if (!result.ok) return result.error === "forbidden" ? exportError(403, "Not available.") : exportError(503, "Access data could not be loaded. Please try again later.");
  if (result.data.status !== "complete") {
    return exportError(409, "Export is unavailable while the full access graph cannot be evaluated within the current safety limits. Open a specific identity or application instead.");
  }
  const filtered = filterFindings(result.data.findings, filters);
  if (filtered.length > EXPORT_ROW_CAP) {
    return exportError(413, `This export has ${filtered.length.toLocaleString()} rows, above the ${EXPORT_ROW_CAP.toLocaleString()}-row limit. Narrow the filters and try again.`);
  }
  const date = new Date().toISOString().slice(0, 10);
  return csvResponse(buildFindingsCsv(filtered), exportFilename("access-findings", date));
}
