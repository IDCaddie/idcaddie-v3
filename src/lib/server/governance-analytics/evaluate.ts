// Phase 14 — the governance-analytics ENGINE. Pure, COMPUTE-ONLY: it consumes the canonical directory_* graph + Phase-13 effective
// access (computed here, in memory) + an explicit policy, and returns immutable, deterministic governance findings + a summary. No DB,
// RPC, network, migration, route, Date.now, env, flag, or log; the input graph is never mutated. Findings prove ACCESS TOPOLOGY ONLY
// (see types.ts) — never license/cost/usage/inactivity/compliance. Dependency direction: canonical graph -> access-graph (Phase 13) ->
// governance-analytics. Phase 13 must NOT import this module.

import { resolveAllEffectiveAccess } from "../access-graph/resolve";
import type { AccessGraph, IdentityAccess, Scope, SyncStatus } from "../access-graph/types";
import { governanceFindingId, scopeToken } from "./finding-id";
import type {
  CanonicalNode, GovernanceContext, GovernanceEvaluation, GovernanceFinding, GovernanceGraph, GovernancePolicy,
  GovernanceRuleId, GovernanceSeverity, GovernanceCategory, GovernanceConfidence, GovernanceSubjectType, GovernanceSummary,
} from "./types";
import { SEVERITY_RANK } from "./types";

// server-only.
if (typeof (globalThis as { window?: unknown }).window !== "undefined") {
  throw new Error("governance-analytics/evaluate is server-only and must not be imported in client code");
}

const NUL = "\u0000";
const sk = (s: Scope): string => `${s.tenantId}${NUL}${s.connectionId}${NUL}${s.provider}`;
const nk = (s: Scope, id: string): string => `${sk(s)}${NUL}${id}`;
const sameScope = (a: Scope, b: Scope): boolean => a.tenantId === b.tenantId && a.connectionId === b.connectionId && a.provider === b.provider;
const isCurrent = (n: { syncStatus: SyncStatus }): boolean => n.syncStatus === "current";
const sortedStr = (xs: readonly string[]): string[] => [...xs].sort();

type ResolvedPolicy = {
  includeStale: boolean;
  identityBroadAccessThreshold: number | null;
  groupBroadReachThreshold: number | null;
  duplicateInheritedPathThreshold: number;
};

function resolvePolicy(p: GovernancePolicy = {}): ResolvedPolicy {
  const chk = (v: number | null | undefined, name: string): number | null => {
    if (v === undefined || v === null) return null;
    if (!Number.isInteger(v) || v < 0) throw new Error(`governance policy: ${name} must be a non-negative integer`);
    return v;
  };
  const dup = p.duplicateInheritedPathThreshold ?? 1;
  if (!Number.isInteger(dup) || dup < 0) throw new Error("governance policy: duplicateInheritedPathThreshold must be a non-negative integer");
  return {
    includeStale: p.includeStale === true,
    identityBroadAccessThreshold: chk(p.identityBroadAccessThreshold, "identityBroadAccessThreshold"),
    groupBroadReachThreshold: chk(p.groupBroadReachThreshold, "groupBroadReachThreshold"),
    duplicateInheritedPathThreshold: dup,
  };
}

// ── the CATEGORY + message-key derivation for a rule (stable, prose-free) ──────────────────────────────────────────────────────────
const RULE_CATEGORY: Readonly<Record<GovernanceRuleId, GovernanceCategory>> = {
  redundant_direct_access: "redundancy", identity_without_effective_access: "coverage", group_without_application_reach: "coverage",
  application_without_effective_identities: "coverage", direct_assignment_with_stale_endpoint: "freshness", group_assignment_with_stale_endpoint: "freshness",
  stale_only_effective_access: "freshness", identity_broad_access: "breadth", group_broad_application_reach: "breadth", duplicate_inherited_access_paths: "redundancy",
  assignment_missing_identity: "structural", assignment_missing_group: "structural", assignment_missing_application: "structural",
  membership_missing_identity: "structural", membership_missing_group: "structural", cross_scope_edge_ignored: "structural", wrong_provider_edge_ignored: "structural",
};

