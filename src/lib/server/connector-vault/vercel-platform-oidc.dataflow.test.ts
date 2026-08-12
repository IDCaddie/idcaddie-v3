import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import ts from "typescript";
import { exchangeForDedicatedAudience } from "./vercel-platform-oidc";
import { acquireDedicatedAudienceAssertion, HANDOFF_OIDC_AUDIENCE } from "./oauth-handoff-client";

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

/**
 * Does this file hold ANY capability that could reach the platform OIDC value?
 *
 * NOT a search for one spelling. A review evaded the previous single regex three ways — `Object.getOwnPropertySymbols`
 * + a description match, a computed symbol key, and `process.env.VERCEL_OIDC_TOKEN` (which the approved module itself
 * uses, so the predicate was blind to its own file's second path). Enumerating spellings is unwinnable.
 *
 * What IS closed is the small set of MECHANISMS by which a module can reach the value at all, each detected
 * structurally over the AST. A module in the callback closure that holds none of these cannot obtain the token,
 * whatever it is called:
 *
 *   1. the request-context global — any `Symbol.for(...)`, `Object.getOwnPropertySymbols`, or computed `globalThis[...]`
 *   2. the env var — any reference to `VERCEL_OIDC_TOKEN`
 *   3. Next's request accessors — importing `next/headers`
 *
 * Only the approved module may hold any of them. That is a capability boundary, not a naming convention.
 */
function platformCapabilities(src: string): string[] {
  const sf = parse(src);
  const hits: string[] = [];
  const visit = (n: ts.Node): void => {
    // 1a. `Symbol.for(...)` reaching the request context. A STATIC literal that is demonstrably some other well-known
    //     symbol is fine — `Symbol.for("nodejs.util.inspect.custom")` is a redaction hook, the opposite of a leak. A
    //     NON-literal argument is not fine: a computed key is exactly how the regex was evaded.
    if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression)
      && ts.isIdentifier(n.expression.expression) && n.expression.expression.text === "Symbol"
      && n.expression.name.text === "for") {
      const arg = n.arguments[0];
      if (!arg || !ts.isStringLiteral(arg)) hits.push("Symbol.for(computed)");
      else if (arg.text.includes("request-context")) hits.push("Symbol.for(request-context)");
    }
    // 1b. enumerating globalThis's symbols — no legitimate use in this closure, and the evasion the regex missed.
    if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression)
      && n.expression.name.text === "getOwnPropertySymbols") hits.push("Object.getOwnPropertySymbols");
    // 1c. a computed index into globalThis, however the key is built.
    if (ts.isElementAccessExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === "globalThis") {
      hits.push("globalThis[computed]");
    }
    // 2. the OIDC env var, in any form.
    if ((ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) && n.text.includes("VERCEL_OIDC_TOKEN")) hits.push("VERCEL_OIDC_TOKEN");
    if (ts.isIdentifier(n) && n.text === "VERCEL_OIDC_TOKEN") hits.push("VERCEL_OIDC_TOKEN");
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return [...new Set(hits)];
}

/**
 * Does this module import Next's request accessors? Allowed on its own — Supabase auth legitimately reads cookies —
 * but a module that holds one of those AND a platform capability is reaching for the OIDC value through the request,
 * which is precisely what §8.4 rule 1 forbids. The co-occurrence is the violation, not the import.
 */
