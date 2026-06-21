import { NextResponse } from "next/server";
import {
  handleOAuthCallback,
  createHmacStateSigner,
  type OAuthStateSigner,
} from "@/lib/server/connector-vault/oauth-state";

// Inert OAuth callback skeleton (docs/42 §7/§16/§31, gated sequence PR F). It validates `state` (CSRF /
// nonce / expiry / signature) and returns a SAFE, INERT response — it performs NO token exchange, calls NO
// provider endpoint, stores NO token/credential, never touches `connector_secrets`, never marks a
// connector connected, and never persists the query params. The authorization `code` is intentionally
// ignored (never read, returned, or logged). The vault stays NOT usable for real credentials.
//
// The HMAC signing secret is read from a SERVER-ONLY env var that THIS PR does not set — so by default the
// signer is null and every callback returns an inert "not configured" status. No real secret ships here;
// the production secret/KMS wiring is a remaining gate (docs/42 §17/§31). Tests exercise the pure
// `handleOAuthCallback` with a test-only signer, never this env path.

// Build the signer from a server-only secret, or null when unconfigured (the skeleton default). The env
// var is read ONLY here (the oauth-state module stays pure); it is never exposed to the browser.
function signerFromEnv(): OAuthStateSigner | null {
  const secret = process.env.CONNECTOR_OAUTH_STATE_SECRET;
  if (!secret) return null;
  return createHmacStateSigner(secret, process.env.CONNECTOR_OAUTH_STATE_KEY_ID ?? "env");
}

// Safe, inert messages — no secret, no code, no state, no provider payload.
const MESSAGES: Record<string, string> = {
  not_configured:
    "Connector OAuth callback is not available yet. Connecting a provider is not built; no credentials were stored.",
  provider_error: "The provider reported an error on the OAuth callback. No credentials were stored.",
  invalid: "Invalid or expired OAuth callback. No credentials were stored.",
  received:
    "OAuth callback received. Connecting a provider is not built yet; no authorization code was exchanged and no credentials were stored.",
};

function handle(request: Request) {
  const url = new URL(request.url);
  const outcome = handleOAuthCallback(url.searchParams, {
    signer: signerFromEnv(),
    now: Date.now(),
  });
  // Plain-text, no-store, inert. The body carries only a fixed safe message + the safe status/reason code.
  const body = `${MESSAGES[outcome.status] ?? "OAuth callback."}${outcome.reason ? ` (${outcome.reason})` : ""}`;
  return new NextResponse(body, {
    status: outcome.httpStatus,
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
  });
}

export const GET = handle;
export const POST = handle;
