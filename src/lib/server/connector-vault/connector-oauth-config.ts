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

// Resolve the server-trusted OAuth redirect URI from TRUSTED config ONLY (an explicit `CONNECTOR_OAUTH_REDIRECT_URI`
// override, else the staging default). NEVER request-derived. Validated absolute-HTTPS + exact path + no trailing
// slash (also re-asserted by the B2a `serverTrustedRedirectUri` helper). Throws on a malformed configured value.
export function connectorOAuthRedirectUri(env: Record<string, string | undefined> = process.env): string {
  const value = env.CONNECTOR_OAUTH_REDIRECT_URI ?? STAGING_OAUTH_REDIRECT_URI;
  if (!REDIRECT_RE.test(value))
    throw new Error("invalid CONNECTOR_OAUTH_REDIRECT_URI (must be https://<host>/connectors/oauth/callback, no trailing slash)");
  return serverTrustedRedirectUri(value);
}
