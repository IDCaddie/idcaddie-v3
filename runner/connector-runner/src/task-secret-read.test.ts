import { describe, it, expect } from "vitest";
import {
  EXPECTED_SECRET_REF, isTaskSecretReadEnabled, validateTaskSecretReadRequest, createDisabledTaskSecretReader,
  type TaskSecretReadRequest, type SecretConsumer,
} from "./task-secret-read";

const REQ: TaskSecretReadRequest = { provider: "slack", secretRef: EXPECTED_SECRET_REF, secretKind: "oauth_client_secret", appEnv: "staging" };

describe("connector-runner task-secret-read — fail-closed skeleton, never reads the secret", () => {
  it("isTaskSecretReadEnabled is ALWAYS false (no runner deployable / prod KMS-IAM / provisioned secret)", () => {
    for (const env of [
      {}, { ID_CADDIE_CONNECTOR_RUNNER_TASK_READ_ENABLED: "1" },
      { NODE_ENV: "production", ID_CADDIE_CONNECTOR_RUNNER_TASK_READ_ENABLED: "1" },
    ]) expect(isTaskSecretReadEnabled(env)).toBe(false);
  });

  it("read() ALWAYS returns task_read_disabled and NEVER invokes the consume callback (no read)", async () => {
    let consumed = false;
    const consume: SecretConsumer = async () => { consumed = true; };
    const reader = createDisabledTaskSecretReader({ ID_CADDIE_CONNECTOR_RUNNER_TASK_READ_ENABLED: "1", NODE_ENV: "production" });
    const res = await reader.read({ ...REQ, requestId: "MUSTNOTLEAK" }, consume);
    expect(res).toEqual({ ok: false, reason: "task_read_disabled", provider: "slack" });
    expect(consumed, "the disabled reader must never call consume (never read the secret)").toBe(false);
    expect(JSON.stringify(res)).not.toContain("MUSTNOTLEAK");
  });

  it("the result type carries NO secret value field — only ok/reason/provider (+ non-secret secretRef on success)", async () => {
    const res = await createDisabledTaskSecretReader({}).read(REQ, async () => {});
    for (const k of Object.keys(res)) expect(["ok", "reason", "provider", "secretRef"]).toContain(k);
    expect(res).not.toHaveProperty("value");
    expect(res).not.toHaveProperty("plaintext");
    expect(res).not.toHaveProperty("secretString");
  });

  it("validateTaskSecretReadRequest — safe static reasons, pins the staging secret reference", () => {
    expect(validateTaskSecretReadRequest(REQ)).toEqual({ ok: true });
    expect(validateTaskSecretReadRequest({ ...REQ, provider: "okta" as unknown as "slack" })).toEqual({ ok: false, reason: "unsupported_provider" });
    expect(validateTaskSecretReadRequest({ ...REQ, secretKind: "token" as unknown as "oauth_client_secret" })).toEqual({ ok: false, reason: "unsupported_secret_kind" });
    expect(validateTaskSecretReadRequest({ ...REQ, appEnv: "production" as unknown as "staging" })).toEqual({ ok: false, reason: "invalid_app_env" });
    expect(validateTaskSecretReadRequest({ ...REQ, secretRef: "" })).toEqual({ ok: false, reason: "missing_secret_ref" });
    expect(validateTaskSecretReadRequest({ ...REQ, secretRef: "/idcaddie/production/slack/oauth-client-secret" })).toEqual({ ok: false, reason: "unexpected_secret_ref" });
  });
});
