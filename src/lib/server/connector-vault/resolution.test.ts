import { describe, it, expect } from "vitest";
import {
  confidenceRank,
  classifyResolutionConfidence,
  appResolutionSignals,
  explainResolutionDecision,
  sameOperationalInstance,
  normalizeEmail,
  identityMatchSignals,
  type DiscoveryResolutionInput,
} from "./resolution";

// Atlassian multi-instance fixtures — Flywheel vs Perpetua must stay distinct apps rows under the same product.
const FLYWHEEL: DiscoveryResolutionInput = {
  vendorName: "Atlassian", productName: "Jira", instanceDomain: "flywheel.atlassian.net",
  instanceUrl: "https://flywheel.atlassian.net",
};
const PERPETUA: DiscoveryResolutionInput = {
  vendorName: "Atlassian", productName: "Jira", instanceDomain: "perpetua.atlassian.net",
  instanceUrl: "https://perpetua.atlassian.net",
};

describe("resolver confidence classification — deterministic-first, probabilistic-second, fail-closed", () => {
  it("deterministic confidence outranks name-similarity confidence", () => {
    const deterministic = classifyResolutionConfidence(["instance_domain"]);
    const nameSimilarity = classifyResolutionConfidence(["vendor_name_similarity"]);
    expect(deterministic).toBe("deterministic");
    expect(nameSimilarity).toBe("probabilistic_low");
    // the load-bearing ordering: a deterministic key always beats a fuzzy name match
    expect(confidenceRank(deterministic)).toBeGreaterThan(confidenceRank(nameSimilarity));
  });

  it("any deterministic signal wins even mixed with probabilistic ones", () => {
    expect(classifyResolutionConfidence(["vendor_name_similarity", "external_instance_id"])).toBe("deterministic");
    expect(classifyResolutionConfidence(["verified_external_id"])).toBe("deterministic");
  });

  it("two probabilistic signals = high, one = low, none = human_review (fail closed)", () => {
    expect(classifyResolutionConfidence(["vendor_name_similarity", "domain_similarity"])).toBe("probabilistic_high");
    expect(classifyResolutionConfidence(["product_name_similarity"])).toBe("probabilistic_low");
    expect(classifyResolutionConfidence([])).toBe("human_review");
  });

  it("only a deterministic match auto-assigns; everything else routes to human review", () => {
    expect(explainResolutionDecision(["instance_domain"]).action).toBe("auto_assign");
    expect(explainResolutionDecision(["exact_normalized_email"]).action).toBe("auto_assign");
    // probabilistic-only must NOT auto-merge
    expect(explainResolutionDecision(["vendor_name_similarity", "domain_similarity"]).action).toBe("human_review");
    expect(explainResolutionDecision(["product_name_similarity"]).action).toBe("human_review");
  });

  it("unknown / ambiguous input (no signal) routes to human_review", () => {
    const decision = explainResolutionDecision([]);
    expect(decision.action).toBe("human_review");
    expect(decision.confidence).toBe("human_review");
    expect(decision.reasons.join(" ")).toMatch(/fail closed/i);
  });

  it("appResolutionSignals extracts only the present deterministic keys", () => {
    expect(appResolutionSignals(FLYWHEEL)).toEqual(["instance_domain", "instance_url"]);
    expect(appResolutionSignals({})).toEqual([]);
    expect(appResolutionSignals({ instanceDomain: "   " })).toEqual([]); // blank is not present
  });
});

