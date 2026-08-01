// Phase 5 — the loader behind Connector Management.
//
// One RPC returns every connector with its lifecycle, evidence timestamps and directory counts, so the page costs one round trip
// whether the workspace has one directory or ten. This is deliberately the ONE product read that returns inactive connectors:
// its job is to show what exists, and hiding a disconnected connector would make disconnect look like deletion.

import { accessGate, listConnectorInventory, listConnectorRuns, type ConnectorInventoryRow, type ConnectorRunRow } from "./access-repository";
import { CONNECTOR_LIFECYCLE_LABEL, connectorHealth, type ConnectorHealthView, type ConnectorLifecycle } from "./connector-health";

// The lifecycle vocabulary and health derivation are pure and live in ./connector-health so the management components can use
// them. Re-exported here so a server caller has one import.
export * from "./connector-health";

export type ConnectorSummary = {
  readonly id: string;
  readonly provider: string;
  readonly name: string;
  readonly organization: string | null;
  readonly lifecycle: ConnectorLifecycle;
  readonly lifecycleLabel: string;
  readonly health: ConnectorHealthView;
  readonly active: boolean;
  readonly supersededBy: string | null;
  readonly disconnectedAt: string | null;
  readonly disconnectedReason: string | null;
  readonly lastVerifiedAt: string | null;
  readonly lastDiscoveryAt: string | null;
  readonly createdAt: string | null;
  readonly counts: { readonly people: number; readonly groups: number; readonly applications: number; readonly memberships: number; readonly userAssignments: number; readonly groupAssignments: number };
};

export type ConnectorManagementData = {
  readonly connectors: readonly ConnectorSummary[];
  readonly activeCount: number;
  readonly inactiveCount: number;
};
export type ConnectorManagementResult = { ok: true; data: ConnectorManagementData } | { ok: false; error: "forbidden" | "query_failed" };

const LIFECYCLES = new Set<string>(["configured", "verified", "discovering", "discovered", "failed", "superseded", "disconnected"]);
const lifecycleOf = (v: string): ConnectorLifecycle => (LIFECYCLES.has(v) ? (v as ConnectorLifecycle) : "configured");

function toSummary(r: ConnectorInventoryRow): ConnectorSummary {
  const lifecycle = lifecycleOf(r.lifecycle);
  return {
    id: r.id, provider: r.provider,
    // Never a bare uuid on screen. Display name, else the organization, else the provider.
    name: r.display_name?.trim() || r.organization?.trim() || r.provider,
    organization: r.organization,
    lifecycle, lifecycleLabel: CONNECTOR_LIFECYCLE_LABEL[lifecycle],
    health: connectorHealth(r),
    active: r.superseded_by === null && r.disconnected_at === null,
    supersededBy: r.superseded_by, disconnectedAt: r.disconnected_at, disconnectedReason: r.disconnected_reason,
    lastVerifiedAt: r.last_verified_at, lastDiscoveryAt: r.last_discovery_at, createdAt: r.created_at,
    counts: {
      people: r.identities, groups: r.groups, applications: r.applications,
      memberships: r.memberships, userAssignments: r.user_assignments, groupAssignments: r.group_assignments,
    },
  };
}

export async function loadConnectorManagement(): Promise<ConnectorManagementResult> {
  const g = await accessGate();
  if (!g.ok) return { ok: false, error: "forbidden" };
  const r = await listConnectorInventory(g.tenantId);
  if (!r.ok) return { ok: false, error: "query_failed" };
  const connectors = r.data.map(toSummary);
  return {
    ok: true,
    data: {
      connectors,
      activeCount: connectors.filter((c) => c.active).length,
      inactiveCount: connectors.filter((c) => !c.active).length,
    },
  };
}

export type ConnectorDetailData = { readonly connector: ConnectorSummary; readonly runs: readonly ConnectorRunRow[] };
export type ConnectorDetailResult = { ok: true; data: ConnectorDetailData } | { ok: false; error: "not_found" | "query_failed" };

// Detail = the inventory row plus its discovery history. Two round trips, never one per run.
export async function loadConnectorDetail(connectorId: string): Promise<ConnectorDetailResult> {
  const g = await accessGate();
  if (!g.ok) return { ok: false, error: "not_found" };   // forbidden and missing collapse, as everywhere else
  const [inv, runs] = await Promise.all([listConnectorInventory(g.tenantId), listConnectorRuns(g.tenantId, connectorId)]);
  if (!inv.ok || !runs.ok) return { ok: false, error: "query_failed" };
  const row = inv.data.find((c) => c.id === connectorId);
  if (!row) return { ok: false, error: "not_found" };
  return { ok: true, data: { connector: toSummary(row), runs: runs.data } };
}
