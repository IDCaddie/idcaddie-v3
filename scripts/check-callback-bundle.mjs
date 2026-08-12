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
// Node builtins are reached by MANY spellings, and anchoring on `require(` caught one of them. A review used
// `process.getBuiltinModule("child_process")` — a first-class Node API needing no require, no import, no bundler edge —
// and the guard printed OK while `execSync` sat in a chunk it had already walked. So builtins are matched by the module
// NAME wherever it appears next to any loader spelling, and the loader list includes the ones that need no bundling.
const BUILTIN_LOADERS = String.raw`(?:require|getBuiltinModule|createRequire\([^)]*\)|import|__webpack_require__|[a-zA-Z_$][\w$]*)`;
const builtinSymbols = (mod) => [
  new RegExp(String.raw`${BUILTIN_LOADERS}\(\s*["'](?:node:)?${mod}["']`),
  new RegExp(String.raw`["'](?:node:)?${mod}["']\s*\)`),   // the bare specifier in any call position
];

const FORBIDDEN = [
  { name: "pg / postgres", packages: [/(^|\/)pg($|\/)/, /(^|\/)pg-[a-z0-9-]+($|\/)/, /(^|\/)postgres($|\/)/], symbols: [/pg-connection-string/, /node-postgres/] },
  { name: "child_process", packages: [/(^|\/)child_process($|\/)/], symbols: [...builtinSymbols("child_process"), /\bexecSync\b/, /\bspawnSync\b/] },
  // `node:net` was absent from this table entirely: a review reached it from the callback and NOTHING fired, in a chunk
  // the walk had already opened. A raw socket in the public callback path is exactly what doc 83 §2 forbids.
  { name: "node:net / tls / dgram", packages: [], symbols: [...builtinSymbols("net"), ...builtinSymbols("tls"), ...builtinSymbols("dgram")] },
  { name: "execa", packages: [/(^|\/)execa($|\/)/], symbols: [/VERCEL_CLI_EXEC_FAILED/] },
  { name: "@vercel/cli-exec", packages: [/@vercel\/cli-exec/], symbols: [/Vercel CLI command/] },
  { name: "@vercel/cli-config", packages: [/@vercel\/cli-config/], symbols: [/cred-storage/] },
  { name: "cross-spawn", packages: [/(^|\/)cross-spawn($|\/)/], symbols: [] },
  { name: "keytar / keyring", packages: [/(^|\/)keytar($|\/)/, /(^|\/)node-keyring($|\/)/], symbols: [...builtinSymbols("keytar")] },
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

// ── (1) the traced file list — externalized packages ─────────────────────────────────────────────────────────────────
const trace = JSON.parse(readFileSync(tracePath, "utf8"));
const traced = (trace.files ?? []).map((f) => resolve(dirname(tracePath), f));
if (traced.length === 0) fail("the nft trace lists ZERO files — it cannot be proving anything");
const packagesSeen = new Set();
for (const f of traced) {
  if (!f.includes("node_modules/")) continue;
  packagesSeen.add(f.slice(f.lastIndexOf("node_modules/") + "node_modules/".length));
}

// ── (2) sourcemap provenance — packages the bundler INLINED ──────────────────────────────────────────────────────────
// This is the signal the first version lacked, and it is the one that matters. A pure-ESM driver such as `postgres` is
// inlined into a chunk rather than externalized, so it appears in NO nft trace and its package name appears nowhere in
// the emitted JS — a review proved a real `postgres` client in the callback closure passed the guard 5/5 green while
// its wire protocol was demonstrably in the bundle. Turbopack still emits a sourcemap per chunk whose `sources` name
// the original module paths, so provenance survives inlining even when identifiers do not.
const routeJs = tracePath.replace(/\.nft\.json$/, "");

// THE CHUNK CLOSURE IS TRANSITIVE, NOT ONE LEVEL DEEP.
//
// It used to be exactly the `server/chunks/...` strings appearing inside `route.js`. A review defeated all three
// signals by changing one keyword: `await import("@aws-sdk/client-kms")` instead of a static import. A dynamically
// imported package lands in its OWN chunk, referenced from a sibling chunk rather than from `route.js`, so the scan
// never opened it — and the script printed OK while `client-kms` and `node:child_process` sat in the deployed lambda.
// Verified: with the bypass applied, `.next/server/chunks/[externals]_node_child_process_*.js` exists and is traced,
// and the guard passed.
//
// So the walk follows references until closure. A capability one lazy hop away is still in the function.
if (!existsSync(routeJs)) {
  // Absence is a FAILURE, never a skip — the same rule the header states for a missing build. Previously the
  // zero-chunks check was itself gated on this file existing, so a renamed build output would have silently disabled
  // signals 2 and 3 and still exited 0.
  fail(`no route loader at ${routeJs.slice(SERVER.length + 1)} — the chunk signals cannot run, and that is a failure`);
}
const chunkRefs = [];
{
  const seen = new Set();
  const queue = existsSync(routeJs) ? [routeJs] : [];
  while (queue.length) {
    const f = queue.pop();
    if (seen.has(f) || !existsSync(f)) continue;
    seen.add(f);
    if (f !== routeJs) chunkRefs.push(f);
    for (const m of readFileSync(f, "utf8").matchAll(/["'](server\/chunks\/[^"']+?\.js)["']/g)) {
      const next = join(SERVER, m[1].replace(/^server\//, ""));
      if (!seen.has(next)) queue.push(next);
    }
  }
}
if (existsSync(routeJs) && chunkRefs.length === 0) fail("the route loader references ZERO chunks — the closure cannot be proving anything");

// Turbopack names a vendored chunk `node_modules_<pkg>_<hash>.js` — with UNDERSCORES. The package-path checks below
// look for the `node_modules/` slash form, which a chunk FILENAME never has, so a whole class of vendored capability
// was invisible to them. Read the chunk names themselves as an additional package signal.
for (const c of chunkRefs) {
  const base = c.slice(c.lastIndexOf("/") + 1);
  const m = base.match(/node_modules_(.+?)_[a-z0-9-]+\._?\.?js$/) ?? base.match(/node_modules_(.+)\.js$/);
  if (m) packagesSeen.add(m[1].replace(/_/g, "/"));
  const ext = base.match(/^\[externals\]_(.+?)_[a-z0-9]+\._?\.?js$/);
  if (ext) packagesSeen.add(ext[1].replace(/_/g, ":").replace(/^node:/, "node:"));
}

let mapped = 0;
for (const c of chunkRefs) {
  const mp = `${c}.map`;
  if (!existsSync(mp)) { fail(`no sourcemap for ${c.slice(SERVER.length + 1)} — inlined packages would be invisible`); continue; }
  mapped++;
  let sources = [];
  try { sources = JSON.parse(readFileSync(mp, "utf8")).sources ?? []; } catch { fail(`unreadable sourcemap ${mp}`); continue; }
  for (const raw of sources) {
    // Sourcemap sources are URI-encoded, so a SCOPED package arrives as `%40aws-sdk/client-kms/...`. Decoding is
    // load-bearing, not tidiness: without it the `@aws-sdk/client-kms` control passed while the client was in the
    // bundle — the same class of miss as the inlined-package gap this signal exists to close.
    let src = raw;
    try { src = decodeURIComponent(raw); } catch { /* leave as-is; a malformed escape is still worth matching raw */ }
    if (!src.includes("node_modules/")) continue;
    packagesSeen.add(src.slice(src.lastIndexOf("node_modules/") + "node_modules/".length));
  }
}
if (chunkRefs.length > 0 && mapped === 0) fail("no chunk sourcemaps at all — the inlining signal is dead");

for (const rel of packagesSeen) {
  for (const cap of FORBIDDEN) {
    if (cap.packages.some((re) => re.test(rel))) fail(`${cap.name}: reachable from the callback closure via node_modules/${rel}`);
  }
}

// ── (3) runtime symbols — Node builtins and class names, which are not node_modules files at all ────────────────────
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
console.log(`check-callback-bundle OK — ${traced.length} traced file(s), ${chunkRefs.length} chunk(s), ${packagesSeen.size} distinct package path(s) reachable from the OAuth callback closure; none of ${FORBIDDEN.length} forbidden capabilities present`);
