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

// A pending review batch, grouped by (source_run_id, fact_type, source_provider). Safe metadata + a count only — never
// a row body / PII / id. `sourceRunId` is an opaque run uuid; `factType`/`provider` are enums/labels.
export type SyncReviewPendingGroup = {
  sourceRunId: string | null;
  factType: string;
  provider: string;
  pending: number;
  firstSeen: string; // min created_at in the group
  lastSeen: string; // max created_at in the group
};

// The current tenant's PENDING discovery facts, aggregated into (run, type, provider) batches — the unit the review
// route confirms/rejects. Reads ONLY safe metadata columns (source_run_id / fact_type / source_provider / created_at)
// for review_status='pending' rows and groups them in-process — NEVER a body column (no fact_json / natural_key /
// signal_id / source_record_id / provenance_json / email / name / id), never a caller tenant_id (RLS scopes rows).
// Fails closed. Returns only per-batch counts + timestamps; individual rows are never surfaced.
export async function getSyncReviewPendingGroups(): Promise<DataResult<SyncReviewPendingGroup[]>> {
  const supabase = await createClient();

  const { data, error } = await supabase
    .from("discovery_facts")
    .select("source_run_id, fact_type, source_provider, created_at")
    .eq("review_status", "pending");
  if (error) {
    console.error("[data/sync-review] getSyncReviewPendingGroups query failed");
    return { ok: false, error: "query_failed" };
  }

  const byKey = new Map<string, SyncReviewPendingGroup>();
  for (const r of data ?? []) {
    const sourceRunId = (r.source_run_id as string | null) ?? null;
    const factType = String(r.fact_type);
    const provider = String(r.source_provider);
    const createdAt = String(r.created_at);
    const key = `${sourceRunId ?? "—"}|${factType}|${provider}`;
    const g = byKey.get(key);
    if (!g) {
      byKey.set(key, { sourceRunId, factType, provider, pending: 1, firstSeen: createdAt, lastSeen: createdAt });
    } else {
      g.pending += 1;
      if (createdAt < g.firstSeen) g.firstSeen = createdAt;
      if (createdAt > g.lastSeen) g.lastSeen = createdAt;
    }
  }
  // Newest batch first (by lastSeen), stable.
  const groups = [...byKey.values()].sort((a, b) => (a.lastSeen < b.lastSeen ? 1 : a.lastSeen > b.lastSeen ? -1 : 0));
  return { ok: true, data: groups };
}
