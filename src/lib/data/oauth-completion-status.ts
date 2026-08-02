// Phase 8K — the customer-facing state of one Slack OAuth completion. Server-only read layer.
//
// The ONLY source of truth is `product_oauth_completion_job_status` (migration 0081): the single wrapper on
// `oauth_completion_jobs` granted to `authenticated`, gated on `has_tenant_role(owner|admin)`, returning an EMPTY SET
// rather than an error when the caller may not read. That convention is what makes an unauthorized read, another
// tenant's job, and a job that never existed indistinguishable here — this module preserves it by mapping all three to
// the same customer state.
//
// It narrows further than the wrapper does. The wrapper returns four timestamps and a terminal reason; none of them
// leaves this file. A customer sees one of four words. They do not see the internal job id, the attempt count, the
// claim time, the terminal reason, the body digest, the sealed payload, a provider error, or anything a database row
// could carry — those are engineering facts about a queue, and a customer reading "state_consume_failed" has learned
// nothing they can act on and something we should not have said.

import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { accessGate } from "./access-repository";
import { CORRELATION_ID_RE } from "@/lib/server/connector-vault/oauth-handoff-protocol";

/** The whole customer vocabulary. There is no fifth value and no place to add a raw one. */
export const CONNECTION_STATES = ["completing", "completed", "failed", "expired"] as const;
export type ConnectionState = (typeof CONNECTION_STATES)[number];

export type ConnectionStatus = {
  state: ConnectionState;
  /** Terminal states stop the browser polling. `completing` is the only non-terminal one. */
  terminal: boolean;
};

const COMPLETING: ConnectionStatus = { state: "completing", terminal: false };
const FAILED: ConnectionStatus = { state: "failed", terminal: true };

// The wrapper's row shape. Only `job_status` is read; the rest is declared so a drifted contract is a parse failure
// rather than a silently-ignored column.
const statusRowSchema = z.object({
  job_status: z.enum(["pending", "claimed", "completed", "failed", "expired"]),
  job_created_at: z.string().nullable().optional(),
  job_expires_at: z.string().nullable().optional(),
  job_completed_at: z.string().nullable().optional(),
  job_terminal_reason: z.string().nullable().optional(),
});

type RpcFn = (name: string, args: Record<string, unknown>) => PromiseLike<{ data: unknown; error: { message: string } | null }>;

/**
 * Read the state of one completion, for the signed-in user's active tenant.
 *
 * Every failure — malformed correlation, no active tenant, no owner/admin role, RPC error, empty set, unparseable row —
 * becomes `failed`. That is deliberate and it is the honest answer: from the customer's side nothing is in progress and
 * nothing completed. It is also what keeps another tenant from learning that a job exists, because "denied" and "never
 * existed" produce identical output and identical timing at this layer.
 */
export async function getSlackConnectionStatus(correlationId: string | null | undefined): Promise<ConnectionStatus> {
  if (typeof correlationId !== "string" || !CORRELATION_ID_RE.test(correlationId)) return FAILED;

  const gate = await accessGate();
  if (!gate.ok) return FAILED;

  const supabase = await createClient();
  const rpc = supabase.rpc.bind(supabase) as unknown as RpcFn;
  const { data, error } = await rpc("product_oauth_completion_job_status", {
    p_tenant_id: gate.tenantId,
    p_correlation_id: correlationId,
  });
  // The error message is never surfaced or logged with context: it can name a function, a role, or a tenant id.
  if (error) return FAILED;

  const rows = Array.isArray(data) ? data : [];
  if (rows.length !== 1) return FAILED;
  const row = statusRowSchema.safeParse(rows[0]);
  if (!row.success) return FAILED;

  switch (row.data.job_status) {
    // `claimed` means a worker is mid-exchange. To a customer that is the same thing as `pending`: still working.
    case "pending":
    case "claimed":
      return COMPLETING;
    case "completed":
      return { state: "completed", terminal: true };
    case "expired":
      return { state: "expired", terminal: true };
    case "failed":
      return FAILED;
  }
}
