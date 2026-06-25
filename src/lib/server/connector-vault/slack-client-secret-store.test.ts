import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { randomBytes } from "node:crypto";
import {
  saveSlackClientSecret,
  withSlackClientSecret,
  createRunnerAppSecretStore,
  SlackClientSecretStoreError,
  type AppSecretEnvelopeStore,
} from "./slack-client-secret-store";
import { encryptAppSecret, decryptAppSecret, type ConnectorVaultKeyProvider, type EncryptedConnectorSecret } from "./crypto";
import type { RunnerConnection } from "./runner-db-client";

// B2c-secret: the vault-grade APP-SCOPED Slack client-secret store. Synthetic only. A DETECTABLE marked sentinel
// (NOT a realistic client secret) so the no-leak assertions prove a real secret could not survive into any output.
const SENTINEL = "MUSTNOTLEAK-slack-client-secret-b2c-sentinel";
const KEK = "kek-staging-app-1";

// Synthetic KMS: generateDataKey + unwrapDataKey (the decrypt capability). `failUnwrap` models an identity WITHOUT
// kms:Decrypt (e.g. the web/request identity) — it cannot unwrap, so it cannot decrypt.
const memKeyProvider = (opts: { failUnwrap?: boolean } = {}): ConnectorVaultKeyProvider => ({
  async generateDataKey(kekId) { const dek = randomBytes(32); return { dek, wrappedDek: Buffer.concat([Buffer.from(`${kekId}|`), dek]) }; },
  async unwrapDataKey(wrappedDek, kekId) {
    if (opts.failUnwrap) throw new Error("kms:Decrypt denied for this identity");
    const prefix = Buffer.from(`${kekId}|`);
    if (wrappedDek.length < prefix.length || !wrappedDek.subarray(0, prefix.length).equals(prefix)) throw new Error("wrong KEK");
    return wrappedDek.subarray(prefix.length);
  },
});
const kp = memKeyProvider();

// In-memory faithful AppSecretEnvelopeStore — captures the at-rest envelope (to prove no plaintext) + latest-version load.
const memStore = () => {
  const rows: { appEnv: string; provider: string; secretKind: string; version: number; encrypted: EncryptedConnectorSecret }[] = [];
  const store: AppSecretEnvelopeStore = {
    async insertEnvelope(row) { rows.push({ ...row }); return { secretId: `appsec-${rows.length}` }; },
    async loadActiveEnvelope(q) {
      const m = rows.filter((r) => r.appEnv === q.appEnv && r.provider === q.provider && r.secretKind === q.secretKind);
      if (!m.length) return null;
      const latest = m.reduce((a, b) => (b.version > a.version ? b : a));
      return { version: latest.version, encrypted: latest.encrypted };
    },
  };
  return { store, rows };
};

let consoleDump: string[];
beforeEach(() => {
  consoleDump = [];
  for (const m of ["log", "info", "warn", "error", "debug"] as const) vi.spyOn(console, m).mockImplementation((...a: unknown[]) => { consoleDump.push(a.map(String).join(" ")); });
});
afterEach(() => vi.restoreAllMocks());
const noLeak = (dump: string) => { expect(dump).not.toContain(SENTINEL); expect(dump).not.toContain("MUSTNOTLEAK"); };
const ctx = (over = {}) => ({ appEnv: "staging", provider: "slack", secretKind: "oauth_client_secret" as const, version: 1, ...over });

describe("B2c-secret crypto — app-scope AAD binding (no tenant_id); cross-identity fails closed", () => {
  it("round-trips under the SAME app-scope identity", async () => {
    const enc = await encryptAppSecret({ plaintext: SENTINEL, context: ctx(), keyProvider: kp, kekId: KEK });
    expect(JSON.stringify(enc)).not.toContain(SENTINEL); // envelope is ciphertext only
    const pt = await decryptAppSecret({ encrypted: enc, context: ctx(), keyProvider: kp });
    expect(pt.toString("utf8")).toBe(SENTINEL);
  });
  it("a staging ciphertext does NOT decrypt as production (appEnv bound in AAD)", async () => {
    const enc = await encryptAppSecret({ plaintext: SENTINEL, context: ctx({ appEnv: "staging" }), keyProvider: kp, kekId: KEK });
    await expect(decryptAppSecret({ encrypted: enc, context: ctx({ appEnv: "production" }), keyProvider: kp })).rejects.toBeTruthy();
  });
  it("a ciphertext for one provider/kind/version does NOT decrypt under another", async () => {
    const enc = await encryptAppSecret({ plaintext: SENTINEL, context: ctx({ version: 1, provider: "slack" }), keyProvider: kp, kekId: KEK });
    await expect(decryptAppSecret({ encrypted: enc, context: ctx({ version: 2 }), keyProvider: kp })).rejects.toBeTruthy();
    await expect(decryptAppSecret({ encrypted: enc, context: ctx({ provider: "okta" }), keyProvider: kp })).rejects.toBeTruthy();
  });
});

