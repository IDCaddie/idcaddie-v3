import { describe, it, expect } from "vitest";
import { buildOktaAuthorizeUrl, isValidOktaClientId, type OktaClientIdSource } from "./okta-authorize-url";

// P5E18a Phase 6/19 — the pure authorize-URL builder (no network). Synthetic-only fixtures.

const SYNTH_CLIENT_ID = "0oaEXAMPLEexampleABCDE"; // obviously synthetic Okta 0oa… client id (public, not a secret)
const source: OktaClientIdSource = { resolveClientId: () => SYNTH_CLIENT_ID };
const CHALLENGE = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"; // 43-char base64url (RFC 7636 example)
const REDIRECT = "https://idcaddie-v3.vercel.app/connectors/oauth/okta/callback";
const base = { issuerUrl: "https://acme.okta.com", clientIdSource: source, redirectUri: REDIRECT, scopes: ["okta.users.read"], state: "signed.state.value", codeChallenge: CHALLENGE };

describe("buildOktaAuthorizeUrl", () => {
  it("builds a correct authorization-code + PKCE(S256) URL with the exact closed parameter set", () => {
    const r = buildOktaAuthorizeUrl(base);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const u = new URL(r.url);
    expect(u.origin).toBe("https://acme.okta.com");
    expect(u.pathname).toBe("/oauth2/v1/authorize");
    expect(u.searchParams.get("response_type")).toBe("code"); // never token/id_token (no implicit)
    expect(u.searchParams.get("scope")).toBe("okta.users.read");
    expect(u.searchParams.get("client_id")).toBe(SYNTH_CLIENT_ID);
    expect(u.searchParams.get("redirect_uri")).toBe(REDIRECT);
    expect(u.searchParams.get("state")).toBe("signed.state.value");
    expect(u.searchParams.get("code_challenge")).toBe(CHALLENGE);
    expect(u.searchParams.get("code_challenge_method")).toBe("S256");
    // exactly these 7 params — no user-controlled extras
    expect([...u.searchParams.keys()].sort()).toEqual(["client_id", "code_challenge", "code_challenge_method", "redirect_uri", "response_type", "scope", "state"]);
    // no token/secret anywhere in the URL
    expect(/token|secret|client_secret|assertion/i.test(r.url)).toBe(false);
  });

  it("rejects invalid issuer / client id / redirect / scope / challenge", () => {
    expect(buildOktaAuthorizeUrl({ ...base, issuerUrl: "http://acme.okta.com" })).toEqual({ ok: false, reason: "invalid_issuer" });
    expect(buildOktaAuthorizeUrl({ ...base, issuerUrl: "https://acme.okta.com/oauth2/default" })).toEqual({ ok: false, reason: "invalid_issuer" });
    expect(buildOktaAuthorizeUrl({ ...base, clientIdSource: { resolveClientId: () => "not-a-client-id" } })).toEqual({ ok: false, reason: "invalid_client_id" });
    expect(buildOktaAuthorizeUrl({ ...base, clientIdSource: { resolveClientId: () => { throw new Error("no ref"); } } })).toEqual({ ok: false, reason: "invalid_client_id" });
    expect(buildOktaAuthorizeUrl({ ...base, redirectUri: "https://evil.com/cb" })).toEqual({ ok: false, reason: "invalid_redirect_uri" });
    expect(buildOktaAuthorizeUrl({ ...base, scopes: ["okta.users.read", "okta.groups.read"] })).toEqual({ ok: false, reason: "scope_not_exact" });
    expect(buildOktaAuthorizeUrl({ ...base, codeChallenge: "too-short" })).toEqual({ ok: false, reason: "invalid_code_challenge" });
  });

  it("validates Okta client id shape", () => {
    expect(isValidOktaClientId("0oaEXAMPLEexampleABCDE")).toBe(true);
    expect(isValidOktaClientId("00u1234567890")).toBe(false); // user id, not client id
    expect(isValidOktaClientId("random")).toBe(false);
  });
});
