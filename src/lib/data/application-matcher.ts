// Phase 18C — the deterministic application matcher: reads, validates, proposes, and records that it ran.
//
// THE MATCHER PROPOSES. IT NEVER ACCEPTS OR REJECTS. Even the most deterministic case — one confirmed canonical
// product with exactly one operational instance — produces a `proposed` row at `medium`. `product_decide_application_match`
// is never called from this module, and a static test pins that at zero.
//
// ══ EXECUTION ORDER, AND WHY IT IS THIS ORDER ════════════════════════════════════════════════════════════════════════
//   1. start the run          -> if it does not transition, nothing else happens
//   2. read the CENSUS        (every current directory application)
//   3. read the CANDIDATE feed (only those with a resolved canonical product)
//   4. validate the two against each other
//   5. write EVERY proposal
//   6. complete the run
//
// Reads are ALL-OR-NOTHING and happen entirely before any write. A matcher that proposed from a half-read estate would
// record `completed` over evidence it never saw — and `completed` is exactly what licenses Rule 5 to treat an
// unmatched application as unmanaged. So a failed read, a broken pagination contract or a feed disagreement fails the
// run before a single proposal is written, and the failure is recorded so Rule 5 stays withheld.
//
// `completed` means "the deterministic matcher processed its complete readable inputs" — NOT "there were candidates".
// An empty estate, an entirely unresolved one, or one where every product has zero operational instances all complete
// successfully with zero proposals.
//
// Provider-neutral by construction: it reads canonical product facts and never a provider name.

import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { accessGate } from "./access-repository";
import {
  planApplicationMatches, MATCHER_METHOD,
  type CandidateRow, type CensusRow, type PlanCounts,
} from "@/lib/server/application-matcher/plan";

if (typeof (globalThis as { window?: unknown }).window !== "undefined") {
  throw new Error("application-matcher is server-only and must not be imported in client code");
}

// Each feed's own cap, read from its migration rather than assumed: 0061 clamps to 100, 0090 to 200. Asking for more
// is clamped server-side, so requesting the maximum is simply the fewest round trips.
const CENSUS_PAGE = 100;
const CANDIDATE_PAGE = 200;
// Runaway backstop. Reaching it FAILS rather than truncating — a partial census would misclassify every application it
// never saw as absent.
const MAX_PAGES = 500;

export type MatcherFailureReason =
  | "not_authorized"
  | "run_not_started"
  | "query_failed"
  | "pagination_contract_violated"
  | "evidence_contract_violated"
  | "proposal_failed"
  | "matcher_state_failed";

export type MatcherResult =
  | {
      readonly status: "completed";
      readonly counts: PlanCounts;
      readonly proposalsCreated: number;
      readonly proposalsExisting: number;
      readonly proposalsAlreadyAccepted: number;
      readonly proposalsAlreadyRejected: number;
    }
  | { readonly status: "failed"; readonly reason: MatcherFailureReason; readonly failureRecorded: boolean };

export type MatcherIo = {
  readonly rpc: (name: string, args: Record<string, unknown>) => Promise<{ data: unknown; error: unknown }>;
};

export async function createMatcherIo(): Promise<MatcherIo> {
  const supabase = await createClient();
  type RpcFn = (n: string, a: Record<string, unknown>) => PromiseLike<{ data: unknown; error: unknown }>;
  const rpc = supabase.rpc.bind(supabase) as unknown as RpcFn;
  return { rpc: async (name, args) => await rpc(name, args) };
}

// Only the RPC name is ever logged. A PostgREST message can carry a predicate, a column list or a row value, so the
// raw error is observed here and nowhere else — never returned, never attached.
type Call<T> = { ok: true; data: T } | { ok: false; reason: MatcherFailureReason };

async function callRpc(io: MatcherIo, name: string, args: Record<string, unknown>): Promise<Call<unknown>> {
  try {
    const { data, error } = await io.rpc(name, args);
    if (error) { console.error(`[governance/matcher] rpc query_failed: ${name}`); return { ok: false, reason: "query_failed" }; }
    return { ok: true, data };
  } catch {
    console.error(`[governance/matcher] rpc threw: ${name}`);
    return { ok: false, reason: "query_failed" };
  }
}

const censusRowSchema = z.object({ id: z.string().min(1) });
const candidateRowSchema = z.object({
  directory_application_id: z.string().min(1),
  app_product_id: z.string().min(1),
  app_id: z.string().min(1).nullable().optional().transform(v => v ?? null),
});
const updatedSchema = z.object({ updated: z.number() });
const proposalSchema = z.object({ status: z.string().min(1) });