describe("B2c-secret store — envelope only, no plaintext at rest, redacted ref", () => {
  it("saves the synthetic secret as an envelope; the row + return value carry NO plaintext", async () => {
    const { store, rows } = memStore();
    const ref = await saveSlackClientSecret({ plaintext: SENTINEL, appEnv: "staging", version: 1 }, { keyProvider: kp, kekId: KEK, store });
    expect(ref).toEqual({ secretId: "appsec-1" });
    expect(JSON.stringify(ref)).not.toContain(SENTINEL);
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows)).not.toContain(SENTINEL); // the stored envelope has no plaintext
    expect(rows[0].provider).toBe("slack");
    expect(rows[0].secretKind).toBe("oauth_client_secret");
  });
});

describe("B2c-secret decrypt boundary — withSlackClientSecret: plaintext reaches ONLY the use callback", () => {
  const save = async (store: AppSecretEnvelopeStore, appEnv = "staging", version = 1) =>
    saveSlackClientSecret({ plaintext: SENTINEL, appEnv, version }, { keyProvider: kp, kekId: KEK, store });

  it("decrypts the sentinel ONLY into the use callback; returns the callback's REDACTED result (no secret)", async () => {
    const { store } = memStore();
    await save(store);
    let received: string | undefined;
    const result = await withSlackClientSecret({ appEnv: "staging" }, { keyProvider: kp, store }, async (secret) => {
      received = secret;
      return { exchanged: true, ref: "redacted-ref" }; // a synthetic exchange callback's redacted result
    });
    expect(result).toEqual({ ok: true, value: { exchanged: true, ref: "redacted-ref" } });
    expect(received).toBe(SENTINEL); // the plaintext reached the exchange callback...
    noLeak(JSON.stringify({ result, console: consoleDump })); // ...and appears in NO result/log
  });
  it("a forced exchange failure AFTER decrypt (use throws with the secret embedded) does NOT leak it", async () => {
    const { store } = memStore();
    await save(store);
    let result: unknown, thrown: unknown;
    try {
      result = await withSlackClientSecret({ appEnv: "staging" }, { keyProvider: kp, store }, async (secret) => { throw new Error(`exchange boom ${secret}`); });
    } catch (e) { thrown = e; }
    expect(result).toEqual({ ok: false, reason: "use_failed" }); // fail closed, NOT a thrown secret
    noLeak(JSON.stringify({ result, thrown: thrown instanceof Error ? thrown.message : thrown, console: consoleDump }));
  });
  it("the plaintext buffer is WIPED even when the exchange callback THROWS (cleanup runs in finally, not only on success)", async () => {
    const { store } = memStore();
    await save(store);
    // Capture the pre-wipe content of EVERY buffer that .fill() touches during the run; the real fill still zeroes it.
    const wiped: string[] = [];
    const realFill = Buffer.prototype.fill;
    const spy = vi.spyOn(Buffer.prototype, "fill").mockImplementation(function (this: Buffer, ...args: unknown[]) {
      wiped.push(this.toString("utf8")); // content BEFORE the real wipe zeroes it
      return (realFill as (...a: unknown[]) => Buffer).apply(this, args);
    });
    const result = await withSlackClientSecret({ appEnv: "staging" }, { keyProvider: kp, store }, async (secret) => { throw new Error(`boom ${secret}`); });
    spy.mockRestore();
    expect(result).toEqual({ ok: false, reason: "use_failed" }); // failure path
    // wipe-ATTEMPTED on the failure path: the buffer holding the plaintext sentinel was filled (its lifetime was
    // bounded even though the callback threw). Would FAIL if the wipe were only after a successful callback.
    expect(wiped).toContain(SENTINEL);
  });
  it("an identity WITHOUT kms:Decrypt (web/request-like) cannot decrypt — fails closed", async () => {
    const { store } = memStore();
    await save(store);
    const result = await withSlackClientSecret({ appEnv: "staging" }, { keyProvider: memKeyProvider({ failUnwrap: true }), store }, async (s) => s);
    expect(result).toEqual({ ok: false, reason: "decrypt_failed" });
    noLeak(JSON.stringify({ result, console: consoleDump }));
  });
  it("a staging-sealed envelope cannot be used under a production identity (AAD env binding at the boundary)", async () => {
    const { store } = memStore();
    await save(store, "staging", 1);
    // a tricked store returns the STAGING envelope even when the boundary asks as production:
    const trick: AppSecretEnvelopeStore = { ...store, loadActiveEnvelope: async () => store.loadActiveEnvelope({ appEnv: "staging", provider: "slack", secretKind: "oauth_client_secret" }) };
    const result = await withSlackClientSecret({ appEnv: "production" }, { keyProvider: kp, store: trick }, async (s) => s);
    expect(result).toEqual({ ok: false, reason: "decrypt_failed" }); // sealed staging, opened production → AAD mismatch
  });
  it("no envelope → not_found (no decrypt attempted)", async () => {
    const { store } = memStore();
    const result = await withSlackClientSecret({ appEnv: "staging" }, { keyProvider: kp, store }, async (s) => s);
    expect(result).toEqual({ ok: false, reason: "not_found" });
  });
  it("a missing use callback / appEnv fails loud (precondition)", async () => {
    const { store } = memStore();
    await expect(withSlackClientSecret({ appEnv: "" }, { keyProvider: kp, store }, async (s) => s)).rejects.toBeInstanceOf(SlackClientSecretStoreError);
    // @ts-expect-error — missing use
    await expect(withSlackClientSecret({ appEnv: "staging" }, { keyProvider: kp, store }, undefined)).rejects.toBeInstanceOf(SlackClientSecretStoreError);
  });
});

