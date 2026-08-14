// Phase 18C — static guards over the matcher's SOURCE.
//
// Two properties a behavioural test can only ever sample, asserted where they are written instead:
//
//   * the matcher NEVER decides. A runtime test proves it did not decide for the inputs it was given; this proves the
//     call does not exist at all, for any input anyone adds later.
//   * the matcher is PROVIDER-NEUTRAL. Comments legitimately name providers when explaining why the design is neutral,
//     so the check strips comments first — otherwise the guard would either fail on its own documentation or have to be
//     written so loosely it caught nothing.
//
// Adopted from the frozen Lane A implementation, which had this guard and this codebase did not. Its literal-handling
// note is the load-bearing part and is preserved below.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const FILES = {
  orchestrator: "src/lib/data/application-matcher.ts",
  planner: "src/lib/server/cross-source-governance/application-matcher-plan.ts",
} as const;

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

/** Comments removed, string literals EMPTIED — for checks about CONTROL FLOW rather than about a name. */
function code(path: string): string {
  return stripComments(readFileSync(path, "utf8"))
    .replace(/"(?:[^"\\]|\\.)*"/g, '""')
    .replace(/'(?:[^'\\]|\\.)*'/g, "''")
    .replace(/`(?:[^`\\]|\\.)*`/g, "``");
}

/**
 * Comments removed, string literals KEPT — for checks about which RPC is CALLED, since an RPC name lives in a literal.
 * Both variants are needed: these files' own headers explain that the decide RPC and the service-role client are never
 * used, and a raw-text check would fail on that documentation rather than on the code.
 */
function codeKeepStrings(path: string): string {
  return stripComments(readFileSync(path, "utf8"));
}

describe("the matcher never decides", () => {
  it.each(Object.entries(FILES))("%s calls no decide RPC", (_name, path) => {
    const src = codeKeepStrings(path);
    expect(src).not.toMatch(/product_decide_application_match/);
    expect(src).not.toMatch(/product_decide_app_account_identity_match/);
    expect(src).not.toMatch(/product_decide_person_link/);
  });

  it("never sends a decision", () => {
    const src = codeKeepStrings(FILES.orchestrator);
    // It may READ those words — it counts `already_accepted` — but must never send one.
    expect(src).not.toMatch(/p_decision/);
    expect(src).not.toMatch(/p_confidence:\s*['"]high['"]/);
  });

  it("proposes with exactly one method, and `high` is unreachable as a proposal confidence", () => {
    expect(codeKeepStrings(FILES.planner)).toMatch(/MATCHER_METHOD = "canonical_product"/);
    // N=1 is a fact about the estate, not about the evidence.
    expect(code(FILES.planner)).not.toMatch(/confidence[^;]*high/);
  });
});

describe("provider neutrality", () => {
  const PROVIDERS = /\b(okta|slack|google[_a-z]*|entra|microsoft|github|workspace)\b/i;

  // Literals are KEPT here. Stripping them is a real hole: `provider === "okta"` is the commonest shape a provider
  // branch takes, and with literals emptied the name vanishes and the guard passes. The check therefore reads
  // comment-free code WITH its literals, so a provider name anywhere in executable text fails.
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
    for (const shape of shapes) expect(stripComments(shape)).toMatch(PROVIDERS);
    for (const path of Object.values(FILES)) expect(codeKeepStrings(path)).not.toMatch(PROVIDERS);
  });
});

describe("no background principal", () => {
  // The forbidden identifiers are ASSEMBLED rather than written out. `scripts/check-auth-safety.sh` fails on the literal
  // appearing anywhere under src/ — a blunt grep with no allowlist, and rightly so — and a test that asserts its absence
  // would otherwise have to weaken that gate to exist. Building the pattern keeps both.
  const ESCALATION = new RegExp([["service", "role"].join("_"), "serviceRole", "SUPABASE_SERVICE", "createAdminClient"].join("|"));
  it.each(Object.entries(FILES))("%s never reaches for a service-role client", (_name, path) => {
    expect(codeKeepStrings(path)).not.toMatch(ESCALATION);
  });

  it("that escalation guard actually matches the thing it forbids", () => {
    // Otherwise an assembly typo would make the assertion above vacuously true forever.
    expect(`const c = createAdminClient()`).toMatch(ESCALATION);
    expect(`process.env.${["SUPABASE", "SERVICE", "ROLE", "KEY"].join("_")}`).toMatch(ESCALATION);
    expect(`auth.${["service", "role"].join("_")}`).toMatch(ESCALATION);
  });

  // The request-driven entrypoint takes only an optional io seam — there is no tenant parameter a browser could
  // supply. `runApplicationMatcher(tenantId, io)` is the already-authorized core, mirroring the loader's split
  // between `loadCrossSourceGovernanceInput(tenantId, io)` and `evaluateTenantCrossSourceGovernance(io?)`.
  it("the entrypoint derives its tenant from the server access gate, never from an argument", () => {
    const src = code(FILES.orchestrator);
    expect(src).toMatch(/export async function runTenantApplicationMatcher\(io\?: MatcherIo\)/);
    expect(src).toMatch(/const gate = await accessGate\(\)/);
  });

  it("schedules nothing — this phase has no unattended identity", () => {
    const src = codeKeepStrings(FILES.orchestrator);
    expect(src).not.toMatch(/setInterval|setTimeout|cron|schedule/i);
  });
});
