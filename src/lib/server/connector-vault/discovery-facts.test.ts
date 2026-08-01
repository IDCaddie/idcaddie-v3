import { describe, it, expect } from "vitest";
import {
  DISCOVERY_FACT_SCHEMA_VERSION,
  parseDiscoveryFact,
  classifySourceType,
  isKnownSourceType,
  hasForbiddenFactKey,
  appInstanceCandidateKey,
  type DiscoveryFactType,
} from "./discovery-facts";

// The base (core) fields every fact carries. Each category fixture spreads this + its own fields.
const base = {
  schema_version: DISCOVERY_FACT_SCHEMA_VERSION,
  signal_id: "okta:app:1",
  tenant_id: "11111111-1111-1111-1111-111111111111",
  source_type: "identity_provider_discovery" as const,
  source_provider: "okta",
  observed_at: "2026-06-23T00:00:00Z",
  confidence: 0.9,
};

// One valid fixture per category — the defining fields for each of the 13 fact types.
const FIXTURES: Record<DiscoveryFactType, Record<string, unknown>> = {
  app_discovery: { ...base, fact_type: "app_discovery", discovered_app_name: "Jira", discovered_vendor_name: "Atlassian", discovered_domain: "atlassian.com" },
  app_instance_identity: { ...base, fact_type: "app_instance_identity", instance_domain: "flywheel.atlassian.net", external_instance_id: "cloud-1", owner_org_hint: "org-1" },
  vendor_product: { ...base, fact_type: "vendor_product", vendor_name: "Atlassian", product_name: "Jira" },
  app_user_account: { ...base, fact_type: "app_user_account", app_user_external_id: "u-1", email: "jane@acme.com", status: "active" },
  person_identity_candidate: { ...base, fact_type: "person_identity_candidate", primary_email: "jane@acme.com", display_name: "Jane Doe" },
  license: { ...base, fact_type: "license", license_name: "Jira Standard", license_sku: "JIRA-STD", cost_hint: 7.75, currency: "USD" },
  usage_activity: { ...base, fact_type: "usage_activity", last_activity_at: "2026-06-20T00:00:00Z", activity_count: 42, usage_confidence: 0.7 },
  role_admin: { ...base, fact_type: "role_admin", role_name: "site-admin", is_admin: true },
  group: { ...base, fact_type: "group", group_external_id: "S07UG1", group_name: "Engineering", group_handle: "eng", member_count: 5, is_active: true },
  group_membership: { ...base, fact_type: "group_membership", group_name: "Engineering", member_email: "jane@acme.com" },
  contract: { ...base, fact_type: "contract", source_type: "contract_intelligence", source_provider: "contract-ai", counterparty_vendor: "Atlassian", contract_value: 50000, currency: "USD" },
  invoice_spend: { ...base, fact_type: "invoice_spend", source_type: "invoice_spend_import", source_provider: "stripe", vendor_name: "Atlassian", amount: 1234.5, currency: "USD", app_candidate_name: "Jira" },
  risk_completeness: { ...base, fact_type: "risk_completeness", risk_type: "missing_owner", severity: "high", reason: "no owning org" },
  recommendation_evidence: { ...base, fact_type: "recommendation_evidence", recommendation_kind: "reclaim_license", evidence: ["inactive_90d"] },
};

const ALL_TYPES = Object.keys(FIXTURES) as DiscoveryFactType[];

describe("discovery fact schema — versioned contract, valid fixture per category", () => {
  it("defines exactly the 14 required fact categories", () => {
    expect(ALL_TYPES).toHaveLength(14);
  });

  it.each(ALL_TYPES)("a valid %s fact parses", (factType) => {
    const result = parseDiscoveryFact(FIXTURES[factType]);
    expect(result.success).toBe(true);
  });

  it("the schema is versioned — schema_version is required", () => {
    const withoutVersion = { ...FIXTURES.app_discovery };
    delete withoutVersion.schema_version;
    expect(parseDiscoveryFact(withoutVersion).success).toBe(false);
    // a wrong version is rejected too
    expect(parseDiscoveryFact({ ...FIXTURES.app_discovery, schema_version: 999 }).success).toBe(false);
  });
});

