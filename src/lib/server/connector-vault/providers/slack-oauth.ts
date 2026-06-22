// Server-only SLACK OAuth authorize/callback SKELETON (docs/42 §49, gated vault). The first
// provider-specific connector module — it builds the Slack authorize-redirect URL and classifies the Slack
// callback, integrating the existing `oauth-state` signer + `oauth_pending` replay-store shape + the
// provider registry. **The Slack provider remains non-functional for real connections.** It does NOT
// exchange an OAuth code for tokens, store any token/credential, touch `connector_secrets`, call any Slack
// API, or mark a connector connected. Real token storage stays gated behind a later reviewed PR.
//
// WHAT IT DOES: (a) `buildSlackAuthorizeUrl` returns the `https://slack.com/oauth/v2/authorize?...` redirect
// URL with a SIGNED `state` (via `createOAuthState`) + the alignment values a future PR persists to
// `oauth_pending` (`stateJti = sha256(state)`, `nonceHash = sha256(nonce)` — one-way hashes, never the raw
// nonce/state); (b) `classifySlackCallback` validates the signed state (via `validateOAuthState`) and
// classifies the callback into a SAFE outcome. The Slack token endpoint (`oauth.v2.access`) is NEVER built
// or called — only the authorize redirect target is. No `fetch` anywhere.
//
// FAIL CLOSED: missing client_id / redirect_uri / signer / a non-https redirect / a non-slack provider all
// return a safe `{ ok:false, reason }` (authorize) or `{ status:'invalid'|'not_configured' }` (callback) —
// never a thrown raw value, never a partial URL. The `code` value is never read/returned/logged (presence
// only). Outcomes carry safe labels + one-way hashes only.
//
// SERVER-ONLY: under `src/lib/server/`, the runtime browser sentinel below, and `no-client-import.test.ts`.
// Imports only its server-only siblings (`../oauth-state`, `../provider-registry`) + `node:crypto`.

import { createHash } from "node:crypto";
import {
  createOAuthState,
  validateOAuthState,
  type OAuthStateContext,
  type OAuthStateSigner,
  type OAuthStateReason,
  type ConsumedNonceStore,
} from "../oauth-state";
import { getConnectorProvider } from "../provider-registry";

// Runtime server-only sentinel — throw if evaluated in a browser.
if (typeof (globalThis as { window?: unknown }).window !== "undefined") {
  throw new Error("connector-vault/providers/slack-oauth is server-only and must not be imported in client code");
}

export const SLACK_PROVIDER_ID = "slack";
// Slack OAuth v2 AUTHORIZE endpoint (the public redirect target — NOT a secret, NOT the token endpoint).
const SLACK_AUTHORIZE_URL = "https://slack.com/oauth/v2/authorize";
const DEFAULT_TTL_SECONDS = 600; // 10 min

export type SlackAuthorizeReason =
  | "wrong_provider"
  | "missing_client_id"
  | "missing_redirect_uri"
  | "invalid_redirect_uri"
  | "missing_signer"
  | "missing_scopes"
  | "invalid_context";

export type SlackAuthorizeInput = {
  ctx: OAuthStateContext; // provider MUST be 'slack'
  clientId: string; // INJECTED from server-only config — never hardcoded / read from env here
  redirectUri: string; // validated (https only)
  signer: OAuthStateSigner; // the existing oauth-state signer boundary
  now: number;
  ttlSeconds?: number;
  scopes?: readonly string[]; // defaults to the registry's display scopes for slack
  nonce?: string; // injectable for deterministic tests
};

export type SlackAuthorizeResult =
  | {
      ok: true;
      url: string;
      // The alignment values a FUTURE PR persists to oauth_pending at authorize-time (one-way hashes —
      // the raw nonce/state are NEVER persisted). The callback later consumes by { stateJti, nonceHash }.
      stateJti: string;
      nonceHash: string;
      expiresAt: number;
    }
  | { ok: false; reason: SlackAuthorizeReason };

export type SlackCallbackInvalidReason = "missing_code" | "wrong_provider" | OAuthStateReason;

export type SlackCallbackOutcome =
  // A well-formed, valid Slack callback we WOULD consume — but this PR performs NO token exchange / NO
  // storage. stateJti/nonceHash are the (future) oauth_pending consume keys; both are one-way hashes.
  | { status: "received"; stateJti: string; nonceHash: string }
  | { status: "provider_error"; reason: "provider_reported_error" }
  | { status: "not_configured" }
  | { status: "invalid"; reason: SlackCallbackInvalidReason };

