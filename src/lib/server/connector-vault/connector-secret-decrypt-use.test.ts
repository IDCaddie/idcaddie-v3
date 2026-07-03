import { describe, it, expect, vi } from "vitest";
import { createHash, randomBytes, createCipheriv, createDecipheriv } from "node:crypto";
import {
  runnerDecryptAndUse,
  ConnectorSecretDecryptUseError,
  type DecryptUseResult,
} from "./connector-secret-decrypt-use";
import {
  acquireRunnerDecryptCapability,
  RUNNER_RUNTIME_MARKER,
  RunnerDecryptCapability,
  RedactedSecret,
  type ConnectorSecretReadStore,
  type StoredEncryptedSecret,
} from "./secret-vault";
import {
  encryptConnectorSecret,
  type SecretContext,
  type ConnectorVaultKeyProvider,
  type EncryptedConnectorSecret,
} from "./crypto";

// The synthetic plaintext under test. NOT a real token and NOT a secret shape (no xox-/postgres://); it doubles as the
// leak sentinel — no assertion output, log, error, or proof field may ever contain it.
const TOKEN = "MUSTNOTLEAK-synthetic-oauth-access-token-slice-decrypt-use";
const KEK = "test-kek-1";
const ctx = (over: Partial<SecretContext> = {}): SecretContext => ({
  tenantId: "11111111-1111-4111-8111-111111111111",
  connectorId: "22222222-2222-4222-8222-222222222222",
  secretKind: "oauth_access_token",
  version: 1,
  ...over,
});

// In-memory KMS-shaped key provider (AES-256-GCM DEK wrap under an in-memory KEK) — the same shape as the real KMS
// provider, so no AWS/KMS is touched. `unwrapDataKey` throws on a wrong KEK / tampered wrap.
function inMemoryKeyProvider(): ConnectorVaultKeyProvider {
  const keks = new Map<string, Buffer>();
  const getKek = (id: string) => { let k = keks.get(id); if (!k) { k = randomBytes(32); keks.set(id, k); } return k; };
  return {
    async generateDataKey(kekId) {
      const dek = randomBytes(32), kek = getKek(kekId), iv = randomBytes(12);
      const c = createCipheriv("aes-256-gcm", kek, iv); c.setAAD(Buffer.from(`kek:${kekId}`, "utf8"));
      const ct = Buffer.concat([c.update(dek), c.final()]);
      return { dek, wrappedDek: Buffer.concat([iv, c.getAuthTag(), ct]) };
    },
    async unwrapDataKey(wrapped, kekId) {
      const kek = getKek(kekId), iv = wrapped.subarray(0, 12), tag = wrapped.subarray(12, 28), ct = wrapped.subarray(28);
      const d = createDecipheriv("aes-256-gcm", kek, iv); d.setAAD(Buffer.from(`kek:${kekId}`, "utf8")); d.setAuthTag(tag);
      return Buffer.concat([d.update(ct), d.final()]);
    },
  };
}

// A fake ConnectorSecretReadStore that returns a pre-built envelope (or null / throws). Records call count so we can
// prove the request-path path never reaches a store read.
function fakeReadStore(behavior: { row?: StoredEncryptedSecret | null; throws?: boolean } = {}) {
  let calls = 0;
  const find = async (): Promise<StoredEncryptedSecret | null> => {
    calls++;
    if (behavior.throws) throw new Error("db boom leaking " + TOKEN); // must never surface
    return behavior.row ?? null;
  };
  const store: ConnectorSecretReadStore = { findEncryptedSecret: find, findLatestEncryptedSecret: find };
  return { store, calls: () => calls };
}

function tamperCiphertext(env: EncryptedConnectorSecret): EncryptedConnectorSecret {
  const ct = Buffer.from(env.ciphertext, "base64"); ct[0] ^= 0xff;
  return { ...env, ciphertext: ct.toString("base64") };
}

