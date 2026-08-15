// Phase 18F-C2 — rule 5's withholding and the closure licence must come from ONE snapshot.
//
// ══ THE RACE THIS EXISTS FOR ═════════════════════════════════════════════════════════════════════════════════════════
// Rule 5 fires only while the matcher's CURRENT status is `completed`, and its findings carry the directory
// application's connection as their evidence. Migration 0083 closes any open finding of this engine that is ABSENT
// from a run's payload and whose evidence connections are all in `p_complete_connection_ids` — a flat subset test with
// no notion of which rule produced a finding, or whether that rule ran.
//
// So a run that withholds rule 5 used to hand 0083 both halves of a false closure at once: the finding goes missing
// from the payload, and its connection stays closure-eligible because the CONNECTOR is perfectly healthy — only the
// matcher is unwell. 0083 read "absent + covered" as "the condition ended".
//
// A caller-side precondition cannot fix this: the caller's matcher read and the engine's are two statements, and a
// concurrent matcher run between them flips the state after the caller has already decided. The decision therefore has
// to be made where BOTH facts come from the same graph — here.
//
// ══ WHAT THE FIX DOES NOT DO ═════════════════════════════════════════════════════════════════════════════════════════
// It does not mark rule 5 resolved, fabricate a finding, touch matcher state, or change what OPENS. It removes the
// directory-application connections from the CLOSURE licence for that one evaluation, so a finding that cannot be
// re-proven cannot be closed either. Closure is delayed until a run that can prove it — never denied permanently.

import { describe, expect, it } from "vitest";
import { evaluateCrossSourceGovernance } from "./evaluate";
import type {
  AppAccountRow, CrossSourceGraph, DirectoryApplicationRow, IdentityAccountRow, PersonAccountLinkRow, SourceCapability,
} from "./types";

const TENANT = "11111111-1111-4111-8111-111111111111";
const OKTA = "22222222-2222-4222-8222-222222222222";   // identity AND directory_applications
const SLACK = "33333333-3333-4333-8333-333333333333";  // app_accounts only

const RULE5 = "discovered_application_unmanaged_by_idp";

const cap = (connectionId: string, provider: string, capability: SourceCapability["capability"],
  state: SourceCapability["state"] = "available"): SourceCapability => ({ connectionId, provider, capability, state });

const app = (id: string, connectionId = OKTA): DirectoryApplicationRow =>
  ({ id, connectionId, provider: "okta", syncStatus: "current" });
const account = (id: string, o: Partial<AppAccountRow> = {}): AppAccountRow =>
  ({ id, connectionId: SLACK, provider: "slack", syncStatus: "current", accountKind: "human",
     accountStatus: "active", isAdmin: null, ...o });
const identity = (id: string, o: Partial<IdentityAccountRow> = {}): IdentityAccountRow =>
  ({ id, connectionId: OKTA, provider: "okta", syncStatus: "current", isActive: true, ...o });
const link = (o: Partial<PersonAccountLinkRow> & { personId: string }): PersonAccountLinkRow =>
  ({ identityAccountId: null, appAccountId: null, status: "accepted", ...o });

const COMPLETED = { hasEverRun: true, status: "completed", lastCompletedAt: "2026-01-01T00:00:00Z" } as const;
const FAILED_HIST = { hasEverRun: true, status: "failed", lastCompletedAt: "2026-01-01T00:00:00Z" } as const;
const RUNNING_HIST = { hasEverRun: true, status: "running", lastCompletedAt: "2026-01-01T00:00:00Z" } as const;
const FAILED_NO_HIST = { hasEverRun: true, status: "failed", lastCompletedAt: null } as const;
const NEVER = { hasEverRun: false, status: null, lastCompletedAt: null } as const;

const graph = (o: Partial<CrossSourceGraph> = {}): CrossSourceGraph => ({
  tenantId: TENANT,
  capabilities: [cap(OKTA, "okta", "directory_applications")],
  identityAccounts: [], appAccounts: [], personAccountLinks: [],
  directoryApplications: [app("app-1")], applicationMatches: [], applicationCandidates: [],
  matcherState: COMPLETED,
  ...o,
});

