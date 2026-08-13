import { createClient } from "@/lib/supabase/server";
import { resolveCanonicalAlias } from "@/lib/canonical/application-alias";
import {
  APP_IDENTITY_ALIAS_TYPE, appIdentifier, decideCanonicalLink, decisionToStatus, normalizeProductName,
  type AppIdentityRow, type CanonicalizationStatus,
} from "@/lib/canonical/app-canonicalization";

// Phase 18B0 — the IO half: the first writer the canonical product layer has ever had.
//
// SERVER-ONLY. Every call uses the user-scoped, cookie-bound, RLS-governed client — never service-role, and no SECURITY DEFINER
// function is added by this phase. That is a finding, not a shortcut: all three writes are already reachable under existing
// policy, so inventing a privileged layer would add a trust boundary the problem does not have.
//
//   app_products   INSERT  owner/admin/editor        0024 "editors manage app_products"
//   app_aliases    INSERT  owner/admin/editor        0024 "editors manage app_aliases"
//   apps           UPDATE  owner/admin/editor        0004 "editors update apps"
//   apps           SELECT  any tenant member         0001 "members read apps"
//   app_aliases    SELECT  any tenant member         0024 "members read app_aliases"
//
// Same-tenant integrity is STRUCTURAL, not checked here: `apps_canonical_app_same_tenant` (0024) is a composite FK on
// (canonical_app_id, tenant_id) -> app_products(id, tenant_id), so an app can only ever be grouped under a product in its own
// tenant — even if this code were wrong. `app_aliases_product_same_tenant` does the same for the alias. RLS decides visibility;
// the composite FKs decide integrity; this module decides nothing about authority.
//
// ══ THREE ACTIONS, KEPT SEPARATE ════════════════════════════════════════════════════════════════════════════════════════════
//   1. createCanonicalProduct   a HUMAN asserts a canonical product exists
//   2. declareAppAlias          a HUMAN asserts this app's provider identifier IS that product
//   3. canonicalizeApp          the RESOLVER links the app, deterministically, from the confirmed alias
//
// They are not collapsed because the evidence does not prove all three at once. Connector sync observing a workspace called
// "Slack" is evidence that an instance exists — it is NOT evidence about canonical product identity, and (1) and (2) are
// therefore human judgements. Only (3) is derivable, and only from an alias a human already confirmed.

export type CanonicalizationError = "not_allowed" | "query_failed";
type Result<T> = { readonly ok: true; readonly data: T } | { readonly ok: false; readonly error: CanonicalizationError };

// PostgREST codes we can safely distinguish. 42501 is an RLS refusal; 23503/23505/23514 are the composite FK, the natural key
// and the CHECKs — all of which a caller reaching this point has already been told about, so they collapse into the same
// bounded label rather than disclosing which row exists.
const classify = (code: unknown): CanonicalizationError =>
  code === "42501" || code === "23503" || code === "23505" || code === "23514" ? "not_allowed" : "query_failed";

const codeOf = (e: unknown): unknown => (e as { code?: unknown } | null)?.code;

// ── 1. CREATE CANONICAL PRODUCT — a human judgement, never derived from connector evidence ──────────────────────────────────
/**
 * Create a canonical product.
 *
 * Deliberately takes a NAME from a person rather than deriving one from an app row. A connector seeing a workspace named
 * "Slack" proves an instance exists; it proves nothing about which canonical product that instance belongs to, and turning
 * observed display metadata into canonical truth is exactly the failure the whole alias model exists to prevent.
 *
 * `normalized_name` is this table's own per-tenant dedup key (UNIQUE(tenant_id, vendor_id, normalized_name)), so entering the
 * same label twice collides instead of silently creating a second canonical identity for one product.
 */
export async function createCanonicalProduct(
  tenantId: string, name: string, vendorId: string | null = null,
): Promise<Result<{ readonly appProductId: string }>> {
  const trimmed = name.trim();
  if (trimmed === "") return { ok: false, error: "not_allowed" };

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("app_products")
    .insert({
      tenant_id: tenantId, name: trimmed, normalized_name: normalizeProductName(trimmed),
      vendor_id: vendorId, source: "product_declaration",
    })
    .select("id")
    .single();

  if (error || !data) {
    console.error("[data/app-canonicalization] create product rejected");
    return { ok: false, error: classify(codeOf(error)) };
  }
  return { ok: true, data: { appProductId: data.id } };
}

// ── 2. DECLARE THE ALIAS — this app's provider identifier IS that product ───────────────────────────────────────────────────
/**
 * Record the confirmed canonical alias for an app's deterministic identifier.
 *
 * The apps-side counterpart of the 0087 command, and deliberately NOT that command: 0087 exists because
 * `directory_applications` is deny-all and its `external_id` is unreachable from the product, so it needs SECURITY DEFINER to
 * read the identifier inside the database. `apps` carries a plain "members read" policy (0001), so its `external_instance_id`
 * is already lawfully readable and no privileged wrapper is warranted. Overloading 0087 to cover a second, differently-governed
 * source would hide that difference.
 *
 * `confirmed` because a person calling this IS the review — Phase 18A1 resolves only `confirmed`, so writing `pending` would
 * record a judgement nothing can use.
 */
