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

import { makeRealOrchestratorDeps, isRealExchangeEnabled } from "./oauth-real-exchange-wiring";
import { orchestrateSlackOAuthCallback, type OrchestratorResult } from "./oauth-callback-orchestrator";
import { realConnectorOAuthRedirectUri, expectedSlackTeamId, ConnectorOAuthHostError } from "./connector-oauth-config";
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

const PRODUCTION_REF = "dzbfxulvxchdemcettrx"; // must NEVER appear in a real-run input

// SAFE STATIC assembly reasons — a bounded set, never an env value, host, id or exception text.
export type RealRunnerReason =
  | "real_exchange_disabled"
  | "callback_host_not_allowlisted"
  | "missing_expected_workspace"
  | "missing_expected_context"
  | "missing_client_id"
  | "production_ref";

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

const nonEmpty = (v: unknown): v is string => typeof v === "string" && v.length > 0;

// Build the real callback runner from server-trusted config, or refuse with a bounded reason.
export function buildRealCallbackRunner(
  deps: RealRunnerDeps,
  env: Record<string, string | undefined> = process.env,
): RealRunnerBuild {
  // 1) The gate. Non-production AND an explicit opt-in — checked here as well as inside makeRealOrchestratorDeps,
  //    because this function's caller uses the answer to decide whether to serve the route at all.
  if (!isRealExchangeEnabled(env)) return { ok: false, reason: "real_exchange_disabled" };

  // 2) The callback host. Throws rather than falling back, so a real run cannot retarget its own callback.
  let redirectUri: string;
  try {
    redirectUri = realConnectorOAuthRedirectUri(env);
  } catch (e) {
    return { ok: false, reason: e instanceof ConnectorOAuthHostError ? "callback_host_not_allowlisted" : "missing_expected_context" };
  }

  // 3) The workspace. Unset is a refusal, not a wildcard.
  const expectedTeamId = expectedSlackTeamId(env);
  if (expectedTeamId === null) return { ok: false, reason: "missing_expected_workspace" };

  // 4) The operator-supplied expected context — the same triple RUN GATE A wrote into oauth_pending.
  const tenantId = env.CONNECTOR_OAUTH_EXPECTED_TENANT_ID;
  const connectorId = env.CONNECTOR_OAUTH_EXPECTED_CONNECTOR_ID;
  const correlationId = env.CONNECTOR_OAUTH_EXPECTED_CORRELATION_ID;
  if (!nonEmpty(tenantId) || !nonEmpty(connectorId) || !nonEmpty(correlationId))
    return { ok: false, reason: "missing_expected_context" };

  const clientId = env.SLACK_CLIENT_ID;
  if (!nonEmpty(clientId)) return { ok: false, reason: "missing_client_id" };

  // 5) Production must never be reachable from a real-run input, whatever the flag says.
  if ([redirectUri, tenantId, connectorId, correlationId, expectedTeamId].some((v) => v.includes(PRODUCTION_REF)))
    return { ok: false, reason: "production_ref" };

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
