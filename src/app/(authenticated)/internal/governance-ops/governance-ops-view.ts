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
    "Rule 5 is withheld: the most recent run did not complete, so absence of a match proves nothing. Findings raised by an earlier run stay open and are not being refreshed.",
};

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
  return `${withheldFromClosure} finding(s) stayed open because this run could not prove the condition had ended — the connector evidence they rest on was not complete. This is correct behaviour, not a failure: re-run once those connectors have synced.`;
}

/** Rules that did not run, and why. Already produced by the engine — surfaced rather than recomputed. */
export function withheldRuleRows(
  withheldRules: readonly { readonly ruleId: string; readonly reason: string }[],
): readonly { readonly ruleId: string; readonly reason: string }[] {
  return withheldRules;
}
