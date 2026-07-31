// Phase 15 Part 1 PR B — the SERVER-ONLY loaders for the /access surface. Each orchestrates: repository (0061 RPCs, owner/admin-gated) ->
// graph assembly (inject verified tenant) -> the Phase-13 access-graph engine + Phase-14 governance engine (REUSED, never reimplemented) ->
// browser-safe view models. detectedAt is injected explicitly (the engines never call Date.now). The overview gates the whole-tenant
// evaluation behind a counts check + bounded paging and fails closed with a truthful "unavailable" completeness state rather than
// silently truncating. Server-only via the repository's createClient import.

import {
  accessGate, getAccessCounts, listDirectoryIdentities, listDirectoryGroups, listDirectoryApplications,
  listGroupMemberships, listUserAssignments, listGroupAssignments, getIdentityAccessSubgraph, getApplicationAccessSubgraph,
  getGroupAccessSubgraph,
  type ListResult,
} from "./access-repository";
import { assembleGovernanceGraph, type AccessGraphRows } from "./access-graph-assembly";
import { evaluateGovernance, evaluateIdentityGovernance, evaluateGroupGovernance } from "@/lib/server/governance-analytics/evaluate";
import { resolveEffectiveAccess, resolveAllEffectiveAccess } from "@/lib/server/access-graph/resolve";
import {
  mapFindingToView, mapSummaryToView, mapIdentityApplications, classificationView,
  identityLabel, groupLabel, applicationLabel,
  type GovernanceFindingView, type GovernanceSummaryView, type IdentityApplicationAccessView, type ClassificationView,
} from "./access-view-models";

const PAGE = 100, MAX_NODES = 2000, MAX_EDGES = 5000;
// Detail subgraphs are entity-bounded, but a fan-in-heavy app (e.g. an "all employees" group) can still return a large neighborhood.
// Fail closed above this many total subgraph rows rather than resolving + rendering an unbounded response (mirrors the overview cap).
const SUBGRAPH_MAX_ROWS = 5000;

export type CountsView = { identities: number; groups: number; applications: number; memberships: number; directAssignments: number; groupAssignments: number };
export type AccessBreakdown = { directOnly: number; groupOnly: number; both: number };
export type AccessOverviewData =
  | { status: "too_large"; counts: CountsView }
  | { status: "complete"; counts: CountsView; breakdown: AccessBreakdown; effectiveRelationships: number; governanceFindingsTotal: number; summary: GovernanceSummaryView; findings: readonly GovernanceFindingView[] };
export type AccessOverviewResult = { ok: true; data: AccessOverviewData } | { ok: false; error: "forbidden" | "query_failed" };

export type IdentityAccessDetailData = {
  id: string; displayName: string; providerLabel: string; syncState: "current" | "stale"; staleSince: string | null; bounded: boolean;
  effectiveApplicationCount: number; applications: readonly IdentityApplicationAccessView[]; findings: readonly GovernanceFindingView[];
};
export type ApplicationIdentityAccessView = { identityId: string; identityLabel: string; classification: ClassificationView; classificationLabel: string; staleEvidence: boolean };
// Phase 4: the group id travels with the label so the application's assigned groups become links.
export type ApplicationAssignedGroupView = { groupId: string; groupLabel: string; staleEvidence: boolean };
export type ApplicationAccessDetailData = {
  id: string; displayName: string; providerLabel: string; syncState: "current" | "stale"; staleSince: string | null; catalogMatchStatus: string | null; bounded: boolean;
  effectiveIdentityCount: number; directOnlyCount: number; groupOnlyCount: number; bothCount: number;
  identities: readonly ApplicationIdentityAccessView[]; assignedGroups: readonly ApplicationAssignedGroupView[]; findings: readonly GovernanceFindingView[];
};
export type EntityDetailResult<T> = { ok: true; data: T } | { ok: false; error: "not_found" | "query_failed" };

const syncState = (s: string): "current" | "stale" => (s === "current" ? "current" : "stale");

