import { getSessionUser } from "@/lib/auth/session";
import { createHmacStateSigner } from "@/lib/server/connector-vault/oauth-state";
import {
  handleSyntheticSlackOAuthCallback,
  isSyntheticCallbackEnabled,
  makeSyntheticOrchestratorRunner,
} from "@/lib/server/connector-vault/oauth-callback-route-handler";

// PRODUCTION-SHAPED but SYNTHETIC Slack OAuth callback route (PR B2c-route — docs/42 §90). This is the request-path
// SHAPE (guard → explicit session resolution → B2c-wire orchestrator → safe/static response), wired with FULLY
// SYNTHETIC/MOCKED dependencies. It is PRODUCTION-DISABLED (`isSyntheticCallbackEnabled` is false in production and
// without the explicit staging opt-in) and makes NO real Slack call, handles NO real token, uses NO real client
// secret, and does NOT touch the B2c-secret client-secret decrypt boundary. The real exchange + the first real-token
// event are B2c-run (future, explicitly authorized). NOT production OAuth.

// Synthetic signer + server-trusted expected context (synthetic placeholders in B2c-route; in B2c-run these come from
// the oauth_pending lookup + server config). The state secret is read from a server-only env (with a clearly-
// synthetic fallback used only in the staging-synthetic, production-disabled path) — never exposed to the browser.
function syntheticRunner() {
  const signer = createHmacStateSigner(
    process.env.CONNECTOR_OAUTH_STATE_SECRET ?? "SYNTHETIC-staging-only-state-secret-not-real",
    process.env.CONNECTOR_OAUTH_STATE_KEY_ID ?? "synthetic",
  );
  return makeSyntheticOrchestratorRunner({
    signer,
    expected: {
      tenantId: "11111111-1111-1111-1111-111111111111",
      connectorId: "17000000-0000-0000-0000-0000000000a1",
      provider: "slack",
      redirectUri: "https://app.example.com/connectors/oauth/callback",
      correlationId: "corr-b2c-route-synthetic",
    },
    now: () => Date.now(),
  });
}

async function handle(request: Request) {
  return handleSyntheticSlackOAuthCallback(request, {
    enabled: isSyntheticCallbackEnabled(),
    // Explicit session resolution (no layout auth): the validated server-side user id, or null.
    resolveSubject: async () => (await getSessionUser())?.id ?? null,
    runOrchestrator: syntheticRunner(),
  });
}

export const GET = handle;
export const POST = handle;
