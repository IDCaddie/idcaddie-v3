// Phase 8E — the REAL callback runner. Server-only.
//
// `oauth-real-exchange-wiring.ts` assembles the real `OrchestratorDeps` but takes every server-trusted value as a
// parameter. This module is the one place that decides where those values come from, so there is exactly one file to
// review for "what does a real run trust".
//
// It trusts, in order of importance:
//   * the redirect URI   — server config, host-allowlisted (`realConnectorOAuthRedirectUri`)
//   * the workspace      — server config (`expectedSlackTeamId`); unset FAILS, it does not mean "any workspace"
//   * tenant / connector / correlation — server-trusted operator env, the SAME values the authorize half persisted
//     into `oauth_pending` (RUN GATE A, `run-gate-a-authorize.ts`). The atomic consume then re-checks every one of
//     them against the row, so a state that disagrees with what was authorized finds no consumable row.
//   * the subject        — the resolved session, passed in per request (never config)
//
// It trusts NOTHING from the callback query. `state` and `code` are the only request-sourced values in the flow, and
// both are consumed downstream of validation.
//
// FAIL-CLOSED ASSEMBLY: every missing or malformed input returns a reason instead of a runner. There is deliberately
// no default for any of them — a real OAuth run that silently substituted a default for the workspace, the tenant or
// the callback host would be a real credential posted somewhere nobody chose.
//
// SERVER-ONLY: under `src/lib/server/`, the runtime browser sentinel below, and `no-client-import.test.ts`.

import { makeRealOrchestratorDeps } from "./oauth-real-exchange-wiring";
import { orchestrateSlackOAuthCallback, type OrchestratorResult } from "./oauth-callback-orchestrator";
import { realConnectorOAuthRedirectUri, ConnectorOAuthHostError } from "./connector-oauth-config";
import { resolveStagingEnvironmentIdentity, type EnvironmentRefusal } from "./staging-environment-identity";
import type { OAuthStateSigner } from "./oauth-state";
import type { OAuthPendingConsumer } from "./oauth-pending-consume";
import type { SlackHttpClient } from "./slack-oauth-exchange";
import type { ConnectorVaultKeyProvider } from "./crypto";
import type { AppSecretEnvelopeStore } from "./slack-client-secret-store";
import type { StagingConnectorSecretIngestDeps } from "./connector-secret-ingest";

// Runtime server-only sentinel — throw if evaluated in a browser.
if (typeof (globalThis as { window?: unknown }).window !== "undefined") {
  throw new Error("connector-vault/oauth-callback-real-runner is server-only and must not be imported in client code");
}


// SAFE STATIC assembly reasons — a bounded set, never an env value, host, id or exception text. The environment ones
// are re-exported from the identity gate so a caller has ONE vocabulary to render, not two.
export type RealRunnerReason = EnvironmentRefusal | "callback_host_not_allowlisted";

export type RealRunnerBuild =
  | { ok: true; run: (input: { state?: string; code?: string; subject: string }) => Promise<OrchestratorResult> }
  | { ok: false; reason: RealRunnerReason };

export type RealRunnerDeps = {
  signer: OAuthStateSigner;
  pendingConsumer: OAuthPendingConsumer;
  httpClient: SlackHttpClient;
  keyProvider: ConnectorVaultKeyProvider;
  appSecretStore: AppSecretEnvelopeStore;
  ingestDeps: StagingConnectorSecretIngestDeps;
  now?: () => number;
};


// Build the real callback runner from server-trusted config, or refuse with a bounded reason.
export function buildRealCallbackRunner(
  deps: RealRunnerDeps,
  env: Record<string, string | undefined> = process.env,
): RealRunnerBuild {
  // 1) ENVIRONMENT IDENTITY — the whole gate, in one place. Every fact must be present and match: the staging marker,
  //    the Vercel project, the Supabase project, the absence of the production ref anywhere, the narrow
  //    `oauth_completer` identity, the exact callback, the opt-in, the workspace and the trusted context.
  const identity = resolveStagingEnvironmentIdentity(env);
  if (!identity.ok) return { ok: false, reason: identity.reason };

  // 2) The callback allowlist, re-asserted independently of the environment gate. The gate compares against a pinned
  //    constant and this compares against the shipped allowlist; they have to agree, and if they ever stop agreeing
  //    that is a bug worth failing on rather than silently preferring one of them.
  let redirectUri: string;
  try {
    redirectUri = realConnectorOAuthRedirectUri(env);
  } catch (e) {
    return { ok: false, reason: e instanceof ConnectorOAuthHostError ? "callback_host_not_allowlisted" : "callback_uri_mismatch" };
  }
  if (redirectUri !== identity.callbackUri) return { ok: false, reason: "callback_uri_mismatch" };

  const { tenantId, connectorId, correlationId, expectedTeamId, clientId } = identity;
  const now = deps.now ?? (() => Date.now());
  const appEnv = env.APP_ENV ?? "staging";

  return {
    ok: true,
    run: async ({ state, code, subject }) =>
      orchestrateSlackOAuthCallback(
        { state, code },
        {
          ...makeRealOrchestratorDeps({
            env,
            // The subject is the RESOLVED SESSION's, per request — the one field here that is not config.
            expectedContext: { tenantId, connectorId, provider: "slack", subject, redirectIntent: "connect", redirectUri, correlationId },
            signer: deps.signer,
            now: now(),
            pendingConsumer: deps.pendingConsumer,
            httpClient: deps.httpClient,
            clientId,
            clientSecretIdentity: { appEnv },
            clientSecretDeps: { keyProvider: deps.keyProvider, store: deps.appSecretStore },
            ingestDeps: deps.ingestDeps,
            version: 1,
          }),
          expectedTeamId,
        },
      ),
  };
}
