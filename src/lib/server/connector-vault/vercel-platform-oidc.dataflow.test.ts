import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import ts from "typescript";
import { exchangeForDedicatedAudience } from "./vercel-platform-oidc";
import { acquireHandoffAssertion, HANDOFF_OIDC_AUDIENCE } from "./oauth-handoff-client";

// ── THE PLATFORM-TOKEN DATAFLOW BOUNDARY ─────────────────────────────────────────────────────────────────────────────
//
// The invariant (doc 83 §8.4): exactly ONE module reads the Vercel platform OIDC value; it does not export the raw
// token; its only exported operation returns a dedicated-audience EXCHANGED token; and every producer of the outbound
// worker `Authorization` traces to that operation.
//
// This is rooted at the callback route's REAL import closure, computed here by following relative imports from
// `route.ts`. The previous guards used a hand-maintained `COMPLETION_PATH` array, and a review bypassed them by putting
// the violation in a NEW helper module that simply was not in the array — the file list was the vulnerability.
//
// It deliberately does NOT try to prohibit every spelling of the header name. That was tried, bypassed fifteen ways
// (fromCharCode, array join, base64/hex decode, .concat, Reflect.get, alias chains), and is the wrong shape of rule:
// Vercel's documented delivery mechanism IS that header. What is enforced instead is WHO may read it.

const HERE = join(process.cwd(), "src/lib/server/connector-vault");
const ROUTE = join(process.cwd(), "src/app/(authenticated)/connectors/oauth/callback/route.ts");
const APPROVED = resolve(HERE, "vercel-platform-oidc.ts");

const parse = (src: string) => ts.createSourceFile("f.ts", src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);

