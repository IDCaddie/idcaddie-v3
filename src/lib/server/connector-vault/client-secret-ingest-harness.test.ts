import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { randomBytes } from "node:crypto";
import { Readable } from "node:stream";
import {
  assertSafeInvocation,
  readSecretFromStream,
  ingestClientSecret,
  formatRedactedOutcome,
  ClientSecretIngestError,
  type IngestDeps,
} from "./client-secret-ingest-harness";
import type { AppSecretEnvelopeStore } from "./slack-client-secret-store";
import type { ConnectorVaultKeyProvider } from "./crypto";

// B2c-run prep: the safe client-secret ingestion harness CORE. Synthetic only — a MARKED sentinel (NOT a real
// client secret) so the no-leak assertions prove a real secret would not survive into stdout/stderr/errors/result.
const SENTINEL = "MUSTNOTLEAK-b2c-prep-client-secret-sentinel";
const KEK = "kek-staging-app-1";

const memKeyProvider = (opts: { failGenerate?: boolean } = {}): ConnectorVaultKeyProvider => ({
  async generateDataKey(kekId) { if (opts.failGenerate) throw new Error("forced kms failure (no sentinel here)"); const dek = randomBytes(32); return { dek, wrappedDek: Buffer.concat([Buffer.from(`${kekId}|`), dek]) }; },
  async unwrapDataKey() { throw new Error("decrypt not allowed in ingestion"); },
});
const memStore = (opts: { throwSentinel?: boolean } = {}) => {
  const rows: { plaintextSeen?: boolean; envelope: unknown }[] = [];
  const store: AppSecretEnvelopeStore = {
    async insertEnvelope(row) {
      if (opts.throwSentinel) throw new Error(`store blew up with ${SENTINEL}`); // worst case: error carries the sentinel
      rows.push({ envelope: row.encrypted, plaintextSeen: JSON.stringify(row).includes(SENTINEL) });
      return { secretId: `appsec-${rows.length}` };
    },
    async loadActiveEnvelope() { return null; },
  };
  return { store, rows };
};
const deps = (over: Partial<IngestDeps> = {}): IngestDeps => ({ keyProvider: memKeyProvider(), kekId: KEK, store: memStore().store, ...over });

let consoleDump: string[];
beforeEach(() => { consoleDump = []; for (const m of ["log", "info", "warn", "error", "debug"] as const) vi.spyOn(console, m).mockImplementation((...a: unknown[]) => { consoleDump.push(a.map(String).join(" ")); }); });
afterEach(() => vi.restoreAllMocks());
const noLeak = (...vals: unknown[]) => { const dump = JSON.stringify({ vals, console: consoleDump }); expect(dump).not.toContain(SENTINEL); expect(dump).not.toContain("MUSTNOTLEAK"); };

describe("harness — stdin reading reaches the boundary; secret is envelope-only and never printed/logged/returned", () => {
  it("reads the secret from a stream and ingests it (envelope-only row; redacted ref; no plaintext anywhere)", async () => {
    const secret = await readSecretFromStream(Readable.from([SENTINEL + "\n"])); // trailing newline trimmed
    expect(secret).toBe(SENTINEL);
    const st = memStore();
    const result = await ingestClientSecret({ plaintext: secret, appEnv: "staging", version: 1 }, deps({ store: st.store }));
    expect(result).toEqual({ ok: true, secretId: "appsec-1" });
    expect(st.rows[0].plaintextSeen).toBe(false); // the store only ever saw the envelope, never the plaintext
    noLeak(result, secret && "[redacted]"); // result + console carry no sentinel
    expect(formatRedactedOutcome(result)).toBe("OK: stored Slack client secret (envelope-only). secret_id=appsec-1");
    expect(formatRedactedOutcome(result)).not.toContain(SENTINEL);
  });
});

