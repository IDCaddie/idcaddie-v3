// Phase 18F-C — the PURE half of the internal governance ops surface. No React, no next, no "use client", no I/O, no
// clock: the same inputs always produce the same view, which is what makes the operator's reading of it testable.
//
// ══ THE ONE THING THIS FILE EXISTS TO PREVENT ════════════════════════════════════════════════════════════════════════
// `application_matcher_state` carries a CURRENT status and a `last_completed_at` that SURVIVES a later failure (0085
// clears neither on failure, deliberately — an earlier successful run really did happen). A surface that leads with the
// timestamp therefore shows "completed 09:14" to an operator whose matcher failed at 11:02, and rule 5 — which is
// gated on the current status being `completed`, never on the timestamp being non-null — has silently stopped firing
// while the page says everything ran. So the headline is ALWAYS the current status, and a surviving completion is
// rendered only as an explicitly historical fact beside it.
//
// ══ NEVER-RUN IS NOT A ZERO ══════════════════════════════════════════════════════════════════════════════════════════
// The same distinction one level up: `hasEverRun: false` means nobody has looked, which is not "looked and found
// nothing". Rule 5 withholds in both, and only one of them is fixed by running the matcher. They get different copy.
//
// Nothing here decides access, and nothing here reads a secret: its inputs are a status enum, two timestamps, bounded
// failure literals and integer counts.

import type { MatcherState } from "@/lib/data/governance-ops";

/** The surface's own route. It lives here rather than in `actions.ts` — see the note there. */
export const OPS_PATH = "/internal/governance-ops";

// ── Enablement ───────────────────────────────────────────────────────────────────────────────────────────────────────
// Fail-closed, allowlist-shaped, reading the trusted env map ONLY — a request header, query, body or cookie cannot turn
// this on. A DISTINCT flag, so enabling any other internal trigger never enables this one.
//
// It is deliberately NOT restricted to local development, and the difference from `isInternalSlackTriggerEnabled` is a
// real one rather than an oversight: that trigger forwards a provider token from a dev-only token source, so it must
// never exist outside a developer's machine. This surface calls two RPCs that are already granted to `authenticated`
// and that re-verify owner/admin inside the database — an operator who can open this page could already call them. The
// page adds a button, not an authority. Staging must be able to enable it, because an engine no one can run on staging
// cannot be accepted there; production stays off unless someone deliberately sets the flag.
const OPS_OPT_IN = "ID_CADDIE_INTERNAL_GOVERNANCE_OPS_ENABLED";

export function isGovernanceOpsEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env[OPS_OPT_IN] === "1";
}

// ── Matcher state ────────────────────────────────────────────────────────────────────────────────────────────────────

/** What an operator must act on. Derived from the CURRENT status alone. */
export type MatcherHeadline = "never_run" | "running" | "completed" | "failed";

export type MatcherStateView = {
  readonly headline: MatcherHeadline;
  readonly headlineLabel: string;
  /** When the CURRENT run started. Null only when none ever has. */
  readonly startedAt: string | null;
  /**
   * When a run last completed successfully — presented ONLY through `historicalCompletionNote`, never as the headline.
   * Null means no run has ever completed, whatever the current status says.
   */
  readonly lastCompletedAt: string | null;
  /**
   * Non-null exactly when a surviving completion could be MISREAD as current — i.e. the current status is not
   * `completed` and a previous one was. This is the sentence that stops the misreading.
   */
  readonly historicalCompletionNote: string | null;
  /** Whether rule 5 may fire right now. 0085's status must be `completed`; the timestamp is not a substitute. */
  readonly rule5Licensed: boolean;
  /** What the current state MEANS for findings — the reason an operator would act, not a restatement of the status. */
  readonly consequence: string;
};

const HEADLINE_LABEL: Record<MatcherHeadline, string> = {
  never_run: "Never run",
  running: "In progress",
  completed: "Completed",
  failed: "Failed",
};

// Deliberately phrased as consequences for FINDINGS. "Failed" tells an operator what happened; "unmanaged-application
// findings are not being raised" tells them why it matters and whether it can wait.
const CONSEQUENCE: Record<MatcherHeadline, string> = {
  never_run:
    "Rule 5 is withheld: an application with no accepted match is unknown rather than unmanaged, so no unmanaged-application finding can be raised or closed.",
  running:
    "Rule 5 is withheld while a run is in flight — its output is not yet complete, so absence of a match proves nothing.",
  completed:
    "Rule 5 is licensed: an application with no accepted match may now be reported as unmanaged.",
  failed:
    "Rule 5 is withheld: the most recent run did not complete, so absence of a match proves nothing.",
};

