// Pure, server-safe grouping/search/filter/summary for the read-only App Catalog. NO DB access — operates on
// the already-fetched, RLS-scoped CatalogView. Ids are structural keys only (never rendered as data); no
// secrets, no excluded columns. Unit-testable with plain fixtures.
import type { CatalogView, CatalogVendor, CatalogProduct, CatalogAlias } from "./catalog";

export type GroupedProduct = CatalogProduct & { aliases: CatalogAlias[]; aliasCount: number };
export type GroupedVendor = {
  id: string | null; // null = the synthetic "No vendor" bucket
  name: string;
  websiteDomain: string | null;
  products: GroupedProduct[];
  productCount: number;
  aliasCount: number;
};
export type CatalogFilter = "vendors_with_products" | "products_with_aliases" | "products_without_aliases";

export const CATALOG_FILTERS: readonly CatalogFilter[] = [
  "vendors_with_products",
  "products_with_aliases",
  "products_without_aliases",
];
export function isCatalogFilter(v: string): v is CatalogFilter {
  return (CATALOG_FILTERS as readonly string[]).includes(v);
}

const NO_VENDOR = "__no_vendor__";
const REVIEW_STATUSES = ["pending", "confirmed", "rejected", "auto"] as const;

export function summarizeCatalog(view: CatalogView) {
  const aliasesByReviewStatus: Record<string, number> = { pending: 0, confirmed: 0, rejected: 0, auto: 0 };
  for (const a of view.aliases) {
    if ((REVIEW_STATUSES as readonly string[]).includes(a.reviewStatus)) aliasesByReviewStatus[a.reviewStatus]++;
  }
  return {
    vendorCount: view.vendors.length,
    productCount: view.products.length,
    aliasCount: view.aliases.length,
    aliasesByReviewStatus,
  };
}

// Group products under their vendor (null vendor → a "No vendor" bucket), attach aliases, then apply the
// search text + one filter. Returns vendor groups sorted by name (No vendor last).
export function buildCatalog(view: CatalogView, opts: { q?: string; filter?: CatalogFilter } = {}): GroupedVendor[] {
  const q = (opts.q ?? "").trim().toLowerCase();

  const aliasesByProduct = new Map<string, CatalogAlias[]>();
  for (const a of view.aliases) {
    const arr = aliasesByProduct.get(a.productId) ?? [];
    arr.push(a);
    aliasesByProduct.set(a.productId, arr);
  }

  const vendorById = new Map<string, CatalogVendor>(view.vendors.map((v) => [v.id, v]));
  const productsByVendor = new Map<string, GroupedProduct[]>();
  for (const p of view.products) {
    const aliases = aliasesByProduct.get(p.id) ?? [];
    const gp: GroupedProduct = { ...p, aliases, aliasCount: aliases.length };
    const key = p.vendorId ?? NO_VENDOR;
    const arr = productsByVendor.get(key) ?? [];
    arr.push(gp);
    productsByVendor.set(key, arr);
  }

  const productMatchesQ = (gp: GroupedProduct) =>
    gp.name.toLowerCase().includes(q) || gp.aliases.some((a) => a.aliasValue.toLowerCase().includes(q));

  const keys = [...new Set<string>([...view.vendors.map((v) => v.id), ...productsByVendor.keys()])];
  const groups: GroupedVendor[] = [];
  for (const key of keys) {
    const v = key === NO_VENDOR ? null : vendorById.get(key);
    if (key !== NO_VENDOR && !v) continue; // a product's vendor row the user cannot read (RLS) — skip
    const vendorMatchesQ = !!q && !!v && v.name.toLowerCase().includes(q);

    let products = productsByVendor.get(key) ?? [];
    // search: a matching vendor name keeps all its products; otherwise keep only products matching q
    if (q && !vendorMatchesQ) products = products.filter(productMatchesQ);
    // one filter at a time
    if (opts.filter === "products_with_aliases") products = products.filter((p) => p.aliasCount > 0);
    else if (opts.filter === "products_without_aliases") products = products.filter((p) => p.aliasCount === 0);

    products = [...products].sort((a, b) => a.name.localeCompare(b.name));
    const group: GroupedVendor = {
      id: v?.id ?? null,
      name: v ? v.name : "No vendor",
      websiteDomain: v?.websiteDomain ?? null,
      products,
      productCount: products.length,
      aliasCount: products.reduce((n, p) => n + p.aliasCount, 0),
    };

    const keep =
      opts.filter === "vendors_with_products" ||
      opts.filter === "products_with_aliases" ||
      opts.filter === "products_without_aliases"
        ? group.productCount > 0
        : q
          ? group.productCount > 0 || vendorMatchesQ
          : true;
    if (keep) groups.push(group);
  }

  return groups.sort((a, b) => (a.id === null ? 1 : b.id === null ? -1 : a.name.localeCompare(b.name)));
}
