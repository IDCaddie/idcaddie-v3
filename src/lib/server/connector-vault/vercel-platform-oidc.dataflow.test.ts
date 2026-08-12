import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import ts from "typescript";
import { exchangeForDedicatedAudience } from "./vercel-platform-oidc";
import { acquireDedicatedAudienceAssertion, HANDOFF_OIDC_AUDIENCE } from "./oauth-handoff-client";
import { withPlatform } from "./platform-context.testkit";

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
/** Every extension Next's resolver will load. Narrower than this and the closure is a fiction. */
const RESOLVES_AS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"];
const unresolvable: string[] = [];
function importClosure(entry: string): string[] {
  const seen = new Set<string>();
  const queue = [entry];
  while (queue.length) {
    const f = queue.pop() as string;
    if (seen.has(f) || !existsSync(f)) continue;
    seen.add(f);
    const sf = parse(readFileSync(f, "utf8"));
    const visit = (n: ts.Node): void => {
      // A dynamic import whose specifier is NOT a plain string literal cannot be resolved here, so the module it
      // reaches would silently leave the closure. A review used exactly that — a template literal — to hide a module
      // holding `process.env.VERCEL_OIDC_TOKEN`. Unresolvable is recorded and asserted on, never skipped.
      if (ts.isCallExpression(n) && n.expression.kind === ts.SyntaxKind.ImportKeyword
        && n.arguments[0] && !ts.isStringLiteral(n.arguments[0])) {
        unresolvable.push(`${f.slice(process.cwd().length + 5)}: import(${n.arguments[0].getText().slice(0, 40)})`);
      }
      const spec =
        (ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) && n.moduleSpecifier && ts.isStringLiteral(n.moduleSpecifier)
          ? n.moduleSpecifier.text
          : ts.isCallExpression(n) && n.expression.kind === ts.SyntaxKind.ImportKeyword && n.arguments[0] && ts.isStringLiteral(n.arguments[0])
            ? (n.arguments[0] as ts.StringLiteral).text
            : null;
      if (spec) {
        const base = spec.startsWith(".") ? resolve(dirname(f), spec) : spec.startsWith("@/") ? join(process.cwd(), "src", spec.slice(2)) : null;
        // `index.tsx` was missing from this list, and a review put a module holding the crudest possible violation
        // behind exactly that filename. Every extension Next resolves must be probed or the closure is a fiction.
        // EVERY extension the RUNTIME resolver accepts, not just the ones we happen to write. `allowJs` is on in
        // tsconfig and Next resolves `.js`/`.jsx`/`.mjs`/`.cjs`, so a `.js` module was in the real closure and invisible
        // to this walk — a review used exactly that to patch `globalThis.fetch` inside the callback process while this
        // test still reported the reviewed 24. A resolver that is narrower than the runtime's is not a boundary.
        if (base) for (const c of RESOLVES_AS.map((e) => `${base}${e}`).concat(RESOLVES_AS.map((e) => join(base, `index${e}`)))) {
          if (existsSync(c) && !seen.has(c)) queue.push(c);
        }
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
  // Names bound directly to `globalThis` — an alias is the same capability under a different identifier.
  const globalAliases = new Set<string>();
  const collectAliases = (n: ts.Node): void => {
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer) {
      const u = (e: ts.Expression): ts.Expression =>
        ts.isAsExpression(e) || ts.isParenthesizedExpression(e) || ts.isSatisfiesExpression(e) || ts.isTypeAssertionExpression(e) ? u(e.expression) : e;
      const init = u(n.initializer);
      if (ts.isIdentifier(init) && (init.text === "globalThis" || globalAliases.has(init.text))) globalAliases.add(n.name.text);
    }
    ts.forEachChild(n, collectAliases);
  };
  collectAliases(sf);
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
    // 1c. a computed index into globalThis, however the key is built AND however the callee is spelled.
    //
    // This rule used to require a bare `globalThis` Identifier as the callee — a form that does not typecheck in this
    // project, because indexing it needs a cast, and the cast makes the callee an AsExpression. So the rule could not
    // fire on any shippable spelling: it was decoration. Unwrap casts, parentheses and `satisfies`, and follow a
    // single-level alias (`const g = globalThis as never; g[k]`), which is how a review spelled it.
    if (ts.isElementAccessExpression(n)) {
      const unwrap = (e: ts.Expression): ts.Expression =>
        ts.isAsExpression(e) || ts.isParenthesizedExpression(e) || ts.isSatisfiesExpression(e) || ts.isTypeAssertionExpression(e)
          ? unwrap(e.expression) : e;
      const callee = unwrap(n.expression);
      if (ts.isIdentifier(callee) && (callee.text === "globalThis" || globalAliases.has(callee.text))) hits.push("globalThis[computed]");
    }
    // 1d. any enumeration of an object's own keys that can yield SYMBOLS — `Reflect.ownKeys` returns them too, and a
    //     review used it precisely because the rule named only `Object.getOwnPropertySymbols`.
    if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression)
      && ts.isIdentifier(n.expression.expression) && n.expression.expression.text === "Reflect"
      && n.expression.name.text === "ownKeys") hits.push("Reflect.ownKeys");
    // 2. the OIDC env var, in any form.
    if ((ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) && n.text.includes("VERCEL_OIDC_TOKEN")) hits.push("VERCEL_OIDC_TOKEN");
    if (ts.isIdentifier(n) && n.text === "VERCEL_OIDC_TOKEN") hits.push("VERCEL_OIDC_TOKEN");
    // Built by `+` from pieces — `"VERCEL_OIDC" + "_TOKEN"` was a review's bypass of the literal check above.
    if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      const lit = (e: ts.Expression): string =>
        ts.isStringLiteral(e) ? e.text : ts.isBinaryExpression(e) ? lit(e.left) + lit(e.right) : "\u0000";
      if (lit(n).includes("VERCEL_OIDC_TOKEN")) hits.push("VERCEL_OIDC_TOKEN");
    }
    // …or joined from an array of pieces, the same trick one call deeper.
    if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && n.expression.name.text === "join"
      && ts.isArrayLiteralExpression(n.expression.expression)) {
      const sep = n.arguments[0] && ts.isStringLiteral(n.arguments[0]) ? n.arguments[0].text : ",";
      const joined = n.expression.expression.elements.map((e) => (ts.isStringLiteral(e) ? e.text : "\u0000")).join(sep);
      if (joined.includes("VERCEL_OIDC_TOKEN") || joined.includes("vercel-oidc-token")) hits.push("VERCEL_OIDC_TOKEN");
    }
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

