// P5E18a — the DORMANT Okta OAuth CALLBACK foundation (Phase 7). PURE, server-only, NO network/DB/exchange. It implements the
// ORDERED validation boundary a real Okta callback would run, and STOPS before token exchange behind an explicit certificationOnly
// gate. It NEVER exchanges the authorization code, NEVER calls the token endpoint, NEVER creates a credential, and NEVER marks a
// real connection connected. It fails closed if any gate changed since initiation.
//
// The authorization `code` VALUE is never logged, never returned, never stored, never placed in an error — only its PRESENCE +
// coarse SHAPE are checked. Reasons are typed CODES only (never a code/state/token/session value). Okta reason codes are a SEPARATE
// union from oauth_pending.last_rejected_code (no DB CHECK-constraint drift).
//
// This module is NOT wired into the shared Slack callback route (which is hardwired to Slack); it is an inert, tested boundary.
// SERVER-ONLY: under src/lib/server/, the runtime browser sentinel below, and no-client-import.test.ts.

import { validateOAuthState, type ConsumedNonceStore, type OAuthStateSigner, type OAuthStateReason } from "../oauth-state";
import { OKTA_PROVIDER_ID, oktaLifecyclePermitsPilotConnection, OKTA_LIFECYCLE, type OktaProviderLifecycle } from "./okta-provider-contract";
import { governancePermitsHostedOkta, OKTA_GOVERNANCE, type OktaGovernanceState } from "./okta-governance-gate";

// Runtime server-only sentinel — throw if evaluated in a browser.
if (typeof (globalThis as { window?: unknown }).window !== "undefined") {
  throw new Error("connector-vault/okta-live/okta-callback-foundation is server-only and must not be imported in client code");
}

const FIXED_CALLBACK_PATH = "/connectors/oauth/okta/callback";
// An Okta authorization code is an opaque bounded string. We validate SHAPE only and never echo the value.
const AUTH_CODE_RE = /^[A-Za-z0-9._~-]{16,512}$/;

// The server-side transaction the callback verifies against (the future single-use store row). All non-secret.
export type OktaCallbackTransaction = {
  correlationId: string;
  subject: string;
  tenantId: string;
  organizationId: string;
  provider: string;
  redirectUri: string;
  issuerUrl: string;
  orgHostname: string;
  expiresAt: number;
  consumedAt: number | null;
};

export type OktaCallbackReason =
  | "wrong_callback_route"
  | "wrong_provider"
  | "invalid_state" // wraps an OAuthStateReason (state signature/expiry/nonce/binding)
  | "transaction_not_found"
  | "transaction_expired"
  | "transaction_already_consumed"
  | "organization_mismatch"
  | "tenant_mismatch"
  | "session_required"
  | "subject_mismatch"
  | "redirect_uri_mismatch"
  | "issuer_binding_mismatch"
  | "provider_reported_error"
  | "invalid_code_shape"
  | "pkce_unavailable"
  | "lifecycle_changed"
  | "governance_changed";

export type OktaCallbackResult =
  // A gate failed — fail closed. `stateReason` is the underlying oauth-state code when reason==="invalid_state".
  | { status: "blocked"; reason: OktaCallbackReason; stateReason?: OAuthStateReason; httpStatus: number }
  // Okta redirected back with ?error=… — never surface its value, only a safe code.
  | { status: "provider_error"; reason: "provider_reported_error"; httpStatus: 400 }
  // ALL gates passed AND the code shape is valid — but Okta is certificationOnly, so we STOP here: NO exchange, NO token, NO
  // credential, NO connected connection. This is the dormant terminal success state.
  | { status: "validated_no_exchange"; correlationId: string; httpStatus: 200 };

export type OktaCallbackInput = {
  callbackPath: string;
  expectedProvider: string;
  query: URLSearchParams;
  session: { subject: string | null; tenantId: string | null; organizationId: string | null } | null;
  serverTrustedRedirectUri: string;
  expectedIssuerUrl: string; // the server-known issuer for this org (from the transaction / issuer binding)
  transaction: OktaCallbackTransaction | null;
  pkceVerifierAvailable: boolean;
};

export type OktaCallbackDeps = {
  signer: OAuthStateSigner | null;
  now: number;
  lifecycle?: OktaProviderLifecycle;
  governance?: OktaGovernanceState;
  consumedNonces?: ConsumedNonceStore;
};

const blocked = (reason: OktaCallbackReason, httpStatus = 400, stateReason?: OAuthStateReason): OktaCallbackResult => ({ status: "blocked", reason, stateReason, httpStatus });