// Page one list RPC fully (deterministic id cursor). Counts already gate too-large, so this stays bounded; a defensive page cap backstops.
async function pageAll<T extends { id?: string }>(fetch: (afterId: string | null) => Promise<ListResult<T[]>>): Promise<{ ok: true; rows: T[] } | { ok: false; error: "query_failed" }> {
  const rows: T[] = []; let afterId: string | null = null;
  for (let guard = 0; guard < 1000; guard++) {
    const r = await fetch(afterId);
    if (!r.ok) return { ok: false, error: "query_failed" };
    rows.push(...r.data);
    if (r.data.length < PAGE) return { ok: true, rows };
    const last = r.data[r.data.length - 1];
    if (!last.id) return { ok: true, rows }; // no cursor available -> stop (defensive; list RPCs always return id)
    afterId = last.id;
  }
  return { ok: true, rows };
}

export async function loadAccessOverview(includeStale = false): Promise<AccessOverviewResult> {
  const g = await accessGate();
  if (!g.ok) return { ok: false, error: "forbidden" };
  const counts = await getAccessCounts(g.tenantId); // counts are stale-agnostic (total rows) — the conservative bound for the too-large gate
  if (!counts.ok) return { ok: false, error: "query_failed" };
  const c = counts.data;
  const countsView: CountsView = { identities: c.identities, groups: c.groups, applications: c.applications, memberships: c.memberships, directAssignments: c.userAssignments, groupAssignments: c.groupAssignments };
  if (c.identities > MAX_NODES || c.groups > MAX_NODES || c.applications > MAX_NODES || c.memberships > MAX_EDGES || c.userAssignments > MAX_EDGES || c.groupAssignments > MAX_EDGES) {
    return { ok: true, data: { status: "too_large", counts: countsView } };
  }
  const opt = (afterId: string | null) => ({ includeStale, afterId, limit: PAGE });
  const [ids, grps, apps, mem, ua, ga] = await Promise.all([
    pageAll((a) => listDirectoryIdentities(g.tenantId, opt(a))), pageAll((a) => listDirectoryGroups(g.tenantId, opt(a))), pageAll((a) => listDirectoryApplications(g.tenantId, opt(a))),
    pageAll((a) => listGroupMemberships(g.tenantId, opt(a))), pageAll((a) => listUserAssignments(g.tenantId, opt(a))), pageAll((a) => listGroupAssignments(g.tenantId, opt(a))),
  ]);
  if (!ids.ok || !grps.ok || !apps.ok || !mem.ok || !ua.ok || !ga.ok) return { ok: false, error: "query_failed" };
  const rows: AccessGraphRows = { identities: ids.rows, groups: grps.rows, applications: apps.rows, memberships: mem.rows, userAssignments: ua.rows, groupAssignments: ga.rows };
  // Displayed complete-view counts come from the PAGED rows (which honor includeStale), so the StatCards match the evaluated graph exactly —
  // not the stale-agnostic RPC total (used only for the too-large pre-gate above, where no current-only body is shown).
  const shownCounts: CountsView = { identities: ids.rows.length, groups: grps.rows.length, applications: apps.rows.length, memberships: mem.rows.length, directAssignments: ua.rows.length, groupAssignments: ga.rows.length };
  const graph = assembleGovernanceGraph(g.tenantId, rows);
  const detectedAt = new Date().toISOString();
  const evaluation = evaluateGovernance(graph, { includeStale }, { detectedAt });
  const access = resolveAllEffectiveAccess(graph, { includeStale });
  let directOnly = 0, groupOnly = 0, both = 0;
  for (const ia of access) for (const app of ia.effective) { if (app.classification === "DIRECT") directOnly++; else if (app.classification === "GROUP") groupOnly++; else both++; }
  const identityLabels = new Map(ids.rows.map((r) => [r.id, identityLabel(r)]));
  const applicationLabels = new Map(apps.rows.map((r) => [r.id, applicationLabel(r)]));
  const groupLabels = new Map(grps.rows.map((r) => [r.id, groupLabel(r)]));
  const findings = evaluation.findings.map((f) => mapFindingToView(f, identityLabels, applicationLabels, groupLabels)); // all, sorted higher-severity-first
  return {
    ok: true,
    data: {
      status: "complete", counts: shownCounts, breakdown: { directOnly, groupOnly, both },
      effectiveRelationships: evaluation.summary.effectiveAccessRelationships, governanceFindingsTotal: evaluation.summary.findingsTotal,
      summary: mapSummaryToView(evaluation.summary), findings,
    },
  };
}