// ── the shared, prepared evaluation context ───────────────────────────────────────────────────────────────────────────────────────
type Ctx = {
  policy: ResolvedPolicy;
  detectedAt: string | null;
  idNode: Map<string, CanonicalNode>; grpNode: Map<string, CanonicalNode>; appNode: Map<string, CanonicalNode>;
  accessPrimary: IdentityAccess[]; accessCurrent: IdentityAccess[]; accessAll: IdentityAccess[];
  accessByIdentity: Map<string, IdentityAccess>;          // primary access keyed by identityId
  currentAccessByIdentity: Map<string, IdentityAccess>;
  allAccessByIdentity: Map<string, IdentityAccess>;
  primaryMem: GovernanceGraph["memberships"]; primaryUA: GovernanceGraph["userAssignments"]; primaryGA: GovernanceGraph["groupAssignments"];
  membersByGroup: Map<string, Set<string>>;               // nk(group) -> distinct member identity ids (primary)
  appsByGroup: Map<string, Set<string>>;                  // nk(group) -> distinct granted app ids (primary)
  directCountByApp: Map<string, number>;                  // nk(app) -> current direct user-assignment count
  groupAssignCountByApp: Map<string, number>;             // nk(app) -> current group-assignment count
  identitiesByApp: Map<string, Set<string>>;              // nk(app) -> distinct effective identity ids (primary)
  membershipCountByIdentity: Map<string, { current: number; stale: number }>;
};

function buildCtx(graph: GovernanceGraph, policy: ResolvedPolicy, detectedAt: string | null): Ctx {
  const ag: AccessGraph = { identities: graph.identities, memberships: graph.memberships, userAssignments: graph.userAssignments, groupAssignments: graph.groupAssignments };
  const accessCurrent = resolveAllEffectiveAccess(ag, { includeStale: false });
  const accessAll = resolveAllEffectiveAccess(ag, { includeStale: true });
  const accessPrimary = policy.includeStale ? accessAll : accessCurrent;

  const idNode = new Map<string, CanonicalNode>(); const grpNode = new Map<string, CanonicalNode>(); const appNode = new Map<string, CanonicalNode>();
  for (const n of graph.identities) if (!idNode.has(n.id)) idNode.set(n.id, n);
  for (const n of graph.groups) if (!grpNode.has(n.id)) grpNode.set(n.id, n);
  for (const n of graph.applications) if (!appNode.has(n.id)) appNode.set(n.id, n);

  const keep = (s: SyncStatus) => (policy.includeStale ? true : s === "current");
  const primaryMem = graph.memberships.filter((e) => keep(e.syncStatus));
  const primaryUA = graph.userAssignments.filter((e) => keep(e.syncStatus));
  const primaryGA = graph.groupAssignments.filter((e) => keep(e.syncStatus));

  const addTo = (m: Map<string, Set<string>>, key: string, v: string) => { let s = m.get(key); if (!s) { s = new Set(); m.set(key, s); } s.add(v); };
  const membersByGroup = new Map<string, Set<string>>(); const appsByGroup = new Map<string, Set<string>>();
  for (const e of primaryMem) addTo(membersByGroup, nk(e, e.directoryGroupId), e.identityAccountId);
  for (const e of primaryGA) addTo(appsByGroup, nk(e, e.directoryGroupId), e.directoryApplicationId);

  const membershipCountByIdentity = new Map<string, { current: number; stale: number }>();
  for (const e of graph.memberships) {
    const c = membershipCountByIdentity.get(e.identityAccountId) ?? { current: 0, stale: 0 };
    if (e.syncStatus === "current") c.current++; else c.stale++;
    membershipCountByIdentity.set(e.identityAccountId, c);
  }

  const inc = (m: Map<string, number>, key: string) => m.set(key, (m.get(key) ?? 0) + 1);
  const directCountByApp = new Map<string, number>(); const groupAssignCountByApp = new Map<string, number>();
  for (const e of graph.userAssignments) if (e.syncStatus === "current") inc(directCountByApp, nk(e, e.directoryApplicationId));
  for (const e of graph.groupAssignments) if (e.syncStatus === "current") inc(groupAssignCountByApp, nk(e, e.directoryApplicationId));

  const accessByIdentity = new Map<string, IdentityAccess>(); const currentAccessByIdentity = new Map<string, IdentityAccess>(); const allAccessByIdentity = new Map<string, IdentityAccess>();
  const identitiesByApp = new Map<string, Set<string>>();
  for (const ia of accessPrimary) {
    accessByIdentity.set(ia.identityId, ia);
    for (const app of ia.effective) addTo(identitiesByApp, nk(ia.scope, app.applicationId), ia.identityId);
  }
  for (const ia of accessCurrent) currentAccessByIdentity.set(ia.identityId, ia);
  for (const ia of accessAll) allAccessByIdentity.set(ia.identityId, ia);

  return {
    policy, detectedAt, idNode, grpNode, appNode, accessPrimary, accessCurrent, accessAll,
    accessByIdentity, currentAccessByIdentity, allAccessByIdentity, primaryMem, primaryUA, primaryGA,
    membersByGroup, appsByGroup, directCountByApp, groupAssignCountByApp, identitiesByApp, membershipCountByIdentity,
  };
}

