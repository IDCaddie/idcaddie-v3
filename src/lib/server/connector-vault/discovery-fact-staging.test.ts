import { describe, it, expect, vi } from "vitest";
import {
  validateDiscoveryFact,
  stageDiscoveryFactForReview,
  stageDiscoveryFactsForReview,
  type DiscoveryFactStagingStore,
  type DiscoveryFactStagingRow,
} from "./discovery-fact-staging";
import { DISCOVERY_FACT_SCHEMA_VERSION } from "./discovery-facts";

const TENANT_A = "11111111-1111-1111-1111-111111111111";
const TENANT_B = "22222222-2222-2222-2222-222222222222";

const validFact = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  schema_version: DISCOVERY_FACT_SCHEMA_VERSION,
  signal_id: "okta:app:1",
  tenant_id: TENANT_A,
  source_type: "identity_provider_discovery",
  source_provider: "okta",
  observed_at: "2026-06-23T00:00:00Z",
  confidence: 0.9,
  fact_type: "app_discovery",
  discovered_app_name: "Jira",
  ...over,
});

// A mock store that records every row it is asked to stage.
function mockStore(): DiscoveryFactStagingStore & { rows: DiscoveryFactStagingRow[] } {
  const rows: DiscoveryFactStagingRow[] = [];
  return {
    rows,
    stage: vi.fn(async (row: DiscoveryFactStagingRow) => {
      rows.push(row);
      return { ok: true as const, id: "staged-1" };
    }),
  };
}

describe("stageDiscoveryFactForReview — only safeParse-validated, secret-free facts are staged", () => {
  it("a valid app discovery fact stages successfully (store called with the mapped row)", async () => {
    const store = mockStore();
    const result = await stageDiscoveryFactForReview(store, TENANT_A, validFact());
    expect(result.ok).toBe(true);
    expect(store.rows).toHaveLength(1);
    const row = store.rows[0];
    expect(row.tenant_id).toBe(TENANT_A);
    expect(row.fact_type).toBe("app_discovery");
    expect(row.source_provider).toBe("okta");
    expect(row.natural_key).toBe("app_discovery:okta:okta:app:1");
    expect(row.fact_json).toMatchObject({ fact_type: "app_discovery", discovered_app_name: "Jira" });
  });

  it("an invalid fact is rejected BEFORE any DB insert (store never called)", async () => {
    const store = mockStore();
    const result = await stageDiscoveryFactForReview(store, TENANT_A, { not: "a fact" });
    expect(result).toEqual({ ok: false, reason: "invalid_fact" });
    expect(store.stage).not.toHaveBeenCalled();
  });

  it("an unknown fact_type fails parse (rejected before insert)", async () => {
    const store = mockStore();
    const result = await stageDiscoveryFactForReview(store, TENANT_A, validFact({ fact_type: "made_up" }));
    expect(result).toEqual({ ok: false, reason: "invalid_fact" });
    expect(store.stage).not.toHaveBeenCalled();
  });

  it.each(["access_token", "refresh_token", "connector_secrets", "api_key", "client_secret"])(
    "%s-bearing fact is rejected BEFORE any DB insert", async (secretKey) => {
      const store = mockStore();
      const result = await stageDiscoveryFactForReview(store, TENANT_A, validFact({ [secretKey]: "leak" }));
      expect(result).toEqual({ ok: false, reason: "forbidden_material" });
      expect(store.stage).not.toHaveBeenCalled();
    },
  );

  it("a secret nested inside provenance is rejected before insert", async () => {
    const store = mockStore();
    const result = await stageDiscoveryFactForReview(store, TENANT_A, validFact({ provenance: { access_token: "x" } }));
    expect(result.ok).toBe(false);
    expect(store.stage).not.toHaveBeenCalled();
  });

  it("a fact claiming a different tenant than the session is rejected (tenant_mismatch)", async () => {
    const store = mockStore();
    const result = await stageDiscoveryFactForReview(store, TENANT_A, validFact({ tenant_id: TENANT_B }));
    expect(result).toEqual({ ok: false, reason: "tenant_mismatch" });
    expect(store.stage).not.toHaveBeenCalled();
  });

  it("a db_error from the store surfaces (and only after validation passed)", async () => {
    const store: DiscoveryFactStagingStore = { stage: async () => ({ ok: false, reason: "db_error" }) };
    expect(await stageDiscoveryFactForReview(store, TENANT_A, validFact())).toEqual({ ok: false, reason: "db_error" });
  });
});

