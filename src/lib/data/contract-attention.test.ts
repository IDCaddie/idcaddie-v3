import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renewalFlag, contractAttentionFlags } from "./contract-attention";
import { formatMoney } from "./dashboard-overview";

const NOW = new Date("2026-07-07T12:00:00Z"); // "today" = 2026-07-07 UTC

describe("renewalFlag", () => {
  it("flags missing / due-30 / due-90 with end_date fallback; past + far are unflagged", () => {
    expect(renewalFlag(null, null, NOW)).toBe("missing");
    expect(renewalFlag("2026-07-17", null, NOW)).toBe("due30"); // +10d
    expect(renewalFlag("2026-09-05", null, NOW)).toBe("due90"); // ~+60d
    expect(renewalFlag("2027-02-01", null, NOW)).toBeNull(); // far
    expect(renewalFlag("2026-07-01", null, NOW)).toBeNull(); // already past
    expect(renewalFlag(null, "2026-07-12", NOW)).toBe("due30"); // end-date fallback +5d
  });
});

describe("contractAttentionFlags", () => {
  const keys = (i: Parameters<typeof contractAttentionFlags>[0]) => contractAttentionFlags(i, NOW).map((f) => f.key);

  it("missing renewal", () => {
    expect(keys({ renewalDate: null, endDate: null, hasOwner: true, hasLinkedApp: true })).toEqual(["missing_renewal"]);
  });
  it("renewal soon (due-30)", () => {
    expect(keys({ renewalDate: "2026-07-17", endDate: null, hasOwner: true, hasLinkedApp: true })).toEqual(["renewal_soon"]);
  });
  it("missing owner", () => {
    expect(keys({ renewalDate: "2027-01-01", endDate: null, hasOwner: false, hasLinkedApp: true })).toContain("missing_owner");
  });
  it("no linked app only when known-none (false), NOT when unknown (null)", () => {
    expect(keys({ renewalDate: "2027-01-01", endDate: null, hasOwner: true, hasLinkedApp: false })).toContain("no_linked_app");
    expect(keys({ renewalDate: "2027-01-01", endDate: null, hasOwner: true, hasLinkedApp: null })).not.toContain("no_linked_app");
  });
  it("all good → no flags", () => {
    expect(keys({ renewalDate: "2027-01-01", endDate: null, hasOwner: true, hasLinkedApp: true })).toEqual([]);
  });
});

describe("formatMoney (shared, used by contracts list + detail)", () => {
  it("formats a currency and falls back safely", () => {
    expect(formatMoney(1500, "USD")).toContain("1,500");
    expect(formatMoney(1500, "unspecified")).toContain("currency unspecified");
  });
});

describe("contracts data safety", () => {
  const strip = (s: string) => s.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");

  it("the contracts DAL reads no invoices/license table and exposes hasOwner, never a raw owner id", () => {
    const src = readFileSync(join(__dirname, "contracts.ts"), "utf8");
    const code = strip(src);
    expect(code).not.toMatch(/\.from\(["'](invoices|license_)/); // no default-deny table reads (RISK-002)
    expect(code).not.toMatch(/connector_secrets|discovery_facts|fact_json/);
    expect(src).toContain("hasOwner: "); // the computed boolean is what's returned
    expect(src).not.toMatch(/ownerUserId/); // no camelCase owner-id field on any DTO/return
  });

  it("the helper + list/detail pages render no secret/discovery/owner-id fields (comments stripped)", () => {
    const files = [
      "contract-attention.ts",
      "../../app/(authenticated)/contracts/page.tsx",
      "../../app/(authenticated)/contracts/[id]/page.tsx",
    ];
    for (const rel of files) {
      const code = strip(readFileSync(join(__dirname, rel), "utf8"));
      // pages may MENTION "invoices" in deferred-feature prose; what must never appear is a secret/discovery
      // field or a raw owner id being rendered.
      for (const forbidden of ["connector_secrets", "discovery_facts", "fact_json", "owner_user_id", "SERVICE_ROLE"]) {
        expect(code, `${rel} must not reference ${forbidden}`).not.toContain(forbidden);
      }
    }
  });
});
