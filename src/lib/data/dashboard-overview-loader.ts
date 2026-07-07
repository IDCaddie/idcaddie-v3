// Server-only fetch wrapper for the /dashboards executive overview. ONE RLS-scoped read of `contracts`
// (the safe spend/renewal columns only) → the PURE aggregators in ./dashboard-overview. No caller-supplied
// tenant_id, no service-role, no writes; the database (RLS) is the authorization boundary. Reads NO
// invoices/license tables (default-deny — RISK-002) and no connector_secrets / discovery_facts.

import { createClient } from "@/lib/supabase/server";
import {
  aggregateSpend,
  bucketRenewals,
  type OverviewRow,
  type SpendSummary,
  type RenewalBuckets,
} from "./dashboard-overview";

export type { SpendSummary, RenewalBuckets, SpendByCurrency, RenewalItem } from "./dashboard-overview";
export { formatMoney } from "./dashboard-overview";

// Both null on a failed read → the page renders a safe "unavailable" state (never fatal).
export type DashboardOverview = { spend: SpendSummary | null; renewals: RenewalBuckets | null };

export async function getDashboardOverviewForCurrentUser(now: Date = new Date()): Promise<DashboardOverview> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("contracts")
    .select("id, contract_name, vendor_name, status, total_cost, currency, renewal_date, end_date, notice_deadline");
  if (error) {
    console.error("[data/dashboard-overview] contracts query failed");
    return { spend: null, renewals: null };
  }
  const rows: OverviewRow[] = (data ?? []).map((c) => ({
    id: c.id,
    contractName: c.contract_name,
    vendorName: c.vendor_name,
    status: c.status,
    totalCost: c.total_cost,
    currency: c.currency,
    renewalDate: c.renewal_date,
    endDate: c.end_date,
    noticeDeadline: c.notice_deadline,
  }));
  return { spend: aggregateSpend(rows), renewals: bucketRenewals(rows, now) };
}
