import { createClient } from "@/lib/supabase/server";

// Server-only, READ-ONLY access to the canonical app graph (vendors → app_products → app_aliases). Same
// discipline as the other DALs: user-scoped anon client (NEVER service-role), NO caller-supplied tenant_id —
// RLS is the sole authorization boundary (migration 0024 `members read` SELECT policies). EXPLICIT safe column
// lists only: normalized_name, source, provenance, reviewed_by, reviewed_at, tenant_id, and app_id are NEVER
// read into the DTO. review_status (a bounded enum) is safe and already tells you whether an alias was reviewed,
// so reviewed_by is not read at all.
export type DataResult<T> = { ok: true; data: T } | { ok: false; error: "query_failed" };

export type CatalogVendor = { id: string; name: string; websiteDomain: string | null };
export type CatalogProduct = { id: string; vendorId: string | null; name: string; category: string | null };
export type CatalogAlias = {
  id: string;
  productId: string;
  aliasType: string;
  aliasValue: string;
  reviewStatus: string;
  confidence: number | null;
};
export type CatalogView = { vendors: CatalogVendor[]; products: CatalogProduct[]; aliases: CatalogAlias[] };

// Three RLS-scoped reads (no joins, no tenant filter). Fails closed: any read error → query_failed.
export async function listCatalogForCurrentUser(): Promise<DataResult<CatalogView>> {
  const supabase = await createClient();

  const { data: vendors, error: vErr } = await supabase
    .from("vendors")
    .select("id, name, website_domain")
    .order("name", { ascending: true });
  if (vErr) {
    console.error("[data/catalog] vendors query failed");
    return { ok: false, error: "query_failed" };
  }

  const { data: products, error: pErr } = await supabase
    .from("app_products")
    .select("id, vendor_id, name, category")
    .order("name", { ascending: true });
  if (pErr) {
    console.error("[data/catalog] app_products query failed");
    return { ok: false, error: "query_failed" };
  }

  const { data: aliases, error: aErr } = await supabase
    .from("app_aliases")
    .select("id, app_product_id, alias_type, alias_value, review_status, confidence")
    .order("alias_value", { ascending: true });
  if (aErr) {
    console.error("[data/catalog] app_aliases query failed");
    return { ok: false, error: "query_failed" };
  }

  return {
    ok: true,
    data: {
      vendors: (vendors ?? []).map((v) => ({ id: v.id, name: v.name, websiteDomain: v.website_domain })),
      products: (products ?? []).map((p) => ({ id: p.id, vendorId: p.vendor_id, name: p.name, category: p.category })),
      aliases: (aliases ?? []).map((a) => ({
        id: a.id,
        productId: a.app_product_id,
        aliasType: a.alias_type,
        aliasValue: a.alias_value,
        reviewStatus: a.review_status,
        confidence: a.confidence,
      })),
    },
  };
}
