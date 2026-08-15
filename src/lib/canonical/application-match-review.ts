// Phase 18F-B — the PURE half of application-match review. No Supabase, no next/headers, no clock, so every rule below is
// unit-testable in isolation (application-match-review.test.ts). The IO half lives in src/lib/data/application-match-review.ts,
// the same split as application-alias.ts (pure) vs application-aliases.ts (IO).
//
// WHAT THE REVIEWER IS BEING ASKED. docs/79, verbatim: *"is this IdP application the same thing as this operational/contract
// record?"* Everything here exists to keep that question — and only that question — on the screen.
//
//   product recognition   directory application → confirmed alias → app_product.   UPSTREAM, and already settled elsewhere.
//   instance matching     app_product → the tenant's operational `apps` rows → competing candidates.   THIS surface.
//
// Four properties of that model are enforced structurally below rather than by convention, because each one is a way this
// surface could quietly start lying:
//
//   1. NOTHING RANKS. The 0085 read returns (id, directory_application_id, app_id, status) and no confidence, so there is
//      literally nothing to rank by — and there must not be. docs/79: "neither confidence, arrival order nor arithmetic may
//      pick one." Candidates are therefore ordered ALPHABETICALLY by their own label, an ordering that carries no claim, and
//      every candidate is built with the same fields so no caller can find a "first" to emphasise.
//   2. NOTHING AUTO-ACCEPTS. There is no code path here that produces a decision. `decideOutcome` CLASSIFIES a status the
//      database already returned; it never chooses one.
//   3. A SETTLED DECISION IS NOT AN ERROR. `already_*` and `accepted_exists` are outcomes of a race or a replay, not
//      failures — see `decideOutcome`.
//   4. REJECTION IS INSTANCE-SCOPED. This module never derives a product-level verdict from an instance-level one; the only
//      product fact it carries is the upstream recognition it was handed.

// ── the review state a candidate can be in ───────────────────────────────────────────────────────────────────────────────────
// The 0075 `application_matches_status_chk` vocabulary, in full. Kept here so drift between code and schema surfaces as a
// failing test rather than an unreachable branch.
export const MATCH_STATUSES = ["proposed", "accepted", "rejected"] as const;
export type MatchStatus = (typeof MATCH_STATUSES)[number];
export function isMatchStatus(value: string): value is MatchStatus {
  return (MATCH_STATUSES as readonly string[]).includes(value);
}

// ── what a human may decide ──────────────────────────────────────────────────────────────────────────────────────────────────
// The two values `product_decide_application_match` admits. Deliberately NOT the same list as MATCH_STATUSES: `proposed` is a
// state a proposal is *in*, never a decision anybody can make, and admitting it here would let a form post it.
export const DECISIONS = ["accepted", "rejected"] as const;
export type Decision = (typeof DECISIONS)[number];
export function isDecision(value: string): value is Decision {
  return (DECISIONS as readonly string[]).includes(value);
}

// ── the bounded result vocabulary of the decide command ──────────────────────────────────────────────────────────────────────
// `accepted | rejected | accepted_exists | not_allowed | invalid_decision | already_decided` are what the 0088 command returns
// today. `already_accepted` / `already_rejected` / `already_proposed` are the sibling PROPOSE vocabulary; they are admitted here
// too because a status this surface cannot name is a status it would have to report as a failure, and "your decision failed"
// would be a lie about a row that is simply already settled. Recognising them costs one list entry each and cannot invent a
// state the database did not send.
export const DECIDE_STATUSES = [
  "accepted",
  "rejected",
  "already_decided",
  "already_accepted",
  "already_rejected",
  "already_proposed",
  "accepted_exists",
  "not_allowed",
  "invalid_decision",
] as const;
export type DecideStatus = (typeof DECIDE_STATUSES)[number];
export function isDecideStatus(value: string): value is DecideStatus {
  return (DECIDE_STATUSES as readonly string[]).includes(value);
}

// What a status MEANS to the person who clicked. The split that matters is `settled`/`contended` vs `refused`: a replayed or
// raced decision changed nothing and nothing is wrong, whereas a refusal is the caller being told no.
//
//   decided    this call moved the row — accepted or rejected
//   settled    the row was already decided (or, for `already_proposed`, already open) before this call. NOT a failure.
//   contended  a sibling candidate was accepted first. 0075's partial unique index refused the second accept, the 0088
//              exception handler rolled it back, and THIS candidate is still a proposal — docs/79: "the losing candidate
//              remains a proposal rather than being silently rejected."
//   refused    the caller may not do this, or asked for something that is not a decision
export type DecideOutcome = "decided" | "settled" | "contended" | "refused";
export function decideOutcome(status: DecideStatus): DecideOutcome {
  switch (status) {
    case "accepted":
    case "rejected":
      return "decided";
    case "already_decided":
    case "already_accepted":
    case "already_rejected":
    case "already_proposed":
      return "settled";
    case "accepted_exists":
      return "contended";
    case "not_allowed":
    case "invalid_decision":
      return "refused";
  }
}

// ── the view model ───────────────────────────────────────────────────────────────────────────────────────────────────────────
// Structural types, so the pure layer does not depend on generated DB types or on zod schemas that live in the IO half.