/**
 * THE REVIEWED CALLBACK CLOSURE.
 *
 * Every capability scan in this file is a predicate over the modules the route can reach, and a review defeated three
 * of them the same way each time: not by evading a predicate, but by ADDING A MODULE the predicate had no reason to
 * suspect — `Reflect.ownKeys` instead of `getOwnPropertySymbols`, a concatenated env key instead of a literal, an
 * `index.tsx`, a template-literal `import()`. Detecting arbitrary obfuscation in source is not a winnable game.
 *
 * So membership itself is the boundary. This list is the set of modules a human has reviewed for the callback path.
 * A new module in the closure fails this test, whatever it contains and however it is spelled — which converts an
 * undecidable question ("is this obfuscated read of the platform token?") into a decidable one ("was this module
 * reviewed?"). Adding an entry here is the deliberate act of accepting a module into the public callback path.
 */
const REVIEWED_CLOSURE = [
  "app/(authenticated)/connectors/oauth/callback/route.ts",
  "lib/auth/session.ts",
  "lib/database.types.ts",
  "lib/server/connector-vault/connector-oauth-config.ts",
  "lib/server/connector-vault/connector-secret-ingest.ts",
  "lib/server/connector-vault/crypto.ts",
  "lib/server/connector-vault/oauth-callback-handoff.ts",
  "lib/server/connector-vault/oauth-callback-orchestrator.ts",
  "lib/server/connector-vault/oauth-callback-route-handler.ts",
  "lib/server/connector-vault/oauth-handoff-client.ts",
  "lib/server/connector-vault/oauth-handoff-protocol.ts",
  "lib/server/connector-vault/oauth-payload-seal.ts",
  "lib/server/connector-vault/oauth-pending.ts",
  "lib/server/connector-vault/oauth-state.ts",
  "lib/server/connector-vault/read-bounded.ts",
  "lib/server/connector-vault/real-callback-dependencies.ts",
  "lib/server/connector-vault/run-lifecycle.ts",
  "lib/server/connector-vault/secret-audit.ts",
  "lib/server/connector-vault/secret-vault.ts",
  "lib/server/connector-vault/slack-oauth-exchange.ts",
  "lib/server/connector-vault/staging-environment-identity.ts",
  "lib/server/connector-vault/vercel-platform-oidc.ts",
  "lib/supabase/env.ts",
  "lib/supabase/server.ts",
];