// ── finding factory (fills id/category/keys deterministically) ────────────────────────────────────────────────────────────────────
function mkFinding(ctx: Ctx, f: {
  ruleId: GovernanceRuleId; severity: GovernanceSeverity; confidence: GovernanceConfidence; scope: Scope;
  subjectType: GovernanceSubjectType; subjectId: string; relatedIds: readonly string[];
  counts: Record<string, number>; supportingIds?: readonly string[]; endpointStates?: Record<string, SyncStatus>; threshold?: number | null;
}): GovernanceFinding {
  const relatedIds = sortedStr(f.relatedIds);
  // normalize scope to the BARE triple — callers may pass a node/edge object (Scope & extra id fields); storing it verbatim would leak
  // identityAccountId / directoryApplicationId / sync fields into the finding.
  const scope: Scope = { tenantId: f.scope.tenantId, connectionId: f.scope.connectionId, provider: f.scope.provider };
  return {
    id: governanceFindingId({ ruleId: f.ruleId, scope, subjectType: f.subjectType, subjectId: f.subjectId, relatedIds }),
    ruleId: f.ruleId, category: RULE_CATEGORY[f.ruleId], severity: f.severity, confidence: f.confidence, scope,
    subjectType: f.subjectType, subjectId: f.subjectId, relatedIds,
    titleKey: `governance.${f.ruleId}.title`, summaryKey: `governance.${f.ruleId}.summary`, remediationKey: `governance.${f.ruleId}.remediation`,
    evidence: {
      counts: f.counts,
      ...(f.supportingIds ? { supportingIds: sortedStr(f.supportingIds) } : {}),
      ...(f.endpointStates ? { endpointStates: f.endpointStates } : {}),
      ...(f.threshold !== undefined ? { threshold: f.threshold } : {}),
    },
    detectedAt: ctx.detectedAt,
  };
}

