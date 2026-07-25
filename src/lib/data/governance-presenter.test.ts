import { describe, it, expect } from "vitest";
import { RULE_PROSE, ruleProse, severityTone, severityLabel, confidenceLabel } from "./governance-presenter";
import type { GovernanceRuleId } from "@/lib/server/governance-analytics/types";

// The full rule catalog (must match GovernanceRuleId exactly — RULE_PROSE is a Record<GovernanceRuleId,…> so any missing rule is a compile
// error; this list is the runtime backstop that the count/coverage never silently drifts).
const ALL_RULES: GovernanceRuleId[] = [
  "redundant_direct_access", "identity_without_effective_access", "group_without_application_reach", "application_without_effective_identities",
  "direct_assignment_with_stale_endpoint", "group_assignment_with_stale_endpoint", "stale_only_effective_access",
  "identity_broad_access", "group_broad_application_reach", "duplicate_inherited_access_paths",
  "assignment_missing_identity", "assignment_missing_group", "assignment_missing_application",
  "membership_missing_identity", "membership_missing_group", "cross_scope_edge_ignored", "wrong_provider_edge_ignored",
];

// docs/71 forbidden vocabulary — the presenter must never imply usage/license/cost/inactivity/compliance/safe-removal, and topology alone
// is never "critical".
const FORBIDDEN = [
  "unused", "unlicensed", "waste", "wasted", "savings", "save money", "reclaim", "recover license", "license consumed", "license recovered",
  "inactive", "last login", "last-login", "safe to remove", "remove safely", "safe removal", "deprovision",
  "compliance", "violation", "breach", "shadow it", "usage", "over-provision", "overprovision", "over provisioned", "critical", "orphaned",
];

describe("governance presenter — exhaustive + truthful", () => {
  it("maps EVERY GovernanceRuleId to non-empty title + summary (exhaustive, 17 rules)", () => {
    expect(Object.keys(RULE_PROSE).sort()).toEqual([...ALL_RULES].sort());
    expect(Object.keys(RULE_PROSE)).toHaveLength(17);
    for (const id of ALL_RULES) {
      const p = ruleProse(id);
      expect(p.title.trim().length, `${id} title`).toBeGreaterThan(0);
      expect(p.summary.trim().length, `${id} summary`).toBeGreaterThan(0);
    }
  });

  it("no rule copy uses a forbidden/unsupported term (usage/license/cost/inactivity/compliance/safe-removal/critical)", () => {
    for (const id of ALL_RULES) {
      const p = ruleProse(id);
      const blob = `${p.title} ${p.summary} ${p.guidance ?? ""}`.toLowerCase();
      for (const term of FORBIDDEN) {
        expect(blob.includes(term), `${id} copy must not contain "${term}": ${blob}`).toBe(false);
      }
    }
  });

  it("no guidance recommends removal/deletion (review-only wording)", () => {
    for (const id of ALL_RULES) {
      const g = (ruleProse(id).guidance ?? "").toLowerCase();
      for (const bad of ["remove", "delete", "revoke", "reclaim"]) expect(g.includes(bad), `${id} guidance must not say "${bad}"`).toBe(false);
    }
  });

  it("severity/confidence render as bounded labels + tones (never 'critical')", () => {
    expect(severityTone("high")).toBe("danger");
    expect(severityTone("medium")).toBe("attention");
    expect(severityTone("low")).toBe("neutral");
    expect(severityTone("info")).toBe("neutral");
    expect(severityLabel("high")).toBe("High");
    expect(confidenceLabel("medium")).toBe("Medium confidence");
    // there is no "critical" severity in the type; the tone map has exactly 4 keys
  });
});
