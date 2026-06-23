import { describe, it, expect, vi } from "vitest";
import {
  submitDiscoveryFactForReview,
  submitDiscoveryFactsForReview,
  previewDiscoveryFactResolution,
  stageAndPreviewDiscoveryFact,
  type ResolverPreview,
} from "./discovery-fact-adapter";
import { type DiscoveryFactStagingStore, type DiscoveryFactStagingRow } from "./discovery-fact-staging";
import { DISCOVERY_FACT_SCHEMA_VERSION } from "./discovery-facts";

const TENANT_A = "11111111-1111-1111-1111-111111111111";
const TENANT_B = "22222222-2222-2222-2222-222222222222";

const base = {
  schema_version: DISCOVERY_FACT_SCHEMA_VERSION,
  signal_id: "okta:app:1",
  tenant_id: TENANT_A,
  source_type: "identity_provider_discovery",
  source_provider: "okta",
  observed_at: "2026-06-23T00:00:00Z",
  confidence: 0.9,
};
const appDiscoveryFact = (over: Record<string, unknown> = {}) => ({ ...base, fact_type: "app_discovery", discovered_app_name: "Jira", ...over });
// a deterministic instance signal (carries instance_domain — a merge/no-merge key)
const instanceFact = (over: Record<string, unknown> = {}) => ({
  ...base, fact_type: "app_instance_identity", instance_domain: "flywheel.atlassian.net", ...over,
});

function mockStore(): DiscoveryFactStagingStore & { rows: DiscoveryFactStagingRow[] } {
  const rows: DiscoveryFactStagingRow[] = [];
  return { rows, stage: vi.fn(async (row: DiscoveryFactStagingRow) => { rows.push(row); return { ok: true as const, id: "staged-1" }; }) };
}

describe("submitDiscoveryFactForReview — authenticated user-scoped staging seam", () => {
  it("a valid fact stages through the adapter (mocked authenticated store called)", async () => {
    const store = mockStore();
    const result = await submitDiscoveryFactForReview(store, TENANT_A, appDiscoveryFact());
    expect(result.ok).toBe(true);
    expect(store.rows).toHaveLength(1);
    expect(store.rows[0].tenant_id).toBe(TENANT_A);
  });

  it("an invalid fact rejects before the store call", async () => {
    const store = mockStore();
    const result = await submitDiscoveryFactForReview(store, TENANT_A, { not: "a fact" });
    expect(result).toEqual({ ok: false, reason: "invalid_fact" });
    expect(store.stage).not.toHaveBeenCalled();
  });

  it.each(["access_token", "refresh_token", "connector_secrets"])(
    "a %s-bearing fact rejects before the store call", async (secretKey) => {
      const store = mockStore();
      const result = await submitDiscoveryFactForReview(store, TENANT_A, appDiscoveryFact({ [secretKey]: "leak" }));
      expect(result).toEqual({ ok: false, reason: "forbidden_material" });
      expect(store.stage).not.toHaveBeenCalled();
    },
  );

  it("a mismatched tenant rejects before the store call", async () => {
    const store = mockStore();
    const result = await submitDiscoveryFactForReview(store, TENANT_A, appDiscoveryFact({ tenant_id: TENANT_B }));
    expect(result).toEqual({ ok: false, reason: "tenant_mismatch" });
    expect(store.stage).not.toHaveBeenCalled();
  });

  it("submitDiscoveryFactsForReview stages valid facts, rejects bad ones independently", async () => {
    const store = mockStore();
    const results = await submitDiscoveryFactsForReview(store, TENANT_A, [appDiscoveryFact(), { junk: true }]);
    expect(results.map((r) => r.ok)).toEqual([true, false]);
    expect(store.rows).toHaveLength(1);
  });
});

