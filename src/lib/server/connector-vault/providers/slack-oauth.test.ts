import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import {
  buildSlackAuthorizeUrl,
  classifySlackCallback,
  SLACK_PROVIDER_ID,
  type SlackAuthorizeInput,
} from "./slack-oauth";
import { createHmacStateSigner, createOAuthState, type OAuthStateContext } from "../oauth-state";
import { getConnectorProvider } from "../provider-registry";

const SIGNER = createHmacStateSigner("test-only-state-secret-not-a-real-secret", "k1");
const NOW = 1_750_000_000_000;
const TENANT = "aaaa1111-1111-1111-1111-111111111111";
const REDIRECT = "https://app.example.com/connectors/oauth/callback";

function ctx(over: Partial<OAuthStateContext> = {}): OAuthStateContext {
  return { tenantId: TENANT, provider: "slack", connectorId: null, subject: null, redirectIntent: "connect", ...over };
}
function authInput(over: Partial<SlackAuthorizeInput> = {}): SlackAuthorizeInput {
  return { ctx: ctx(), clientId: "11111.22222", redirectUri: REDIRECT, signer: SIGNER, now: NOW, nonce: "nonce-A", ...over };
}
const sha256 = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

describe("buildSlackAuthorizeUrl — authorize URL builder", () => {
  it("returns a Slack authorize URL with the expected host/path + safe query params", () => {
    const res = buildSlackAuthorizeUrl(authInput());
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const url = new URL(res.url);
    expect(url.origin).toBe("https://slack.com");
    expect(url.pathname).toBe("/oauth/v2/authorize");
    expect(url.searchParams.get("client_id")).toBe("11111.22222");
    expect(url.searchParams.get("redirect_uri")).toBe(REDIRECT);
    expect(url.searchParams.get("scope")).toBe(getConnectorProvider("slack")!.requiredScopes.join(","));
    expect(url.searchParams.get("state")).toBeTruthy();
    // no token endpoint, no client_secret, no response_type leakage
    expect(res.url).not.toContain("oauth.v2.access");
    expect(res.url.toLowerCase()).not.toContain("client_secret");
  });

  it("binds state/nonce via the existing oauth-state signer + returns oauth_pending alignment hashes", () => {
    const res = buildSlackAuthorizeUrl(authInput({ nonce: "nonce-A" }));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const state = new URL(res.url).searchParams.get("state")!;
    // state is exactly what createOAuthState produces for this ctx/nonce (same signer) — proves integration
    const expected = createOAuthState(ctx(), { signer: SIGNER, ttlSeconds: 600, now: NOW, nonce: "nonce-A" });
    expect(state).toBe(expected.state);
    // alignment hashes are one-way (never the raw nonce/state)
    expect(res.nonceHash).toBe(sha256("nonce-A"));
    expect(res.stateJti).toBe(sha256(state));
    expect(res.nonceHash).not.toContain("nonce-A");
    expect(res.expiresAt).toBe(NOW + 600_000);
  });

  it("uses caller-provided scopes when given (display metadata only)", () => {
    const res = buildSlackAuthorizeUrl(authInput({ scopes: ["users:read"] }));
    expect(res.ok).toBe(true);
    if (res.ok) expect(new URL(res.url).searchParams.get("scope")).toBe("users:read");
  });

  it("fails closed on missing client_id / redirect_uri / signer", () => {
    expect(buildSlackAuthorizeUrl(authInput({ clientId: "" }))).toEqual({ ok: false, reason: "missing_client_id" });
    expect(buildSlackAuthorizeUrl(authInput({ redirectUri: "" }))).toEqual({ ok: false, reason: "missing_redirect_uri" });
    expect(buildSlackAuthorizeUrl(authInput({ signer: undefined }))).toEqual({ ok: false, reason: "missing_signer" });
  });

  it("rejects an unsafe / non-https redirect_uri", () => {
    for (const bad of ["javascript:alert(1)", "http://evil.example.com/cb", "not-a-url", "data:text/html,x", "//evil.com"]) {
      expect(buildSlackAuthorizeUrl(authInput({ redirectUri: bad }))).toEqual({ ok: false, reason: "invalid_redirect_uri" });
    }
  });

  it("fails closed when the context is not the slack provider", () => {
    expect(buildSlackAuthorizeUrl(authInput({ ctx: ctx({ provider: "google_workspace" }) }))).toEqual({ ok: false, reason: "wrong_provider" });
  });
});

