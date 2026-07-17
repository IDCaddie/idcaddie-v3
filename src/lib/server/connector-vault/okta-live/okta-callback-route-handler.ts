// P5E18b — the PROVIDER-SELECTING Okta OAuth callback route HANDLER (Phase 8). Server-only, testable. It runs the ordered
// callback gates (evaluateOktaCallback) and invokes the dormant token-exchange adapter ONLY when ALL gates permit — which they
// never do in the current environment because Okta is certificationOnly + governance is blocked. It NEVER displays or logs the
// authorization code, NEVER redirects to an arbitrary destination (fixed customer-safe success/failure paths only), and stops
// before exchange today. An extra environment gate (isOktaCallbackEnabled) keeps it OFF by default and in production.
//
// It is deliberately a SEPARATE handler from the shared Slack callback (which is Slack-wired) and serves a dedicated Okta path.
// SERVER-ONLY: under src/lib/server/, the runtime browser sentinel below, and no-client-import.test.ts.

import { evaluateOktaCallback, type OktaCallbackTransaction } from "./okta-callback-foundation";
import { OKTA_PROVIDER_ID, OKTA_LIFECYCLE, type OktaProviderLifecycle } from "./okta-provider-contract";
import { OKTA_GOVERNANCE, type OktaGovernanceState } from "./okta-governance-gate";
import type { OAuthStateSigner } from "../oauth-state";
import type { OktaTokenExchange } from "./okta-token-exchange";

// Runtime server-only sentinel — throw if evaluated in a browser.
if (typeof (globalThis as { window?: unknown }).window !== "undefined") {
  throw new Error("connector-vault/okta-live/okta-callback-route-handler is server-only and must not be imported in client code");
}

export const OKTA_CALLBACK_PATH = "/connectors/oauth/okta/callback" as const;
// Fixed, customer-safe destinations (same-site absolute paths — never an arbitrary/provider destination).
export const OKTA_CALLBACK_SUCCESS_PATH = "/connectors/okta/status" as const;
export const OKTA_CALLBACK_FAILURE_PATH = "/connectors/okta?connection=unavailable" as const;

// The dormant environment gate — OFF by default, OFF in production, requires an explicit non-production opt-in. An independent
// block on top of certificationOnly + governance.
export function isOktaCallbackEnabled(env: Record<string, string | undefined> = process.env): boolean {
  if (env.VERCEL_ENV === "production" || env.NODE_ENV === "production") return false;
  return env.CONNECTOR_OKTA_CALLBACK_ENABLED === "1";
}

export type OktaCallbackHandlerDeps = {
  enabled: boolean;
  signer: OAuthStateSigner | null;
  now: number;
  resolveSession: () => Promise<{ subject: string | null; tenantId: string | null; organizationId: string | null } | null>;
  serverTrustedRedirectUri: string;
  // Production looks the transaction up by the (signature-verified) correlation; the DORMANT wiring has no store → returns null.
  lookupTransaction: (rawState: string | null) => Promise<OktaCallbackTransaction | null>;
  pkceVerifierAvailable: (correlationId: string) => Promise<boolean>;
  exchangeAdapter: OktaTokenExchange; // wired, but NEVER invoked under current gates
  lifecycle?: OktaProviderLifecycle; // defaults to the pinned certificationOnly
  governance?: OktaGovernanceState; // defaults to the pinned blocked state
  onExchangeInvoked?: () => void; // test observability hook
};

const redirect = (path: string): Response => new Response(null, { status: 303, headers: { location: path } });

// Handle an Okta OAuth callback request. Returns a Response that redirects to a FIXED customer-safe path. Never echoes code/error.
export async function handleOktaOAuthCallback(request: Request, deps: OktaCallbackHandlerDeps): Promise<Response> {
  if (!deps.enabled) return redirect(OKTA_CALLBACK_FAILURE_PATH); // route not available in this environment
  const url = new URL(request.url);
  const query = url.searchParams;
  const session = await deps.resolveSession();
  const transaction = await deps.lookupTransaction(query.get("state"));
  const pkceAvailable = transaction ? await deps.pkceVerifierAvailable(transaction.correlationId) : false;

  const result = evaluateOktaCallback(
    {
      callbackPath: url.pathname,
      expectedProvider: OKTA_PROVIDER_ID,
      query,
      session,
      serverTrustedRedirectUri: deps.serverTrustedRedirectUri,
      expectedIssuerUrl: transaction?.issuerUrl ?? "",
      transaction,
      pkceVerifierAvailable: pkceAvailable,
    },
    { signer: deps.signer, now: deps.now, lifecycle: deps.lifecycle ?? OKTA_LIFECYCLE, governance: deps.governance ?? OKTA_GOVERNANCE },
  );

  if (result.status === "validated_no_exchange") {
    // ALL gates permitted. This branch is UNREACHABLE under the pinned certificationOnly lifecycle + blocked governance. Only here
    // would the token exchange run — and it stays dormant in P5E18b. The exchange result/token is never placed in the response.
    deps.onExchangeInvoked?.();
    await deps.exchangeAdapter.exchange({
      issuerUrl: transaction!.issuerUrl,
      authorizationCode: query.get("code") ?? "",
      pkceVerifier: "", // supplied by the transient PKCE store in a real flow
      redirectUri: deps.serverTrustedRedirectUri,
      clientCredentialReference: "",
      timeoutMs: 8000,
      signal: new AbortController().signal,
      correlationId: transaction!.correlationId,
    });
    return redirect(OKTA_CALLBACK_SUCCESS_PATH);
  }
  // Any blocked/provider_error → a fixed customer-safe failure destination. No code/error value is surfaced.
  return redirect(OKTA_CALLBACK_FAILURE_PATH);
}
