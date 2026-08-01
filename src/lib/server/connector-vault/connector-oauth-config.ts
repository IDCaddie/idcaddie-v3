// Server-only TRUSTED OAuth redirect config (PR B2c-run prep — docs/42 §90.2/§90.4, docs/45). SYNTHETIC-safe.
//
// The EXACT staging callback URL the B2c-route serves. This is the value:
//   * the orchestrator's `expectedContext.redirectUri` is set to (compared FULL-STRING by B2a `validateOAuthState`),
//   * the Slack app's "Redirect URLs" MUST byte-match (docs/45),
//   * and it is resolved from TRUSTED server config ONLY — NEVER reconstructed from a request (Host / X-Forwarded-
//     Host / Forwarded / request URL / origin / query). No trailing slash.
//
// It is NOT a secret. It replaces the prior placeholder (`https://app.example.com/...`) so B2c-run validates against
// the real staging redirect. No real OAuth run, no real token, no production enablement.
//
// SERVER-ONLY: under `src/lib/server/`, the runtime browser sentinel below, and `no-client-import.test.ts`.

import { serverTrustedRedirectUri } from "./oauth-state";

// Runtime server-only sentinel — throw if evaluated in a browser.
if (typeof (globalThis as { window?: unknown }).window !== "undefined") {
  throw new Error("connector-vault/connector-oauth-config is server-only and must not be imported in client code");
}

// The route handler lives at `src/app/(authenticated)/connectors/oauth/callback/route.ts`; `(authenticated)` is a
// route GROUP and adds NO URL segment, so the served path is exactly `/connectors/oauth/callback`.
export const CONNECTOR_OAUTH_CALLBACK_PATH = "/connectors/oauth/callback" as const;
// The exact staging callback URL (host + path). Slack must register THIS string verbatim; the server validates
// against THIS string. No trailing slash.
export const STAGING_OAUTH_REDIRECT_URI = `https://idcaddie-v3.vercel.app${CONNECTOR_OAUTH_CALLBACK_PATH}`;

// absolute https + exact callback path + NO trailing slash.
const REDIRECT_RE = /^https:\/\/[a-z0-9.-]+\/connectors\/oauth\/callback$/;

// EXACT callback allowlist for a REAL run (Phase 8E). REDIRECT_RE constrains the SHAPE but accepts any host, and the
// redirect URI is what a client secret and an authorization code get posted against. A typo'd or attacker-supplied
// CONNECTOR_OAUTH_REDIRECT_URI that still matched the shape would be a credential-bearing request to somewhere else.
// Shape-checking a URL is not the same as knowing where it points.
//
// Whole URIs, compared as strings — not hosts parsed out of the value. Parsing would mean this module contained the
// substring `.host`, and `connector-oauth-config.test.ts` asserts it never does: the guard exists because the ONE
// mistake this file must never make is deriving a redirect from a request Host header. An exact-string allowlist is
// both stricter than a host check and keeps that guard meaningful.
const REAL_CALLBACK_URIS: readonly string[] = [
  `https://idcaddie-v3.vercel.app${CONNECTOR_OAUTH_CALLBACK_PATH}`,
  `https://staging.idcaddie.com${CONNECTOR_OAUTH_CALLBACK_PATH}`,
];

export class ConnectorOAuthHostError extends Error {
  constructor() { super("callback_host_not_allowlisted"); this.name = "ConnectorOAuthHostError"; }
}

// The redirect URI for a REAL run: the configured value, additionally required to be one of the allowlisted URIs.
// Throws (fail closed) rather than falling back to the default — a real run must not silently retarget its callback.
export function realConnectorOAuthRedirectUri(env: Record<string, string | undefined> = process.env): string {
  const uri = connectorOAuthRedirectUri(env);
  if (!REAL_CALLBACK_URIS.includes(uri)) throw new ConnectorOAuthHostError();
  return uri;
}

// The ONE Slack workspace a real run is allowed to bind, from server-trusted config. No default: an unset value must
// fail closed rather than mean "any workspace". Slack team ids are `T` + uppercase alphanumerics.
export function expectedSlackTeamId(env: Record<string, string | undefined> = process.env): string | null {
  const v = env.CONNECTOR_OAUTH_EXPECTED_SLACK_TEAM_ID;
  return typeof v === "string" && /^T[A-Z0-9]{2,}$/.test(v) ? v : null;
}

// Resolve the server-trusted OAuth redirect URI from TRUSTED config ONLY (an explicit `CONNECTOR_OAUTH_REDIRECT_URI`
// override, else the staging default). NEVER request-derived. Validated absolute-HTTPS + exact path + no trailing
// slash (also re-asserted by the B2a `serverTrustedRedirectUri` helper). Throws on a malformed configured value.
export function connectorOAuthRedirectUri(env: Record<string, string | undefined> = process.env): string {
  const value = env.CONNECTOR_OAUTH_REDIRECT_URI ?? STAGING_OAUTH_REDIRECT_URI;
  if (!REDIRECT_RE.test(value))
    throw new Error("invalid CONNECTOR_OAUTH_REDIRECT_URI (must be https://<host>/connectors/oauth/callback, no trailing slash)");
  return serverTrustedRedirectUri(value);
}
