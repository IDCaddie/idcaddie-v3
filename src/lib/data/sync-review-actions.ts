import { createClient } from "@/lib/supabase/server";

// Server-only status-only review actions for the discovery review queue. Boundary: imports the user-scoped server client
// (anon key, server-only) — NEVER a service-role/admin client and NEVER the connector_runner role; takes NO tenant_id
// from the caller (RLS 0025 `editors update` = has_tenant_role owner/admin/editor decides scope). These helpers ONLY
// transition review state on the existing columns review_status / reviewed_by / reviewed_at / rejected_reason. They
// select/update NO row body (never fact_json / natural_key / signal_id / source_record_id / provenance_json / email /
// name / id / token / secret), never DELETE, and never INSERT audit_logs — the audit row is written by the DB-side 0042
// `discovery_facts_audit_on_write` SECURITY DEFINER trigger. Guarded pending-only (pending → confirmed / rejected; a
// confirmed/rejected row is never moved back). NOT wired into any UI here. Fails closed via DataResult.

// The ONLY allowed reject reasons — a fixed code enum (never free text / PII).
export const REVIEW_REJECT_REASONS = [
  "not_a_real_account",
  "duplicate",
  "out_of_scope",
  "test_or_noise",
  "wrong_app_or_provider",
] as const;
export type ReviewRejectReason = (typeof REVIEW_REJECT_REASONS)[number];
export function isReviewRejectReason(v: string): v is ReviewRejectReason {
  return (REVIEW_REJECT_REASONS as readonly string[]).includes(v);
}

// A bounded scope for the transition (all optional → "all pending the caller may edit"). No tenant_id — RLS scopes rows.
// factIds / sourceRunId / factType are opaque lookup keys, never a row body.
export type ReviewScope = { factIds?: readonly string[]; sourceRunId?: string; factType?: string };

// Count-only outcome: how many pending rows this call transitioned. No ids/bodies returned. Fail-closed error codes
// (follows the `DataResult`-style shape in `apps.ts`, with a review-specific error union).
export type ReviewActionResult =
  | { ok: true; data: { updated: number } }
  | { ok: false; error: "not_authenticated" | "invalid_reason" | "update_failed" };

type Builder = {
  eq: (col: string, val: string) => Builder;
  in: (col: string, vals: readonly string[]) => Builder;
  select: (cols: string) => Promise<{ data: { id: string }[] | null; error: unknown }>;
};

function applyScope(q: Builder, scope: ReviewScope): Builder {
  let b = q;
  if (scope.factIds && scope.factIds.length > 0) b = b.in("id", scope.factIds);
  if (scope.sourceRunId) b = b.eq("source_run_id", scope.sourceRunId);
  if (scope.factType) b = b.eq("fact_type", scope.factType);
  return b;
}

// Shared transition: guarded pending-only UPDATE of the review columns only; select("id") counts the transitioned rows
// (id only — no body). RLS + the pending guard together mean a non-editor, a cross-tenant row, or an already
// confirmed/rejected row is a 0-row no-op. Fails closed.
async function transitionPending(
  scope: ReviewScope,
  patch: { review_status: "confirmed" | "rejected"; rejected_reason?: ReviewRejectReason },
): Promise<ReviewActionResult> {
  const supabase = await createClient();

  const { data: userRes, error: userErr } = await supabase.auth.getUser();
  if (userErr || !userRes?.user) return { ok: false, error: "not_authenticated" };
  const reviewerId = userRes.user.id;

  const update = {
    review_status: patch.review_status,
    reviewed_by: reviewerId,
    reviewed_at: new Date().toISOString(),
    ...(patch.rejected_reason ? { rejected_reason: patch.rejected_reason } : {}),
  };

  // Guard: only rows that are STILL pending transition. `.eq("review_status","pending")` blocks confirmed/rejected→pending
  // and double-submits. No `.eq("tenant_id", …)` — RLS decides the tenant. `.select("id")` returns ids to COUNT only.
  const base = supabase.from("discovery_facts").update(update).eq("review_status", "pending") as unknown as Builder;
  const { data, error } = await applyScope(base, scope).select("id");
  if (error) {
    console.error("[data/sync-review-actions] transitionPending update failed");
    return { ok: false, error: "update_failed" };
  }
  return { ok: true, data: { updated: (data ?? []).length } };
}

// Confirm: pending → confirmed (guarded). Records reviewer + time; audit via the 0042 trigger.
export async function confirmPendingReview(scope: ReviewScope = {}): Promise<ReviewActionResult> {
  return transitionPending(scope, { review_status: "confirmed" });
}

// Reject: pending → rejected with a FIXED reason code (guarded). Records reviewer + time + reason; audit via the trigger.
export async function rejectPendingReview(scope: ReviewScope, reason: ReviewRejectReason): Promise<ReviewActionResult> {
  if (!isReviewRejectReason(reason)) return { ok: false, error: "invalid_reason" };
  return transitionPending(scope, { review_status: "rejected", rejected_reason: reason });
}
