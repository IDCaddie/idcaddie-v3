// Phase 15 Part 1 PR B — assemble validated migration-0061 RPC rows into the Phase-14 GovernanceGraph (the engine derives the Phase-13
// AccessGraph from it). Pure, deterministic, no I/O. The RPCs OMIT tenant_id (deliberately), so this layer INJECTS the verified tenant id
// into every node/edge scope — without it, the engine's scope-keyed traversal would silently drop every edge. It maps ONLY row-id
// references + scope + sync freshness into the graph (display labels are handled separately in the view models); it never joins by label,
// email, or external_id, and it never infers access (that is Phase 13) or findings (that is Phase 14). A window sentinel keeps it server-lean.

import type { CanonicalNode, GovernanceGraph } from "@/lib/server/governance-analytics/types";
import type { MembershipEdge, UserAssignmentEdge, GroupAssignmentEdge } from "@/lib/server/access-graph/types";
import type { IdentityRow, GroupRow, ApplicationRow, MembershipRow, UserAssignmentRow, GroupAssignmentRow } from "./access-rpc-types";

if (typeof (globalThis as { window?: unknown }).window !== "undefined") {
  throw new Error("access-graph-assembly is server-only and must not be imported in client code");
}

export type AccessGraphRows = {
  identities: readonly IdentityRow[];
  groups: readonly GroupRow[];
  applications: readonly ApplicationRow[];
  memberships: readonly MembershipRow[];
  userAssignments: readonly UserAssignmentRow[];
  groupAssignments: readonly GroupAssignmentRow[];
};

const node = (tenantId: string, r: { id: string; connection_id: string; provider: string; sync_status: CanonicalNode["syncStatus"]; stale_since: string | null }): CanonicalNode =>
  ({ id: r.id, tenantId, connectionId: r.connection_id, provider: r.provider, syncStatus: r.sync_status, staleSince: r.stale_since });

// Assemble the GovernanceGraph. tenantId is the VERIFIED active tenant (from the repository's owner/admin gate) — never from a row.
export function assembleGovernanceGraph(tenantId: string, rows: AccessGraphRows): GovernanceGraph {
  const memberships: MembershipEdge[] = rows.memberships.map((r) => ({
    tenantId, connectionId: r.connection_id, provider: r.provider, syncStatus: r.sync_status, staleSince: r.stale_since,
    identityAccountId: r.identity_account_id, directoryGroupId: r.directory_group_id,
  }));
  const userAssignments: UserAssignmentEdge[] = rows.userAssignments.map((r) => ({
    tenantId, connectionId: r.connection_id, provider: r.provider, syncStatus: r.sync_status, staleSince: r.stale_since,
    identityAccountId: r.identity_account_id, directoryApplicationId: r.directory_application_id,
  }));
  const groupAssignments: GroupAssignmentEdge[] = rows.groupAssignments.map((r) => ({
    tenantId, connectionId: r.connection_id, provider: r.provider, syncStatus: r.sync_status, staleSince: r.stale_since,
    directoryGroupId: r.directory_group_id, directoryApplicationId: r.directory_application_id,
  }));
  return {
    identities: rows.identities.map((r) => node(tenantId, r)),
    groups: rows.groups.map((r) => node(tenantId, r)),
    applications: rows.applications.map((r) => node(tenantId, r)),
    memberships, userAssignments, groupAssignments,
  };
}