export async function loadIdentityAccessDetail(identityId: string, includeStale = false): Promise<EntityDetailResult<IdentityAccessDetailData>> {
  const g = await accessGate();
  if (!g.ok) return { ok: false, error: "not_found" };
  const sub = await getIdentityAccessSubgraph(g.tenantId, identityId, includeStale);
  if (!sub.ok) return sub;
  const s = sub.data;
  const total = 1 + s.groups.length + s.applications.length + s.memberships.length + s.userAssignments.length + s.groupAssignments.length;
  if (total > SUBGRAPH_MAX_ROWS) {
    return { ok: true, data: { id: s.identity.id, displayName: identityLabel(s.identity), providerLabel: s.identity.provider, syncState: syncState(s.identity.sync_status), staleSince: s.identity.stale_since, bounded: true, effectiveApplicationCount: 0, applications: [], findings: [] } };
  }
  const rows: AccessGraphRows = { identities: [s.identity], groups: s.groups, applications: s.applications, memberships: s.memberships, userAssignments: s.userAssignments, groupAssignments: s.groupAssignments };
  const graph = assembleGovernanceGraph(g.tenantId, rows);
  const detectedAt = new Date().toISOString();
  const access = resolveEffectiveAccess(graph, s.identity.id, { includeStale }); // identity is in-graph -> never throws
  const gov = evaluateIdentityGovernance(graph, s.identity.id, { includeStale }, { detectedAt });
  const applicationLabels = new Map(s.applications.map((r) => [r.id, applicationLabel(r)]));
  const groupLabels = new Map(s.groups.map((r) => [r.id, groupLabel(r)]));
  const identityLabels = new Map([[s.identity.id, identityLabel(s.identity)]]);
  return {
    ok: true,
    data: {
      id: s.identity.id, displayName: identityLabel(s.identity), providerLabel: s.identity.provider,
      syncState: syncState(s.identity.sync_status), staleSince: s.identity.stale_since, bounded: false,
      effectiveApplicationCount: access.effectiveCount,
      applications: mapIdentityApplications(access, applicationLabels, groupLabels),
      findings: gov.findings.map((f) => mapFindingToView(f, identityLabels, applicationLabels, groupLabels)),
    },
  };
}

