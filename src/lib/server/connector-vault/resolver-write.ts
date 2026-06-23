// Server-only DETERMINISTIC RESOLVER WRITE PATH — the FIRST canonical-graph mutation in the discovery →
// canonical pipeline (docs/42 §69). It reads staged `discovery_facts`, runs the pure PR #140 resolver logic,
// and writes ONLY deterministic, high-confidence outputs: an `app_alias` per deterministic observed identifier
// and `apps.canonical_app_id` for the matching same-tenant instance. Everything else stays reviewable.
//
// SAFETY PRINCIPLE (from #140): a FALSE MERGE is more expensive than a FALSE SPLIT. So:
//   * ONLY a `deterministic` decision auto-writes; probabilistic / ambiguous / low-confidence → review (no write);
//   * a missing instance discriminator → review; a CONFLICT (an existing alias points elsewhere, or the
//     instance already has a DIFFERENT canonical_app_id) → review, NEVER an overwrite/blind re-merge;
//   * distinct instance_domain / external_instance_id values NEVER collapse — each is its own alias + apps row.
//
// IDEMPOTENT: all writes upsert on NATURAL KEYS — vendor (tenant, normalized_name), product
// (tenant, vendor_id, normalized_name), alias (tenant, alias_type, alias_value; 0026). Re-running the same
// staged fact set adds NO vendor/product/alias rows and does not change canonical_app_id. Arrival order does
// not change the persisted state.
//
// SAFE BY DESIGN: the only DB access is through the INJECTED `CanonicalGraphWriteStore`, backed by the
// authenticated user-scoped (RLS-enforced) client when wired — this module imports NO Supabase client and uses
// NO service-role. Tenant scoping comes from the authenticated `tenantId` + RLS (the write functions do NOTHING
// when there is no authenticated tenant). It NEVER writes `app_user_identity_matches`, NEVER calls a provider,
// NEVER touches tokens/credentials/connector_secrets. Unmerge/repoint REPOINTS (sets canonical_app_id null /
// changes an alias's product) — it NEVER deletes historical users/contracts/invoices.
//
// SERVER-ONLY: under `src/lib/server/`, the runtime browser sentinel below, and `no-client-import.test.ts`.
// Imports only the sibling pure logic (`./resolution`, `./discovery-fact-read`).

import {
  appResolutionSignals,
  explainResolutionDecision,
  type DiscoveryResolutionInput,
} from "./resolution";
import { type StagedDiscoveryFactRow } from "./discovery-fact-read";

// Runtime server-only sentinel — throw if evaluated in a browser.
if (typeof (globalThis as { window?: unknown }).window !== "undefined") {
  throw new Error("connector-vault/resolver-write is server-only and must not be imported in client code");
}

// What a deterministic write resolved to (or why it did not). `wrote` = a deterministic alias/canonical
// assignment was upserted; `review` = left reviewable (probabilistic/ambiguous/conflict/missing instance).
export type ResolverWriteOutcome = "wrote" | "review";

export type ResolverWriteResult = {
  factId: string;
  outcome: ResolverWriteOutcome;
  reason: string;
  appProductId?: string;
  aliasNaturalKey?: { aliasType: string; aliasValue: string };
};

// The deterministic canonical identity extracted from a fact: the vendor/product to group under + the single
// deterministic alias key for the observed instance discriminator.
type DeterministicCanonicalTarget = {
  vendorName: string;
  productName: string;
  aliasType: "instance_domain" | "external_instance_id";
  aliasValue: string; // normalized (trim + lowercase)
};