describe("B2c-secret runner-backed store — SET ROLE connector_runner + granted columns + no plaintext in SQL params", () => {
  const captureConn = () => {
    const statements: { sql: string; params: readonly unknown[] }[] = [];
    const conn: RunnerConnection = {
      async runSequence(stmts) {
        const results: { rows: ReadonlyArray<Record<string, unknown>> }[] = [];
        for (const s of stmts) {
          statements.push({ sql: s.sql, params: s.params });
          if (/insert\s+into\s+public\.connector_app_secrets/i.test(s.sql)) results.push({ rows: [{ id: "appsec-row-1" }] });
          else results.push({ rows: [] });
        }
        return results;
      },
    };
    return { conn, statements };
  };
  it("INSERT goes under SET ROLE, targets connector_app_secrets, and carries ciphertext (not the plaintext)", async () => {
    const c = captureConn();
    const ref = await saveSlackClientSecret({ plaintext: SENTINEL, appEnv: "staging", version: 1 }, { keyProvider: kp, kekId: KEK, store: createRunnerAppSecretStore(c.conn) });
    expect(ref).toEqual({ secretId: "appsec-row-1" });
    expect(c.statements[0].sql).toMatch(/^set role connector_runner$/i); // runner identity
    expect(c.statements[1].sql).toMatch(/insert into public\.connector_app_secrets/i);
    // serialize the params (Buffers -> hex) and prove the plaintext sentinel never appears.
    const wire = JSON.stringify(c.statements, (_k, v) => (v?.type === "Buffer" ? Buffer.from(v.data).toString("hex") : v));
    expect(wire).not.toContain(SENTINEL);
    expect(wire).not.toContain("MUSTNOTLEAK");
  });
  it("round-trips through the runner store (load reconstructs the envelope; withSlackClientSecret decrypts it)", async () => {
    // capture the INSERT, then serve it back from a SELECT to prove the bytea<->envelope mapping round-trips.
    const enc = await encryptAppSecret({ plaintext: SENTINEL, context: ctx(), keyProvider: kp, kekId: KEK });
    const conn: RunnerConnection = {
      async runSequence(stmts) {
        return stmts.map((s) => {
          if (/select .* from public\.connector_app_secrets/i.test(s.sql))
            return { rows: [{ id: "r1", version: 1, ciphertext: Buffer.from(enc.ciphertext, "base64"), dek_wrapped: Buffer.from(enc.wrappedDek, "base64"), aead_nonce: Buffer.from(enc.iv, "base64"), aead_tag: Buffer.from(enc.tag, "base64"), aad_digest: enc.aadDigest, kek_id: enc.kekId, envelope_version: enc.v, aead_alg: enc.alg }] };
          return { rows: [] };
        });
      },
    };
    let received: string | undefined;
    const result = await withSlackClientSecret({ appEnv: "staging" }, { keyProvider: kp, store: createRunnerAppSecretStore(conn) }, async (secret) => { received = secret; return "ok"; });
    expect(result).toEqual({ ok: true, value: "ok" });
    expect(received).toBe(SENTINEL);
  });
});

describe("B2c-secret — no generic plaintext-returning API (the decrypt boundary is the only path)", () => {
  it("the module exports no loadClientSecret/getClientSecret-style API; source has no plaintext return", async () => {
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const src = readFileSync(fileURLToPath(new URL("./slack-client-secret-store.ts", import.meta.url)), "utf8");
    expect(src).not.toMatch(/export\s+(async\s+)?function\s+(load|get|read|fetch)\w*ClientSecret/i);
    expect(src).toMatch(/server-only and must not be imported in client code/);
    const code = src.replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
    for (const bad of ["process.env", "NextRequest", "NextResponse"]) expect(code).not.toContain(bad);
  });
});