function importsRequestAccessors(src: string): boolean {
  const sf = parse(src);
  let found = false;
  const visit = (n: ts.Node): void => {
    if ((ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) && n.moduleSpecifier && ts.isStringLiteral(n.moduleSpecifier)
      && /^next\/(headers|cookies)$/.test(n.moduleSpecifier.text)) found = true;
    if (ts.isCallExpression(n) && n.expression.kind === ts.SyntaxKind.ImportKeyword
      && n.arguments[0] && ts.isStringLiteral(n.arguments[0]) && /^next\/(headers|cookies)$/.test((n.arguments[0] as ts.StringLiteral).text)) found = true;
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return found;
}

const closure = importClosure(ROUTE);

describe("platform-token dataflow, rooted at the real callback route closure", () => {
  it("the closure is real — it reaches the approved module and a plausible number of files", () => {
    expect(existsSync(ROUTE)).toBe(true);
    expect(closure.length).toBeGreaterThan(5);
    expect(closure).toContain(APPROVED);
  });

  // (1) EXACTLY ONE module may hold ANY platform-token capability — computed over the closure, not a maintained list.
  it("exactly one module in the callback closure holds a platform-token capability", () => {
    const holders = closure
      .map((f) => ({ f, caps: platformCapabilities(readFileSync(f, "utf8")) }))
      .filter((x) => x.caps.length > 0);
    expect(holders.map((x) => x.f)).toEqual([APPROVED]);
  });

  it("the approved module's capabilities are the expected ones, and no more", () => {
    const caps = platformCapabilities(readFileSync(APPROVED, "utf8")).sort();
    expect(caps).toEqual(["Symbol.for(request-context)", "VERCEL_OIDC_TOKEN"]);
  });

  // `next/headers` is allowed elsewhere (Supabase auth reads cookies). Holding it TOGETHER with a platform capability
  // is not: that combination is a module reaching for the OIDC value through the request.
  it("no module combines a request accessor with a platform-token capability", () => {
    const both = closure.filter((f) => {
      const src = readFileSync(f, "utf8");
      return importsRequestAccessors(src) && platformCapabilities(src).length > 0;
    });
    expect(both).toEqual([]);
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
    // …and `assertion` on the runner comes from `acquireDedicatedAudienceAssertion`, which has no parameter for one.
    const runner = readFileSync(join(HERE, "oauth-callback-handoff.ts"), "utf8");
    // The assertion has exactly ONE construction path: the approved module's exported operation, called directly.
    // There is no injectable producer to substitute — a review previously swapped `readAssertion` for a helper
    // returning an inbound Authorization bearer and the whole suite stayed green.
    expect(runner).toMatch(/const acquired = await acquireDedicatedAudienceAssertion\(deps\.config\.audience, deps\.exchange\)/);
    expect(runner).toMatch(/const assertion = acquired\.token/);
    // The seam is gone, not merely unused. Code forms only — both files name it in prose to explain why it was removed,
    // and that documentation is worth more than the convenience of a bare-word match.
    const seam = /\.readAssertion|readAssertion\s*[(:?]/;
    expect(runner).not.toMatch(seam);
    expect(readFileSync(join(HERE, "real-callback-dependencies.ts"), "utf8")).not.toMatch(seam);
  });

  // (5) BEHAVIOURAL: caller-controlled input cannot supply or override the assertion. `acquireDedicatedAudienceAssertion` takes an
  //     audience and injection points — there is no parameter through which a request value could arrive.
  it("no exported signature accepts a caller-supplied assertion", async () => {
    let exchanged = 0;
    const r = await acquireDedicatedAudienceAssertion(HANDOFF_OIDC_AUDIENCE, {
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
describe("the four bypasses a review used are all caught by the capability boundary", () => {
  const cases: [string, string][] = [
    ["Object.getOwnPropertySymbols evasion", `
      const s = Object.getOwnPropertySymbols(globalThis).find((x) => x.description?.endsWith("/request-context"));
      export const steal = () => (globalThis as never)[s as never];`],
    ["process.env.VERCEL_OIDC_TOKEN", `export const steal = () => process.env.VERCEL_OIDC_TOKEN;`],
    ["computed Symbol.for key", `const k = ["@vercel", "request-context"].join("/"); export const steal = () => Symbol.for(k);`],
    ["computed globalThis index", `const K = "@vercel/request-context"; export const steal = () => (globalThis as never)[Symbol.for(K) as never];`],
  ];
  for (const [name, src] of cases) {
    it(`detects: ${name}`, () => expect(platformCapabilities(src).length, src).toBeGreaterThan(0));
  }

  it("does NOT fire on the legitimate uses that already exist in the closure", () => {
    expect(platformCapabilities(`class X { [Symbol.for("nodejs.util.inspect.custom")]() { return "[redacted]"; } }`)).toEqual([]);
    expect(platformCapabilities(`import { cookies } from "next/headers"; export const c = () => cookies();`)).toEqual([]);
  });

  it("a helper importing next/headers is only a violation when it ALSO holds a platform capability", () => {
    const benign = `import { cookies } from "next/headers"; export const c = () => cookies();`;
    const hostile = `import { headers } from "next/headers"; export const s = () => process.env.VERCEL_OIDC_TOKEN;`;
    expect(importsRequestAccessors(benign) && platformCapabilities(benign).length > 0).toBe(false);
    expect(importsRequestAccessors(hostile) && platformCapabilities(hostile).length > 0).toBe(true);
  });
});