describe("a completed matcher is unaffected — rule 5 opens and its connection stays closure-eligible", () => {
  it("reports rule 5 and licenses OKTA for closure", () => {
    const e = evaluateCrossSourceGovernance(graph());
    expect(e.findings.map(f => f.rule_id)).toContain(RULE5);
    expect(e.findings.find(f => f.rule_id === RULE5)!.evidence_connection_ids).toEqual([OKTA]);
    expect(e.completeConnectionIds).toContain(OKTA);
  });

  it("an application that is genuinely matched stops reporting, and closure stays licensed", () => {
    // This is what a REAL resolution looks like: rule 5 evaluated, nothing reported, connection eligible → 0083 closes.
    const e = evaluateCrossSourceGovernance(graph({
      applicationMatches: [{ directoryApplicationId: "app-1", status: "accepted" }],
    }));
    expect(e.evaluatedRules).toContain(RULE5);
    expect(e.findings.some(f => f.rule_id === RULE5)).toBe(false);
    expect(e.completeConnectionIds).toContain(OKTA); // closure must remain possible
  });
});

describe("THE FIX — a matcher-withheld rule 5 withdraws its own closure licence", () => {
  it.each([
    ["failed with history", FAILED_HIST],
    ["failed without history", FAILED_NO_HIST],
    ["running with history", RUNNING_HIST],
  ])("matcher %s: rule 5 withheld AND OKTA is no longer closure-eligible", (_label, matcherState) => {
    const e = evaluateCrossSourceGovernance(graph({ matcherState }));
    expect(e.withheldRules.map(r => r.ruleId)).toContain(RULE5);
    expect(e.findings.some(f => f.rule_id === RULE5)).toBe(false);
    // The load-bearing assertion: 0083 cannot close a finding whose evidence is [OKTA] if OKTA is not covered.
    expect(e.completeConnectionIds).not.toContain(OKTA);
  });

  it("keyed on CURRENT status, never on last_completed_at", () => {
    // A surviving completion timestamp is exactly what makes this race look safe. It must not license closure.
    const e = evaluateCrossSourceGovernance(graph({ matcherState: FAILED_HIST }));
    expect(FAILED_HIST.lastCompletedAt).not.toBeNull();
    expect(e.completeConnectionIds).not.toContain(OKTA);
  });

  it("NEVER-RUN is left alone — rule 5 can never have opened a finding, so nothing needs protecting", () => {
    // `application_matcher_state` gains its row on the first `start` and keeps it, so `hasEverRun: false` proves no
    // rule 5 finding was ever raised by this engine. Withdrawing the licence here would freeze OTHER rules' closures
    // for a tenant that simply never runs the matcher, which is a permanent cost for no protection.
    const e = evaluateCrossSourceGovernance(graph({ matcherState: NEVER }));
    expect(e.withheldRules.map(r => r.ruleId)).toContain(RULE5);
    expect(e.completeConnectionIds).toContain(OKTA);
  });
});

describe("the withdrawal is SCOPED to directory-application connections", () => {
  const withBoth = (matcherState: CrossSourceGraph["matcherState"]) =>
    evaluateCrossSourceGovernance(graph({
      matcherState,
      capabilities: [cap(OKTA, "okta", "directory_applications"), cap(OKTA, "okta", "identity"), cap(SLACK, "slack", "app_accounts")],
      identityAccounts: [identity("i1")],
      appAccounts: [account("a1")],
      personAccountLinks: [link({ personId: "p1", appAccountId: "a1" })],
    }));

  it("a pure app-accounts connection keeps its closure licence", () => {
    const e = withBoth(FAILED_HIST);
    expect(e.completeConnectionIds).toContain(SLACK);   // untouched
    expect(e.completeConnectionIds).not.toContain(OKTA); // withdrawn
  });

  it("THE TRADEOFF, stated: a connector serving BOTH identity and applications loses closure for both, for this run", () => {
    // OKTA carries `identity` too, so identity-bearing findings on OKTA are also held open this run. That is a DELAY,
    // not a freeze — the next completed-matcher run restores it (proved below). Delayed closure is acceptable; false
    // closure is not.
    const e = withBoth(FAILED_HIST);
    expect(e.completeConnectionIds).not.toContain(OKTA);
  });

  it("and the delay ends: the same estate with a completed matcher licenses OKTA again", () => {
    expect(withBoth(COMPLETED).completeConnectionIds).toContain(OKTA);
  });
});

