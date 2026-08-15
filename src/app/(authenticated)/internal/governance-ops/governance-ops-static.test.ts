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

describe("no privileged-client path", () => {
  // The privileged-role literal is NOT asserted here. `scripts/check-auth-safety.sh` already greps the whole of `src/`
  // for it on every PR, with no allowlist — so writing it down would duplicate an existing gate AND trip it, which is
  // how this test first failed CI. What follows is only what that scanner does not cover.
  it.each(Object.entries(FILES))("%s never reaches for an admin client factory", (_name, path) => {
    const kept = codeKeepStrings(path);
    expect(kept).not.toMatch(/createAdminClient|serviceClient|createServiceClient|createSupabaseAdmin/);
    // The one client factory this path is allowed to use is the cookie-bound, user-scoped server client.
    expect(kept).not.toMatch(/@supabase\/supabase-js/);
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

describe("the evaluation precondition is enforced server-side, before the engine", () => {
  it("the action reads the matcher state BEFORE it calls the evaluator", () => {
    const src = codeKeepStrings(FILES.actions);
    const read = src.indexOf("readTenantMatcherState(");
    const gate = src.indexOf("evaluationGate(");
    const evaluate = src.indexOf("evaluateTenantCrossSourceGovernance(");
    expect(read).toBeGreaterThan(-1);
    expect(gate).toBeGreaterThan(read);      // gate the state we just read …
    expect(evaluate).toBeGreaterThan(gate);  // … and only then enter the engine
  });

  it("the refusal returns before the engine rather than discarding its result", () => {
    // `return` on the blocked branch is the whole guard. Computing the evaluation and then throwing the result away
    // would already have run the sync — and the sync is the mutation.
    expect(codeKeepStrings(FILES.actions)).toMatch(/if \(!gate\.allowed\) return/);
  });

  it("the evaluation button is actually disabled when the server said blocked", () => {
    // Defence in depth, and the only half a mutation of the JSX would touch: the server action refuses regardless, but
    // an enabled button invites a press that is guaranteed to fail, and hides the reason behind an error instead of
    // showing it up front.
    const kept = codeKeepStrings(FILES.panel);
    expect(kept).toMatch(/const blocked = blockedReason !== null/);
    expect(kept).toMatch(/disabled=\{pending \|\| blocked\}/);
  });

  it("the client component holds no gate logic — it renders a reason the server decided", () => {
    const kept = codeKeepStrings(FILES.panel);
    expect(kept).not.toMatch(/evaluationGate|readTenantMatcherState|lastCompletedAt|"completed"/);
    expect(kept).toMatch(/blockedReason/);
  });

  it("the false pre-fix promise cannot come back", () => {
    // "Findings raised by an earlier run stay open and are not being refreshed" was untrue: pressing Run evaluation
    // closed them. Nothing on this surface may claim it again.
    for (const path of Object.values(FILES)) {
      expect(codeKeepStrings(path)).not.toMatch(/stay open/);
    }
  });

  it("the guard records that it does NOT fix the engine's closure model", () => {
    // Read raw: this is a claim about the documentation a maintainer will read, and `codeKeepStrings` strips comments.
    const raw = readFileSync(FILES.view, "utf8");
    expect(raw).toMatch(/THIS GUARD DOES NOT FIX IT/);
    expect(raw).toMatch(/needs a migration/);
  });

  it("no operator-facing copy promises engine-wide closure safety", () => {
    for (const path of Object.values(FILES)) {
      expect(codeKeepStrings(path)).not.toMatch(/closure-safe|never closes|cannot close a finding/i);
    }
  });
});

describe("the runbook cannot re-assert the claims the guard disproved", () => {
  const RUNBOOK = "docs/runbooks/GOVERNANCE_OPS_RUNBOOK.md";
  const text = () => readFileSync(RUNBOOK, "utf8");

  it("never says evaluation-alone is valid", () => {
    // The pre-fix text said "Running the evaluation alone is valid — it simply reports rule 5 as withheld". It is not
    // valid: with a prior rule 5 finding open, that run closes it.
    expect(text()).not.toMatch(/evaluation alone is valid|Running the evaluation alone is valid/i);
  });

  it("never claims a withheld rule leaves findings merely absent", () => {
    expect(text()).not.toMatch(/findings are not wrong, they are absent/i);
  });

  it("states the precondition and the reason for it", () => {
    // Markdown wraps and emphasises, so compare against a whitespace- and bold-normalised copy rather than the raw
    // file — otherwise a reflow would break a test that is about meaning.
    const flat = text().replace(/\*\*/g, "").replace(/\s+/g, " ");
    expect(flat).toMatch(/refuses to run unless the matcher/i);
    expect(flat).toMatch(/closes a finding that is still true/i);
    expect(flat).toMatch(/history does not authorize a run/i);
  });

  it("does not claim the engine's closure model is fixed", () => {
    const t = text();
    expect(t).toMatch(/does \*\*not\*\* repair 0083/i);
    expect(t).not.toMatch(/the engine is now closure-safe/i);
  });
});
