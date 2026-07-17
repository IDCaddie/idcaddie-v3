import { describe, it, expect, beforeAll } from "vitest";
import { createHmacStateSigner, generateBoundOAuthState } from "../oauth-state";
import { evaluateOktaCallback, type OktaCallbackInput, type OktaCallbackTransaction, type OktaCallbackDeps } from "./okta-callback-foundation";

// P5E18a Phase 7/19 — the dormant callback boundary: ordered gates, replay/cross-org rejection, no code echo, stops before exchange.

const signer = createHmacStateSigner(Buffer.from("synthetic-test-state-secret-not-real"), "test-key");
const NOW = 1_700_000_000_000;
const TENANT = "11111111-1111-1111-1111-111111111111";
const ORG = "22222222-2222-2222-2222-222222222222";
const SUBJECT = "33333333-3333-3333-3333-333333333333";
const REDIRECT = "https://idcaddie-v3.vercel.app/connectors/oauth/okta/callback";
const ISSUER = "https://acme.okta.com";
const CORR = "corr-okta-cb-1";
const CODE = "AbCd1234_synthetic-auth-code-value-xyz"; // synthetic; must never be echoed

let STATE = "";
beforeAll(async () => {
  const minted = await generateBoundOAuthState(
    { tenantId: TENANT, provider: "okta", connectorId: null, subject: SUBJECT, redirectIntent: "okta_connect", redirectUri: REDIRECT, correlationId: CORR },
    { signer, ttlSeconds: 300, now: NOW, authorizeActor: async () => true },
  );
  STATE = minted.state;
});

const txn = (over: Partial<OktaCallbackTransaction> = {}): OktaCallbackTransaction => ({
  correlationId: CORR, subject: SUBJECT, tenantId: TENANT, organizationId: ORG, provider: "okta",
  redirectUri: REDIRECT, issuerUrl: ISSUER, orgHostname: "acme.okta.com", expiresAt: NOW + 300_000, consumedAt: null, ...over,
});
const input = (over: Partial<OktaCallbackInput> = {}): OktaCallbackInput => ({
  callbackPath: "/connectors/oauth/okta/callback", expectedProvider: "okta",
  query: new URLSearchParams({ state: STATE, code: CODE }),
  session: { subject: SUBJECT, tenantId: TENANT, organizationId: ORG },
  serverTrustedRedirectUri: REDIRECT, expectedIssuerUrl: ISSUER, transaction: txn(), pkceVerifierAvailable: true, ...over,
});
const deps: OktaCallbackDeps = { signer, now: NOW };
const permit: OktaCallbackDeps = { signer, now: NOW, lifecycle: "pilotReady", governance: { phaseCUnblocked: true, risk007Closed: true, hostedOAuthEnabled: true } };

describe("evaluateOktaCallback — dormancy + ordered gates", () => {
  it("with the pinned certificationOnly lifecycle, a fully-valid callback STILL fails closed at gate 13", () => {
    const r = evaluateOktaCallback(input(), deps);
    expect(r.status).toBe("blocked");
    if (r.status === "blocked") expect(r.reason).toBe("lifecycle_changed");
  });

  it("only when lifecycle+governance are overridden does it reach validated_no_exchange — and it NEVER exchanges/echoes the code", () => {
    const r = evaluateOktaCallback(input(), permit);
    expect(r.status).toBe("validated_no_exchange");
    // the authorization code value never appears in the result
    expect(JSON.stringify(r)).not.toContain(CODE);
  });

  it("rejects wrong route / wrong provider", () => {
    expect(evaluateOktaCallback(input({ callbackPath: "/connectors/oauth/evil" }), permit)).toMatchObject({ status: "blocked", reason: "wrong_callback_route" });
    expect(evaluateOktaCallback(input({ expectedProvider: "slack" }), permit)).toMatchObject({ status: "blocked", reason: "wrong_provider" });
  });

  it("rejects a tampered / missing state", () => {
    expect(evaluateOktaCallback(input({ query: new URLSearchParams({ state: STATE + "x", code: CODE }) }), permit)).toMatchObject({ status: "blocked", reason: "invalid_state" });
    expect(evaluateOktaCallback(input({ query: new URLSearchParams({ code: CODE }) }), permit)).toMatchObject({ status: "blocked", reason: "invalid_state" });
  });

  it("rejects missing transaction, expiry, and replay (already consumed)", () => {
    expect(evaluateOktaCallback(input({ transaction: null }), permit)).toMatchObject({ status: "blocked", reason: "transaction_not_found" });
    expect(evaluateOktaCallback(input({ transaction: txn({ expiresAt: NOW - 1 }) }), permit)).toMatchObject({ status: "blocked", reason: "transaction_expired" });
    expect(evaluateOktaCallback(input({ transaction: txn({ consumedAt: NOW - 100 }) }), permit)).toMatchObject({ status: "blocked", reason: "transaction_already_consumed" });
  });

  it("rejects a cross-organization completion", () => {
    const r = evaluateOktaCallback(input({ session: { subject: SUBJECT, tenantId: TENANT, organizationId: "99999999-9999-9999-9999-999999999999" } }), permit);
    expect(r.status).toBe("blocked");
    if (r.status === "blocked") expect(r.reason).toBe("organization_mismatch");
  });

  it("rejects a cross-tenant completion (defense in depth: session.tenantId compared to the transaction)", () => {
    // org matches but the session's tenant differs from the transaction's tenant → tenant_mismatch
    const r = evaluateOktaCallback(input({ session: { subject: SUBJECT, tenantId: "88888888-8888-8888-8888-888888888888", organizationId: ORG } }), permit);
    expect(r.status).toBe("blocked");
    if (r.status === "blocked") expect(r.reason).toBe("tenant_mismatch");
  });

  it("rejects an issuer-binding mismatch, a provider error, a bad code shape, and missing PKCE", () => {
    expect(evaluateOktaCallback(input({ expectedIssuerUrl: "https://evil.okta.com" }), permit)).toMatchObject({ status: "blocked", reason: "issuer_binding_mismatch" });
    expect(evaluateOktaCallback(input({ query: new URLSearchParams({ state: STATE, error: "access_denied" }) }), permit)).toMatchObject({ status: "provider_error" });
    expect(evaluateOktaCallback(input({ query: new URLSearchParams({ state: STATE, code: "short" }) }), permit)).toMatchObject({ status: "blocked", reason: "invalid_code_shape" });
    expect(evaluateOktaCallback(input({ pkceVerifierAvailable: false }), permit)).toMatchObject({ status: "blocked", reason: "pkce_unavailable" });
  });

  it("single-use: a replayed state nonce is rejected", () => {
    const store = new Set<string>();
    const consumed = { has: (n: string) => store.has(n), add: (n: string) => void store.add(n) };
    const first = evaluateOktaCallback(input(), { ...permit, consumedNonces: consumed });
    expect(first.status).toBe("validated_no_exchange");
    const second = evaluateOktaCallback(input(), { ...permit, consumedNonces: consumed });
    expect(second.status).toBe("blocked");
    if (second.status === "blocked") expect(second.reason).toBe("invalid_state"); // replayed nonce
  });
});