// The injected WRITE boundary, backed by the authenticated user-scoped (RLS) client when wired — never a
// service-role client. Every method upserts on a NATURAL KEY (idempotent) or repoints; there is intentionally
// NO delete-rows method and NO app_user_identity_matches method here.
export interface CanonicalGraphWriteStore {
  // upsert a vendor on (tenant, normalized_name); returns the existing or new id (no duplicate row on re-run).
  upsertVendor(input: { normalizedName: string; displayName: string }): Promise<{ id: string }>;
  // upsert a product on (tenant, vendor_id, normalized_name); returns the existing or new id.
  upsertAppProduct(input: { vendorId: string; normalizedName: string; displayName: string }): Promise<{ id: string }>;
  // upsert an alias on (tenant, alias_type, alias_value) -> app_product_id. Returns whether a NEW row was
  // created and the product the alias currently resolves to (so a conflict — existing alias to a DIFFERENT
  // product — can be detected and routed to review instead of overwritten).
  upsertAppAlias(input: { aliasType: string; aliasValue: string; appProductId: string }):
    Promise<{ created: boolean; resolvedAppProductId: string }>;
  // find the apps instance row for an observed instance discriminator (within the tenant), or null.
  findAppIdByInstanceKey(input: { aliasType: "instance_domain" | "external_instance_id"; aliasValue: string }):
    Promise<{ appId: string; canonicalAppId: string | null } | null>;
  // set apps.canonical_app_id for a same-tenant instance row (idempotent — same value is a no-op write).
  setAppCanonicalAppId(input: { appId: string; appProductId: string }): Promise<void>;
  // ── unmerge / repoint (non-destructive) ───────────────────────────────────────────────────────────────
  // clear an instance's canonical link (repoint to "unassigned") — NEVER deletes the apps row or its users.
  clearAppCanonicalAppId(input: { appId: string }): Promise<void>;
  // repoint an alias to a different product — NEVER deletes the alias's history.
  repointAppAlias(input: { aliasType: string; aliasValue: string; newAppProductId: string }): Promise<void>;
}

const norm = (v: string | null | undefined): string | null =>
  typeof v === "string" && v.trim().length > 0 ? v.trim().toLowerCase() : null;

const fieldStr = (fact: unknown, key: string): string | null => {
  const f = (fact !== null && typeof fact === "object" ? fact : {}) as Record<string, unknown>;
  return typeof f[key] === "string" ? (f[key] as string) : null;
};

// Map a staged fact's payload to the resolver input (deterministic instance discriminators only).
function rowToResolutionInput(row: StagedDiscoveryFactRow): DiscoveryResolutionInput {
  const f = row.fact_json;
  return {
    instanceDomain: fieldStr(f, "instance_domain"),
    externalInstanceId: fieldStr(f, "external_instance_id"),
    instanceUrl: fieldStr(f, "instance_url"),
    ownerOrgId: fieldStr(f, "owner_org_hint"),
    payingOrgId: fieldStr(f, "paying_org_hint"),
    responsibleOrgId: fieldStr(f, "responsible_org_hint"),
  };
}

// Extract the deterministic canonical target from a fact — REQUIRES a vendor + product name AND a single
// deterministic instance discriminator (instance_domain preferred, else external_instance_id). Returns null
// when any of those is missing (→ the fact stays reviewable; no blind merge by name alone).
function deterministicTarget(row: StagedDiscoveryFactRow): DeterministicCanonicalTarget | null {
  const f = row.fact_json;
  const vendorName = fieldStr(f, "discovered_vendor_name") ?? fieldStr(f, "vendor_name");
  const productName = fieldStr(f, "discovered_product_name") ?? fieldStr(f, "product_name");
  const instanceDomain = norm(fieldStr(f, "instance_domain"));
  const externalInstanceId = norm(fieldStr(f, "external_instance_id"));
  if (vendorName == null || productName == null) return null; // no canonical product without vendor+product
  if (instanceDomain != null) return { vendorName, productName, aliasType: "instance_domain", aliasValue: instanceDomain };
  if (externalInstanceId != null) return { vendorName, productName, aliasType: "external_instance_id", aliasValue: externalInstanceId };
  return null; // deterministic key present (per the resolver) but no instance discriminator to anchor on → review
}

