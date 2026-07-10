"use server";

// Sync Review batch SERVER ACTIONS — the `"use server"` boundary the /connectors/review controls call. Thin wrappers
// over the user-scoped, status-only helpers in src/lib/data/sync-review-actions.ts (#301), where the RLS-gated,
// pending-only UPDATE + fail-closed logic live. Guarantees inherited: user-scoped anon client only (NEVER service-role),
// tenant_id resolved server-side by RLS (never caller-supplied), audit-on-write via the 0042 DB trigger (this module
// never inserts audit_logs). Scope is ONLY source_run_id + fact_type — NEVER explicit fact ids. No promotion, no delete,
// no undo. Result is surfaced via a redirect back to the route (server-rendered truth; no client JS / no optimistic UI).

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import {
  confirmPendingReview,
  rejectPendingReview,
  isReviewRejectReason,
} from "@/lib/data/sync-review-actions";

const ROUTE = "/connectors/review";

// Batch scope from the form — ONLY source_run_id + fact_type (opaque run id + enum). Never fact ids. A missing run id or
// type → no scope (the caller shows controls only for run-scoped batches; this is a defensive no-op).
function scopeFromForm(formData: FormData): { sourceRunId: string; factType: string } | null {
  const sourceRunId = (formData.get("sourceRunId") ?? "").toString().trim();
  const factType = (formData.get("factType") ?? "").toString().trim();
  if (!sourceRunId || !factType) return null;
  return { sourceRunId, factType };
}

// Confirm a pending batch (pending → confirmed). Editor RLS decides; a viewer / already-reviewed batch is a 0-row no-op.
export async function confirmReviewBatchAction(formData: FormData): Promise<void> {
  const scope = scopeFromForm(formData);
  if (!scope) redirect(`${ROUTE}?status=noop`);
  const res = await confirmPendingReview(scope);
  revalidatePath(ROUTE);
  if (!res.ok) redirect(`${ROUTE}?status=${res.error}`);
  redirect(`${ROUTE}?status=confirmed_${res.data.updated}`);
}

// Reject a pending batch (pending → rejected) with a FIXED reason code. Out-of-enum reason → fail closed, no DB write.
export async function rejectReviewBatchAction(formData: FormData): Promise<void> {
  const scope = scopeFromForm(formData);
  if (!scope) redirect(`${ROUTE}?status=noop`);
  const reason = (formData.get("reason") ?? "").toString();
  if (!isReviewRejectReason(reason)) redirect(`${ROUTE}?status=invalid_reason`);
  const res = await rejectPendingReview(scope, reason);
  revalidatePath(ROUTE);
  if (!res.ok) redirect(`${ROUTE}?status=${res.error}`);
  redirect(`${ROUTE}?status=rejected_${res.data.updated}`);
}
