import { describe, it, expect, vi } from "vitest";
import {
  listStagedDiscoveryFactsForCurrentUser,
  previewStagedDiscoveryFacts,
  previewDiscoveryFactResolutionFromRows,
  mapDiscoveryFactRowToResolutionInput,
  type DiscoveryFactReadStore,
  type StagedDiscoveryFactRow,
} from "./discovery-fact-read";

const TENANT_A = "11111111-1111-1111-1111-111111111111";

// a staged row carrying a deterministic instance key (in fact_json)
const instanceRow: StagedDiscoveryFactRow = {
  id: "df-1", tenant_id: TENANT_A, fact_type: "app_instance_identity",
  fact_json: { fact_type: "app_instance_identity", instance_domain: "flywheel.atlassian.net" },
};
// a staged row with no deterministic instance key (name only) — ambiguous
const ambiguousRow: StagedDiscoveryFactRow = {
  id: "df-2", tenant_id: TENANT_A, fact_type: "app_discovery",
  fact_json: { fact_type: "app_discovery", discovered_app_name: "Jira" },
};

function mockReadStore(rows: readonly StagedDiscoveryFactRow[]): DiscoveryFactReadStore & { calls: number } {
  const store = { calls: 0, listStagedFacts: vi.fn(async () => { store.calls++; return rows; }) };
  return store;
}

describe("listStagedDiscoveryFactsForCurrentUser — RLS-scoped read, tenant-context gated", () => {
  it("reads staged facts through the injected authenticated store", async () => {
    const store = mockReadStore([instanceRow, ambiguousRow]);
    const rows = await listStagedDiscoveryFactsForCurrentUser(store, TENANT_A);
    expect(store.listStagedFacts).toHaveBeenCalledTimes(1);
    expect(rows).toHaveLength(2);
  });

  it.each([null, undefined, ""])("does NOT call the store when tenant context is missing (%s)", async (ctx) => {
    const store = mockReadStore([instanceRow]);
    const rows = await listStagedDiscoveryFactsForCurrentUser(store, ctx as string | null | undefined);
    expect(store.listStagedFacts).not.toHaveBeenCalled();
    expect(rows).toEqual([]);
  });
});

describe("previewStagedDiscoveryFacts — read-only previews over staged rows", () => {
  it("returns a read-only preview for a deterministic instance fact", async () => {
    const store = mockReadStore([instanceRow]);
    const previews = await previewStagedDiscoveryFacts(store, TENANT_A);
    expect(previews).toHaveLength(1);
    expect(previews[0].factId).toBe("df-1");
    expect(previews[0].decision.confidence).toBe("deterministic");
    expect(previews[0].decision.action).toBe("auto_assign"); // a PREDICTION only — nothing acts on it
  });

  it("returns human_review for an ambiguous staged fact (no deterministic instance key)", async () => {
    const store = mockReadStore([ambiguousRow]);
    const previews = await previewStagedDiscoveryFacts(store, TENANT_A);
    expect(previews[0].decision.action).toBe("human_review");
    expect(previews[0].decision.confidence).toBe("human_review");
  });

  it("a malformed / empty fact_json fails closed to human_review", () => {
    const rows: StagedDiscoveryFactRow[] = [
      { id: "x", tenant_id: TENANT_A, fact_type: "app_discovery", fact_json: null },
      { id: "y", tenant_id: TENANT_A, fact_type: "app_discovery", fact_json: "not-an-object" },
      { id: "z", tenant_id: TENANT_A, fact_type: "app_discovery", fact_json: {} },
    ];
    for (const p of previewDiscoveryFactResolutionFromRows(rows)) {
      expect(p.decision.action).toBe("human_review");
    }
  });

  it("does NOT call the store (and previews nothing) when tenant context is missing", async () => {
    const store = mockReadStore([instanceRow]);
    const previews = await previewStagedDiscoveryFacts(store, null);
    expect(store.listStagedFacts).not.toHaveBeenCalled();
    expect(previews).toEqual([]);
  });
});

describe("preview is read-only — persists nothing, writes no graph, no review_status update", () => {
  it("the read store has NO write/update method (read path only)", () => {
    const store = mockReadStore([instanceRow]);
    // the injected store surface is exactly { listStagedFacts } (+ the test's call counter) — no update/insert/stage
    const keys = Object.keys(store).filter((k) => k !== "calls");
    expect(keys).toEqual(["listStagedFacts"]);
    for (const forbidden of ["update", "insert", "upsert", "stage", "delete", "write"]) {
      expect(store).not.toHaveProperty(forbidden);
    }
  });

  it("a preview carries ONLY { factId, factType, decision } — no persisted / canonical-graph field", async () => {
    const store = mockReadStore([instanceRow]);
    const [preview] = await previewStagedDiscoveryFacts(store, TENANT_A);
    expect(Object.keys(preview).sort()).toEqual(["decision", "factId", "factType"]);
    const flat = JSON.stringify(preview);
    for (const forbidden of ["canonical_app_id", "app_alias", "app_user_identity_match", "person_id", "review_status", "staged_id"]) {
      expect(flat).not.toContain(forbidden);
    }
  });

  it("mapDiscoveryFactRowToResolutionInput extracts only the deterministic instance fields", () => {
    const input = mapDiscoveryFactRowToResolutionInput(instanceRow);
    expect(input.instanceDomain).toBe("flywheel.atlassian.net");
    // no canonical/alias/match fields leak into the resolution input
    expect(input).not.toHaveProperty("canonical_app_id");
  });
});

// Static guards: the read module is server-only — imports ONLY ./resolution; no Supabase / db client, no
// createClient, no fetch, no service-role, no connector_secrets, no HTTP route, no client/browser import.
describe("discovery-fact-read module is server-safe (no db client / fetch / service-role / route)", () => {
  it("imports only ./resolution and has no forbidden call/string", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const src = fs.readFileSync(path.resolve(__dirname, "discovery-fact-read.ts"), "utf8");
    const imports = [...src.matchAll(/from\s+["']([^"']+)["']/g)].map((m) => m[1]);
    expect(imports).toEqual(["./resolution"]);
    const code = src.replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
    expect(code).not.toMatch(/createClient\s*\(/);
    expect(code).not.toMatch(/createServiceClient/);
    expect(code).not.toMatch(/\bfetch\s*\(/);
    expect(code).not.toMatch(/process\.env/);
    expect(code).not.toContain(["service", "role"].join("_"));
    expect(code).not.toContain(["connector", "secrets"].join("_"));
    // no HTTP route handler / no canonical-graph write / no review_status mutation
    for (const bad of ["export async function GET", "export async function POST", "NextRequest", "NextResponse", "canonical_app_id", "app_aliases", "app_user_identity_matches", ".update(", ".insert("]) {
      expect(code).not.toContain(bad);
    }
  });
});