// ── the rule catalog (each pushes findings; all pure over ctx) ────────────────────────────────────────────────────────────────────
function runRules(ctx: Ctx, graph: GovernanceGraph): GovernanceFinding[] {
  const out: GovernanceFinding[] = [];

  // Rule 1: redundant_direct_access — an app reached by BOTH a direct edge and >=1 group path (direct grant is POTENTIALLY redundant).
  // Rule 9: duplicate_inherited_access_paths — an app reached via > threshold distinct groups.
  for (const ia of ctx.accessPrimary) {
    for (const app of ia.effective) {
      if (app.classification === "BOTH") {
        const groupIds = app.groupPaths.map((p) => p.groupId);
        out.push(mkFinding(ctx, { ruleId: "redundant_direct_access", severity: "medium", confidence: "high", scope: ia.scope,
          subjectType: "identity", subjectId: ia.identityId, relatedIds: [app.applicationId, ...groupIds],
          counts: { directAssignmentCount: 1, inheritedPathCount: app.groupPaths.length }, supportingIds: groupIds }));
      }
      if (app.groupPaths.length > ctx.policy.duplicateInheritedPathThreshold) {
        const groupIds = app.groupPaths.map((p) => p.groupId);
        out.push(mkFinding(ctx, { ruleId: "duplicate_inherited_access_paths", severity: "low", confidence: "high", scope: ia.scope,
          subjectType: "effective_access", subjectId: ia.identityId, relatedIds: [app.applicationId, ...groupIds],
          counts: { distinctGroupPathCount: app.groupPaths.length }, supportingIds: groupIds, threshold: ctx.policy.duplicateInheritedPathThreshold }));
      }
    }
    // Rule 7: identity_broad_access (threshold-gated).
    if (ctx.policy.identityBroadAccessThreshold !== null && ia.effectiveCount > ctx.policy.identityBroadAccessThreshold) {
      out.push(mkFinding(ctx, { ruleId: "identity_broad_access", severity: "medium", confidence: "medium", scope: ia.scope,
        subjectType: "identity", subjectId: ia.identityId, relatedIds: [],
        counts: { effectiveApplicationCount: ia.effectiveCount, directCount: ia.directCount, groupDerivedCount: ia.groupCount }, threshold: ctx.policy.identityBroadAccessThreshold }));
    }
  }

  // Rule 2: identity_without_effective_access — a current identity (or any, if includeStale) with zero effective apps.
  for (const n of graph.identities) {
    if (!ctx.policy.includeStale && !isCurrent(n)) continue;
    const ia = ctx.accessByIdentity.get(n.id);
    if (ia && ia.effectiveCount > 0) continue; // has access
    const mc = ctx.membershipCountByIdentity.get(n.id) ?? { current: 0, stale: 0 };
    out.push(mkFinding(ctx, { ruleId: "identity_without_effective_access", severity: "info", confidence: "high", scope: n,
      subjectType: "identity", subjectId: n.id, relatedIds: [],
      counts: { directCount: 0, groupDerivedCount: 0, effectiveCount: 0, currentMembershipCount: mc.current, staleMembershipCount: mc.stale }, endpointStates: { identity: n.syncStatus } }));
  }

  // Rule 3: group_without_application_reach — a current group (or any, if includeStale) granting zero apps in the primary view.
  // Rule 8: group_broad_application_reach (threshold-gated).
  for (const n of graph.groups) {
    if (!ctx.policy.includeStale && !isCurrent(n)) continue;
    const apps = ctx.appsByGroup.get(nk(n, n.id)); const appCount = apps?.size ?? 0;
    const memberCount = ctx.membersByGroup.get(nk(n, n.id))?.size ?? 0;
    if (appCount === 0) {
      out.push(mkFinding(ctx, { ruleId: "group_without_application_reach", severity: "info", confidence: "high", scope: n,
        subjectType: "group", subjectId: n.id, relatedIds: [], counts: { memberCount, applicationAssignmentCount: 0 }, endpointStates: { group: n.syncStatus } }));
    }
    if (ctx.policy.groupBroadReachThreshold !== null && appCount > ctx.policy.groupBroadReachThreshold) {
      out.push(mkFinding(ctx, { ruleId: "group_broad_application_reach", severity: "low", confidence: "medium", scope: n,
        subjectType: "group", subjectId: n.id, relatedIds: [], counts: { applicationCount: appCount, memberCount }, threshold: ctx.policy.groupBroadReachThreshold }));
    }
  }

  // Rule 4: application_without_effective_identities — a current app (or any, if includeStale) with zero effective identities.
  for (const n of graph.applications) {
    if (!ctx.policy.includeStale && !isCurrent(n)) continue;
    const eff = ctx.identitiesByApp.get(nk(n, n.id))?.size ?? 0;
    if (eff > 0) continue;
    out.push(mkFinding(ctx, { ruleId: "application_without_effective_identities", severity: "low", confidence: "high", scope: n,
      subjectType: "application", subjectId: n.id, relatedIds: [],
      counts: { effectiveIdentityCount: 0, currentDirectAssignmentCount: ctx.directCountByApp.get(nk(n, n.id)) ?? 0, currentGroupAssignmentCount: ctx.groupAssignCountByApp.get(nk(n, n.id)) ?? 0 }, endpointStates: { application: n.syncStatus } }));
  }

  // Rule 5a: direct_assignment_with_stale_endpoint — a CURRENT user-assignment whose identity OR app node is non-current. The SUBJECT
  // endpoint (identity) must be same-scope, else the finding subject would be a foreign-scope row id (a cross-scope edge is instead
  // diagnosed by the structural rules). A duplicate edge cannot inflate: identical edges yield identical finding ids, deduped on output.
  for (const e of graph.userAssignments) {
    if (e.syncStatus !== "current") continue;
    const idn = ctx.idNode.get(e.identityAccountId);
    if (!idn || !sameScope(idn, e)) continue; // subject endpoint must belong to the edge's own scope
    const apn = ctx.appNode.get(e.directoryApplicationId);
    const apState = apn && sameScope(apn, e) ? apn.syncStatus : undefined;
    if (idn.syncStatus !== "current" || (apState && apState !== "current")) {
      out.push(mkFinding(ctx, { ruleId: "direct_assignment_with_stale_endpoint", severity: "medium", confidence: "high", scope: e,
        subjectType: "assignment", subjectId: e.identityAccountId, relatedIds: [e.directoryApplicationId],
        counts: {}, endpointStates: { assignment: e.syncStatus, identity: idn.syncStatus, ...(apState ? { application: apState } : {}) } }));
    }
  }
  // Rule 5b: group_assignment_with_stale_endpoint — a CURRENT group-assignment whose group OR app node is non-current. Subject (group)
  // must be same-scope.
  for (const e of graph.groupAssignments) {
    if (e.syncStatus !== "current") continue;
    const grn = ctx.grpNode.get(e.directoryGroupId);
    if (!grn || !sameScope(grn, e)) continue;
    const apn = ctx.appNode.get(e.directoryApplicationId);
    const apState = apn && sameScope(apn, e) ? apn.syncStatus : undefined;
    if (grn.syncStatus !== "current" || (apState && apState !== "current")) {
      out.push(mkFinding(ctx, { ruleId: "group_assignment_with_stale_endpoint", severity: "medium", confidence: "high", scope: e,
        subjectType: "assignment", subjectId: e.directoryGroupId, relatedIds: [e.directoryApplicationId],
        counts: {}, endpointStates: { assignment: e.syncStatus, group: grn.syncStatus, ...(apState ? { application: apState } : {}) } }));
    }
  }

  // Rule 6: stale_only_effective_access — an identity->app relationship present with stale edges but ABSENT current-only.
  for (const ia of ctx.accessAll) {
    const cur = ctx.currentAccessByIdentity.get(ia.identityId);
    const curApps = new Set((cur?.effective ?? []).map((a) => a.applicationId));
    for (const app of ia.effective) {
      if (curApps.has(app.applicationId)) continue; // still reachable current-only -> not stale-only
      out.push(mkFinding(ctx, { ruleId: "stale_only_effective_access", severity: "medium", confidence: "medium", scope: ia.scope,
        subjectType: "effective_access", subjectId: ia.identityId, relatedIds: [app.applicationId],
        counts: { staleDirectPathCount: app.direct ? 1 : 0, staleGroupPathCount: app.groupPaths.length, currentPathCount: 0 } }));
    }
  }

  // Rule 10: structural inconsistency — aggregate diagnostics (COUNTS only, per (scope, ruleId); NEVER a foreign entity id).
  out.push(...structuralFindings(ctx, graph));

  return out;
}

