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
import { CORRELATION_ID_RE } from "@/lib/server/connector-vault/oauth-handoff-protocol";
import { resolveStagingEnvironmentIdentity } from "@/lib/server/connector-vault/staging-environment-identity";

/** The whole customer vocabulary. There is no fifth value and no place to add a raw one. */
export const CONNECTION_STATES = ["completing", "completed", "failed", "expired"] as const;
export type ConnectionState = (typeof CONNECTION_STATES)[number];

export type ConnectionStatus = {
  state: ConnectionState;
  /** Terminal states stop the browser polling. `completing` is the only non-terminal one. */
  terminal: boolean;
};

const COMPLETING: ConnectionStatus = { state: "completing", terminal: false };
/** The wrapper said `failed`. That is the job's own answer and it is final. */
const FAILED: ConnectionStatus = { state: "failed", terminal: true };
/**
 * WE DO NOT KNOW — denied, foreign, absent, or the read itself did not work.
 *
 * It renders IDENTICALLY to `FAILED`, which is what keeps denied / another tenant's job / never existed
 * indistinguishable. What differs is that it is NOT terminal, and that difference is load-bearing: one transient
 * statement timeout on the first server render would otherwise pin the screen to "Connection failed" forever with
 * polling disabled, while the worker went on to store a live Slack token. The client-side poller already refuses to
 * make that mistake ("a failed poll is not a failed connection"); the server render must not make it either.
 * (Found in adversarial review of PR #398.)
 */
const UNKNOWN: ConnectionStatus = { state: "failed", terminal: false };

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
  // A malformed correlation id can never name a job, so this one IS terminal — there is nothing to wait for.
  if (typeof correlationId !== "string" || !CORRELATION_ID_RE.test(correlationId)) return FAILED;

  // THE TENANT IS THE SERVER-PINNED ONE, NOT THE SESSION'S ACTIVE ONE.
  //
  // The job was written under `CONNECTOR_OAUTH_EXPECTED_TENANT_ID`. Reading it under whichever tenant the session
  // happens to have made active is a different question, and for a user who belongs to more than one tenant it is a
  // different answer: `activeTenant` is simply the alphabetically-first membership (there is no switcher), so a user
  // who is an owner of both "Acme" and the pinned tenant would query Acme, match nothing, and be told the connection
  // failed while it was completing. (Found in adversarial review of PR #398.)
  //
  // This does NOT widen access. `product_oauth_completion_job_status` gates on `has_tenant_role(p_tenant_id,
  // owner|admin)` itself and returns an empty set otherwise, so a caller without that role on the pinned tenant learns
  // exactly nothing — which is why there is no membership check here to duplicate. Authorization is the database's.
  const identity = resolveStagingEnvironmentIdentity();
  // Outside the pinned staging environment no completion job can exist, because the callback cannot create one.
  if (!identity.ok) return FAILED;

  const supabase = await createClient();
  const rpc = supabase.rpc.bind(supabase) as unknown as RpcFn;
  const { data, error } = await rpc("product_oauth_completion_job_status", {
    p_tenant_id: identity.tenantId,
    p_correlation_id: correlationId,
  });
  // The error message is never surfaced or logged with context: it can name a function, a role, or a tenant id.
  if (error) return UNKNOWN;

  const rows = Array.isArray(data) ? data : [];
  if (rows.length !== 1) return UNKNOWN;
  const row = statusRowSchema.safeParse(rows[0]);
  if (!row.success) return UNKNOWN;

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
