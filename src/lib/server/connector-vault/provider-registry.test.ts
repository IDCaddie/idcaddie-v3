import { describe, it, expect } from "vitest";
import {
  listConnectorProviders,
  getConnectorProvider,
  isSupportedConnectorProvider,
  getProviderCapabilities,
  isConnectorProviderReady,
  type ConnectorProviderDefinition,
} from "./provider-registry";

const SAFE_FIELDS = new Set([
  "id", "displayName", "category", "authKind", "kind", "capabilities", "discoveryCapabilities", "status", "reviewGate", "riskLevel", "requiredScopes", "helpCopy", "enabled",
]);

describe("connector provider registry — safe metadata only", () => {
  it("lists providers exposing ONLY safe metadata fields (no secret/token/url field)", () => {
    const providers = listConnectorProviders();
    expect(providers.length).toBeGreaterThan(0);
    for (const p of providers) {
      // every key is on the safe allow-list — no surprise field could carry a secret/token/url
      expect(Object.keys(p).every((k) => SAFE_FIELDS.has(k))).toBe(true);
      // scan the STRUCTURAL fields for secret/token/url values; helpCopy is display prose (it may safely say
      // "no token storage") so it is asserted separately as a plain string, not value-scanned.
      const { helpCopy, ...structural } = p;
      expect(typeof helpCopy).toBe("string");
      const flat = JSON.stringify(structural).toLowerCase();
      for (const bad of ["token", "secret", "client_id", "client_secret", "authorize", "redirect_uri", "http", "://"]) {
        expect(flat).not.toContain(bad);
      }
    }
  });

  it("Slack is the first inert provider skeleton (oauth2, collaboration, disabled, not ready)", () => {
    const slack = getConnectorProvider("slack");
    expect(slack).not.toBeNull();
    const s = slack as ConnectorProviderDefinition;
    expect(s.id).toBe("slack");
    expect(s.displayName).toBe("Slack");
    expect(s.category).toBe("collaboration");
    expect(s.authKind).toBe("oauth2");
    expect(s.status).toBe("skeleton");
    expect(s.enabled).toBe(false); // inert
    expect(s.capabilities.length).toBeGreaterThan(0);
    expect(s.requiredScopes.length).toBeGreaterThan(0);
    // skeleton provider is NOT ready — cannot be connected / exchanged / synced / credentialed
    expect(isConnectorProviderReady("slack")).toBe(false);
  });

  it("supported-provider check is true for slack, and capabilities resolve", () => {
    expect(isSupportedConnectorProvider("slack")).toBe(true);
    expect(getProviderCapabilities("slack")).toContain("read_users");
  });

  it("unknown / malformed provider fails closed (null / false / [])", () => {
    expect(getConnectorProvider("nope")).toBeNull();
    expect(getConnectorProvider("")).toBeNull();
    // @ts-expect-error — non-string
    expect(getConnectorProvider(null)).toBeNull();
    expect(isSupportedConnectorProvider("zoom")).toBe(false); // in the type space but NOT defined yet
    expect(getProviderCapabilities("nope")).toEqual([]);
    expect(isConnectorProviderReady("nope")).toBe(false);
    expect(isConnectorProviderReady("google_workspace")).toBe(false);
  });

  it("NO provider in the registry is ready (all inert) — nothing can be connected/synced/credentialed", () => {
    for (const p of listConnectorProviders()) {
      expect(isConnectorProviderReady(p.id)).toBe(false);
      expect(p.enabled).toBe(false);
    }
  });
});

// Static guards: the registry is pure server-only metadata — no DB / Supabase / service-role /
// connector_secrets / token exchange / provider API / OAuth-URL generation, and no client/browser imports.
describe("provider-registry module is server-safe + scoped (no secrets/tokens/api/oauth-exchange)", () => {
  it("has no imports and no forbidden call/string", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const src = fs.readFileSync(path.resolve(__dirname, "provider-registry.ts"), "utf8");
    const imports = [...src.matchAll(/from\s+["']([^"']+)["']/g)].map((m) => m[1]);
    expect(imports).toEqual([]); // pure TS data — no module imports at all
    const code = src.replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
    expect(code).not.toMatch(/createClient\s*\(/);
    expect(code).not.toMatch(/process\.env/);
    expect(code).not.toMatch(/\bfetch\s*\(/); // no provider API call / no token exchange
    const secretsTable = ["connector", "secrets"].join("_");
    expect(code).not.toContain(secretsTable);
    const serviceRole = ["service", "role"].join("_");
    expect(code).not.toContain(serviceRole);
    // no token-exchange / credential machinery, and no live OAuth authorize URL
    for (const tok of ["access_token", "refresh_token", "token_endpoint", "grant_type", "client_secret", "oauth/authorize", "https://"]) {
      expect(code).not.toContain(tok);
    }
    // no sync-EXECUTION function lives in this metadata module (the deep-sync TAXONOMY helpers
    // listDeepSyncProviders/isDeepSyncProvider are classification accessors, not sync runners).
    expect(code).not.toMatch(/function\s+(run|start|execute|perform|do)[A-Za-z]*[Ss]ync/);
  });

  it("the OAuth callback route is still inert — no token exchange, no registry-driven connect", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const route = fs.readFileSync(
      path.resolve(__dirname, "..", "..", "..", "app", "(authenticated)", "connectors", "oauth", "callback", "route.ts"),
      "utf8",
    );
    const code = route.replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
    expect(code).not.toMatch(/\bfetch\s*\(/);
    for (const bad of [["connector", "secrets"].join("_"), "access_token", "refresh_token", "token_endpoint", "grant_type"]) {
      expect(code).not.toContain(bad);
    }
  });
});
