// Phase 16 — the tenant-wide cross-source governance engine.
//
// Deterministic: same canonical rows in, byte-identical findings out. No LLM, no fuzzy or display-name matching, no
// domain-only identity inference, no clock, no randomness, no DB call, no provider module. The engine decides WHETHER a
// finding exists; explaining and prioritising it is somebody else's job, later.
//
// ══ THE RULE THAT GOVERNS EVERY RULE ═════════════════════════════════════════════════════════════════════════════════
// A missing row means one of: true absence · a stale source · an incomplete sync · an unsupported capability · a
// disconnected provider. Those are NOT equivalent, and only the first licenses a finding. So every rule below declares,
// explicitly:
//
//   OPEN REQUIRES  — the capabilities that must be `available` before the rule may assert anything at all;
//   CLOSE REQUIRES — the connections handed to 0083 as `complete_connection_ids`, which gate resolution.
//
// When the open requirement is unmet the rule is WITHHELD (reported in `withheldRules`) rather than evaluated to zero.
// A rule that returns no findings because it could not look is a lie told in the shape of good news.

import { crossSourceFindingKey } from "./finding-id";
import {
  CAPABILITY,
  CROSS_SOURCE_RULE_VERSION,
  type AppAccountRow,
  type ApplicationCandidateRow,
  type CapabilityName,
  type CrossSourceEvaluation,
  type CrossSourceFinding,
  type CrossSourceGraph,
  type CrossSourceRuleId,
  type PersonAccountLinkRow,
  type UnmanagedApplicationReason,
} from "./types";

if (typeof (globalThis as { window?: unknown }).window !== "undefined") {
  throw new Error("cross-source-governance/evaluate is server-only and must not be imported in client code");
}

const sorted = (xs: Iterable<string>): string[] => [...new Set(xs)].sort();

/** Connections whose named capability is proven `available`. Every other state means "we could not see". */
function completeFor(graph: CrossSourceGraph, capability: CapabilityName): Set<string> {
  return new Set(
    graph.capabilities.filter(c => c.capability === capability && c.state === "available").map(c => c.connectionId),
  );
}

/** A provider account only counts as present evidence when the connector re-confirmed it. */
const isCurrent = (r: { syncStatus: string }): boolean => r.syncStatus === "current";

type Ctx = {
  graph: CrossSourceGraph;
  identityComplete: Set<string>;
  accountsComplete: Set<string>;
  appsComplete: Set<string>;
  /** appAccountId -> its links, any status. */
  linksByAppAccount: Map<string, PersonAccountLinkRow[]>;
  /** personId -> accepted identity/app account ids. */
  acceptedIdentitiesByPerson: Map<string, string[]>;
  acceptedAppAccountsByPerson: Map<string, string[]>;
  /**
   * directoryApplicationId -> its 0090 candidate rows. A MISSING key and an empty array mean different things — see
   * `unmanagedReason` — so this is built by presence, and no default is ever supplied for a key that is not there.
   */
  candidatesByApplication: Map<string, ApplicationCandidateRow[]>;
  /**
   * Has person resolution produced ANY output for this tenant? An empty link table is indistinguishable from "every
   * account is an orphan", and treating it as the latter would flag a whole estate the moment 0082 shipped. Empty
   * matcher state is UNKNOWN, never a conclusion — the same rule that keeps rule 5 silent today.
   */
  resolutionHasRun: boolean;
};

function buildCtx(graph: CrossSourceGraph): Ctx {
  const linksByAppAccount = new Map<string, PersonAccountLinkRow[]>();
  const acceptedIdentitiesByPerson = new Map<string, string[]>();
  const acceptedAppAccountsByPerson = new Map<string, string[]>();
  for (const l of graph.personAccountLinks) {
    if (l.appAccountId) {
      const cur = linksByAppAccount.get(l.appAccountId);
      if (cur) cur.push(l);
      else linksByAppAccount.set(l.appAccountId, [l]);
    }
    if (l.status !== "accepted") continue;
    const target = l.identityAccountId ? acceptedIdentitiesByPerson : acceptedAppAccountsByPerson;
    const id = l.identityAccountId ?? l.appAccountId;
    if (!id) continue;
    const cur = target.get(l.personId);
    if (cur) cur.push(id);
    else target.set(l.personId, [id]);
  }
  const candidatesByApplication = new Map<string, ApplicationCandidateRow[]>();
  for (const c of graph.applicationCandidates) {
    const cur = candidatesByApplication.get(c.directoryApplicationId);
    if (cur) cur.push(c);
    else candidatesByApplication.set(c.directoryApplicationId, [c]);
  }
  return {
    graph,
    candidatesByApplication,
    identityComplete: completeFor(graph, CAPABILITY.identity),
    accountsComplete: completeFor(graph, CAPABILITY.appAccounts),
    appsComplete: completeFor(graph, CAPABILITY.applications),
    linksByAppAccount,
    acceptedIdentitiesByPerson,
    acceptedAppAccountsByPerson,
    resolutionHasRun: graph.personAccountLinks.length > 0,
  };
}

