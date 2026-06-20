import { getReportsSummaryForCurrentUser, type ReportsSummary } from "./reports";
import { listRecentAuditEntriesForCurrentUser } from "./audit";

// Server-only, read-only Dashboard summary. It INVENTS no new query power — it COMPOSES two already
// RLS-scoped, already-tested helpers: getReportsSummaryForCurrentUser (apps/contracts/files/account
// counts) + listRecentAuditEntriesForCurrentUser (the recent count). The DTO is integers/nulls ONLY —
// no ids, no tenant_id, no storage/path/url, no audit JSON, no actor/IP/UA — so nothing sensitive can
// leak. Each count is `number | null` ("—" when its underlying read failed); best-effort, never fatal.

export type DashboardSummary = ReportsSummary & {
  // Count of recent audit entries visible to the user (capped at the audit page limit; null if the read failed).
  recentActivityCount: number | null;
};

export async function getDashboardSummaryForCurrentUser(): Promise<DashboardSummary> {
  const reports = await getReportsSummaryForCurrentUser();

  // Recent activity = the count of the most-recent audit entries the user may read (already a safe,
  // capped, RLS-scoped read with a deliberately minimal DTO). We expose only the COUNT, never the rows.
  const audit = await listRecentAuditEntriesForCurrentUser();
  const recentActivityCount = audit.ok ? audit.data.length : null;

  return { ...reports, recentActivityCount };
}
