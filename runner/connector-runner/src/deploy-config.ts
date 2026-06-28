// connector-runner — typed FAIL-CLOSED deployment-config validator (doc 46 §12; PR #201 skeleton). It validates the
// SHAPE of the future ECS/Fargate runtime config, accepting only REFERENCES (names/aliases/ARNs/env-var-names) and
// hard-rejecting any raw secret VALUE — it NEVER decrypts, resolves an ARN, reads a secret, or connects. Self-contained
// (no app `src/` import, no pg/AWS/KMS/Secrets-Manager). Disabled by default: `validateDeployConfig` always returns
// `deploy_disabled` in this skeleton (the production runner is not provisioned). RISK-007 stays OPEN.
//
// Pinned design (doc 46 §12): runtime = ECS/Fargate one-shot (§12.1); ingestion = Secrets Manager task-read, Model B,
// NOT ECS-Exec stdin (§12.2); staging-only (§6); KMS via alias reference only (§9); the DB password is supplied to the
// production runner as an injected secret referenced BY ENV-VAR NAME here, never a connection string.

// Env-var names the production runner's task definition will set (this validator reads only these; no secret VALUES).
export const DEPLOY_ENV = {
  ENABLED: "ID_CADDIE_CONNECTOR_RUNNER_ENABLED", // reuse the runner opt-in (no second flag) — see entrypoint.ts
  RUNTIME_TARGET: "RUNNER_RUNTIME_TARGET",
  INGESTION_MODEL: "RUNNER_INGESTION_MODEL",
  APP_ENV: "RUNNER_APP_ENV",
  AWS_REGION: "CONNECTOR_VAULT_AWS_KMS_REGION",
  KMS_KEY_REF: "CONNECTOR_VAULT_KMS_KEY_ID",
  SECRET_REF: "CONNECTOR_VAULT_SECRET_REF",
  DB_CONN_REF: "CONNECTOR_RUNNER_DB_URL_REF",
} as const;

const RUNTIME_TARGET = "ecs-fargate";
const INGESTION_MODEL = "secrets-manager-task-read";
const APP_ENV = "staging";
const AWS_REGION = "ca-central-1";
const PRODUCTION_REF = "dzbfxulvxchdemcettrx"; // production project ref — hard-abort (doc 46 §6)

export type DeployConfigReason =
  | "deploy_disabled" | "missing_config" | "unknown_env" | "production_disabled"
  | "secret_value_supplied" | "invalid_reference" | "invalid_runtime_target" | "invalid_ingestion_model";
export type RunnerDeployConfig = {
  runtimeTarget: "ecs-fargate";
  ingestionModel: "secrets-manager-task-read";
  appEnv: "staging";
  awsRegion: "ca-central-1";
  kmsKeyRef: string; // alias/<name> or a kms key ARN — never key material
  secretRef: string; // /<name>/<path> or a secretsmanager ARN — never the secret plaintext
  dbConnRef: string; // the env-var NAME the runner reads the DB url from — never a connection string
};
export type DeployConfigResult = { ok: true; config: RunnerDeployConfig } | { ok: false; reason: DeployConfigReason };

// Shapes that are clearly a raw secret VALUE (never a reference). If a config field matches, the validator refuses with
// `secret_value_supplied` and never echoes the value.
const SECRET_VALUE_SHAPES: RegExp[] = [
  /xox[baprs]-/, /xapp-/,                                   // Slack bot/user/app tokens
  /A(KIA|SIA)[0-9A-Z]{16}/,                                 // AWS access key id
  /eyJ[A-Za-z0-9_-]{10,}\./,                                // JWT
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,                     // PEM private key
  /postgres(ql)?:\/\/[^:@/ ]+:[^@/ ]{6,}@/,                 // DB URL carrying a password
];
function looksLikeSecretValue(v: string): boolean {
  if (SECRET_VALUE_SHAPES.some((re) => re.test(v))) return true;
  // A real alias/path/ARN is broken up by separators (/ - . : _); a 40+ char separator-free run of token chars is
  // blob-like secret material — caught even behind an `alias/`, `arn:`, or `/` prefix (the prefix can't launder a blob).
  const longestRun = (v.match(/[A-Za-z0-9+=]+/g) ?? []).reduce((m, s) => Math.max(m, s.length), 0);
  return longestRun >= 40;
}