export async function declareAppAlias(
  tenantId: string, appId: string, appProductId: string,
): Promise<Result<{ readonly status: "declared" | "no_identifier" }>> {
  const supabase = await createClient();

  const { data: app, error: appErr } = await supabase
    .from("apps")
    .select("id, external_instance_id, canonical_app_id")
    .eq("id", appId)
    .maybeSingle();
  if (appErr) {
    console.error("[data/app-canonicalization] app read failed");
    return { ok: false, error: "query_failed" };
  }
  // An app RLS hides is indistinguishable from one that does not exist.
  if (!app) return { ok: false, error: "not_allowed" };

  const identifier = appIdentifier({ externalInstanceId: app.external_instance_id });
  if (identifier === null) return { ok: true, data: { status: "no_identifier" } };

  const { error } = await supabase.from("app_aliases").insert({
    tenant_id: tenantId, app_product_id: appProductId, app_id: app.id,
    alias_type: APP_IDENTITY_ALIAS_TYPE, alias_value: identifier,
    source: "product_declaration", confidence: 100, review_status: "confirmed", reviewed_at: new Date().toISOString(),
  });
  if (error) {
    // Includes the 0026 natural-key collision: this identifier already carries a judgement. Never overwritten here.
    console.error("[data/app-canonicalization] alias declaration rejected");
    return { ok: false, error: classify(codeOf(error)) };
  }
  return { ok: true, data: { status: "declared" } };
}

// ── 3. CANONICALIZE — the deterministic part, and the only derived one ──────────────────────────────────────────────────────
/**
 * Link one app to the canonical product its confirmed alias resolves to.
 *
 * Reads no name and compares no label. The identifier goes to the 0026 natural key, at most one alias row comes back, and the
 * Phase 18A1 resolver decides whether that row is settled enough to act on — `confirmed` only, never `pending`, `rejected` or
 * `auto`, and never a `name` alias.
 *
 * A DIFFERENT existing `canonical_app_id` is a conflict and is never overwritten. Repointing an app to another product is a
 * deliberate act of identity revision (0024: the resolver "unmerges by repointing … never by rewriting history"), not something
 * a resolve should do silently on the way past.
 */
export async function canonicalizeApp(
  tenantId: string, appId: string,
): Promise<Result<{ readonly status: CanonicalizationStatus }>> {
  const supabase = await createClient();

  const { data: appRow, error: appErr } = await supabase
    .from("apps")
    .select("id, external_instance_id, canonical_app_id")
    .eq("id", appId)
    .maybeSingle();
  if (appErr) {
    console.error("[data/app-canonicalization] app read failed");
    return { ok: false, error: "query_failed" };
  }
  if (!appRow) return { ok: false, error: "not_allowed" };

  const app: AppIdentityRow = {
    id: appRow.id, externalInstanceId: appRow.external_instance_id, canonicalAppId: appRow.canonical_app_id,
  };

  const identifier = appIdentifier(app);
  let resolvedAppProductId: string | null = null;
  if (identifier !== null) {
    // At most one row: the 0026 natural key is UNIQUE(tenant_id, alias_type, alias_value). Ambiguity is represented by the
    // ABSENCE of a row, never by several — so this is a single answer, not a candidate list.
    const { data: alias, error: aliasErr } = await supabase
      .from("app_aliases")
      .select("app_product_id, review_status")
      .eq("tenant_id", tenantId)
      .eq("alias_type", APP_IDENTITY_ALIAS_TYPE)
      .eq("alias_value", identifier)
      .maybeSingle();
    if (aliasErr) {
      console.error("[data/app-canonicalization] alias read failed");
      return { ok: false, error: "query_failed" };
    }
    const resolution = resolveCanonicalAlias(
      APP_IDENTITY_ALIAS_TYPE,
      alias ? { appProductId: alias.app_product_id, reviewStatus: alias.review_status } : null,
    );
    resolvedAppProductId = resolution.outcome === "resolved" ? resolution.appProductId : null;
  }

  const decision = decideCanonicalLink({ app, resolvedAppProductId });
  if (decision.action !== "link") return { ok: true, data: { status: decisionToStatus(decision) } };

  // Guarded on the CURRENT value so two concurrent resolves cannot fight: the second finds canonical_app_id already set and
  // matches zero rows, then re-reads to report the settled answer rather than asserting one.
  const { data: updated, error: updErr } = await supabase
    .from("apps")
    .update({ canonical_app_id: decision.appProductId })
    .eq("id", app.id)
    .is("canonical_app_id", null)
    .select("id");
  if (updErr) {
    console.error("[data/app-canonicalization] canonical link rejected");
    return { ok: false, error: classify(codeOf(updErr)) };
  }
  if (!updated || updated.length === 0) {
    const { data: after } = await supabase.from("apps").select("canonical_app_id").eq("id", app.id).maybeSingle();
    const settled = after?.canonical_app_id ?? null;
    if (settled === decision.appProductId) return { ok: true, data: { status: "already_linked" } };
    // Either another writer won with a different product, or RLS refused the update. Both are "not this call's answer".
    return { ok: true, data: { status: settled === null ? "no_confirmed_alias" : "conflict" } };
  }
  return { ok: true, data: { status: "linked" } };
}
