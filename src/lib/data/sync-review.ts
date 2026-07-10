import { createClient } from "@/lib/supabase/server";
import type { DataResult } from "@/lib/data/apps";

// Server-only, read-only, COUNT-ONLY summary of the discovery review queue, scoped by RLS (migration 0025:
// `members read` = is_tenant_member(tenant_id)). Boundary: imports the user-scoped server client (anon key, server-only)
// — NEVER a service-role/admin client and NEVER the connector_runner role; takes NO tenant_id from the caller (RLS
// decides which tenant's rows are counted). Reads COUNTS ONLY via `head: true` (zero rows transferred): it selects no
// row body — never a fact payload, natural key, signal id, provenance, email, name, id, token, or secret. Grouped by the
// safe enums review_status + fact_type only. Reviewing items (confirm/reject) is a SEPARATE, not-built write path.

export type SyncReviewCounts = {
  pending: number;
  needsReview: number;
  confirmed: number;
  rejected: number;
  total: number; // pending + needs_review + confirmed + rejected + auto (all safe review_status values)
  appUserAccounts: number; // fact_type = app_user_account (a safe enum count)
};

// Count-only discovery-review summary for the current tenant (RLS-scoped). One `head: true` count per review_status
// plus one per the app_user_account fact_type — all counts, no rows. Fails closed (DataResult). Never selects or returns
// a row body.
export async function getSyncReviewCounts(): Promise<DataResult<SyncReviewCounts>> {
  const supabase = await createClient();

  // COUNT ONLY: select("id", { count: "exact", head: true }) transfers zero rows — never a fact body.
  const countByStatus = (status: string) =>
    supabase.from("discovery_facts").select("id", { count: "exact", head: true }).eq("review_status", status);
  const countByFactType = (factType: string) =>
    supabase.from("discovery_facts").select("id", { count: "exact", head: true }).eq("fact_type", factType);

  const [pending, needsReview, confirmed, rejected, auto, appUserAccounts] = await Promise.all([
    countByStatus("pending"),
    countByStatus("needs_review"),
    countByStatus("confirmed"),
    countByStatus("rejected"),
    countByStatus("auto"),
    countByFactType("app_user_account"),
  ]);

  if (pending.error || needsReview.error || confirmed.error || rejected.error || auto.error || appUserAccounts.error) {
    console.error("[data/sync-review] getSyncReviewCounts count query failed");
    return { ok: false, error: "query_failed" };
  }

  const p = pending.count ?? 0;
  const nr = needsReview.count ?? 0;
  const c = confirmed.count ?? 0;
  const r = rejected.count ?? 0;
  const a = auto.count ?? 0;
  return {
    ok: true,
    data: {
      pending: p,
      needsReview: nr,
      confirmed: c,
      rejected: r,
      total: p + nr + c + r + a,
      appUserAccounts: appUserAccounts.count ?? 0,
    },
  };
}

// Pure: "3 items pending review from the last sync" (singular "1 item …"). Counts only; never throws.
export function syncReviewLeadLabel(counts: Pick<SyncReviewCounts, "pending">): string {
  const n = counts.pending;
  return `${n} item${n === 1 ? "" : "s"} pending review from the last sync`;
}

// Pure: is there anything for a human to look at? (pending + needs_review). Drives the empty state.
export function syncReviewHasAwaiting(counts: Pick<SyncReviewCounts, "pending" | "needsReview">): boolean {
  return counts.pending + counts.needsReview > 0;
}