/** A dropped row is a row we did not read; continuing would misclassify it. Same rule as the governance loader. */
function parsePage<T>(schema: z.ZodType<T>, data: unknown): { rows: T[]; dropped: number } {
  if (!Array.isArray(data)) return { rows: [], dropped: 0 };
  const rows: T[] = [];
  let dropped = 0;
  for (const r of data) { const p = schema.safeParse(r); if (p.success) rows.push(p.data); else dropped++; }
  return { rows, dropped };
}

/**
 * Walk the CENSUS to exhaustion. Ids strictly increase (0061 is `where id > p_after_id order by id`), enforced rather
 * than trusted.
 */
async function readCensus(io: MatcherIo, tenantId: string): Promise<Call<CensusRow[]>> {
  const rows: CensusRow[] = [];
  let after: string | null = null;
  for (let page = 0; page < MAX_PAGES; page++) {
    const r = await callRpc(io, "product_list_directory_applications", {
      p_tenant_id: tenantId, p_connection_id: null, p_provider: null,
      // Phase 18C's census is the CURRENT estate. Stale provider evidence must not mint a fresh candidate, and 0090
      // filters to `current` too — asking for stale here would make the two feeds disagree by construction.
      p_include_stale: false, p_after_id: after, p_limit: CENSUS_PAGE,
    });
    if (!r.ok) return r;
    const parsed = parsePage(censusRowSchema, r.data);
    if (parsed.dropped > 0) {
      console.error("[governance/matcher] census row failed its contract");
      return { ok: false, reason: "pagination_contract_violated" };
    }
    let prev: string | null = after;
    for (const row of parsed.rows) {
      if (prev !== null && row.id <= prev) {
        console.error("[governance/matcher] non-monotonic census page");
        return { ok: false, reason: "pagination_contract_violated" };
      }
      prev = row.id;
    }
    rows.push(...parsed.rows);
    const raw = Array.isArray(r.data) ? r.data.length : 0;
    if (raw < CENSUS_PAGE) return { ok: true, data: rows };
    if (prev === null || prev === after) {
      console.error("[governance/matcher] census cursor did not advance");
      return { ok: false, reason: "pagination_contract_violated" };
    }
    after = prev;
  }
  console.error("[governance/matcher] census page limit exceeded");
  return { ok: false, reason: "pagination_contract_violated" };
}

/**
 * Walk the CANDIDATE feed to exhaustion.
 *
 * Its cursor is the PARENT directory application, not the row: 0090 pages parents and then expands each one's complete
 * 0/1/N operational set, so a page can legitimately return more rows than its limit and a group is never split. The
 * cursor therefore advances from the last PARENT id seen, and monotonicity is asserted on parents — asserting it on
 * rows would reject the perfectly legal repetition of a parent across its own instances.
 */
async function readCandidates(io: MatcherIo, tenantId: string): Promise<Call<CandidateRow[]>> {
  const rows: CandidateRow[] = [];
  let after: string | null = null;
  for (let page = 0; page < MAX_PAGES; page++) {
    const r = await callRpc(io, "product_application_match_candidates", {
      p_tenant_id: tenantId, p_after_directory_application_id: after, p_limit: CANDIDATE_PAGE,
    });
    if (!r.ok) return r;
    const parsed = parsePage(candidateRowSchema, r.data);
    if (parsed.dropped > 0) {
      console.error("[governance/matcher] candidate row failed its contract");
      return { ok: false, reason: "pagination_contract_violated" };
    }

    const parents: string[] = [];
    for (const row of parsed.rows) {
      if (parents.length === 0 || parents[parents.length - 1] !== row.directory_application_id) {
        parents.push(row.directory_application_id);
      }
    }
    let prev: string | null = after;
    for (const parent of parents) {
      if (prev !== null && parent <= prev) {
        console.error("[governance/matcher] non-monotonic candidate page");
        return { ok: false, reason: "pagination_contract_violated" };
      }
      prev = parent;
    }

    rows.push(...parsed.rows.map(toCandidate));
    // The page is a page of PARENTS, so exhaustion is measured in parents rather than rows.
    if (parents.length < CANDIDATE_PAGE) return { ok: true, data: rows };
    if (prev === null || prev === after) {
      console.error("[governance/matcher] candidate cursor did not advance");
      return { ok: false, reason: "pagination_contract_violated" };
    }
    after = prev;
  }
  console.error("[governance/matcher] candidate page limit exceeded");
  return { ok: false, reason: "pagination_contract_violated" };
}

const toCandidate = (r: z.infer<typeof candidateRowSchema>): CandidateRow => ({
  directoryApplicationId: r.directory_application_id,
  appProductId: r.app_product_id,
  appId: r.app_id,
});

/**
 * Run the matcher for the caller's active tenant.
 *
 * Request-driven and owner/admin only: the tenant comes from `accessGate()` (the existing RLS-backed context), never
 * from a caller argument, and every RPC re-verifies it. There is no scheduler, no worker and no background principal:
 * the only database identity in play is the caller's own session, and `scripts/check-auth-safety.sh` enforces that no
 * elevated role literal exists anywhere under `src/`.
 */
