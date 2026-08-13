// Phase 7B — PRODUCT DATA LINEAGE. Every metric the product displays, and exactly one owner for each.
//
// The rule this encodes: no page computes its own metric. A number appears on a screen because a registered entry says where it
// comes from, not because a component happened to have the rows to hand. Two surfaces deriving the same number independently is
// how "7 groups" and "6 groups" coexisted for four phases.
//
// This registry is MACHINE-READABLE on purpose. A test walks it and fails if a metric is displayed without an entry, or if two
// entries claim the same name — so the documentation cannot drift from the product, because it is the same artefact.
//
// PURE data. No I/O.

import type { Capability } from "./capabilities";

export type RefreshTrigger = "directory_discovery" | "connector_lifecycle" | "contract_write" | "file_upload" | "none";

export type MetricLineage = {
  readonly id: string;                 // stable key, referenced by the component that renders it
  readonly name: string;               // what the customer sees
  readonly capability: Capability;     // which source capability owns it
  readonly rpc: string | null;         // the ONE read contract; null = derived in an engine from other registered metrics
  readonly tables: readonly string[];  // canonical tables behind it, for audit
  readonly formula: string;            // in words. "count of X where Y" — never an unexplained derivation
  readonly refresh: RefreshTrigger;    // what makes it change
  readonly connectorScoped: boolean;   // does ?connection= change it
  readonly unavailableState: string;   // what renders when the capability is not available — NEVER a zero
  readonly staleBehaviour: string;     // what happens to retained-but-not-current rows
  readonly security: string;           // the boundary that governs it
};

const RLS_OWNER_ADMIN = "RLS + has_tenant_role(owner|admin); tenant derived server-side; superseded and disconnected connectors excluded.";
const CURRENT_ONLY = "Excluded. Stale rows are retained and counted only under totalEvidence, never in this metric.";

