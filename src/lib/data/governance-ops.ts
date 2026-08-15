// Phase 18F-C — the single READ behind the internal governance ops surface: what state is the application matcher in?
//
// `cross-source-governance-loader` already reads `product_application_matcher_state`, but it reads it as one of nine
// feeds inside a full evaluation load, and an operator asking "did the matcher fail?" must not have to run an
// evaluation to find out. So the same RPC is read on its own here. There is no second source of truth: 0085 owns the
// state, this returns it, and nothing below computes, defaults, or repairs a value.
//
// Boundary: the user-scoped, cookie-bound, RLS-governed server client — NEVER service-role. `accessGate()` resolves and
// verifies owner/admin server-side, and 0085's own `has_tenant_role` gate re-verifies it; the tenant id is never a
// caller argument. The RPC returns safe scalars only (a status enum and two timestamps) — no id, no email, no name, no
// provider payload — so there is nothing here to redact.

import { createClient } from "@/lib/supabase/server";
import { accessGate } from "./access-repository";

if (typeof (globalThis as { window?: unknown }).window !== "undefined") {
  throw new Error("data/governance-ops is server-only and must not be imported in client code");
}

/** Exactly 0085's projection. `status`/`startedAt` are null only when no run has ever started. */
export type MatcherState = {
  readonly hasEverRun: boolean;
  readonly status: "running" | "completed" | "failed" | null;
  readonly startedAt: string | null;
  readonly lastCompletedAt: string | null;
};

// Two failures, kept apart. An operator who cannot read the state must not be shown "never run" — that is a claim about
// the customer's estate, and this one is a claim about our access. Same distinction the loader draws at its own
// matcher read, for the same reason.
export type MatcherStateResult =
  | { readonly ok: true; readonly state: MatcherState }
  | { readonly ok: false; readonly error: "not_authorized" | "query_failed" };

export type MatcherStateIo = {
  readonly rpc: (name: string, args: Record<string, unknown>) => Promise<{ data: unknown; error: unknown }>;
};

export async function createMatcherStateIo(): Promise<MatcherStateIo> {
  const supabase = await createClient();
  type RpcFn = (n: string, a: Record<string, unknown>) => PromiseLike<{ data: unknown; error: unknown }>;
  const rpc = supabase.rpc.bind(supabase) as unknown as RpcFn;
  return { rpc: async (name, args) => await rpc(name, args) };
}

const STATUSES = ["running", "completed", "failed"] as const;

/**
 * Read one tenant's matcher state.
 *
 * 0085 returns exactly ONE row for an authorized caller and ZERO for anyone else — a tenant that does not exist and a
 * caller without the role are deliberately indistinguishable (the 0061 no-existence-disclosure rule). So a row count
 * other than one is `not_authorized`, never an empty estate.
 *
 * A status outside the three literals means the contract drifted; that is `query_failed` rather than a value passed
 * through, because an unrecognised status rendered as-is would be an operator reading a string this code does not
 * understand as though it did.
 */
export async function readMatcherState(tenantId: string, io: MatcherStateIo): Promise<MatcherStateResult> {
  let data: unknown;
  try {
    const r = await io.rpc("product_application_matcher_state", { p_tenant_id: tenantId });
    if (r.error) {
      // Only the RPC name is logged. A PostgREST message can carry a predicate, a column list, or a row value.
      console.error("[data/governance-ops] rpc query_failed: product_application_matcher_state");
      return { ok: false, error: "query_failed" };
    }
    data = r.data;
  } catch {
    console.error("[data/governance-ops] rpc threw: product_application_matcher_state");
    return { ok: false, error: "query_failed" };
  }

  if (!Array.isArray(data) || data.length !== 1) return { ok: false, error: "not_authorized" };
  const row = data[0] as Record<string, unknown>;

  const hasEverRun = row.has_ever_run;
  if (typeof hasEverRun !== "boolean") {
    console.error("[data/governance-ops] matcher state returned an unexpected shape");
    return { ok: false, error: "query_failed" };
  }

  const rawStatus = row.status ?? null;
  if (rawStatus !== null && !(STATUSES as readonly unknown[]).includes(rawStatus)) {
    console.error("[data/governance-ops] matcher state returned an unknown status");
    return { ok: false, error: "query_failed" };
  }
  const startedAt = typeof row.started_at === "string" ? row.started_at : null;
  const lastCompletedAt = typeof row.last_completed_at === "string" ? row.last_completed_at : null;

  return {
    ok: true,
    state: {
      hasEverRun,
      status: rawStatus as MatcherState["status"],
      startedAt,
      lastCompletedAt,
    },
  };
}

/** The request-driven entrypoint: resolve + verify the tenant from the session, then read. */
export async function readTenantMatcherState(io?: MatcherStateIo): Promise<MatcherStateResult> {
  const gate = await accessGate();
  if (!gate.ok) return { ok: false, error: "not_authorized" };
  return await readMatcherState(gate.tenantId, io ?? (await createMatcherStateIo()));
}