// Reference shapes the validator accepts (names/aliases/ARNs/env-var-names only).
const KMS_REF = /^alias\/[A-Za-z0-9/_-]+$|^arn:aws:kms:[a-z0-9-]+:[0-9]{12}:key\/[0-9a-f-]{36}$/;
const SECRET_REF = /^\/[A-Za-z0-9/_.-]+$|^arn:aws:secretsmanager:[a-z0-9-]+:[0-9]{12}:secret:[A-Za-z0-9/_+=.@-]+$/;
const DB_REF_NAME = /^[A-Z][A-Z0-9_]+$/; // an ENV-VAR NAME, never a URL

// PURE shape validation (the contract the production runner enforces before any deploy). Order is fail-closed; reasons
// are safe static strings that never embed a value.
export function parseDeployConfig(env: Record<string, string | undefined> = process.env): DeployConfigResult {
  const get = (k: string): string => (typeof env[k] === "string" ? (env[k] as string).trim() : "");
  const runtimeTarget = get(DEPLOY_ENV.RUNTIME_TARGET);
  const ingestionModel = get(DEPLOY_ENV.INGESTION_MODEL);
  const appEnv = get(DEPLOY_ENV.APP_ENV);
  const awsRegion = get(DEPLOY_ENV.AWS_REGION);
  const kmsKeyRef = get(DEPLOY_ENV.KMS_KEY_REF);
  const secretRef = get(DEPLOY_ENV.SECRET_REF);
  const dbConnRef = get(DEPLOY_ENV.DB_CONN_REF);

  if (![runtimeTarget, ingestionModel, appEnv, awsRegion, kmsKeyRef, secretRef, dbConnRef].every((v) => v.length > 0))
    return { ok: false, reason: "missing_config" };
  // refuse any raw secret value where only a reference belongs (checked before shape-accept, never echoed)
  if ([kmsKeyRef, secretRef, dbConnRef].some(looksLikeSecretValue)) return { ok: false, reason: "secret_value_supplied" };
  if (runtimeTarget !== RUNTIME_TARGET) return { ok: false, reason: "invalid_runtime_target" };
  if (ingestionModel !== INGESTION_MODEL) return { ok: false, reason: "invalid_ingestion_model" }; // e.g. ecs-exec-stdin
  if (appEnv === PRODUCTION_REF || appEnv === "production" || appEnv === "prod") return { ok: false, reason: "production_disabled" };
  if (appEnv !== APP_ENV) return { ok: false, reason: "unknown_env" };
  if (awsRegion !== AWS_REGION) return { ok: false, reason: "invalid_reference" };
  // a production-named ref (or the production project ref) in ANY reference field is a hard abort, not just secretRef
  const productionLike = (r: string): boolean => /prod/i.test(r) || r.toLowerCase().includes(PRODUCTION_REF);
  if ([kmsKeyRef, secretRef, dbConnRef].some(productionLike)) return { ok: false, reason: "production_disabled" };
  if (!KMS_REF.test(kmsKeyRef)) return { ok: false, reason: "invalid_reference" };
  if (!SECRET_REF.test(secretRef)) return { ok: false, reason: "invalid_reference" };
  if (!DB_REF_NAME.test(dbConnRef)) return { ok: false, reason: "invalid_reference" };

  return { ok: true, config: { runtimeTarget: RUNTIME_TARGET, ingestionModel: INGESTION_MODEL, appEnv: APP_ENV, awsRegion: AWS_REGION, kmsKeyRef, secretRef, dbConnRef } };
}

// ALLOWLIST-shaped, ALWAYS false in this skeleton (mirrors isConnectorRunnerEnabled): no provisioned runner host / prod
// KMS-IAM / Secrets Manager / first-real-token. Reads the TRUSTED env map ONLY — a request can never enable it.
export function isDeployConfigEnabled(env: Record<string, string | undefined> = process.env): boolean {
  const optIn = env[DEPLOY_ENV.ENABLED] === "1";
  const productionRunnerProvisioned = false; // no host / prod KMS-IAM / Secrets Manager / first-real-token — never set here
  return optIn && productionRunnerProvisioned;
}

// The gated entry: fail closed unless the runner is enabled (always disabled today). Shape checks run as a dead-but-
// correct path behind the always-false guard, exactly like createConnectorRunner/validateRunnerRequest.
export function validateDeployConfig(env: Record<string, string | undefined> = process.env): DeployConfigResult {
  if (!isDeployConfigEnabled(env)) return { ok: false, reason: "deploy_disabled" }; // always, today
  return parseDeployConfig(env);
}
