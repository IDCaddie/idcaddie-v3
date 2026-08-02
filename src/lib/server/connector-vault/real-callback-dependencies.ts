// Phase 8F — construction of the REAL callback's dependencies. Server-only.
//
// `buildRealCallbackRunner` takes every dependency as a parameter, which is what makes it testable. This module is the
// one place that turns environment configuration into those concrete objects, so there is exactly one file to review
// for "what does the web tier actually connect to".
//
// It is deliberately separate from the environment gate: the gate decides WHETHER, this decides WITH WHAT. Both fail
// closed, and neither ever falls back to the synthetic path — that decision belongs to the route, and the route refuses.
//
// The database identity is `oauth_completer` and nothing else (docs/83). The runner's own login is never constructed
// here, and the environment gate refuses outright if that credential is present anywhere in this tier.
//
// SERVER-ONLY: under `src/lib/server/`, the runtime browser sentinel below, and `no-client-import.test.ts`.

import { buildRealCallbackRunner, type RealRunnerBuild } from "./oauth-callback-real-runner";
import { resolveStagingEnvironmentIdentity } from "./staging-environment-identity";
import { createHmacStateSigner } from "./oauth-state";
import { makeSlackHttpClient } from "./slack-http-client";

if (typeof (globalThis as { window?: unknown }).window !== "undefined") {
  throw new Error("connector-vault/real-callback-dependencies is server-only and must not be imported in client code");
}

// Reasons this module can add on top of the environment gate's own. Bounded; never a value.
export type DependencyRefusal =
  | "state_secret_missing"
  | "kms_configuration_missing"
  | "dependency_construction_failed";

export type RealRunnerFromEnvironment = RealRunnerBuild | { ok: false; reason: DependencyRefusal };

/**
 * Build the real callback runner from the current environment, or refuse with a bounded reason.
 *
 * The environment gate runs FIRST and is authoritative: if this is not the pinned staging environment, nothing is
 * constructed, no connection is opened and no KMS client is created.
 */
export function buildRealCallbackRunnerFromEnvironment(
  env: Record<string, string | undefined> = process.env,
): RealRunnerFromEnvironment {
  const identity = resolveStagingEnvironmentIdentity(env);
  if (!identity.ok) return { ok: false, reason: identity.reason };

  // The state HMAC key. No fallback — a real flow signed with a placeholder key is a real flow anyone can forge.
  const stateSecret = env.CONNECTOR_OAUTH_STATE_SECRET;
  if (typeof stateSecret !== "string" || stateSecret.length === 0) return { ok: false, reason: "state_secret_missing" };
  const keyId = env.CONNECTOR_OAUTH_STATE_KEY_ID;
  if (typeof keyId !== "string" || keyId.length === 0) return { ok: false, reason: "state_secret_missing" };

  // KMS is required for both halves of the flow: decrypt the app client secret, encrypt the returned bot token.
  // Absence is a refusal rather than a plaintext path.
  if (typeof env.CONNECTOR_VAULT_KEK_ID !== "string" || env.CONNECTOR_VAULT_KEK_ID.length === 0) {
    return { ok: false, reason: "kms_configuration_missing" };
  }

  try {
    const signer = createHmacStateSigner(stateSecret, keyId);
    const httpClient = makeSlackHttpClient();

    // The narrow `oauth_completer` connection and the KMS-backed providers are assembled by the vault's own factories
    // against OAUTH_COMPLETER_DB_URL. They are required to exist; if any throws, the whole build refuses rather than
    // returning a partially-wired runner.
    const wiring = requireCompleterWiring(env);

    return buildRealCallbackRunner(
      {
        signer,
        httpClient,
        pendingConsumer: wiring.pendingConsumer,
        keyProvider: wiring.keyProvider,
        appSecretStore: wiring.appSecretStore,
        ingestDeps: wiring.ingestDeps,
      },
      env,
    );
  } catch {
    // The original error is deliberately dropped: connection and KMS errors embed hosts, ARNs and sometimes
    // credentials, and this value reaches a redirect.
    return { ok: false, reason: "dependency_construction_failed" };
  }
}

// The concrete `oauth_completer`-scoped wiring. Split out so the seam is explicit and reviewable in one place, and so
// the failure mode is a throw that the caller converts into a bounded reason.
type CompleterWiring = {
  pendingConsumer: Parameters<typeof buildRealCallbackRunner>[0]["pendingConsumer"];
  keyProvider: Parameters<typeof buildRealCallbackRunner>[0]["keyProvider"];
  appSecretStore: Parameters<typeof buildRealCallbackRunner>[0]["appSecretStore"];
  ingestDeps: Parameters<typeof buildRealCallbackRunner>[0]["ingestDeps"];
};

function requireCompleterWiring(_env: Record<string, string | undefined>): CompleterWiring {
  // NOT YET IMPLEMENTED, and deliberately a throw rather than a stub that returns something.
  //
  // The `oauth_completer` role does not exist in the database yet — docs/83 §3.1 specifies it and it has not been
  // applied. Returning a placeholder here would make `buildRealCallbackRunner` succeed and the route report a real
  // connection that cannot possibly work; throwing makes the route refuse with `dependency_construction_failed`,
  // which is the truthful answer until the role and its grants are provisioned.
  //
  // When §3.1 has been applied, this becomes: open a RunnerConnection over OAUTH_COMPLETER_DB_URL with an SQL
  // allowlist of exactly the three permitted functions, then createRunnerOAuthPendingConsumer / createRunnerAppSecretStore
  // over it, plus createKmsKeyProvider for the two keys.
  throw new Error("oauth_completer_wiring_not_provisioned");
}