/**
 * Does this account have an owner?
 *
 * The two orphan rules answer that question differently ON PURPOSE.
 *
 * For an ORDINARY account, a `proposed` link counts: it means "we found a candidate and a human has not decided yet",
 * and reporting that as an orphan just hands the reviewer their own queue back as a governance problem.
 *
 * For a PRIVILEGED account it does NOT count — `acceptedOnly`. An undecided proposal is a queue entry, not an owner,
 * and a proposal never expires: a wrong proposal, or simply nobody reviewing, would hide an unowned ADMIN account for
 * as long as the queue is ignored. That is a real false negative with an indefinite lifetime, and the account class it
 * hides is exactly the one worth not hiding. Only an accepted owner silences that rule.
 */
function hasOwner(ctx: Ctx, account: AppAccountRow, acceptedOnly: boolean): boolean {
  const links = ctx.linksByAppAccount.get(account.id);
  if (!links) return false;
  return acceptedOnly
    ? links.some(l => l.status === "accepted")
    : links.some(l => l.status === "accepted" || l.status === "proposed");
}

/** The human, currently-confirmed, provider-active accounts — the only ones any orphan rule may speak about. */
function liveHumanAccounts(ctx: Ctx): AppAccountRow[] {
  return ctx.graph.appAccounts.filter(
    a =>
      a.accountKind === "human" &&
      a.accountStatus === "active" &&
      isCurrent(a) &&
      ctx.accountsComplete.has(a.connectionId),
  );
}

// ══ RULE 1 ═══════════════════════════════════════════════════════════════════════════════════════════════════════════
// ACTIVE_SAAS_ACCOUNT_WITHOUT_ACCEPTED_IDENTITY — an active human SaaS account nobody owns.
//
// OPEN REQUIRES:  at least one connection with `identity` available (otherwise "no identity exists" is unprovable);
//                 the account's own connection with `app_accounts` available; and person resolution to have produced
//                 output at all. Admin accounts are excluded — rule 3 owns those, so one account yields one finding.
// CLOSE REQUIRES: the same set — the SaaS connection plus every identity connection.
function ruleOrphanAccounts(ctx: Ctx, privileged: boolean): CrossSourceFinding[] {
  const ruleId: CrossSourceRuleId = privileged
    ? "privileged_saas_account_without_accepted_identity"
    : "active_saas_account_without_accepted_identity";
  const identityConnections = sorted(ctx.identityComplete);

  return liveHumanAccounts(ctx)
    .filter(a => (privileged ? a.isAdmin === true : a.isAdmin !== true))
    // Privileged accounts require an ACCEPTED owner; ordinary ones are also shielded by a pending proposal.
    .filter(a => !hasOwner(ctx, a, privileged))
    .map(a => ({
      finding_key: crossSourceFindingKey({
        ruleId,
        tenantId: ctx.graph.tenantId,
        subjectType: "app_account",
        subjectId: a.id,
      }),
      rule_id: ruleId,
      subject_type: "app_account" as const,
      subject_id: a.id,
      // A privileged account with no owner is materially worse than an ordinary one, and that is a property of the
      // fact, not of how sure we are — so it moves severity and leaves confidence alone.
      severity: privileged ? ("high" as const) : ("medium" as const),
      confidence: "high" as const,
      title_key: `crossSource.${ruleId}.title`,
      summary_key: `crossSource.${ruleId}.summary`,
      remediation_key: `crossSource.${ruleId}.remediation`,
      evidence: {
        counts: { accounts: 1, identityConnectionsProven: identityConnections.length },
        supportingIds: [a.id],
      },
      source_providers: sorted([a.provider]),
      evidence_connection_ids: sorted([a.connectionId, ...identityConnections]),
    }));
}

