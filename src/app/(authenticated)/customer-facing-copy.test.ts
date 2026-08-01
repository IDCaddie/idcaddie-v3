// A static guard against engineering vocabulary reaching a customer's screen.
//
// This exists because the alternative failed: every one of the phrases below was, at some point, written into a page
// description by someone who knew exactly what it meant. "RLS-scoped" is precise and correct and completely opaque to
// the person paying for the product, and "not built yet" is honest in a changelog and alarming in a demo.
//
// Scope is deliberately narrow — it scans page/component SOURCE under src/app and src/components, and only the string
// literals a reader could plausibly see. It cannot prove a string is rendered, so it errs toward flagging: if a phrase
// on this list turns out to be genuinely fine somewhere, the fix is to reword it, not to widen the allowlist.

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOTS = ["src/app", "src/components"];

// Files whose strings are not customer-facing.
const EXEMPT = (p: string) =>
  p.includes(".test.") ||
  p.includes("/internal/") ||        // env-gated internal tooling, never linked from the product
  p.endsWith("route.ts") ||          // HTTP handlers render no copy
  p.endsWith("nav-items.ts") ||      // the roadmap map itself; its unbuilt markers are the honesty feature
  p.endsWith("nav.tsx") ||           // renders those markers, and hides them in demo mode
  p.endsWith("customer-facing-copy.test.ts");

// Rules a file may opt out of by being DEMO-GATED. "Not built yet" is a deliberate honesty marker in the shipped
// product and the wrong thing to project during a walkthrough, so the requirement is not that it never exists — it is
// that it is behind `DEMO_MODE`. A file that imports DEMO_MODE has made that choice explicitly.
const DEMO_GATED_OK = [/not built yet/i];

const BANNED: ReadonlyArray<readonly [RegExp, string]> = [
  [/RLS[- ]scoped/i, "say what the customer sees, not how it is enforced"],
  [/Postgres RLS/i, "name the database and you have lost the reader"],
  [/\(RLS\)/i, "an unexplained acronym"],
  [/service[- ]role/i, "an internal credential concept"],
  [/default[- ]deny/i, "a policy term, not a product term"],
  [/\bRPC\b/, "an implementation detail"],
  [/raw (id|ids|owner ids)/i, "the customer does not know what a raw id is"],
  [/\bsynthetic\b/i, "tells the viewer the thing is not real"],
  [/not built yet/i, "reads as an unfinished product"],
  [/coming soon|coming next/i, "a roadmap promise inside the product"],
  [/staging pilot|staging use|for staging\b/i, "a deployment environment is not the customer's concern"],
  [/\bmigration \d{3,4}\b/i, "an internal version number"],
  [/npm run |supabase (db|migration) /i, "a developer command"],
  [/\bskeleton\b/i, "tells the viewer this is scaffolding"],
];

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (/\.(tsx|ts)$/.test(p) && !EXEMPT(p)) out.push(p);
  }
  return out;
}

// Strip comments so a note explaining WHY a rule exists is not itself a violation. Crude but sufficient: these are
// TS/TSX sources, and a `//` inside a string literal is rare enough that a false strip would surface as a missed
// violation, not a wrong one.
function withoutComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((l) => l.replace(/(^|\s)\/\/.*$/, "$1"))
    .join("\n");
}

describe("customer-facing copy", () => {
  const files = ROOTS.flatMap((r) => { try { return walk(r); } catch { return []; } });

  it("scans a meaningful number of files (so a broken walk cannot pass silently)", () => {
    expect(files.length).toBeGreaterThan(30);
  });

  it.each(BANNED)("never renders %s — %s", (re, _why) => {
    const hits: string[] = [];
    for (const f of files) {
      const raw = readFileSync(f, "utf8");
      if (DEMO_GATED_OK.some((r) => r.source === re.source) && raw.includes("DEMO_MODE")) continue;
      const src = withoutComments(raw);
      for (const [i, line] of src.split("\n").entries()) {
        // An import path is not copy (`@/components/skeleton` is a module, not a sentence).
        if (/^\s*import\b/.test(line)) continue;
        if (re.test(line)) hits.push(`${f}:${i + 1}: ${line.trim().slice(0, 120)}`);
      }
    }
    expect(hits, `engineering language on a customer screen:\n${hits.join("\n")}`).toEqual([]);
  });
});