function structuralFindings(ctx: Ctx, graph: GovernanceGraph): GovernanceFinding[] {
  // agg[ scopeKey ][ ruleId ] = { scope, count }
  const agg = new Map<string, Map<GovernanceRuleId, { scope: Scope; count: number }>>();
  const bump = (scope: Scope, ruleId: GovernanceRuleId) => {
    const key = sk(scope); let m = agg.get(key); if (!m) { m = new Map(); agg.set(key, m); }
    const cell = m.get(ruleId) ?? { scope, count: 0 }; cell.count++; m.set(ruleId, cell);
  };
  // classify an endpoint reference against its node map: 'ok' | 'missing' | 'cross_scope' | 'wrong_provider'
  const classify = (node: CanonicalNode | undefined, edge: Scope): "ok" | "missing" | "cross_scope" | "wrong_provider" => {
    if (!node) return "missing";
    if (sameScope(node, edge)) return "ok";
    if (node.tenantId === edge.tenantId && node.connectionId === edge.connectionId && node.provider !== edge.provider) return "wrong_provider";
    return "cross_scope";
  };
  // Process one edge: missing endpoints bump per endpoint (distinct rule ids), but cross-scope / wrong-provider bump ONCE per EDGE (both
  // endpoints of a mis-scoped edge classify the same, so a per-endpoint bump would double-count the single ignored edge).
  const processEdge = (edge: Scope, endpoints: ReadonlyArray<{ node: CanonicalNode | undefined; missingRule: GovernanceRuleId }>) => {
    let crossScope = false, wrongProvider = false;
    for (const { node, missingRule } of endpoints) {
      const v = classify(node, edge);
      if (v === "missing") bump(edge, missingRule);
      else if (v === "wrong_provider") wrongProvider = true;
      else if (v === "cross_scope") crossScope = true;
    }
    if (crossScope) bump(edge, "cross_scope_edge_ignored");
    if (wrongProvider) bump(edge, "wrong_provider_edge_ignored");
  };
  for (const e of graph.userAssignments) processEdge(e, [{ node: ctx.idNode.get(e.identityAccountId), missingRule: "assignment_missing_identity" }, { node: ctx.appNode.get(e.directoryApplicationId), missingRule: "assignment_missing_application" }]);
  for (const e of graph.memberships) processEdge(e, [{ node: ctx.idNode.get(e.identityAccountId), missingRule: "membership_missing_identity" }, { node: ctx.grpNode.get(e.directoryGroupId), missingRule: "membership_missing_group" }]);
  for (const e of graph.groupAssignments) processEdge(e, [{ node: ctx.grpNode.get(e.directoryGroupId), missingRule: "assignment_missing_group" }, { node: ctx.appNode.get(e.directoryApplicationId), missingRule: "assignment_missing_application" }]);
  const HIGH: ReadonlySet<GovernanceRuleId> = new Set(["assignment_missing_identity", "assignment_missing_group", "assignment_missing_application", "membership_missing_identity", "membership_missing_group"]);
  const out: GovernanceFinding[] = [];
  for (const m of agg.values()) for (const [ruleId, cell] of m) {
    out.push(mkFinding(ctx, { ruleId, severity: HIGH.has(ruleId) ? "high" : "medium", confidence: "high", scope: cell.scope,
      subjectType: "graph", subjectId: scopeToken(cell.scope), relatedIds: [], counts: { edgeCount: cell.count } }));
  }
  return out;
}

