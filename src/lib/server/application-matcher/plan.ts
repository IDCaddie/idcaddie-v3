// Phase 18C — the deterministic application matcher's PURE planner.
//
// It takes two already-read feeds and returns either a validated proposal plan or a contract violation. No I/O, no
// clock, no randomness, no provider name, no LLM, no ranking. Given the same two feeds it returns byte-identical
// output, which is what makes a matcher run reproducible rather than merely repeatable.
//
// ══ WHY TWO FEEDS AND NOT ONE ════════════════════════════════════════════════════════════════════════════════════════
// The census (`product_list_directory_applications`, 0061) is every CURRENT directory application. The candidate feed
// (`product_application_match_candidates`, 0090) is only those whose canonical product is RESOLVED — an application
// with no confirmed `provider_app_id` alias simply has no row there.
//
// Reading only the feed would silently erase the difference between "this application has no product evidence yet" and
// "this application has a product but nothing operational under it". Those need opposite remediations — canonicalise
// the product, versus record the contract instance — so the planner keeps them apart as distinct states and proposes
// nothing for either. The census is what makes the first state observable at all.
//
// ══ THE FOUR STATES ══════════════════════════════════════════════════════════════════════════════════════════════════
//   U  product_unresolved        in census, absent from feed        -> no proposal
//   Z  resolved_zero_instances   feed row with app_id NULL          -> no proposal
//   O  one_candidate             exactly one concrete app_id        -> one proposal, medium
//   M  many_candidates           N concrete app_ids                 -> N proposals, low EACH
//
// In M every candidate gets `low`, and none is preferred. There is no ranking, no "best" candidate, no first-row or
// arrival-order tie-break: the evidence genuinely does not say which operational instance the directory application
// corresponds to, and inventing an order here would launder that ambiguity into a number a reviewer would trust.

export const MATCHER_METHOD = "canonical_product" as const;

export type CensusRow = { readonly id: string };
export type CandidateRow = {
  readonly directoryApplicationId: string;
  readonly appProductId: string;
  readonly appId: string | null;
};

export type Classification =
  | "product_unresolved"
  | "resolved_zero_instances"
  | "one_candidate"
  | "many_candidates";

export type Proposal = {
  readonly directoryApplicationId: string;
  readonly appId: string;
  readonly method: typeof MATCHER_METHOD;
  /** ONE candidate -> medium. MANY -> low for every one of them. Never `high`: a deterministic product mapping still
   *  does not prove WHICH operational instance a directory application is, and N=1 is a fact about the estate's size
   *  rather than about the strength of the evidence. */
  readonly confidence: "medium" | "low";
};

export type PlanCounts = {
  readonly directoryApplications: number;
  readonly unresolvedProducts: number;
  readonly resolvedZeroInstances: number;
  readonly oneCandidateApplications: number;
  readonly ambiguousApplications: number;
  readonly candidateCount: number;
};

/**
 * Why a plan was refused. Every one of these means the two feeds disagree in a way that cannot be repaired by
 * guessing, so the run fails rather than proposing from evidence it does not trust.
 */
export type EvidenceViolation =
  | "candidate_absent_from_census"
  | "conflicting_app_product"
  | "null_and_concrete_candidates"
  | "duplicate_candidate";

export type Plan =
  | { readonly ok: true; readonly proposals: readonly Proposal[]; readonly counts: PlanCounts }
  | { readonly ok: false; readonly violation: EvidenceViolation };

type Group = { appProductId: string; appIds: string[]; sawNull: boolean };

/**
 * Validate the two feeds against each other and produce the proposal plan.
 *
 * Every disagreement below FAILS the run rather than being repaired:
 *
 *  * a feed row whose directory application is not in the census — the feed resolved something the census says is not
 *    a current application, so one of the two reads is stale or scoped differently. Dropping it silently would let a
 *    proposal reference an application the matcher never confirmed exists.
 *  * two different products for one directory application — 0090's alias join is unique per application, so seeing two
 *    means the evidence changed mid-read or an alias invariant broke. Picking either one would be a coin toss recorded
 *    as a fact.
 *  * a NULL row alongside concrete rows — 0090 emits the NULL row only when the LEFT JOIN found nothing, so both
 *    cannot be true of one application.
 *  * the same concrete app_id twice — deduplicating would hide a broken read, exactly as it would in the loader.
 */
export function planApplicationMatches(census: readonly CensusRow[], candidates: readonly CandidateRow[]): Plan {
  const censusIds = new Set(census.map(c => c.id));
  const groups = new Map<string, Group>();

  for (const row of candidates) {
    if (!censusIds.has(row.directoryApplicationId)) return { ok: false, violation: "candidate_absent_from_census" };

    const existing = groups.get(row.directoryApplicationId);
    if (!existing) {
      groups.set(row.directoryApplicationId, {
        appProductId: row.appProductId,
        appIds: row.appId === null ? [] : [row.appId],
        sawNull: row.appId === null,
      });
      continue;
    }
    if (existing.appProductId !== row.appProductId) return { ok: false, violation: "conflicting_app_product" };
    if (row.appId === null) {
      // A second NULL, or a NULL after a concrete id — either way the group now claims both zero and some instances.
      if (existing.sawNull || existing.appIds.length > 0) return { ok: false, violation: "null_and_concrete_candidates" };
      existing.sawNull = true;
      continue;
    }
    if (existing.sawNull) return { ok: false, violation: "null_and_concrete_candidates" };
    if (existing.appIds.includes(row.appId)) return { ok: false, violation: "duplicate_candidate" };
    existing.appIds.push(row.appId);
  }

  const proposals: Proposal[] = [];
  let unresolved = 0, zeroInstances = 0, oneCandidate = 0, ambiguous = 0, candidateCount = 0;

  // Iterate the CENSUS, not the feed: an application absent from the feed is the unresolved state, and it can only be
  // counted by walking the set that contains it.
  for (const id of [...censusIds].sort()) {
    const group = groups.get(id);
    if (!group) { unresolved++; continue; }
    if (group.appIds.length === 0) { zeroInstances++; continue; }

    candidateCount += group.appIds.length;
    const confidence = group.appIds.length === 1 ? ("medium" as const) : ("low" as const);
    if (group.appIds.length === 1) oneCandidate++; else ambiguous++;

    for (const appId of [...group.appIds].sort()) {
      proposals.push({ directoryApplicationId: id, appId, method: MATCHER_METHOD, confidence });
    }
  }

  return {
    ok: true,
    // Sorted by (application, app) so a replay writes proposals in the same order — the ordering is for
    // reproducibility, and carries no preference between candidates in an ambiguous group.
    proposals,
    counts: {
      directoryApplications: censusIds.size,
      unresolvedProducts: unresolved,
      resolvedZeroInstances: zeroInstances,
      oneCandidateApplications: oneCandidate,
      ambiguousApplications: ambiguous,
      candidateCount,
    },
  };
}

/** Exposed for tests and for the run summary; the planner itself never needs to name a state. */
export function classify(census: readonly CensusRow[], candidates: readonly CandidateRow[], id: string): Classification {
  const rows = candidates.filter(c => c.directoryApplicationId === id);
  if (rows.length === 0) return "product_unresolved";
  const concrete = rows.filter(r => r.appId !== null);
  if (concrete.length === 0) return "resolved_zero_instances";
  return concrete.length === 1 ? "one_candidate" : "many_candidates";
}
