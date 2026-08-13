import { describe, it, expect } from "vitest";
import {
  ALIAS_TYPES,
  DECLARABLE_ALIAS_TYPES,
  DETERMINISTIC_ALIAS_TYPES,
  classifyAliasWriteError,
  isDeclarableAliasType,
  isDeterministicAliasType,
  isEligibleDeclarationSource,
  normalizeAliasValue,
  planDeclaration,
  resolveCanonicalAlias,
} from "./application-alias";

// Phase 18A pure layer. The property that matters most is negative: there is NO path from a name to a canonical product.

const confirmed = (appProductId: string) => ({ appProductId, reviewStatus: "confirmed" });

describe("deterministic alias vocabulary — name is excluded structurally, not by convention", () => {
  it("resolves every alias type EXCEPT name, and the exclusion is exactly one member", () => {
    expect(DETERMINISTIC_ALIAS_TYPES).toEqual(["domain", "instance_domain", "external_instance_id", "provider_app_id", "oauth_client_id", "sso_app_id"]);
    expect(ALIAS_TYPES.length - DETERMINISTIC_ALIAS_TYPES.length).toBe(1);
    expect(isDeterministicAliasType("name")).toBe(false);
    expect((DETERMINISTIC_ALIAS_TYPES as readonly string[]).includes("name")).toBe(false);
  });

  it("permits declaring ONLY provider_app_id — the one type with a real current source field", () => {
    // directory_applications.external_id is the only identifier column the directory side exposes (0057). The other
    // deterministic types stay disabled until a source field actually carries their semantics.
    expect(DECLARABLE_ALIAS_TYPES).toEqual(["provider_app_id"]);
    for (const t of ["sso_app_id", "oauth_client_id", "external_instance_id", "instance_domain", "domain", "name"]) {
      expect(isDeclarableAliasType(t)).toBe(false);
    }
  });
});

describe("resolveCanonicalAlias", () => {
  it("1 — an exact provider_app_id alias resolves to exactly one product", () => {
    expect(resolveCanonicalAlias("provider_app_id", confirmed("prod-1"))).toEqual({ outcome: "resolved", appProductId: "prod-1" });
  });

  it("2 — no alias row is unresolved, never a guess", () => {
    expect(resolveCanonicalAlias("provider_app_id", null)).toEqual({ outcome: "unresolved" });
  });

  it("3 — alias_type=name is refused for deterministic resolution even when a row exists", () => {
    expect(resolveCanonicalAlias("name", confirmed("prod-1"))).toEqual({ outcome: "unsupported", aliasType: "name" });
    expect(resolveCanonicalAlias("name", null)).toEqual({ outcome: "unsupported", aliasType: "name" });
  });

  it("3b — an alias type outside the schema vocabulary is unsupported, not silently resolved", () => {
    expect(resolveCanonicalAlias("logo_hash", confirmed("prod-1"))).toEqual({ outcome: "unsupported", aliasType: "logo_hash" });
  });

  it("6 — the same canonical alias resolves identically on repeat; resolution is a pure function of its inputs", () => {
    const row = confirmed("prod-1");
    const a = resolveCanonicalAlias("provider_app_id", row);
    expect(resolveCanonicalAlias("provider_app_id", row)).toEqual(a);
    expect(resolveCanonicalAlias("provider_app_id", { ...row })).toEqual(a);
  });

  it("ONLY 'confirmed' resolves — every other status in the 0024 CHECK reads as unresolved", () => {
    // 'auto' is excluded deliberately: the CHECK admits it, but nothing defines it, nothing writes it, and the only implemented
    // review lifecycle (discovery_facts) goes pending → confirmed | rejected. Resolving an undefined status as canonical truth
    // is the failure this layer exists to prevent.
    for (const reviewStatus of ["pending", "rejected", "auto"]) {
      expect(resolveCanonicalAlias("provider_app_id", { appProductId: "p", reviewStatus })).toEqual({ outcome: "unresolved" });
    }
    expect(resolveCanonicalAlias("provider_app_id", { appProductId: "p", reviewStatus: "confirmed" })).toEqual({ outcome: "resolved", appProductId: "p" });
  });

  it("an unexpected or empty review_status can never resolve", () => {
    for (const reviewStatus of ["", "needs_review", "CONFIRMED", "accepted"]) {
      expect(resolveCanonicalAlias("provider_app_id", { appProductId: "p", reviewStatus })).toEqual({ outcome: "unresolved" });
    }
  });
});

describe("normalizeAliasValue — trims, and deliberately does NOT fold case", () => {
  it("trims surrounding whitespace so a pasted identifier is idempotent against the 0026 natural key", () => {
    expect(normalizeAliasValue("  0oa1b2c3  ")).toBe("0oa1b2c3");
  });
  it("preserves case — a provider application id is a case-sensitive opaque string", () => {
    expect(normalizeAliasValue("0oaAbC")).toBe("0oaAbC");
  });
});

describe("planDeclaration — human decisions outrank a re-submitted declaration", () => {
  it("7 — no existing row inserts", () => {
    expect(planDeclaration(null, "prod-1")).toEqual({ action: "insert" });
  });
  it("8 — the same product again is an idempotent no-op, not a second row", () => {
    expect(planDeclaration(confirmed("prod-1"), "prod-1")).toEqual({ action: "unchanged" });
  });
  it("9 — a DIFFERENT product conflicts; last-write-wins is not a canonical identity policy", () => {
    expect(planDeclaration(confirmed("prod-1"), "prod-2")).toEqual({ action: "conflict", reason: "different_product" });
  });
  it("15 — a rejected mapping is preserved: re-declaring the same product still conflicts", () => {
    expect(planDeclaration({ appProductId: "prod-1", reviewStatus: "rejected" }, "prod-1")).toEqual({ action: "conflict", reason: "rejected" });
  });
  it("a pending row for the same product is left alone rather than auto-promoted to confirmed", () => {
    expect(planDeclaration({ appProductId: "prod-1", reviewStatus: "pending" }, "prod-1")).toEqual({ action: "unchanged" });
  });
});

describe("isEligibleDeclarationSource — provider freshness and canonical judgement are separate facts", () => {
  it("13 — only a current directory application may MINT new canonical identity", () => {
    expect(isEligibleDeclarationSource("current")).toBe(true);
    for (const s of ["stale", "review_required", "disconnected"]) expect(isEligibleDeclarationSource(s)).toBe(false);
  });
});

describe("classifyAliasWriteError — never discloses whether a cross-tenant row exists", () => {
  it("maps RLS denial, CHECK violation and the same-tenant FK to one indistinguishable label", () => {
    expect(classifyAliasWriteError("42501")).toBe("not_allowed");
    expect(classifyAliasWriteError("23514")).toBe("not_allowed");
    expect(classifyAliasWriteError("23503")).toBe("not_allowed");
  });
  it("maps the 0026 natural-key violation to conflict, and anything else to query_failed", () => {
    expect(classifyAliasWriteError("23505")).toBe("conflict");
    expect(classifyAliasWriteError("08006")).toBe("query_failed");
    expect(classifyAliasWriteError(null)).toBe("query_failed");
  });
});