// Resolve ONE staged fact deterministically (or leave it reviewable). Fail closed on every uncertainty.
async function resolveOne(store: CanonicalGraphWriteStore, row: StagedDiscoveryFactRow): Promise<ResolverWriteResult> {
  // 1. the pure resolver gate — ONLY a deterministic decision may auto-write.
  const decision = explainResolutionDecision(appResolutionSignals(rowToResolutionInput(row)));
  if (decision.action !== "auto_assign") {
    return { factId: row.id, outcome: "review", reason: `not deterministic (${decision.confidence})` };
  }
  // 2. a deterministic canonical target (vendor + product + one instance discriminator) is required.
  const target = deterministicTarget(row);
  if (target == null) {
    return { factId: row.id, outcome: "review", reason: "missing vendor/product or instance discriminator" };
  }
  // 3. upsert vendor -> product on natural keys (idempotent; no duplicate rows on re-run).
  const vendor = await store.upsertVendor({ normalizedName: norm(target.vendorName)!, displayName: target.vendorName });
  const product = await store.upsertAppProduct({
    vendorId: vendor.id, normalizedName: norm(target.productName)!, displayName: target.productName,
  });
  // 4. alias upsert on the natural key. A CONFLICT (the deterministic key already resolves to a DIFFERENT
  //    product) is NEVER overwritten — fail closed to review (no blind re-merge).
  const alias = await store.upsertAppAlias({ aliasType: target.aliasType, aliasValue: target.aliasValue, appProductId: product.id });
  if (alias.resolvedAppProductId !== product.id) {
    return { factId: row.id, outcome: "review", reason: "alias natural key already resolves to a different product (conflict)" };
  }
  // 5. set apps.canonical_app_id for the matching instance — ONLY when it exists and is unassigned or already
  //    points at THIS product (a different existing canonical link is a conflict → review, never overwritten).
  const instance = await store.findAppIdByInstanceKey({ aliasType: target.aliasType, aliasValue: target.aliasValue });
  if (instance != null) {
    if (instance.canonicalAppId != null && instance.canonicalAppId !== product.id) {
      return { factId: row.id, outcome: "review", reason: "instance already has a different canonical_app_id (conflict)" };
    }
    await store.setAppCanonicalAppId({ appId: instance.appId, appProductId: product.id });
  }
  return {
    factId: row.id, outcome: "wrote", reason: "deterministic",
    appProductId: product.id, aliasNaturalKey: { aliasType: target.aliasType, aliasValue: target.aliasValue },
  };
}

// Apply deterministic resolution to a set of already-RLS-read staged facts. Tenant scoping comes from the
// authenticated `authTenantId` + the RLS-backed store: with no authenticated tenant this writes NOTHING.
// Idempotent (natural-key upserts) and order-independent.
export async function applyDeterministicResolution(
  store: CanonicalGraphWriteStore,
  authTenantId: string | null | undefined,
  rows: readonly StagedDiscoveryFactRow[],
): Promise<ResolverWriteResult[]> {
  if (typeof authTenantId !== "string" || authTenantId.length === 0) return [];
  const results: ResolverWriteResult[] = [];
  for (const row of rows) results.push(await resolveOne(store, row));
  return results;
}

// ── Unmerge / repoint (non-destructive) ─────────────────────────────────────────────────────────────────

// Revert a deterministic canonical assignment by clearing apps.canonical_app_id (repoint to unassigned). It
// NEVER deletes the apps row, its app_users, contracts, or invoices — it only un-links the canonical pointer.
export async function revertCanonicalAppAssignment(
  store: CanonicalGraphWriteStore,
  authTenantId: string | null | undefined,
  input: { appId: string },
): Promise<{ ok: boolean }> {
  if (typeof authTenantId !== "string" || authTenantId.length === 0) return { ok: false };
  await store.clearAppCanonicalAppId({ appId: input.appId });
  return { ok: true };
}

// Repoint a deterministic alias to a different product (e.g. after a human corrects a grouping). It updates
// the alias's target only — it NEVER deletes the alias or any historical users/contracts/invoices.
export async function repointAppAlias(
  store: CanonicalGraphWriteStore,
  authTenantId: string | null | undefined,
  input: { aliasType: string; aliasValue: string; newAppProductId: string },
): Promise<{ ok: boolean }> {
  if (typeof authTenantId !== "string" || authTenantId.length === 0) return { ok: false };
  await store.repointAppAlias(input);
  return { ok: true };
}
