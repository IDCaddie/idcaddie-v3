// P5E18b — the server-side Okta TOKEN-EXCHANGE adapter (Phase 6), kept UNREACHABLE (dormant). It implements the P5E18a
// OktaTokenExchange interface with a DEPENDENCY-INJECTED HTTP transport — there is NO real Okta call here; it is exercised only
// with synthetic/mocked transports in tests. It never runs in the current environment because the callback route stops before
// exchange while certificationOnly.
//
// SECURITY: HTTPS only; issuer-bound exact token path; POST only; authorization_code grant only; exact redirect URI; PKCE
// verifier; private_key_jwt client assertion; strict timeout + AbortSignal; NO broad retries; max response size; content-type
// validation; sanitized error taxonomy. The raw access token NEVER appears in a log, an exception, an audit event, or the return
// value — it is handed straight to the injected vault-write boundary, which returns only an opaque VaultBoundAccessTokenRef. The
// response is validated: token type, granted scope EXACTLY equals the approved scope (reject broader/missing), expiry bounds,
// required fields, and no unexpected additional privileges.
//
// SERVER-ONLY: under src/lib/server/, the runtime browser sentinel below, and no-client-import.test.ts.

import { OKTA_APPROVED_SCOPES } from "./okta-provider-contract";
import type { OktaTokenExchange, OktaTokenExchangeRequest, OktaTokenExchangeResult, OktaTokenExchangeFailureClass, VaultBoundAccessTokenRef } from "./okta-token-exchange";

// Runtime server-only sentinel — throw if evaluated in a browser.
if (typeof (globalThis as { window?: unknown }).window !== "undefined") {
  throw new Error("connector-vault/okta-live/okta-token-exchange-adapter is server-only and must not be imported in client code");
}

const MAX_RESPONSE_BYTES = 64 * 1024; // token responses are small; cap to avoid a hostile/huge body
const TOKEN_PATH = "/oauth2/v1/token";

// The injected HTTP transport. NO real implementation ships in this phase — tests inject a mock. It performs a single POST and
// returns the raw status/content-type/body TEXT (bounded). It must honour the timeout + AbortSignal + maxBytes.
export interface OktaHttpTransport {
  post(input: { url: string; headers: Record<string, string>; body: string; timeoutMs: number; signal: AbortSignal; maxBytes: number }):
    Promise<{ status: number; contentType: string; bodyText: string }>;
}

// The injected vault-write boundary: it takes the RAW token material and returns ONLY an opaque reference. The raw token never
// leaves this call. NO real implementation ships in this phase.
export interface OktaTokenVaultWriter {
  write(input: { rawTokenMaterial: string; issuer: string; grantedScopes: readonly string[]; expiresInSeconds: number; correlationId: string }):
    Promise<VaultBoundAccessTokenRef>;
}

// The injected private_key_jwt client-assertion provider. Signing is KMS-backed + unbuilt (dormant); tests inject a synthetic
// assertion string. The adapter never handles a private key.
export interface OktaClientAssertionProvider {
  assertionFor(input: { issuer: string; clientId: string; tokenUrl: string }): Promise<string>;
}

export type OktaTokenExchangeAdapterDeps = {
  transport: OktaHttpTransport;
  vaultWriter: OktaTokenVaultWriter;
  assertionProvider: OktaClientAssertionProvider;
  clientId: string; // non-secret
};

function fail(classification: OktaTokenExchangeFailureClass): OktaTokenExchangeResult {
  return { ok: false, failure: { classification } };
}

// A structural check that the token response grants EXACTLY the approved scope (no missing, no extra/broader). Okta returns a
// space-delimited `scope`. Any deviation → scope_denied.
function grantedScopeIsExact(scope: unknown): boolean {
  if (typeof scope !== "string" || scope.length === 0) return false;
  const got = scope.trim().split(/\s+/).filter(Boolean);
  const approved = new Set<string>(OKTA_APPROVED_SCOPES);
  if (got.length !== approved.size) return false;
  return got.every((s) => approved.has(s));
}