// ══ RULE 2 ═══════════════════════════════════════════════════════════════════════════════════════════════════════════
// INACTIVE_IDENTITY_WITH_ACTIVE_SAAS_ACCOUNT — the leaver who still has access.
//
// `isActive === false` only. NULL means the provider did not say, and treating unknown as inactive would accuse a live
// employee. Both sides must be currently confirmed, and both are named in the evidence.
//
// OPEN REQUIRES:  the identity connection with `identity` available AND the SaaS connection with `app_accounts`
//                 available — the finding asserts a fact about both sides, so both must be provable.
// CLOSE REQUIRES: both of those connections.
function ruleInactiveIdentityActiveAccount(ctx: Ctx): CrossSourceFinding[] {
  const identityById = new Map(ctx.graph.identityAccounts.map(i => [i.id, i]));
  const accountById = new Map(ctx.graph.appAccounts.map(a => [a.id, a]));
  const out: CrossSourceFinding[] = [];

  for (const [personId, identityIds] of ctx.acceptedIdentitiesByPerson) {
    const inactive = identityIds
      .map(id => identityById.get(id))
      .filter(i => !!i && i.isActive === false && isCurrent(i) && ctx.identityComplete.has(i.connectionId));
    if (inactive.length === 0) continue;

    const live = (ctx.acceptedAppAccountsByPerson.get(personId) ?? [])
      .map(id => accountById.get(id))
      .filter(
        a =>
          !!a &&
          a.accountStatus === "active" &&
          isCurrent(a) &&
          ctx.accountsComplete.has(a.connectionId),
      );
    if (live.length === 0) continue;

    const identityIdsSorted = sorted(inactive.map(i => i!.id));
    const accountIdsSorted = sorted(live.map(a => a!.id));
    out.push({
      finding_key: crossSourceFindingKey({
        ruleId: "inactive_identity_with_active_saas_account",
        tenantId: ctx.graph.tenantId,
        subjectType: "person",
        subjectId: personId,
        relatedIds: [...identityIdsSorted, ...accountIdsSorted],
      }),
      rule_id: "inactive_identity_with_active_saas_account",
      subject_type: "person",
      subject_id: personId,
      severity: "high",
      confidence: "high",
      title_key: "crossSource.inactive_identity_with_active_saas_account.title",
      summary_key: "crossSource.inactive_identity_with_active_saas_account.summary",
      remediation_key: "crossSource.inactive_identity_with_active_saas_account.remediation",
      evidence: {
        counts: { inactiveIdentities: identityIdsSorted.length, activeAccounts: accountIdsSorted.length },
        supportingIds: [...identityIdsSorted, ...accountIdsSorted],
      },
      source_providers: sorted([...inactive.map(i => i!.provider), ...live.map(a => a!.provider)]),
      evidence_connection_ids: sorted([
        ...inactive.map(i => i!.connectionId),
        ...live.map(a => a!.connectionId),
      ]),
    });
  }
  return out;
}

// ══ RULE 4 ═══════════════════════════════════════════════════════════════════════════════════════════════════════════
// DUPLICATE_ACTIVE_ACCOUNTS_FOR_ONE_PERSON.
//
// Holding many accounts is NORMAL — one person legitimately has Okta, Slack and Google — so the naive reading of this
// rule is pure noise. The deterministic, actionable condition is narrower: **two or more active accounts for one person
// within a SINGLE connection**, i.e. duplicates inside one workspace. Across connections it is not a finding, even for
// the same provider: two Okta organisations legitimately hold the same human, which is what 0071 supersession exists
// to describe.
//
// OPEN REQUIRES:  that connection with `app_accounts` available.
// CLOSE REQUIRES: that connection.
function ruleDuplicateAccounts(ctx: Ctx): CrossSourceFinding[] {
  const accountById = new Map(ctx.graph.appAccounts.map(a => [a.id, a]));
  const out: CrossSourceFinding[] = [];

  for (const [personId, accountIds] of ctx.acceptedAppAccountsByPerson) {
    const live = accountIds
      .map(id => accountById.get(id))
      // `human` is load-bearing, not decoration: 0082's proposer only links human accounts, but a MANUAL link can
      // attach anything, and this rule must not depend on another component's filter. A person who owns their login
      // plus a service account has ONE account and a robot, not two duplicates.
      .filter(
        a =>
          !!a &&
          a.accountKind === "human" &&
          a.accountStatus === "active" &&
          isCurrent(a) &&
          ctx.accountsComplete.has(a.connectionId),
      );

    const byConnection = new Map<string, string[]>();
    for (const a of live) {
      const cur = byConnection.get(a!.connectionId);
      if (cur) cur.push(a!.id);
      else byConnection.set(a!.connectionId, [a!.id]);
    }

    for (const connectionId of sorted(byConnection.keys())) {
      const ids = sorted(byConnection.get(connectionId)!);
      if (ids.length < 2) continue;
      out.push({
        finding_key: crossSourceFindingKey({
          ruleId: "duplicate_active_accounts_for_one_person",
          tenantId: ctx.graph.tenantId,
          subjectType: "person",
          subjectId: personId,
          relatedIds: ids,
        }),
        rule_id: "duplicate_active_accounts_for_one_person",
        subject_type: "person",
        subject_id: personId,
        severity: "medium",
        confidence: "high",
        title_key: "crossSource.duplicate_active_accounts_for_one_person.title",
        summary_key: "crossSource.duplicate_active_accounts_for_one_person.summary",
        remediation_key: "crossSource.duplicate_active_accounts_for_one_person.remediation",
        evidence: { counts: { duplicateAccounts: ids.length }, supportingIds: ids },
        source_providers: sorted([accountById.get(ids[0])!.provider]),
        evidence_connection_ids: [connectionId],
      });
    }
  }
  return out;
}

