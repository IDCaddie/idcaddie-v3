import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
// needs-attention.ts is PURE (type-only DAL imports) — it loads with no server graph, so no mock is needed.
import { buildNeedsAttention, type NeedsAttentionInputs } from "./needs-attention";
import { NAV_SECTIONS, IMPLEMENTED_ROUTES } from "../../app/(authenticated)/nav-items";

// Fixture builders for the exact DAL result shapes.
const appsCounts = (rows: Array<{ id: string; name: string; vendorName?: string | null; linkedContractCount: number }>): NeedsAttentionInputs["appsCounts"] =>
  ({ ok: true, data: rows.map((r) => ({ id: r.id, name: r.name, vendorName: r.vendorName ?? null, category: null, status: "active", linkedContractCount: r.linkedContractCount, appUserCount: 0 })) });
const appsOwnership = (rows: Array<{ id: string; name: string; hasOwner: boolean }>): NeedsAttentionInputs["appsOwnership"] =>
  ({ ok: true, data: rows.map((r) => ({ id: r.id, name: r.name, status: "active", hasOwner: r.hasOwner })) });
const contracts = (rows: Array<{ id: string; contractName: string; renewalDate: string | null; endDate: string | null }>): NeedsAttentionInputs["contracts"] =>
  ({ ok: true, data: rows.map((r) => ({ id: r.id, contractName: r.contractName, vendorName: null, status: "active", category: null, renewalDate: r.renewalDate, endDate: r.endDate, totalCost: null, currency: null, hasOwner: false, renewalResponsibility: null })) });
const connectors = (rows: Array<{ id: string; provider: string; status: string; runStatus?: string }>): NeedsAttentionInputs["connectors"] =>
  ({ ok: true, data: rows.map((r) => ({ id: r.id, provider: r.provider, displayName: null, status: r.status, safeScopes: [], createdAt: "t", updatedAt: "t", lastRun: r.runStatus ? { status: r.runStatus, startedAt: null, completedAt: null, failureCode: null, failureLabel: null, recordsSeen: null, recordsImported: null, recordsFailed: null } : null })) });
const reports = (unmatched: number | null): NeedsAttentionInputs["reports"] =>
  ({ ok: true, data: { appsVisible: 0, contractsVisible: 0, accountsVisible: 0, accountsMatched: null, accountsUnmatched: unmatched, filesVisible: 0 } });

const base = (): NeedsAttentionInputs => ({
  appsCounts: appsCounts([]),
  appsOwnership: appsOwnership([]),
  contracts: contracts([]),
  connectors: connectors([]),
  reports: reports(0),
});
const sec = (r: ReturnType<typeof buildNeedsAttention>, key: string) => r.sections.find((s) => s.key === key)!;