export const METRICS: readonly MetricLineage[] = [
  {
    id: "people", name: "People", capability: "identity",
    rpc: "product_directory_access_counts", tables: ["identity_accounts"],
    formula: "count of identity_accounts with sync_status = 'current', in scope",
    refresh: "directory_discovery", connectorScoped: true,
    unavailableState: "Requires a connected directory connector.", staleBehaviour: CURRENT_ONLY, security: RLS_OWNER_ADMIN,
  },
  {
    id: "groups", name: "Groups", capability: "groups",
    rpc: "product_directory_access_counts", tables: ["directory_groups"],
    formula: "count of directory_groups with sync_status = 'current', in scope",
    refresh: "directory_discovery", connectorScoped: true,
    unavailableState: "Requires a connected directory connector.", staleBehaviour: CURRENT_ONLY, security: RLS_OWNER_ADMIN,
  },
  {
    id: "directory_applications", name: "Directory applications", capability: "directory_applications",
    rpc: "product_directory_access_counts", tables: ["directory_applications"],
    formula: "count of directory_applications with sync_status = 'current', in scope",
    refresh: "directory_discovery", connectorScoped: true,
    unavailableState: "Requires a connected directory connector.", staleBehaviour: CURRENT_ONLY, security: RLS_OWNER_ADMIN,
  },
  {
    id: "effective_access", name: "Effective access", capability: "assignments",
    rpc: null, tables: ["directory_group_memberships", "directory_application_user_assignments", "directory_application_group_assignments"],
    formula: "identity→application relationships resolved by the Phase-13 access engine over the current graph; NOT a row count",
    refresh: "directory_discovery", connectorScoped: true,
    unavailableState: "Withheld when the graph exceeds the evaluation bound; counts remain, distribution does not.",
    staleBehaviour: "Excluded unless the stale scope is explicitly requested.", security: RLS_OWNER_ADMIN,
  },
  {
    id: "group_mediated_access", name: "Through group only", capability: "assignments",
    rpc: null, tables: ["directory_group_memberships", "directory_application_group_assignments"],
    formula: "effective relationships classified GROUP by the access engine — access held only via membership",
    refresh: "directory_discovery", connectorScoped: true,
    unavailableState: "Withheld with the rest of the distribution when the graph is too large.",
    staleBehaviour: "Excluded unless the stale scope is explicitly requested.", security: RLS_OWNER_ADMIN,
  },
  {
    id: "high_findings", name: "High findings", capability: "assignments",
    rpc: null, tables: ["identity_accounts", "directory_groups", "directory_applications"],
    formula: "governance summary bySeverity.high from the Phase-14 engine; taken from the engine summary, never re-counted",
    refresh: "directory_discovery", connectorScoped: true,
    unavailableState: "Withheld when whole-graph evaluation did not run; 0 would be a false all-clear.",
    staleBehaviour: "Findings carry a staleEvidence flag; they are not silently dropped.", security: RLS_OWNER_ADMIN,
  },
  {
    id: "retained_stale_evidence", name: "Retained stale evidence", capability: "identity",
    rpc: "product_directory_access_counts", tables: ["identity_accounts", "directory_groups", "directory_applications"],
    formula: "counts.stale — rows last seen in an earlier discovery, retained as evidence",
    refresh: "directory_discovery", connectorScoped: true,
    unavailableState: "Requires a connected directory connector.",
    staleBehaviour: "This metric IS the stale reading; it is never presented as an active count.", security: RLS_OWNER_ADMIN,
  },
  {
    id: "connector_health", name: "Connector health", capability: "identity",
    rpc: "product_connector_inventory", tables: ["connectors", "okta_connector_configs", "connector_runs"],
    formula: "derived from lifecycle + last run; never stored, so it cannot drift from the evidence it summarises",
    refresh: "connector_lifecycle", connectorScoped: false,
    unavailableState: "Reported as unavailable — never rendered as healthy.", staleBehaviour: "n/a", security: RLS_OWNER_ADMIN,
  },
  // ── SaaS-management metrics. Separate spoke, separate owner, no directory involvement. ────────────────────────────────
  {
    id: "saas_inventory", name: "SaaS inventory", capability: "contracts",
    rpc: null, tables: ["apps"], formula: "count of normalized software records visible to the caller",
    refresh: "none", connectorScoped: false,
    unavailableState: "Requires SaaS records; not derived from any directory connector.",
    staleBehaviour: "n/a — not discovery-sourced.", security: "RLS; tenant-scoped.",
  },
  {
    id: "contracts_visible", name: "Contracts", capability: "contracts",
    rpc: null, tables: ["contracts"], formula: "count of contracts visible to the caller",
    refresh: "contract_write", connectorScoped: false,
    unavailableState: "Requires contract records.", staleBehaviour: "n/a", security: "RLS; tenant-scoped.",
  },
  {
    id: "tracked_spend", name: "Tracked contract spend", capability: "spend",
    rpc: null, tables: ["contracts"],
    formula: "sum of contracts.total_cost grouped by currency; ONLY contract fields — no invoice or licence source exists",
    refresh: "contract_write", connectorScoped: false,
    unavailableState: "Requires contracts with a recorded cost.",
    staleBehaviour: "n/a", security: "RLS; tenant-scoped.",
  },
  // ── Phase 10 commercial metrics. The purchased side and its reconciliation. Separate owner from `tracked_spend`, which is a
  // ── contract-level commitment total and answers a different question from a per-line purchased quantity. ─────────────────
  {
    id: "purchased_quantity", name: "Purchased", capability: "contracts",
    rpc: null, tables: ["contract_entitlements"],
    formula: "contract_entitlements.purchased_quantity for one line, as recorded; NULL is 'not recorded' and is never counted as 0",
    refresh: "contract_write", connectorScoped: false,
    unavailableState: "No purchased quantity has been recorded for this line. This is not a quantity of zero.",
    staleBehaviour: "n/a — recorded from paper, not discovered.", security: "RLS; readable by whoever may read the parent contract (0083).",
  },
  {
    id: "provisioned_accounts", name: "Provisioned", capability: "app_accounts",
    rpc: "product_app_account_counts", tables: ["app_accounts"],
    formula: "accounts.current for the connector the line DECLARES as its measurement source; never inferred from a provider name",
    refresh: "directory_discovery", connectorScoped: false,
    unavailableState: "Requires a declared measurement source with readable account evidence; the explanation is rendered instead.",
    staleBehaviour: "Stale rows are excluded from the count and raise a stale-evidence flag on the line.",
    security: "RLS + has_tenant_role(owner|admin) on the RPC; a reader without it sees 'unavailable', never 0.",
  },
  {
    id: "annual_reduction_opportunity", name: "Estimated annual reduction", capability: "spend",
    rpc: null, tables: ["contract_entitlements", "app_accounts"],
    formula:
      "(purchased − max(contracted minimum, provisioned)) × unit_amount × periods per year, per currency; requires a unit price with a currency and an annualizable cadence, and is never summed across currencies",
    refresh: "contract_write", connectorScoped: false,
    unavailableState: "No estimate is offered unless a purchase, a discovered count and an annualizable price all exist.",
    staleBehaviour: "Inherits the line's stale-evidence flag; the figure is shown with it, never silently.",
    security: "RLS; derived only from figures the caller may already read.",
  },
];

export const metric = (id: string): MetricLineage | undefined => METRICS.find((m) => m.id === id);
export const metricsForCapability = (c: Capability): readonly MetricLineage[] => METRICS.filter((m) => m.capability === c);

// ── refresh propagation ──────────────────────────────────────────────────────────────────────────────────────────────────────
// What a source event invalidates. Declared here rather than scattered across revalidatePath calls, so adding a connector means
// adding a row — not hunting for every page that happens to read it.
export const REFRESH_PATHS: Record<RefreshTrigger, readonly string[]> = {
  directory_discovery: ["/dashboards", "/directory/people", "/directory/groups", "/directory/applications", "/access", "/access/findings", "/connectors/manage"],
  connector_lifecycle: ["/dashboards", "/connectors", "/connectors/manage", "/directory/people", "/directory/groups", "/directory/applications", "/access", "/access/findings"],
  contract_write: ["/dashboards", "/contracts"],
  file_upload: ["/files"],
  none: [],
};
