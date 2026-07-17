import { getSessionUser } from "@/lib/auth/session";
import { createHmacStateSigner } from "@/lib/server/connector-vault/oauth-state";
import { createDormantOktaTokenExchange } from "@/lib/server/connector-vault/okta-live/okta-token-exchange";
import {
  handleOktaOAuthCallback,
  isOktaCallbackEnabled,
} from "@/lib/server/connector-vault/okta-live/okta-callback-route-handler";

// P5E18b — the dedicated, PROVIDER-SELECTING Okta OAuth callback route (Phase 8). Fully ISOLATED from the shared Slack callback
// (its own path `/connectors/oauth/okta/callback`). It runs the ordered Okta callback gates and STOPS before token exchange while
// Okta is certificationOnly + governance is blocked — the wired exchange adapter is the DORMANT (throwing) one and is never
// invoked under the current gates. It makes NO real Okta call, handles NO token/code value, and redirects only to a fixed
// customer-safe destination. It is OFF by default and OFF in production (isOktaCallbackEnabled).

// The server-trusted exact Okta callback URL (NON-secret; the Okta app must register THIS verbatim). Server config only — NEVER
// request-derived. No trailing slash.
const OKTA_REDIRECT_URI =
  process.env.CONNECTOR_OKTA_REDIRECT_URI ?? "https://idcaddie-v3.vercel.app/connectors/oauth/okta/callback";

async function handle(request: Request) {
  const signer = createHmacStateSigner(
    process.env.CONNECTOR_OAUTH_STATE_SECRET ?? "SYNTHETIC-staging-only-state-secret-not-real",
    process.env.CONNECTOR_OAUTH_STATE_KEY_ID ?? "synthetic",
  );
  return handleOktaOAuthCallback(request, {
    enabled: isOktaCallbackEnabled(),
    signer,
    now: Date.now(),
    // Identity only; tenant/org are resolved server-side in a real flow. Dormant: no transaction is ever found, so the callback
    // fails closed (invalid_state / transaction_not_found) before the exchange gate is ever reached.
    resolveSession: async () => {
      const u = await getSessionUser();
      return { subject: u?.id ?? null, tenantId: null, organizationId: null };
    },
    serverTrustedRedirectUri: OKTA_REDIRECT_URI,
    // DORMANT: there is no persisted Okta transaction (nothing was initiated), so the lookup returns null and the callback fails
    // closed. A future authorized phase wires the oauth_pending-backed store.
    lookupTransaction: async () => null,
    pkceVerifierAvailable: async () => false,
    exchangeAdapter: createDormantOktaTokenExchange(), // throws if ever called — but the gates never reach it today
  });
}

export const GET = handle;
export const POST = handle;
