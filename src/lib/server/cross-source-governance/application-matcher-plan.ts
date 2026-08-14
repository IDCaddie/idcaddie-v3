// Phase 18C — the deterministic application matcher's PURE half.
//
// Given two independently-read feeds — the directory census and the resolved candidate feed — decide what may be
// proposed. No IO, no SQL, no provider name, no clock, no randomness: the same two inputs always yield the same plan,
// which is what makes the run reproducible and the mutants meaningful.
//
// ══ TWO FEEDS, DELIBERATELY NOT COLLAPSED ════════════════════════════════════════════════════════════════════════════
// `product_list_directory_applications` (0073) is the CENSUS: every eligible directory application, whether or not
// anything is known about it. `product_application_match_candidates` (0090) is the CANDIDATE FEED: only applications
// whose canonical product is settled by a confirmed alias.
//
// Absence from the candidate feed is therefore NOT absence of the application — it is absence of settled product
// evidence. Reading one feed and inferring the other is the mistake this split exists to prevent: a matcher driven by
// the candidate feed alone would never learn that an application exists at all, and would report a clean run over an
// estate it had not looked at.
//
// ══ WHAT THE EVIDENCE CAN SAY ════════════════════════════════════════════════════════════════════════════════════════
//   product_unresolved         in the census, absent from the feed        → nothing may be proposed
//   resolved_zero_instances    feed row with app_id NULL                  → nothing may be proposed
//   one_candidate              feed gives exactly one operational app     → propose it, confidence MEDIUM
//   ambiguous_candidates       feed gives N operational apps              → propose EVERY one, confidence LOW
//
// CONFIDENCE IS NOT CARDINALITY. One instance means the ambiguity is small, not that the evidence is stronger: the
// identifier proved the PRODUCT in both cases and never proved which instance is correct. Promoting a lone candidate
// to `high` would launder "the estate happens to have one row today" into "we know this is the right one", and a
// second instance appearing tomorrow would retroactively falsify a claim already recorded. So one is MEDIUM, many are
// LOW, and none is ever `high` — `high` belongs to evidence that identifies the instance itself.

/** A row of the 0090 candidate feed, already parsed. `appId` is null exactly when the product owns no instances. */
export type CandidateRow = {
  readonly directoryApplicationId: string;
  readonly appProductId: string;
  readonly appId: string | null;
};

export type MatchState =
  | "product_unresolved"
  | "resolved_zero_instances"
  | "one_candidate"
  | "ambiguous_candidates";

/** 0075's method vocabulary admits five other literals; this planner may only ever produce this one. */
export const MATCHER_METHOD = "canonical_product" as const;

export type PlannedProposal = {
  readonly directoryApplicationId: string;
  readonly appId: string;
  readonly confidence: "medium" | "low";
};

/**
 * Bounded reasons the two feeds cannot be reconciled. Every one of them means the deterministic layer beneath is
 * inconsistent, and the honest response is to fail the run — a matcher that "handles" contradictory evidence by
 * choosing among it has stopped being deterministic.
 */
export type EvidenceViolation =
  | "candidate_absent_from_census"
  | "conflicting_products"
  | "mixed_null_and_concrete"
  | "duplicate_candidate_row";

export type MatcherCounts = {
  readonly directoryApplicationCount: number;
  readonly unresolvedProductCount: number;
  readonly zeroInstanceCount: number;
  readonly oneCandidateCount: number;
  readonly ambiguousApplicationCount: number;
  readonly candidateCount: number;
};

export type MatcherPlan = {
  readonly counts: MatcherCounts;
  readonly proposals: readonly PlannedProposal[];
};

export type PlanResult =
  | { readonly ok: true; readonly plan: MatcherPlan }
  | { readonly ok: false; readonly error: EvidenceViolation };

/**
 * Reconcile the census against the candidate feed and produce the complete proposal set.
 *
 * Every inconsistency FAILS rather than resolves. There is deliberately no "pick the first", "pick the newest" or
 * "pick the highest confidence" anywhere below: each of those would turn a broken canonical layer into a plausible
 * proposal that a human would then ratify, and the wrongness would be indistinguishable from correctness afterwards.
 */
export function planApplicationMatches(
  censusDirectoryApplicationIds: readonly string[],
  candidateRows: readonly CandidateRow[],
): PlanResult {
  const census = new Set(censusDirectoryApplicationIds);

  // Grouped by parent. `products` is a Set rather than a single value so a conflict is detectable rather than
  // overwritten by the last row read.
  const groups = new Map<string, { products: Set<string>; appIds: string[]; nulls: number }>();

  for (const row of candidateRows) {
    // CONTRACT DRIFT, NOT A ROW TO SKIP. A candidate for an application the census did not return means the two feeds
    // disagree about which applications exist — one of them filtered on something the other did not. Dropping it would
    // hide that, and proposing against it would attach a match to an application this run never examined.
    if (!census.has(row.directoryApplicationId)) return { ok: false, error: "candidate_absent_from_census" };

    let g = groups.get(row.directoryApplicationId);
    if (g === undefined) {
      g = { products: new Set(), appIds: [], nulls: 0 };
      groups.set(row.directoryApplicationId, g);
    }
    g.products.add(row.appProductId);
    // One directory application resolving to two canonical products is a contradiction in `app_aliases`, not a choice.
    if (g.products.size > 1) return { ok: false, error: "conflicting_products" };

    if (row.appId === null) {
      g.nulls++;
    } else {
      // The feed orders by (parent, app) and joins on a primary key, so a repeat is impossible unless the contract
      // broke. Silently deduplicating would let a malformed read look like a healthy one.
      if (g.appIds.includes(row.appId)) return { ok: false, error: "duplicate_candidate_row" };
      g.appIds.push(row.appId);
    }
  }

  const proposals: PlannedProposal[] = [];
  let zeroInstanceCount = 0;
  let oneCandidateCount = 0;
  let ambiguousApplicationCount = 0;

  for (const [directoryApplicationId, g] of groups) {
    // The NULL row means "resolved, zero instances" and is only meaningful ALONE. Alongside a concrete app it asserts
    // both "this product has no instances" and "here is one", which no read of the database could truthfully produce.
    if (g.nulls > 0 && (g.nulls > 1 || g.appIds.length > 0)) return { ok: false, error: "mixed_null_and_concrete" };

    if (g.appIds.length === 0) {
      zeroInstanceCount++;
      continue;
    }
    const confidence = g.appIds.length === 1 ? "medium" : "low";
    if (g.appIds.length === 1) oneCandidateCount++;
    else ambiguousApplicationCount++;
    for (const appId of g.appIds) proposals.push({ directoryApplicationId, appId, confidence });
  }

  // A total order, so a replayed run issues the same calls in the same sequence and a diff of two runs is readable.
  proposals.sort((a, b) =>
    a.directoryApplicationId === b.directoryApplicationId
      ? (a.appId < b.appId ? -1 : a.appId > b.appId ? 1 : 0)
      : (a.directoryApplicationId < b.directoryApplicationId ? -1 : 1),
  );

  return {
    ok: true,
    plan: {
      counts: {
        directoryApplicationCount: census.size,
        // Everything the census returned that the feed had nothing settled to say about.
        unresolvedProductCount: census.size - groups.size,
        zeroInstanceCount,
        oneCandidateCount,
        ambiguousApplicationCount,
        candidateCount: proposals.length,
      },
      proposals,
    },
  };
}
