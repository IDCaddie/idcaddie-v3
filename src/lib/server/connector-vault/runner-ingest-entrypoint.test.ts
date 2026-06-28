import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  isRunnerIngestEntrypointEnabled, validateRunnerIngestRequest, createDisabledRunnerIngestEntrypoint,
  type RunnerIngestRequest,
} from "./runner-ingest-entrypoint";

const REQ: RunnerIngestRequest = { provider: "slack", tenantId: "t", connectorId: "c", purpose: "ingest_client_secret", secretKind: "oauth_client_secret", appEnv: "staging", version: 1 };

describe("runner ingest entrypoint — TYPED app↔runner seam, disabled fail-closed placeholder", () => {
  it("isRunnerIngestEntrypointEnabled is ALWAYS false (no separate runner / verified prod KMS-IAM / first-real-token)", () => {
    for (const env of [
      {}, { ID_CADDIE_RUNNER_INGEST_ENTRYPOINT_ENABLED: "1" },
      { NODE_ENV: "development", ID_CADDIE_RUNNER_INGEST_ENTRYPOINT_ENABLED: "1" },
      { NODE_ENV: "production", ID_CADDIE_RUNNER_INGEST_ENTRYPOINT_ENABLED: "1" },
      { VERCEL_ENV: "preview", ID_CADDIE_RUNNER_INGEST_ENTRYPOINT_ENABLED: "1" },
    ]) expect(isRunnerIngestEntrypointEnabled(env)).toBe(false);
  });

  it("run() ALWAYS fails closed with reason 'disabled' — regardless of env/request — and leaks no input", async () => {
    const ep = createDisabledRunnerIngestEntrypoint({ ID_CADDIE_RUNNER_INGEST_ENTRYPOINT_ENABLED: "1", NODE_ENV: "production" });
    const res = await ep.run({ ...REQ, tenantId: "MUSTNOTLEAK_TENANT", connectorId: "MUSTNOTLEAK_CONN" });
    expect(res).toEqual({ ok: false, reason: "disabled", provider: "slack" });
    const blob = JSON.stringify(res);
    for (const bad of ["MUSTNOTLEAK", "xoxb", "secret", "token"]) expect(blob).not.toContain(bad);
  });

  it("validateRunnerIngestRequest — the future runner's non-secret request contract (safe static reasons)", () => {
    expect(validateRunnerIngestRequest(REQ)).toEqual({ ok: true });
    expect(validateRunnerIngestRequest({ ...REQ, provider: "okta" as unknown as "slack" })).toEqual({ ok: false, reason: "unsupported_provider" });
    expect(validateRunnerIngestRequest({ ...REQ, purpose: "sync" as unknown as RunnerIngestRequest["purpose"] })).toEqual({ ok: false, reason: "unsupported_purpose" });
    expect(validateRunnerIngestRequest({ ...REQ, tenantId: "" })).toEqual({ ok: false, reason: "missing_tenant" });
    expect(validateRunnerIngestRequest({ ...REQ, connectorId: "" })).toEqual({ ok: false, reason: "missing_connector" });
    expect(validateRunnerIngestRequest({ ...REQ, appEnv: "production" as unknown as "staging" })).toEqual({ ok: false, reason: "invalid_app_env" });
    expect(validateRunnerIngestRequest({ ...REQ, version: 0 })).toEqual({ ok: false, reason: "invalid_version" });
  });

  it("instantiates NOTHING from pg/AWS/KMS/RunnerConnection — only a TYPE import from the committed core (static)", () => {
    const src = fs.readFileSync(path.resolve(__dirname, "runner-ingest-entrypoint.ts"), "utf8");
    const importLines = src.split("\n").filter((l) => /^import\b/.test(l));
    // The ONLY import is a TYPE-only import from the committed harness — so NO value from the vault/runner/KMS/AWS layer
    // is imported, and none of those functions can be CALLED (they appear only in the documentation comment).
    expect(importLines).toEqual(['import type { IngestDeps, IngestReason } from "./client-secret-ingest-harness";']);
    for (const bad of ['@aws-sdk', 'from "pg"', 'require("pg")', 'from "postgres"']) expect(src).not.toContain(bad);
  });
});
