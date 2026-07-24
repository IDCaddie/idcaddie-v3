// Phase 13 — the effective-access GRAPH ENGINE. Given the durable canonical edges (passed in as typed row-id tuples), it computes for
// each identity its DIRECT / GROUP-derived / EFFECTIVE application access with full provenance and reasoning paths. COMPUTE-ONLY: no
// table, no fact, no RPC, no migration, no DB read, no mutation of any kind. Reachability is a bounded 2-level DAG
//   DIRECT:  identity --user_assignment--> application
//   GROUP:   identity --membership--> group --group_assignment--> application
// so cycles are STRUCTURALLY IMPOSSIBLE (memberships are identity<->group only — there is no group->group edge in the schema, 0056).
// Isolation is DB-enforced (every edge carries a NOT-NULL (tenant, connection, provider) scope + 4-col composite FKs) and the engine
// honors it: every index/lookup is keyed on (scope, ROW id), so an edge in a different scope can NEVER contribute to an identity's
// access. Algorithm: build three hash indices once in O(E), then per identity resolve in O(direct + Σ groupApps); whole-tenant O(V+E),
// no exponential/quadratic blowup. RISK-007 OPEN; Phase C BLOCKED; production untouched.

import type {
  AccessGraph, IdentityNode, IdentityAccess, AppAccess, EdgeProvenance, GroupPath, Scope, SyncPolicy, Classification,
} from "./types";

// server-only: the access-reasoning engine must not be bundled into client code.
if (typeof (globalThis as { window?: unknown }).window !== "undefined") {
  throw new Error("access-graph/resolve is server-only and must not be imported in client code");
}

// Depth of the reachability graph today (identity -> group -> app). A defensive bound: the model has no group->group edge, so no loop
// can occur; this is documentation + future-proofing, not an active recursion limit.
export const MAX_GROUP_DEPTH = 1;

const NUL = "\u0000"; // an injective delimiter that cannot appear in a uuid/provider slug, so composite keys never collide.
const scopeKey = (s: Scope): string => `${s.tenantId}${NUL}${s.connectionId}${NUL}${s.provider}`;
const nodeKey = (s: Scope, id: string): string => `${scopeKey(s)}${NUL}${id}`;

const provOf = (e: EdgeProvenance): EdgeProvenance => ({
  syncStatus: e.syncStatus,
  lastDiscoveryRunId: e.lastDiscoveryRunId ?? null,
  firstSeenAt: e.firstSeenAt ?? null,
  lastSeenAt: e.lastSeenAt ?? null,
  staleSince: e.staleSince ?? null,
  sourceEndpoint: e.sourceEndpoint ?? null,
});

// includeStale default TRUE (keep every edge). includeStale:false -> only sync_status='current' edges are traversed.
const keeps = (syncStatus: string, policy: SyncPolicy): boolean => (policy.includeStale === false ? syncStatus === "current" : true);

// The three scoped indices. Inner maps dedup to ONE representative edge per relationship (the DB edge key is unique, so at most one
// exists in a correct graph; on a malformed duplicate the FIRST wins — deterministic, never double-counts).
type AccessIndex = {
  directByIdentity: Map<string, Map<string, EdgeProvenance>>; // nodeKey(identity) -> (appId -> user-assignment provenance)
  groupsByIdentity: Map<string, Map<string, EdgeProvenance>>; // nodeKey(identity) -> (groupId -> membership provenance)
  appsByGroup: Map<string, Map<string, EdgeProvenance>>;      // nodeKey(group)    -> (appId -> group-assignment provenance)
  scopeOf: Map<string, Scope>;                                // identityId -> its scope (first node wins on a malformed duplicate)
};

const setFirst = (outer: Map<string, Map<string, EdgeProvenance>>, key: string, inner: string, prov: EdgeProvenance): void => {
  let m = outer.get(key);
  if (!m) { m = new Map(); outer.set(key, m); }
  if (!m.has(inner)) m.set(inner, prov); // FIRST wins -> deterministic; a duplicate edge never double-counts
};

export function buildAccessIndex(graph: AccessGraph, policy: SyncPolicy = {}): AccessIndex {
  const directByIdentity = new Map<string, Map<string, EdgeProvenance>>();
  const groupsByIdentity = new Map<string, Map<string, EdgeProvenance>>();
  const appsByGroup = new Map<string, Map<string, EdgeProvenance>>();
  const scopeOf = new Map<string, Scope>();

  for (const n of graph.identities) if (!scopeOf.has(n.id)) scopeOf.set(n.id, { tenantId: n.tenantId, connectionId: n.connectionId, provider: n.provider });

  for (const e of graph.userAssignments) {
    if (!keeps(e.syncStatus, policy)) continue;
    setFirst(directByIdentity, nodeKey(e, e.identityAccountId), e.directoryApplicationId, provOf(e));
  }
  for (const e of graph.memberships) {
    if (!keeps(e.syncStatus, policy)) continue;
    setFirst(groupsByIdentity, nodeKey(e, e.identityAccountId), e.directoryGroupId, provOf(e));
  }
  for (const e of graph.groupAssignments) {
    if (!keeps(e.syncStatus, policy)) continue;
    setFirst(appsByGroup, nodeKey(e, e.directoryGroupId), e.directoryApplicationId, provOf(e));
  }
  return { directByIdentity, groupsByIdentity, appsByGroup, scopeOf };
}

