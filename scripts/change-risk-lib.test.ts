import { describe, it, expect } from "vitest";
import { classifyChangeRisk } from "./change-risk-lib.mjs";

// Baseline risk classification is deterministic path evidence ONLY (ENGINEERING_STANDARDS.md §B/§C). These tests pin
// the tier rules and — more importantly — the two properties that make the output safe to act on: highest-tier-wins
// regardless of input order, and non-empty reasons on every result.

const tier = (paths: string[]) => classifyChangeRisk(paths).baselineRiskTier;

describe("baselineRiskTier — single-category diffs", () => {
  it("docs-only => T0, and a doc ABOUT a trust boundary is still T0 (no keyword escalation out of a filename)", () => {
    expect(tier(["docs/05_ENGINEERING_CHANGELOG.md", "README.md"])).toBe("T0");
    expect(tier(["docs/02_SECURITY_AND_RLS.md"])).toBe("T0");
    expect(tier(["supabase/tests/rls_test_plan.md"])).toBe("T0");
  });

  it("UI-only => T1, including every page under the `(authenticated)` route group", () => {
    expect(tier(["src/app/(authenticated)/apps/page.tsx", "src/components/nav.tsx", "src/app/globals.css"])).toBe("T1");
  });

  it("connector discovery => T2", () => {
    expect(tier(["src/lib/server/connectors/okta-discovery.ts"])).toBe("T2");
  });

  it("governance computation => T2", () => {
    expect(tier(["src/lib/server/governance-analytics/unused-license-rule.ts"])).toBe("T2");
  });

  it("migration => T3", () => {
    expect(tier(["supabase/migrations/0099_example.sql"])).toBe("T3");
  });

  it("OAuth / KMS / RLS / credentials => T3, wherever in the tree they live", () => {
    // The OAuth callback route lives under src/app/ — a naive `src/app/ => T1` rule would tier the single most
    // security-sensitive route in the repo as presentation.
    expect(tier(["src/app/(authenticated)/connectors/oauth/callback/route.ts"])).toBe("T3");
    expect(tier(["src/lib/server/connector-vault/aws-kms-client.ts"])).toBe("T3");
    expect(tier(["supabase/tests/org_rls_test.sql"])).toBe("T3");
    expect(tier(["scripts/check-auth-safety.sh"])).toBe("T3");
  });
});

describe("baselineRiskTier — highest deterministic tier wins", () => {
  it("T1 + T3 => T3", () => {
    expect(tier(["src/components/badge.tsx", "supabase/migrations/0099_example.sql"])).toBe("T3");
  });

  it("T2 + T3 => T3", () => {
    expect(tier(["src/lib/server/sync/slack/sync.ts", "src/lib/auth/session.ts"])).toBe("T3");
  });

  it("T0 + T2 => T2", () => {
    expect(tier(["docs/00_PRODUCT_STATUS.md", "src/lib/server/sync/slack/sync.ts"])).toBe("T2");
  });

  // ANTI-REGRESSION. The failure this guards is a max() quietly becoming last-match-wins: with the T3 path first the
  // bug is invisible, so both orders are asserted. A mutant that returns the last (or first) rule's tier fails here.
  it("is order-independent — the same mixed set classifies T3 either way round", () => {
    const mixed = ["supabase/migrations/0099_example.sql", "src/components/badge.tsx", "docs/README.md"];
    expect(tier(mixed)).toBe("T3");
    expect(tier([...mixed].reverse())).toBe("T3");
    expect(tier(["src/components/badge.tsx", "docs/README.md", "supabase/migrations/0099_example.sql"])).toBe("T3");
  });
});

describe("riskReasons — always emitted, tier-tagged, and traceable to a path", () => {
  it("names the tier, the rule, and a concrete matching path, highest tier first", () => {
    const { baselineRiskTier, riskReasons } = classifyChangeRisk([
      "docs/00_PRODUCT_STATUS.md",
      "src/components/badge.tsx",
      "supabase/migrations/0099_example.sql",
    ]);
    expect(baselineRiskTier).toBe("T3");
    expect(riskReasons).toHaveLength(3);
    expect(riskReasons[0]).toContain("T3 ·");
    expect(riskReasons[0]).toContain("supabase/migrations/0099_example.sql");
    expect(riskReasons.map((r) => r.slice(0, 2))).toEqual(["T3", "T1", "T0"]);
  });

  it("collapses many paths matching one rule into a single counted reason", () => {
    const { riskReasons } = classifyChangeRisk(["src/components/a.tsx", "src/components/b.tsx", "src/components/c.tsx"]);
    expect(riskReasons).toEqual(["T1 · UI / presentation surface — src/components/a.tsx (+2 more)"]);
  });

  it("an unrecognised path defaults UP to T2 and says so, rather than passing silently as low risk", () => {
    const { baselineRiskTier, riskReasons } = classifyChangeRisk([".gitignore"]);
    expect(baselineRiskTier).toBe("T2");
    expect(riskReasons[0]).toContain("unclassified path");
  });

  it("empty / malformed input is T0 with a reason, never a throw and never a silent T3", () => {
    for (const input of [[], [""], ["   "], null, undefined, "not-an-array"] as unknown[]) {
      const out = classifyChangeRisk(input as string[]);
      expect(out).toEqual({ baselineRiskTier: "T0", riskReasons: ["no changed files"] });
    }
  });
});