// ── The evaluation precondition ──────────────────────────────────────────────────────────────────────────────────────
//
// ══ WHY A WITHHELD RULE IS STILL NOT A USEFUL STATE TO SYNC IN ═══════════════════════════════════════════════════════
// CORRECTNESS LIVES IN THE ENGINE, NOT HERE. Phase 18F-C2 (#436) made `closureEligibleConnections` withdraw the
// directory-application connections from the closure licence whenever the matcher has run before and its current
// status is not `completed` — so a rule 5 finding can no longer be closed by a run that could not re-prove it, no
// matter which caller triggered the evaluation and no matter when the state changed. This guard is NOT what stops
// false closure, and must not be described as if it were.
//
// What it stops is a WASTED AND MISLEADING RUN. Evaluating while rule 5 is withheld produces a result that says
// nothing about unmanaged applications and that conservatively withholds closures on the affected connections — an
// operator reading it as "the estate is fine" would be reading an incomplete evaluation as a complete one. So the
// surface asks for a successful matcher run first, which is a completeness precondition rather than a safety one.
//
// Per-rule closure licensing still does not exist in 0083's contract, so the engine's protection is deliberately
// coarse: it can delay another rule's closure on a shared connection for one evaluation. That is stated in the
// runbook rather than papered over here.
export type EvaluationBlockReason = "matcher_never_run" | "matcher_running" | "matcher_failed";

export type EvaluationGate =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly reason: EvaluationBlockReason; readonly message: string };

const BLOCKED_BY: Record<Exclude<MatcherHeadline, "completed">, { reason: EvaluationBlockReason; message: string }> = {
  never_run: {
    reason: "matcher_never_run",
    message:
      "Run the application matcher before evaluating governance. Until it has completed once, rule 5 cannot speak about this estate, so an evaluation now would return a deliberately incomplete result. Nothing was evaluated and no finding was changed.",
  },
  running: {
    reason: "matcher_running",
    message:
      "The matcher is currently running. Wait for it to finish before evaluating governance — rule 5 is withheld while a run is in flight, so this evaluation would be incomplete. Nothing was evaluated and no finding was changed.",
  },
  failed: {
    reason: "matcher_failed",
    message:
      "The matcher is currently failed. Governance evaluation is unavailable until a matcher run completes successfully. A previous run may have completed — that history does not make the current state healthy, because rule 5 reads the current status. The engine preserves closure safety while matcher evidence cannot be re-proven; re-run the matcher first to produce a COMPLETE governance result. Nothing was evaluated and no finding was changed.",
  },
};

/**
 * May the operator run the evaluation right now?
 *
 * Derived from `toMatcherStateView(...).headline`, which is a function of the CURRENT status alone — so a surviving
 * `last_completed_at` can never unlock this, by construction rather than by a second rule that could drift from the
 * first.
 */
export function evaluationGate(state: MatcherState): EvaluationGate {
  const { headline } = toMatcherStateView(state);
  if (headline === "completed") return { allowed: true };
  return { allowed: false, ...BLOCKED_BY[headline] };
}

/**
 * The rule whose withholding is unsafe to sync in. If a run we ALLOWED still reports this rule as withheld, the matcher
 * state changed after the precondition was checked and before the engine read it — see `runEvaluationAction`.
 */
export const CLOSURE_UNSAFE_WITHHELD_RULE = "discovered_application_unmanaged_by_idp";

export const MID_RUN_STATE_CHANGE_NOTE =
  "INCOMPLETE — the matcher state changed while this evaluation was running: it was authorized with the matcher " +
  "`completed`, but the engine then read a different status and withheld rule 5. Closure stayed protected — the engine " +
  "withdraws the closure licence in exactly this state — but this run does not describe unmanaged applications, and it " +
  "may have withheld closures it would otherwise have made. Run the matcher to completion and evaluate again for a " +
  "complete result; if this recurs, check whether another operator is running the matcher at the same time.";

export function toMatcherStateView(state: MatcherState): MatcherStateView {
  // `hasEverRun` and a null status are the same fact from 0085's LEFT JOIN; either one alone means no row exists.
  const headline: MatcherHeadline = !state.hasEverRun || state.status === null ? "never_run" : state.status;

  // A completion that survived into a non-completed state is the misreadable case, and the only one that earns a note.
  const historicalCompletionNote =
    headline !== "completed" && state.lastCompletedAt !== null
      ? "A previous run completed at this timestamp. It does NOT describe the current state — rule 5 reads the current status, not this timestamp."
      : null;

  return {
    headline,
    headlineLabel: HEADLINE_LABEL[headline],
    startedAt: state.hasEverRun ? state.startedAt : null,
    lastCompletedAt: state.lastCompletedAt,
    historicalCompletionNote,
    rule5Licensed: headline === "completed",
    consequence: CONSEQUENCE[headline],
  };
}

// ── Bounded failure reasons ──────────────────────────────────────────────────────────────────────────────────────────
// An ALLOWLIST, not a lookup with a raw fallback. Every reason the matcher and the loader can return is a fixed literal
// today, so echoing an unrecognised one would leak nothing — but the allowlist is what keeps that true: a future
// maintainer who widens either union to carry a message, a predicate or an id gets `UNRECOGNISED_REASON` on screen
// instead of that content. The failure is still reported; only the unvetted string is dropped.
export const UNRECOGNISED_REASON = "The run failed for a reason this page does not recognise. Check the server logs.";

