import { describe, it, expect, vi, beforeAll } from "vitest";
import { createHmacStateSigner, generateBoundOAuthState } from "../oauth-state";
import { handleOktaOAuthCallback, isOktaCallbackEnabled, OKTA_CALLBACK_PATH, OKTA_CALLBACK_FAILURE_PATH, OKTA_CALLBACK_SUCCESS_PATH, type OktaCallbackHandlerDeps } from "./okta-callback-route-handler";
import type { OktaCallbackTransaction } from "./okta-callback-foundation";
import type { OktaTokenExchange } from "./okta-token-exchange";

// P5E18b Phase 8/15 — the provider-selecting Okta callback route handler. Proves the exchange adapter is NEVER called under the
// current gates (certificationOnly), the code is never echoed, and the redirect is a fixed customer-safe path.

const signer = createHmacStateSigner(Buffer.from("synthetic-test-state-secret-not-real"), "k");
const NOW = 1_700_000_000_000;
const REDIRECT = "https://idcaddie-v3.vercel.app/connectors/oauth/okta/callback";
const T = "11111111-1111-1111-1111-111111111111", O = "22222222-2222-2222-2222-222222222222", S = "33333333-3333-3333-3333-333333333333", CORR = "corr-okta-r1";
const CODE = "AbCd1234_synthetic_code_never_echoed";

let STATE = "";
beforeAll(async () => {
  STATE = (await generateBoundOAuthState(
    { tenantId: T, provider: "okta", connectorId: null, subject: S, redirectIntent: "okta_connect", redirectUri: REDIRECT, correlationId: CORR },
    { signer, ttlSeconds: 300, now: NOW, authorizeActor: async () => true },
  )).state;
});

const txn = (): OktaCallbackTransaction => ({ correlationId: CORR, subject: S, tenantId: T, organizationId: O, provider: "okta", redirectUri: REDIRECT, issuerUrl: "https://acme.okta.com", orgHostname: "acme.okta.com", expiresAt: NOW + 300_000, consumedAt: null });
const spyExchange = () => { const exchange = vi.fn(async () => ({ ok: false, failure: { classification: "unknown" } }) as never); return { exchange } as OktaTokenExchange & { exchange: ReturnType<typeof vi.fn> }; };
const req = (path: string = OKTA_CALLBACK_PATH, params = `state=${encodeURIComponent(STATE)}&code=${CODE}`) => new Request(`https://app.example${path}?${params}`);

const deps = (over: Partial<OktaCallbackHandlerDeps> = {}): OktaCallbackHandlerDeps => ({
  enabled: true, signer, now: NOW,
  resolveSession: async () => ({ subject: S, tenantId: T, organizationId: O }),
  serverTrustedRedirectUri: REDIRECT,
  lookupTransaction: async () => txn(),
  pkceVerifierAvailable: async () => true,
  exchangeAdapter: spyExchange(),
  ...over,
});

describe("okta callback route handler — dormancy", () => {
  it("under the current gates (certificationOnly), a fully-valid callback does NOT call the exchange and redirects to the fixed failure path", async () => {
    const ex = spyExchange();
    const onExchangeInvoked = vi.fn();
    const res = await handleOktaOAuthCallback(req(), deps({ exchangeAdapter: ex, onExchangeInvoked }));
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(OKTA_CALLBACK_FAILURE_PATH);
    expect(ex.exchange).not.toHaveBeenCalled();
    expect(onExchangeInvoked).not.toHaveBeenCalled();
    // the authorization code is never echoed into the response
    expect(res.headers.get("location")).not.toContain(CODE);
  });

  it("when disabled, redirects to the fixed failure path and never calls the exchange", async () => {
    const ex = spyExchange();
    const res = await handleOktaOAuthCallback(req(), deps({ enabled: false, exchangeAdapter: ex }));
    expect(res.headers.get("location")).toBe(OKTA_CALLBACK_FAILURE_PATH);
    expect(ex.exchange).not.toHaveBeenCalled();
  });

  it("is provider/path-selecting: a wrong callback path fails closed (no exchange)", async () => {
    const ex = spyExchange();
    const res = await handleOktaOAuthCallback(req("/connectors/oauth/callback"), deps({ exchangeAdapter: ex }));
    expect(res.headers.get("location")).toBe(OKTA_CALLBACK_FAILURE_PATH);
    expect(ex.exchange).not.toHaveBeenCalled();
  });

  it("ONLY when lifecycle+governance are overridden to permit does the exchange get invoked — proving the gates are the sole barrier", async () => {
    const ex = spyExchange();
    const onExchangeInvoked = vi.fn();
    const res = await handleOktaOAuthCallback(req(), deps({
      exchangeAdapter: ex, onExchangeInvoked,
      lifecycle: "pilotReady",
      governance: { phaseCUnblocked: true, risk007Closed: true, hostedOAuthEnabled: true },
    }));
    expect(onExchangeInvoked).toHaveBeenCalledOnce();
    expect(ex.exchange).toHaveBeenCalledOnce();
    expect(res.headers.get("location")).toBe(OKTA_CALLBACK_SUCCESS_PATH);
  });
});

describe("okta callback environment gate", () => {
  it("is OFF by default, OFF in production, ON only with the explicit non-prod opt-in", () => {
    expect(isOktaCallbackEnabled({})).toBe(false);
    expect(isOktaCallbackEnabled({ CONNECTOR_OKTA_CALLBACK_ENABLED: "1", VERCEL_ENV: "production" })).toBe(false);
    expect(isOktaCallbackEnabled({ CONNECTOR_OKTA_CALLBACK_ENABLED: "1", NODE_ENV: "production" })).toBe(false);
    expect(isOktaCallbackEnabled({ CONNECTOR_OKTA_CALLBACK_ENABLED: "1", VERCEL_ENV: "preview" })).toBe(true);
  });
});