export async function loadApplicationAccessDetail(applicationId: string, includeStale = false): Promise<EntityDetailResult<ApplicationAccessDetailData>> {
  const g = await accessGate();
  if (!g.ok) return { ok: false, error: "not_found" };
  const sub = await getApplicationAccessSubgraph(g.tenantId, applicationId, includeStale);
  if (!sub.ok) return sub;
  const s = sub.data;
  const total = 1 + s.identities.length + s.groups.length + s.memberships.length + s.userAssignments.length + s.groupAssignments.length;
  if (total > SUBGRAPH_MAX_ROWS) {
    return { ok: true, data: { id: s.application.id, displayName: applicationLabel(s.application), providerLabel: s.application.provider, syncState: syncState(s.application.sync_status), staleSince: s.application.stale_since, catalogMatchStatus: s.application.catalog_match_status, bounded: true, effectiveIdentityCount: 0, directOnlyCount: 0, groupOnlyCount: 0, bothCount: 0, identities: [], assignedGroups: [], findings: [] } };
  }
  const rows: AccessGraphRows = { identities: s.identities, groups: s.groups, applications: [s.application], memberships: s.memberships, userAssignments: s.userAssignments, groupAssignments: s.groupAssignments };
  const graph = assembleGovernanceGraph(g.tenantId, rows);
  const detectedAt = new Date().toISOString();
  const appId = s.application.id;
  const access = resolveAllEffectiveAccess(graph, { includeStale });
  const identityLabels = new Map(s.identities.map((r) => [r.id, identityLabel(r)]));
  const applicationLabels = new Map([[appId, applicationLabel(s.application)]]);
  let directOnly = 0, groupOnly = 0, both = 0;
  const identities: ApplicationIdentityAccessView[] = [];
  for (const ia of access) {
    const app = ia.effective.find((a) => a.applicationId === appId);
    if (!app) continue;
    const cls = app.classification; // DIRECT/GROUP/BOTH is Phase-13's decision (single source of truth)
    if (cls === "DIRECT") directOnly++; else if (cls === "GROUP") groupOnly++; else both++;
    // Same freshness rule as the identity page: this (identity, app) relationship is stale-derived if its direct edge or any group path is non-current.
    const staleEvidence = (app.directProvenance?.syncStatus ?? "current") !== "current" || app.groupPaths.some((p) => p.assignment.syncStatus !== "current" || p.membership.syncStatus !== "current");
    identities.push({ identityId: ia.identityId, identityLabel: identityLabels.get(ia.identityId) ?? "Unnamed identity", classification: cls, classificationLabel: classificationView(cls, app.groupPaths.length).label, staleEvidence });
  }
  identities.sort((a, b) => a.identityLabel.localeCompare(b.identityLabel) || a.identityId.localeCompare(b.identityId));
  const assignedGroups: ApplicationAssignedGroupView[] = s.groupAssignments
    .filter((e) => e.directory_application_id === appId)
      .map((e) => ({ groupId: e.directory_group_id, groupLabel: groupLabel(s.groups.find((gr) => gr.id === e.directory_group_id) ?? {}), staleEvidence: e.sync_status !== "current" }))
      .sort((a, b) => a.groupLabel.localeCompare(b.groupLabel) || a.groupId.localeCompare(b.groupId));
  const gov = evaluateGovernance(graph, { includeStale }, { detectedAt });
  const groupLabels = new Map(s.groups.map((r) => [r.id, groupLabel(r)]));
    const findings = gov.findings.filter((f) => f.subjectId === appId || f.relatedIds.includes(appId)).map((f) => mapFindingToView(f, identityLabels, applicationLabels, groupLabels));
  return {
    ok: true,
    data: {
      id: appId, displayName: applicationLabel(s.application), providerLabel: s.application.provider,
      syncState: syncState(s.application.sync_status), staleSince: s.application.stale_since, catalogMatchStatus: s.application.catalog_match_status, bounded: false,
      effectiveIdentityCount: identities.length, directOnlyCount: directOnly, groupOnlyCount: groupOnly, bothCount: both,
      identities, assignedGroups, findings,
    },
  };
}

// ── Phase 3: group detail ─────────────────────────────────────────────────────────────────────────────────────────────────────────
// One RPC call, then the existing Phase-13 access engine and Phase-14 governance engine over the returned neighbourhood. No per-row
// query: the members, the applications the group grants, and those members' direct holdings of those same applications all arrive
// together, which is exactly what is needed to say whether the group is the ONLY path to an application or one of two.

export type GroupMemberView = {
  readonly identityId: string; readonly displayName: string; readonly identifier: string | null;
  readonly isActive: boolean | null;
  readonly accountState: SyncStateView;          // the identity record's own evidence
  readonly membershipState: SyncStateView;       // the membership edge's evidence — they can differ
  readonly staleEvidence: boolean;
};
export type GroupApplicationView = {
  readonly applicationId: string; readonly label: string;
  readonly statusCategory: string | null; readonly signOnCategory: string | null;
  readonly applicationState: SyncStateView; readonly assignmentState: SyncStateView;
  readonly staleEvidence: boolean;
  readonly alsoDirectFor: number;                // members who ALSO hold this application directly
};
export type SyncStateView = "current" | "stale";

export type GroupAccessDetailData = {
  readonly id: string; readonly displayName: string; readonly description: string | null;
  readonly providerLabel: string; readonly connectionId: string;
  readonly typeCategory: string | null; readonly isBuiltIn: boolean;
  readonly syncState: SyncStateView; readonly staleSince: string | null; readonly lastSeenAt: string | null;
  readonly bounded: boolean;                     // the neighbourhood was refused, not empty
  readonly memberCount: number; readonly applicationCount: number;
  readonly members: readonly GroupMemberView[];
  readonly applications: readonly GroupApplicationView[];
  readonly findings: readonly GovernanceFindingView[];
  readonly staleEvidenceCount: number;
};

