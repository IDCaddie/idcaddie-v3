// connector-runner — VENDORED typed seam for the LIVE task-read → ingest composition (doc 46 §4/§12.5/§12.6). It ties
// the task-read (`TaskSecretReader`) to the connector-vault ingest into ONE fail-closed unit for the future ECS/Fargate
// one-shot task. It is a SKELETON: self-contained (no app-`src/` import), imports NOTHING at runtime (NO AWS SDK, NO
// Secrets Manager client, NO pg) — the API name "GetSecretValue" appears here only in COMMENTS. The REAL implementation
// (Secrets Manager GetSecretValue + the committed connector-vault core + a `connector_runner_login` connection) lives in
// the SEPARATE runner deployable (doc 46 §11), never in this app repo.
//
// THE LIVE FLOW (in the separate runner, NOT here): the task role calls Secrets Manager GetSecretValue on ONLY the pinned
// ARN → the plaintext is read INTO MEMORY → handed to `consume(plaintext)` in-scope → `consume` passes it STRAIGHT to
// `ingestClientSecret({ plaintext, appEnv:"staging", version:1 }, deps)` → the committed core encrypts it (KMS
// GenerateDataKey + AES-256-GCM) and writes an **envelope-only** row → the plaintext is discarded. It is NEVER logged,
// NEVER written to disk, NEVER in env/argv, NEVER in the task env dump; the returned result carries only a redacted vault
// row id or a safe static reason.
//
// LEAK-PROOF BY CONSTRUCTION: the plaintext exists ONLY inside the `consume` callback's scope (→ ingest → discarded). It
// is NEVER a field of any returned type, never assigned to an outer var, never printed. `composeTaskReadIngest` below is
// the reference orchestration the real runner drops in; the disabled placeholder reads/ingests NOTHING.

import type { TaskSecretReader, TaskSecretReadRequest, TaskSecretReadReason } from "./task-secret-read";

export type TaskReadProvider = "slack";

// self-declared ingest contract mirroring the committed core's IngestInput/IngestResult — the REAL runner supplies an
// `ingest` that wraps `ingestClientSecret(...)`. NOT imported from app `src/` (self-contained per §11.2).
export type RunnerIngestInput = { plaintext: string; appEnv: "staging"; version: number };
export type RunnerIngestResult = { ok: true; secretId: string } | { ok: false; reason: string };
export type RunnerIngestFn = (input: RunnerIngestInput) => Promise<RunnerIngestResult>;

// REDACTED outcome — a non-secret vault row id (`secretId`) or a safe static reason. NEVER the secret value / plaintext /
// ciphertext / ARN / KMS material / stack.
export type TaskReadIngestReason = TaskSecretReadReason | "ingest_failed";
export type TaskReadIngestResult =
  | { ok: true; provider: TaskReadProvider; secretId: string }
  | { ok: false; provider: TaskReadProvider; reason: TaskReadIngestReason };

// The one-shot seam the SEPARATE runner implements: read the pinned secret, ingest it, return a redacted outcome.
export interface TaskReadIngest {
  run(request: TaskSecretReadRequest): Promise<TaskReadIngestResult>;
}

const TASK_READ_INGEST_OPT_IN = "ID_CADDIE_CONNECTOR_RUNNER_TASK_READ_INGEST_ENABLED"; // a FUTURE approved flag — no effect here.

// ALLOWLIST-shaped, ALWAYS false in this skeleton: no separate runner deployable, no real SDK, no provisioned live path.
// The operator-run guard — reads the trusted env map ONLY; a request can never enable it. RISK-007 stays OPEN.
export function isTaskReadIngestEnabled(env: Record<string, string | undefined> = process.env): boolean {
  const optIn = env[TASK_READ_INGEST_OPT_IN] === "1";
  const productionRunnerReady = false; // no separate runner deployable / real SDK / provisioned live task-read
  return optIn && productionRunnerReady;
}

// The fail-closed placeholder: ALWAYS fails closed. It reads NO secret, ingests NOTHING, touches NO AWS/pg.
export function createDisabledTaskReadIngest(env: Record<string, string | undefined> = process.env): TaskReadIngest {
  return {
    async run(_request: TaskSecretReadRequest): Promise<TaskReadIngestResult> {
      void _request;
      const provider: TaskReadProvider = "slack";
      if (!isTaskReadIngestEnabled(env)) return { ok: false, provider, reason: "task_read_disabled" }; // always, today
      return { ok: false, provider, reason: "task_read_disabled" }; // no live read/ingest in the skeleton
    },
  };
}

// The reference orchestration the SEPARATE runner drops in: it wires an injected `reader` (which GetSecretValue-s the
// pinned secret) to an injected `ingest` (which wraps `ingestClientSecret`). The plaintext is delivered ONLY via the
// `consume` callback → `ingest`, in-scope; it is never returned, stored, or logged. (In this repo the only `reader` is
// the disabled placeholder, which never reads — so composing it is inert; tests exercise it with in-memory mocks.)
export function composeTaskReadIngest(reader: TaskSecretReader, ingest: RunnerIngestFn): TaskReadIngest {
  return {
    async run(request: TaskSecretReadRequest): Promise<TaskReadIngestResult> {
      const provider: TaskReadProvider = "slack";
      let ingestResult: RunnerIngestResult | undefined;
      const read = await reader.read(request, async (plaintext) => {
        // plaintext lives ONLY in this scope → straight to ingest → discarded. Never assigned outward / logged / returned.
        ingestResult = await ingest({ plaintext, appEnv: "staging", version: 1 });
      });
      if (!read.ok) return { ok: false, provider, reason: read.reason };
      if (!ingestResult || !ingestResult.ok) return { ok: false, provider, reason: "ingest_failed" };
      return { ok: true, provider, secretId: ingestResult.secretId };
    },
  };
}
