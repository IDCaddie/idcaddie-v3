import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { DEPLOY_ENV, isDeployConfigEnabled, parseDeployConfig, validateDeployConfig } from "./deploy-config";

// a fully well-shaped (but inert) config — references only, no secret values
const OK_ENV: Record<string, string> = {
  [DEPLOY_ENV.RUNTIME_TARGET]: "ecs-fargate",
  [DEPLOY_ENV.INGESTION_MODEL]: "secrets-manager-task-read",
  [DEPLOY_ENV.APP_ENV]: "staging",
  [DEPLOY_ENV.AWS_REGION]: "ca-central-1",
  [DEPLOY_ENV.KMS_KEY_REF]: "alias/idcaddie-staging-connector-vault",
  [DEPLOY_ENV.SECRET_REF]: "/idcaddie/staging/slack/oauth-client-secret",
  [DEPLOY_ENV.DB_CONN_REF]: "CONNECTOR_RUNNER_DB_URL",
};

describe("connector-runner deploy-config — fail-closed, reference-only", () => {
  it("validateDeployConfig is ALWAYS deploy_disabled (skeleton) — even with the opt-in flag + a perfect config", () => {
    for (const env of [
      {}, OK_ENV,
      { ...OK_ENV, [DEPLOY_ENV.ENABLED]: "1" },
      { ...OK_ENV, [DEPLOY_ENV.ENABLED]: "1", NODE_ENV: "production" },
    ]) expect(validateDeployConfig(env)).toEqual({ ok: false, reason: "deploy_disabled" });
    expect(isDeployConfigEnabled({ [DEPLOY_ENV.ENABLED]: "1" })).toBe(false);
  });

  it("parseDeployConfig accepts a well-shaped reference-only config", () => {
    const r = parseDeployConfig(OK_ENV);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.config.kmsKeyRef).toBe("alias/idcaddie-staging-connector-vault");
  });

  it("missing any reference fails closed (missing_config)", () => {
    for (const k of Object.values(DEPLOY_ENV).filter((k) => k !== DEPLOY_ENV.ENABLED)) {
      const env = { ...OK_ENV }; delete (env as Record<string, string>)[k];
      expect(parseDeployConfig(env)).toEqual({ ok: false, reason: "missing_config" });
    }
  });

  it("a raw secret VALUE where a reference belongs is rejected (secret_value_supplied) and never echoed", () => {
    // each value is sentinel-marked so check-no-real-tokens excuses it; each must be rejected + never echoed
    const cases: ReadonlyArray<readonly [string, string]> = [
      ["xoxb-not-a-real-token-0", DEPLOY_ENV.KMS_KEY_REF],            // Slack token shape
      ["AKIAIOSFODNN7EXAMPLE", DEPLOY_ENV.SECRET_REF],               // AWS access key id shape
      ["postgres://runner:MUSTNOTLEAKpw@db.internal:5432/x", DEPLOY_ENV.DB_CONN_REF], // DB URL with password
      ["abcdef0123456789ABCDEF0123456789EXAMPLE9999", DEPLOY_ENV.KMS_KEY_REF],        // high-entropy blob
    ];
    for (const [val, key] of cases) {
      const res = parseDeployConfig({ ...OK_ENV, [key]: val });
      expect(res).toEqual({ ok: false, reason: "secret_value_supplied" });
      expect(JSON.stringify(res)).not.toContain(val.slice(0, 12)); // the value is never echoed in the result
    }
  });

  it("a production-looking value in ANY ref field (not just secretRef) refuses (production_disabled)", () => {
    expect(parseDeployConfig({ ...OK_ENV, [DEPLOY_ENV.APP_ENV]: "production" })).toEqual({ ok: false, reason: "production_disabled" });
    expect(parseDeployConfig({ ...OK_ENV, [DEPLOY_ENV.APP_ENV]: "dzbfxulvxchdemcettrx" })).toEqual({ ok: false, reason: "production_disabled" });
    expect(parseDeployConfig({ ...OK_ENV, [DEPLOY_ENV.SECRET_REF]: "/idcaddie/production/slack/oauth-client-secret" })).toEqual({ ok: false, reason: "production_disabled" });
    expect(parseDeployConfig({ ...OK_ENV, [DEPLOY_ENV.KMS_KEY_REF]: "alias/idcaddie-production-connector-vault" })).toEqual({ ok: false, reason: "production_disabled" });
    expect(parseDeployConfig({ ...OK_ENV, [DEPLOY_ENV.DB_CONN_REF]: "DZBFXULVXCHDEMCETTRX_DB_URL" })).toEqual({ ok: false, reason: "production_disabled" });
  });

  it("a high-entropy blob behind an alias/ or / prefix is still rejected (secret_value_supplied)", () => {
    expect(parseDeployConfig({ ...OK_ENV, [DEPLOY_ENV.KMS_KEY_REF]: "alias/" + "A".repeat(40) })).toEqual({ ok: false, reason: "secret_value_supplied" });
    expect(parseDeployConfig({ ...OK_ENV, [DEPLOY_ENV.SECRET_REF]: "/" + "B".repeat(40) })).toEqual({ ok: false, reason: "secret_value_supplied" });
  });

  it("unknown env / wrong runtime / wrong ingestion model / malformed reference each refuse safely", () => {
    expect(parseDeployConfig({ ...OK_ENV, [DEPLOY_ENV.APP_ENV]: "dev" })).toEqual({ ok: false, reason: "unknown_env" });
    expect(parseDeployConfig({ ...OK_ENV, [DEPLOY_ENV.RUNTIME_TARGET]: "k8s" })).toEqual({ ok: false, reason: "invalid_runtime_target" });
    expect(parseDeployConfig({ ...OK_ENV, [DEPLOY_ENV.INGESTION_MODEL]: "ecs-exec-stdin" })).toEqual({ ok: false, reason: "invalid_ingestion_model" });
    expect(parseDeployConfig({ ...OK_ENV, [DEPLOY_ENV.KMS_KEY_REF]: "not-an-alias-or-arn" })).toEqual({ ok: false, reason: "invalid_reference" });
    expect(parseDeployConfig({ ...OK_ENV, [DEPLOY_ENV.DB_CONN_REF]: "postgres://localhost/x" })).toEqual({ ok: false, reason: "invalid_reference" });
  });

  it("the committed deploy-config + README carry NO real AWS account / KMS-ARN / key-material / DB-URL (inert placeholders only)", () => {
    const files = ["deploy-config.ts", "../README.md"]; // not the test file — it holds synthetic secret-shaped fixtures by design
    for (const f of files) {
      const src = fs.readFileSync(path.resolve(__dirname, f), "utf8");
      expect(src, `${f} must not embed an account-bearing ARN`).not.toMatch(/arn:aws:[a-z0-9-]+:[a-z0-9-]*:[0-9]{12}:/);
      expect(src, `${f} must not embed a real KMS key UUID`).not.toMatch(/key\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/);
      expect(src, `${f} must not embed a DB URL with a password`).not.toMatch(/postgres(ql)?:\/\/[^:@/ ]+:[^@/ ]{6,}@/);
      expect(src, `${f} must not embed a PEM private key`).not.toContain("BEGIN PRIVATE KEY");
    }
  });
});
