import { describe, it, expect } from "vitest";
import {
  APP_IDENTITY_ALIAS_TYPE, appIdentifier, decideCanonicalLink, decisionToStatus, normalizeProductName,
  CANONICALIZATION_STATUSES, type AppIdentityRow,
} from "./app-canonicalization";
import { ALIAS_TYPES, DETERMINISTIC_ALIAS_TYPES, resolveCanonicalAlias } from "./application-alias";

const app = (over: Partial<AppIdentityRow> = {}): AppIdentityRow => ({
  id: "app-1", externalInstanceId: "T0123ABCD", canonicalAppId: null, ...over,
});

describe("the identifier this phase trusts", () => {
  it("uses external_instance_id — the ONLY alias class anything populates", () => {
    expect(APP_IDENTITY_ALIAS_TYPE).toBe("external_instance_id");
    // It must still be a real member of the 0024 vocabulary, and a deterministic one.
    expect(ALIAS_TYPES).toContain(APP_IDENTITY_ALIAS_TYPE);
    expect(DETERMINISTIC_ALIAS_TYPES).toContain(APP_IDENTITY_ALIAS_TYPE);
    // …and emphatically not the name class.
    expect(APP_IDENTITY_ALIAS_TYPE).not.toBe("name");
  });

  it("treats absent, empty and whitespace-only identifiers as no identifier", () => {
    expect(appIdentifier({ externalInstanceId: null })).toBeNull();
    expect(appIdentifier({ externalInstanceId: "" })).toBeNull();
    expect(appIdentifier({ externalInstanceId: "   " })).toBeNull();
  });

  it("trims but never folds case — an instance id is opaque and case-sensitive", () => {
    expect(appIdentifier({ externalInstanceId: "  T0123ABCD  " })).toBe("T0123ABCD");
    expect(appIdentifier({ externalInstanceId: "T0123abcd" })).toBe("T0123abcd");
  });
});

describe("names never establish identity", () => {
  it("normalizeProductName is a dedup key for a human label, not a matcher", () => {
    // It exists only to fill app_products.normalized_name so "Slack" entered twice collides on the natural key.
    expect(normalizeProductName("  Slack  ")).toBe("slack");
    expect(normalizeProductName("Slack   Technologies")).toBe("slack technologies");
    // Two products a fuzzy matcher would happily merge normalize DIFFERENTLY — nothing here declares them the same.
    expect(normalizeProductName("Slack")).not.toBe(normalizeProductName("Slack Enterprise Grid"));
  });

  it("the link decision never reads a name — identical names do not resolve", () => {
    // Same display name on both sides, no confirmed alias: the honest answer is unresolved.
    const d = decideCanonicalLink({ app: app(), resolvedAppProductId: null });
    expect(d).toEqual({ action: "unresolved", reason: "no_confirmed_alias" });
  });
});

describe("only a CONFIRMED alias resolves", () => {
  // decideCanonicalLink takes the Phase 18A1 resolver's output, so these prove the composition, not a reimplementation.
  const resolveWith = (reviewStatus: string) =>
    resolveCanonicalAlias(APP_IDENTITY_ALIAS_TYPE, { appProductId: "prod-1", reviewStatus });

  it("confirmed resolves and links", () => {
    const r = resolveWith("confirmed");
    expect(r.outcome).toBe("resolved");
    const d = decideCanonicalLink({ app: app(), resolvedAppProductId: r.outcome === "resolved" ? r.appProductId : null });
    expect(d).toEqual({ action: "link", appProductId: "prod-1" });
  });

  it("pending, rejected and auto do NOT resolve", () => {
    for (const status of ["pending", "rejected", "auto"]) {
      const r = resolveWith(status);
      expect(r.outcome, status).toBe("unresolved");
      const d = decideCanonicalLink({ app: app(), resolvedAppProductId: null });
      expect(d.action, status).toBe("unresolved");
    }
  });

  it("a name alias is structurally unsupported, whatever its review status", () => {
    expect(resolveCanonicalAlias("name", { appProductId: "prod-1", reviewStatus: "confirmed" }).outcome).toBe("unsupported");
  });
});

describe("the link decision", () => {
  it("links an unlinked app", () => {
    expect(decideCanonicalLink({ app: app(), resolvedAppProductId: "prod-1" }))
      .toEqual({ action: "link", appProductId: "prod-1" });
  });

  it("is idempotent when already pointing at the same product", () => {
    expect(decideCanonicalLink({ app: app({ canonicalAppId: "prod-1" }), resolvedAppProductId: "prod-1" }))
      .toEqual({ action: "already_linked", appProductId: "prod-1" });
  });

  it("REFUSES to silently repoint an app already linked elsewhere", () => {
    // Identity revision is a deliberate human act (0024 unmerges by repointing), never a side effect of a resolve.
    expect(decideCanonicalLink({ app: app({ canonicalAppId: "prod-OTHER" }), resolvedAppProductId: "prod-1" }))
      .toEqual({ action: "conflict", currentAppProductId: "prod-OTHER", resolvedAppProductId: "prod-1" });
  });

  it("reports no_identifier ahead of everything else — an app with none can never be canonicalized", () => {
    expect(decideCanonicalLink({ app: app({ externalInstanceId: null }), resolvedAppProductId: "prod-1" }))
      .toEqual({ action: "unresolved", reason: "no_identifier" });
  });

  it("distinguishes 'no identifier' from 'no confirmed alias' — different problems, different fixes", () => {
    const a = decideCanonicalLink({ app: app({ externalInstanceId: null }), resolvedAppProductId: null });
    const b = decideCanonicalLink({ app: app(), resolvedAppProductId: null });
    expect(a).not.toEqual(b);
  });

  it("lets one product own many apps — two different apps resolve to the same product", () => {
    // The multi-instance case 0024 exists for: two Slack workspaces, one canonical product.
    const w1 = decideCanonicalLink({ app: app({ id: "app-1", externalInstanceId: "T111" }), resolvedAppProductId: "prod-1" });
    const w2 = decideCanonicalLink({ app: app({ id: "app-2", externalInstanceId: "T222" }), resolvedAppProductId: "prod-1" });
    expect(w1).toEqual({ action: "link", appProductId: "prod-1" });
    expect(w2).toEqual({ action: "link", appProductId: "prod-1" });
  });
});

describe("the status vocabulary is bounded", () => {
  it("every decision maps into the closed status list", () => {
    const decisions = [
      decideCanonicalLink({ app: app(), resolvedAppProductId: "p" }),
      decideCanonicalLink({ app: app({ canonicalAppId: "p" }), resolvedAppProductId: "p" }),
      decideCanonicalLink({ app: app({ canonicalAppId: "q" }), resolvedAppProductId: "p" }),
      decideCanonicalLink({ app: app({ externalInstanceId: null }), resolvedAppProductId: "p" }),
      decideCanonicalLink({ app: app(), resolvedAppProductId: null }),
    ];
    for (const d of decisions) expect(CANONICALIZATION_STATUSES).toContain(decisionToStatus(d));
    expect(new Set(decisions.map(decisionToStatus)).size).toBe(5);
  });
});
