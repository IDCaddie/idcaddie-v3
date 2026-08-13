import { createClient } from "@/lib/supabase/server";
import {
  normalizeAliasValue,
  resolveCanonicalAlias,
  type AliasResolution,
  type CanonicalAliasRow,
} from "@/lib/canonical/application-alias";

// Phase 18A — the IO half of canonical application-alias resolution. Pure decisions live in
// src/lib/canonical/application-alias.ts; this module only talks to the database.
//
// READ-ONLY. It performs no insert, update, upsert or delete, and there is no product-side path in this codebase that declares a
// canonical alias — see docs/79. An earlier draft of this phase carried one and it was removed in review because it could not
// execute: `directory_applications` is deny-all to `authenticated` (0057 enables RLS and defines NO policy), and the product read
// RPCs deliberately withhold `external_id` (0061: "NEVER external_id"), so product code cannot obtain the identifier a
// declaration would record. Mocked IO had hidden that. Declaration is a deliberate T3 design decision, deferred to Phase 18A2.
//
// Boundary: imports the user-scoped server client (which imports next/headers), so it is server-only — importing it from a Client
// Component fails the build. It NEVER uses a service-role or admin client, NEVER takes a tenant_id from the caller as
// authorization, and adds NO connector_runner authority. `app_aliases` is read under the existing 0024 "members read" RLS policy,
// whose tenant isolation is proven functionally by supabase/tests/org_rls_test.sql (T46) against a real database.
//
// Nothing here touches `application_matches` (0075) or `directory_applications`.

const ALIAS_COLUMNS = "app_product_id, review_status" as const;

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
 * `tenantId` MUST come from trusted server-side context (accessGate / resolveTenantContext); it narrows the query but is not the
 * authority — RLS is, and it applies whatever is passed.
 *
 * Reads ONLY `app_aliases` — never the directory side — so a confirmed canonical judgement keeps resolving after its source
 * directory application goes stale, is superseded, or its connector is disconnected. Provider freshness and canonical judgement
 * are separate facts, and this asymmetry is the reason the resolver has no notion of a source row at all.
 *
 * Returns null only when the read itself failed, which is distinct from `unresolved` (the read succeeded and there is no settled
 * alias). A caller must never treat a failed read as "no canonical product".
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
