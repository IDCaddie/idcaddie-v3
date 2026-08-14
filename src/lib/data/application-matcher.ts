// Phase 18C — the deterministic application matcher's IO half: authorize → start → read → plan → propose → complete.
//
// It proposes and NOTHING else. `product_decide_application_match` is not called here and must never be: a match is a
// human judgement about a customer's estate, and a matcher that accepted its own proposal would make the review
// boundary 0088 built decorative. One candidate does not auto-accept either — cardinality is not evidence.
//
// ══ WHY THE RUN IS FAIL-CLOSED ═══════════════════════════════════════════════════════════════════════════════════════
// `application_matcher_state = completed` is what licenses Rule 5 to fire. That single flag is the difference between
// "this application has no accepted match" meaning *unmanaged* and meaning *we never looked*, so completing a run that
// did not fully succeed would license findings against an estate this code failed to read. Every failure after the
// start therefore marks the run FAILED and returns; there is no partial completion and no "best effort" path.
//
// The corollary is the ordering: complete is the LAST call, after every proposal has succeeded. Completing first and
// proposing afterwards would leave a window in which Rule 5 reads a completed run whose proposals do not exist yet.
//
// ══ WHAT "COMPLETE" HONESTLY MEANS ═══════════════════════════════════════════════════════════════════════════════════
// The run is complete RELATIVE TO ITS OWN BOUNDED READS, not relative to a database snapshot. The census and the
// candidate feed are separate cursor walks in separate statements; an application created between them is simply not
// in this run and will be in the next. That is stated rather than papered over, because claiming snapshot consistency
// we do not have would be the more dangerous kind of wrong.
//
// No provider name is compared anywhere below. The census carries `provider` and the matcher never reads it — the
// canonical layer already absorbed every provider difference before this point.

import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { accessGate } from "./access-repository";
import {
  MATCHER_METHOD, planApplicationMatches,
  type CandidateRow, type EvidenceViolation, type MatcherCounts,
} from "@/lib/server/cross-source-governance/application-matcher-plan";

if (typeof (globalThis as { window?: unknown }).window !== "undefined") {
  throw new Error("application-matcher is server-only and must not be imported in client code");
}

// ── Bounded failure vocabulary ───────────────────────────────────────────────────────────────────────────────────────
// Every value is a fixed literal. None can carry SQL, a URL, a PostgREST payload, a row, an external id or a stack —
// the raw error is dropped at the boundary and never returned.
export type MatcherError =
  | "not_authorized"
  | "query_failed"
  | "pagination_contract_violated"
  | "page_limit_exceeded"
  | "proposal_rejected"
  | "state_transition_failed"
  | EvidenceViolation;

export type MatcherRunResult =
  | {
      readonly status: "completed";
      readonly counts: MatcherCounts;
      readonly createdProposalCount: number;
      readonly existingProposalCount: number;
      readonly acceptedExistingCount: number;
      readonly rejectedExistingCount: number;
    }
  | { readonly status: "failed"; readonly reason: MatcherError };

export type MatcherIo = {
  readonly rpc: (name: string, args: Record<string, unknown>) => Promise<{ data: unknown; error: unknown }>;
};

export async function createMatcherIo(): Promise<MatcherIo> {
  const supabase = await createClient();
  type RpcFn = (n: string, a: Record<string, unknown>) => PromiseLike<{ data: unknown; error: unknown }>;
  const rpc = supabase.rpc.bind(supabase) as unknown as RpcFn;
  return { rpc: async (name, args) => await rpc(name, args) };
}

// 0073 clamps its own page to 100 and 0090 clamps to 200; asking for the maximum means neither can be widened here.
const PAGE_CENSUS = 100;
const PAGE_CANDIDATES = 200;
// A cursor that stops advancing must terminate the walk rather than spin. 400 pages is far beyond any real estate, and
// reaching it FAILS — a truncated read would understate the census and let a completed run license Rule 5 over an
// estate it only partly saw.
const MAX_PAGES = 400;