function sha256Hex(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

// A redirect_uri is acceptable only if it is an absolute HTTPS URL (no javascript:/http:/data:/relative).
function isValidRedirectUri(u: string): boolean {
  if (typeof u !== "string" || u.length === 0) return false;
  try {
    return new URL(u).protocol === "https:";
  } catch {
    return false;
  }
}

// Build the Slack authorize-redirect URL with a signed `state`. Fails closed (safe reason) on bad config.
export function buildSlackAuthorizeUrl(input: SlackAuthorizeInput): SlackAuthorizeResult {
  if (!input || typeof input !== "object" || !input.ctx) return { ok: false, reason: "invalid_context" };
  if (input.ctx.provider !== SLACK_PROVIDER_ID) return { ok: false, reason: "wrong_provider" };
  if (typeof input.clientId !== "string" || input.clientId.length === 0)
    return { ok: false, reason: "missing_client_id" };
  if (typeof input.redirectUri !== "string" || input.redirectUri.length === 0)
    return { ok: false, reason: "missing_redirect_uri" };
  if (!isValidRedirectUri(input.redirectUri)) return { ok: false, reason: "invalid_redirect_uri" };
  if (!input.signer) return { ok: false, reason: "missing_signer" };

  // Default to the registry's DISPLAY scopes for slack (metadata only — not secrets).
  const scopes = input.scopes ?? getConnectorProvider(SLACK_PROVIDER_ID)?.requiredScopes ?? [];
  if (!scopes.length) return { ok: false, reason: "missing_scopes" };

  let state: string;
  let nonce: string;
  try {
    ({ state, nonce } = createOAuthState(input.ctx, {
      signer: input.signer,
      ttlSeconds: input.ttlSeconds ?? DEFAULT_TTL_SECONDS,
      now: input.now,
      nonce: input.nonce,
    }));
  } catch {
    // createOAuthState validates the context/opts; a bad context fails closed (no raw value surfaced).
    return { ok: false, reason: "invalid_context" };
  }

  const params = new URLSearchParams({
    client_id: input.clientId,
    scope: scopes.join(","),
    redirect_uri: input.redirectUri,
    state,
  });
  return {
    ok: true,
    url: `${SLACK_AUTHORIZE_URL}?${params.toString()}`,
    stateJti: sha256Hex(state),
    nonceHash: sha256Hex(nonce),
    expiresAt: input.now + (input.ttlSeconds ?? DEFAULT_TTL_SECONDS) * 1000,
  };
}

// Classify a Slack OAuth callback into a SAFE, inert outcome. Validates the signed state via the existing
// `validateOAuthState`. NEVER exchanges `code` for a token, NEVER calls Slack, NEVER reads/writes
// `connector_secrets`, NEVER marks a connector connected. The `code` value is checked for PRESENCE only.
export function classifySlackCallback(
  searchParams: URLSearchParams,
  opts: { signer: OAuthStateSigner | null; now: number; expectedContext?: OAuthStateContext | null; consumedNonces?: ConsumedNonceStore },
): SlackCallbackOutcome {
  // Slack reports cancel/errors via ?error= (e.g. access_denied) — never surface the raw value.
  if (searchParams.has("error")) return { status: "provider_error", reason: "provider_reported_error" };
  // Skeleton default: with no signer wired (this PR ships none), the Slack callback is inert.
  if (!opts.signer) return { status: "not_configured" };
  // This module handles ONLY slack — a non-slack expected context fails closed.
  if (opts.expectedContext && opts.expectedContext.provider !== SLACK_PROVIDER_ID)
    return { status: "invalid", reason: "wrong_provider" };

  const state = searchParams.get("state");
  const result = validateOAuthState(state, opts.expectedContext ?? null, {
    signer: opts.signer,
    now: opts.now,
    consumedNonces: opts.consumedNonces,
  });
  if (!result.ok) return { status: "invalid", reason: result.reason };

  // Valid signed state. Slack returns `code` on success; its absence is a malformed/cancelled callback.
  if (!searchParams.get("code")) return { status: "invalid", reason: "missing_code" };

  // A valid Slack callback we WOULD consume + (future) exchange. This PR does NEITHER — it returns only the
  // safe future-consume keys (one-way hashes). No token exchange, no Slack call, no connector_secrets write.
  return {
    status: "received",
    stateJti: state ? sha256Hex(state) : "",
    nonceHash: sha256Hex(result.payload.nonce),
  };
}