// Evaluate the ordered callback gates. Returns a typed result; never throws on bad input; never echoes a code/state/token.
export function evaluateOktaCallback(input: OktaCallbackInput, deps: OktaCallbackDeps): OktaCallbackResult {
  const lifecycle = deps.lifecycle ?? OKTA_LIFECYCLE;
  const governance = deps.governance ?? OKTA_GOVERNANCE;

  // 1. callback route + provider
  if (input.callbackPath !== FIXED_CALLBACK_PATH) return blocked("wrong_callback_route", 404);
  if (input.expectedProvider !== OKTA_PROVIDER_ID) return blocked("wrong_provider", 400);

  // 2. state existence + cryptographic validity + binding (subject/tenant/provider/redirect/correlation/expiry/nonce). The
  //    completing session supplies the expected subject/tenant; the redirect URI is the SERVER-TRUSTED value (never request-derived).
  if (!deps.signer) return blocked("invalid_state", 400);
  const state = input.query.get("state");
  const expected = input.transaction
    ? {
        tenantId: input.transaction.tenantId,
        provider: OKTA_PROVIDER_ID,
        connectorId: null,
        subject: input.session?.subject ?? null,
        redirectIntent: "okta_connect",
        redirectUri: input.serverTrustedRedirectUri,
        correlationId: input.transaction.correlationId,
      }
    : { tenantId: "", provider: OKTA_PROVIDER_ID, connectorId: null, subject: input.session?.subject ?? null, redirectIntent: "okta_connect", redirectUri: input.serverTrustedRedirectUri, correlationId: "" };
  const sv = validateOAuthState(state, input.transaction ? expected : null, { signer: deps.signer, now: deps.now, consumedNonces: deps.consumedNonces });
  if (!sv.ok) return blocked("invalid_state", 400, sv.reason);

  // 3. transaction existence (server-side record)
  if (!input.transaction) return blocked("transaction_not_found", 400);
  const t = input.transaction;
  // 4. transaction expiry (server-side)
  if (!(t.expiresAt > deps.now)) return blocked("transaction_expired", 400);
  // 5. transaction unused (single-use)
  if (t.consumedAt !== null) return blocked("transaction_already_consumed", 400);
  // 6. initiating organization + tenant (defense in depth: compare the session's tenant to the transaction's, not only via the
  //    state's tid — so an org→tenant uniqueness assumption is never load-bearing).
  if (!input.session || input.session.organizationId == null) return blocked("session_required", 401);
  if (input.session.organizationId !== t.organizationId) return blocked("organization_mismatch", 403);
  if (input.session.tenantId == null || input.session.tenantId !== t.tenantId) return blocked("tenant_mismatch", 403);
  // 7. initiating user/session rules
  if (input.session.subject == null) return blocked("session_required", 401);
  if (input.session.subject !== t.subject) return blocked("subject_mismatch", 403);
  // 8. exact redirect URI (server-trusted vs the transaction's bound value)
  if (t.redirectUri !== input.serverTrustedRedirectUri) return blocked("redirect_uri_mismatch", 400);
  // 9. issuer/organization binding
  if (t.provider !== OKTA_PROVIDER_ID) return blocked("wrong_provider", 400);
  if (t.issuerUrl !== input.expectedIssuerUrl) return blocked("issuer_binding_mismatch", 400);

  // 10. provider-reported error (?error=…) — safe code only, never the value/description
  if (input.query.has("error")) return { status: "provider_error", reason: "provider_reported_error", httpStatus: 400 };

  // 11. authorization code SHAPE (presence + coarse shape; value never read/echoed)
  const code = input.query.get("code");
  if (typeof code !== "string" || !AUTH_CODE_RE.test(code)) return blocked("invalid_code_shape", 400);

  // 12. PKCE transaction availability (a server-held verifier must exist for this transaction)
  if (input.pkceVerifierAvailable !== true) return blocked("pkce_unavailable", 400);

  // 13. provider lifecycle + phase gates STILL permit continuation (fail closed if changed since initiation)
  if (!oktaLifecyclePermitsPilotConnection(lifecycle)) return blocked("lifecycle_changed", 403);
  if (!governancePermitsHostedOkta(governance)) return blocked("governance_changed", 403);

  // ── ALL gates passed. In P5E18a we STOP here — certificationOnly means NO code exchange, NO token endpoint call, NO credential
  //    creation, NO connected connection. A future authorized phase resumes from this exact point behind an explicit gate.
  return { status: "validated_no_exchange", correlationId: t.correlationId, httpStatus: 200 };
}
