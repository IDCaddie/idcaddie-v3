"use server";

// Phase 18F-C — the two manual, request-driven triggers for the governance engine.
//
// Before this page existed, `runTenantApplicationMatcher` and `evaluateTenantCrossSourceGovernance` had NO production
// caller at all: both were reachable only from their own test suites. The engine was not merely unobservable, it was
// unrunnable — so this file is the operability fix, not a convenience.
//
// EACH ACTION IS A SHELL. It re-checks the env flag (it never trusts the page that rendered the button), resolves
// nothing from the browser, and calls the existing entrypoint unchanged. Authorization is decided where it already
// was: `accessGate()` admits owner/admin of a single active tenant, and every SECURITY DEFINER RPC beneath re-verifies
// the same role via `has_tenant_role`. No tenant id is accepted from the caller and no service-role client exists on
// this path — the writes happen as the signed-in operator, under RLS.
//
// THERE IS NO SCHEDULER. Nothing below is called on a timer, a cron, a webhook or a page load; each runs exactly once
// per button press, by a named human who is present to read the result. That is what makes the transient counts here
// sufficient — see the ceiling note on `OpsActionState`.

import { revalidatePath } from "next/cache";
import { runTenantApplicationMatcher } from "@/lib/data/application-matcher";
import { evaluateTenantCrossSourceGovernance } from "@/lib/data/cross-source-governance-loader";
import { readTenantMatcherState } from "@/lib/data/governance-ops";
import {
  CLOSURE_UNSAFE_WITHHELD_RULE, MID_RUN_STATE_CHANGE_NOTE, OPS_PATH, evaluationGate, failureReasonLabel,
  isGovernanceOpsEnabled, matcherCountRows, syncCountRows, withheldClosureNote,
  type CountRow,
} from "./governance-ops-view";

// NOTE: a `"use server"` module may export ONLY async functions. `OPS_PATH` therefore lives in the pure view module —
// exporting the constant from here silently strips every export from this file's client-facing view, and the page fails
// to build with "the module has no exports at all".

/**
 * One shape for both actions, because an operator reads them the same way: did it work, what did it do, and what
 * should worry me.
 *
 * `counts` and `notes` are TRANSIENT. 0085 persists a status and two timestamps and nothing else; the finding sync's
 * summary is a function return value that vanishes with the request. Persisting them is not needed while every run is
 * attended, and becomes necessary the moment one is not — the ceiling, and the upgrade path, are stated in
 * docs/runbooks/GOVERNANCE_OPS_RUNBOOK.md.
 */
export type OpsActionState = {
  readonly ok: boolean;
  readonly message: string;
  readonly counts: readonly CountRow[];
  readonly notes: readonly string[];
} | null;

const DISABLED: OpsActionState = {
  ok: false,
  message: "The internal governance ops trigger is not enabled in this environment.",
  counts: [],
  notes: [],
};

export async function runMatcherAction(_prev: OpsActionState): Promise<OpsActionState> {
  if (!isGovernanceOpsEnabled(process.env)) return DISABLED;

  const result = await runTenantApplicationMatcher();
  // Revalidated on BOTH paths. A failed run still moved `application_matcher_state` to `failed`, and that is precisely
  // the transition an operator must see reflected above the button.
  revalidatePath(OPS_PATH);

  if (result.status === "failed") {
    return { ok: false, message: `Matcher run failed. ${failureReasonLabel(result.reason)}`, counts: [], notes: [] };
  }
  return {
    ok: true,
    message: "Matcher run completed. Rule 5 is licensed until the next run starts.",
    counts: matcherCountRows(result.counts, result),
    notes: [],
  };
}

export async function runEvaluationAction(_prev: OpsActionState): Promise<OpsActionState> {
  if (!isGovernanceOpsEnabled(process.env)) return DISABLED;

  // ── THE PRECONDITION, ENFORCED HERE AND NOT IN THE UI ──────────────────────────────────────────────────────────────
  // The page also hides the button, but that is a courtesy: a server action is an addressable POST endpoint, so a
  // hostile or stale client can invoke this directly. This check is the authority, and it runs BEFORE the engine — and
  // therefore before any finding-sync mutation — is reached at all.
  //
  // It reads the CURRENT persisted matcher state. `last_completed_at` is not consulted and cannot unlock anything: see
  // `evaluationGate` for why syncing while rule 5 is withheld closes findings that are still true.
  const state = await readTenantMatcherState();
  if (!state.ok) {
    return { ok: false, message: `Evaluation blocked. ${failureReasonLabel(state.error)}`, counts: [], notes: [] };
  }
  const gate = evaluationGate(state.state);
  if (!gate.allowed) return { ok: false, message: gate.message, counts: [], notes: [] };

  const result = await evaluateTenantCrossSourceGovernance();
  revalidatePath(OPS_PATH);

  if (!result.ok) {
    return { ok: false, message: `Evaluation failed. ${failureReasonLabel(result.error)}`, counts: [], notes: [] };
  }

  const { summary } = result;
  const notes: string[] = [];
  const withheld = withheldClosureNote(summary.withheldFromClosure);
  if (withheld !== null) notes.push(withheld);
  // A withheld RULE is a different fact from a withheld CLOSURE and is reported separately: one rule did not run at
  // all, the other ran and declined to close. Collapsing them would let "rule 5 never fired" hide inside a closure count.
  for (const r of summary.withheldRules) notes.push(`Rule not evaluated — ${r.ruleId}: ${r.reason}`);

  // ── MID-RUN STATE CHANGE — AN INCOMPLETENESS SIGNAL, NOT AN INCIDENT ───────────────────────────────────────────────
  // The precondition above and the engine's own matcher read are two separate statements, so a concurrent matcher run
  // between them flips the state after this action has already decided. #436 handles the SAFETY of that from inside the
  // engine — the closure licence is withdrawn from the same graph the withholding decision is made on — so nothing is
  // at risk here. What is affected is COMPLETENESS: the run says nothing about unmanaged applications and may have
  // withheld closures it would otherwise have made. The note exists so the operator knows to run the matcher to
  // completion and evaluate again, rather than reading this run as a full picture.
  if (summary.withheldRules.some(r => r.ruleId === CLOSURE_UNSAFE_WITHHELD_RULE)) {
    notes.push(MID_RUN_STATE_CHANGE_NOTE);
  }

  return {
    ok: true,
    message: `Evaluation completed. Rules evaluated: ${summary.evaluatedRules.length}; withheld: ${summary.withheldRules.length}.`,
    counts: syncCountRows(summary),
    notes,
  };
}
