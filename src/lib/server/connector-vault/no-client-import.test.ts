import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

// Static server-only guard (docs/42 §6, PR C property 1.4): prove the connector vault crypto module is
// never reachable from client/browser code. This scans every .ts/.tsx under src/ and asserts that:
//   (a) NO file that declares "use client" imports the crypto module, and
//   (b) NO file under src/app (the route/component tree, server or client) imports it directly —
//       the crypto wrapper is reached only via future server-only DAL/runner code under src/lib/server.
// If a later PR legitimately wires the wrapper into a server-only runner, that runner lives under
// src/lib/server (not src/app, not a "use client" file), so this guard keeps holding.

const SRC = path.resolve(__dirname, "..", "..", "..", "..", "src");
// Any import path that references a server-only connector-vault module (crypto wrapper PR C, run/audit
// lifecycle PR D). The guard holds as the dir grows: new server-only modules under connector-vault/ are
// reached only from other src/lib/server code, never from "use client" / src/app.
const CRYPTO_REL_HINTS = [
  "connector-vault/crypto",
  "server/connector-vault/crypto",
  "lib/server/connector-vault/crypto",
  "connector-vault/oauth-real-exchange-wiring",
  "server/connector-vault/oauth-real-exchange-wiring",
  "lib/server/connector-vault/oauth-real-exchange-wiring",
  "connector-vault/connector-secret-decrypt-use",
  "server/connector-vault/connector-secret-decrypt-use",
  "lib/server/connector-vault/connector-secret-decrypt-use",
  "connector-vault/run-lifecycle",
  "server/connector-vault/run-lifecycle",
  "lib/server/connector-vault/run-lifecycle",
  "connector-vault/oauth-pending",
  "server/connector-vault/oauth-pending",
  "lib/server/connector-vault/oauth-pending",
  "connector-vault/kms-key-provider",
  "server/connector-vault/kms-key-provider",
  "lib/server/connector-vault/kms-key-provider",
  "connector-vault/aws-kms-client",
  "server/connector-vault/aws-kms-client",
  "lib/server/connector-vault/aws-kms-client",
  "connector-vault/aws-kms-sdk-sender",
  "server/connector-vault/aws-kms-sdk-sender",
  "lib/server/connector-vault/aws-kms-sdk-sender",
  "connector-vault/oauth-pending-consume",
  "server/connector-vault/oauth-pending-consume",
  "lib/server/connector-vault/oauth-pending-consume",
  "connector-vault/oauth-pending-executor",
  "server/connector-vault/oauth-pending-executor",
  "lib/server/connector-vault/oauth-pending-executor",
  "connector-vault/provider-registry",
  "server/connector-vault/provider-registry",
  "lib/server/connector-vault/provider-registry",
  // P5E18a dormant Okta live-connection foundation — the whole okta-live/ dir is server-only and must never be imported from a
  // "use client" file or from src/app (the real path stays unreachable from the client/route tree).
  "connector-vault/okta-live/",
  "server/connector-vault/okta-live/",
  "lib/server/connector-vault/okta-live/",
  "connector-vault/providers/slack-oauth",
  "server/connector-vault/providers/slack-oauth",
  "lib/server/connector-vault/providers/slack-oauth",
  "connector-vault/providers/slack-authorize-pending",
  "server/connector-vault/providers/slack-authorize-pending",
  "lib/server/connector-vault/providers/slack-authorize-pending",
  "connector-vault/runner-db-client",
  "server/connector-vault/runner-db-client",
  "lib/server/connector-vault/runner-db-client",
  "connector-vault/runner-connection",
  "server/connector-vault/runner-connection",
  "lib/server/connector-vault/runner-connection",
  "connector-vault/app-discovery",
  "server/connector-vault/app-discovery",
  "lib/server/connector-vault/app-discovery",
  "connector-vault/resolution",
  "server/connector-vault/resolution",
  "lib/server/connector-vault/resolution",
  "connector-vault/discovery-facts",
  "server/connector-vault/discovery-facts",
  "lib/server/connector-vault/discovery-facts",
  "connector-vault/discovery-fact-staging",
  "server/connector-vault/discovery-fact-staging",
  "lib/server/connector-vault/discovery-fact-staging",
  "connector-vault/discovery-fact-adapter",
  "server/connector-vault/discovery-fact-adapter",
  "lib/server/connector-vault/discovery-fact-adapter",
  "connector-vault/discovery-fact-read",
  "server/connector-vault/discovery-fact-read",
  "lib/server/connector-vault/discovery-fact-read",
  "connector-vault/resolver-write",
  "server/connector-vault/resolver-write",
  "lib/server/connector-vault/resolver-write",
  "connector-vault/identity-match-write",
  "server/connector-vault/identity-match-write",
  "lib/server/connector-vault/identity-match-write",
  "connector-vault/okta-discovery-emitter",
  "server/connector-vault/okta-discovery-emitter",
  "lib/server/connector-vault/okta-discovery-emitter",
  "connector-vault/secret-vault",
  "server/connector-vault/secret-vault",
  "lib/server/connector-vault/secret-vault",
  "connector-vault/connector-secret-store",
  "server/connector-vault/connector-secret-store",
  "lib/server/connector-vault/connector-secret-store",
  "connector-vault/connector-credential-reference-store",
  "server/connector-vault/connector-credential-reference-store",
  "lib/server/connector-vault/connector-credential-reference-store",
  "connector-vault/secret-audit",
  "server/connector-vault/secret-audit",
  "lib/server/connector-vault/secret-audit",
  "connector-vault/secret-audit-writer",
  "server/connector-vault/secret-audit-writer",
  "lib/server/connector-vault/secret-audit-writer",
  "connector-vault/connector-secret-lifecycle",
  "server/connector-vault/connector-secret-lifecycle",
  "lib/server/connector-vault/connector-secret-lifecycle",
  "connector-vault/connector-secret-ingest",
  "server/connector-vault/connector-secret-ingest",
  "lib/server/connector-vault/connector-secret-ingest",
  "connector-vault/slack-oauth-exchange",
  "server/connector-vault/slack-oauth-exchange",
  "lib/server/connector-vault/slack-oauth-exchange",
  "connector-vault/oauth-callback-orchestrator",
  "server/connector-vault/oauth-callback-orchestrator",
  "lib/server/connector-vault/oauth-callback-orchestrator",
  "connector-vault/slack-client-secret-store",
  "server/connector-vault/slack-client-secret-store",
  "lib/server/connector-vault/slack-client-secret-store",
  "connector-vault/client-secret-ingest-harness",
  "server/connector-vault/client-secret-ingest-harness",
  "lib/server/connector-vault/client-secret-ingest-harness",
  "connector-vault/slack-discovery-emitter",
  "server/connector-vault/slack-discovery-emitter",
  "lib/server/connector-vault/slack-discovery-emitter",
  "connector-vault/slack-resolver-write",
  "server/connector-vault/slack-resolver-write",
  "lib/server/connector-vault/slack-resolver-write",
  "connector-vault/runner-ingest-entrypoint",
  "server/connector-vault/runner-ingest-entrypoint",
  "lib/server/connector-vault/runner-ingest-entrypoint",
];

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === ".next") continue;
      out.push(...walk(full));
    } else if (/\.(ts|tsx)$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

function importsCrypto(src: string): boolean {
  // any import/require/dynamic-import that references the crypto module path
  return CRYPTO_REL_HINTS.some((hint) => src.includes(hint));
}

describe("connector vault crypto is server-only (no client/app import path)", () => {
  // Exclude the server-vault dir itself AND test files: the guard protects SHIPPED bundles, and a test may legitimately
  // mock/import a server-only module (e.g. vi.mock(".../provider-registry")) — tests never reach the browser.
  const files = walk(SRC).filter((f) => !f.includes(path.join("server", "connector-vault")) && !/\.test\.(ts|tsx)$/.test(f));

  it("no \"use client\" file imports the connector vault crypto module", () => {
    const offenders = files.filter((f) => {
      const src = fs.readFileSync(f, "utf8");
      const isClient = /^\s*["']use client["']/m.test(src);
      return isClient && importsCrypto(src);
    });
    expect(offenders).toEqual([]);
  });

  it("no file under src/app imports the connector vault crypto module directly", () => {
    const appDir = path.join(SRC, "app");
    const offenders = files
      .filter((f) => f.startsWith(appDir))
      .filter((f) => importsCrypto(fs.readFileSync(f, "utf8")));
    expect(offenders).toEqual([]);
  });

  it("the crypto module declares its server-only runtime sentinel", () => {
    const src = fs.readFileSync(path.join(SRC, "lib", "server", "connector-vault", "crypto.ts"), "utf8");
    expect(src).toMatch(/server-only/);
    expect(src).toMatch(/globalThis[^\n]*window/); // the browser-detection sentinel
  });
});

// The OAuth state module (PR F) is server-only TOO, but UNLIKE crypto/run-lifecycle it is legitimately
// imported by ONE src/app file — the inert server-only callback route handler (a route.ts is server code,
// never client/browser code). So its guard forbids any "use client" importer and pins the single allowed
// src/app importer to that route handler (so a future page/client file can't start importing it).
// The OAuth callback CHAIN that ONLY the callback route may import from src/app: the state module (B2a) + the
// production-shaped synthetic route handler (B2c-route, which itself imports the B2c-wire orchestrator — that
// orchestrator stays in CRYPTO_REL_HINTS, forbidden everywhere in src/app, since the route imports only the handler).
const OAUTH_REL_HINTS = [
  "connector-vault/oauth-state", "server/connector-vault/oauth-state", "lib/server/connector-vault/oauth-state",
  "connector-vault/oauth-callback-route-handler", "server/connector-vault/oauth-callback-route-handler", "lib/server/connector-vault/oauth-callback-route-handler",
  "connector-vault/connector-oauth-config", "server/connector-vault/connector-oauth-config", "lib/server/connector-vault/connector-oauth-config",
];
const CALLBACK_ROUTE = path.join(SRC, "app", "(authenticated)", "connectors", "oauth", "callback", "route.ts");

describe("connector vault oauth-state is server-only (only the inert callback route may import it)", () => {
  // Exclude the server-vault dir itself AND test files: the guard protects SHIPPED bundles, and a test may legitimately
  // mock/import a server-only module (e.g. vi.mock(".../provider-registry")) — tests never reach the browser.
  const files = walk(SRC).filter((f) => !f.includes(path.join("server", "connector-vault")) && !/\.test\.(ts|tsx)$/.test(f));
  const importsOauth = (src: string) => OAUTH_REL_HINTS.some((h) => src.includes(h));

  it("no \"use client\" file imports the oauth-state module", () => {
    const offenders = files.filter((f) => {
      const src = fs.readFileSync(f, "utf8");
      return /^\s*["']use client["']/m.test(src) && importsOauth(src);
    });
    expect(offenders).toEqual([]);
  });

  it("the ONLY src/app file importing oauth-state is the inert callback route handler", () => {
    const appDir = path.join(SRC, "app");
    const offenders = files
      .filter((f) => f.startsWith(appDir))
      .filter((f) => importsOauth(fs.readFileSync(f, "utf8")))
      .filter((f) => f !== CALLBACK_ROUTE);
    expect(offenders).toEqual([]);
  });

  it("the oauth-state module declares its server-only runtime sentinel", () => {
    const src = fs.readFileSync(path.join(SRC, "lib", "server", "connector-vault", "oauth-state.ts"), "utf8");
    expect(src).toMatch(/server-only/);
    expect(src).toMatch(/globalThis[^\n]*window/);
  });
});