// One operational/contract record proposed as the answer for a directory application.
//
// `recordLabel` is the customer's own name for that record and is the PRIMARY label; a uuid is never one. `instanceLabel` is
// what tells two records of the SAME product apart (Salesforce Production vs Sandbox) and is the reason this surface is usable
// at all — without it a many-candidate group is two identical rows and the reviewer cannot answer the question.
export type MatchCandidateView = {
  readonly matchId: string;
  readonly appId: string;
  readonly recordLabel: string | null;
  readonly instanceLabel: string | null;
  readonly status: MatchStatus;
  // True when ANOTHER candidate in the same group carries the identical (recordLabel, instanceLabel) pair — i.e. the tenant's
  // own records do not distinguish themselves. Reported rather than hidden: two indistinguishable rows with Accept buttons is
  // how somebody accepts the wrong one. The surface shows a short record reference for these, and only for these.
  readonly ambiguous: boolean;
};

export type ReviewGroupView = {
  readonly directoryApplicationId: string;
  // null when the directory read did not return this row (its connector was superseded/disconnected, or the row is gone). A
  // decided match legitimately outlives its source row's visibility, so this is a real state, not an error.
  readonly applicationLabel: string | null;
  // The UPSTREAM product recognition, or null when the directory application resolves to no confirmed canonical product today.
  // NEVER derived from a candidate's own product: for a `manual` proposal those are different facts, and substituting one for
  // the other would put a recognition claim on the screen that nothing settled.
  readonly productLabel: string | null;
  readonly openCount: number;
  readonly candidates: readonly MatchCandidateView[];
};

// The at-most-one match row per (directory application, app) pair — 0088's candidate identity.
export type MatchRow = {
  readonly matchId: string;
  readonly directoryApplicationId: string;
  readonly appId: string;
  readonly status: MatchStatus;
};

// The operational record's display facts. `instanceLabel` is pre-derived by the IO layer from whichever discriminator the row
// actually carries, so this stays free of column names.
export type AppLabel = {
  readonly recordLabel: string | null;
  readonly instanceLabel: string | null;
};

export type ReviewLabels = {
  // directory application id → its customer label
  readonly application: ReadonlyMap<string, string>;
  // directory application id → the canonical product id it resolved to (upstream recognition)
  readonly productOf: ReadonlyMap<string, string>;
  // canonical product id → its name
  readonly productName: ReadonlyMap<string, string>;
  // app id → operational record labels
  readonly app: ReadonlyMap<string, AppLabel>;
};

const byText = (a: string | null, b: string | null): number => (a ?? "").localeCompare(b ?? "");

/**
 * Assemble the review queue from match rows plus labels. PURE and total: every unresolvable label becomes `null`, never a
 * uuid, never a guess, and never a dropped row — a candidate whose labels are unavailable is still a decision the human owns.
 *
 * ORDERING IS THE LOAD-BEARING PART, twice over:
 *
 *   candidates  by label, then instance, then match id. Alphabetical is the only order that asserts nothing. There is no
 *               confidence to sort by (the read does not return it) and no arrival order (no timestamp either), which is the
 *               contract holding: docs/79 forbids confidence, arrival order and arithmetic from picking one.
 *   groups      the ones with open questions first, then by label. This ranks GROUPS — a queue putting outstanding work
 *               first — and never ranks the candidates INSIDE one, which is the only place ranking would be a claim.
 */
export function buildReviewGroups(rows: readonly MatchRow[], labels: ReviewLabels): readonly ReviewGroupView[] {
  const byApplication = new Map<string, MatchRow[]>();
  for (const r of rows) {
    const bucket = byApplication.get(r.directoryApplicationId);
    if (bucket === undefined) byApplication.set(r.directoryApplicationId, [r]);
    else bucket.push(r);
  }

  const groups: ReviewGroupView[] = [];
  for (const [directoryApplicationId, bucket] of byApplication) {
    const withLabels = bucket.map((r) => {
      const a = labels.app.get(r.appId);
      return { row: r, recordLabel: a?.recordLabel ?? null, instanceLabel: a?.instanceLabel ?? null };
    });

    // How many candidates in this group share each (label, instance) pair. Anything above one is indistinguishable to a
    // reader, whatever the ids say.
    const seen = new Map<string, number>();
    const key = (c: { recordLabel: string | null; instanceLabel: string | null }) => `${c.recordLabel ?? ""} ${c.instanceLabel ?? ""}`;
    for (const c of withLabels) seen.set(key(c), (seen.get(key(c)) ?? 0) + 1);

    const candidates: MatchCandidateView[] = withLabels
      .map((c) => ({
        matchId: c.row.matchId,
        appId: c.row.appId,
        recordLabel: c.recordLabel,
        instanceLabel: c.instanceLabel,
        status: c.row.status,
        ambiguous: (seen.get(key(c)) ?? 0) > 1,
      }))
      .sort((a, b) => byText(a.recordLabel, b.recordLabel) || byText(a.instanceLabel, b.instanceLabel) || a.matchId.localeCompare(b.matchId));

    const productId = labels.productOf.get(directoryApplicationId) ?? null;
    groups.push({
      directoryApplicationId,
      applicationLabel: labels.application.get(directoryApplicationId) ?? null,
      productLabel: productId === null ? null : labels.productName.get(productId) ?? null,
      openCount: candidates.filter((c) => c.status === "proposed").length,
      candidates,
    });
  }

  return groups.sort(
    (a, b) =>
      Number(b.openCount > 0) - Number(a.openCount > 0) ||
      byText(a.applicationLabel, b.applicationLabel) ||
      a.directoryApplicationId.localeCompare(b.directoryApplicationId),
  );
}
