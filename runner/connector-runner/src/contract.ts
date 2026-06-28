// connector-runner — VENDORED typed contract (doc 46 §11.2). This mirrors the committed app seam
// `src/lib/server/connector-vault/runner-ingest-entrypoint.ts` (PR #199). It is SELF-CONTAINED (re-declared, no import
// of app `src/`) so the runner is a structurally separate deployable that does not reach into the app runtime. The
// PRODUCTION runner vendors the connector-vault core BYTE-IDENTICAL at a pinned app-repo commit + a drift check
// (§11.2); this skeleton vendors only the typed contract. NO pg / AWS / KMS / Secrets Manager — types only.

export type RunnerProvider = "slack"; // P0
export type RunnerPurpose = "ingest_client_secret";
export type RunnerSecretKind = "oauth_client_secret";
export type RunnerAppEnv = "staging"; // staging-only (doc 46 §6); production ref is hard-aborted by the real runner

// NON-secret request envelope — carries NO plaintext (the real runner reads the secret from Secrets Manager, never from
// this object). Mirrors the app seam's RunnerIngestRequest.
export type RunnerRequest = {
  provider: RunnerProvider;
  tenantId: string;
  connectorId: string;
  purpose: RunnerPurpose;
  secretKind: RunnerSecretKind;
  appEnv: RunnerAppEnv;
  version: number;
  requestId?: string; // optional safe correlation id (no secret)
};

// REDACTED safe outcome reasons. The app-seam `RunnerIngestReason` set (harness reasons + entrypoint guard reasons) is
// inlined here for self-containment, plus the runner-level `runner_disabled`. A reason NEVER embeds a value.
export type RunnerReason =
  | "runner_disabled"
  | "missing_secret" | "invalid_app_env" | "invalid_version" | "missing_kms_config" | "missing_store" | "ingest_failed"
  | "disabled" | "unsupported_provider" | "unsupported_purpose" | "missing_tenant" | "missing_connector";

// REDACTED safe output — `secretId` is the row id only. NEVER a token, client secret, ciphertext, wrapped DEK, AAD,
// KEK, DB connection string, AWS credentials, or a stack/cause.
export type RunnerResult =
  | { ok: true; secretId: string; provider: RunnerProvider }
  | { ok: false; reason: RunnerReason; provider: RunnerProvider };

// The seam the runner implements (= the app's RunnerIngestEntrypoint). The real runner passes injected deps (the
// Secrets-Manager-read keyProvider/store); the disabled skeleton takes/uses NONE.
export interface ConnectorRunner {
  run(request: RunnerRequest): Promise<RunnerResult>;
}