const uuid = z.string().min(1);
const censusRowSchema = z.object({ id: uuid });
const candidateRowSchema = z.object({
  directory_application_id: uuid,
  app_product_id: uuid,
  app_id: uuid.nullable(),
});
// `start` returns a status; `complete`/`fail` return how many rows the guarded UPDATE moved.
const startSchema = z.object({ status: z.string() });
const updatedSchema = z.object({ updated: z.number() });
const proposeSchema = z.object({ status: z.string() });

type Fail = { ok: false; error: MatcherError };
type CallResult = { ok: true; data: unknown } | Fail;

async function callRpc(io: MatcherIo, name: string, args: Record<string, unknown>): Promise<CallResult> {
  try {
    const { data, error } = await io.rpc(name, args);
    if (error) {
      console.error(`[governance/matcher] rpc query_failed: ${name}`);
      return { ok: false, error: "query_failed" };
    }
    return { ok: true, data };
  } catch {
    // A thrown transport error is the same class of unknown as a returned one, and must not escape as a stack.
    console.error(`[governance/matcher] rpc threw: ${name}`);
    return { ok: false, error: "query_failed" };
  }
}

/**
 * Walk the 0073 census to exhaustion. Ordinary id cursor: one row per directory application, so a short page is the
 * last page.
 *
 * `p_include_stale: false` is a real decision, not a default. 0090's feed admits only `current` applications, so a
 * census that included stale ones would manufacture `product_unresolved` states for rows the feed was never going to
 * mention — inflating a count that reads as "we looked and found nothing settled". The two feeds must filter alike.
 */
async function loadCensus(io: MatcherIo, tenantId: string): Promise<{ ok: true; ids: string[] } | Fail> {
  const ids: string[] = [];
  let after: string | null = null;
  for (let page = 0; page < MAX_PAGES; page++) {
    const r = await callRpc(io, "product_list_directory_applications", {
      p_tenant_id: tenantId, p_connection_id: null, p_provider: null,
      p_include_stale: false, p_after_id: after, p_limit: PAGE_CENSUS,
    });
    if (!r.ok) return r;
    if (!Array.isArray(r.data)) return { ok: false, error: "pagination_contract_violated" };
    const parsed = r.data.map(x => censusRowSchema.safeParse(x));
    // A row we could not parse is a row we did not read. Continuing would leave it out of the census while the run
    // still reported success, and an application missing from the census is one no candidate may reference.
    if (parsed.some(p => !p.success)) {
      console.error("[governance/matcher] census row failed its contract");
      return { ok: false, error: "pagination_contract_violated" };
    }
    const batch = parsed.map(p => (p.success ? p.data.id : ""));
    for (const id of batch) {
      if (after !== null && id <= after) {
        console.error("[governance/matcher] non-monotonic census cursor");
        return { ok: false, error: "pagination_contract_violated" };
      }
      after = id;
      ids.push(id);
    }
    if (r.data.length < PAGE_CENSUS) return { ok: true, ids };
    if (batch.length === 0) {
      console.error("[governance/matcher] census cursor did not advance");
      return { ok: false, error: "pagination_contract_violated" };
    }
  }
  console.error("[governance/matcher] census page limit exceeded");
  return { ok: false, error: "page_limit_exceeded" };
}

/**
 * Walk the 0090 candidate feed to exhaustion.
 *
 * ITS PAGE IS PARENTS, NOT ROWS — that is the whole point of 0090's contract, and it changes both loop conditions.
 * A page may return MORE rows than `p_limit` because one parent expands to its complete instance set, so row count
 * says nothing about whether the walk is finished; the number of DISTINCT PARENTS does. And the cursor is the last
 * parent, not the last row, so a many-instance group is carried whole rather than split across a boundary.
 */
