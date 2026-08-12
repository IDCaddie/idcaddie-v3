import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";

// ── THE HEADER TRUST BOUNDARY, ENFORCED OVER THE AST ─────────────────────────────────────────────────────────────────
//
// Doc 83 §8.4 (Option B) permits exactly one source for the handoff assertion: the official `@vercel/oidc` SDK, which
// reads the platform-injected token from Vercel's own request context. It forbids application code from reading
// `x-vercel-oidc-token` itself, and forbids any caller-supplied value becoming the outbound `Authorization`.
//
// The first version of these rules was regex over source text, and an adversarial review broke both in the form a
// developer here would actually write: `(await headers()).get("x-vercel-oidc-token")` passed cleanly, so did aliasing
// the header name to a constant, so did concatenating it, and so did splitting an Authorization forward across two
// lines. A same-line, order-anchored regex is not a boundary.
//
// These rules parse the file instead. They are deliberately BLUNT — the completion path has no legitimate reason to
// read an inbound header at all — because a blunt rule that cannot be reworded around is worth more here than a precise
// one that can.

const SRC = join(process.cwd(), "src");
const HEADER = "x-vercel-oidc-token";
// The ONE module permitted to touch the platform OIDC value (doc 83 §8.4). Its raw token never leaves it.
const APPROVED_OIDC_MODULE = "lib/server/connector-vault/vercel-platform-oidc.ts";

function walkFiles(dir: string, acc: string[] = []): string[] {
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) walkFiles(p, acc);
    else if (/\.tsx?$/.test(n) && !/\.test\.tsx?$/.test(n)) acc.push(p);
  }
  return acc;
}
const rel = (p: string) => p.slice(SRC.length + 1);
const parse = (src: string) => ts.createSourceFile("f.ts", src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);

