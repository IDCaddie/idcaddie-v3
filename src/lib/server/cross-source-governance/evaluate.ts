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
  type CapabilityName,
  type CrossSourceEvaluation,
  type CrossSourceFinding,
  type CrossSourceGraph,
  type CrossSourceRuleId,
  type PersonAccountLinkRow,
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
  return {
    graph,
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
// OPEN REQUIRES:  the application's connection with `directory_applications` available, AND `application_matches` to
//                 contain at least one row. That second clause is the whole point: the matcher does not exist yet
//                 (docs/79 — "No matcher exists. The table is empty"), so an empty table means NOT YET LOOKED, not
//                 "nothing is managed". Firing on it would declare a customer's entire estate unmanaged on the strength
//                 of code nobody has written. The rule therefore ships correct and SILENT until a matcher runs.
// CLOSE REQUIRES: that application's connection.
function ruleUnmanagedApplications(ctx: Ctx): CrossSourceFinding[] {
  const matched = new Set(
    ctx.graph.applicationMatches.filter(m => m.status === "accepted").map(m => m.directoryApplicationId),
  );
  return ctx.graph.directoryApplications
    .filter(app => isCurrent(app) && ctx.appsComplete.has(app.connectionId) && !matched.has(app.id))
    .map(app => ({
      finding_key: crossSourceFindingKey({
        ruleId: "discovered_application_unmanaged_by_idp",
        tenantId: ctx.graph.tenantId,
        subjectType: "directory_application",
        subjectId: app.id,
      }),
      rule_id: "discovered_application_unmanaged_by_idp" as const,
      subject_type: "directory_application" as const,
      subject_id: app.id,
      severity: "low" as const,
      confidence: "medium" as const,
      title_key: "crossSource.discovered_application_unmanaged_by_idp.title",
      summary_key: "crossSource.discovered_application_unmanaged_by_idp.summary",
      remediation_key: "crossSource.discovered_application_unmanaged_by_idp.remediation",
      evidence: { counts: { applications: 1 }, supportingIds: [app.id] },
      source_providers: sorted([app.provider]),
      evidence_connection_ids: [app.connectionId],
    }));
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
  gate(
    "discovered_application_unmanaged_by_idp",
    ctx.appsComplete.size > 0 && graph.applicationMatches.length > 0,
    graph.applicationMatches.length === 0
      ? "no application matcher has run, so an unmatched application is unknown rather than unmanaged"
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
    completeConnectionIds: sorted([...ctx.identityComplete, ...ctx.accountsComplete, ...ctx.appsComplete]),
  };
}