export async function loadGroupAccessDetail(groupId: string, includeStale = false): Promise<EntityDetailResult<GroupAccessDetailData>> {
  const g = await accessGate();
  if (!g.ok) return { ok: false, error: "not_found" };   // forbidden and missing collapse, as on the other two detail loaders
  const sub = await getGroupAccessSubgraph(g.tenantId, groupId, includeStale);
  if (!sub.ok) return sub;
  const s = sub.data;

  const grp = s.group;
  const base = {
    id: grp.id, displayName: groupLabel(grp), description: grp.description,
    providerLabel: grp.provider, connectionId: grp.connection_id,
    typeCategory: grp.group_type_category, isBuiltIn: grp.group_type_category === "built_in",
    syncState: syncState(grp.sync_status),
    // Only meaningful on a row that is actually stale — 0053/0054 left leftover timestamps on returning rows before 0070, and the
    // display should not depend on that migration having run to be truthful.
    staleSince: syncState(grp.sync_status) === "stale" ? grp.stale_since : null,
    lastSeenAt: grp.last_seen_at,
  };

  // The RPC already refused a fan-in neighbourhood. Report the refusal; never render zeros that would read as "this group is empty".
  if (s.bounded) {
    return { ok: true, data: { ...base, bounded: true, memberCount: 0, applicationCount: 0, members: [], applications: [], findings: [], staleEvidenceCount: 0 } };
  }

  const rows: AccessGraphRows = {
    identities: s.identities, groups: [grp], applications: s.applications,
    memberships: s.memberships, userAssignments: s.userAssignments, groupAssignments: s.groupAssignments,
  };
  const graph = assembleGovernanceGraph(g.tenantId, rows);
  const gov = evaluateGroupGovernance(graph, grp.id, { includeStale }, { detectedAt: new Date().toISOString() });

  const membershipByIdentity = new Map(s.memberships.map((m) => [m.identity_account_id, m]));
  const members: GroupMemberView[] = s.identities
    .map((i) => {
      const m = membershipByIdentity.get(i.id);
      const accountState = syncState(i.sync_status);
      const membershipState = m ? syncState(m.sync_status) : "stale";
      const identifier = i.login ?? i.email ?? null;
      const displayName = identityLabel(i);
      return {
        identityId: i.id, displayName,
        // The name already falls back to login then email, so repeating it as a second column would say nothing.
        identifier: identifier !== null && identifier !== displayName ? identifier : null,
        isActive: i.is_active, accountState, membershipState,
        staleEvidence: accountState === "stale" || membershipState === "stale",
      };
    })
    .sort((a, b) => a.displayName.localeCompare(b.displayName) || a.identityId.localeCompare(b.identityId));

  const assignmentByApp = new Map(s.groupAssignments.map((a) => [a.directory_application_id, a]));
  const directHolders = new Map<string, number>();
  for (const ua of s.userAssignments) directHolders.set(ua.directory_application_id, (directHolders.get(ua.directory_application_id) ?? 0) + 1);

  const applications: GroupApplicationView[] = s.applications
    .map((a) => {
      const ga = assignmentByApp.get(a.id);
      const applicationState = syncState(a.sync_status);
      const assignmentState = ga ? syncState(ga.sync_status) : "stale";
      return {
        applicationId: a.id, label: applicationLabel(a),
        statusCategory: a.status_category, signOnCategory: a.sign_on_category,
        applicationState, assignmentState,
        staleEvidence: applicationState === "stale" || assignmentState === "stale",
        alsoDirectFor: directHolders.get(a.id) ?? 0,
      };
    })
    .sort((a, b) => a.label.localeCompare(b.label) || a.applicationId.localeCompare(b.applicationId));

  const identityLabels = new Map(s.identities.map((r) => [r.id, identityLabel(r)]));
  const applicationLabels = new Map(s.applications.map((r) => [r.id, applicationLabel(r)]));

  return {
    ok: true,
    data: {
      ...base, bounded: false,
      memberCount: members.length, applicationCount: applications.length,
      members, applications,
      findings: gov.findings.map((f) => mapFindingToView(f, identityLabels, applicationLabels, new Map([[grp.id, groupLabel(grp)]]))),
      staleEvidenceCount: members.filter((m) => m.staleEvidence).length + applications.filter((a) => a.staleEvidence).length,
    },
  };
}