/** Every string value the AST can see, including the pieces of a `+` concatenation and template literals. */
function stringValues(sf: ts.SourceFile): string[] {
  const out: string[] = [];
  const visit = (n: ts.Node): void => {
    if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) out.push(n.text);
    if (ts.isTemplateExpression(n)) out.push(n.head.text + n.templateSpans.map((s) => s.literal.text).join(""));
    if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      const lit = (e: ts.Expression): string => (ts.isStringLiteral(e) ? e.text : ts.isBinaryExpression(e) ? lit(e.left) + lit(e.right) : "");
      out.push(lit(n.left) + lit(n.right));
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

/** An INBOUND header read: `x.headers.get(...)`, `x.headers[...]`, `Object.fromEntries(x.headers)`, or `headers()`. */
function inboundHeaderReads(sf: ts.SourceFile): string[] {
  const hits: string[] = [];
  const visit = (n: ts.Node): void => {
    // `<expr>.headers` used as a VALUE. An object-literal property called `headers` (an outbound Response init) is a
    // PropertyAssignment, not a PropertyAccessExpression, so it is structurally excluded rather than special-cased.
    if (ts.isPropertyAccessExpression(n) && n.name.text === "headers") hits.push(`.headers on ${n.expression.getText().slice(0, 40)}`);
    if (ts.isElementAccessExpression(n) && ts.isPropertyAccessExpression(n.expression) && n.expression.name.text === "headers") hits.push("headers[...]");
    // `headers()` / `cookies()` from next/headers — the request-scoped accessors.
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && (n.expression.text === "headers" || n.expression.text === "cookies")) {
      hits.push(`${n.expression.text}()`);
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return hits;
}

const COMPLETION_PATH = [
  "lib/server/connector-vault/oauth-state.ts",
  "lib/server/connector-vault/oauth-pending.ts",
  "lib/server/connector-vault/oauth-payload-seal.ts",
  "lib/server/connector-vault/oauth-handoff-client.ts",
  "lib/server/connector-vault/oauth-callback-handoff.ts",
  "lib/server/connector-vault/real-callback-dependencies.ts",
  "lib/server/connector-vault/staging-environment-identity.ts",
  "app/(authenticated)/connectors/oauth/callback/route.ts",
];

// `oauth-handoff-protocol.ts` is deliberately NOT in that list, and the reason is asserted below rather than assumed.
// It is the SHARED contract: V3 uses its request-BUILDING half, while `verifyHandoffRequest` — the worker's RECEIVING
// half — legitimately reads the inbound handoff request's version, digest and correlation headers. That is the worker
// reading its own caller, not V3 reading a browser. V3 has no caller of it outside tests, which is what makes the
// exclusion sound; if that ever changes, the assertion below fails before the exclusion can hide anything.
const WORKER_SIDE_SHARED = "lib/server/connector-vault/oauth-handoff-protocol.ts";

describe("the header trust boundary, over the AST", () => {
  const files = walkFiles(SRC).map((p) => ({ rel: rel(p), src: readFileSync(p, "utf8") }));

  it("has files to check (a silent empty sweep is the failure mode this guards)", () => {
    expect(files.length).toBeGreaterThan(100);
    for (const p of COMPLETION_PATH) expect(files.some((f) => f.rel === p), `missing ${p}`).toBe(true);
  });

  // RULE A — SEMANTIC, not a string prohibition. Vercel's documented Function delivery mechanism IS that header, so
  // forbidding the name outright was both unenforceable (a review bypassed it 15 ways: fromCharCode, array join,
  // base64/hex decode, .concat, Reflect.get, an alias chain, a helper in another module) and wrong in principle.
  //
  // The boundary that actually holds: EXACTLY ONE module may touch the platform OIDC value, and it does not hand the
  // raw value out. Everything else is expressed as dataflow in `vercel-platform-oidc.dataflow.test.ts`.
  it("exactly one approved module names the platform OIDC header", () => {
    const namers = files
      .filter((f) => stringValues(parse(f.src)).some((v) => v.toLowerCase().includes(HEADER)))
      .map((f) => f.rel);
    expect(namers).toEqual([APPROVED_OIDC_MODULE]);
  });

  it("the approved module does not export the raw platform token — only an exchanged one", () => {
    const src = files.find((f) => f.rel === APPROVED_OIDC_MODULE)?.src ?? "";
    expect(src).toContain("function readPlatformToken");     // it exists
    expect(src).not.toMatch(/export\s+(?:async\s+)?function\s+readPlatformToken/); // and is NOT exported
    // The only exported way to obtain a token returns the EXCHANGED one.
    expect(src).toMatch(/export async function exchangeForDedicatedAudience/);
  });

  it("only the handoff client consumes the approved module", () => {
    const importers = files
      .filter((f) => f.rel !== APPROVED_OIDC_MODULE && /from\s+["'].*vercel-platform-oidc["']/.test(f.src))
      .map((f) => f.rel);
    expect(importers).toEqual(["lib/server/connector-vault/oauth-handoff-client.ts"]);
  });

  // RULE B — no file on the completion path reads an INBOUND header or cookie at all. The assertion comes from the SDK;
  // nothing else on this path has a reason to look at request headers, so the capability is removed rather than policed.
  it("the shared-contract exclusion is sound — V3 never calls the worker's receiving half", () => {
    const callers = files.filter((f) => f.rel !== WORKER_SIDE_SHARED && /\bverifyHandoffRequest\b/.test(f.src));
    expect(callers.map((f) => f.rel)).toEqual([]);
  });

  it("no completion-path file reads an inbound header or cookie", () => {
    const offenders = files
      .filter((f) => COMPLETION_PATH.includes(f.rel))
      .map((f) => ({ rel: f.rel, hits: inboundHeaderReads(parse(f.src)) }))
      .filter((f) => f.hits.length > 0);
    expect(offenders).toEqual([]);
  });
});

// ── MUTATION: every bypass the review demonstrated must now fire ──────────────────────────────────────────────────────
describe("the AST rules fire on every form the regex missed", () => {
  const namesHeader = (src: string) => stringValues(parse(src)).some((v) => v.toLowerCase().includes(HEADER));
  const readsHeaders = (src: string) => inboundHeaderReads(parse(src)).length > 0;

  const headerNamePlants: [string, string][] = [
    ["direct literal", `const t = request.headers.get("x-vercel-oidc-token");`],
    ["next/headers accessor (broke regex 1)", `const h = await headers(); const t = h.get("x-vercel-oidc-token");`],
    ["inline next/headers accessor", `const t = (await headers()).get("x-vercel-oidc-token");`],
    ["alias to a constant (broke regex 1)", `const H = "x-vercel-oidc-token"; const t = request.headers.get(H);`],
    ["string concatenation (broke regex 1)", `const t = request.headers.get("x-vercel-" + "oidc-token");`],
    ["computed key via fromEntries", `const t = Object.fromEntries(request.headers)["x-vercel-oidc-token"];`],
    ["template literal", "const t = req.headers.get(`x-vercel-oidc-token`);"],
    ["uppercase spelling", `const t = req.headers.get("X-Vercel-OIDC-Token");`],
  ];
  // These are the forms that bypassed the old regex. The AST sees all of them — which is what makes "only the approved
  // module may name it" enforceable at all.
  for (const [name, src] of headerNamePlants) {
    it(`the AST sees the header name via: ${name}`, () => expect(namesHeader(src)).toBe(true));
  }

  const headerReadPlants: [string, string][] = [
    ["request.headers.get", `const a = request.headers.get("authorization");`],
    ["multiline Authorization forward (broke regex 2)", `const a = request.headers.get("authorization");\nconst h = { Authorization: a };`],
    ["differently-named inbound header into Bearer", `const t = req.headers.get("x-my-token");\nconst h = { authorization: \`Bearer \${t}\` };`],
    ["next/headers accessor", `const h = await headers();`],
    ["cookies accessor", `const c = await cookies();`],
    ["fromEntries over headers", `const all = Object.fromEntries(request.headers);`],
    ["element access on headers", `const t = request.headers["authorization"];`],
  ];
  for (const [name, src] of headerReadPlants) {
    it(`RULE B fires on: ${name}`, () => expect(readsHeaders(src)).toBe(true));
  }

  // The rules must not fire on legitimate OUTBOUND construction, or the boundary becomes unworkable and gets removed.
  const allowed: [string, string][] = [
    ["outbound Response init", `new Response(null, { status: 303, headers: { location: "/x", "cache-control": "no-store" } });`],
    ["outbound fetch init", `await fetch(url, { method: "POST", headers: { authorization: \`Bearer \${assertion}\` } });`],
    ["a variable merely called headers", `const headersDoc = "we never read inbound headers";`],
  ];
  for (const [name, src] of allowed) {
    it(`neither rule fires on legitimate: ${name}`, () => {
      expect(namesHeader(src)).toBe(false);
      expect(readsHeaders(src)).toBe(false);
    });
  }
});