describe("buildNeedsAttention — categorization", () => {
  it("apps missing owner: only hasOwner=false rows, linking to /apps/[id]", () => {
    const r = buildNeedsAttention({ ...base(), appsOwnership: appsOwnership([{ id: "a1", name: "Figma", hasOwner: false }, { id: "a2", name: "Slack", hasOwner: true }]) });
    const s = sec(r, "apps-missing-owner");
    expect(s.state).toBe("ok");
    expect(s.count).toBe(1);
    expect(s.items).toEqual([{ label: "Figma", sublabel: "active", href: "/apps/a1" }]);
  });

  it("apps missing contract: only linkedContractCount===0", () => {
    const r = buildNeedsAttention({ ...base(), appsCounts: appsCounts([{ id: "a1", name: "Notion", linkedContractCount: 0 }, { id: "a2", name: "Zoom", linkedContractCount: 2 }]) });
    const s = sec(r, "apps-missing-contract");
    expect(s.count).toBe(1);
    expect(s.items[0].href).toBe("/apps/a1");
  });

  it("contracts missing renewal: only rows with neither renewalDate nor endDate", () => {
    const r = buildNeedsAttention({ ...base(), contracts: contracts([
      { id: "c1", contractName: "AWS", renewalDate: null, endDate: null },
      { id: "c2", contractName: "GCP", renewalDate: "2027-01-01", endDate: null },
      { id: "c3", contractName: "Azure", renewalDate: null, endDate: "2027-06-01" },
    ]) });
    const s = sec(r, "contracts-missing-renewal");
    expect(s.count).toBe(1);
    expect(s.items[0]).toMatchObject({ label: "AWS", href: "/contracts/c1" });
  });

  it("connector issues: bad connector status OR bad last-run status", () => {
    const r = buildNeedsAttention({ ...base(), connectors: connectors([
      { id: "k1", provider: "slack", status: "error" },
      { id: "k2", provider: "okta", status: "active", runStatus: "failed" },
      { id: "k3", provider: "zoom", status: "active", runStatus: "succeeded" },
    ]) });
    const s = sec(r, "connector-issues");
    expect(s.count).toBe(2);
    expect(s.items.every((i) => i.href === "/connectors")).toBe(true);
  });

  it("unmatched accounts: aggregate count only, links to /people, no per-account detail", () => {
    const r = buildNeedsAttention({ ...base(), reports: reports(4) });
    const s = sec(r, "unmatched-accounts");
    expect(s.state).toBe("ok");
    expect(s.count).toBe(4);
    expect(s.items).toEqual([{ label: "4 unmatched accounts", href: "/people" }]);
  });

  it("empty inputs → every actionable section is 'empty' (all clear); unmanaged is 'deferred'", () => {
    const r = buildNeedsAttention(base());
    for (const key of ["apps-missing-owner", "apps-missing-contract", "contracts-missing-renewal", "connector-issues", "unmatched-accounts"]) {
      expect(sec(r, key).state).toBe("empty");
    }
    expect(sec(r, "unmanaged-apps").state).toBe("deferred");
  });

  it("a failed DAL fails closed to 'error' (no crash)", () => {
    const r = buildNeedsAttention({ ...base(), appsCounts: { ok: false, error: "query_failed" }, reports: { ok: false } });
    expect(sec(r, "apps-missing-contract").state).toBe("error");
    expect(sec(r, "unmatched-accounts").state).toBe("error");
  });

  it("caps rendered items at 8 but reports the true total", () => {
    const many = Array.from({ length: 20 }, (_, i) => ({ id: `a${i}`, name: `App${i}`, hasOwner: false }));
    const s = sec(buildNeedsAttention({ ...base(), appsOwnership: appsOwnership(many) }), "apps-missing-owner");
    expect(s.count).toBe(20);
    expect(s.items).toHaveLength(8);
  });
});

describe("needs-attention — safety", () => {
  it("output never contains a raw owner id, fact_json, connector_secrets, or token", () => {
    // even if owner ids somehow reached the builder, they aren't in AppOwnershipRow — assert the serialized output is clean
    const r = buildNeedsAttention({ ...base(), appsOwnership: appsOwnership([{ id: "a1", name: "Figma", hasOwner: false }]), reports: reports(3) });
    const json = JSON.stringify(r);
    for (const forbidden of ["fact_json", "connector_secrets", "discovery_facts", "business_owner_user_id", "technical_owner_user_id", "token", "ciphertext"]) {
      expect(json).not.toContain(forbidden);
    }
  });

  it("the page + loaders reference no secret/discovery/PII fields (comments stripped — they legitimately name what they avoid)", () => {
    const strip = (s: string) => s.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
    const files = ["../../app/(authenticated)/needs-attention/page.tsx", "needs-attention.ts", "needs-attention-loader.ts"];
    for (const rel of files) {
      const code = strip(readFileSync(join(__dirname, rel), "utf8"));
      for (const forbidden of ["fact_json", "connector_secrets", "discovery_facts", "raw_payload", "getSecretValue", "SERVICE_ROLE", "business_owner_user_id"]) {
        expect(code, `${rel} must not reference ${forbidden}`).not.toContain(forbidden);
      }
    }
  });

  it("nav exposes Needs Attention → /needs-attention (a real implemented route)", () => {
    const item = NAV_SECTIONS.flatMap((s) => s.items).find((i) => i.label === "Needs Attention");
    expect(item?.href).toBe("/needs-attention");
    expect(IMPLEMENTED_ROUTES).toContain("/needs-attention");
  });
});