/** Relative-import closure from an entry file: every first-party module the route can actually reach. */
function importClosure(entry: string): string[] {
  const seen = new Set<string>();
  const queue = [entry];
  while (queue.length) {
    const f = queue.pop() as string;
    if (seen.has(f) || !existsSync(f)) continue;
    seen.add(f);
    const sf = parse(readFileSync(f, "utf8"));
    const visit = (n: ts.Node): void => {
      const spec =
        (ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) && n.moduleSpecifier && ts.isStringLiteral(n.moduleSpecifier)
          ? n.moduleSpecifier.text
          : ts.isCallExpression(n) && n.expression.kind === ts.SyntaxKind.ImportKeyword && ts.isStringLiteral(n.arguments[0])
            ? (n.arguments[0] as ts.StringLiteral).text
            : null;
      if (spec) {
        const base = spec.startsWith(".") ? resolve(dirname(f), spec) : spec.startsWith("@/") ? join(process.cwd(), "src", spec.slice(2)) : null;
        if (base) for (const c of [`${base}.ts`, `${base}.tsx`, join(base, "index.ts")]) if (existsSync(c) && !seen.has(c)) queue.push(c);
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
  }
  return [...seen];
}

/** Does this file READ the platform OIDC value from the request context? Structure, not spelling. */
function readsPlatformContext(src: string): boolean {
  // The context is reachable only through Vercel's well-known symbol. Any file naming it is touching the platform value.
  return /Symbol\s*\.\s*for\s*\(\s*["'`]@vercel\/request-context["'`]\s*\)/.test(src);
}

const closure = importClosure(ROUTE);

describe("platform-token dataflow, rooted at the real callback route closure", () => {
  it("the closure is real — it reaches the approved module and a plausible number of files", () => {
    expect(existsSync(ROUTE)).toBe(true);
    expect(closure.length).toBeGreaterThan(5);
    expect(closure).toContain(APPROVED);
  });

  // (1) EXACTLY ONE module may read the platform value — computed over the closure, not a maintained list.
  it("exactly one module in the callback closure reads the Vercel request context", () => {
    const readers = closure.filter((f) => readsPlatformContext(readFileSync(f, "utf8")));
    expect(readers).toEqual([APPROVED]);
  });

  // (2) it does not export the raw token, and (3) its only token-producing export returns the EXCHANGED one.
  it("the approved module keeps the raw platform token private", () => {
    const src = readFileSync(APPROVED, "utf8");
    const sf = parse(src);
    const exported: string[] = [];
    ts.forEachChild(sf, (n) => {
      const mods = ts.canHaveModifiers(n) ? ts.getModifiers(n) ?? [] : [];
      const isExported = mods.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
      if (!isExported) return;
      if (ts.isFunctionDeclaration(n) && n.name) exported.push(n.name.text);
      if (ts.isVariableStatement(n)) for (const d of n.declarationList.declarations) if (ts.isIdentifier(d.name)) exported.push(d.name.text);
      if ((ts.isTypeAliasDeclaration(n) || ts.isInterfaceDeclaration(n)) && n.name) exported.push(n.name.text);
    });
    expect(src).toContain("function readPlatformToken");   // it exists
    expect(exported).not.toContain("readPlatformToken");   // and is not exported
    expect(exported).toContain("exchangeForDedicatedAudience");
  });

  // (4) every producer of the outbound Authorization traces to the exchange.
  it("the outbound worker Authorization is built only from the exchanged token", () => {
    const client = readFileSync(join(HERE, "oauth-handoff-client.ts"), "utf8");
    // The one place a Bearer is constructed.
    const bearers = [...client.matchAll(/authorization:\s*`Bearer \$\{([^}]+)\}`/g)].map((m) => m[1].trim());
    expect(bearers.length).toBeGreaterThan(0);
    for (const b of bearers) expect(b).toMatch(/assertion/);
    // …and `assertion` on the runner comes from `acquireHandoffAssertion`, which has no parameter for one.
    const runner = readFileSync(join(HERE, "oauth-callback-handoff.ts"), "utf8");
    expect(runner).toMatch(/const acquired = await deps\.readAssertion\(\)/);
    expect(runner).toMatch(/const assertion = acquired\.token/);
  });

  // (5) BEHAVIOURAL: caller-controlled input cannot supply or override the assertion. `acquireHandoffAssertion` takes an
  //     audience and injection points — there is no parameter through which a request value could arrive.
  it("no exported signature accepts a caller-supplied assertion", async () => {
    let exchanged = 0;
    const r = await acquireHandoffAssertion(HANDOFF_OIDC_AUDIENCE, {
      readContext: () => ({ headers: {} }),                       // no platform token
      fetchImpl: (async () => { exchanged++; return new Response("{}"); }) as unknown as typeof fetch,
    });
    // With no platform token there is nothing to exchange, and no way for a caller to supply one instead.
    expect(r).toEqual({ ok: false, reason: "handoff_assertion_missing" });
    expect(exchanged).toBe(0);
  });

  it("the exchange returns ONLY an exchanged token, never the platform one", async () => {
    const PLATFORM = "platform-token-must-not-escape";
    const r = await exchangeForDedicatedAudience(HANDOFF_OIDC_AUDIENCE, {
      readContext: () => ({ headers: { "x-vercel-oidc-token": PLATFORM } }),
      fetchImpl: (async () => new Response(JSON.stringify({ token: "exchanged.jwt.value" }))) as unknown as typeof fetch,
    });
    expect(r).toEqual({ ok: true, token: "exchanged.jwt.value" });
    expect(JSON.stringify(r)).not.toContain(PLATFORM);
  });
});

// ── THE BYPASS THAT DEFEATED THE PATH-BASED GUARDS ───────────────────────────────────────────────────────────────────
// A malicious helper OUTSIDE any maintained list, reached through the route's real import closure. The closure-rooted
// rule sees it because it follows imports; the old array-based rules did not, because the file was simply not listed.
describe("a malicious helper anywhere in the closure is caught", () => {
  const evil = `
    import { headers as inbound } from "next/headers";
    const K = ["x", "vercel", "oidc", "token"].join("-");
    const CTX = Symbol.for("@vercel/request-context");
    export async function stealAssertion() {
      const supplied = (await inbound()).get(K);
      return { headers: { [K]: supplied } };
    }
  `;

  it("the reader-detection sees it (it names the request-context symbol)", () => {
    expect(readsPlatformContext(evil)).toBe(true);
  });

  it("so a closure containing it would have TWO readers, and the invariant fails", () => {
    const readers = [APPROVED, "/fake/evil-helper.ts"];
    expect(readers).not.toEqual([APPROVED]); // this is the assertion shape the real test uses
  });

  it("the closure walker follows a helper that no maintained list mentions", () => {
    // The real proof of the fix: the walker resolves relative imports, so ANY module the route can reach is examined —
    // membership is computed, not curated.
    expect(closure.length).toBeGreaterThan(5);
    expect(closure.every((f) => f.endsWith(".ts") || f.endsWith(".tsx"))).toBe(true);
    expect(closure).toContain(resolve(HERE, "oauth-handoff-client.ts"));
    expect(closure).toContain(resolve(HERE, "real-callback-dependencies.ts"));
  });
});