describe("nothing else about the evaluation changes", () => {
  it.each([COMPLETED, FAILED_HIST, RUNNING_HIST, NEVER])("matcher %o: opening/reporting is untouched", (matcherState) => {
    const withApps = graph({
      matcherState,
      capabilities: [cap(OKTA, "okta", "identity"), cap(SLACK, "slack", "app_accounts"), cap(OKTA, "okta", "directory_applications")],
      identityAccounts: [identity("i1")],
      appAccounts: [account("a1")],
      personAccountLinks: [link({ personId: "p1", identityAccountId: "i1" })],
    });
    const e = evaluateCrossSourceGovernance(withApps);
    // The orphan rule still fires on its own merits regardless of matcher state — this fix touches CLOSURE only.
    expect(e.evaluatedRules).toContain("active_saas_account_without_accepted_identity");
    expect(e.findings.some(f => f.rule_id === "active_saas_account_without_accepted_identity")).toBe(true);
  });

  it("a degraded directory connector is still excluded, as before", () => {
    const e = evaluateCrossSourceGovernance(graph({
      matcherState: COMPLETED,
      capabilities: [cap(OKTA, "okta", "directory_applications", "incomplete")],
    }));
    expect(e.completeConnectionIds).not.toContain(OKTA);
  });

  it("no connection outside this tenant's graph can enter the closure set", () => {
    const e = evaluateCrossSourceGovernance(graph({ matcherState: COMPLETED }));
    expect(e.completeConnectionIds.every(id => id === OKTA || id === SLACK)).toBe(true);
  });
});

// ── The invariant, quantified over every matcher state rather than asserted line by line ────────────────────────────
describe("INVARIANT — withholding and the closure licence are decided together, from one graph", () => {
  const STATES = [
    { label: "never run", m: NEVER },
    { label: "running, no history", m: { hasEverRun: true, status: "running", lastCompletedAt: null } as const },
    { label: "running, history", m: RUNNING_HIST },
    { label: "failed, no history", m: FAILED_NO_HIST },
    { label: "failed, history", m: FAILED_HIST },
    { label: "completed", m: COMPLETED },
  ];

  it.each(STATES)("$label — rule 5 licensed ⇔ its connections are closure-eligible", ({ m }) => {
    const e = evaluateCrossSourceGovernance(graph({ matcherState: m }));
    const rule5Ran = e.evaluatedRules.includes(RULE5);
    const appConnectionEligible = e.completeConnectionIds.includes(OKTA);

    if (rule5Ran) {
      // The rule re-proved the estate, so closing what it no longer reports is correct.
      expect(appConnectionEligible).toBe(true);
    } else if (m.hasEverRun) {
      // The rule could not re-prove anything AND a finding may exist → the licence must be withdrawn.
      expect(appConnectionEligible).toBe(false);
    } else {
      // Never run: rule 5 has never opened a finding, so there is nothing to protect and no reason to hold
      // other rules' closures hostage.
      expect(appConnectionEligible).toBe(true);
    }
  });

  it("the licence is a pure function of the graph — same input, same answer", () => {
    // No clock, no second read, nothing that could differ between the withholding decision and the licence.
    const g = graph({ matcherState: FAILED_HIST });
    const a = evaluateCrossSourceGovernance(g);
    const b = evaluateCrossSourceGovernance(g);
    expect(a.completeConnectionIds).toEqual(b.completeConnectionIds);
    expect(a.withheldRules).toEqual(b.withheldRules);
  });

  it("a withheld rule 5 can never coexist with its own closure licence", () => {
    for (const m of [RUNNING_HIST, FAILED_HIST, FAILED_NO_HIST]) {
      const e = evaluateCrossSourceGovernance(graph({ matcherState: m }));
      const withheld = e.withheldRules.some(r => r.ruleId === RULE5);
      expect(withheld).toBe(true);
      expect(e.completeConnectionIds.some(id => id === OKTA)).toBe(false);
    }
  });
});