async function envelope(kp: ConnectorVaultKeyProvider, context = ctx()): Promise<StoredEncryptedSecret> {
  const encrypted = await encryptConnectorSecret({ plaintext: TOKEN, context, keyProvider: kp, kekId: KEK });
  return { id: "33333333-3333-4333-8333-333333333333", encrypted };
}

describe("connector-secret decrypt/use harness (doc 44 §7 PR C) — runner-only, redacted, fail-closed", () => {
  it("runner path: fake-KMS envelope round-trips → decrypts → returns a REDACTED proof only (no plaintext)", async () => {
    const kp = inMemoryKeyProvider();
    const { store } = fakeReadStore({ row: await envelope(kp) });
    const cap = acquireRunnerDecryptCapability({ runnerEnv: RUNNER_RUNTIME_MARKER, keyProvider: kp });
    expect(cap).toBeInstanceOf(RunnerDecryptCapability);

    const proof = await runnerDecryptAndUse(cap!, { context: ctx(), store, kekId: KEK });

    expect(proof.ok).toBe(true);
    expect(proof.tenantId).toBe(ctx().tenantId);
    expect(proof.secretKind).toBe("oauth_access_token");
    expect(proof.version).toBe(1);
    expect(proof.kekId).toBe(KEK);
    expect(proof.plaintextByteLength).toBe(Buffer.byteLength(TOKEN, "utf8"));
    // fingerprint = sha256(plaintext) — proves identity WITHOUT exposing the secret
    expect(proof.fingerprint).toBe(createHash("sha256").update(Buffer.from(TOKEN, "utf8")).digest("hex"));
    expect(proof.use).toBeNull();
    // the proof carries NO plaintext anywhere
    expect(JSON.stringify(proof)).not.toContain("MUSTNOTLEAK");
  });

  it("injected runner-only `use` receives a REDACTED secret (bytes only via .expose(); string/JSON redacted) and its non-secret result is echoed", async () => {
    const kp = inMemoryKeyProvider();
    const { store } = fakeReadStore({ row: await envelope(kp) });
    const cap = acquireRunnerDecryptCapability({ runnerEnv: RUNNER_RUNTIME_MARKER, keyProvider: kp })!;
    let seenString = "", seenExposedLen = -1;
    const use = (s: RedactedSecret): DecryptUseResult => {
      seenString = String(s);            // redacted
      seenExposedLen = s.expose().length; // real bytes for the actual "use"
      return { ok: s.expose().length > 0, detail: "provider-accepted" };
    };
    const proof = await runnerDecryptAndUse(cap, { context: ctx(), store, kekId: KEK, use });
    expect(seenString).toBe("[REDACTED connector secret]");
    expect(seenExposedLen).toBe(Buffer.byteLength(TOKEN, "utf8"));
    expect(proof.use).toEqual({ ok: true, detail: "provider-accepted" });
    expect(JSON.stringify(proof)).not.toContain("MUSTNOTLEAK");
  });

  it("request/web path is DENIED: cannot acquire, cannot forge, and a non-capability fails closed BEFORE any store read", async () => {
    const kp = inMemoryKeyProvider();
    // (a) acquire fails closed without the runner runtime marker
    expect(acquireRunnerDecryptCapability({ runnerEnv: "web-request", keyProvider: kp })).toBeNull();
    expect(acquireRunnerDecryptCapability({ runnerEnv: undefined, keyProvider: kp })).toBeNull();
    // (b) the capability cannot be forged directly
    expect(() => new RunnerDecryptCapability(Symbol("forge"), kp)).toThrow();
    // (c) calling the harness without a real capability fails closed and never touches the store
    const { store, calls } = fakeReadStore({ row: await envelope(kp) });
    await expect(
      runnerDecryptAndUse({} as unknown as RunnerDecryptCapability, { context: ctx(), store, kekId: KEK }),
    ).rejects.toBeInstanceOf(ConnectorSecretDecryptUseError);
    expect(calls()).toBe(0); // no store read on the denied path
  });

  it("fail-closed: not-found / inactive-revoked (store returns null) → typed error, no plaintext", async () => {
    const kp = inMemoryKeyProvider();
    const { store } = fakeReadStore({ row: null });
    const cap = acquireRunnerDecryptCapability({ runnerEnv: RUNNER_RUNTIME_MARKER, keyProvider: kp })!;
    let err: Error | undefined;
    await runnerDecryptAndUse(cap, { context: ctx(), store, kekId: KEK }).catch((e) => (err = e as Error));
    expect(err).toBeInstanceOf(ConnectorSecretDecryptUseError);
    expect(String(err?.message) + String(err?.stack ?? "")).not.toContain("MUSTNOTLEAK");
  });

  it("fail-closed: malformed / tampered envelope → typed error, no plaintext or caught-error body", async () => {
    const kp = inMemoryKeyProvider();
    const { store } = fakeReadStore({ row: { id: "x", encrypted: tamperCiphertext((await envelope(kp)).encrypted) } });
    const cap = acquireRunnerDecryptCapability({ runnerEnv: RUNNER_RUNTIME_MARKER, keyProvider: kp })!;
    let err: Error | undefined;
    await runnerDecryptAndUse(cap, { context: ctx(), store, kekId: KEK }).catch((e) => (err = e as Error));
    expect(err).toBeInstanceOf(ConnectorSecretDecryptUseError);
    expect(String(err?.message) + String(err?.stack ?? "")).not.toContain("MUSTNOTLEAK");
  });

  it("fail-closed: wrong AAD (row sealed for another tenant/connector/kind/version) → typed error", async () => {
    const kp = inMemoryKeyProvider();
    const row = await envelope(kp, ctx({ tenantId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" }));
    const { store } = fakeReadStore({ row });
    const cap = acquireRunnerDecryptCapability({ runnerEnv: RUNNER_RUNTIME_MARKER, keyProvider: kp })!;
    // decrypt with a DIFFERENT tenant context than the one it was sealed under → AAD mismatch
    let err: Error | undefined;
    await runnerDecryptAndUse(cap, { context: ctx({ tenantId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" }), store, kekId: KEK }).catch((e) => (err = e as Error));
    expect(err).toBeInstanceOf(ConnectorSecretDecryptUseError);
    expect(String(err?.message) + String(err?.stack ?? "")).not.toContain("MUSTNOTLEAK");
  });

  it("fail-closed: a store that throws (its error body carries the sentinel) never surfaces it", async () => {
    const kp = inMemoryKeyProvider();
    const { store } = fakeReadStore({ throws: true });
    const cap = acquireRunnerDecryptCapability({ runnerEnv: RUNNER_RUNTIME_MARKER, keyProvider: kp })!;
    let err: Error | undefined;
    await runnerDecryptAndUse(cap, { context: ctx(), store, kekId: KEK }).catch((e) => (err = e as Error));
    expect(err).toBeInstanceOf(ConnectorSecretDecryptUseError);
    expect(String(err?.message) + String(err?.stack ?? "")).not.toContain("MUSTNOTLEAK");
  });

  it("NEVER logs the plaintext across success and every failure path", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const kp = inMemoryKeyProvider();
      const cap = acquireRunnerDecryptCapability({ runnerEnv: RUNNER_RUNTIME_MARKER, keyProvider: kp })!;
      await runnerDecryptAndUse(cap, { context: ctx(), store: fakeReadStore({ row: await envelope(kp) }).store, kekId: KEK });
      await runnerDecryptAndUse(cap, { context: ctx(), store: fakeReadStore({ row: null }).store, kekId: KEK }).catch(() => {});
      await runnerDecryptAndUse(cap, { context: ctx(), store: fakeReadStore({ throws: true }).store, kekId: KEK }).catch(() => {});
      const printed = [...log.mock.calls, ...err.mock.calls].flat().join(" ");
      expect(printed).not.toContain("MUSTNOTLEAK");
    } finally { log.mockRestore(); err.mockRestore(); }
  });
});