async function loadCandidates(io: MatcherIo, tenantId: string): Promise<{ ok: true; rows: CandidateRow[] } | Fail> {
  const rows: CandidateRow[] = [];
  let after: string | null = null;
  for (let page = 0; page < MAX_PAGES; page++) {
    const r = await callRpc(io, "product_application_match_candidates", {
      p_tenant_id: tenantId, p_after_directory_application_id: after, p_limit: PAGE_CANDIDATES,
    });
    if (!r.ok) return r;
    if (!Array.isArray(r.data)) return { ok: false, error: "pagination_contract_violated" };
    const parsed = r.data.map(x => candidateRowSchema.safeParse(x));
    if (parsed.some(p => !p.success)) {
      console.error("[governance/matcher] candidate row failed its contract");
      return { ok: false, error: "pagination_contract_violated" };
    }
    const batch = parsed.flatMap(p => (p.success ? [p.data] : []));

    const parents: string[] = [];
    for (const row of batch) {
      // 0090 orders by (parent, app), so parents arrive in ascending order and each appears once contiguously. A
      // parent at or before the cursor means the page overlaps one already consumed — rows would be counted twice.
      if (after !== null && row.directory_application_id <= after) {
        console.error("[governance/matcher] non-monotonic candidate cursor");
        return { ok: false, error: "pagination_contract_violated" };
      }
      if (parents.length === 0 || parents[parents.length - 1] !== row.directory_application_id) {
        if (parents.includes(row.directory_application_id)) {
          // A parent reappearing after another one intervened means the group was split by the read itself.
          console.error("[governance/matcher] candidate group not contiguous");
          return { ok: false, error: "pagination_contract_violated" };
        }
        parents.push(row.directory_application_id);
      }
      rows.push({
        directoryApplicationId: row.directory_application_id,
        appProductId: row.app_product_id,
        appId: row.app_id,
      });
    }

    if (parents.length === 0) return { ok: true, rows };
    after = parents[parents.length - 1];
    // A short PARENT page is the last page. Comparing row count here would end the walk early on any page whose
    // parents expanded to fewer rows than the limit, and continue forever on one that expanded to more.
    if (parents.length < PAGE_CANDIDATES) return { ok: true, rows };
  }
  console.error("[governance/matcher] candidate page limit exceeded");
  return { ok: false, error: "page_limit_exceeded" };
}

/** The exact bounded vocabulary 0090's propose command returns. Anything outside it fails the run. */
type ProposeOutcome = "created" | "existing" | "accepted" | "rejected";
function classifyProposal(status: string): ProposeOutcome | null {
  switch (status) {
    case "proposed": return "created";
    case "already_proposed": return "existing";
    // A settled human decision. Both are SUCCESSES for the run: the matcher generated a legitimate candidate and a
    // person had already answered it. Treating `already_rejected` as an error would make a healthy estate look broken
    // and would pressure a future maintainer into "fixing" it by re-proposing around the rejection.
    case "already_accepted": return "accepted";
    case "already_rejected": return "rejected";
    // `not_allowed`, `invalid_method`, `invalid_confidence` and anything unrecognised are contract failures, not
    // outcomes: they mean this matcher asked for something the boundary refuses, and the run did not do what it claims.
    default: return null;
  }
}

/**
 * Run the deterministic matcher for ONE already-authorized tenant.
 *
 * `tenantId` MUST already be verified by `accessGate()`. Every RPC re-checks it, so passing an unverified id is not a
 * hole, but the double check is the defence in depth worth keeping.
 */
export async function runApplicationMatcher(tenantId: string, io: MatcherIo): Promise<MatcherRunResult> {
  // START FIRST. 0085 upserts `running` unconditionally, so this cannot report "already running" — but it CAN raise
  // 42501 for a caller without the role, and that must stop everything before a single read.
  const started = await callRpc(io, "product_start_application_matcher_run", { p_tenant_id: tenantId });
  if (!started.ok) return { status: "failed", reason: started.error };
  const startParsed = startSchema.safeParse(started.data);
  if (!startParsed.success || startParsed.data.status !== "running") {
    console.error("[governance/matcher] start returned an unexpected shape");
    // Nothing is marked failed here: without a confirmed `running` state there is no run of ours to fail, and calling
    // fail would risk stamping somebody else's.
    return { status: "failed", reason: "state_transition_failed" };
  }

  const outcome = await runAfterStart(tenantId, io);
  if (outcome.status === "failed") {
    // Best-effort: the run is already failed from the caller's perspective, and a failing `fail` must not overwrite
    // the real reason with a bookkeeping one. It is logged and the original reason is returned.
    const failed = await callRpc(io, "product_fail_application_matcher_run", { p_tenant_id: tenantId });
    const n = failed.ok ? updatedSchema.safeParse(failed.data) : null;
    if (!failed.ok || !n?.success || n.data.updated !== 1) {
      console.error("[governance/matcher] could not mark the run failed");
    }
  }
  return outcome;
}

