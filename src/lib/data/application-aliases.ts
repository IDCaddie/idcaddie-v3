import { createClient } from "@/lib/supabase/server";
import { resolveTenantContext } from "@/lib/auth/tenant-context";
import { getSessionUser } from "@/lib/auth/session";
import { resolveWriteContextTenantId, isUuid } from "./contract-write";
import {
  classifyAliasWriteError,
  isDeclarableAliasType,
  isEligibleDeclarationSource,
  normalizeAliasValue,
  planDeclaration,
  resolveCanonicalAlias,
  type AliasResolution,
  type CanonicalAliasRow,
} from "@/lib/canonical/application-alias";
import type { TablesInsert } from "@/lib/database.types";

// Phase 18A — the IO half of canonical application-alias resolution. Pure decisions live in
// src/lib/canonical/application-alias.ts; this module only talks to the database.
//
// Boundary: imports the user-scoped server client (which imports next/headers), so it is server-only — importing it from a Client
// Component fails the build. It NEVER uses a service-role or admin client, NEVER takes a tenant_id from the caller as
// authorization, and adds NO connector_runner authority. `app_aliases` is a product-side canonical table whose existing 0024 RLS
// policies are the write boundary: members read, owner/admin/editor insert + update, nobody deletes. That is why this phase adds
// no SECURITY DEFINER RPC — a wrapper over an already-governed editor write would catch no failure class RLS does not.
//
// Nothing here touches `application_matches` (0075). Declaring that an identifier IS a product is a different fact from deciding
// that a directory application MATCHES a SaaS app; the latter is Phase 18B/18C.

const ALIAS_COLUMNS = "app_product_id, review_status" as const;

export type AliasDeclarationInput = {
  readonly directoryApplicationId: string;
  readonly appProductId: string;
  readonly aliasType: string;
};

export type AliasDeclarationResult =
  | { readonly ok: true; readonly outcome: "declared" | "unchanged"; readonly aliasValue: string }
  | { readonly ok: false; readonly error: "invalid_input" | "unsupported_alias_type" | "source_not_eligible" | "not_allowed" | "conflict" | "query_failed"; readonly reason?: string };

async function readAlias(tenantId: string, aliasType: string, aliasValue: string): Promise<{ ok: true; row: CanonicalAliasRow | null } | { ok: false }> {
  const supabase = await createClient();
  // `maybeSingle` because the 0026 natural key UNIQUE(tenant_id, alias_type, alias_value) guarantees at most one row. RLS scopes
  // the read to the caller's tenant, so `tenant_id` here narrows an already-safe query rather than providing the authority.
  const { data, error } = await supabase
    .from("app_aliases")
    .select(ALIAS_COLUMNS)
    .eq("tenant_id", tenantId)
    .eq("alias_type", aliasType)
    .eq("alias_value", aliasValue)
    .maybeSingle();
  if (error) { console.error("[data/application-aliases] alias read failed"); return { ok: false }; }
  return { ok: true, row: data ? { appProductId: data.app_product_id, reviewStatus: data.review_status } : null };
}

/**
 * Resolve a deterministic identifier to its canonical product. Read-only.
 *
 * Reads ONLY `app_aliases` — never the directory side — so a confirmed canonical judgement keeps resolving after its source
 * directory application goes stale or its connector is disconnected. Provider freshness and canonical judgement are separate facts.
 */
export async function resolveApplicationAlias(tenantId: string, aliasType: string, aliasValue: string): Promise<AliasResolution | null> {
  const value = normalizeAliasValue(aliasValue);
  // Refuse an unsupported type (notably 'name') BEFORE querying: there is no circumstance in which a name lookup should reach the
  // database, and a short-circuit means the forbidden path cannot exist even as a wasted round trip.
  const gate = resolveCanonicalAlias(aliasType, null);
  if (gate.outcome === "unsupported") return gate;
  if (value === "") return { outcome: "unresolved" };

  const r = await readAlias(tenantId, aliasType, value);
  if (!r.ok) return null;
  return resolveCanonicalAlias(aliasType, r.row);
}

