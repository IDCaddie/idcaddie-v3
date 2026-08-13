import { describe, it, expect } from "vitest";
import {
  ALIAS_TYPES,
  DETERMINISTIC_ALIAS_TYPES,
  RESOLVING_REVIEW_STATUSES,
  isAliasType,
  isDeterministicAliasType,
  normalizeAliasValue,
  resolveCanonicalAlias,
} from "./application-alias";

// Phase 18A pure layer, resolution only. The property that matters most is negative: there is NO path from a name to a
// canonical product, and no unsettled status resolves.

const confirmed = (appProductId: string) => ({ appProductId, reviewStatus: "confirmed" });

describe("deterministic alias vocabulary — name is excluded structurally, not by convention", () => {
  it("resolves every alias type EXCEPT name, and the exclusion is exactly one member", () => {
    expect(DETERMINISTIC_ALIAS_TYPES).toEqual(["domain", "instance_domain", "external_instance_id", "provider_app_id", "oauth_client_id", "sso_app_id"]);
    expect(ALIAS_TYPES.length - DETERMINISTIC_ALIAS_TYPES.length).toBe(1);
    expect(isDeterministicAliasType("name")).toBe(false);
    expect((DETERMINISTIC_ALIAS_TYPES as readonly string[]).includes("name")).toBe(false);
  });

  it("mirrors the 0024 CHECK vocabulary exactly, so schema drift fails loudly", () => {
    expect(ALIAS_TYPES).toEqual(["domain", "instance_domain", "external_instance_id", "provider_app_id", "oauth_client_id", "sso_app_id", "name"]);
    expect(isAliasType("name")).toBe(true);
    expect(isAliasType("logo_hash")).toBe(false);
  });
});

describe("resolveCanonicalAlias", () => {
  it("an exact deterministic identifier resolves to exactly one product", () => {
    expect(resolveCanonicalAlias("provider_app_id", confirmed("prod-1"))).toEqual({ outcome: "resolved", appProductId: "prod-1" });
  });

  it("every deterministic type resolves — resolution is not provider- or type-specific", () => {
    for (const t of DETERMINISTIC_ALIAS_TYPES) {
      expect(resolveCanonicalAlias(t, confirmed("prod-1"))).toEqual({ outcome: "resolved", appProductId: "prod-1" });
    }
  });

  it("no alias row is unresolved, never a guess", () => {
    expect(resolveCanonicalAlias("provider_app_id", null)).toEqual({ outcome: "unresolved" });
  });

  it("alias_type=name is refused for deterministic resolution even when a row exists", () => {
    expect(resolveCanonicalAlias("name", confirmed("prod-1"))).toEqual({ outcome: "unsupported", aliasType: "name" });
    expect(resolveCanonicalAlias("name", null)).toEqual({ outcome: "unsupported", aliasType: "name" });
  });

  it("an alias type outside the schema vocabulary is unsupported, not silently resolved", () => {
    expect(resolveCanonicalAlias("logo_hash", confirmed("prod-1"))).toEqual({ outcome: "unsupported", aliasType: "logo_hash" });
  });

  it("ONLY 'confirmed' resolves — every other status in the 0024 CHECK reads as unresolved", () => {
    // 'auto' is excluded deliberately: the CHECK admits it, but nothing defines it, nothing writes it, and the only implemented
    // review lifecycle (discovery_facts) goes pending → confirmed | rejected. Resolving an undefined status as canonical truth
    // is the failure this layer exists to prevent.
    expect(RESOLVING_REVIEW_STATUSES).toEqual(["confirmed"]);
    for (const reviewStatus of ["pending", "rejected", "auto"]) {
      expect(resolveCanonicalAlias("provider_app_id", { appProductId: "p", reviewStatus })).toEqual({ outcome: "unresolved" });
    }
    expect(resolveCanonicalAlias("provider_app_id", { appProductId: "p", reviewStatus: "confirmed" })).toEqual({ outcome: "resolved", appProductId: "p" });
  });

  it("an unexpected, cased or empty review_status can never resolve", () => {
    for (const reviewStatus of ["", "needs_review", "CONFIRMED", "accepted", "Confirmed"]) {
      expect(resolveCanonicalAlias("provider_app_id", { appProductId: "p", reviewStatus })).toEqual({ outcome: "unresolved" });
    }
  });

  it("the same alias resolves identically on repeat; resolution is a pure function of its inputs", () => {
    const row = confirmed("prod-1");
    const a = resolveCanonicalAlias("provider_app_id", row);
    expect(resolveCanonicalAlias("provider_app_id", row)).toEqual(a);
    expect(resolveCanonicalAlias("provider_app_id", { ...row })).toEqual(a);
  });

  it("resolution has no notion of a source row, so source freshness cannot influence it", () => {
    // CanonicalAliasRow carries only the judgement. A caller cannot pass sync_status, a label, or a directory id even by mistake.
    expect(Object.keys(confirmed("prod-1")).sort()).toEqual(["appProductId", "reviewStatus"]);
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