// ── dedup by finding id: a malformed duplicate input edge/node yields identical (rule,scope,subject,related) -> identical id; collapse
// to one so a duplicate input never inflates findings or the summary (the DB unique keys prevent this in the persisted graph; this is
// robustness for arbitrary in-memory input). FIRST wins -> deterministic. ────────────────────────────────────────────────────────────
function dedupById(findings: GovernanceFinding[]): GovernanceFinding[] {
  const seen = new Set<string>(); const out: GovernanceFinding[] = [];
  for (const f of findings) { if (seen.has(f.id)) continue; seen.add(f.id); out.push(f); }
  return out;
}

// ── deterministic ordering: higher severity FIRST, then ruleId, subjectType, subjectId, relatedIds, id (all asc) ──────────────────
function sortFindings(a: GovernanceFinding[]): GovernanceFinding[] {
  const cmp = (x: string, y: string) => (x < y ? -1 : x > y ? 1 : 0);
  return [...a].sort((x, y) =>
    (SEVERITY_RANK[y.severity] - SEVERITY_RANK[x.severity]) ||   // higher severity first
    cmp(x.ruleId, y.ruleId) || cmp(x.subjectType, y.subjectType) || cmp(x.subjectId, y.subjectId) ||
    cmp(x.relatedIds.join(NUL), y.relatedIds.join(NUL)) || cmp(x.id, y.id));
}