describe("classifySlackCallback — callback validation/classification (NO token exchange)", () => {
  // build a real valid callback for the happy path
  function validCallback(over: Record<string, string> = {}) {
    const { state } = createOAuthState(ctx(), { signer: SIGNER, ttlSeconds: 600, now: NOW, nonce: "nonce-cb" });
    return new URLSearchParams({ code: "slack-auth-code-VALUE-ignored", state, ...over });
  }

  it("accepts a well-formed valid callback but returns NO token-exchange action (status: received)", () => {
    const sp = validCallback();
    const out = classifySlackCallback(sp, { signer: SIGNER, now: NOW, expectedContext: ctx() });
    expect(out.status).toBe("received");
    if (out.status === "received") {
      // returns only safe one-way hashes (the future oauth_pending consume keys) — never the raw code/state
      expect(out.nonceHash).toBe(sha256("nonce-cb"));
      expect(out.stateJti).toBe(sha256(sp.get("state")!));
      const flat = JSON.stringify(out);
      expect(flat).not.toContain("slack-auth-code-VALUE-ignored"); // the code value is never returned
      expect(flat).not.toContain("nonce-cb");
    }
  });

  it("classifies a Slack error/cancel (?error=access_denied) safely without surfacing the value", () => {
    const out = classifySlackCallback(new URLSearchParams({ error: "access_denied" }), { signer: SIGNER, now: NOW });
    expect(out).toEqual({ status: "provider_error", reason: "provider_reported_error" });
  });

  it("is inert (not_configured) when no signer is wired (the skeleton default)", () => {
    const out = classifySlackCallback(validCallback(), { signer: null, now: NOW });
    expect(out).toEqual({ status: "not_configured" });
  });

  it("fails closed on a missing code (valid state, no code → invalid/missing_code)", () => {
    const { state } = createOAuthState(ctx(), { signer: SIGNER, ttlSeconds: 600, now: NOW, nonce: "n2" });
    const out = classifySlackCallback(new URLSearchParams({ state }), { signer: SIGNER, now: NOW, expectedContext: ctx() });
    expect(out).toEqual({ status: "invalid", reason: "missing_code" });
  });

  it("fails closed on missing / invalid / tampered state", () => {
    expect(classifySlackCallback(new URLSearchParams({ code: "c" }), { signer: SIGNER, now: NOW })).toEqual({ status: "invalid", reason: "missing_state" });
    expect(classifySlackCallback(new URLSearchParams({ code: "c", state: "garbage" }), { signer: SIGNER, now: NOW })).toEqual({ status: "invalid", reason: "malformed_state" });
    // tampered signature
    const { state } = createOAuthState(ctx(), { signer: SIGNER, ttlSeconds: 600, now: NOW, nonce: "n3" });
    const tampered = state.slice(0, -2) + (state.endsWith("AA") ? "BB" : "AA");
    const out = classifySlackCallback(new URLSearchParams({ code: "c", state: tampered }), { signer: SIGNER, now: NOW });
    expect(out.status).toBe("invalid");
  });

  it("fails closed when the expected context is not slack (wrong_provider)", () => {
    const out = classifySlackCallback(validCallback(), { signer: SIGNER, now: NOW, expectedContext: ctx({ provider: "okta" }) });
    expect(out).toEqual({ status: "invalid", reason: "wrong_provider" });
  });

  it("provider registry still lists Slack as inert/not functional (this skeleton does not flip it)", () => {
    const slack = getConnectorProvider(SLACK_PROVIDER_ID);
    expect(slack?.status).toBe("skeleton");
    expect(slack?.enabled).toBe(false);
  });
});

// Static guards: server-only, no token exchange / Slack API / connector_secrets / KMS / token storage, no
// client/browser import.
describe("slack-oauth module is server-only + scoped (no exchange/api/secrets/kms/token-storage)", () => {
  it("imports only server-only siblings + node:crypto; no forbidden call/string", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const src = fs.readFileSync(path.resolve(__dirname, "slack-oauth.ts"), "utf8");
    const imports = [...src.matchAll(/from\s+["']([^"']+)["']/g)].map((m) => m[1]).sort();
    expect(imports).toEqual(["../oauth-state", "../provider-registry", "node:crypto"]);
    const code = src.replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
    expect(code).not.toMatch(/\bfetch\s*\(/); // no Slack API call / no token exchange
    expect(code).not.toMatch(/createClient\s*\(/);
    expect(code).not.toMatch(/process\.env/); // client_id is injected, never read from env here
    const secretsTable = ["connector", "secrets"].join("_");
    expect(code).not.toContain(secretsTable);
    const serviceRole = ["service", "role"].join("_");
    expect(code).not.toContain(serviceRole);
    for (const tok of ["oauth.v2.access", "access_token", "refresh_token", "client_secret", "grant_type", "kms", "GenerateDataKey", "Decrypt"]) {
      expect(code).not.toContain(tok);
    }
    // the only Slack URL is the authorize redirect target, never the token endpoint (checked on raw src —
    // the naive comment-stripper would mangle the `//` in `https://`).
    expect(src).toContain("https://slack.com/oauth/v2/authorize");
    expect(src).not.toMatch(/slack\.com\/api/);
  });

  it("the OAuth callback route is still inert — no token exchange, no slack-oauth-driven connect", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const route = fs.readFileSync(
      path.resolve(__dirname, "..", "..", "..", "..", "app", "(authenticated)", "connectors", "oauth", "callback", "route.ts"),
      "utf8",
    );
    const code = route.replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
    expect(code).not.toMatch(/\bfetch\s*\(/);
    for (const bad of [["connector", "secrets"].join("_"), "access_token", "refresh_token", "oauth.v2.access", "grant_type"]) {
      expect(code).not.toContain(bad);
    }
  });
});
