import { getSessionUser } from "@/lib/auth/session";
import { createHmacStateSigner } from "@/lib/server/connector-vault/oauth-state";
import { connectorOAuthRedirectUri } from "@/lib/server/connector-vault/connector-oauth-config";
import {
  handleSyntheticSlackOAuthCallback,
  isSyntheticCallbackEnabled,
  makeSyntheticOrchestratorRunner,
} from "@/lib/server/connector-vault/oauth-callback-route-handler";
import { resolveStagingEnvironmentIdentity } from "@/lib/server/connector-vault/staging-environment-identity";
import { buildRealCallbackRunnerFromEnvironment } from "@/lib/server/connector-vault/real-callback-dependencies";

// The Slack OAuth callback.
//
// MODE SELECTION, and the rule that matters: when the environment-identity gate says this is the pinned staging
// environment with real mode enabled, this route is REAL and there is NO fallback to the synthetic handler. A silent
// fallback would be the worst failure this file could have — the customer completes a Slack consent screen, gets a
// success page, and has connected nothing. An unavailable real path returns an error; it never quietly pretends.
//
// The synthetic handler remains for local and unprovisioned environments, where it is reached only because the real
// gate refused on identity grounds — never as a rescue after a real attempt failed.

function syntheticRunner() {
  const signer = createHmacStateSigner(
    process.env.CONNECTOR_OAUTH_STATE_SECRET ?? "PLACEHOLDER-staging-only-state-secret-not-real",
    process.env.CONNECTOR_OAUTH_STATE_KEY_ID ?? "placeholder",
  );
  return makeSyntheticOrchestratorRunner({
    signer,
    expected: {
      tenantId: "11111111-1111-1111-1111-111111111111",
      connectorId: "17000000-0000-0000-0000-0000000000a1",
      provider: "slack",
      redirectUri: connectorOAuthRedirectUri(),
      correlationId: "corr-placeholder",
    },
    now: () => Date.now(),
  });
}

// A safe, static redirect carrying only a coarse outcome. `reason` is one of the bounded refusal codes — never an env
// value, connection string, host, token, code or exception text.
function refuse(reason: string): Response {
  return new Response(null, {
    status: 303,
    headers: { location: `/connectors?oauth=error&reason=${encodeURIComponent(reason)}`, "cache-control": "no-store" },
  });
}

async function handle(request: Request) {
  const identity = resolveStagingEnvironmentIdentity();

  // ── REAL MODE ────────────────────────────────────────────────────────────────────────────────────────────────
  if (identity.ok) {
    const built = buildRealCallbackRunnerFromEnvironment();
    // The real path could not be assembled. Refuse — do NOT fall through to the synthetic handler.
    if (!built.ok) return refuse(built.reason);

    return handleSyntheticSlackOAuthCallback(request, {
      // The handler is mode-agnostic transport (guard → session → parse → orchestrate → safe response). It is named
      // for the mode it was written for; the runner it is handed is what decides whether anything is synthetic.
      enabled: true,
      resolveSubject: async () => (await getSessionUser())?.id ?? null,
      runOrchestrator: built.run,
    });
  }

  // ── NOT THE PINNED STAGING ENVIRONMENT ───────────────────────────────────────────────────────────────────────
  // Real mode is off on identity grounds. The synthetic handler is production-disabled and opt-in on its own terms.
  return handleSyntheticSlackOAuthCallback(request, {
    enabled: isSyntheticCallbackEnabled(),
    resolveSubject: async () => (await getSessionUser())?.id ?? null,
    runOrchestrator: syntheticRunner(),
  });
}

export const GET = handle;
export const POST = handle;
