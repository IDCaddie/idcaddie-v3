// P5E18a — the Okta code-exchange INTERFACE (Phase 8). TYPES + a DORMANT (throwing) factory only. There is NO live HTTP call, NO
// token endpoint request, NO real implementation in this phase. It defines the seam a future authorized phase will implement.
//
// RAW-TOKEN BOUNDARY (compile-time enforced by the shape + asserted by tests): a raw access/refresh token NEVER leaves this
// exchange boundary. The success result returns ONLY an opaque, branded `VaultBoundAccessTokenRef` (a handle into the vault-writing
// boundary) — never a token string. So a raw token can never reach a React component, a browser response, an audit event, a DB
// table, a test snapshot, or a log. The authorization code and PKCE verifier are INPUTS consumed here and are never returned/logged.
//
// SERVER-ONLY: under src/lib/server/, the runtime browser sentinel below, and no-client-import.test.ts.

// Runtime server-only sentinel — throw if evaluated in a browser.
if (typeof (globalThis as { window?: unknown }).window !== "undefined") {
  throw new Error("connector-vault/okta-live/okta-token-exchange is server-only and must not be imported in client code");
}

export type OktaTokenExchangeRequest = {
  issuerUrl: string;
  authorizationCode: string; // INPUT only — consumed by the exchange, never returned/logged/stored
  pkceVerifier: string; // server-held secret INPUT — never returned/logged/stored
  redirectUri: string;
  clientCredentialReference: string; // a POINTER (0043 credential-reference), NEVER a secret value
  timeoutMs: number;
  signal: AbortSignal;
  correlationId: string; // safe-for-logs id
};

// An opaque, branded handle to a token that a SEPARATE vault-writing boundary persists (envelope-encrypted). It is NOT the token.
// Nothing can read a token out of this type. It is the only token-adjacent value the exchange returns.
export type VaultBoundAccessTokenRef = string & { readonly __brand: "VaultBoundAccessTokenRef" };

export type OktaTokenExchangeSuccess = {
  accessTokenRef: VaultBoundAccessTokenRef; // handle into the vault-writing boundary — NOT a raw token
  grantedScopes: readonly string[];
  tokenType: string; // e.g. "Bearer" — non-secret metadata
  expiresInSeconds: number; // non-secret metadata
  issuer: string; // the Okta org issuer
  providerTenant: string; // the Okta org identifier (issuer/org), non-secret
};

export type OktaTokenExchangeFailureClass =
  | "network" | "timeout" | "aborted" | "invalid_grant" | "invalid_client" | "scope_denied" | "malformed_response" | "unknown";
export type OktaTokenExchangeFailure = { classification: OktaTokenExchangeFailureClass }; // sanitized — never a raw provider body

export type OktaTokenExchangeResult =
  | { ok: true; value: OktaTokenExchangeSuccess }
  | { ok: false; failure: OktaTokenExchangeFailure };

export interface OktaTokenExchange {
  exchange(req: OktaTokenExchangeRequest): Promise<OktaTokenExchangeResult>;
}

export class OktaTokenExchangeNotAvailableError extends Error {
  constructor() {
    super("okta token exchange is not available (certificationOnly; no live exchange is implemented in P5E18a)");
    this.name = "OktaTokenExchangeNotAvailableError";
  }
}

// The DORMANT exchange: the seam exists but is non-functional. Any call fails closed by throwing — it makes NO network request,
// reads NO secret, and returns NO token. A future authorized phase replaces this with the real HTTP + vault-writing implementation.
export function createDormantOktaTokenExchange(): OktaTokenExchange {
  return {
    // A 0-arg impl still satisfies `exchange(req)` — the dormant seam ignores the request and fails closed.
    async exchange(): Promise<OktaTokenExchangeResult> {
      throw new OktaTokenExchangeNotAvailableError();
    },
  };
}
