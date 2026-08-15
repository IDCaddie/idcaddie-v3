// Phase 18F-C — static guards over the ops surface's SOURCE.
//
// Two properties a behavioural test can only ever sample:
//
//   * NOTHING HERE RUNS UNATTENDED. A runtime test proves the engine did not run on the requests it was given; this
//     proves there is no timer, cron, retry loop or scheduler registration for ANY request anyone adds later. It is
//     the property the whole lane rests on — the transient run outcomes are only sufficient because a human is present
//     to read them, and the first automatic execution silently invalidates that.
//   * NO SERVICE-ROLE PATH. The runs write as the signed-in operator under RLS. A service-role client here would make
//     every guard beneath it decorative.
//
// Same shape as `application-matcher-static.test.ts`, whose literal-handling note is preserved: control-flow checks
// empty string literals so a file's own explanatory comments and copy cannot fail — or falsely pass — a guard.

import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";

const DIR = "src/app/(authenticated)/internal/governance-ops";
const FILES = {
  page: `${DIR}/page.tsx`,
  actions: `${DIR}/actions.ts`,
  panel: `${DIR}/run-panel.tsx`,
  view: `${DIR}/governance-ops-view.ts`,
  reader: "src/lib/data/governance-ops.ts",
} as const;

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

/** Comments removed, string literals EMPTIED — for checks about CONTROL FLOW rather than about a word on screen. */
function code(path: string): string {
  return stripComments(readFileSync(path, "utf8"))
    .replace(/"(?:[^"\\]|\\.)*"/g, '""')
    .replace(/'(?:[^'\\]|\\.)*'/g, "''")
    .replace(/`(?:[^`\\]|\\.)*`/g, "``");
}

/** Comments removed, literals KEPT — for checks about which module or RPC is NAMED, since a name lives in a literal. */
function codeKeepStrings(path: string): string {
  return stripComments(readFileSync(path, "utf8"));
}

describe("nothing on this surface runs unattended", () => {
  it.each(Object.entries(FILES))("%s registers no timer or scheduler", (_name, path) => {
    const src = code(path);
    expect(src).not.toMatch(/\bsetInterval\b/);
    expect(src).not.toMatch(/\bsetTimeout\b/);
    expect(src).not.toMatch(/\bqueueMicrotask\b/);
    // CALL-shaped, not word-shaped. These files say "there is no scheduler" in their own visible copy, and a guard
    // that failed on the sentence stating the property would have to be deleted by the first person who read it.
    expect(src).not.toMatch(/\b(cron|CronJob|schedule[A-Za-z]*)\s*\(/);
    expect(src).not.toMatch(/node-cron|@vercel\/cron/);
    // Next.js revalidation is a CACHE lifetime, not an execution trigger — but a maintainer reaching for it here is
    // usually reaching for "run it again periodically", which this surface must never do.
    expect(src).not.toMatch(/\brevalidate\s*=/);
  });

  it("the actions run their engine exactly once, with no retry loop", () => {
    const src = code(FILES.actions);
    expect(src).not.toMatch(/\bwhile\s*\(/);
    expect(src).not.toMatch(/\.retry\b|\bretry\s*\(/);
    // The load-bearing half: ONE call site each. A `for…of` is legitimate here (the withheld-rule notes are rendered
    // from a list), so banning loops outright would fail on presentation code; counting the call sites is the property
    // that actually matters, and a retry would need a second one.
    const kept = codeKeepStrings(FILES.actions);
    expect(kept.match(/runTenantApplicationMatcher\(/g) ?? []).toHaveLength(1);
    expect(kept.match(/evaluateTenantCrossSourceGovernance\(/g) ?? []).toHaveLength(1);
  });

  it("the page renders state but never triggers a run", () => {
    const kept = codeKeepStrings(FILES.page);
    expect(kept).not.toMatch(/runTenantApplicationMatcher/);
    expect(kept).not.toMatch(/evaluateTenantCrossSourceGovernance/);
    expect(kept).not.toMatch(/runMatcherAction|runEvaluationAction/);
  });

  it("no route handler exists under this surface — a URL anything could POST to on a timer", () => {
    const entries = readdirSync(DIR);
    expect(entries).not.toContain("route.ts");
    expect(entries).not.toContain("route.tsx");
  });

  it("this repository still configures no scheduler at all", () => {
    // The lane's stated conclusion, asserted rather than remembered: no Vercel cron config exists. If one is ever
    // added, this fails and whoever added it has to come back and re-read what the transient outcomes above assume.
    let vercelConfig = "";
    try {
      vercelConfig = readFileSync("vercel.json", "utf8");
    } catch {
      vercelConfig = "";
    }
    expect(vercelConfig).not.toMatch(/"crons"/);
  });
});

describe("no service-role path", () => {
  it.each(Object.entries(FILES))("%s never reaches for an admin client or a service key", (_name, path) => {
    const kept = codeKeepStrings(path);
    expect(kept).not.toMatch(/service_role/);
    expect(kept).not.toMatch(/SERVICE_ROLE/);
    expect(kept).not.toMatch(/createAdminClient|serviceClient|createServiceClient/);
  });

  it("the reader takes its tenant from the gate, never from a caller argument", () => {
    const kept = codeKeepStrings(FILES.reader);
    expect(kept).toMatch(/accessGate\(\)/);
    // The exported request-driven entrypoint accepts an IO seam only — no tenant parameter a browser could supply.
    expect(kept).toMatch(/readTenantMatcherState\(io\?: MatcherStateIo\)/);
  });

  it("the actions accept no tenant, connector or id from the form", () => {
    const kept = codeKeepStrings(FILES.actions);
    expect(kept).not.toMatch(/form\.get\(/);
    expect(kept).not.toMatch(/p_tenant_id/);
  });
});

describe("the surface is gated where it is rendered AND where it acts", () => {
  it("the page checks the flag", () => {
    expect(codeKeepStrings(FILES.page)).toMatch(/isGovernanceOpsEnabled\(process\.env\)/);
  });

  it("both actions re-check the flag rather than trusting the page", () => {
    const kept = codeKeepStrings(FILES.actions);
    expect(kept.match(/isGovernanceOpsEnabled\(process\.env\)/g) ?? []).toHaveLength(2);
  });

  it("the client component never reads the flag or the env", () => {
    // A client-side gate is decoration; it also risks inlining an env value into the browser bundle.
    const kept = codeKeepStrings(FILES.panel);
    expect(kept).not.toMatch(/process\.env/);
    expect(kept).not.toMatch(/isGovernanceOpsEnabled/);
  });
});

describe("the surface shows engine operability, not finding content", () => {
  it("reads no finding table or finding RPC", () => {
    for (const path of Object.values(FILES)) {
      const kept = codeKeepStrings(path);
      expect(kept).not.toMatch(/governance_findings/);
      expect(kept).not.toMatch(/product_governance_findings|finding_key|subject_id/);
    }
  });

  it("is not linked from the customer navigation", () => {
    const nav = readFileSync("src/app/(authenticated)/nav-items.ts", "utf8");
    expect(nav).not.toMatch(/governance-ops/);
    expect(nav).not.toMatch(/\/internal\//);
  });
});