describe("fail-closed: unknown source / unknown type / token+secret material rejected", () => {
  it("an unknown fact_type fails closed (not in the discriminated union)", () => {
    expect(parseDiscoveryFact({ ...base, fact_type: "totally_made_up" }).success).toBe(false);
  });

  it("classifySourceType routes unknown source data to unknown_source (review)", () => {
    expect(classifySourceType("definitely_not_a_source")).toBe("unknown_source");
    expect(classifySourceType(null)).toBe("unknown_source");
    expect(classifySourceType("okta-ish")).toBe("unknown_source");
    expect(classifySourceType("identity_provider_discovery")).toBe("identity_provider_discovery");
    expect(isKnownSourceType("manual_csv_import")).toBe(true);
    expect(isKnownSourceType("unknown_source")).toBe(false); // the fail-closed bucket is not a "known" source
  });

  it("a token-like field is rejected by the strict schema", () => {
    for (const bad of ["access_token", "refresh_token", "api_key", "client_secret"]) {
      const result = parseDiscoveryFact({ ...FIXTURES.app_user_account, [bad]: "xoxb-secret" });
      expect(result.success).toBe(false);
    }
  });

  it("connector_secrets is NOT a valid field (strict schema rejects it)", () => {
    expect(parseDiscoveryFact({ ...FIXTURES.app_discovery, connector_secrets: { k: "v" } }).success).toBe(false);
  });

  it("hasForbiddenFactKey detects token/secret-like keys (incl. nested)", () => {
    expect(hasForbiddenFactKey({ ...base, access_token: "x" })).toBe(true);
    expect(hasForbiddenFactKey({ ...base, provenance: { client_secret: "x" } })).toBe(true);
    expect(hasForbiddenFactKey({ ...base, nested: { deep: { connector_secrets: 1 } } })).toBe(true);
    expect(hasForbiddenFactKey(FIXTURES.app_discovery)).toBe(false); // a clean fact has none
  });

  it("a token-like key nested inside provenance is rejected by the schema itself (refine), not just the guard", () => {
    const withNestedSecret = { ...FIXTURES.app_discovery, provenance: { access_token: "xoxb-secret" } };
    expect(parseDiscoveryFact(withNestedSecret).success).toBe(false); // schema-enforced, not only hasForbiddenFactKey
    expect(hasForbiddenFactKey(withNestedSecret)).toBe(true); // defense-in-depth still catches it too
    // a clean provenance record (safe scalar labels) still parses
    expect(parseDiscoveryFact({ ...FIXTURES.app_discovery, provenance: { region: "us", seats: 5 } }).success).toBe(true);
  });
});

describe("instance identity does not auto-resolve — distinct keys stay separate candidates", () => {
  it("different instance_domain values are different instance candidates (no auto-merge)", () => {
    const flywheel = appInstanceCandidateKey({ instance_domain: "flywheel.atlassian.net" });
    const perpetua = appInstanceCandidateKey({ instance_domain: "perpetua.atlassian.net" });
    expect(flywheel).not.toBe(perpetua);
    expect(flywheel).toBe("flywheel.atlassian.net");
  });

  it("different external_instance_id values are different instance candidates", () => {
    expect(appInstanceCandidateKey({ external_instance_id: "A1" }))
      .not.toBe(appInstanceCandidateKey({ external_instance_id: "B2" }));
  });

  it("no instance key → null (ambiguous, does not auto-resolve)", () => {
    expect(appInstanceCandidateKey({})).toBeNull();
  });
});

