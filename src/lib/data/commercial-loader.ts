import { listEntitlementsForContract, type ContractEntitlement } from "./contract-entitlements";
import { loadConnectorManagement, type ConnectorSummary } from "./connector-management";
import { accessGate, getSaasCounts } from "./saas-accounts";
import { resolveCapability, type ConnectorFacts } from "@/lib/canonical/capabilities";
import { reconcileEntitlement, type DiscoveredCounts } from "@/lib/server/commercial-analytics/reconcile";
import { evaluateCommercial, summarize, type ConnectionFacts, type ContractFacts } from "@/lib/server/commercial-analytics/evaluate";
import type { ConceptCapabilities, EntitlementReconciliation, CommercialSummary } from "@/lib/server/commercial-analytics/types";
import { toCommercialFindingView, type CommercialFindingView } from "./commercial-presenter";

// Phase 10 — the server-side assembly for one contract's commercial view.
//
// SERVER-ONLY (it reaches the user-scoped Supabase client through the DALs below). It fetches, the engines compute, and the page
// renders — no page derives a commercial number itself.
//
// THE DEGRADATION RULE, which is the whole reason this file is careful. `contract_entitlements` is readable by anyone who can read
// the contract (0083), but the discovered evidence behind `product_app_account_counts` is owner/admin only (0078). A
// procurement-org manager therefore sees the purchased lines and CANNOT see the accounts. That must render as "we could not read
// it", never as zero provisioned and certainly never as a savings opportunity computed against a zero — which is exactly what a
// naive `?? 0` here would produce. Every failure path below resolves to an `unavailable` measure carrying a sentence.

export type ContractCommercialView = {
  readonly reconciliations: readonly EntitlementReconciliation[];
  readonly findings: readonly CommercialFindingView[];
  readonly summary: CommercialSummary;
  readonly entitlementCount: number;
  // True when the caller may read purchased lines but not the discovered evidence. The UI says so rather than showing gaps.
  readonly discoveredEvidenceReadable: boolean;
};

export type ContractCommercialResult =
  | { ok: true; data: ContractCommercialView }
  | { ok: false; error: "query_failed" };

const toConnectorFacts = (c: ConnectorSummary): ConnectorFacts => ({
  id: c.id,
  provider: c.provider,
  active: c.active,
  lifecycle: c.lifecycle,
  healthState: c.health.state,
  lastDiscoveryAt: c.lastDiscoveryAt,
  // The capability model asks whether THIS capability produced data. For the SaaS spoke that is the account evidence, which the
  // counts call below answers per connection; at connector granularity, a completed discovery is the available signal.
  hasCurrentData: c.lifecycle === "discovered",
  hasStaleData: c.lifecycle === "discovering" || c.lifecycle === "failed",
});

// Resolve the four concept capabilities once. `readFailed` propagates the difference between "no connector" and "we could not
// look", which the capability model already distinguishes and which must not be flattened here.
function conceptCapabilities(connectors: readonly ConnectorSummary[], readFailed: boolean): ConceptCapabilities {
  const facts = connectors.map(toConnectorFacts);
  return {
    assigned: resolveCapability("assignments", facts, readFailed),
    provisioned: resolveCapability("app_accounts", facts, readFailed),
    billable: resolveCapability("licenses", facts, readFailed),
    active: resolveCapability("usage", facts, readFailed),
  };
}

export async function loadContractCommercialView(
  contract: ContractFacts,
): Promise<ContractCommercialResult> {
  const lines = await listEntitlementsForContract(contract.id);
  if (!lines.ok) return { ok: false, error: "query_failed" };

  // A failed connector read is NOT "no connectors" — it becomes readFailed, so every capability answers "could not be
  // determined" instead of "not connected", which would send someone to connect something they already have.
  const connectors = await loadConnectorManagement();
  const connectorList = connectors.ok ? connectors.data.connectors : [];
  const capabilities = conceptCapabilities(connectorList, !connectors.ok);

  const gate = await accessGate();
  const discovered = new Map<string, DiscoveredCounts | null>();
  const connectionFacts: ConnectionFacts[] = [];

  if (gate.ok) {
    // One counts call per DECLARED connection — never per connector. A line that names no source is not measured, and asking
    // every connector "how many accounts do you have?" on a contract page would be paying for evidence nobody asked for.
    const declared = [...new Set(lines.data.map((l) => l.measuredByConnectionId).filter((x): x is string => x !== null))];
    for (const connectionId of declared) {
      const counts = await getSaasCounts(gate.tenantId, connectionId);
      if (!counts.ok) {
        discovered.set(connectionId, null);   // read failed → unavailable, not zero
        continue;
      }
      discovered.set(connectionId, {
        current: counts.data.accounts.current,
        stale: counts.data.accounts.stale,
        inactive: counts.data.accounts.inactive,
        // The RPC omits lastSeenAt when there is nothing current to date-stamp, so the schema makes it optional. Absent and
        // null mean the same thing here — "no observation to timestamp" — and both must arrive as null, never as undefined.
        lastSeenAt: counts.data.accounts.lastSeenAt ?? null,
      });
      connectionFacts.push({
        connectionId,
        currentAccounts: counts.data.accounts.current,
        inactiveAccounts: counts.data.accounts.inactive,
        staleAccounts: counts.data.accounts.stale,
      });
    }
  }

  const reconciliations = lines.data.map((l) =>
    reconcileEntitlement(l, l.measuredByConnectionId ? (discovered.get(l.measuredByConnectionId) ?? null) : null, capabilities),
  );

  // Scoped to THIS contract: the portfolio rules (duplicates across contracts, connectors with no contract at all) belong to a
  // portfolio surface and would be wrong here — a single contract page cannot see the other contracts that would clear them.
  const findings = evaluateCommercial({
    contracts: [contract],
    entitlements: lines.data as readonly ContractEntitlement[],
    reconciliations,
    connections: connectionFacts,
    now: new Date(),
    detectedAt: new Date().toISOString(),
  }).filter((f) => f.ruleId !== "possible_duplicate_entitlement" && f.ruleId !== "discovered_source_without_entitlement");

  return {
    ok: true,
    data: {
      reconciliations,
      findings: findings.map(toCommercialFindingView),
      summary: summarize(findings),
      entitlementCount: lines.data.length,
      discoveredEvidenceReadable: gate.ok,
    },
  };
}