async function runAfterStart(tenantId: string, io: MatcherIo): Promise<MatcherRunResult> {
  // Sequential, not concurrent. The census is what validates the candidate feed, and issuing both together would only
  // save a round trip while making a census failure race a candidate failure for which reason gets reported.
  const census = await loadCensus(io, tenantId);
  if (!census.ok) return { status: "failed", reason: census.error };

  const candidates = await loadCandidates(io, tenantId);
  if (!candidates.ok) return { status: "failed", reason: candidates.error };

  const planned = planApplicationMatches(census.ids, candidates.rows);
  if (!planned.ok) {
    console.error(`[governance/matcher] evidence inconsistent: ${planned.error}`);
    return { status: "failed", reason: planned.error };
  }

  let createdProposalCount = 0;
  let existingProposalCount = 0;
  let acceptedExistingCount = 0;
  let rejectedExistingCount = 0;

  // Sequentially, in the plan's deterministic order. Concurrency here would buy little — the work is one INSERT per
  // candidate — and would make a partial failure's boundary unclear at exactly the moment it matters most.
  for (const p of planned.plan.proposals) {
    const r = await callRpc(io, "product_propose_application_match", {
      p_tenant_id: tenantId,
      p_directory_application_id: p.directoryApplicationId,
      p_app_id: p.appId,
      p_method: MATCHER_METHOD,
      p_confidence: p.confidence,
    });
    if (!r.ok) return { status: "failed", reason: r.error };
    const parsed = proposeSchema.safeParse(r.data);
    const outcome = parsed.success ? classifyProposal(parsed.data.status) : null;
    if (outcome === null) {
      console.error("[governance/matcher] propose returned a status this matcher does not accept");
      return { status: "failed", reason: "proposal_rejected" };
    }
    if (outcome === "created") createdProposalCount++;
    else if (outcome === "existing") existingProposalCount++;
    else if (outcome === "accepted") acceptedExistingCount++;
    else rejectedExistingCount++;
  }

  // LAST. `updated = 0` means the row was no longer `running` — a concurrent run stamped over it, or something else
  // failed it — so this run cannot claim completeness it did not hold at the end.
  const completed = await callRpc(io, "product_complete_application_matcher_run", { p_tenant_id: tenantId });
  if (!completed.ok) return { status: "failed", reason: completed.error };
  const n = updatedSchema.safeParse(completed.data);
  if (!n.success || n.data.updated !== 1) {
    console.error("[governance/matcher] completion did not transition the run");
    return { status: "failed", reason: "state_transition_failed" };
  }

  return {
    status: "completed",
    counts: planned.plan.counts,
    createdProposalCount,
    existingProposalCount,
    acceptedExistingCount,
    rejectedExistingCount,
  };
}

/**
 * The request-driven entrypoint: resolve the tenant from the session, then run.
 *
 * The tenant is NEVER a parameter from the browser — `accessGate()` derives it from the signed-in context and admits
 * owner/admin only, the same authority every RPC below re-verifies. There is no scheduler and no machine principal:
 * a matcher that ran unattended would need an identity nobody has granted, and this phase does not create one.
 */
export async function runTenantApplicationMatcher(io?: MatcherIo): Promise<MatcherRunResult> {
  const gate = await accessGate();
  if (!gate.ok) return { status: "failed", reason: "not_authorized" };
  return await runApplicationMatcher(gate.tenantId, io ?? (await createMatcherIo()));
}
