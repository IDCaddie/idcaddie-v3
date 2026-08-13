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
      //
      // `requiredScopes` is scanned too, but under a narrower URL rule. The `http`/`://` ban exists to keep an ENDPOINT —
      // an authorize URL, a redirect URI, a provider API base — out of display metadata. Google's scope identifiers are
      // genuinely URI-shaped (`https://www.googleapis.com/auth/...`) and are not endpoints: nothing is served at them, and
      // the full URI is the literal string an admin pastes into the domain-wide-delegation console, so a short label here
      // would be a fiction. Banning them outright would force exactly that fiction, so the rule is tightened rather than
      // dropped: a URI is permitted ONLY under the Google scope namespace, and every other URL shape stays forbidden.
      const { helpCopy, requiredScopes, ...structural } = p;
      expect(typeof helpCopy).toBe("string");
      const flat = JSON.stringify(structural).toLowerCase();
      for (const bad of ["token", "secret", "client_id", "client_secret", "authorize", "redirect_uri", "http", "://"]) {
        expect(flat).not.toContain(bad);
      }

      const GOOGLE_SCOPE_PREFIX = "https://www.googleapis.com/auth/";
      for (const scope of requiredScopes) {
        const s = scope.toLowerCase();
        for (const bad of ["token", "secret", "client_id", "client_secret", "authorize", "redirect_uri"]) {
          expect(s, `scope '${scope}' looks like a credential or endpoint`).not.toContain(bad);
        }
        // A URI-shaped scope must be a Google scope identifier and nothing else — no other host, and no other protocol.
        if (s.includes("://")) {
          expect(s.startsWith(GOOGLE_SCOPE_PREFIX), `scope '${scope}' is URI-shaped but is not a Google scope identifier`).toBe(true);
          // Defence in depth: a Google scope has no query, fragment, port or userinfo — anything richer is an endpoint.
          expect(s).not.toMatch(/[?#@]|:\d/);
        }
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

describe("scim_fixture — synthetic SCIM proof provider (P5A.1)", () => {
  it("is a SUPPORTED canonical provider id and resolves to an inert, clearly-synthetic, disabled definition", () => {
    expect(isSupportedConnectorProvider("scim_fixture")).toBe(true);
    const def = getConnectorProvider("scim_fixture");
    expect(def).not.toBeNull();
    const d = def as ConnectorProviderDefinition;
    expect(d.id).toBe("scim_fixture");
    expect(d.displayName.toLowerCase()).toMatch(/fixture|synthetic/); // cannot be confused with a real vendor
    expect(d.category).toBe("identity");
    expect(d.status).toBe("disabled");
    expect(d.enabled).toBe(false); // never production-enabled
    expect(isConnectorProviderReady("scim_fixture")).toBe(false); // inert — cannot connect/sync/credential
  });

  it("fails closed for near-miss ids — no fallback to scim_fixture or slack", () => {
    for (const miss of ["scim_fixtur", "scimfixture", "scim", "scim-fixture", "SCIM_FIXTURE", "fixture"]) {
      expect(getConnectorProvider(miss)).toBeNull();
      expect(isSupportedConnectorProvider(miss)).toBe(false);
    }
  });

  it("Slack provider metadata is unchanged (no regression from adding scim_fixture)", () => {
    const s = getConnectorProvider("slack") as ConnectorProviderDefinition;
    expect(s.id).toBe("slack");
    expect(s.status).toBe("skeleton");
    expect(s.enabled).toBe(false);
  });
});

describe("microsoft_entra — inert canonical provider identity (P5E2.1)", () => {
  it("is a SUPPORTED canonical provider id that resolves to an INERT, disabled, unconfigured definition", () => {
    expect(isSupportedConnectorProvider("microsoft_entra")).toBe(true);
    const def = getConnectorProvider("microsoft_entra");
    expect(def).not.toBeNull();
    const d = def as ConnectorProviderDefinition;
    expect(d.id).toBe("microsoft_entra");
    expect(d.category).toBe("identity");
    expect(d.enabled).toBe(false); // never production-enabled
    expect(d.status).not.toBe("not_connected"); // not connectable
    expect(isConnectorProviderReady("microsoft_entra")).toBe(false); // inert — cannot connect/sync/credential
    // safe metadata only — no host/token/secret/oauth field carries a credential or a URL
    const flat = JSON.stringify({ ...d, helpCopy: undefined }).toLowerCase();
    for (const bad of ["token", "secret", "client_id", "client_secret", "://", "graph.microsoft.com"]) expect(flat).not.toContain(bad);
  });

  it("fails closed for near-miss ids — NO fallback / alias to microsoft_entra", () => {
    for (const miss of ["microsoft-entra", "microsoft_entra_extra", "Microsoft_Entra", "entra", "graph", "microsoftentra", "azure_ad"]) {
      expect(getConnectorProvider(miss), miss).toBeNull();
      expect(isSupportedConnectorProvider(miss), miss).toBe(false);
      expect(isConnectorProviderReady(miss), miss).toBe(false);
    }
  });

  it("adding microsoft_entra does not regress slack / scim_fixture (still inert, unchanged)", () => {
    expect((getConnectorProvider("slack") as ConnectorProviderDefinition).status).toBe("skeleton");
    expect((getConnectorProvider("scim_fixture") as ConnectorProviderDefinition).status).toBe("disabled");
    expect(isConnectorProviderReady("slack")).toBe(false);
    expect(isConnectorProviderReady("scim_fixture")).toBe(false);
  });
});

// Hardening — provider lookups must do OWN-property checks so an INHERITED object key can never resolve to an
// Object.prototype internal and masquerade as a provider (previously getConnectorProvider("constructor") returned the
// Object constructor, so isSupportedConnectorProvider("constructor") was true).
describe("connector registry lookups fail closed for INHERITED object keys (no prototype-chain traversal)", () => {
  const INHERITED = ["constructor", "toString", "valueOf", "hasOwnProperty", "__proto__", "prototype", "isPrototypeOf", "propertyIsEnumerable", "toLocaleString"];

  it("every inherited key → null / not-supported / not-ready / no capabilities", () => {
    for (const k of INHERITED) {
      expect(getConnectorProvider(k), k).toBeNull();
      expect(isSupportedConnectorProvider(k), k).toBe(false);
      expect(isConnectorProviderReady(k), k).toBe(false);
      expect(getProviderCapabilities(k), k).toEqual([]);
    }
  });

  it("no inherited function/object is ever returned as a provider definition", () => {
    for (const k of INHERITED) expect(typeof getConnectorProvider(k)).not.toBe("function");
  });

  it("valid OWN providers are unchanged (slack ready-state, scim_fixture / microsoft_entra inert)", () => {
    for (const p of ["slack", "scim_fixture", "microsoft_entra"]) {
      expect(isSupportedConnectorProvider(p), p).toBe(true);
      expect(getConnectorProvider(p), p).not.toBeNull();
    }
    expect(getProviderCapabilities("slack")).toContain("read_users");
    expect(isConnectorProviderReady("slack")).toBe(false);   // still inert
    expect(isConnectorProviderReady("scim_fixture")).toBe(false);
    expect(isConnectorProviderReady("microsoft_entra")).toBe(false);
    // an ordinary unknown string still fails closed (no behavior change)
    expect(getConnectorProvider("totally_unknown")).toBeNull();
  });
});