describe("previewDiscoveryFactResolution — READ-ONLY in-memory prediction, persists nothing", () => {
  it("a deterministic instance signal returns a read-only preview (deterministic confidence)", () => {
    const result = previewDiscoveryFactResolution(instanceFact());
    expect(result.ok).toBe(true);
    const preview = (result as { ok: true; preview: ResolverPreview }).preview;
    expect(preview.decision.confidence).toBe("deterministic");
    // the preview is a PREDICTION only — it returns a decision object, it does not act on it
    expect(preview.decision.action).toBe("auto_assign");
    expect(Array.isArray(preview.decision.reasons)).toBe(true);
  });

  it("an ambiguous fact (no deterministic instance key) returns human_review", () => {
    // a name-only app_discovery fact has no instance_domain/external_instance_id → fail closed
    const result = previewDiscoveryFactResolution(appDiscoveryFact());
    expect(result.ok).toBe(true);
    const preview = (result as { ok: true; preview: ResolverPreview }).preview;
    expect(preview.decision.action).toBe("human_review");
    expect(preview.decision.confidence).toBe("human_review");
  });

  it("an invalid/secret-bearing fact does not produce a preview", () => {
    expect(previewDiscoveryFactResolution({ junk: true })).toEqual({ ok: false, reason: "invalid_fact" });
    expect(previewDiscoveryFactResolution(appDiscoveryFact({ access_token: "x" }))).toEqual({ ok: false, reason: "forbidden_material" });
  });

  it("preview takes NO store and returns ONLY a decision (no canonical-graph / persistence fields)", () => {
    const result = previewDiscoveryFactResolution(instanceFact());
    const preview = (result as { ok: true; preview: ResolverPreview }).preview;
    // the preview surface is exactly { decision } — no canonical_app_id / app_alias / match / persisted id
    expect(Object.keys(preview)).toEqual(["decision"]);
    const flat = JSON.stringify(preview);
    for (const forbidden of ["canonical_app_id", "app_alias", "app_user_identity_match", "person_id", "staged", "review_status"]) {
      expect(flat).not.toContain(forbidden);
    }
  });
});

describe("stageAndPreviewDiscoveryFact — stages + read-only preview; preview never persisted", () => {
  it("stages the fact AND returns a read-only preview alongside it", async () => {
    const store = mockStore();
    const { stage, preview } = await stageAndPreviewDiscoveryFact(store, TENANT_A, instanceFact());
    expect(stage.ok).toBe(true);
    expect(store.rows).toHaveLength(1);
    expect(preview?.decision.confidence).toBe("deterministic");
    // the staged ROW never carries the preview decision or any canonical-graph field — preview is not persisted
    const row = store.rows[0] as Record<string, unknown>;
    for (const forbidden of ["decision", "preview", "canonical_app_id", "app_alias", "app_user_identity_match", "person_id"]) {
      expect(row).not.toHaveProperty(forbidden);
    }
  });

  it("when the fact is invalid: stage fails, no store call, preview is null", async () => {
    const store = mockStore();
    const { stage, preview } = await stageAndPreviewDiscoveryFact(store, TENANT_A, { junk: true });
    expect(stage.ok).toBe(false);
    expect(store.stage).not.toHaveBeenCalled();
    expect(preview).toBeNull();
  });
});

// Static guards: the adapter is server-only — it imports ONLY sibling server-only modules; no Supabase / db
// client, no createClient, no fetch, no service-role, no connector_secrets, no HTTP route, no client import.
describe("discovery-fact-adapter module is server-safe (no db client / fetch / service-role / route)", () => {
  it("imports only sibling server-only modules and has no forbidden call/string", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const src = fs.readFileSync(path.resolve(__dirname, "discovery-fact-adapter.ts"), "utf8");
    const imports = [...src.matchAll(/from\s+["']([^"']+)["']/g)].map((m) => m[1]);
    expect(imports.sort()).toEqual(["./discovery-fact-staging", "./discovery-facts", "./resolution"]);
    const code = src.replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
    expect(code).not.toMatch(/createClient\s*\(/);
    expect(code).not.toMatch(/createServiceClient/);
    expect(code).not.toMatch(/\bfetch\s*\(/);
    expect(code).not.toMatch(/process\.env/);
    expect(code).not.toContain(["service", "role"].join("_"));
    expect(code).not.toContain(["connector", "secrets"].join("_"));
    // no HTTP route handler (no public/unauthenticated ingestion route lives here)
    for (const routeExport of ["export async function GET", "export async function POST", "export const GET", "export const POST", "NextRequest", "NextResponse"]) {
      expect(code).not.toContain(routeExport);
    }
    // the adapter writes NO canonical-graph tables and persists no preview
    for (const t of ["canonical_app_id", "app_aliases", "app_user_identity_matches"]) {
      expect(code).not.toContain(t);
    }
  });
});
