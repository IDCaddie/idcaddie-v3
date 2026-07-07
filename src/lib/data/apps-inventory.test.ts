import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { filterSortApps, appChips, appAttentionFlags, type InventoryRow } from "./apps-inventory";

const row = (o: Partial<InventoryRow> & { id: string; name: string }): InventoryRow => ({
  vendorName: null,
  category: null,
  status: "active",
  linkedContractCount: 1,
  appUserCount: 0,
  hasOwner: true,
  ...o,
});

describe("filterSortApps", () => {
  const rows = [
    row({ id: "1", name: "Figma", vendorName: "Figma Inc", hasOwner: false, linkedContractCount: 0, appUserCount: 5, status: "active" }),
    row({ id: "2", name: "Slack", vendorName: "Salesforce", hasOwner: true, linkedContractCount: 2, appUserCount: 1, status: "inactive" }),
    row({ id: "3", name: "Zoom", vendorName: null, hasOwner: true, linkedContractCount: 0, appUserCount: 9, status: "active" }),
  ];

  it("searches name + vendor, case-insensitive", () => {
    expect(filterSortApps(rows, { q: "fig" }).map((r) => r.id)).toEqual(["1"]);
    expect(filterSortApps(rows, { q: "salesforce" }).map((r) => r.id)).toEqual(["2"]);
    expect(filterSortApps(rows, { q: "nomatch" })).toEqual([]);
  });

  it("filters missing_owner and missing_contract (combinable)", () => {
    expect(filterSortApps(rows, { filters: ["missing_owner"] }).map((r) => r.id)).toEqual(["1"]);
    expect(filterSortApps(rows, { filters: ["missing_contract"] }).map((r) => r.id).sort()).toEqual(["1", "3"]);
    expect(filterSortApps(rows, { filters: ["missing_owner", "missing_contract"] }).map((r) => r.id)).toEqual(["1"]);
  });

  it("sorts by name (default), status, and users (desc)", () => {
    expect(filterSortApps(rows, {}).map((r) => r.id)).toEqual(["1", "2", "3"]); // name asc
    expect(filterSortApps(rows, { sort: "users" }).map((r) => r.id)).toEqual(["3", "1", "2"]); // appUserCount desc
    expect(filterSortApps(rows, { sort: "status" }).map((r) => r.id)).toEqual(["1", "3", "2"]); // active<inactive, name tiebreak
  });
});

describe("appChips + appAttentionFlags", () => {
  it("chips: no owner / no contract", () => {
    expect(appChips({ hasOwner: false, linkedContractCount: 0 }).map((c) => c.key).sort()).toEqual(["missing_contract", "missing_owner"]);
    expect(appChips({ hasOwner: true, linkedContractCount: 3 })).toEqual([]);
  });

  it("detail flags: missing owner / no contract / no accounts; unknown (null) is not flagged", () => {
    expect(appAttentionFlags({ hasOwner: false, hasLinkedContract: true, hasDiscoveredAccounts: true }).map((f) => f.key)).toEqual(["missing_owner"]);
    expect(appAttentionFlags({ hasOwner: true, hasLinkedContract: false, hasDiscoveredAccounts: false }).map((f) => f.key).sort()).toEqual(["missing_contract", "no_accounts"]);
    expect(appAttentionFlags({ hasOwner: true, hasLinkedContract: null, hasDiscoveredAccounts: null })).toEqual([]); // unknown → not flagged
  });
});

describe("apps data safety", () => {
  const strip = (s: string) => s.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");

  it("apps DAL exposes owner presence booleans, never a raw owner id DTO field", () => {
    const src = readFileSync(join(__dirname, "apps.ts"), "utf8");
    expect(src).toContain("hasOwner: ");
    expect(src).toContain("hasBusinessOwner: ");
    expect(src).toContain("hasTechnicalOwner: ");
    expect(src).not.toMatch(/ownerUserId|businessOwnerUserId|technicalOwnerUserId/); // no camelCase owner-id DTO field
  });

  it("helper + apps pages render no secret/discovery/raw-owner fields (comments stripped)", () => {
    const files = [
      "apps-inventory.ts",
      "../../app/(authenticated)/apps/page.tsx",
      "../../app/(authenticated)/apps/[id]/page.tsx",
    ];
    for (const rel of files) {
      const code = strip(readFileSync(join(__dirname, rel), "utf8"));
      for (const forbidden of ["connector_secrets", "discovery_facts", "fact_json", "business_owner_user_id", "technical_owner_user_id", "SERVICE_ROLE"]) {
        expect(code, `${rel} must not reference ${forbidden}`).not.toContain(forbidden);
      }
    }
  });
});
