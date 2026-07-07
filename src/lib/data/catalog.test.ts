import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// The catalog DAL reads three RLS-scoped tables and must project ONLY safe columns — the cross-tenant denial is
// enforced by RLS (0024 members-read); this covers the projection wiring and fail-closed behavior.
const createClient = vi.fn();
vi.mock("@/lib/supabase/server", () => ({ createClient: () => createClient() }));

import { listCatalogForCurrentUser, getCatalogMappingForApp } from "./catalog";

type TableData = { data: unknown[] | null; error: unknown };
function makeSupabase(byTable: Record<string, TableData>) {
  const query = (table: string) => {
    const result = byTable[table] ?? { data: [], error: null };
    const p = Promise.resolve(result);
    return { order: () => p, then: (...a: Parameters<Promise<TableData>["then"]>) => p.then(...a) };
  };
  return { from: (table: string) => ({ select: () => query(table) }) };
}
beforeEach(() => createClient.mockReset());

describe("listCatalogForCurrentUser", () => {
  it("maps to safe DTOs and DROPS every sensitive column even if the DB returns it", async () => {
    createClient.mockResolvedValue(
      makeSupabase({
        vendors: { data: [{ id: "v1", name: "Atlassian", website_domain: "atlassian.com", normalized_name: "atlassian", source: "okta", tenant_id: "t1" }], error: null },
        app_products: { data: [{ id: "p1", vendor_id: "v1", name: "Jira", category: "PM", normalized_name: "jira", source: "okta", tenant_id: "t1" }], error: null },
        app_aliases: { data: [{ id: "a1", app_product_id: "p1", app_id: "app1", alias_type: "domain", alias_value: "jira.example.com", review_status: "pending", confidence: 90, reviewed_by: "u1", reviewed_at: "t", provenance: { secret: 1 }, source: "okta", tenant_id: "t1" }], error: null },
      }),
    );
    const res = await listCatalogForCurrentUser();
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.vendors).toEqual([{ id: "v1", name: "Atlassian", websiteDomain: "atlassian.com" }]);
    expect(res.data.products).toEqual([{ id: "p1", vendorId: "v1", name: "Jira", category: "PM" }]);
    expect(res.data.aliases).toEqual([{ id: "a1", productId: "p1", aliasType: "domain", aliasValue: "jira.example.com", reviewStatus: "pending", confidence: 90 }]);
    // No sensitive column survives the projection.
    const keys = [...Object.keys(res.data.vendors[0]), ...Object.keys(res.data.products[0]), ...Object.keys(res.data.aliases[0])];
    for (const f of ["normalized_name", "source", "provenance", "reviewed_by", "reviewed_at", "tenant_id", "app_id"]) {
      expect(keys, `DTO must not expose ${f}`).not.toContain(f);
    }
  });

  it("fails closed to query_failed when any read errors", async () => {
    createClient.mockResolvedValue(makeSupabase({ vendors: { data: null, error: { message: "boom" } } }));
    expect(await listCatalogForCurrentUser()).toEqual({ ok: false, error: "query_failed" });
  });

  it("empty tables → ok:true with empty arrays", async () => {
    createClient.mockResolvedValue(makeSupabase({ vendors: { data: [], error: null }, app_products: { data: [], error: null }, app_aliases: { data: [], error: null } }));
    expect(await listCatalogForCurrentUser()).toEqual({ ok: true, data: { vendors: [], products: [], aliases: [] } });
  });

  it("the DAL source selects no sensitive/forbidden column (comments stripped)", () => {
    const code = readFileSync(join(__dirname, "catalog.ts"), "utf8").replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
    for (const f of ["normalized_name", "provenance", "reviewed_by", "reviewed_at", "fact_json", "connector_secrets", "discovery_facts", "SERVICE_ROLE"]) {
      expect(code, `catalog.ts must not reference ${f}`).not.toContain(f);
    }
  });
});

// `.select().eq().maybeSingle()` (apps/products/vendors single reads) AND `.select().eq()` (awaitable alias
// list) resolve to the configured per-table result.
function mappingSupabase(byTable: Record<string, { data: unknown; error: unknown }>) {
  const from = (table: string) => {
    const r = byTable[table] ?? { data: null, error: null };
    const p = Promise.resolve(r);
    const eqResult = { maybeSingle: () => p, then: (...a: Parameters<Promise<typeof r>["then"]>) => p.then(...a) };
    return { select: () => ({ eq: () => eqResult }) };
  };
  return { from };
}

describe("getCatalogMappingForApp", () => {
  it("returns a mapped product with safe display fields only (no raw ids)", async () => {
    createClient.mockResolvedValue(
      mappingSupabase({
        apps: { data: { canonical_app_id: "prod-uuid" }, error: null },
        app_products: { data: { name: "Confluence", category: "Docs", vendor_id: "vend-uuid" }, error: null },
        vendors: { data: { name: "Atlassian" }, error: null },
        app_aliases: { data: [{ id: "a1" }, { id: "a2" }, { id: "a3" }], error: null },
      }),
    );
    const res = await getCatalogMappingForApp("app1");
    expect(res).toEqual({ ok: true, data: { mapped: true, productName: "Confluence", vendorName: "Atlassian", category: "Docs", aliasCount: 3 } });
    if (res.ok && res.data.mapped) {
      for (const f of ["canonical_app_id", "vendor_id", "tenant_id", "id", "normalized_name", "provenance"]) {
        expect(Object.keys(res.data), `mapping DTO must not expose ${f}`).not.toContain(f);
      }
    }
  });

  it("no canonical_app_id → unmapped", async () => {
    createClient.mockResolvedValue(mappingSupabase({ apps: { data: { canonical_app_id: null }, error: null } }));
    expect(await getCatalogMappingForApp("app1")).toEqual({ ok: true, data: { mapped: false } });
  });

  it("canonical product hidden/missing (RLS or deleted) → unmapped, no id leak", async () => {
    createClient.mockResolvedValue(
      mappingSupabase({ apps: { data: { canonical_app_id: "prod-x" }, error: null }, app_products: { data: null, error: null } }),
    );
    expect(await getCatalogMappingForApp("app1")).toEqual({ ok: true, data: { mapped: false } });
  });

  it("a read error fails closed to query_failed", async () => {
    createClient.mockResolvedValue(mappingSupabase({ apps: { data: null, error: { message: "boom" } } }));
    expect(await getCatalogMappingForApp("app1")).toEqual({ ok: false, error: "query_failed" });
  });

  it("a product with no vendor → mapped with vendorName null", async () => {
    createClient.mockResolvedValue(
      mappingSupabase({
        apps: { data: { canonical_app_id: "prod-uuid" }, error: null },
        app_products: { data: { name: "Orphan", category: null, vendor_id: null }, error: null },
        app_aliases: { data: [], error: null },
      }),
    );
    expect(await getCatalogMappingForApp("app1")).toEqual({ ok: true, data: { mapped: true, productName: "Orphan", vendorName: null, category: null, aliasCount: 0 } });
  });
});
