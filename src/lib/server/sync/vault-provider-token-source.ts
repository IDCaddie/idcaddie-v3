// Server-only PRODUCTION-SHAPED Slack token source — a TYPED FAIL-CLOSED PLACEHOLDER (Slack production credential path
// foundation, PR #198). It implements the SAME `ProviderTokenSource` seam as the dev source, but loads NO token: every
// `getProviderToken` call throws a generic error. This exists so the env-driven selector has a concrete production-shaped
// source to choose outside local dev (instead of falling back to the dev token), and so the future runner/vault/KMS
// reader is a zero-caller-change swap. It instantiates NOTHING from the vault/runner/KMS/AWS layer.
//
// WHY A PLACEHOLDER (verified, not assumed — docs 42/44/46, RISK-007 OPEN): the real path requires (a) a hosted RUNNER
// deployed SEPARATELY (doc 46 §11 — the app stays pg-free; an in-repo runner is forbidden), (b) production KMS/IAM
// provisioned + verified (doc 44 §0 — currently UNVERIFIED), and (c) the doc 44 §5 first-real-token dry-run (the 17-item
// executed-proof, NOT run). None exist yet, so a real reader cannot be wired without faking it. RISK-007 stays OPEN.
//
// THE FUTURE REAL PATH (documented swap target — NOT coded here; nothing below is imported/instantiated):
//   Slack OAuth callback → token exchange → connector_secrets envelope (KMS-wrapped DEK, doc 42) → the hosted runner
//   reads it via `loadConnectorSecret(capability, { context, store })`, where
//   `capability = acquireRunnerDecryptCapability({ runnerEnv: process.env.CONNECTOR_VAULT_RUNNER, keyProvider })` and
//   `keyProvider = createKmsKeyProvider(createAwsKmsClient(createAwsKmsSdkSenderFromEnv()))`. The decrypted token stays
//   in-memory and is returned ONLY as `{ provider, token }`; ciphertext/key_id/aad never leave the runner.
//
// SERVER-ONLY: under `src/lib/server/`, the runtime browser sentinel below, and the static no-client-import scan.

import { ProviderTokenError, type ProviderToken, type ProviderTokenSource, type VaultProviderTokenSource } from "./provider-token-source";

if (typeof (globalThis as { window?: unknown }).window !== "undefined") {
  throw new Error("server/sync/vault-provider-token-source is server-only and must not be imported in client code");
}

// A FUTURE approved enablement flag (documented only). It is intentionally impossible to satisfy in this PR: there is no
// production-credential-ready state (no hosted runner, no provisioned/verified prod KMS-IAM, no first-real-token), so
// this ALWAYS returns false. Even if it were true, `getProviderToken` still fails closed (there is no reader). A request
// can never set it — it reads the trusted env map only. NOT a denylist.
export function isVaultProviderTokenSourceEnabled(env: Record<string, string | undefined> = process.env): boolean {
  const optIn = env.ID_CADDIE_VAULT_PROVIDER_TOKEN_SOURCE_ENABLED === "1"; // a future approved flag (no effect yet)
  // The provisioned/verified production-credential-ready state (hosted runner + prod KMS/IAM + first-real-token, docs
  // 44/46) does NOT exist in this PR — hardcoded false. So this is always false (even with the opt-in set). RISK-007 OPEN.
  const productionCredentialReady = false;
  return optIn && productionCredentialReady;
}

// The production-shaped source. Fails closed on EVERY call — no token loading, no dev fallback, no fake/mock. The thrown
// error is generic (never a token, env value, request field, or raw cause).
export function createVaultProviderTokenSource(): VaultProviderTokenSource {
  const source: ProviderTokenSource = {
    async getProviderToken(): Promise<ProviderToken> {
      throw new ProviderTokenError(
        "vault provider-token source is not available (production credential path not provisioned — RISK-007 OPEN)",
      );
    },
  };
  return source;
}
