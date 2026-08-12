import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";

// ── WHAT THE DEPLOYED SERVER BUNDLE MAY NOT CONTAIN ──────────────────────────────────────────────────────────────────
//
// Doc 83 §2's origin story is a Postgres driver and a KMS client in a public request path. Source-level import rules
// cannot see capability that arrives through a dependency's own graph: `@vercel/oidc` had ONE supported entry, a
// CommonJS barrel that eagerly required `@vercel/cli-exec` -> `execa` -> `child_process` plus a keyring credential
// store, and every source-level check in this repository stayed green while it did.
//
// So this asserts against the EMITTED build — the thing that actually ships. It reads `.next/server`, not source, and
// not a hand-picked list of leaf files (the mistake that let the previous version of this check pass while the
// capability was in the bundle).
//
// It SKIPS when there is no build output, so `vitest` alone stays fast. CI runs `next build` first; the skip is loud
// rather than silent, and the positive control below fails regardless of build state.

const SERVER_DIR = join(process.cwd(), ".next", "server");

/** Marker strings that only appear if the capability is genuinely bundled. */
const FORBIDDEN: [string, RegExp][] = [
  ["child_process", /require\(["']child_process["']\)|"child_process"|node:child_process/],
  ["execa", /execa|VERCEL_CLI_EXEC_FAILED/],
  ["@vercel/cli-exec", /@vercel\/cli-exec|Vercel CLI command/],
  ["@vercel/cli-config", /@vercel\/cli-config|cred-storage/],
  ["cross-spawn", /cross-spawn/],
  ["keyring/keytar", /keytar|node-keyring/],
  ["pg / postgres", /require\(["']pg["']\)|"pg-connection-string"|node-postgres/],
  ["AWS KMS client", /@aws-sdk\/client-kms|GenerateDataKeyCommand|DecryptCommand/],
];

function serverJsFiles(dir: string, acc: string[] = []): string[] {
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) serverJsFiles(p, acc);
    else if (n.endsWith(".js")) acc.push(p);
  }
  return acc;
}

function scan(files: string[]): { capability: string; file: string }[] {
  const hits: { capability: string; file: string }[] = [];
  for (const f of files) {
    const src = readFileSync(f, "utf8");
    for (const [name, re] of FORBIDDEN) if (re.test(src)) hits.push({ capability: name, file: f.slice(SERVER_DIR.length + 1) });
  }
  return hits;
}

const hasBuild = existsSync(SERVER_DIR);

describe("the emitted server bundle carries no forbidden runtime capability", () => {
  it.skipIf(!hasBuild)("has build output to inspect (a silent empty sweep is the failure mode)", () => {
    const files = serverJsFiles(SERVER_DIR);
    expect(files.length).toBeGreaterThan(10);
  });

  it.skipIf(!hasBuild)("contains none of the forbidden capabilities", () => {
    expect(scan(serverJsFiles(SERVER_DIR))).toEqual([]);
  });

  it.skipIf(!hasBuild)("the OAuth callback route's own chunks are clean", () => {
    const routeDir = join(SERVER_DIR, "app");
    const files = existsSync(routeDir) ? serverJsFiles(routeDir).filter((f) => f.includes("oauth")) : [];
    expect(scan(files)).toEqual([]);
  });

  // POSITIVE CONTROL — runs with or without a build. If the scanner cannot detect a deliberately introduced
  // capability, its silence on the real bundle means nothing. This is the assertion the previous version of this check
  // did not have, which is why it passed while `child_process` was reachable from the route entry.
  it("DETECTS every forbidden capability when one is deliberately introduced", () => {
    const planted: [string, string][] = [
      ["child_process", `const cp = require("child_process"); cp.spawn("sh");`],
      ["execa", `throw new Error("VERCEL_CLI_EXEC_FAILED");`],
      ["@vercel/cli-exec", `var i = require("@vercel/cli-exec");`],
      ["@vercel/cli-config", `var c = require("@vercel/cli-config/dist/cred-storage");`],
      ["cross-spawn", `var s = require("cross-spawn");`],
      ["keyring/keytar", `var k = require("keytar");`],
      ["pg / postgres", `var p = require("pg");`],
      ["AWS KMS client", `import { DecryptCommand } from "@aws-sdk/client-kms";`],
    ];
    for (const [capability, source] of planted) {
      const hit = FORBIDDEN.filter(([, re]) => re.test(source)).map(([n]) => n);
      expect(hit, `planted ${capability} was not detected`).toContain(capability);
    }
  });

  it("does NOT fire on ordinary application code", () => {
    const benign = [
      `const headers = { "cache-control": "no-store" };`,
      `await fetch("https://oidc.vercel.com/~token", { method: "POST" });`,
      `export const runtime = "nodejs";`,
    ];
    for (const src of benign) expect(FORBIDDEN.filter(([, re]) => re.test(src)).map(([n]) => n)).toEqual([]);
  });
});