/**
 * Declare that a directory application's provider identifier IS a canonical app product.
 *
 * The tenant is resolved SERVER-SIDE from the actor's context and is never accepted from the caller. The identifier is likewise
 * never accepted from the caller: it is read out of the directory application row, so a caller cannot submit a forged or foreign
 * provider id and have it recorded as evidence. A directory application in another tenant is invisible to RLS, so it reads as
 * absent and is refused without disclosing that it exists.
 *
 * Authorization is RLS's: this function does not pre-check the actor's role. A member without editor+ is rejected by the 0024
 * WITH CHECK and mapped to `not_allowed`, and the same-tenant composite FK on app_product_id is the database's final backstop.
 */
export async function declareApplicationAlias(input: AliasDeclarationInput): Promise<AliasDeclarationResult> {
  if (!isDeclarableAliasType(input.aliasType)) return { ok: false, error: "unsupported_alias_type" };
  if (!isUuid(input.directoryApplicationId) || !isUuid(input.appProductId)) return { ok: false, error: "invalid_input" };

  const context = await resolveTenantContext();
  const tenantId = context ? resolveWriteContextTenantId(context) : null;
  if (!tenantId) return { ok: false, error: "not_allowed" };

  const supabase = await createClient();

  // The identifier comes from the row, not the request. RLS scopes this read to the caller's tenant.
  const { data: source, error: sourceError } = await supabase
    .from("directory_applications")
    .select("external_id, provider, sync_status")
    .eq("id", input.directoryApplicationId)
    .eq("tenant_id", tenantId)
    .maybeSingle();
  if (sourceError) { console.error("[data/application-aliases] source read failed"); return { ok: false, error: "query_failed" }; }
  if (!source) return { ok: false, error: "not_allowed" };
  if (!isEligibleDeclarationSource(source.sync_status)) return { ok: false, error: "source_not_eligible" };

  const aliasValue = normalizeAliasValue(source.external_id);
  if (aliasValue === "") return { ok: false, error: "invalid_input" };

  const existing = await readAlias(tenantId, input.aliasType, aliasValue);
  if (!existing.ok) return { ok: false, error: "query_failed" };
  const plan = planDeclaration(existing.row, input.appProductId);
  if (plan.action === "unchanged") return { ok: true, outcome: "unchanged", aliasValue };
  if (plan.action === "conflict") return { ok: false, error: "conflict", reason: plan.reason };

  const user = await getSessionUser();
  const payload: TablesInsert<"app_aliases"> = {
    tenant_id: tenantId,
    alias_type: input.aliasType,
    alias_value: aliasValue,
    app_product_id: input.appProductId,
    // `app_id` stays null: the evidence came from the directory side, not from an operational `apps` instance.
    review_status: "confirmed",   // an editor asserting this IS the product is the review, not a proposal awaiting one
    reviewed_by: user?.id ?? null,
    reviewed_at: new Date().toISOString(),
    confidence: 100,              // exact identifier equality declared by a human — the 0..100 scale's ceiling
    source: source.provider,      // opaque provenance string; never branched on
  };

  const { error } = await supabase.from("app_aliases").insert(payload);
  if (error) {
    const classified = classifyAliasWriteError(error.code);
    // A unique violation means a concurrent writer took the natural key between the read and the insert. Re-read and re-decide
    // rather than reporting a conflict that may not be one — if they wrote the same product, this call is still idempotent.
    if (classified === "conflict") {
      const after = await readAlias(tenantId, input.aliasType, aliasValue);
      if (after.ok && planDeclaration(after.row, input.appProductId).action === "unchanged") {
        return { ok: true, outcome: "unchanged", aliasValue };
      }
      return { ok: false, error: "conflict", reason: "different_product" };
    }
    console.error("[data/application-aliases] alias write rejected");
    return { ok: false, error: classified };
  }
  return { ok: true, outcome: "declared", aliasValue };
}