export async function runApplicationMatcher(io?: MatcherIo): Promise<MatcherResult> {
  const gate = await accessGate();
  if (!gate.ok) return { status: "failed", reason: "not_authorized", failureRecorded: false };
  const tenantId = gate.tenantId;
  const resolved = io ?? (await createMatcherIo());

  // ── 1. start ────────────────────────────────────────────────────────────────────────────────────────────────────
  const started = await callRpc(resolved, "product_start_application_matcher_run", { p_tenant_id: tenantId });
  if (!started.ok) return { status: "failed", reason: started.reason, failureRecorded: false };
  const startParsed = updatedSchema.safeParse(started.data);
  if (!startParsed.success) return { status: "failed", reason: "matcher_state_failed", failureRecorded: false };
  // 0085's start is an upsert, so `updated` of 0 means the transition did not happen and there is no run to fail.
  // Nothing is read or written in that case: a proposal outside a started run is evidence with no execution record.
  if (startParsed.data.updated === 0) return { status: "failed", reason: "run_not_started", failureRecorded: false };

  // Every abort after a successful start records the failure, so `matcher.status` stops licensing Rule 5.
  const abort = async (reason: MatcherFailureReason): Promise<MatcherResult> => {
    const failed = await callRpc(resolved, "product_fail_application_matcher_run", { p_tenant_id: tenantId });
    const parsedFail = failed.ok ? updatedSchema.safeParse(failed.data) : null;
    // If the failure transition itself does not take, the ORIGINAL reason is still what is reported — the run failed
    // for that reason whether or not the state table recorded it. `failureRecorded` says which.
    return { status: "failed", reason, failureRecorded: parsedFail?.success === true && parsedFail.data.updated > 0 };
  };

  // ── 2-3. both reads, complete, before any write ──────────────────────────────────────────────────────────────────
  const census = await readCensus(resolved, tenantId);
  if (!census.ok) return abort(census.reason);
  const candidates = await readCandidates(resolved, tenantId);
  if (!candidates.ok) return abort(candidates.reason);

  // ── 4. cross-feed validation ─────────────────────────────────────────────────────────────────────────────────────
  const plan = planApplicationMatches(census.data, candidates.data);
  if (!plan.ok) {
    console.error(`[governance/matcher] evidence contract violated: ${plan.violation}`);
    return abort("evidence_contract_violated");
  }

  // ── 5. every proposal ────────────────────────────────────────────────────────────────────────────────────────────
  let created = 0, existing = 0, alreadyAccepted = 0, alreadyRejected = 0;
  for (const proposal of plan.proposals) {
    const r = await callRpc(resolved, "product_propose_application_match", {
      p_tenant_id: tenantId,
      p_directory_application_id: proposal.directoryApplicationId,
      p_app_id: proposal.appId,
      p_method: MATCHER_METHOD,
      p_confidence: proposal.confidence,
    });
    if (!r.ok) return abort(r.reason);
    const parsed = proposalSchema.safeParse(r.data);
    if (!parsed.success) return abort("proposal_failed");

    switch (parsed.data.status) {
      case "proposed": created++; break;
      case "already_proposed": existing++; break;
      // A human already settled this instance. Both are SUCCESS: the matcher deterministically regenerated a
      // legitimate candidate and found a decision already recorded against it. Treating a rejection as a failure
      // would let one reviewer's "no" break every subsequent run, and re-proposing over it would resurrect a
      // relationship a person deliberately refused.
      case "already_accepted": alreadyAccepted++; break;
      case "already_rejected": alreadyRejected++; break;
      // `not_allowed` / `invalid_method` / `invalid_confidence` / anything unrecognised: the run must not claim to
      // have processed the estate.
      default:
        console.error(`[governance/matcher] unexpected proposal status: ${parsed.data.status}`);
        return abort("proposal_failed");
    }
  }

  // ── 6. complete, only now ────────────────────────────────────────────────────────────────────────────────────────
  const completed = await callRpc(resolved, "product_complete_application_matcher_run", { p_tenant_id: tenantId });
  if (!completed.ok) return abort(completed.reason);
  const completeParsed = updatedSchema.safeParse(completed.data);
  if (!completeParsed.success || completeParsed.data.updated === 0) {
    // 0085 only completes a run that is still `running`. A zero here means the state moved underneath us, so the work
    // happened but is NOT durably recorded as complete — reporting success would license Rule 5 on a run whose own
    // state table does not agree.
    return abort("matcher_state_failed");
  }

  return {
    status: "completed",
    counts: plan.counts,
    proposalsCreated: created,
    proposalsExisting: existing,
    proposalsAlreadyAccepted: alreadyAccepted,
    proposalsAlreadyRejected: alreadyRejected,
  };
}
