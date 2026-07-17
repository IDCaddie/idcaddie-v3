// P5E18b — the SERVER-ONLY Okta client CONFIGURATION model (Phase 5). PURE, server-only, NO network/secret. It resolves the
// non-secret configuration a future authorized exchange needs — the (non-secret) client id, the client-authentication METHOD, the
// credential REFERENCE pointer, the exact redirect URI, the issuer binding, the exact scope, the authorize/token endpoint paths,
// timeout, environment, and lifecycle gate. It FAILS CLOSED when any required field is missing (e.g. the client id is not yet
// provided by the operator). The client id is NOT populated here — it arrives only through the approved non-secret staging config
// path once the operator creates the Okta app.
//
// SERVER-ONLY: under src/lib/server/, the runtime browser sentinel below, and no-client-import.test.ts (okta-live/ is guarded).

import { OKTA_PROVIDER_ID, OKTA_APPROVED_SCOPES, scopesExactlyApproved, OKTA_LIFECYCLE, oktaLifecyclePermitsPilotConnection, type OktaProviderLifecycle } from "./okta-provider-contract";
import { isValidOktaClientId } from "./okta-authorize-url";

// Runtime server-only sentinel — throw if evaluated in a browser.
if (typeof (globalThis as { window?: unknown }).window !== "undefined") {
  throw new Error("connector-vault/okta-live/okta-client-config is server-only and must not be imported in client code");
}

// Only private_key_jwt is supported (matches the runner Okta design; a client_secret method is deliberately NOT offered here).
export type OktaClientAuthMethod = "private_key_jwt";
export const OKTA_AUTHORIZE_PATH = "/oauth2/v1/authorize" as const;
export const OKTA_TOKEN_PATH = "/oauth2/v1/token" as const;
export const OKTA_DEFAULT_TIMEOUT_MS = 8000;

const REDIRECT_RE = /^https:\/\/[a-z0-9.-]+\/connectors\/oauth\/okta\/callback$/;
const ISSUER_RE = /^https:\/\/[a-z0-9.-]+$/;

export type OktaClientConfig = {
  provider: typeof OKTA_PROVIDER_ID;
  clientId: string; // NON-secret, from the approved staging config path
  clientAuthMethod: OktaClientAuthMethod;
  credentialReference: string; // 0043 external-store POINTER — never a secret value
  redirectUri: string;
  issuerUrl: string;
  orgHostname: string;
  scopes: readonly string[];
  authorizePath: typeof OKTA_AUTHORIZE_PATH;
  tokenPath: typeof OKTA_TOKEN_PATH;
  timeoutMs: number;
  environment: "staging";
  lifecycle: OktaProviderLifecycle;
};

export type OktaClientConfigInput = {
  clientId?: string | null; // absent until the operator provides it
  clientAuthMethod?: OktaClientAuthMethod;
  credentialReference?: string | null;
  redirectUri?: string | null;
  issuerUrl?: string | null;
  orgHostname?: string | null;
  scopes?: readonly string[] | null;
  timeoutMs?: number;
  environment?: string | null;
  lifecycle?: OktaProviderLifecycle;
};

export type OktaClientConfigResult = { ok: true; config: OktaClientConfig } | { ok: false; missing: string[] };

// Resolve the config, failing closed with the list of MISSING/invalid required fields. It never throws. It does NOT decide whether
// the connection may proceed (that is the connect/callback gate + governance) — it only assembles a valid, complete config or
// reports what is missing. `lifecycle` still resolves even at certificationOnly (config completeness is separate from the gate).
export function resolveOktaClientConfig(input: OktaClientConfigInput): OktaClientConfigResult {
  const missing: string[] = [];
  const clientId = input.clientId ?? "";
  if (!isValidOktaClientId(clientId)) missing.push("clientId"); // absent/invalid until the operator supplies it
  const method: OktaClientAuthMethod = input.clientAuthMethod ?? "private_key_jwt";
  if (method !== "private_key_jwt") missing.push("clientAuthMethod");
  const credentialReference = input.credentialReference ?? "";
  if (typeof credentialReference !== "string" || credentialReference.length === 0) missing.push("credentialReference");
  const redirectUri = input.redirectUri ?? "";
  if (!REDIRECT_RE.test(redirectUri)) missing.push("redirectUri");
  const issuerUrl = input.issuerUrl ?? "";
  if (!ISSUER_RE.test(issuerUrl)) missing.push("issuerUrl");
  const orgHostname = input.orgHostname ?? "";
  if (typeof orgHostname !== "string" || orgHostname.length === 0) missing.push("orgHostname");
  const scopes = input.scopes ?? [];
  if (scopesExactlyApproved(scopes).ok !== true) missing.push("scopes");
  if ((input.environment ?? "") !== "staging") missing.push("environment"); // staging-only
  const timeoutMs = input.timeoutMs ?? OKTA_DEFAULT_TIMEOUT_MS;
  if (!(Number.isInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 30000)) missing.push("timeoutMs");

  if (missing.length > 0) return { ok: false, missing };
  return {
    ok: true,
    config: {
      provider: OKTA_PROVIDER_ID,
      clientId,
      clientAuthMethod: method,
      credentialReference,
      redirectUri,
      issuerUrl,
      orgHostname,
      scopes: [...OKTA_APPROVED_SCOPES],
      authorizePath: OKTA_AUTHORIZE_PATH,
      tokenPath: OKTA_TOKEN_PATH,
      timeoutMs,
      environment: "staging",
      lifecycle: input.lifecycle ?? OKTA_LIFECYCLE,
    },
  };
}

// A pilot connection may proceed ONLY when the config is complete AND the lifecycle permits pilot connection (not certificationOnly).
// Today this is false (lifecycle pinned certificationOnly). Fail closed.
export function oktaClientConfigPermitsConnection(result: OktaClientConfigResult): boolean {
  return result.ok && oktaLifecyclePermitsPilotConnection(result.config.lifecycle);
}
