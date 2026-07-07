// Server-only fetch wrapper for the "Needs Attention" queue. Fetches every underlying RLS-scoped DAL in
// parallel (each already fail-closed), then hands the results to the PURE buildNeedsAttention categorizer
// (./needs-attention). Kept separate so the pure logic + its tests never pull in @/lib/supabase/server.

import { listAppsWithCountsForCurrentUser, listAppOwnershipForCurrentUser } from "./apps";
import { listContractsForCurrentUser } from "./contracts";
import { listConnectorsForCurrentUser } from "./connectors";
import { getReportsSummaryForCurrentUser } from "./reports";
import { listCatalogForCurrentUser } from "./catalog";
import { buildNeedsAttention, type NeedsAttention, type NeedsAttentionInputs } from "./needs-attention";

export type { AttentionSection, AttentionItem, NeedsAttention } from "./needs-attention";

export async function getNeedsAttentionForCurrentUser(): Promise<NeedsAttention> {
  const [appsCounts, appsOwnership, contracts, connectors, reports, catalogAliases] = await Promise.all([
    listAppsWithCountsForCurrentUser(),
    listAppOwnershipForCurrentUser(),
    listContractsForCurrentUser(),
    listConnectorsForCurrentUser(),
    getReportsSummaryForCurrentUser()
      .then((data): NeedsAttentionInputs["reports"] => ({ ok: true, data }))
      .catch((): NeedsAttentionInputs["reports"] => ({ ok: false })),
    listCatalogForCurrentUser(),
  ]);
  return buildNeedsAttention({ appsCounts, appsOwnership, contracts, connectors, reports, catalogAliases });
}
