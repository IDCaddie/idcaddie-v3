import { describe, it, expect } from "vitest";
import {
  isTaskReadIngestEnabled, createDisabledTaskReadIngest, composeTaskReadIngest,
  type TaskReadIngestResult, type RunnerIngestFn,
} from "./task-read-ingest";
import {
  EXPECTED_SECRET_REF, createDisabledTaskSecretReader,
  type TaskSecretReader, type TaskSecretReadRequest, type SecretConsumer,
} from "./task-secret-read";

const REQ: TaskSecretReadRequest = { provider: "slack", secretRef: EXPECTED_SECRET_REF, secretKind: "oauth_client_secret", appEnv: "staging" };
const SENTINEL = "MUSTNOTLEAK-synthetic-client-secret-value";

// a mock reader that (like the real GetSecretValue path) delivers a plaintext ONLY via consume — never returns it.
function mockReader(plaintext: string): TaskSecretReader {
  return { async read(_r: TaskSecretReadRequest, consume: SecretConsumer) { await consume(plaintext); return { ok: true, provider: "slack", secretRef: EXPECTED_SECRET_REF }; } };
}

describe("connector-runner task-read → ingest seam — fail-closed, leak-proof", () => {
  it("isTaskReadIngestEnabled is ALWAYS false (no separate runner / real SDK / provisioned live path)", () => {
    for (const env of [{}, { ID_CADDIE_CONNECTOR_RUNNER_TASK_READ_INGEST_ENABLED: "1" }, { NODE_ENV: "production", ID_CADDIE_CONNECTOR_RUNNER_TASK_READ_INGEST_ENABLED: "1" }])
      expect(isTaskReadIngestEnabled(env)).toBe(false);
  });

  it("createDisabledTaskReadIngest().run() ALWAYS returns task_read_disabled — reads/ingests nothing", async () => {
    const res = await createDisabledTaskReadIngest({ ID_CADDIE_CONNECTOR_RUNNER_TASK_READ_INGEST_ENABLED: "1" }).run({ ...REQ, requestId: SENTINEL });
    expect(res).toEqual({ ok: false, provider: "slack", reason: "task_read_disabled" });
    expect(JSON.stringify(res)).not.toContain("MUSTNOTLEAK");
  });

  it("the result type carries NO secret value — only ok/provider/(secretId|reason)", async () => {
    const res: TaskReadIngestResult = await createDisabledTaskReadIngest({}).run(REQ);
    for (const k of Object.keys(res)) expect(["ok", "provider", "secretId", "reason"]).toContain(k);
    expect(res).not.toHaveProperty("value");
    expect(res).not.toHaveProperty("plaintext");
  });

  it("compose: the plaintext flows reader→consume→ingest and NEVER leaks into the result (leak-proof handoff)", async () => {
    let ingestSaw = "";
    const ingest: RunnerIngestFn = async (input) => { ingestSaw = input.plaintext; return { ok: true, secretId: "appsec-1" }; };
    const res = await composeTaskReadIngest(mockReader(SENTINEL), ingest).run(REQ);
    expect(res).toEqual({ ok: true, provider: "slack", secretId: "appsec-1" }); // redacted row id only
    expect(ingestSaw).toBe(SENTINEL);                    // ingest received the plaintext in-scope
    expect(JSON.stringify(res)).not.toContain("MUSTNOTLEAK"); // ...but the result never carries it
    // the ingest input shape matches the committed core: appEnv staging, version 1
  });

  it("compose passes appEnv=staging + version=1 to ingest (matches the committed ingestClientSecret contract)", async () => {
    let seen: { appEnv: string; version: number } | undefined;
    const ingest: RunnerIngestFn = async (i) => { seen = { appEnv: i.appEnv, version: i.version }; return { ok: true, secretId: "x" }; };
    await composeTaskReadIngest(mockReader("s"), ingest).run(REQ);
    expect(seen).toEqual({ appEnv: "staging", version: 1 });
  });

  it("compose fails closed when the reader is the disabled placeholder (never reads, never ingests)", async () => {
    let ingestCalled = false;
    const ingest: RunnerIngestFn = async () => { ingestCalled = true; return { ok: true, secretId: "x" }; };
    const res = await composeTaskReadIngest(createDisabledTaskSecretReader({}), ingest).run(REQ);
    expect(res).toEqual({ ok: false, provider: "slack", reason: "task_read_disabled" });
    expect(ingestCalled).toBe(false);
  });

  it("compose maps an ingest failure to a redacted ingest_failed (no value)", async () => {
    const ingest: RunnerIngestFn = async () => ({ ok: false, reason: "ingest_failed" });
    const res = await composeTaskReadIngest(mockReader(SENTINEL), ingest).run(REQ);
    expect(res).toEqual({ ok: false, provider: "slack", reason: "ingest_failed" });
    expect(JSON.stringify(res)).not.toContain("MUSTNOTLEAK");
  });
});
