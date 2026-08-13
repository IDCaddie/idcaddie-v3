import { describe, it, expect } from "vitest";
import { COMMERCIAL_RULE_PROSE, commercialProse, toCommercialFindingView, formatOpportunity } from "./commercial-presenter";
import { COMMERCIAL_RULE_IDS, type CommercialFinding } from "@/lib/server/commercial-analytics/types";

// The commercial truthfulness boundary, enforced by machine rather than by review discipline. The access engine has the same
// guard for its own (different) boundary; this is the money one.

describe("prose coverage", () => {
  it("has reviewed copy for every rule in the catalog, and no copy for a rule that does not exist", () => {
    for (const id of COMMERCIAL_RULE_IDS) {
      const p = commercialProse(id);
      expect(p.title.length, id).toBeGreaterThan(0);
      expect(p.summary.length, id).toBeGreaterThan(0);
    }
    expect(Object.keys(COMMERCIAL_RULE_PROSE).sort()).toEqual([...COMMERCIAL_RULE_IDS].sort());
  });
});

describe("the commercial truthfulness boundary", () => {
  const rawCopy = Object.values(COMMERCIAL_RULE_PROSE)
    .flatMap((p) => [p.title, p.summary, p.guidance ?? ""])
    .join(" ")
    .toLowerCase();

  // The educational-disclaimer exception, the same one the access surface documents: a forbidden term is allowed inside an
  // explicit NEGATION, because saying "whether they are charged for is not represented" is the opposite of claiming it. Each
  // exception is listed literally and asserted to still exist, so the carve-out cannot quietly become a loophole — and the
  // scan below runs against the copy with those clauses removed, keeping it strict on everything affirmative.
  const DISCLAIMERS = ["whether they are still charged for is not represented"];
  const allCopy = DISCLAIMERS.reduce((text, d) => text.split(d).join(" "), rawCopy);

  it("keeps every documented disclaimer exception in place", () => {
    for (const d of DISCLAIMERS) expect(rawCopy, d).toContain(d);
  });

  it("never claims usage, activity, or that something is unused", () => {
    // No source produces any of these. Claiming one would be the single most misleading thing this feature could say.
    for (const word of ["unused", "not used", "never used", "inactive user", "last login", "last active", "idle", "dormant"]) {
      expect(allCopy, word).not.toContain(word);
    }
  });

  it("never claims a seat is billable", () => {
    // license_evaluations has existed since 0001 and has never been written by anything.
    for (const word of ["billable", "charged for", "you are paying for"]) {
      expect(allCopy, word).not.toContain(word);
    }
  });

  it("never instructs a removal", () => {
    for (const word of ["remove", "delete", "revoke", "safe to", "should be removed", "deprovision"]) {
      expect(allCopy, word).not.toContain(word);
    }
  });

  it("never presents an estimate as a realized saving, and never says 'critical'", () => {
    for (const word of ["you will save", "saved", "guaranteed", "critical"]) {
      expect(allCopy, word).not.toContain(word);
    }
    // The opportunity rule must describe itself as an estimate.
    expect(COMMERCIAL_RULE_PROSE.reducible_purchased_quantity.summary.toLowerCase()).toContain("estimate");
  });

  it("describes provider-inactive accounts as what the provider reports, not as waste", () => {
    const p = COMMERCIAL_RULE_PROSE.inactive_provisioned_accounts;
    expect(p.summary.toLowerCase()).toContain("provider");
    // It must explicitly disclaim the billing question rather than leave the reader to assume it.
    expect(p.summary.toLowerCase()).toContain("not represented");
  });
});

describe("view model", () => {
  const finding = (over: Partial<CommercialFinding> = {}): CommercialFinding => ({
    id: "commercial:purchase_exceeds_discovered:e1",
    ruleId: "purchase_exceeds_discovered",
    category: "reconciliation",
    severity: "medium",
    confidence: "high",
    subjectType: "entitlement",
    subjectId: "e1",
    relatedIds: [],
    evidence: { counts: { purchased: 3200, provisioned: 3011, surplus: 189 } },
    staleEvidence: false,
    detectedAt: "2026-08-12T00:00:00.000Z",
    ...over,
  });

  it("resolves prose, tone and labels from the shared severity scale", () => {
    const v = toCommercialFindingView(finding());
    expect(v.title).toBe(COMMERCIAL_RULE_PROSE.purchase_exceeds_discovered.title);
    expect(v.tone).toBe("attention");        // medium — the same tone the access findings use
    expect(v.severityLabel).toBe("Medium");
    expect(v.confidenceLabel).toBe("High confidence");
    expect(toCommercialFindingView(finding({ severity: "high" })).tone).toBe("danger");
  });

  it("carries the arithmetic wherever it carries money", () => {
    const v = toCommercialFindingView(
      finding({
        ruleId: "reducible_purchased_quantity",
        evidence: { counts: { reducibleQuantity: 189 }, money: { amount: 28350, currency: "USD", basis: "3200 purchased less 3011 retained…" } },
      }),
    );
    expect(v.money).toBe("$28,350 / year");
    expect(v.basis).toBeTruthy();
    // A money figure with no basis must be impossible to render.
    expect(v.money !== null && v.basis !== null).toBe(true);
  });

  it("shows no money where the engine attached none", () => {
    const v = toCommercialFindingView(finding({ ruleId: "inactive_provisioned_accounts", evidence: { counts: { inactive: 400 } } }));
    expect(v.money).toBeNull();
    expect(v.basis).toBeNull();
  });

  it("states where a figure came from, and how certain it is", () => {
    const v = toCommercialFindingView(
      finding({ evidence: { counts: {}, provenance: { source: "order_form", confidence: "high", hasEvidenceDocument: true } } }),
    );
    expect(v.provenanceNote).toBe("Figure read from the order form, with an attached document · high confidence");

    const manual = toCommercialFindingView(
      finding({ evidence: { counts: {}, provenance: { source: "manual_entry", confidence: "low", hasEvidenceDocument: false } } }),
    );
    expect(manual.provenanceNote).toBe("Figure entered manually · low confidence");
  });

  it("formats money in its own currency and never converts", () => {
    expect(formatOpportunity({ amount: 28350, currency: "USD" })).toContain("$");
    expect(formatOpportunity({ amount: 1890, currency: "GBP" })).toContain("£");
  });
});
