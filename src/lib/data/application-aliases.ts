import { createClient } from "@/lib/supabase/server";
import { accessGate } from "./access-repository";
import {
  isDeclarationStatus,
  normalizeAliasValue,
  resolveCanonicalAlias,
  type AliasDeclarationStatus,
  type AliasResolution,
  type CanonicalAliasRow,
} from "@/lib/canonical/application-alias";

// Phase 18A1/18A2 — the IO half of canonical application aliases. Pure decisions live in
// src/lib/canonical/application-alias.ts; this module only talks to the database.
//
// This module NEVER writes a table directly. Resolution is a plain RLS-governed read of `app_aliases`; declaration goes through
// the 0087 SECURITY DEFINER command, because the identifier it keys on is unreachable from here by design —
// `directory_applications` is deny-all to `authenticated` (0057 enables RLS and defines NO policy) and the 0061 read RPCs
// deliberately withhold `external_id`. An earlier draft read that column directly and could not execute at all; mocked IO hid it.
// The 0087 command reads the identifier INSIDE the database and never returns it, so the product declares the relationship
// without ever receiving the value. That preserves 0061 rather than overriding it.
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

/**
 * Declare that a directory application corresponds to a canonical app product.
 *
 * The caller supplies two row ids it already holds; it never supplies — and never receives — the provider identifier. The 0087
 * command resolves `external_id` internally, keys the canonical `app_aliases` judgement on it, and returns a bounded status.
 *
 * Authorization is the command's: it re-verifies owner/admin via `has_tenant_role` against `auth.uid()`. `accessGate()` here
 * resolves the tenant from trusted server context and short-circuits for anyone below owner/admin — it narrows, it does not
 * authorize, and a passed tenant id is verified rather than trusted on the other side.
 */
export async function declareApplicationAlias(
  directoryApplicationId: string,
  appProductId: string,
): Promise<{ ok: true; status: AliasDeclarationStatus } | { ok: false; error: "not_allowed" | "query_failed" }> {
  const gate = await accessGate();
  if (!gate.ok) return { ok: false, error: "not_allowed" };

  const supabase = await createClient();
  const rpc = supabase.rpc.bind(supabase) as unknown as (n: string, a: Record<string, unknown>) => Promise<{ data: unknown; error: unknown }>;
  const { data, error } = await rpc("product_declare_application_alias", {
    p_tenant_id: gate.tenantId,
    p_directory_application_id: directoryApplicationId,
    p_app_product_id: appProductId,
  });
  // The error label is bounded and carries no DB detail — an RPC failure must not disclose whether a row exists.
  if (error) { console.error("[data/application-aliases] declaration rpc failed"); return { ok: false, error: "query_failed" }; }

  // Read ONLY the status key. Even if a future change to the command added a field, nothing else would reach a caller from here.
  const status = (data as { status?: unknown } | null)?.status;
  if (typeof status !== "string" || !isDeclarationStatus(status)) {
    console.error("[data/application-aliases] declaration rpc returned an unrecognised status");
    return { ok: false, error: "query_failed" };
  }
  return { ok: true, status };
}
