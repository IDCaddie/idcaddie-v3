// Phase 8K — construction of the REAL callback's dependencies. Server-only.
//
// One file to review for "what does the web tier actually reach". After the doc 83 §2 correction the answer is short:
// ONE outbound HTTPS request to the completion worker, authenticated by a Vercel OIDC assertion, carrying an
// authorization code sealed to a public key. No database connection is opened. No KMS client is constructed. No Slack
// endpoint is contacted. The previous version of this file was going to build all three, and could not — the boundary
// check caught it, which is why the architecture changed rather than the check.
//
// It is deliberately separate from the environment gate: the gate decides WHETHER, this decides WITH WHAT. Both fail
// closed, and neither ever falls back to the synthetic path — that decision belongs to the route, and the route refuses.
//
// SERVER-ONLY: under `src/lib/server/`, the runtime browser sentinel below, and `no-client-import.test.ts`.

import { createHmacStateSigner } from "./oauth-state";
import { makeHandoffCallbackRunner, type HandoffCallbackRunner } from "./oauth-callback-handoff";
import {
  WORKER_ALLOWED_HOSTS,
  readVercelOidcAssertion,
  resolveWorkerHandoffConfig,
  type WorkerConfigRefusal,
} from "./oauth-handoff-client";
import { resolveStagingEnvironmentIdentity, type EnvironmentRefusal } from "./staging-environment-identity";

if (typeof (globalThis as { window?: unknown }).window !== "undefined") {
  throw new Error("connector-vault/real-callback-dependencies is server-only and must not be imported in client code");
}

/** Reasons this module can add on top of the environment gate's and the worker config's. Bounded; never a value. */
export type DependencyRefusal = "state_secret_missing" | "dependency_construction_failed";

export type RealCallbackBuild =
  | { ok: true; run: HandoffCallbackRunner }
  | { ok: false; reason: EnvironmentRefusal | WorkerConfigRefusal | DependencyRefusal };

/**
 * Build the real callback runner from the current environment, or refuse with a bounded reason.
 *
 * The environment gate runs FIRST and is authoritative: if this is not the pinned staging environment, no worker
 * configuration is read, no key is parsed and no assertion is touched.
 */
export function buildRealCallbackRunnerFromEnvironment(
  env: Record<string, string | undefined> = process.env,
  fetchImpl: typeof fetch = fetch,
  // The worker-host allowlist, defaulted to the code constant. It is a PARAMETER only so a test can prove the assembled
  // runner works against a fixture host; it is not readable from the environment, so no deployment can widen it.
  allowedHosts: readonly string[] = WORKER_ALLOWED_HOSTS,
): RealCallbackBuild {
  const identity = resolveStagingEnvironmentIdentity(env);
  if (!identity.ok) return { ok: false, reason: identity.reason };

  // The state HMAC key. No fallback — a real flow signed with a placeholder key is a real flow anyone can forge.
  const stateSecret = env.CONNECTOR_OAUTH_STATE_SECRET;
  const keyId = env.CONNECTOR_OAUTH_STATE_KEY_ID;
  if (typeof stateSecret !== "string" || stateSecret.length === 0) return { ok: false, reason: "state_secret_missing" };
  if (typeof keyId !== "string" || keyId.length === 0) return { ok: false, reason: "state_secret_missing" };

  const worker = resolveWorkerHandoffConfig(env, allowedHosts);
  if (!worker.ok) return { ok: false, reason: worker.reason };

  try {
    return {
      ok: true,
      run: makeHandoffCallbackRunner({
        signer: createHmacStateSigner(stateSecret, keyId),
        expected: {
          tenantId: identity.tenantId,
          connectorId: identity.connectorId,
          correlationId: identity.correlationId,
          expectedTeamId: identity.expectedTeamId,
          redirectUri: identity.callbackUri,
        },
        config: worker.config,
        readAssertion: () => readVercelOidcAssertion(env),
        fetchImpl: (input, init) => fetchImpl(input, init),
        now: () => Date.now(),
      }),
    };
  } catch {
    // The original error is dropped: construction errors embed configured values, and this reason reaches a redirect.
    return { ok: false, reason: "dependency_construction_failed" };
  }
}