// ══ RULE 5 ═══════════════════════════════════════════════════════════════════════════════════════════════════════════
// DISCOVERED_APPLICATION_UNMANAGED_BY_IDP.
//
// OPEN REQUIRES:  the application's connection with `directory_applications` available, AND the matcher's CURRENT
//                 status to be `completed` (migration 0085). Counting `application_matches` rows cannot substitute:
//                 an empty table means NOT YET LOOKED just as readily as "nothing is managed", and firing on it would
//                 declare a customer's whole estate unmanaged on the strength of code nobody had run. `completed` is
//                 also deliberately stricter than `lastCompletedAt is not null` — that timestamp survives a later
//                 failure, so a run that failed this morning must not present yesterday's completeness as today's.
// CLOSE REQUIRES: that application's connection.
//
// ── PHASE 18D: THE SUBTYPE DECIDES THE REMEDIATION, NEVER THE FINDING ────────────────────────────────────────────────
// Whether the finding OPENS is decided exactly as it was before: current application, complete application source,
// completed matcher, no accepted match. The candidate feed is consulted only AFTERWARDS, to say which of the three
// distinguishable situations the subject is in — because "confirm what this software is" and "link it to an operational
// record" are not the same instruction, and one of them is useless in the other's state.
//
// The subtype is deliberately absent from the finding key, so a subject moving between states is a REFRESH of one
// finding (0083 updates the copy keys and evidence on conflict, and never moves `first_seen_at`) rather than a close
// and a re-open. An administrator watching a queue sees the advice change, not the problem restart.
function ruleUnmanagedApplications(ctx: Ctx): CrossSourceFinding[] {
  const matched = new Set(
    ctx.graph.applicationMatches.filter(m => m.status === "accepted").map(m => m.directoryApplicationId),
  );
  return ctx.graph.directoryApplications
    .filter(app => isCurrent(app) && ctx.appsComplete.has(app.connectionId) && !matched.has(app.id))
    .map(app => {
      const reason = unmanagedReason(ctx, app.id);
      const stem = `crossSource.discovered_application_unmanaged_by_idp.${reason}`;
      return {
        finding_key: crossSourceFindingKey({
          ruleId: "discovered_application_unmanaged_by_idp",
          tenantId: ctx.graph.tenantId,
          subjectType: "directory_application",
          subjectId: app.id,
        }),
        rule_id: "discovered_application_unmanaged_by_idp" as const,
        subject_type: "directory_application" as const,
        subject_id: app.id,
        // Unchanged by the subtype. Severity and confidence describe the BROAD condition — one unmanaged application —
        // and the customer's next action is not evidence that the finding is more or less certain than it was.
        severity: "low" as const,
        confidence: "medium" as const,
        title_key: `${stem}.title`,
        summary_key: `${stem}.summary`,
        remediation_key: `${stem}.remediation`,
        evidence: { counts: { applications: 1 }, supportingIds: [app.id], reason },
        source_providers: sorted([app.provider]),
        evidence_connection_ids: [app.connectionId],
      };
    });
}

