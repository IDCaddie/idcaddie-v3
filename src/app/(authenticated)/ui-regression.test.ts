import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Consolidated source-scan regression for the PR #1–#5 pages: they must stay read-only and never render a
// secret/discovery field, a raw owner/tenant/org id, or introduce a live-sync/run-sync control or DB mutation.
// Comments are stripped first — several pages legitimately NAME what they avoid in prose.
const strip = (s: string) => s.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
const read = (rel: string) => strip(readFileSync(join(__dirname, rel), "utf8"));
const PAGES = [
  "page.tsx", // authenticated root (redirects to /dashboards)
  "dashboards/page.tsx",
  "needs-attention/page.tsx",
  "apps/page.tsx",
  "apps/[id]/page.tsx",
  "contracts/page.tsx",
  "contracts/[id]/page.tsx",
  "catalog/page.tsx",
  "audit/page.tsx",
  "apps/export-csv-button.tsx",
  "contracts/export-csv-button.tsx",
];

describe("UI regression — PR #1–#5 pages stay read-only + leak-free", () => {
  it("render no secret/discovery/raw-owner/raw-tenant fields", () => {
    for (const p of PAGES) {
      const code = read(p);
      for (const f of [
        "connector_secrets", "discovery_facts", "fact_json", "ciphertext", "getSecretValue",
        "business_owner_user_id", "technical_owner_user_id", "owner_user_id",
        "activeTenant.id", "SERVICE_ROLE",
      ]) {
        expect(code, `${p} must not reference ${f}`).not.toContain(f);
      }
    }
  });

  it("introduce no live-sync / run-sync control or DB mutation", () => {
    for (const p of PAGES) {
      const code = read(p);
      // NB: no ".delete(" here — these pages call DALs (never supabase directly), and a bare ".delete(" matches
      // the in-memory Set.delete used by the apps filter-toggle URL builder. "use server"/insert/update/upsert
      // still catch a real mutation or server action if one is ever added.
      for (const f of ['"use server"', "runInternalSlackSync", "runConnectorSync", "triggerSync", ".insert(", ".update(", ".upsert("]) {
        expect(code, `${p} must not contain ${f}`).not.toContain(f);
      }
    }
  });

  it("app + contract detail render org ownership as presence, not raw UUIDs", () => {
    for (const p of ["apps/[id]/page.tsx", "contracts/[id]/page.tsx"]) {
      const code = read(p);
      expect(code, `${p} must not show the raw "organization IDs" section`).not.toContain("organization IDs");
      expect(code, `${p} must not render a raw org id`).not.toMatch(/OrgId \?\? "—"/);
    }
  });
});
