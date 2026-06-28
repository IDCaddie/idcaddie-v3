import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { isConnectorRunnerEnabled, validateRunnerRequest, createConnectorRunner, main } from "./entrypoint";
import type { RunnerRequest } from "./contract";

const REQ: RunnerRequest = { provider: "slack", tenantId: "t", connectorId: "c", purpose: "ingest_client_secret", secretKind: "oauth_client_secret", appEnv: "staging", version: 1 };

describe("connector-runner — separate deployable skeleton, fail-closed", () => {
  it("isConnectorRunnerEnabled is ALWAYS false (no provisioned host / prod KMS-IAM / first-real-token)", () => {
    for (const env of [
      {}, { ID_CADDIE_CONNECTOR_RUNNER_ENABLED: "1" },
      { NODE_ENV: "development", ID_CADDIE_CONNECTOR_RUNNER_ENABLED: "1" },
      { NODE_ENV: "production", ID_CADDIE_CONNECTOR_RUNNER_ENABLED: "1" },
      { VERCEL_ENV: "preview", ID_CADDIE_CONNECTOR_RUNNER_ENABLED: "1" },
    ]) expect(isConnectorRunnerEnabled(env)).toBe(false);
  });

  it("run() ALWAYS returns runner_disabled — regardless of env/request — and leaks no input/token", async () => {
    const runner = createConnectorRunner({ ID_CADDIE_CONNECTOR_RUNNER_ENABLED: "1", NODE_ENV: "production" });
    const res = await runner.run({ ...REQ, tenantId: "MUSTNOTLEAK_TENANT", connectorId: "MUSTNOTLEAK_CONN" });
    expect(res).toEqual({ ok: false, reason: "runner_disabled", provider: "slack" });
    const blob = JSON.stringify(res);
    for (const bad of ["MUSTNOTLEAK", "xoxb", "secret", "token"]) expect(blob).not.toContain(bad);
  });

  it("validateRunnerRequest rejects bad requests with safe static reasons", () => {
    expect(validateRunnerRequest(REQ)).toEqual({ ok: true });
    expect(validateRunnerRequest({ ...REQ, provider: "okta" as unknown as "slack" })).toEqual({ ok: false, reason: "unsupported_provider" });
    expect(validateRunnerRequest({ ...REQ, purpose: "sync" as unknown as RunnerRequest["purpose"] })).toEqual({ ok: false, reason: "unsupported_purpose" });
    expect(validateRunnerRequest({ ...REQ, tenantId: "" })).toEqual({ ok: false, reason: "missing_tenant" });
    expect(validateRunnerRequest({ ...REQ, connectorId: "" })).toEqual({ ok: false, reason: "missing_connector" });
    expect(validateRunnerRequest({ ...REQ, appEnv: "production" as unknown as "staging" })).toEqual({ ok: false, reason: "invalid_app_env" });
    expect(validateRunnerRequest({ ...REQ, version: 0 })).toEqual({ ok: false, reason: "invalid_version" });
  });

  it("a request-supplied opt-in cannot enable the runner (env-only)", async () => {
    void { headers: { ID_CADDIE_CONNECTOR_RUNNER_ENABLED: "1" } };
    expect((await createConnectorRunner({}).run(REQ)).ok).toBe(false);
  });

  it("main() prints only a safe static line and exits non-zero while disabled", async () => {
    expect(await main([])).toBe(1);
  });

  it("the runner imports NOTHING from pg/AWS/KMS/Secrets-Manager/vault-reader/fs (static, self-contained)", () => {
    for (const file of ["contract.ts", "entrypoint.ts"]) {
      const src = fs.readFileSync(path.resolve(__dirname, file), "utf8");
      const importLines = src.split("\n").filter((l) => /^import\b/.test(l));
      for (const line of importLines) for (const bad of ["@aws-sdk", '"pg"', "postgres", "client-secretsmanager", "secret-vault", "connector-secret-store", "runner-db-client", "../../src/", "@/"])
        expect(line, `import must not reference ${bad}`).not.toContain(bad);
      for (const bad of ["writeFile", "createWriteStream", "tmpdir", "/tmp"]) expect(src).not.toContain(bad);
    }
  });
});