describe("the staged row NEVER carries canonical-graph / match write fields", () => {
  it("staging never writes canonical_app_id / app_alias / app_user_identity_match fields", async () => {
    const store = mockStore();
    // even if the caller tries to smuggle these, strict #141 parse rejects unknown keys before staging
    await stageDiscoveryFactForReview(store, TENANT_A, validFact());
    const row = store.rows[0] as Record<string, unknown>;
    for (const forbidden of ["canonical_app_id", "app_alias_id", "app_aliases", "app_user_identity_match_id", "person_id", "matched_person_id"]) {
      expect(row).not.toHaveProperty(forbidden);
    }
    // the row's keys are exactly the staging columns
    expect(Object.keys(row).sort()).toEqual([
      "confidence", "fact_json", "fact_type", "natural_key", "observed_at", "provenance_json",
      "schema_version", "signal_id", "source_provider", "source_record_id", "source_run_id", "source_type", "tenant_id",
    ]);
  });
});

describe("stageDiscoveryFactsForReview — batch, independent validation", () => {
  it("stages the valid facts and rejects the bad ones independently", async () => {
    const store = mockStore();
    // a clean license fact — core fields + license fields only (no app_discovery field, which strict would reject)
    const licenseFact = {
      schema_version: DISCOVERY_FACT_SCHEMA_VERSION, signal_id: "okta:lic:1", tenant_id: TENANT_A,
      source_type: "deep_provider_sync", source_provider: "okta", observed_at: "2026-06-23T00:00:00Z",
      confidence: 0.8, fact_type: "license", license_name: "Jira Standard",
    };
    const results = await stageDiscoveryFactsForReview(store, TENANT_A, [validFact(), { junk: true }, licenseFact]);
    expect(results.map((r) => r.ok)).toEqual([true, false, true]);
    expect(store.rows).toHaveLength(2); // only the two valid facts reached the store
  });
});

describe("validateDiscoveryFact — fail closed", () => {
  it("returns ok for a clean valid fact, rejects secrets and invalid input", () => {
    expect(validateDiscoveryFact(validFact()).ok).toBe(true);
    expect(validateDiscoveryFact(validFact({ access_token: "x" }))).toEqual({ ok: false, reason: "forbidden_material" });
    expect(validateDiscoveryFact({})).toEqual({ ok: false, reason: "invalid_fact" });
  });
});

// Static guards: the helper is server-only — it imports ONLY the sibling ./discovery-facts contract; no
// Supabase / db / provider client, no fetch, no service-role, no connector_secrets, no client/browser import.
describe("discovery-fact-staging module is server-safe (no db client / fetch / service-role / secrets)", () => {
  it("imports only ./discovery-facts and has no forbidden call/string", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const src = fs.readFileSync(path.resolve(__dirname, "discovery-fact-staging.ts"), "utf8");
    const imports = [...src.matchAll(/from\s+["']([^"']+)["']/g)].map((m) => m[1]);
    expect(imports).toEqual(["./discovery-facts"]); // the ONLY import — no supabase client, no db
    const code = src.replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
    expect(code).not.toMatch(/createClient\s*\(/);
    expect(code).not.toMatch(/createServiceClient/);
    expect(code).not.toMatch(/\bfetch\s*\(/);
    expect(code).not.toMatch(/process\.env/);
    expect(code).not.toContain(["service", "role"].join("_"));
    const secretsTable = ["connector", "secrets"].join("_");
    expect(code).not.toContain(secretsTable);
    // the helper writes NO canonical-graph / match tables
    for (const t of ["canonical_app_id", "app_aliases", "app_user_identity_matches"]) {
      expect(code).not.toContain(t);
    }
  });
});
