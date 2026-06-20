import { createClient } from "@/lib/supabase/server";
import { listIdentityAccountsForCurrentUser } from "./people";

// Server-only, read-only Reports summary = simple "visible to you" counts from existing RLS-backed read
// surfaces. It INVENTS no report capability: every number is an RLS-scoped count of rows the signed-in
// user may already read (apps/contracts/files via `is_tenant_member`/org-scoped SELECT; account totals via
// the existing people helper, which dedups matched accounts correctly). No tenant filter, no service-role,
// no writes, no exports. Each count is `number | null` ("—" when its read fails) — best-effort, never fatal.

export type ReportsSummary = {
  appsVisible: number | null;
  contractsVisible: number | null;
  accountsVisible: number | null;
  accountsMatched: number | null;
  accountsUnmatched: number | null;
  filesVisible: number | null;
};

// RLS-scoped exact count with NO row data fetched (`head: true` returns only the count). So the DTO is
// integers only — no ids, no row contents, nothing sensitive can leak. `null` on a failed read.
async function headCount(
  supabase: Awaited<ReturnType<typeof createClient>>,
  table: "apps" | "contracts" | "files",
): Promise<number | null> {
  const { count, error } = await supabase.from(table).select("*", { count: "exact", head: true });
  if (error) {
    console.error(`[data/reports] count failed for ${table}`);
    return null;
  }
  return count ?? 0;
}

export async function getReportsSummaryForCurrentUser(): Promise<ReportsSummary> {
  const supabase = await createClient();

  const appsVisible = await headCount(supabase, "apps");
  const contractsVisible = await headCount(supabase, "contracts");
  const filesVisible = await headCount(supabase, "files");

  // Account totals reuse the existing, tested people helper (it dedups matched accounts; we never read
  // person/identity PII here — only the already-safe matched/unmatched counts).
  const accounts = await listIdentityAccountsForCurrentUser();
  const accountsView = accounts.ok ? accounts.data : null;
  const matchAvailable = accountsView?.matchStatusAvailable ?? false;

  return {
    appsVisible,
    contractsVisible,
    accountsVisible: accountsView ? accountsView.totalAccounts : null,
    accountsMatched: accountsView && matchAvailable ? accountsView.matchedAccounts : null,
    accountsUnmatched: accountsView && matchAvailable ? accountsView.unmatchedAccounts : null,
    filesVisible,
  };
}
