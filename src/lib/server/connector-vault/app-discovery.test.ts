import { describe, it, expect } from "vitest";
import {
  getConnectorProvider,
  listConnectorProviders,
  listDiscoveryProviders,
  listDeepSyncProviders,
  isDiscoveryProvider,
  isDeepSyncProvider,
  getProviderDiscoveryCapabilities,
  isConnectorProviderReady,
} from "./provider-registry";
import {
  normalizeDiscoveredAppSignals,
  type DiscoveredAppSignal,
} from "./app-discovery";

describe("connector taxonomy — discovery connectors vs deep-sync runners", () => {
  it("registry includes inert Okta / Google Workspace / Microsoft Entra identity-discovery metadata", () => {
    for (const id of ["okta", "google_workspace", "microsoft_entra"]) {
      const p = getConnectorProvider(id);
      expect(p).not.toBeNull();
      expect(p!.kind).toBe("identity_provider_discovery");
      expect(p!.category).toBe("identity");
      expect(p!.status).toBe("future"); // inert future connector — no code
      expect(p!.enabled).toBe(false);
      expect(p!.discoveryCapabilities).toContain("discover_apps");
      expect(p!.discoveryCapabilities).toContain("discover_assigned_users");
      // it is NOT a deep-sync runner and has NO deep-sync read capabilities
      expect(p!.capabilities).toEqual([]);
      expect(isDeepSyncProvider(id)).toBe(false);
      expect(isDiscoveryProvider(id)).toBe(true);
    }
  });

  it("classifies discovery providers separately from deep-sync providers", () => {
    const discovery = listDiscoveryProviders().map((d) => d.id).sort();
    const deepSync = listDeepSyncProviders().map((d) => d.id).sort();
    expect(discovery).toEqual(["google_workspace", "microsoft_entra", "okta", "scim_fixture"]); // scim_fixture = synthetic identity-discovery proof (P5A.1)
    expect(deepSync).toEqual(["slack"]);
    // the two sets are disjoint
    expect(discovery.some((d) => deepSync.includes(d))).toBe(false);
  });

  it("Slack remains a deep-sync runner and non-functional (this PR does not flip it)", () => {
    const slack = getConnectorProvider("slack");
    expect(slack!.kind).toBe("deep_provider_sync");
    expect(slack!.status).toBe("skeleton");
    expect(slack!.enabled).toBe(false);
    expect(isDiscoveryProvider("slack")).toBe(false);
    expect(isDeepSyncProvider("slack")).toBe(true);
  });

  it("NO provider is ready — discovery providers cannot connect/sync/exchange, none are functional", () => {
    for (const p of listConnectorProviders()) {
      expect(isConnectorProviderReady(p.id)).toBe(false);
      expect(p.enabled).toBe(false);
    }
  });

  it("discovery providers expose safe metadata only (no token/secret/url in structural fields)", () => {
    for (const p of listDiscoveryProviders()) {
      const { helpCopy, requiredScopes, ...structural } = p;
      expect(typeof helpCopy).toBe("string");
      const flat = JSON.stringify(structural).toLowerCase();
      for (const bad of ["token", "secret", "client_id", "client_secret", "authorize", "redirect_uri", "http", "://"]) {
        expect(flat).not.toContain(bad);
      }
      // scope identifiers are display-only labels (no secret material)
      for (const bad of ["secret", "access_token", "refresh_token", "client_secret"]) {
        expect(JSON.stringify(requiredScopes).toLowerCase()).not.toContain(bad);
      }
    }
  });

  it("getProviderDiscoveryCapabilities resolves for a discovery provider and fails closed for unknown", () => {
    expect(getProviderDiscoveryCapabilities("okta")).toContain("discover_apps");
    expect(getProviderDiscoveryCapabilities("slack")).toEqual([]); // deep-sync runner has no discovery caps
    expect(getProviderDiscoveryCapabilities("nope")).toEqual([]);
  });

  it("unknown / malformed provider fails closed across the discovery helpers", () => {
    expect(isDiscoveryProvider("nope")).toBe(false);
    expect(isDeepSyncProvider("nope")).toBe(false);
    // @ts-expect-error — non-string
    expect(isDiscoveryProvider(null)).toBe(false);
    expect(getProviderDiscoveryCapabilities("")).toEqual([]);
    expect(listDiscoveryProviders().every((d) => d.enabled === false)).toBe(true);
  });
});