const REASON_LABEL: Record<string, string> = {
  // Shared by both entrypoints.
  not_authorized: "Not authorized — owner or admin of a single active tenant is required.",
  query_failed: "A database read or write failed.",
  pagination_contract_violated: "A canonical read broke its ordering contract; the run stopped rather than read a partial estate.",
  page_limit_exceeded: "A canonical read exceeded its page limit; the run stopped rather than truncate the estate.",
  // Matcher only.
  proposal_rejected: "The match review boundary refused a proposal this matcher is not permitted to make.",
  state_transition_failed: "The run could not be started or completed; another run may have taken over.",
  // Evidence violations from the planner — the canonical layer beneath disagreed with itself.
  candidate_absent_from_census: "Evidence inconsistent: a candidate names an application the census did not return.",
  conflicting_products: "Evidence inconsistent: one application resolved to more than one canonical product.",
  mixed_null_and_concrete: "Evidence inconsistent: one product reported both zero instances and concrete ones.",
  duplicate_candidate_row: "Evidence inconsistent: the candidate feed returned the same pair twice.",
};

export function failureReasonLabel(reason: string): string {
  return REASON_LABEL[reason] ?? UNRECOGNISED_REASON;
}

// ── Run outcomes ─────────────────────────────────────────────────────────────────────────────────────────────────────
// The counts below are TRANSIENT by construction: 0085 persists a status and two timestamps and nothing else, and the
// finding sync's summary is a function return value. That is sufficient precisely because every run is ATTENDED — there
// is no scheduler, so the operator who pressed the button is present to read the outcome. It stops being sufficient the
// moment a run can happen unattended; see docs/runbooks/GOVERNANCE_OPS_RUNBOOK.md.

export type CountRow = { readonly label: string; readonly value: number };

/** Matcher counts, in the order an operator reads them: how big is the estate, then why each part could not be matched. */
export function matcherCountRows(counts: {
  directoryApplicationCount: number;
  unresolvedProductCount: number;
  zeroInstanceCount: number;
  oneCandidateCount: number;
  ambiguousApplicationCount: number;
  candidateCount: number;
}, proposals: {
  createdProposalCount: number;
  existingProposalCount: number;
  acceptedExistingCount: number;
  rejectedExistingCount: number;
}): CountRow[] {
  return [
    { label: "Directory applications seen", value: counts.directoryApplicationCount },
    { label: "Product unresolved", value: counts.unresolvedProductCount },
    { label: "Resolved, zero instances", value: counts.zeroInstanceCount },
    { label: "One candidate", value: counts.oneCandidateCount },
    { label: "Ambiguous candidates", value: counts.ambiguousApplicationCount },
    { label: "Candidate rows read", value: counts.candidateCount },
    { label: "Proposals created", value: proposals.createdProposalCount },
    { label: "Proposals already present", value: proposals.existingProposalCount },
    // Named as decisions rather than as matcher output: the matcher did not accept or reject anything — it re-proposed
    // a pair a human had already settled, and the run left that decision untouched.
    { label: "Already accepted by a human", value: proposals.acceptedExistingCount },
    { label: "Already rejected by a human", value: proposals.rejectedExistingCount },
  ];
}

/** Finding-sync counts. `withheldFromClosure` is last because it is the one a caller must not ignore. */
export function syncCountRows(summary: {
  reported: number;
  opened: number;
  reopened: number;
  refreshed: number;
  closed: number;
  withheldFromClosure: number;
}): CountRow[] {
  return [
    { label: "Reported by the rules", value: summary.reported },
    { label: "Opened", value: summary.opened },
    { label: "Reopened", value: summary.reopened },
    { label: "Refreshed", value: summary.refreshed },
    { label: "Closed", value: summary.closed },
    { label: "Withheld from closure", value: summary.withheldFromClosure },
  ];
}

/**
 * The sentence an operator needs when `withheld_from_closure` is non-zero.
 *
 * A withheld closure is NOT an error and must not read as one: the finding stayed open because this run could not prove
 * the condition had ended, which is the sync behaving correctly on incomplete evidence. Reporting it as a failure would
 * push someone toward "fixing" it by widening what counts as complete — which is exactly how a finding gets closed on
 * evidence that never proved anything.
 */
export function withheldClosureNote(withheldFromClosure: number): string | null {
  if (withheldFromClosure <= 0) return null;
  // The count is all 0083 reports — it does not say WHICH evidence was missing, and inventing a breakdown here would
  // be asserting something the backend never told us. Both causes are named without claiming which applied.
  return `${withheldFromClosure} finding(s) stayed open because this run could not prove the condition had ended — the evidence they rest on was not complete. This is correct behaviour, not a failure: complete the evidence (sync the connectors, and run the matcher to completion) and evaluate again.`;
}

/** Rules that did not run, and why. Already produced by the engine — surfaced rather than recomputed. */
export function withheldRuleRows(
  withheldRules: readonly { readonly ruleId: string; readonly reason: string }[],
): readonly { readonly ruleId: string; readonly reason: string }[] {
  return withheldRules;
}
