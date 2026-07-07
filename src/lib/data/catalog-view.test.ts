import { describe, it, expect } from "vitest";
import { buildCatalog, summarizeCatalog } from "./catalog-view";
import type { CatalogView } from "./catalog";

// v1 Atlassian → Jira(2 aliases), Confluence(0); v2 Zoom → Zoom Meetings(1 alias); v3 Empty Vendor → none;
// no-vendor → Orphan Tool(0).
const view: CatalogView = {
  vendors: [
    { id: "v1", name: "Atlassian", websiteDomain: "atlassian.com" },
    { id: "v2", name: "Zoom", websiteDomain: null },
    { id: "v3", name: "Empty Vendor", websiteDomain: null },
  ],
  products: [
    { id: "p1", vendorId: "v1", name: "Jira", category: "PM" },
    { id: "p2", vendorId: "v1", name: "Confluence", category: "Docs" },
    { id: "p3", vendorId: "v2", name: "Zoom Meetings", category: "Comms" },
    { id: "p4", vendorId: null, name: "Orphan Tool", category: null },
  ],
  aliases: [
    { id: "a1", productId: "p1", aliasType: "domain", aliasValue: "jira.example.com", reviewStatus: "pending", confidence: 90 },
    { id: "a2", productId: "p1", aliasType: "name", aliasValue: "JIRA Cloud", reviewStatus: "confirmed", confidence: null },
    { id: "a3", productId: "p3", aliasType: "domain", aliasValue: "zoom.us", reviewStatus: "auto", confidence: 80 },
  ],
};

describe("summarizeCatalog", () => {
  it("counts vendors/products/aliases + aliases by review status", () => {
    expect(summarizeCatalog(view)).toEqual({
      vendorCount: 3,
      productCount: 4,
      aliasCount: 3,
      aliasesByReviewStatus: { pending: 1, confirmed: 1, rejected: 0, auto: 1 },
    });
  });
  it("empty view → all zeros", () => {
    expect(summarizeCatalog({ vendors: [], products: [], aliases: [] }).aliasCount).toBe(0);
  });
});

describe("buildCatalog grouping", () => {
  it("groups products under vendors, adds a No-vendor bucket last, and tallies alias counts", () => {
    const groups = buildCatalog(view);
    expect(groups.map((g) => g.name)).toEqual(["Atlassian", "Empty Vendor", "Zoom", "No vendor"]);
    const atl = groups.find((g) => g.name === "Atlassian")!;
    expect(atl.productCount).toBe(2);
    expect(atl.aliasCount).toBe(2);
    expect(atl.products.map((p) => p.name)).toEqual(["Confluence", "Jira"]); // sorted
    expect(atl.products.find((p) => p.name === "Jira")!.aliasCount).toBe(2);
    expect(groups.find((g) => g.id === null)!.name).toBe("No vendor");
  });
});

describe("buildCatalog search", () => {
  it("matches product name and keeps only the matching product", () => {
    const g = buildCatalog(view, { q: "jira" });
    expect(g.map((x) => x.name)).toEqual(["Atlassian"]);
    expect(g[0].products.map((p) => p.name)).toEqual(["Jira"]);
  });
  it("matches an alias value", () => {
    const g = buildCatalog(view, { q: "zoom.us" });
    expect(g.map((x) => x.name)).toEqual(["Zoom"]);
    expect(g[0].products.map((p) => p.name)).toEqual(["Zoom Meetings"]);
  });
  it("a vendor-name match keeps all of that vendor's products", () => {
    const g = buildCatalog(view, { q: "atlassian" });
    expect(g.map((x) => x.name)).toEqual(["Atlassian"]);
    expect(g[0].products.map((p) => p.name)).toEqual(["Confluence", "Jira"]);
  });
});

describe("buildCatalog filters", () => {
  it("vendors_with_products drops the empty vendor", () => {
    expect(buildCatalog(view, { filter: "vendors_with_products" }).map((g) => g.name)).toEqual(["Atlassian", "Zoom", "No vendor"]);
  });
  it("products_with_aliases keeps only aliased products (and their vendors)", () => {
    const g = buildCatalog(view, { filter: "products_with_aliases" });
    expect(g.map((x) => x.name)).toEqual(["Atlassian", "Zoom"]);
    expect(g.find((x) => x.name === "Atlassian")!.products.map((p) => p.name)).toEqual(["Jira"]);
  });
  it("products_without_aliases keeps only alias-free products", () => {
    const g = buildCatalog(view, { filter: "products_without_aliases" });
    expect(g.map((x) => x.name)).toEqual(["Atlassian", "No vendor"]);
    expect(g.find((x) => x.name === "Atlassian")!.products.map((p) => p.name)).toEqual(["Confluence"]);
  });
});
