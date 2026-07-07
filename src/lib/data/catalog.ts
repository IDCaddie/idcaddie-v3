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

// Whether one app is mapped to a canonical product, with SAFE display fields only (never a raw id). `appId`
// is a lookup key; apps.canonical_app_id / app_products / vendors / app_aliases are all RLS-scoped. Any read
// error fails closed; a hidden/missing canonical product (RLS or deleted) is treated as unmapped (fail safe,
// no id leak). This is self-contained here so the apps DAL / AppDetail DTO carry no catalog id.
export type CatalogMapping =
  | { mapped: false }
  | { mapped: true; productName: string; vendorName: string | null; category: string | null; aliasCount: number };

export async function getCatalogMappingForApp(appId: string): Promise<DataResult<CatalogMapping>> {
  const supabase = await createClient();

  const { data: app, error: appErr } = await supabase
    .from("apps")
    .select("canonical_app_id")
    .eq("id", appId)
    .maybeSingle();
  if (appErr) {
    console.error("[data/catalog] mapping app read failed");
    return { ok: false, error: "query_failed" };
  }
  const canonicalId: string | null = app?.canonical_app_id ?? null;
  if (!canonicalId) return { ok: true, data: { mapped: false } };

  const { data: product, error: pErr } = await supabase
    .from("app_products")
    .select("name, category, vendor_id")
    .eq("id", canonicalId)
    .maybeSingle();
  if (pErr) {
    console.error("[data/catalog] mapping product read failed");
    return { ok: false, error: "query_failed" };
  }
  if (!product) return { ok: true, data: { mapped: false } };

  let vendorName: string | null = null;
  if (product.vendor_id) {
    const { data: vendor, error: vErr } = await supabase
      .from("vendors")
      .select("name")
      .eq("id", product.vendor_id)
      .maybeSingle();
    if (vErr) {
      console.error("[data/catalog] mapping vendor read failed");
      return { ok: false, error: "query_failed" };
    }
    vendorName = vendor?.name ?? null;
  }

  const { data: aliasRows, error: aErr } = await supabase
    .from("app_aliases")
    .select("id")
    .eq("app_product_id", canonicalId);
  if (aErr) {
    console.error("[data/catalog] mapping alias count failed");
    return { ok: false, error: "query_failed" };
  }

  return {
    ok: true,
    data: { mapped: true, productName: product.name, vendorName, category: product.category, aliasCount: (aliasRows ?? []).length },
  };
}