// Resolve one identity against a prebuilt index. Pure; O(direct_d + Σ_{g in groups(d)} appsByGroup[g]).
function resolveWithIndex(index: AccessIndex, identityId: string, scope: Scope): IdentityAccess {
  const iKey = nodeKey(scope, identityId);
  // per-app accumulator (deduped by appId): direct edge (if any) + every group reasoning path.
  const acc = new Map<string, { direct: boolean; directProvenance: EdgeProvenance | null; groupPaths: GroupPath[] }>();
  const at = (appId: string) => {
    let a = acc.get(appId);
    if (!a) { a = { direct: false, directProvenance: null, groupPaths: [] }; acc.set(appId, a); }
    return a;
  };

  // DIRECT: identity -> app.
  const direct = index.directByIdentity.get(iKey);
  if (direct) for (const [appId, prov] of direct) { const a = at(appId); a.direct = true; a.directProvenance = prov; }

  // GROUP: identity -> group -> app. A visited-set dedupes repeated membership rows and (defensively) precludes any re-entry — there is
  // no group->group edge, so this loop is inherently non-recursive and bounded; cycles cannot occur (see MAX_GROUP_DEPTH).
  const groups = index.groupsByIdentity.get(iKey);
  if (groups) {
    const visited = new Set<string>();
    for (const [groupId, membershipProv] of groups) {
      if (visited.has(groupId)) continue;
      visited.add(groupId);
      const apps = index.appsByGroup.get(nodeKey(scope, groupId)); // SAME scope only -> cross-scope group-assignment can't contribute
      if (!apps) continue; // "missing group" (a group with zero assignments) contributes nothing — a normal empty lookup, not an error
      for (const [appId, assignmentProv] of apps) at(appId).groupPaths.push({ groupId, membership: membershipProv, assignment: assignmentProv });
    }
  }

  const effective: AppAccess[] = [];
  let bothCount = 0, duplicatePathsEliminated = 0;
  for (const [applicationId, a] of acc) {
    a.groupPaths.sort((x, y) => (x.groupId < y.groupId ? -1 : x.groupId > y.groupId ? 1 : 0));
    const hasGroup = a.groupPaths.length > 0;
    const classification: Classification = a.direct && hasGroup ? "BOTH" : a.direct ? "DIRECT" : "GROUP";
    if (classification === "BOTH") bothCount++;
    const paths = (a.direct ? 1 : 0) + a.groupPaths.length;
    duplicatePathsEliminated += paths - 1; // this app collapsed `paths` contributions into one entry
    effective.push({ applicationId, classification, direct: a.direct, directProvenance: a.directProvenance, groupPaths: a.groupPaths });
  }
  const byApp = (x: AppAccess, y: AppAccess) => (x.applicationId < y.applicationId ? -1 : x.applicationId > y.applicationId ? 1 : 0);
  effective.sort(byApp);
  const directApps = effective.filter((a) => a.direct);
  const groupApps = effective.filter((a) => a.groupPaths.length > 0);

  return {
    identityId, scope,
    direct: directApps, group: groupApps, effective,
    directCount: directApps.length, groupCount: groupApps.length, effectiveCount: effective.length,
    bothCount, duplicatePathsEliminated,
  };
}

// Resolve a SINGLE identity. Throws if the identity id is not present in graph.identities (its scope is unknown — a caller error).
export function resolveEffectiveAccess(graph: AccessGraph, identityId: string, policy: SyncPolicy = {}): IdentityAccess {
  const index = buildAccessIndex(graph, policy);
  const scope = index.scopeOf.get(identityId);
  if (!scope) throw new Error(`resolveEffectiveAccess: identity ${identityId} is not present in the graph`);
  return resolveWithIndex(index, identityId, scope);
}

// Resolve EVERY identity in the graph (whole-tenant). Builds the index ONCE. Returns one result per DISTINCT identity id, sorted by id.
export function resolveAllEffectiveAccess(graph: AccessGraph, policy: SyncPolicy = {}): IdentityAccess[] {
  const index = buildAccessIndex(graph, policy);
  const out: IdentityAccess[] = [];
  const seen = new Set<string>();
  for (const [identityId, scope] of index.scopeOf) {
    if (seen.has(identityId)) continue;
    seen.add(identityId);
    out.push(resolveWithIndex(index, identityId, scope));
  }
  out.sort((a, b) => (a.identityId < b.identityId ? -1 : a.identityId > b.identityId ? 1 : 0));
  return out;
}