describe("harness — argv/env rejection (the secret must never arrive via the command line or env)", () => {
  it("rejects a positional argv value (a likely secret)", () => {
    expect(() => assertSafeInvocation({ argv: [SENTINEL], env: {} })).toThrow(ClientSecretIngestError);
    let thrown: unknown; try { assertSafeInvocation({ argv: [SENTINEL], env: {} }); } catch (e) { thrown = e; }
    expect(thrown instanceof Error ? thrown.message : "").not.toContain(SENTINEL); // the error never echoes the arg
  });
  it("rejects SLACK_CLIENT_SECRET set in the environment", () => {
    expect(() => assertSafeInvocation({ argv: [], env: { SLACK_CLIENT_SECRET: SENTINEL } })).toThrow(ClientSecretIngestError);
    let thrown: unknown; try { assertSafeInvocation({ argv: [], env: { SLACK_CLIENT_SECRET: SENTINEL } }); } catch (e) { thrown = e; }
    expect(thrown instanceof Error ? thrown.message : "").not.toContain(SENTINEL);
  });
  it("allows ONLY the minimal NON-secret flags (--app-env/--version/--confirm); rejects unknown + dropped flags", () => {
    expect(() => assertSafeInvocation({ argv: ["--evil=x"], env: {} })).toThrow(ClientSecretIngestError);
    expect(() => assertSafeInvocation({ argv: ["--app-env", "staging", "--version", "1", "--confirm"], env: {} })).not.toThrow();
    expect(() => assertSafeInvocation({ argv: ["--app-env=staging"], env: {} })).not.toThrow();
    // dormant flags removed — a file-path-as-secret / kek-as-flag pattern is now refused outright:
    for (const dropped of ["--secret-file=/tmp/x", "--kek-id=k", "--ref=staging"]) expect(() => assertSafeInvocation({ argv: [dropped], env: {} })).toThrow(ClientSecretIngestError);
  });
});

describe("harness — fail-closed (missing input / invalid config / save failure) with no sentinel leak", () => {
  it("empty stdin fails closed (no input)", async () => {
    await expect(readSecretFromStream(Readable.from([""]))).rejects.toBeInstanceOf(ClientSecretIngestError);
    await expect(readSecretFromStream(Readable.from([]))).rejects.toBeInstanceOf(ClientSecretIngestError);
  });
  it("oversize input fails closed", async () => {
    await expect(readSecretFromStream(Readable.from(["x".repeat(9000)]))).rejects.toBeInstanceOf(ClientSecretIngestError);
  });
  it("empty plaintext → missing_secret", async () => {
    expect(await ingestClientSecret({ plaintext: "", appEnv: "staging", version: 1 }, deps())).toEqual({ ok: false, reason: "missing_secret" });
  });
  it("non-staging app_env → invalid_app_env (staging-only)", async () => {
    expect(await ingestClientSecret({ plaintext: SENTINEL, appEnv: "production", version: 1 }, deps())).toEqual({ ok: false, reason: "invalid_app_env" });
  });
  it("invalid version → invalid_version", async () => {
    expect(await ingestClientSecret({ plaintext: SENTINEL, appEnv: "staging", version: 0 }, deps())).toEqual({ ok: false, reason: "invalid_version" });
  });
  it("missing KMS config → missing_kms_config (fail closed, no weak path)", async () => {
    expect(await ingestClientSecret({ plaintext: SENTINEL, appEnv: "staging", version: 1 }, { keyProvider: undefined as unknown as ConnectorVaultKeyProvider, kekId: "", store: memStore().store })).toEqual({ ok: false, reason: "missing_kms_config" });
  });
  it("missing store → missing_store", async () => {
    expect(await ingestClientSecret({ plaintext: SENTINEL, appEnv: "staging", version: 1 }, { keyProvider: memKeyProvider(), kekId: KEK, store: undefined as unknown as AppSecretEnvelopeStore })).toEqual({ ok: false, reason: "missing_store" });
  });
  it("a KMS failure during save → ingest_failed; the sentinel does not leak", async () => {
    const { result, dump } = await runIngest({ keyProvider: memKeyProvider({ failGenerate: true }) });
    expect(result).toEqual({ ok: false, reason: "ingest_failed" });
    expect(dump).not.toContain(SENTINEL);
  });
  it("a STORE error that CARRIES the sentinel is swallowed → ingest_failed; the sentinel does not leak (catch returns a static reason)", async () => {
    const { result, dump } = await runIngest({ store: memStore({ throwSentinel: true }).store });
    expect(result).toEqual({ ok: false, reason: "ingest_failed" });
    expect(dump).not.toContain(SENTINEL); // the caught error message (which embedded the sentinel) is NEVER surfaced
    expect(formatRedactedOutcome(result as { ok: false; reason: "ingest_failed" })).toBe("FAILED (fail-closed): ingest_failed");
  });
  async function runIngest(over: Partial<IngestDeps>) {
    let result: unknown, thrown: unknown;
    try { result = await ingestClientSecret({ plaintext: SENTINEL, appEnv: "staging", version: 1 }, deps(over)); } catch (e) { thrown = e; }
    return { result, dump: JSON.stringify({ result, thrown: thrown instanceof Error ? thrown.message : thrown, console: consoleDump }) };
  }
});
