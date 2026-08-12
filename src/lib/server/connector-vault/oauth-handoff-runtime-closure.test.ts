import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createRequire } from "node:module";

// ── WHAT THE COMPLETION PATH IS ALLOWED TO PULL IN ───────────────────────────────────────────────────────────────────
//
// Doc 83 §2's origin story is a Postgres driver and a KMS client in a public request path. This walks the ACTUAL
// require graph of the `@vercel/oidc` entry points this repository uses and proves the same class of capability has not
// arrived by dependency.
//
// It exists because it caught one: `getVercelOidcToken` unconditionally `await import`s `token-util.js` + `token.js`,
// which pull `@vercel/cli-exec` -> `execa` -> `child_process`, plus `@vercel/cli-config`'s keyring credential store,
// and then CALL `refreshToken()` whenever the platform token is missing or expired — reachable in production, where it
// would read `~/.vercel` and try to spawn a CLI that is not in the bundle. We use the two primitives it wraps instead.

const FORBIDDEN = [
  "child_process", "node:child_process",
  "execa",
  "@vercel/cli-exec", "@vercel/cli-config",
  "keytar", "keyring",
  "pg", "postgres",
  "@aws-sdk/client-kms",
];

const req = createRequire(join(process.cwd(), "package.json"));

/** Transitively resolve the CommonJS require graph of a module file, returning every file and bare specifier reached. */
function closure(entry: string): { files: Set<string>; specifiers: Set<string> } {
  const files = new Set<string>();
  const specifiers = new Set<string>();
  const queue = [entry];
  while (queue.length) {
    const f = queue.pop() as string;
    if (files.has(f) || !existsSync(f)) continue;
    files.add(f);
    const src = readFileSync(f, "utf8");
    // Both static `require("x")` and dynamic `import("x")` — the wrapper's capability arrived through the dynamic form.
    for (const m of src.matchAll(/(?:require|import)\(\s*["']([^"']+)["']\s*\)/g)) {
      const spec = m[1];
      specifiers.add(spec);
      if (spec.startsWith(".")) {
        const base = resolve(dirname(f), spec);
        for (const cand of [base, `${base}.js`, base.replace(/\.js$/, "") + ".js", join(base, "index.js")]) {
          if (existsSync(cand) && !files.has(cand)) queue.push(cand);
        }
      }
    }
  }
  return { files, specifiers };
}

const ENTRIES = ["get-vercel-oidc-token-sync.js", "exchange-vercel-oidc-token.js", "get-context.js"]
  .map((f) => join(dirname(req.resolve("@vercel/oidc")), f));

describe("the @vercel/oidc primitives we use carry no forbidden capability", () => {
  it("resolves the entry files we actually import (an empty sweep would prove nothing)", () => {
    for (const e of ENTRIES) expect(existsSync(e), `missing ${e}`).toBe(true);
  });

  for (const entry of ENTRIES) {
    it(`${entry.split("/").pop()} reaches none of the forbidden modules`, () => {
      const { specifiers } = closure(entry);
      const hits = [...specifiers].filter((s) => FORBIDDEN.some((f) => s === f || s.startsWith(`${f}/`)));
      expect(hits).toEqual([]);
    });
  }

  // The control. If the walker cannot SEE the capability in the module we rejected, its silence on the ones we kept is
  // meaningless — this is the assertion that makes the three above worth anything.
  it("the walker DOES find the capability in `getVercelOidcToken`, the wrapper we deliberately do not use", () => {
    const wrapper = join(dirname(req.resolve("@vercel/oidc")), "get-vercel-oidc-token-with-refresh.js");
    expect(existsSync(wrapper)).toBe(true);
    const { specifiers } = closure(wrapper);
    // It pulls the CLI refresh path in dynamically; that is exactly what the dynamic-import branch above is for.
    expect([...specifiers].some((s) => s.includes("token-util") || s.includes("token.js"))).toBe(true);
    const viaCli = closure(join(dirname(req.resolve("@vercel/oidc")), "token-util.js")).specifiers;
    expect([...viaCli].some((s) => s.startsWith("@vercel/cli-"))).toBe(true);
  });

  // Naming the wrapper in a REFUSAL (the comment explaining why we do not use it) is fine; IMPORTING it is not. So this
  // checks the import specifiers, not the text — the same distinction the OAUTH_COMPLETER_DB_URL rule draws.
  it("no source file under src/ imports getVercelOidcToken — only the two clean primitives", () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { execSync } = require("node:child_process") as typeof import("node:child_process");
    const out = execSync(`grep -rln "@vercel/oidc" src/ || true`, { encoding: "utf8" });
    const importers = out.split("\n").filter((l) => l.trim() && !l.includes(".test."));
    expect(importers.length).toBeGreaterThan(0); // a sweep that finds no file proves nothing
    let withImport = 0;
    for (const rel of importers) {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const src = (require("node:fs") as typeof import("node:fs")).readFileSync(rel, "utf8");
      const stmts = [...src.matchAll(/import\s*\{([^}]*)\}\s*from\s*["']@vercel\/oidc["']/g)];
      if (stmts.length === 0) continue; // mentions it in prose only — a refusal, not an import
      withImport++;
      const imported = stmts.flatMap((m) => m[1].split(",").map((x) => x.trim())).sort();
      expect(imported, rel).toEqual(["exchangeVercelOidcToken", "getVercelOidcTokenSync"]);
    }
    expect(withImport, "no file actually imports the SDK").toBeGreaterThan(0);
  });
});
