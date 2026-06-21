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
  const files = walk(SRC).filter((f) => !f.includes(path.join("server", "connector-vault")));

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
const OAUTH_REL_HINTS = ["connector-vault/oauth-state", "server/connector-vault/oauth-state", "lib/server/connector-vault/oauth-state"];
const CALLBACK_ROUTE = path.join(SRC, "app", "(authenticated)", "connectors", "oauth", "callback", "route.ts");

describe("connector vault oauth-state is server-only (only the inert callback route may import it)", () => {
  const files = walk(SRC).filter((f) => !f.includes(path.join("server", "connector-vault")));
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
