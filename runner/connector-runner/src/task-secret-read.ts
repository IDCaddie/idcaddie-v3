// connector-runner — VENDORED typed TASK-READ seam for the future ECS/Fargate Model B task-read (doc 46 §12.5). It is a
// FAIL-CLOSED SKELETON: it defines the typed boundary the real runner will implement and a disabled placeholder that
// NEVER reads a secret. It is SELF-CONTAINED (no app-`src/` import) and imports NOTHING — NO AWS SDK, NO Secrets Manager
// client. The API name "GetSecretValue" appears here only in COMMENTS describing the future path; nothing is invoked.
//
// THE FUTURE REAL PATH (in the SEPARATE runner deployable, NOT here): the task role calls Secrets Manager GetSecretValue
// on ONLY the pinned ARN, reads the plaintext INTO MEMORY, hands it to the `consume` callback (which passes it straight
// to `ingestClientSecret(...)`), and discards it — never logged, never written to disk, never in the task env dump
// (§12.5). Least-privilege IAM (§12.7): GetSecretValue on only that ARN; web/request identity denied.
//
// LEAK-PROOF BY CONSTRUCTION: the plaintext is delivered ONLY via `consume(plaintext)` in the reader's own scope; it is
// NEVER a field of the returned `TaskSecretReadResult` (which carries only the non-secret reference + a safe reason).
// The disabled skeleton never calls `consume`.

// the pinned staging secret reference (a NON-secret name; the value lives only in Secrets Manager) — doc 46 §12.4
export const EXPECTED_SECRET_REF = "/idcaddie/staging/slack/oauth-client-secret";

export type TaskReadProvider = "slack";
export type TaskReadSecretKind = "oauth_client_secret";
export type TaskReadAppEnv = "staging";

// NON-secret request envelope — a REFERENCE only (never the value).
export type TaskSecretReadRequest = {
  provider: TaskReadProvider;
  secretRef: string;          // the Secrets Manager secret NAME/ARN reference — never the value
  secretKind: TaskReadSecretKind;
  appEnv: TaskReadAppEnv;
  requestId?: string;         // optional safe correlation id (no secret)
};

// closed, safe-static reason set — a reason NEVER embeds a value. `secret_not_found`/`read_failed` are the future real
// reader's fail-closed reasons (§12.5); `task_read_disabled` is this skeleton's always-on outcome.
export type TaskSecretReadReason =
  | "task_read_disabled"
  | "unsupported_provider" | "unsupported_secret_kind" | "invalid_app_env" | "missing_secret_ref" | "unexpected_secret_ref"
  | "secret_not_found" | "read_failed";

// REDACTED safe output — carries only the non-secret `secretRef` (proof of WHICH reference was read) + a safe reason.
// NEVER the secret value / plaintext / ARN-with-account / KMS material / stack.
export type TaskSecretReadResult =
  | { ok: true; provider: TaskReadProvider; secretRef: string }
  | { ok: false; provider: TaskReadProvider; reason: TaskSecretReadReason };

// the in-memory consumer the real reader hands the plaintext to (→ ingestClientSecret). It returns nothing, so the value
// cannot escape via the return path either.
export type SecretConsumer = (plaintext: string) => Promise<void>;

// The seam the SEPARATE runner implements. The real reader GetSecretValue-s the pinned ARN and calls `consume(plaintext)`
// in-scope; the disabled skeleton NEVER reads and NEVER calls `consume`.
export interface TaskSecretReader {
  read(request: TaskSecretReadRequest, consume: SecretConsumer): Promise<TaskSecretReadResult>;
}

const TASK_READ_OPT_IN = "ID_CADDIE_CONNECTOR_RUNNER_TASK_READ_ENABLED"; // a FUTURE approved flag — no effect in this skeleton.

// ALLOWLIST-shaped, ALWAYS false in this skeleton: no separate runner deployable, no provisioned/verified prod KMS-IAM,
// no Secrets Manager secret (still NOT-YET-CREATED, §12.9), no first-real-token. `productionTaskReadReady` is hardcoded
// false, so even with the opt-in set this returns false. Reads the trusted env map ONLY — a request can never enable it.
export function isTaskSecretReadEnabled(env: Record<string, string | undefined> = process.env): boolean {
  const optIn = env[TASK_READ_OPT_IN] === "1";
  const productionTaskReadReady = false; // no runner deployable / prod KMS-IAM / provisioned secret / first-real-token
  return optIn && productionTaskReadReady;
}

// PURE non-secret request validation (safe static reasons; never echoes a value). Pins the reference to the staging name.
export function validateTaskSecretReadRequest(request: TaskSecretReadRequest): { ok: true } | { ok: false; reason: TaskSecretReadReason } {
  if (!request || request.provider !== "slack") return { ok: false, reason: "unsupported_provider" };
  if (request.secretKind !== "oauth_client_secret") return { ok: false, reason: "unsupported_secret_kind" };
  if (request.appEnv !== "staging") return { ok: false, reason: "invalid_app_env" };
  if (typeof request.secretRef !== "string" || request.secretRef.length === 0) return { ok: false, reason: "missing_secret_ref" };
  if (request.secretRef !== EXPECTED_SECRET_REF) return { ok: false, reason: "unexpected_secret_ref" };
  return { ok: true };
}

// The fail-closed placeholder: ALWAYS fails closed. It NEVER reads a secret, NEVER calls `consume`, NEVER touches AWS.
export function createDisabledTaskSecretReader(env: Record<string, string | undefined> = process.env): TaskSecretReader {
  return {
    async read(request: TaskSecretReadRequest, _consume: SecretConsumer): Promise<TaskSecretReadResult> {
      void _consume; // intentionally never invoked — the disabled skeleton reads nothing (no leak path)
      const provider: TaskReadProvider = "slack";
      if (!isTaskSecretReadEnabled(env)) return { ok: false, reason: "task_read_disabled", provider }; // always, today
      const valid = validateTaskSecretReadRequest(request); // dead path today (guard above is always false); forward-correct
      if (!valid.ok) return { ok: false, reason: valid.reason, provider };
      // The real runner would GetSecretValue on the pinned ARN and hand the plaintext to `_consume` in-memory. The
      // skeleton reads NOTHING and calls `_consume` NEVER — it stays fail-closed.
      return { ok: false, reason: "task_read_disabled", provider };
    },
  };
}
