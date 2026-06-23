// Server-only RESOLVER READ PATH for staged facts — a READ-ONLY preview over ALREADY-STAGED `discovery_facts`
// rows (docs/42 §68). It lists staged facts for the current authenticated tenant (through the user-scoped,
// RLS-enforced read store) and computes what the resolver WOULD do using the pure logic from PR #140 — WITHOUT
// mutating anything. This lets us inspect resolver decisions over persisted facts; it is NOT the resolver
// write path, NOT a provider connector, NOT a sync.
//
// SAFE BY DESIGN:
//   * the only DB access is reading staged rows through the INJECTED `DiscoveryFactReadStore`, backed by the
//     authenticated user-scoped (RLS-enforced) client when wired — this module imports NO Supabase client and
//     uses NO service-role. Tenant scoping comes from the authenticated context + RLS, NOT from trusting a
//     payload tenant_id: the read functions return [] WITHOUT querying when there is no authenticated tenant.
//   * the preview is strictly READ-ONLY and in-memory: it PERSISTS NOTHING, never updates
//     discovery_facts.review_status, and never writes the canonical app graph (apps.canonical_app_id /
//     app_aliases / app_user_identity_matches). The live resolver WRITE path is NOT implemented.
//   * a row whose fact payload carries no deterministic instance key (or a malformed payload) previews as
//     `human_review` — unknown/ambiguous staged facts fail closed.
//
// SERVER-ONLY: under `src/lib/server/`, the runtime browser sentinel below, and `no-client-import.test.ts`.
// Its only import is the sibling pure resolver logic (`./resolution`).

import {
  appResolutionSignals,
  explainResolutionDecision,
  type ResolutionDecision,
  type DiscoveryResolutionInput,
} from "./resolution";

// Runtime server-only sentinel — throw if evaluated in a browser.
if (typeof (globalThis as { window?: unknown }).window !== "undefined") {
  throw new Error("connector-vault/discovery-fact-read is server-only and must not be imported in client code");
}

// The staged-fact fields this read path needs. `fact_json` is the validated fact payload (jsonb) — read
// DEFENSIVELY (it is treated as unknown and field-extracted, never trusted as a typed object).
export type StagedDiscoveryFactRow = {
  id: string;
  tenant_id: string;
  fact_type: string;
  fact_json: unknown;
};

// The injected READ boundary. The real implementation lists `discovery_facts` through the authenticated
// user-scoped (RLS-enforced) client, so it returns ONLY the current tenant's rows — never a service-role
// client. There is intentionally NO write/update method here: this is a read path.
export interface DiscoveryFactReadStore {
  listStagedFacts(): Promise<readonly StagedDiscoveryFactRow[]>;
}

// A READ-ONLY resolver preview for one staged fact — a PREDICTION, never persisted, never a graph write.
export type StagedFactPreview = {
  factId: string;
  factType: string;
  decision: ResolutionDecision;
};

// Pure: extract the DETERMINISTIC instance discriminators from a staged row's fact_json (fail closed if the
// payload is missing/malformed). No probabilistic similarity is synthesized — there is no in-memory corpus —
// so a row without a deterministic instance key yields no signals and previews as human_review.
export function mapDiscoveryFactRowToResolutionInput(row: StagedDiscoveryFactRow): DiscoveryResolutionInput {
  const f = (row.fact_json !== null && typeof row.fact_json === "object" ? row.fact_json : {}) as Record<string, unknown>;
  const str = (k: string): string | null => (typeof f[k] === "string" ? (f[k] as string) : null);
  return {
    instanceDomain: str("instance_domain"),
    externalInstanceId: str("external_instance_id"),
    instanceUrl: str("instance_url"),
    ownerOrgId: str("owner_org_hint"),
    payingOrgId: str("paying_org_hint"),
    responsibleOrgId: str("responsible_org_hint"),
  };
}

// Pure: staged rows -> READ-ONLY previews (in memory). Unknown/ambiguous rows -> human_review (fail closed).
export function previewDiscoveryFactResolutionFromRows(
  rows: readonly StagedDiscoveryFactRow[],
): StagedFactPreview[] {
  return rows.map((row) => ({
    factId: row.id,
    factType: row.fact_type,
    decision: explainResolutionDecision(appResolutionSignals(mapDiscoveryFactRowToResolutionInput(row))),
  }));
}

// List staged facts for the CURRENT authenticated tenant via the RLS read store. Returns [] WITHOUT calling
// the store when there is no authenticated tenant context (defense in depth on top of RLS — tenant scoping
// never relies on a trusted payload tenant_id).
export async function listStagedDiscoveryFactsForCurrentUser(
  store: DiscoveryFactReadStore,
  authTenantId: string | null | undefined,
): Promise<readonly StagedDiscoveryFactRow[]> {
  if (typeof authTenantId !== "string" || authTenantId.length === 0) return [];
  return store.listStagedFacts();
}

// The top read path: list staged facts (RLS-scoped) + compute READ-ONLY previews. Persists nothing, updates no
// review_status, writes no graph.
export async function previewStagedDiscoveryFacts(
  store: DiscoveryFactReadStore,
  authTenantId: string | null | undefined,
): Promise<StagedFactPreview[]> {
  const rows = await listStagedDiscoveryFactsForCurrentUser(store, authTenantId);
  return previewDiscoveryFactResolutionFromRows(rows);
}