/**
 * Which of the three states this application is in, from 0090's feed and nothing else.
 *
 * ABSENCE FROM THE FEED IS THE UNRESOLVED SIGNAL, and it is only readable because the two feeds are eligible for
 * exactly the same applications: `product_list_directory_applications` and 0090's parent CTE share the owner/admin
 * gate, the superseded/disconnected exclusion and `sync_status = 'current'` — which `isCurrent` above has already
 * applied. The feed then narrows on one further thing, a confirmed `provider_app_id` alias, so an application this rule
 * can speak about is missing from the feed for exactly one reason: its canonical product is not settled.
 *
 * A NULL `appId` is the feed's explicit zero-instance statement rather than the absence of a row (0090 LEFT JOINs to
 * say so), which is what keeps "recognised, nothing to link" apart from "not recognised".
 */
function unmanagedReason(ctx: Ctx, directoryApplicationId: string): UnmanagedApplicationReason {
  const rows = ctx.candidatesByApplication.get(directoryApplicationId);
  if (rows === undefined) return "product_unresolved";
  return rows.some(r => r.appId !== null) ? "operational_match_unaccepted" : "operational_instance_absent";
}

/**
 * Why rule 5 is staying quiet. Each of these is a DIFFERENT reason an application has no accepted match, and only
 * `completed` licenses the conclusion that the absence is real.
 */
function matcherWithheldReason(m: CrossSourceGraph["matcherState"]): string {
  if (!m.hasEverRun || m.status === null) {
    return "the application matcher has never run, so an unmatched application is unknown rather than unmanaged";
  }
  if (m.status === "running") return "an application matcher run is still in flight, so its output is not yet complete";
  return "the most recent application matcher run did not complete, so absence of a match proves nothing";
}

/**
 * The connections whose evidence is complete enough to CLOSE a finding.
 *
 * This is deliberately NOT the union of the three per-capability sets, and the difference is a real defect rather than
 * a refinement. 0083 closes a finding when `evidence_connection_ids <@ p_complete_connection_ids` — a FLAT subset test
 * that cannot know which capability a given finding rested on. So a connection that is `available` for `identity` but
 * `incomplete` for `app_accounts` would, under a union, license the closure of an app-account finding that this very
 * run withheld for lack of app-account completeness. The engine would say "no connection has proven its SaaS account
 * list is complete" and, in the same payload, hand 0083 the proof it needs to close exactly that finding.
 *
 * The rule here: a connection is closure-eligible only when EVERY capability it has DECLARED (among the three this
 * engine understands) is `available`. A capability a connector never attempted has no row at all — the writer
 * (`runner_record_capability_state`) only records what was tried — so a connector that legitimately has no directory
 * identity is unaffected, while one that tried and came back degraded is excluded.
 *
 * The per-capability sets above are UNCHANGED: they decide whether a rule may OPEN, and that decision is already
 * correctly scoped. Only the CLOSURE licence is narrowed, because only the closure test is flat.
 *
 * The precise long-term fix is per-capability closure scope in 0083's contract, which needs a migration; this is the
 * correct behaviour available without one, and it errs toward withholding rather than closing.
 *
 * ══ THE SAME DEFECT ALONG THE MATCHER AXIS ═══════════════════════════════════════════════════════════════════════════
 * Capability degradation is not the only way a rule can go quiet while its connection stays "healthy". Rule 5 is also
 * gated on the matcher's CURRENT status, and a matcher failure does not touch any capability — so a withheld rule 5
 * used to leave its directory-application connection fully closure-eligible. 0083 then saw the finding absent from the
 * payload, saw its evidence covered, and closed a condition that was still true. It landed in `closed` rather than
 * `withheld_from_closure`, so the estate appeared to improve because proof was missing.
 *
 * A caller-side precondition cannot fix this. The caller's matcher read and this evaluation's are separate statements,
 * and a concurrent matcher run between them flips the state after the caller has decided. The decision has to be made
 * where the withholding decision itself is made — from THIS graph — which is why it lives here.
 *
 * WHY `hasEverRun` IS PART OF THE CONDITION. `application_matcher_state` gains its row on the first `start` and keeps
 * it, so `hasEverRun: false` proves rule 5 has never fired and therefore that no rule 5 finding can exist to protect.
 * Withdrawing the licence there would buy nothing and would permanently hold open every OTHER rule's findings on a
 * directory connection, for any tenant that simply never runs the matcher. The withdrawal is therefore scoped to the
 * transient states — `running` and `failed` — where a finding really can be waiting.
 *
 * The cost is a DELAY, and it is deliberate: a connector serving both `identity` and `directory_applications` loses
 * closure for both while the matcher is unwell, because the subset test cannot separate them. The next completed-matcher
 * run restores it. False closure is unacceptable; delayed closure is not.
 */