describe("platform-token dataflow, rooted at the real callback route closure", () => {
  it("the callback closure contains exactly the reviewed modules — no new module enters unreviewed", () => {
    const actual = closure.map((f) => f.slice(process.cwd().length + 5)).sort();
    expect(actual).toEqual([...REVIEWED_CLOSURE].sort());
  });

  it("every import on the path is statically resolvable — an unresolvable one hides a module", () => {
    expect(unresolvable).toEqual([]);
  });

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
    // `globalThis[computed]` appears here now and did not before. That is the point: the rule used to require a bare
    // `globalThis` identifier as the index callee, which does not typecheck in this project, so it could not fire on
    // the approved module's OWN `(globalThis as Record<symbol, …>)[VERCEL_REQUEST_CONTEXT]`. A rule blind to the one
    // real instance of the thing it names was decoration.
    expect(caps).toEqual(["Symbol.for(request-context)", "VERCEL_OIDC_TOKEN", "globalThis[computed]"]);
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
    // OVER THE WHOLE CLOSURE AND OVER THE AST, not one file and one spelling.
    //
    // The old rule read `oauth-handoff-client.ts` for `` authorization: `Bearer ${x}` `` and required the matches IT
    // HAPPENED TO FIND to mention `assertion`. A review defeated it twice: a second Bearer in the same file built with
    // `h.set("authorization", "Bearer " + supplied)`, and a new closure module calling `submitHandoff` with a bearer
    // taken from the inbound request. A rule that only inspects the matches it finds cannot see the one it missed.
    const bearerProducers: { file: string; expr: string }[] = [];
    for (const f of closure) {
      const sf = parse(readFileSync(f, "utf8"));
      const rel = f.slice(process.cwd().length + 5);
      const visit = (n: ts.Node): void => {
        // Any expression whose literal parts contain "Bearer ", however assembled.
        const literalOf = (e: ts.Node): string =>
          ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e) ? e.text
          : ts.isTemplateExpression(e) ? e.head.text + e.templateSpans.map((sp) => sp.literal.text).join("")
          : ts.isBinaryExpression(e) && e.operatorToken.kind === ts.SyntaxKind.PlusToken ? literalOf(e.left) + literalOf(e.right)
          : "";
        if ((ts.isTemplateExpression(n) || ts.isBinaryExpression(n) || ts.isStringLiteral(n)) && /bearer /i.test(literalOf(n))) {
          bearerProducers.push({ file: rel, expr: n.getText().replace(/\s+/g, " ").slice(0, 120) });
        }
        ts.forEachChild(n, visit);
      };
      visit(sf);
    }
    expect(bearerProducers.length, "no Bearer is constructed anywhere — this rule has lost its subject").toBeGreaterThan(0);
    for (const b of bearerProducers) expect(b.expr, `${b.file}: ${b.expr}`).toMatch(/assertion/);

    // …and `submitHandoff`, which takes the assertion as an ordinary parameter, has exactly ONE caller. Otherwise a
    // module could pass a bearer of its own choosing without ever constructing the string itself.
    const callers = closure.filter((f) => {
      if (f.endsWith("oauth-handoff-client.ts")) return false;                      // its definition
      return /\bsubmitHandoff\s*\(/.test(readFileSync(f, "utf8"));
    }).map((f) => f.slice(process.cwd().length + 5));
    expect(callers).toEqual(["lib/server/connector-vault/oauth-callback-handoff.ts"]);
    // …and `assertion` on the runner comes from `acquireDedicatedAudienceAssertion`, which has no parameter for one.
    const runner = readFileSync(join(HERE, "oauth-callback-handoff.ts"), "utf8");
    // The assertion has exactly ONE construction path: the approved module's exported operation, called directly.
    // There is no injectable producer to substitute — a review previously swapped `readAssertion` for a helper
    // returning an inbound Authorization bearer and the whole suite stayed green.
    expect(runner).toMatch(/const acquired = await acquireDedicatedAudienceAssertion\(deps\.config\.audience\);/);
    expect(runner).toMatch(/const assertion = acquired\.token/);
    // The seam is gone, not merely unused. Code forms only — both files name it in prose to explain why it was removed,
    // and that documentation is worth more than the convenience of a bare-word match.
    // Over CODE, with comments stripped: both files name the removed seams in prose to record why they are gone, and
    // that documentation is worth more than the convenience of matching a bare word.
    const stripComments = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
    const seam = /\.readAssertion|readAssertion\s*[(:?]|\bexchange\s*[:?]|ExchangeDeps/;
    for (const rel of ["oauth-callback-handoff.ts", "real-callback-dependencies.ts"]) {
      expect(stripComments(readFileSync(join(HERE, rel), "utf8")), rel).not.toMatch(seam);
    }
  });

  // (5) STRUCTURAL: the exchange has NO INJECTABLE DEPENDENCIES.
  //
  // This is the rule that was missing, and its absence cost two rounds. `exchangeForDedicatedAudience` used to take
  // `deps: { fetchImpl?, readContext? }`. A caller supplying `fetchImpl` received the RAW PLATFORM TOKEN in the
  // request body, and by returning a `Response` of its choosing decided the assertion that went to the worker. The
  // guards in force at the time all passed: rule (4) pinned the call site, the seam regex looked for `readAssertion`,
  // the capability scan found no `Symbol.for`, and the leak test below only ever examined the RETURN value. The
  // capability was in an ARGUMENT, so watching returns and call sites could not see it.
  //
  // Pinning the parameter list is what closes that: a dependency cannot be injected into a function that takes none.
  // ALL declarations of the name, not the last one seen. The first version assigned on every match while walking the
  // whole AST, so a trailing `function __shape() { function exchangeForDedicatedAudience(audience: string, timeoutMs:
  // number) {} }` shadowed the real signature and a review restored a live injectable behind it. Ambiguity is itself
  // the finding: if a name is declared more than once in these files, the guard cannot know which one ships.
  const paramsOf = (rel: string, fn: string): string[] => {
    const sf = parse(readFileSync(join(HERE, rel), "utf8"));
    const found: string[][] = [];
    const visit = (n: ts.Node): void => {
      if (ts.isFunctionDeclaration(n) && n.name?.text === fn) {
        found.push(n.parameters.map((prm) => `${(prm.name as ts.Identifier).text}: ${prm.type ? prm.type.getText() : "?"}`));
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
    expect(found.length, `${fn} in ${rel}: expected exactly one declaration, found ${found.length}`).toBe(1);
    return found[0];
  };

  // A review added `export function installExchangeTransport(f)` — a module-level mutable transport, zero change to
  // either pinned signature — and every guard stayed green. Pinning signatures is not enough; the SURFACE is pinned.
  it("the approved module exports exactly the reviewed surface", () => {
    const sf = parse(readFileSync(APPROVED, "utf8"));
    const exported: string[] = [];
    for (const st of sf.statements) {
      const mods = ts.canHaveModifiers(st) ? (ts.getModifiers(st) ?? []) : [];
      if (!mods.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)) continue;
      if (ts.isFunctionDeclaration(st) && st.name) exported.push(st.name.text);
      else if (ts.isTypeAliasDeclaration(st)) exported.push(st.name.text);
      else if (ts.isVariableStatement(st)) for (const d of st.declarationList.declarations) exported.push((d.name as ts.Identifier).text);
    }
    expect(exported.sort()).toEqual([
      "EXCHANGE_MAX_RESPONSE_BYTES", "EXCHANGE_TIMEOUT_MS", "ExchangeResult", "VERCEL_TOKEN_EXCHANGE_URL",
      "exchangeForDedicatedAudience",
    ]);
  });

  it("the exchange takes an audience and a timeout, and nothing else", () => {
    expect(paramsOf("vercel-platform-oidc.ts", "exchangeForDedicatedAudience"))
      .toEqual(["audience: string", "timeoutMs: number"]);
    expect(paramsOf("oauth-handoff-client.ts", "acquireDedicatedAudienceAssertion"))
      .toEqual(["audience: string", "timeoutMs: number"]);
  });

  it("no parameter on the acquisition path can carry a function, an object, or a token", () => {
    for (const [rel, fn] of [
      ["vercel-platform-oidc.ts", "exchangeForDedicatedAudience"],
      ["oauth-handoff-client.ts", "acquireDedicatedAudienceAssertion"],
    ] as const) {
      for (const p of paramsOf(rel, fn)) {
        const type = p.split(": ").slice(1).join(": ");
        // Primitives only. A function type is an injectable I/O seam; an object type can hide one in a field.
        expect(["string", "number", "boolean"], `${fn}(${p})`).toContain(type);
      }
    }
  });

  // (6) STRUCTURAL: the callback runner's dependency surface is a CLOSED, pinned set. Adding an injectable — under any
  //     name — fails here, which is what `readAssertion` and then `exchange` each needed and did not have.
  it("HandoffCallbackDeps exposes exactly the reviewed fields", () => {
    const sf = parse(readFileSync(join(HERE, "oauth-callback-handoff.ts"), "utf8"));
    // Same decoy defeat as `paramsOf`: a trailing `namespace __pin { export type HandoffCallbackDeps = {…} }` hid an
    // added `transport?: HandoffFetch` from the version that kept the last match.
    const all: string[][] = [];
    const visit = (n: ts.Node): void => {
      if (ts.isTypeAliasDeclaration(n) && n.name.text === "HandoffCallbackDeps" && ts.isTypeLiteralNode(n.type)) {
        all.push(n.type.members.map((m) => (m.name as ts.Identifier)?.text).filter(Boolean).sort());
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
    expect(all.length, `HandoffCallbackDeps: expected exactly one declaration, found ${all.length}`).toBe(1);
    const members = all[0];
    // `fetchImpl` carries the SEALED payload to the worker; it cannot influence the assertion. Everything else is
    // configuration or a clock. No member may supply, exchange for, or observe the platform token.
    expect(members).toEqual(["config", "expected", "fetchImpl", "now", "signer"]);
  });

  // (7) BEHAVIOURAL: with the doubles on the REAL globals — the only place they can now live — the platform token does
  //     not appear in the result, and no caller-reachable surface ever sees it.
  it("the exchange returns ONLY an exchanged token, never the platform one", async () => {
    const PLATFORM = "platform-token-must-not-escape";
    let sentBody = "";
    const restore = withPlatform(PLATFORM, (async (_u: string, init: { body?: string }) => {
      sentBody = String(init?.body ?? "");
      return new Response(JSON.stringify({ token: "exchanged.jwt.value" }));
    }) as never);
    try {
      const r = await exchangeForDedicatedAudience(HANDOFF_OIDC_AUDIENCE);
      expect(r).toEqual({ ok: true, token: "exchanged.jwt.value" });
      expect(JSON.stringify(r)).not.toContain(PLATFORM);
    } finally {
      restore();
    }
    // The token IS on the wire to Vercel — that is the protocol. What matters is that observing it required stubbing a
    // global, which no production signature exposes.
    expect(sentBody).toContain(PLATFORM);
  });

  it("with no platform token there is nothing to exchange, and no caller can supply one instead", async () => {
    const prev = process.env.VERCEL_OIDC_TOKEN;
    delete process.env.VERCEL_OIDC_TOKEN;
    let exchanged = 0;
    const restore = withPlatform(undefined, (async () => { exchanged++; return new Response("{}"); }) as never);
    try {
      expect(await acquireDedicatedAudienceAssertion(HANDOFF_OIDC_AUDIENCE))
        .toEqual({ ok: false, reason: "handoff_assertion_missing" });
      expect(exchanged).toBe(0);
    } finally {
      restore();
      if (prev !== undefined) process.env.VERCEL_OIDC_TOKEN = prev;
    }
  });
});