// Build the dormant, dependency-injected adapter. `exchange` performs the POST via the injected transport, validates, and hands the
// raw token to the vault writer — returning only a reference. It never logs a raw body/token and never puts a token in a failure.
export function createOktaTokenExchangeAdapter(deps: OktaTokenExchangeAdapterDeps): OktaTokenExchange {
  return {
    async exchange(req: OktaTokenExchangeRequest): Promise<OktaTokenExchangeResult> {
      // HTTPS + issuer-bound exact token path
      let tokenUrl: URL;
      try {
        tokenUrl = new URL(req.issuerUrl.replace(/\/$/, "") + TOKEN_PATH);
      } catch {
        return fail("unknown");
      }
      if (tokenUrl.protocol !== "https:" || tokenUrl.pathname !== TOKEN_PATH) return fail("unknown");
      if (typeof req.authorizationCode !== "string" || req.authorizationCode.length === 0) return fail("invalid_grant");
      if (typeof req.pkceVerifier !== "string" || req.pkceVerifier.length === 0) return fail("unknown");

      let assertion: string;
      try {
        assertion = await deps.assertionProvider.assertionFor({ issuer: req.issuerUrl, clientId: deps.clientId, tokenUrl: tokenUrl.toString() });
      } catch {
        return fail("invalid_client");
      }

      // authorization_code grant, private_key_jwt client auth — a fixed form body. No token/secret is logged.
      const form = new URLSearchParams();
      form.set("grant_type", "authorization_code");
      form.set("code", req.authorizationCode);
      form.set("redirect_uri", req.redirectUri);
      form.set("code_verifier", req.pkceVerifier);
      form.set("client_id", deps.clientId);
      form.set("client_assertion_type", "urn:ietf:params:oauth:client-assertion-type:jwt-bearer");
      form.set("client_assertion", assertion);

      let resp: { status: number; contentType: string; bodyText: string };
      try {
        resp = await deps.transport.post({
          url: tokenUrl.toString(),
          headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
          body: form.toString(),
          timeoutMs: req.timeoutMs,
          signal: req.signal,
          maxBytes: MAX_RESPONSE_BYTES,
        });
      } catch (e) {
        return fail((e as { name?: string })?.name === "AbortError" ? "aborted" : "network");
      }

      if (!resp.contentType.toLowerCase().includes("application/json")) return fail("malformed_response");
      if (resp.bodyText.length > MAX_RESPONSE_BYTES) return fail("malformed_response");
      if (resp.status === 400) return fail("invalid_grant");
      if (resp.status === 401) return fail("invalid_client");
      if (resp.status < 200 || resp.status >= 300) return fail("unknown");

      let json: Record<string, unknown>;
      try {
        json = JSON.parse(resp.bodyText) as Record<string, unknown>;
      } catch {
        return fail("malformed_response");
      }

      const accessToken = json.access_token;
      const tokenType = json.token_type;
      const expiresIn = json.expires_in;
      if (typeof accessToken !== "string" || accessToken.length === 0) return fail("malformed_response");
      if (typeof tokenType !== "string" || tokenType.toLowerCase() !== "bearer") return fail("malformed_response");
      if (typeof expiresIn !== "number" || !(expiresIn > 0) || expiresIn > 24 * 3600) return fail("malformed_response");
      // EXACT scope enforcement — reject broader/missing/unexpected privileges.
      if (!grantedScopeIsExact(json.scope)) return fail("scope_denied");

      // Hand the RAW token straight to the vault-write boundary; the raw token never leaves this call.
      let accessTokenRef: VaultBoundAccessTokenRef;
      try {
        accessTokenRef = await deps.vaultWriter.write({
          rawTokenMaterial: accessToken,
          issuer: req.issuerUrl,
          grantedScopes: [...OKTA_APPROVED_SCOPES],
          expiresInSeconds: expiresIn,
          correlationId: req.correlationId,
        });
      } catch {
        return fail("unknown");
      }

      return {
        ok: true,
        value: {
          accessTokenRef,
          grantedScopes: [...OKTA_APPROVED_SCOPES],
          tokenType: "Bearer",
          expiresInSeconds: expiresIn,
          issuer: req.issuerUrl,
          providerTenant: req.issuerUrl,
        },
      };
    },
  };
}
