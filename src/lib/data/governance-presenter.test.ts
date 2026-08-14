import { describe, it, expect } from "vitest";
import {
  RULE_PROSE, ruleProse, severityTone, severityLabel, confidenceLabel,
  CROSS_SOURCE_PROSE, crossSourceProse,
} from "./governance-presenter";
import { evaluateCrossSourceGovernance } from "@/lib/server/cross-source-governance/evaluate";
import type { GovernanceRuleId } from "@/lib/server/governance-analytics/types";
import type { CrossSourceGraph } from "@/lib/server/cross-source-governance/types";

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

// ── Phase 18D — cross-source copy ─────────────────────────────────────────────────────────────────────────────────────
// There is still NO live customer renderer for cross-source findings (nothing in src/ reads `product_governance_findings`),
// so this suite pins the CONTRACT instead of a screen: every key the engine can stamp resolves to reviewed copy, and that
// copy says only what the rule proves.
describe("cross-source presenter — resolvable + truthful", () => {
  const RULE = "crossSource.discovered_application_unmanaged_by_idp";
  const VARIANTS = ["product_unresolved", "operational_instance_absent", "operational_match_unaccepted"] as const;
  const blobOf = (stem: string) => {
    const p = crossSourceProse(`${stem}.title`)!;
    return `${p.title} ${p.summary} ${p.guidance ?? ""}`.toLowerCase();
  };

  // R15 — the keys the ENGINE actually emits, not a hand-copied list. A rename in evaluate.ts that forgot the presenter
  // fails here rather than shipping a raw key to a customer.
  it("resolves every title key rule 5 can emit, over all three subtypes", () => {
    const OKTA = "22222222-2222-4222-8222-222222222222";
    const graph = (candidates: CrossSourceGraph["applicationCandidates"]): CrossSourceGraph => ({
      tenantId: "11111111-1111-4111-8111-111111111111",
      capabilities: [{ connectionId: OKTA, provider: "okta", capability: "directory_applications", state: "available" }],
      identityAccounts: [], appAccounts: [], personAccountLinks: [], applicationMatches: [],
      directoryApplications: ["app1", "app2", "app3"].map(id => ({
        id, connectionId: OKTA, provider: "okta", syncStatus: "current" as const,
      })),
      applicationCandidates: candidates,
      matcherState: { hasEverRun: true, status: "completed", lastCompletedAt: "2026-01-01T00:00:00Z" },
    });
    const findings = evaluateCrossSourceGovernance(graph([
      { directoryApplicationId: "app2", appProductId: "prod1", appId: null },
      { directoryApplicationId: "app3", appProductId: "prod1", appId: "opsapp1" },
    ])).findings;

    expect(findings).toHaveLength(3);
    expect(new Set(findings.map(f => f.evidence.reason)).size).toBe(3);
    for (const f of findings) {
      for (const key of [f.title_key, f.summary_key, f.remediation_key!]) {
        const p = crossSourceProse(key);
        expect(p, `unresolvable copy key: ${key}`).not.toBeNull();
        expect(p!.title.trim().length).toBeGreaterThan(0);
        expect(p!.summary.trim().length).toBeGreaterThan(0);
        expect(p!.guidance?.trim().length).toBeGreaterThan(0);
      }
    }
  });

  // R14 — an unknown subtype must degrade to the BROAD rule sentence, which is true of every subtype, rather than
  // failing or leaking the key. An unknown RULE has nothing truthful to say and returns null.
  it("falls back to broad copy for an unknown subtype, and refuses an unknown rule", () => {
    expect(crossSourceProse(`${RULE}.some_future_state.title`)).toEqual(CROSS_SOURCE_PROSE[RULE]);
    expect(crossSourceProse(`${RULE}.title`)).toEqual(CROSS_SOURCE_PROSE[RULE]);
    expect(crossSourceProse("crossSource.a_rule_this_build_does_not_have.title")).toBeNull();
    expect(crossSourceProse("governance.redundant_direct_access.title")).toBeNull();
    // The fallback is the BROAD claim, so it must not name a subtype-specific action.
    expect(blobOf(RULE)).not.toMatch(/recognized|identification|candidates/);
  });

  // REVIEW FIX 2. The argument is an arbitrary persisted string and `CROSS_SOURCE_PROSE` is a plain object literal, so
  // every `Object.prototype` member is reachable by name. Each of these returned a FUNCTION (or the prototype) before
  // the `Object.hasOwn` guard — truthy, typed `RuleProse`, and `undefined` in every field a renderer would print.
  it.each(["constructor", "toString", "valueOf", "hasOwnProperty", "__proto__", "completely_unknown_key"])(
    "the prototype key %s takes the broad fallback, not an inherited property",
    key => {
      for (const form of [key, `${key}.title`, `${RULE}.${key}`, `${RULE}.${key}.title`]) {
        const p = crossSourceProse(form);
        // A rule-scoped form falls back to the broad rule copy; a bare prototype name names no rule at all.
        const expected = form.startsWith(`${RULE}.`) ? CROSS_SOURCE_PROSE[RULE] : null;
        expect(p, `crossSourceProse(${JSON.stringify(form)})`).toEqual(expected);
        if (p === null) continue;
        // Not truthiness — the actual fields, and the actual type.
        expect(typeof p).toBe("object");
        expect(typeof p.title).toBe("string");
        expect(typeof p.summary).toBe("string");
        expect(typeof p.guidance).toBe("string");
        expect(p.title.trim().length).toBeGreaterThan(0);
        expect(p.summary.trim().length).toBeGreaterThan(0);
        expect((p.guidance ?? "").trim().length).toBeGreaterThan(0);
        // Nothing internal leaks: no function, no enum name, no key echo.
        for (const v of [p.title, p.summary, p.guidance ?? ""]) {
          expect(v).not.toMatch(/function|\[object|crossSource\.|product_unresolved|operational_/);
          expect(v).not.toContain(key);
        }
      }
    },
  );

  it("no cross-source copy uses a forbidden/unsupported term", () => {
    for (const stem of Object.keys(CROSS_SOURCE_PROSE)) {
      const blob = blobOf(stem);
      for (const term of FORBIDDEN) {
        expect(blob.includes(term), `${stem} copy must not contain "${term}": ${blob}`).toBe(false);
      }
      for (const bad of ["remove", "delete", "revoke", "reclaim"]) {
        expect(blob.includes(bad), `${stem} copy must not say "${bad}"`).toBe(false);
      }
    }
  });

  // R10 — the unresolved variant may not claim anything about contracts, spend or licences. The rule read
  // `directory_applications`, `application_matches` and one alias feed; it never looked at a contract.
  it("the unresolved-product copy never claims a contract, spend or licence fact", () => {
    const blob = blobOf(`${RULE}.product_unresolved`);
    for (const term of ["contract", "spend", "cost", "subscription", "renewal", "vendor", "invoice", "seat"]) {
      expect(blob.includes(term), `unresolved copy must not mention "${term}": ${blob}`).toBe(false);
    }
  });

  // R11 — and the two operational variants may not call the software unidentified. A confirmed alias has already
  // identified it; saying otherwise sends a customer to redo work the product accepted.
  it("the operational-subtype copy never says the product is unidentified", () => {
    for (const variant of ["operational_instance_absent", "operational_match_unaccepted"]) {
      const blob = blobOf(`${RULE}.${variant}`);
      for (const term of ["unidentified", "unrecognized", "unrecognised", "not been matched", "unknown", "identify"]) {
        expect(blob.includes(term), `${variant} copy must not mention "${term}": ${blob}`).toBe(false);
      }
      expect(blob).toContain("recognized");
    }
  });

  // The instance-absent variant must not imply a candidate list exists to review, and the candidates variant must not
  // imply exactly one. Both are the "no false precision" boundary, in the copy rather than in a comment.
  it("neither operational variant overstates what is available", () => {
    expect(blobOf(`${RULE}.operational_instance_absent`)).not.toMatch(/candidate|proposed|match(es)?\b/);
    const c = blobOf(`${RULE}.operational_match_unaccepted`);
    expect(c).not.toMatch(/\bthe candidate\b|\bexactly one\b|\bthe correct candidate\b/);
    expect(c).toContain("candidates");
  });

  // REVIEW FIX 3. AVAILABLE IS PROVEN; PROPOSED IS NOT.
  //
  // `operational_match_unaccepted` means the feed returned at least one concrete `app_id` and no match is accepted. It
  // does NOT establish that those candidates currently sit at `status = 'proposed'` — a reviewer may already have
  // REJECTED every one of them, and this subtype deliberately covers both. Proving proposal state needs per-candidate
  // match statuses, which this phase does not read.
  //
  // Asserted FIELD BY FIELD. The blob check above passes on the summary's "candidates" alone, so a guidance line
  // rewritten to "review the proposed matches" survived it — the reviewer's M19. Each field now carries its own claim.
  it("the candidates variant says AVAILABLE and never asserts a proposal exists", () => {
    const p = crossSourceProse(`${RULE}.operational_match_unaccepted.title`)!;
    const fields = { title: p.title, summary: p.summary, guidance: p.guidance ?? "" };

    // The wording that IS proven: candidates exist, none accepted, a human should review them.
    expect(fields.title.toLowerCase()).toContain("review");
    expect(fields.summary.toLowerCase()).toContain("available");
    expect(fields.summary.toLowerCase()).toContain("none has been accepted");
    expect(fields.guidance.toLowerCase()).toContain("review");
    expect(fields.guidance.toLowerCase()).toContain("available");

    for (const [name, value] of Object.entries(fields)) {
      const v = value.toLowerCase();
      // Proposal state — the claim the read does not support, in any inflection.
      for (const term of ["proposed", "proposal", "proposals", "pending review", "awaiting review", "suggested"]) {
        expect(v.includes(term), `${name} must not claim "${term}": ${value}`).toBe(false);
      }
      // Singling out a candidate, or asserting how many there are.
      for (const term of ["the candidate", "this candidate", "exactly one", "the only", "a single", "best match"]) {
        expect(v.includes(term), `${name} must not claim "${term}": ${value}`).toBe(false);
      }
      // Plural or nothing: the read proves ">= 1", never "1".
      expect(v, `${name}: ${value}`).not.toMatch(/\ba candidate\b|\bone candidate\b/);
    }
  });
});
