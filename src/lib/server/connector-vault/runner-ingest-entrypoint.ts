// Server-only TYPED app↔runner SEAM for the hosted connector runner (PR #199). It DEFINES the runner's client-secret
// ingest entrypoint CONTRACT (request / redacted result / safe-error) + a DISABLED fail-closed placeholder. It holds
// ONLY types + a refusing placeholder — NO pg, NO AWS SDK, NO KMS client, NO RunnerConnection, NO real token/secret.
//
// WHY ONLY A SEAM (doc 46 §11, PINNED 2026-06-26): the conforming hosted runner is a SEPARATE DEPLOYABLE in its OWN
// repo (Option A) that VENDORS the committed connector-vault core at a pinned commit (Option B). The app repo STAYS
// PG-FREE — adding `pg` here is NOT authorized, and an in-repo runner would require a new decision replacing §11. So
// this PR ships the typed boundary the separate runner implements, NOT an in-repo runner.
//
// THE FUTURE REAL PATH (in the SEPARATE runner, NOT here): AWS Secrets Manager task-read plaintext (doc 46 §12.2) →
// `ingestClientSecret(input: IngestInput, deps: IngestDeps)` where `deps = { keyProvider: createKmsKeyProvider(...),
// kekId, store: createRunnerAppSecretStore(conn: RunnerConnection) }` → atomic `runSequence([SET ROLE, INSERT])`. The
// plaintext flows ONLY as `IngestInput.plaintext` at the runner boundary; it is NEVER carried by the request below.
//
// SERVER-ONLY: under `src/lib/server/`, the runtime browser sentinel below, and the connector-vault no-client-import +
// no-disk static scans.

import type { IngestDeps, IngestReason } from "./client-secret-ingest-harness";

if (typeof (globalThis as { window?: unknown }).window !== "undefined") {
  throw new Error("server/connector-vault/runner-ingest-entrypoint is server-only and must not be imported in client code");
}

export type RunnerProvider = "slack"; // P0
export type RunnerPurpose = "ingest_client_secret";
export type RunnerSecretKind = "oauth_client_secret";
export type RunnerAppEnv = "staging"; // staging-only (doc 46 §6); production ref is hard-aborted by the real runner

// NON-secret request envelope — aligns with the provider-token request shape but APP-scoped for the client secret. It
// carries NO plaintext: the secret is sourced from Secrets Manager inside the runner, never from this object.
export type RunnerIngestRequest = {
  provider: RunnerProvider;
  tenantId: string;
  connectorId: string;
  purpose: RunnerPurpose;
  secretKind: RunnerSecretKind;
  appEnv: RunnerAppEnv;
  version: number;
};

// REDACTED safe output. `secretId` is the connector_app_secrets row id only. The result NEVER carries a token, client
// secret, ciphertext, wrapped DEK, IV/tag, AAD, KEK material, DB connection string, AWS credentials, or a stack/cause.
export type RunnerIngestReason = IngestReason | "disabled" | "unsupported_provider" | "unsupported_purpose" | "missing_tenant" | "missing_connector";
export type RunnerIngestResult =
  | { ok: true; secretId: string; provider: RunnerProvider }
  | { ok: false; reason: RunnerIngestReason; provider: RunnerProvider };

// The seam the SEPARATE runner implements. The app defines the TYPE; the runner provides the real implementation. The
// real runner passes `deps` (the Secrets-Manager-read keyProvider/kekId/store); the disabled in-app placeholder ignores
// it (deps is optional so the placeholder never has to construct/receive a vault/KMS/store dependency).
export interface RunnerIngestEntrypoint {
  run(request: RunnerIngestRequest, deps?: IngestDeps): Promise<RunnerIngestResult>;
}

const RUNNER_OPT_IN = "ID_CADDIE_RUNNER_INGEST_ENTRYPOINT_ENABLED"; // a FUTURE approved flag — no effect in this app repo.

// Allowlist-shaped, ALWAYS false in this app repo: there is no separate hosted runner deployable, no provisioned/
// verified production KMS-IAM, and no first-real-token (doc 46 §11.4, docs 44/45). `productionRunnerReady` is hardcoded
// false, so even with the opt-in set this returns false. It reads the TRUSTED env map ONLY — a request can never enable
// it. RISK-007 stays OPEN. (Mirrors isVaultProviderTokenSourceEnabled.)
export function isRunnerIngestEntrypointEnabled(env: Record<string, string | undefined> = process.env): boolean {
  const optIn = env[RUNNER_OPT_IN] === "1";
  const productionRunnerReady = false; // no separate runner / verified prod KMS-IAM / first-real-token — never set here
  return optIn && productionRunnerReady;
}

// PURE non-secret request validation (the contract the future runner enforces before any ingest). Returns a SAFE static
// reason or ok; never inspects/echoes a value.
export function validateRunnerIngestRequest(request: RunnerIngestRequest): { ok: true } | { ok: false; reason: RunnerIngestReason } {
  if (!request || request.provider !== "slack") return { ok: false, reason: "unsupported_provider" };
  if (request.purpose !== "ingest_client_secret") return { ok: false, reason: "unsupported_purpose" };
  if (typeof request.tenantId !== "string" || request.tenantId.length === 0) return { ok: false, reason: "missing_tenant" };
  if (typeof request.connectorId !== "string" || request.connectorId.length === 0) return { ok: false, reason: "missing_connector" };
  if (request.appEnv !== "staging") return { ok: false, reason: "invalid_app_env" };
  if (!Number.isInteger(request.version) || request.version < 1) return { ok: false, reason: "invalid_version" };
  return { ok: true };
}

// The IN-REPO placeholder: ALWAYS fails closed. The real entrypoint lives in the SEPARATE runner deployable (doc 46
// §11). `run()` loads NO token, instantiates NO pg/KMS/AWS/RunnerConnection, and logs NO request fields — it returns a
// safe static reason only. (It does not even accept `deps`, so no injected vault/KMS/store is touched here.)
export function createDisabledRunnerIngestEntrypoint(env: Record<string, string | undefined> = process.env): RunnerIngestEntrypoint {
  return {
    async run(request: RunnerIngestRequest): Promise<RunnerIngestResult> {
      const provider: RunnerProvider = "slack";
      if (!isRunnerIngestEntrypointEnabled(env)) return { ok: false, reason: "disabled", provider }; // always, today
      const valid = validateRunnerIngestRequest(request); // dead path today (guard above is always false); forward-correct
      if (!valid.ok) return { ok: false, reason: valid.reason, provider };
      return { ok: false, reason: "disabled", provider }; // no real ingest in the app repo — the runner does the work
    },
  };
}