describe("category-specific contract guarantees", () => {
  it("a contract fact supports source_clause_text as provenance", () => {
    const result = parseDiscoveryFact({ ...FIXTURES.contract, source_clause_text: "Auto-renews unless 60 days notice." });
    expect(result.success).toBe(true);
  });

  it("an invoice/spend fact carries only CANDIDATE app linkage — a resolved app_id is rejected", () => {
    // app_candidate_name is allowed (a candidate); a final app_id linkage is NOT a valid field
    expect(parseDiscoveryFact(FIXTURES.invoice_spend).success).toBe(true);
    expect(parseDiscoveryFact({ ...FIXTURES.invoice_spend, app_id: "real-app-uuid" }).success).toBe(false);
    expect(parseDiscoveryFact({ ...FIXTURES.invoice_spend, canonical_app_id: "x" }).success).toBe(false);
  });

  it("app_user_account carries provider observations as booleans, and only as booleans", () => {
    // These exist so a DECLARATIVE field_map can carry them (`is_deleted: "deleted"`) without provider-specific
    // normalizer code. The bounded canonical vocabulary (account_kind / account_status) is derived from them in the
    // promote RPC — deliberately NOT here, so one place owns it.
    const observed = { ...FIXTURES.app_user_account, is_bot: true, is_deleted: false, is_admin: false };
    expect(parseDiscoveryFact(observed).success).toBe(true);
    // A provider that changed shape must fail closed rather than have a truthy string read as "bot".
    expect(parseDiscoveryFact({ ...FIXTURES.app_user_account, is_bot: "true" }).success).toBe(false);
    // Absent is not false: an unreported flag has to stay absent so the promoter can record `unknown`.
    expect("is_bot" in FIXTURES.app_user_account).toBe(false);
    // Still strict — an observation the canonical model has no room for is refused, not ignored.
    expect(parseDiscoveryFact({ ...FIXTURES.app_user_account, is_restricted: true }).success).toBe(false);
  });

  it("app_user_account does not require matched_person_id (future resolved output only)", () => {
    expect("matched_person_id" in FIXTURES.app_user_account).toBe(false);
    expect(parseDiscoveryFact(FIXTURES.app_user_account).success).toBe(true);
  });
});

// Static guards: the module is server-only design logic — its ONLY import is zod; no Supabase / db / provider
// client / fetch / service-role / connector_secrets / token handling.
describe("discovery-facts module is server-safe (only zod; no db/fetch/secrets/service-role)", () => {
  it("imports only zod and has no forbidden call/string", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const src = fs.readFileSync(path.resolve(__dirname, "discovery-facts.ts"), "utf8");
    const imports = [...src.matchAll(/from\s+["']([^"']+)["']/g)].map((m) => m[1]);
    expect(imports).toEqual(["zod"]); // the ONLY import
    const code = src.replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
    expect(code).not.toMatch(/createClient\s*\(/);
    expect(code).not.toMatch(/\bfetch\s*\(/); // no provider API call / no token exchange
    expect(code).not.toMatch(/process\.env/);
    // imports===["zod"] already proves there is no Supabase/service-role/db client to use here.
    // no live DB-write / ingestion execution function in this contract module
    expect(code).not.toMatch(/function\s+(run|execute|ingest|write|upsert|persist|insert|sync)[A-Za-z]*\s*\(/i);
    // no live OAuth/token machinery (these strings are NOT in the FORBIDDEN_FACT_KEYS reject-list, so a hit = real)
    for (const tok of ["token_endpoint", "grant_type", "https://", "createServiceClient"]) {
      expect(code).not.toContain(tok);
    }
  });
});

describe("standalone group fact (PR A — additive within schema v1, no migration)", () => {
  it("'group' is included in the discriminated union", () => {
    expect(ALL_TYPES).toContain("group");
    expect(parseDiscoveryFact(FIXTURES.group).success).toBe(true);
  });

  it("a valid group fact parses (required + optional fields)", () => {
    const r = parseDiscoveryFact(FIXTURES.group);
    expect(r.success).toBe(true);
  });

  it("a group fact WITHOUT group_external_id fails closed", () => {
    const f = { ...FIXTURES.group };
    delete f.group_external_id;
    expect(parseDiscoveryFact(f).success).toBe(false);
  });

  it("a group fact WITHOUT group_name fails closed", () => {
    const f = { ...FIXTURES.group };
    delete f.group_name;
    expect(parseDiscoveryFact(f).success).toBe(false);
  });

  it("an unknown / extra key on a group fact is rejected (strict)", () => {
    expect(parseDiscoveryFact({ ...FIXTURES.group, surprise_field: 1 }).success).toBe(false);
  });

  it("member_count must be a nonnegative integer", () => {
    expect(parseDiscoveryFact({ ...FIXTURES.group, member_count: -1 }).success).toBe(false);
    expect(parseDiscoveryFact({ ...FIXTURES.group, member_count: 1.5 }).success).toBe(false);
    expect(parseDiscoveryFact({ ...FIXTURES.group, member_count: 0 }).success).toBe(true);
  });
});