function closureEligibleConnections(graph: CrossSourceGraph, ctx: Ctx): string[] {
  const degraded = new Set(
    graph.capabilities
      .filter(c => (c.capability === "identity" || c.capability === "app_accounts" || c.capability === "directory_applications")
        && c.state !== "available")
      .map(c => c.connectionId),
  );
  // Read from the SAME graph that gates rule 5 below, so the licence and the withholding cannot disagree.
  const m = graph.matcherState;
  const matcherCannotReprove = m.hasEverRun && m.status !== "completed";

  return sorted(
    [...ctx.identityComplete, ...ctx.accountsComplete, ...ctx.appsComplete]
      .filter(id => !degraded.has(id))
      .filter(id => !(matcherCannotReprove && ctx.appsComplete.has(id))),
  );
}

/**
 * Evaluate every supported rule over one tenant's canonical rows.
 *
 * Findings are sorted (severity desc, then ruleId, subjectId, key) so repeated evaluation of the same input is
 * byte-identical. `detectedAt` appears nowhere: first/last seen are the persistence layer's business (0083), and
 * folding a clock into a finding would give it a new identity every run.
 */
export function evaluateCrossSourceGovernance(graph: CrossSourceGraph): CrossSourceEvaluation {
  const ctx = buildCtx(graph);
  const findings: CrossSourceFinding[] = [];
  const evaluatedRules: CrossSourceRuleId[] = [];
  const withheldRules: { ruleId: CrossSourceRuleId; reason: string }[] = [];

  const gate = (ruleId: CrossSourceRuleId, ok: boolean, reason: string, run: () => CrossSourceFinding[]) => {
    if (!ok) {
      withheldRules.push({ ruleId, reason });
      return;
    }
    evaluatedRules.push(ruleId);
    findings.push(...run());
  };

  const anyIdentitySource = ctx.identityComplete.size > 0;
  const anyAccountSource = ctx.accountsComplete.size > 0;

  const orphanGate = anyIdentitySource && anyAccountSource && ctx.resolutionHasRun;
  const orphanReason = !anyAccountSource
    ? "no connection has proven its SaaS account list is complete"
    : !anyIdentitySource
      ? "no connection has proven its directory identity list is complete, so an account cannot be shown to be unowned"
      : "person resolution has produced no links yet, so an unlinked account is unknown rather than unowned";

  gate("active_saas_account_without_accepted_identity", orphanGate, orphanReason, () => ruleOrphanAccounts(ctx, false));
  gate("privileged_saas_account_without_accepted_identity", orphanGate, orphanReason, () =>
    ruleOrphanAccounts(ctx, true),
  );
  gate(
    "inactive_identity_with_active_saas_account",
    anyIdentitySource && anyAccountSource,
    "both a directory identity source and a SaaS account source must be complete to assert a fact about both sides",
    () => ruleInactiveIdentityActiveAccount(ctx),
  );
  gate(
    "duplicate_active_accounts_for_one_person",
    anyAccountSource,
    "no connection has proven its SaaS account list is complete",
    () => ruleDuplicateAccounts(ctx),
  );
  const matcher = graph.matcherState;
  gate(
    "discovered_application_unmanaged_by_idp",
    ctx.appsComplete.size > 0 && matcher.status === "completed",
    matcher.status !== "completed"
      ? matcherWithheldReason(matcher)
      : "no connection has proven its directory application list is complete",
    () => ruleUnmanagedApplications(ctx),
  );

  const rank = { high: 0, medium: 1, low: 2, info: 3 } as const;
  findings.sort(
    (a, b) =>
      rank[a.severity] - rank[b.severity] ||
      a.rule_id.localeCompare(b.rule_id) ||
      a.subject_id.localeCompare(b.subject_id) ||
      a.finding_key.localeCompare(b.finding_key),
  );

  return {
    findings,
    ruleVersion: CROSS_SOURCE_RULE_VERSION,
    evaluatedRules,
    withheldRules,
    // Handed to 0083 as `p_complete_connection_ids`: a finding may only be resolved by a run that could actually see
    // every source it rests on.
    completeConnectionIds: closureEligibleConnections(graph, ctx),
  };
}
