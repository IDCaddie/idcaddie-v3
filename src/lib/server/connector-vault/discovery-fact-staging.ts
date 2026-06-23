// Server-only DISCOVERY FACT INGESTION STAGING BOUNDARY — the first safe write path for VALIDATED discovery
// facts (docs/42 §64). It accepts UNKNOWN input, validates it against the PR #141 zod contract via `safeParse`
// + the token/secret deny-list, and stages ONLY validated, secret-free facts into the tenant-scoped
// `discovery_facts` table (migration 0025) for later resolver / human review.
//
// SAFE BY DESIGN:
//   * invalid facts and token/secret-bearing facts are REJECTED BEFORE any DB call (nothing is staged);
//   * the DB is reached through an INJECTED `DiscoveryFactStagingStore` boundary, backed by the user-scoped
//     (authenticated, RLS-enforced) DAL when wired — this module imports NO Supabase client and uses NO
//     service-role, so there is no privilege-escalation path here;
//   * it stages ONLY `discovery_facts` columns — it NEVER writes apps.canonical_app_id, app_aliases, or
//     app_user_identity_matches, NEVER calls a provider/resolver, NEVER touches connector_secrets, and exposes
//     NO API route. RLS is the authorization boundary on the insert.
//
// SERVER-ONLY: under `src/lib/server/`, the runtime browser sentinel below, and `no-client-import.test.ts`.
// Its only import is the sibling `./discovery-facts` contract (which imports only `zod`).

import {
  parseDiscoveryFact,
  hasForbiddenFactKey,
  appInstanceCandidateKey,
  type DiscoveryFact,
} from "./discovery-facts";

// Runtime server-only sentinel — throw if evaluated in a browser.
if (typeof (globalThis as { window?: unknown }).window !== "undefined") {
  throw new Error("connector-vault/discovery-fact-staging is server-only and must not be imported in client code");
}

// The exact `discovery_facts` columns the helper stages — and NOTHING else. There is intentionally no
// canonical_app_id / app_alias / person-match field here: staging never writes the canonical app graph.
export type DiscoveryFactStagingRow = {
  tenant_id: string;
  schema_version: string;
  fact_type: string;
  source_type: string;
  source_provider: string;
  source_run_id: string | null;
  source_record_id: string | null;
  signal_id: string | null;
  natural_key: string | null;
  observed_at: string;
  confidence: number | null;
  fact_json: DiscoveryFact; // the ORIGINAL safeParse-validated fact
  provenance_json: Record<string, string | number | boolean> | null;
};

// The injected DB boundary. The real implementation is backed by the user-scoped (authenticated) Supabase
// client so RLS enforces the tenant boundary on INSERT — never a service-role client. Tests inject a mock.
export interface DiscoveryFactStagingStore {
  stage(row: DiscoveryFactStagingRow): Promise<{ ok: true; id?: string } | { ok: false; reason: "db_error" }>;
}

export type FactValidationResult =
  | { ok: true; fact: DiscoveryFact }
  | { ok: false; reason: "forbidden_material" | "invalid_fact" };

export type StageResult =
  | { ok: true; id?: string }
  | { ok: false; reason: "forbidden_material" | "invalid_fact" | "tenant_mismatch" | "db_error" };

// Validate untrusted input: reject token/secret-bearing input FIRST (the pre-parse deny-list), then run the
// PR #141 `safeParse`. Fail closed — anything that is not a clean, valid fact is rejected.
export function validateDiscoveryFact(input: unknown): FactValidationResult {
  if (hasForbiddenFactKey(input)) return { ok: false, reason: "forbidden_material" };
  const parsed = parseDiscoveryFact(input);
  if (!parsed.success) return { ok: false, reason: "invalid_fact" };
  return { ok: true, fact: parsed.data };
}

// A deterministic, NON-secret within-tenant key for dedup/merge. signal_id is always present (the contract
// requires it); app-instance facts additionally fold in their instance discriminator.
function computeNaturalKey(fact: DiscoveryFact): string {
  const instanceKey = appInstanceCandidateKey(
    fact as { instance_domain?: string | null; external_instance_id?: string | null },
  );
  const keyPart = instanceKey ?? fact.signal_id ?? fact.source_record_id ?? "";
  return [fact.fact_type, fact.source_provider, keyPart].join(":").toLowerCase();
}

// Map a validated fact onto exactly the staging columns (review_status defaults to 'pending' in the DB).
function buildStagingRow(fact: DiscoveryFact, tenantId: string): DiscoveryFactStagingRow {
  const provenance = "provenance" in fact ? fact.provenance ?? null : null;
  return {
    tenant_id: tenantId,
    schema_version: String(fact.schema_version),
    fact_type: fact.fact_type,
    source_type: fact.source_type,
    source_provider: fact.source_provider,
    source_run_id: fact.source_run_id ?? null,
    source_record_id: fact.source_record_id ?? null,
    signal_id: fact.signal_id,
    natural_key: computeNaturalKey(fact),
    observed_at: fact.observed_at,
    confidence: fact.confidence ?? null,
    fact_json: fact,
    provenance_json: provenance ?? null,
  };
}

// Stage ONE untrusted fact for review. Validates + secret-checks BEFORE any DB call; binds the row to the
// authenticated `tenantId` and rejects a fact that claims a different tenant (defense in depth on top of RLS).
export async function stageDiscoveryFactForReview(
  store: DiscoveryFactStagingStore,
  tenantId: string,
  input: unknown,
): Promise<StageResult> {
  const validation = validateDiscoveryFact(input);
  if (!validation.ok) return { ok: false, reason: validation.reason };
  if (validation.fact.tenant_id !== tenantId) return { ok: false, reason: "tenant_mismatch" };
  return store.stage(buildStagingRow(validation.fact, tenantId));
}

// Stage MANY untrusted facts; each is validated independently (one bad fact does not block the rest).
export async function stageDiscoveryFactsForReview(
  store: DiscoveryFactStagingStore,
  tenantId: string,
  inputs: readonly unknown[],
): Promise<StageResult[]> {
  const results: StageResult[] = [];
  for (const input of inputs) {
    results.push(await stageDiscoveryFactForReview(store, tenantId, input));
  }
  return results;
}
