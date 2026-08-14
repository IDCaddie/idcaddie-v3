// Phase 18C — static guards over the matcher's source.
//
// Two properties that a behavioural test can only ever sample, asserted where they are written instead:
//
//   * the matcher NEVER decides. A runtime test proves it did not decide for the inputs it was given; this proves the
//     call does not exist at all, for any input anyone adds later.
//   * the matcher is PROVIDER-NEUTRAL. Comments legitimately name Okta and Slack when explaining why the design is
//     neutral, so the check strips comments first — otherwise the guard would either fail on its own documentation or
//     have to be written so loosely it caught nothing.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const FILES = {
  orchestrator: "src/lib/data/application-matcher.ts",
  planner: "src/lib/server/application-matcher/plan.ts",
} as const;

/** Comments removed, string literals emptied — for checks about CONTROL FLOW (e.g. a provider branch). */
function code(path: string): string {
  return stripComments(readFileSync(path, "utf8"))
    .replace(/"(?:[^"\\]|\\.)*"/g, '""')
    .replace(/'(?:[^'\\]|\\.)*'/g, "''")
    .replace(/`(?:[^`\\]|\\.)*`/g, "``");
}

/**
 * Comments removed, string literals KEPT — for checks about which RPC is CALLED, since an RPC name lives in a literal.
 * Both variants are needed: this file's own header explains that the decide RPC is never called, and a raw-text check
 * would fail on that documentation rather than on the code.
 */
function codeKeepStrings(path: string): string {
  return stripComments(readFileSync(path, "utf8"));
}

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

describe("the matcher never decides", () => {
  it.each(Object.entries(FILES))("%s calls no decide RPC", (_name, path) => {
    const src = codeKeepStrings(path);
    // Literals are KEPT (the RPC name is one) but comments are gone, so the header explaining that this call is never
    // made cannot satisfy or fail the guard.
    expect(src).not.toMatch(/product_decide_application_match/);
    expect(src).not.toMatch(/product_decide_app_account_identity_match/);
    expect(src).not.toMatch(/product_decide_person_link/);
  });

  it("never writes an accepted or rejected status", () => {
    const src = codeKeepStrings(FILES.orchestrator);
    // It may READ those words (counting `already_accepted`), but must never send one as a decision.
    expect(src).not.toMatch(/p_decision/);
    expect(src).not.toMatch(/status:\s*['"]accepted['"]/);
    expect(src).not.toMatch(/status:\s*['"]rejected['"]/);
  });

  it("proposes with exactly one method, and never high confidence", () => {
    expect(codeKeepStrings(FILES.planner)).toMatch(/MATCHER_METHOD = "canonical_product"/);
    // `high` must not be reachable as a proposal confidence: N=1 is a fact about the estate, not the evidence.
    expect(code(FILES.planner)).not.toMatch(/confidence[^;]*high/);
  });
});

describe("provider neutrality", () => {
  const PROVIDERS = /\b(okta|slack|google[_a-z]*|entra|microsoft|github|workspace)\b/i;

  // Literals are KEPT here. Stripping them was a real hole: `provider === "okta"` is the commonest shape a provider
  // branch takes, and with literals emptied the name vanished and the guard passed. Mutation caught that — the check
  // now reads comment-free code WITH its literals, so a provider name anywhere in executable text fails.
  it.each(Object.entries(FILES))("%s names no provider in executable code", (_name, path) => {
    expect(codeKeepStrings(path)).not.toMatch(PROVIDERS);
  });

  it.each(Object.entries(FILES))("%s imports no provider adapter", (_name, path) => {
    const src = codeKeepStrings(path);
    const imports = [...src.matchAll(/^import\s[\s\S]*?from\s+["']([^"']+)["']/gm)].map(m => m[1]);
    for (const spec of imports) {
      expect(spec).not.toMatch(/customer-connectors|connector-vault|connectors\/|providers\//);
    }
  });

  it("the guard catches a provider branch in every shape it actually takes", () => {
    // Each of these is a real branch a future edit could introduce; all must be caught by the same check.
    const shapes = [
      'if (provider === "okta") { doSomething(); }',
      "if (row.provider === 'google_workspace') return;",
      'switch (p) { case "slack": break; }',
      "const isEntra = provider.startsWith(`entra`);",
    ];
    for (const shape of shapes) {
      expect(stripComments(shape)).toMatch(PROVIDERS);
    }
    // And the real files remain clean under exactly that check.
    for (const path of Object.values(FILES)) expect(codeKeepStrings(path)).not.toMatch(PROVIDERS);
  });
});

describe("no background principal", () => {
  // The elevated-role literal is deliberately NOT asserted here: `scripts/check-auth-safety.sh` already forbids it
  // anywhere under `src/`, which is a strictly stronger guarantee than this file could offer — and writing the literal
  // to test for it would itself trip that scanner. Redundant local checks that fight a global one are worse than none.
  it.each(Object.entries(FILES))("%s builds no admin client", (_name, path) => {
    expect(codeKeepStrings(path)).not.toMatch(/createAdminClient|SUPABASE_SERVICE/);
  });

  it("the orchestrator derives its tenant from the server access gate, never from an argument", () => {
    const src = code(FILES.orchestrator);
    expect(src).toMatch(/accessGate\(\)/);
    // `runApplicationMatcher` takes only an optional io seam — no tenant parameter a caller could supply.
    expect(src).toMatch(/export async function runApplicationMatcher\(io\?: MatcherIo\)/);
  });
});