describe("app-graph normalization — pure in-memory bridge (no DB, no provider call)", () => {
  function signal(over: Partial<DiscoveredAppSignal> = {}): DiscoveredAppSignal {
    return { sourceProvider: "okta", appName: "Figma", appDomain: "figma.com", externalAppId: "okta-app-1", assignedUserCount: 12, loginActivitySignal: 0.5, usageSignals: ["active_30d"], ...over };
  }

  it("merges signals about the same app (by domain) from multiple sources into one candidate", () => {
    const candidates = normalizeDiscoveredAppSignals([
      signal({ sourceProvider: "okta", assignedUserCount: 12, externalAppId: "okta-1" }),
      signal({ sourceProvider: "google_workspace", assignedUserCount: 20, externalAppId: "g-1" }),
    ]);
    expect(candidates).toHaveLength(1);
    const c = candidates[0];
    expect(c.normalizedName).toBe("Figma");
    expect(c.normalizedDomain).toBe("figma.com");
    expect(c.sourceProviders).toEqual(["google_workspace", "okta"]); // unique + sorted
    expect(c.externalIds).toEqual([{ provider: "okta", id: "okta-1" }, { provider: "google_workspace", id: "g-1" }]);
    expect(c.assignedUserCount).toBe(20); // max across sources
    expect(c.matchStatus).toBe("likely_duplicate"); // 2 corroborating sources
    expect(c.confidence).toBeGreaterThan(0.5);
  });

  it("keeps distinct apps separate and falls back to name when no domain", () => {
    const candidates = normalizeDiscoveredAppSignals([
      signal({ appName: "Figma", appDomain: "figma.com" }),
      signal({ appName: "Notion", appDomain: null, externalAppId: null }),
    ]);
    expect(candidates.map((c) => c.normalizedName)).toEqual(["Figma", "Notion"]); // sorted, distinct
    const notion = candidates.find((c) => c.normalizedName === "Notion")!;
    expect(notion.normalizedDomain).toBeNull();
    expect(notion.matchStatus).toBe("needs_review"); // single source, no domain anchor
  });

  it("is total/fail-soft on empty or malformed input (returns [] / skips bad signals)", () => {
    expect(normalizeDiscoveredAppSignals([])).toEqual([]);
    // @ts-expect-error — not an array
    expect(normalizeDiscoveredAppSignals(null)).toEqual([]);
    expect(normalizeDiscoveredAppSignals([signal({ appName: "  " })])).toEqual([]); // blank name skipped
  });

  it("the normalizer writes no DB and calls no provider (pure — its source imports nothing)", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const src = fs.readFileSync(path.resolve(__dirname, "app-discovery.ts"), "utf8");
    const imports = [...src.matchAll(/from\s+["']([^"']+)["']/g)].map((m) => m[1]);
    expect(imports).toEqual([]); // pure TS — no module imports at all
    const code = src.replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
    expect(code).not.toMatch(/\bfetch\s*\(/);
    expect(code).not.toMatch(/createClient\s*\(/);
    expect(code).not.toMatch(/process\.env/);
    const secretsTable = ["connector", "secrets"].join("_");
    expect(code).not.toContain(secretsTable);
    expect(code).not.toContain(["service", "role"].join("_"));
    for (const tok of ["access_token", "refresh_token", "insert into", "update ", "@supabase"]) {
      expect(code).not.toContain(tok);
    }
  });
});

// Static guard: the registry stays pure server-only metadata after the taxonomy extension.
describe("provider-registry stays pure server-only after the discovery taxonomy extension", () => {
  it("has no imports and no forbidden call/string", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const src = fs.readFileSync(path.resolve(__dirname, "provider-registry.ts"), "utf8");
    const imports = [...src.matchAll(/from\s+["']([^"']+)["']/g)].map((m) => m[1]);
    expect(imports).toEqual([]);
    const code = src.replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
    expect(code).not.toMatch(/\bfetch\s*\(/);
    expect(code).not.toMatch(/createClient\s*\(/);
    expect(code).not.toMatch(/process\.env/);
    const secretsTable = ["connector", "secrets"].join("_");
    expect(code).not.toContain(secretsTable);
    expect(code).not.toContain(["service", "role"].join("_"));
    for (const tok of ["access_token", "refresh_token", "token_endpoint", "grant_type", "oauth/authorize", "https://"]) {
      expect(code).not.toContain(tok);
    }
  });
});
