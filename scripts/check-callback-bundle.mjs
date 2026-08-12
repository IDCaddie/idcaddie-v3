#!/usr/bin/env node
// check-callback-bundle — the OAuth callback function must not carry a forbidden runtime capability.
//
// Doc 83 §2's origin story is a Postgres driver and a KMS client in a public request path. Source-level import rules
// cannot see capability that arrives through a dependency's OWN graph: `@vercel/oidc` had one supported entry, a
// CommonJS barrel that eagerly required `@vercel/cli-exec` -> `execa` -> `child_process`, and every source check in
// this repository stayed green while it did.
//
// SO THIS INSPECTS THE BUILD, TWO WAYS, because neither alone is sufficient:
//
//   (1) THE NFT TRACE — `route.js.nft.json` lists the resolved node_modules FILES Next traces into the deployed
//       lambda. This is the only signal that catches a package the bundler INLINES rather than requires by name: an
//       earlier version of this guard grepped emitted JS for `require("pg")`, and a real `pg` client in the callback
//       path passed 5/5 green because Turbopack rewrites package specifiers to internal module ids. The trace still
//       listed 43 `pg-*` files.
//
//   (2) THE CHUNK CLOSURE — the runtime symbols that survive bundling (`DecryptCommand`, a literal
//       `require("child_process")` for a Node builtin, `@vercel/cli-exec`'s error strings). Builtins are not
//       node_modules files, so the trace cannot see them.
//
// ABSENCE OF THE BUILD IS A FAILURE, NEVER A SKIP. The previous version was a vitest `it.skipIf`, CI ran `npm test`
// before `npm run build`, and all three real assertions skipped silently on every PR while reporting green.

import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join, resolve, dirname } from "node:path";

const ROOT = process.cwd();
const SERVER = join(ROOT, ".next", "server");
const problems = [];
const fail = (m) => problems.push(m);

// ── Forbidden capability. `packages` match a node_modules path segment; `symbols` match emitted chunk text. ──────────
const FORBIDDEN = [
  { name: "pg / postgres", packages: [/(^|\/)pg($|\/)/, /(^|\/)pg-[a-z0-9-]+($|\/)/, /(^|\/)postgres($|\/)/], symbols: [/pg-connection-string/, /node-postgres/] },
  { name: "child_process", packages: [], symbols: [/require\(\s*["']child_process["']\s*\)/, /require\(\s*["']node:child_process["']\s*\)/, /x\(\s*["']child_process["']/] },
  { name: "execa", packages: [/(^|\/)execa($|\/)/], symbols: [/VERCEL_CLI_EXEC_FAILED/] },
  { name: "@vercel/cli-exec", packages: [/@vercel\/cli-exec/], symbols: [/Vercel CLI command/] },
  { name: "@vercel/cli-config", packages: [/@vercel\/cli-config/], symbols: [/cred-storage/] },
  { name: "cross-spawn", packages: [/(^|\/)cross-spawn($|\/)/], symbols: [] },
  { name: "keytar / keyring", packages: [/(^|\/)keytar($|\/)/, /(^|\/)node-keyring($|\/)/], symbols: [/require\(\s*["']keytar["']\s*\)/] },
  { name: "AWS KMS client", packages: [/@aws-sdk\/client-kms/], symbols: [/GenerateDataKeyCommand/, /DecryptCommand/] },
];

// ── Locate the callback route's build output ─────────────────────────────────────────────────────────────────────────
function findRoute(dir) {
  if (!existsSync(dir)) return null;
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) { const hit = findRoute(p); if (hit) return hit; }
    else if (n === "route.js.nft.json" && p.includes("connectors/oauth/callback")) return p;
  }
  return null;
}

if (!existsSync(SERVER)) {
  console.error("check-callback-bundle FAILED — no .next/server. Run `next build` FIRST; a missing build is a failure, not a skip.");
  process.exit(1);
}
const tracePath = findRoute(SERVER);
if (!tracePath) {
  console.error("check-callback-bundle FAILED — no nft trace for the OAuth callback route under .next/server. The route did not build, or moved.");
  process.exit(1);
}

// ── (1) the traced file list ─────────────────────────────────────────────────────────────────────────────────────────
const trace = JSON.parse(readFileSync(tracePath, "utf8"));
const traced = (trace.files ?? []).map((f) => resolve(dirname(tracePath), f));
if (traced.length === 0) fail("the nft trace lists ZERO files — it cannot be proving anything");
for (const f of traced) {
  const rel = f.slice(f.lastIndexOf("node_modules/") + "node_modules/".length);
  if (!f.includes("node_modules/")) continue;
  for (const cap of FORBIDDEN) {
    if (cap.packages.some((re) => re.test(rel))) fail(`${cap.name}: traced into the callback lambda via node_modules/${rel}`);
  }
}

// ── (2) the chunk closure the route loads ────────────────────────────────────────────────────────────────────────────
const routeJs = tracePath.replace(/\.nft\.json$/, "");
const chunkRefs = existsSync(routeJs)
  ? [...readFileSync(routeJs, "utf8").matchAll(/["'](server\/chunks\/[^"']+)["']/g)].map((m) => join(SERVER, m[1].replace(/^server\//, "")))
  : [];
if (existsSync(routeJs) && chunkRefs.length === 0) fail("the route loader references ZERO chunks — the closure cannot be proving anything");
for (const c of chunkRefs) {
  if (!existsSync(c)) continue;
  const src = readFileSync(c, "utf8");
  for (const cap of FORBIDDEN) {
    if (cap.symbols.some((re) => re.test(src))) fail(`${cap.name}: runtime symbol present in the callback's chunk closure (${c.slice(SERVER.length + 1)})`);
  }
}

if (problems.length) {
  console.error(`check-callback-bundle FAILED — ${problems.length} problem(s):`);
  for (const p of [...new Set(problems)]) console.error(`  - ${p}`);
  process.exit(1);
}
console.log(`check-callback-bundle OK — ${traced.length} traced file(s) and ${chunkRefs.length} chunk(s) in the OAuth callback closure; none of ${FORBIDDEN.length} forbidden capabilities present`);
