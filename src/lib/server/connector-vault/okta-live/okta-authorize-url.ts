// P5E18a — the PURE, DETERMINISTIC Okta authorization-URL builder (Phase 6). Server-only, NO network request (it only constructs a
// string). It builds ONLY the authorization-code + PKCE(S256) authorize URL, with an EXACT allowlisted scope set, the EXACT server-
// trusted redirect URI, the signed state, and the PKCE challenge. The public `client_id` is supplied ONLY through a server-side
// credential-reference abstraction (never a raw secret read, never user input). There is NO implicit flow, NO token in the URL, NO
// client secret anywhere, and NO user-controlled extra parameter.
//
// SERVER-ONLY: under src/lib/server/, the runtime browser sentinel below, and no-client-import.test.ts.

import { OKTA_PROVIDER_ID, scopesExactlyApproved } from "./okta-provider-contract";

// Runtime server-only sentinel — throw if evaluated in a browser.
if (typeof (globalThis as { window?: unknown }).window !== "undefined") {
  throw new Error("connector-vault/okta-live/okta-authorize-url is server-only and must not be imported in client code");
}

// The credential-reference abstraction for the PUBLIC client id. A real deployment backs this with the server-side credential-
// reference resolver (0043 pointer → external store metadata); it returns ONLY the non-secret client id, never a secret. Tests
// inject an obviously-synthetic source. The builder NEVER reads a secret and NEVER accepts a client id from a request.
export interface OktaClientIdSource {
  resolveClientId(): string;
}

// Okta OAuth client ids are opaque, prefixed `0oa` + a bounded safe charset (NOT a UUID). Validated by shape only.
const OKTA_CLIENT_ID_RE = /^0oa[a-zA-Z0-9]{10,40}$/;
export function isValidOktaClientId(v: unknown): v is string {
  return typeof v === "string" && OKTA_CLIENT_ID_RE.test(v);
}

// The exact callback path an Okta app must register + the builder must emit (no trailing slash). Kept in lockstep with the
// provider-neutral connector-oauth-config.
const CALLBACK_PATH = "/connectors/oauth/callback";
const REDIRECT_RE = /^https:\/\/[a-z0-9.-]+\/connectors\/oauth\/callback$/;
// The exact authorize path on the Okta org authorization server.
const AUTHORIZE_PATH = "/oauth2/v1/authorize";
const CODE_CHALLENGE_RE = /^[A-Za-z0-9_-]{43}$/; // base64url sha256, unpadded

export type OktaAuthorizeReason =
  | "invalid_issuer"
  | "invalid_client_id"
  | "invalid_redirect_uri"
  | "scope_not_exact"
  | "invalid_state"
  | "invalid_code_challenge";

export type OktaAuthorizeInput = {
  issuerUrl: string; // https://<org>.okta.com — no path/query/fragment
  clientIdSource: OktaClientIdSource;
  redirectUri: string; // exact server-trusted callback URI
  scopes: readonly string[]; // must equal the approved set exactly
  state: string; // signed state
  codeChallenge: string; // PKCE S256 challenge
};

export type OktaAuthorizeResult = { ok: true; url: string } | { ok: false; reason: OktaAuthorizeReason };

function isHttpsOrigin(v: string): boolean {
  try {
    const u = new URL(v);
    // Must be an https ORIGIN — no path (other than "/"), no query, no fragment, no credentials, no explicit port smuggling.
    return u.protocol === "https:" && (u.pathname === "" || u.pathname === "/") && u.search === "" && u.hash === "" && u.username === "" && u.password === "";
  } catch {
    return false;
  }
}

// Build the Okta authorize URL. Returns a typed failure on any invalid input; never throws; never contacts a network. The output
// contains ONLY: client_id, response_type=code, scope (exact, space-delimited), redirect_uri (exact), state, code_challenge,
// code_challenge_method=S256. No secret, no token, no user-controlled parameter.
export function buildOktaAuthorizeUrl(input: OktaAuthorizeInput): OktaAuthorizeResult {
  if (!isHttpsOrigin(input.issuerUrl)) return { ok: false, reason: "invalid_issuer" };

  let clientId: string;
  try {
    clientId = input.clientIdSource.resolveClientId();
  } catch {
    return { ok: false, reason: "invalid_client_id" };
  }
  if (!isValidOktaClientId(clientId)) return { ok: false, reason: "invalid_client_id" };

  if (typeof input.redirectUri !== "string" || !REDIRECT_RE.test(input.redirectUri)) return { ok: false, reason: "invalid_redirect_uri" };
  if (scopesExactlyApproved(input.scopes).ok !== true) return { ok: false, reason: "scope_not_exact" };
  if (typeof input.state !== "string" || input.state.length === 0 || input.state.length > 4096) return { ok: false, reason: "invalid_state" };
  if (typeof input.codeChallenge !== "string" || !CODE_CHALLENGE_RE.test(input.codeChallenge)) return { ok: false, reason: "invalid_code_challenge" };

  const issuer = input.issuerUrl.replace(/\/$/, "");
  // A FIXED, closed parameter set — no spread of caller input, no extra keys. Okta scopes are SPACE-delimited.
  const params = new URLSearchParams();
  params.set("client_id", clientId);
  params.set("response_type", "code"); // authorization-code only — never "token"/"id_token" implicit
  params.set("scope", input.scopes.join(" "));
  params.set("redirect_uri", input.redirectUri);
  params.set("state", input.state);
  params.set("code_challenge", input.codeChallenge);
  params.set("code_challenge_method", "S256");
  return { ok: true, url: `${issuer}${AUTHORIZE_PATH}?${params.toString()}` };
}

// Exposed for tests/assertions: the provider + the exact paths this builder commits to.
export const OKTA_AUTHORIZE_CONTRACT = Object.freeze({ provider: OKTA_PROVIDER_ID, authorizePath: AUTHORIZE_PATH, callbackPath: CALLBACK_PATH });
