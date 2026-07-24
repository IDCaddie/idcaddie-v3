// Phase 13 — the typed input/output for the effective-access GRAPH ENGINE. Provider-neutral, edge-input-driven, COMPUTE-ONLY.
// The engine consumes the durable canonical edges (as row-id tuples carrying their (tenant, connection, provider) scope) and computes,
// for each identity, its DIRECT / GROUP-derived / EFFECTIVE application access with full provenance and reasoning paths. It writes
// NOTHING — no table, no fact, no RPC, no migration, no DB read. These are pure data shapes; the caller loads the edges (a future,
// separate read path) and passes them in. Reachable "applications" are ALWAYS directory_applications ROW ids, never external_ids
// (external_id is unique only per (tenant, connection, provider), so it is ambiguous across connections). See docs — RISK-007 OPEN.

// The connector sync_status vocabulary (identical across every directory_* node + edge: 0053/0054/0056/0057/0059).
export type SyncStatus = "current" | "stale" | "review_required" | "disconnected";

// The scope triple every canonical node + edge carries. Traversal NEVER crosses a scope.
export type Scope = { tenantId: string; connectionId: string; provider: string };

// The freshness + lineage an edge carries, surfaced in provenance so a reasoning path is auditable (no extra table).
export type EdgeProvenance = {
  syncStatus: SyncStatus;
  lastDiscoveryRunId?: string | null;
  firstSeenAt?: string | null;
  lastSeenAt?: string | null;
  staleSince?: string | null;
  sourceEndpoint?: string | null;
};

// Nodes are identified by their canonical ROW id + scope. Only identities are required by the engine (for scope + iteration);
// groups/applications are reachable purely through the edges ("never infer absent edges" — the engine never enumerates the app table).
export type IdentityNode = Scope & { id: string };

// The three canonical EDGE kinds (row-id references only; each carries scope + provenance).
export type MembershipEdge = Scope & EdgeProvenance & { identityAccountId: string; directoryGroupId: string };        // identity <-> group
export type UserAssignmentEdge = Scope & EdgeProvenance & { identityAccountId: string; directoryApplicationId: string }; // identity -> app (DIRECT)
export type GroupAssignmentEdge = Scope & EdgeProvenance & { directoryGroupId: string; directoryApplicationId: string }; // group -> app

// The whole input graph. May contain edges spanning MULTIPLE scopes (e.g. a tenant's rows across connections) — the engine resolves
// each identity STRICTLY within that identity's own scope and ignores any cross-scope edge.
export type AccessGraph = {
  identities: readonly IdentityNode[];
  memberships: readonly MembershipEdge[];
  userAssignments: readonly UserAssignmentEdge[];
  groupAssignments: readonly GroupAssignmentEdge[];
};

// Default (undefined / includeStale:true) = include ALL edges regardless of sync_status (a stale edge still asserts a — possibly
// historical — relationship; the GO forbids inferring absent edges). includeStale:false = consider only sync_status='current' edges.
export type SyncPolicy = { includeStale?: boolean };

export type Classification = "DIRECT" | "GROUP" | "BOTH";

// One group-derived reasoning path to an application: identity --(membership)--> group --(assignment)--> application.
export type GroupPath = {
  groupId: string;             // directory_groups.id that grants the app
  membership: EdgeProvenance;  // the identity<->group membership edge
  assignment: EdgeProvenance;  // the group->app assignment edge
};

// One reachable application for an identity (deduped: each app appears ONCE, with every contributing path).
export type AppAccess = {
  applicationId: string;                    // directory_applications.id ROW id — NEVER external_id
  classification: Classification;
  direct: boolean;
  directProvenance: EdgeProvenance | null;  // the identity->app user-assignment edge, iff `direct`
  groupPaths: GroupPath[];                  // every distinct group reasoning path, iff group-derived (sorted by groupId)
};

// The per-identity effective-access result.
export type IdentityAccess = {
  identityId: string;
  scope: Scope;
  direct: AppAccess[];      // classification DIRECT or BOTH (has a direct edge)   — sorted by applicationId
  group: AppAccess[];       // classification GROUP or BOTH (has >=1 group path)   — sorted by applicationId
  effective: AppAccess[];   // the deduped union — each app once                   — sorted by applicationId
  directCount: number;      // apps with a direct edge
  groupCount: number;       // apps with >=1 group path
  effectiveCount: number;   // distinct reachable apps (== effective.length)
  bothCount: number;        // apps reachable by BOTH a direct and a group path
  duplicatePathsEliminated: number; // total contributing paths minus distinct apps (paths collapsed by dedup)
};