describe("no blind merging — distinct instances stay separate apps rows", () => {
  it("distinct instance_domain values do NOT produce an auto-merge", () => {
    // Atlassian/Jira/Flywheel vs Atlassian/Jira/Perpetua — same vendor+product, different instance_domain
    expect(sameOperationalInstance(FLYWHEEL, PERPETUA)).toBe(false);
  });

  it("same instance_domain is the same operational instance", () => {
    expect(sameOperationalInstance(FLYWHEEL, { ...FLYWHEEL, productName: "Jira (re-discovered)" })).toBe(true);
  });

  it("a differing external_instance_id blocks a merge even if domains match", () => {
    const a: DiscoveryResolutionInput = { instanceDomain: "x.atlassian.net", externalInstanceId: "A1" };
    const b: DiscoveryResolutionInput = { instanceDomain: "x.atlassian.net", externalInstanceId: "B2" };
    expect(sameOperationalInstance(a, b)).toBe(false);
  });

  it("an owning-org conflict blocks a merge (owner/paying/responsible org influences merge/no-merge)", () => {
    const a: DiscoveryResolutionInput = { instanceDomain: "x.atlassian.net", ownerOrgId: "org-1" };
    const b: DiscoveryResolutionInput = { instanceDomain: "x.atlassian.net", ownerOrgId: "org-2" };
    expect(sameOperationalInstance(a, b)).toBe(false);
  });

  it("no shared merge key → not the same instance (fail closed, no blind merge)", () => {
    expect(sameOperationalInstance({ vendorName: "Atlassian" }, { vendorName: "Atlassian" })).toBe(false);
  });
});

describe("identity matching — app_user → person, deterministic-first, no identity_account_id", () => {
  it("exact normalized email is a deterministic identity match", () => {
    const signals = identityMatchSignals({ email: "Jane.Doe@ACME.com " }, { email: "jane.doe@acme.com" });
    expect(signals).toContain("exact_normalized_email");
    expect(classifyResolutionConfidence(signals)).toBe("deterministic");
  });

  it("different emails do not match deterministically (routes to review)", () => {
    const signals = identityMatchSignals({ email: "a@acme.com" }, { email: "b@acme.com" });
    expect(signals).toEqual([]);
    expect(explainResolutionDecision(signals).action).toBe("human_review");
  });

  it("a matching verified external id is deterministic", () => {
    expect(identityMatchSignals({ verifiedExternalId: "okta|123" }, { verifiedExternalId: "okta|123" }))
      .toEqual(["verified_external_id"]);
  });

  it("normalizeEmail trims/lowercases and rejects blanks/non-emails", () => {
    expect(normalizeEmail("  Foo@Bar.com ")).toBe("foo@bar.com");
    expect(normalizeEmail("")).toBeNull();
    expect(normalizeEmail("not-an-email")).toBeNull();
    expect(normalizeEmail(null)).toBeNull();
  });
});

// Static guards: the module is pure server-only design logic — no DB / Supabase / provider client / fetch /
// connector_secrets / token handling, no identity_account_id, no client/browser imports.
describe("resolution module is server-safe + pure (no secrets/tokens/db/fetch/identity_account_id)", () => {
  it("has no imports and no forbidden call/string", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const src = fs.readFileSync(path.resolve(__dirname, "resolution.ts"), "utf8");
    const imports = [...src.matchAll(/from\s+["']([^"']+)["']/g)].map((m) => m[1]);
    expect(imports).toEqual([]); // pure TS — no module imports at all
    const code = src.replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
    expect(code).not.toMatch(/createClient\s*\(/);
    expect(code).not.toMatch(/\bfetch\s*\(/); // no provider API call / no token exchange
    expect(code).not.toMatch(/process\.env/);
    const secretsTable = ["connector", "secrets"].join("_");
    expect(code).not.toContain(secretsTable);
    const serviceRole = ["service", "role"].join("_");
    expect(code).not.toContain(serviceRole);
    // the match graph is app_user → person — NO identity_account_id is introduced
    expect(code).not.toContain(["identity", "account", "id"].join("_"));
    // no token/credential machinery, and no live OAuth authorize URL
    for (const tok of ["access_token", "refresh_token", "token_endpoint", "grant_type", "client_secret", "https://"]) {
      expect(code).not.toContain(tok);
    }
    // no live resolver/merge EXECUTION (a write/run function) lives here — pure classification only
    expect(code).not.toMatch(/function\s+(run|execute|merge|write|upsert|persist|sync)[A-Za-z]*\s*\(/i);
  });
});