// ── summary (counts only) ────────────────────────────────────────────────────────────────────────────────────────────────────────
export function summarizeGovernance(findings: readonly GovernanceFinding[], access: readonly IdentityAccess[], graph: GovernanceGraph): GovernanceSummary {
  const findingsByRule: Record<string, number> = {};
  const findingsBySeverity: Record<GovernanceSeverity, number> = { info: 0, low: 0, medium: 0, high: 0 };
  for (const f of findings) { findingsByRule[f.ruleId] = (findingsByRule[f.ruleId] ?? 0) + 1; findingsBySeverity[f.severity]++; }
  let withDirect = 0, withGroup = 0, withBoth = 0, without = 0, effRel = 0;
  for (const ia of access) {
    if (ia.directCount > 0) withDirect++;
    if (ia.groupCount > 0) withGroup++;
    if (ia.bothCount > 0) withBoth++;
    if (ia.effectiveCount === 0) without++;
    effRel += ia.effectiveCount;
  }
  return {
    identitiesEvaluated: graph.identities.length, groupsEvaluated: graph.groups.length, applicationsEvaluated: graph.applications.length,
    effectiveAccessRelationships: effRel, findingsTotal: findings.length, findingsByRule, findingsBySeverity,
    identitiesWithDirectAccess: withDirect, identitiesWithGroupAccess: withGroup, identitiesWithBoth: withBoth, identitiesWithoutAccess: without,
    applicationsWithoutEffectiveIdentities: findingsByRule["application_without_effective_identities"] ?? 0,
    redundantDirectAccessRelationships: findingsByRule["redundant_direct_access"] ?? 0,
    duplicateInheritedPaths: findingsByRule["duplicate_inherited_access_paths"] ?? 0,
    staleOnlyRelationships: findingsByRule["stale_only_effective_access"] ?? 0,
  };
}

// ── public API ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────
export function evaluateGovernance(graph: GovernanceGraph, policy: GovernancePolicy = {}, ctx: GovernanceContext = {}): GovernanceEvaluation {
  const rp = resolvePolicy(policy);
  const c = buildCtx(graph, rp, ctx.detectedAt ?? null);
  const findings = sortFindings(dedupById(runRules(c, graph)));
  const summary = summarizeGovernance(findings, c.accessPrimary, graph);
  return { findings, summary };
}

// Single-GROUP view (Phase 3): the same engine again, findings filtered to those whose subject IS the group or that reference it.
// Two rules are group-subjected today — group_without_application_reach and group_broad_application_reach — and both read only this
// group's own member and application counts, so a group-bounded subgraph evaluates them exactly. Reusing the engine rather than
// re-deriving those two conditions is the whole point: a second implementation would drift from the first the day a rule changes.
//
// The summary is computed over the access of this group's MEMBERS, which is what the detail page reports.
export function evaluateGroupGovernance(graph: GovernanceGraph, groupId: string, policy: GovernancePolicy = {}, ctx: GovernanceContext = {}): GovernanceEvaluation {
  const rp = resolvePolicy(policy);
  const c = buildCtx(graph, rp, ctx.detectedAt ?? null);
  const all = dedupById(runRules(c, graph));
  const findings = sortFindings(all.filter((f) => f.subjectId === groupId || f.relatedIds.includes(groupId)));
  const summary = summarizeGovernance(findings, [...c.accessByIdentity.values()], graph);
  return { findings, summary };
}

// Single-identity view: the same engine, findings filtered to those whose subject IS the identity or that reference it; summary
// recomputed over just that identity's access. (App/group/graph-diagnostic findings are dropped — they are not identity-scoped.)
export function evaluateIdentityGovernance(graph: GovernanceGraph, identityId: string, policy: GovernancePolicy = {}, ctx: GovernanceContext = {}): GovernanceEvaluation {
  const rp = resolvePolicy(policy);
  const c = buildCtx(graph, rp, ctx.detectedAt ?? null);
  const all = dedupById(runRules(c, graph));
  const findings = sortFindings(all.filter((f) => f.subjectId === identityId || f.relatedIds.includes(identityId)));
  const ia = c.accessByIdentity.get(identityId);
  const summary = summarizeGovernance(findings, ia ? [ia] : [], graph);
  return { findings, summary };
}
