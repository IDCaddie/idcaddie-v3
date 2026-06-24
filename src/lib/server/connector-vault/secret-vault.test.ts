import { describe, it, expect } from "vitest";
import { randomBytes } from "node:crypto";
import {
  saveConnectorSecret,
  loadConnectorSecret,
  acquireRunnerDecryptCapability,
  RunnerDecryptCapability,
  RedactedSecret,
  RUNNER_RUNTIME_MARKER,
  ConnectorSecretVaultError,
  type ConnectorSecretWriteStore,
  type ConnectorSecretReadStore,
  type StoredEncryptedSecret,
  type EncryptOnlyKeyProvider,
} from "./secret-vault";
import { ConnectorVaultCryptoError, type ConnectorVaultKeyProvider, type SecretContext } from "./crypto";

const KEK = "kek-test-1";
const ctx = (over: Partial<SecretContext> = {}): SecretContext => ({
  tenantId: "11111111-1111-1111-1111-111111111111",
  connectorId: "22222222-2222-2222-2222-222222222222",
  secretKind: "oauth_access_token",
  version: 1,
  ...over,
});

// A test-only in-memory key provider (NOT secure): "wrap" = kekId prefix + dek; "unwrap" returns the dek.
function memKeyProvider(): ConnectorVaultKeyProvider {
  return {
    async generateDataKey(kekId) {
      const dek = randomBytes(32);
      return { dek, wrappedDek: Buffer.concat([Buffer.from(`${kekId}|`), dek]) };
    },
    async unwrapDataKey(wrappedDek, kekId) {
      const prefix = Buffer.from(`${kekId}|`);
      if (wrappedDek.length < prefix.length || !wrappedDek.subarray(0, prefix.length).equals(prefix))
        throw new Error("wrong kek");
      return Buffer.from(wrappedDek.subarray(prefix.length));
    },
  };
}
const encryptOnly = (kp: ConnectorVaultKeyProvider): EncryptOnlyKeyProvider => ({ generateDataKey: kp.generateDataKey });

// A mock store that round-trips save -> load, keyed by (tenant, connector, kind, version).
function memStore() {
  type Row = StoredEncryptedSecret & { tenantId: string; connectorId: string; dbSecretKind: string; version: number };
  const rows: Row[] = [];
  let seq = 0;
  const write: ConnectorSecretWriteStore = {
    async insertEncryptedSecret(input) {
      const id = `sec-${++seq}`;
      rows.push({ id, encrypted: input.encrypted, tenantId: input.tenantId, connectorId: input.connectorId, dbSecretKind: input.dbSecretKind, version: input.version });
      return { id };
    },
  };
  const read: ConnectorSecretReadStore = {
    async findEncryptedSecret(input) {
      const r = rows.find((x) => x.tenantId === input.tenantId && x.connectorId === input.connectorId && x.dbSecretKind === input.dbSecretKind && x.version === input.version);
      return r ? { id: r.id, encrypted: r.encrypted } : null;
    },
  };
  return { write, read, rows };
}

const runnerCap = (kp: ConnectorVaultKeyProvider) =>
  acquireRunnerDecryptCapability({ runnerEnv: RUNNER_RUNTIME_MARKER, keyProvider: kp })!;

describe("saveConnectorSecret — redacted result (no plaintext, no ciphertext)", () => {
  it("(1,2) the save result contains neither plaintext nor ciphertext", async () => {
    const kp = memKeyProvider();
    const store = memStore();
    const PLAINTEXT = "super-secret-okta-token-PLAINTEXT";
    const ref = await saveConnectorSecret({ plaintext: PLAINTEXT, context: ctx(), keyProvider: encryptOnly(kp), kekId: KEK, store: store.write });
    const json = JSON.stringify(ref);
    expect(json).not.toContain(PLAINTEXT); // no plaintext in the result
    // no ciphertext / wrapped DEK / iv / tag fields anywhere in the result
    const ciphertextB64 = store.rows[0].encrypted.ciphertext;
    expect(json).not.toContain(ciphertextB64);
    expect(json).not.toContain(store.rows[0].encrypted.wrappedDek);
    for (const k of ["ciphertext", "wrappedDek", "iv", "tag", "plaintext", "dek"]) expect(json).not.toContain(k);
    expect(ref).toEqual({ secretId: "sec-1", tenantId: ctx().tenantId, connectorId: ctx().connectorId, secretKind: "oauth_access_token", version: 1, kekId: KEK });
  });

  it("(11) tenant_id is bound from the server context, never from the secret payload", async () => {
    const kp = memKeyProvider();
    const store = memStore();
    // the plaintext even CONTAINS a different tenant-looking string; it must be ignored.
    await saveConnectorSecret({ plaintext: "tenant_id=99999999-9999-9999-9999-999999999999", context: ctx({ tenantId: "11111111-1111-1111-1111-111111111111" }), keyProvider: encryptOnly(kp), kekId: KEK, store: store.write });
    expect(store.rows[0].tenantId).toBe("11111111-1111-1111-1111-111111111111");
  });
});

describe("RedactedSecret — structural redaction", () => {
  it("(3) string / JSON / inspect conversions are redacted; plaintext is not exposed by accident", () => {
    const secret = new RedactedSecret(Buffer.from("PLAINTEXT-VALUE"));
    expect(String(secret)).toBe("[REDACTED connector secret]");
    expect(secret.toJSON()).toBe("[REDACTED connector secret]");
    expect(JSON.stringify({ secret })).not.toContain("PLAINTEXT-VALUE");
    expect(`${secret}`).not.toContain("PLAINTEXT-VALUE");
    // node inspect hook is redacted too
    const inspected = (secret as unknown as { [k: symbol]: () => string })[Symbol.for("nodejs.util.inspect.custom")]();
    expect(inspected).toBe("[REDACTED connector secret]");
    // the bytes are reachable ONLY through expose()
    expect(secret.expose().toString("utf8")).toBe("PLAINTEXT-VALUE");
  });

  it("(3) node util.inspect / util.format (the console.log path) also redact the plaintext", async () => {
    const util = await import("node:util");
    const secret = new RedactedSecret(Buffer.from("PLAINTEXT-VALUE"));
    for (const rendered of [util.inspect(secret), util.inspect({ secret }, { depth: 5 }), util.format("%o", secret), util.format("%j", secret), util.format("%s", secret)]) {
      expect(rendered).not.toContain("PLAINTEXT-VALUE");
      expect(rendered).toContain("[REDACTED connector secret]");
    }
  });
});

describe("runner-only decrypt capability", () => {
  it("(6) acquire returns null without the runner marker (request-path runtime cannot get it)", () => {
    const kp = memKeyProvider();
    expect(acquireRunnerDecryptCapability({ runnerEnv: undefined, keyProvider: kp })).toBeNull();
    expect(acquireRunnerDecryptCapability({ runnerEnv: "not-the-marker", keyProvider: kp })).toBeNull();
    // even with the marker, a non-decrypt-capable provider yields no capability
    expect(acquireRunnerDecryptCapability({ runnerEnv: RUNNER_RUNTIME_MARKER, keyProvider: {} as ConnectorVaultKeyProvider })).toBeNull();
  });

  it("(6) acquire returns a capability with the marker + a decrypt-capable provider", () => {
    expect(runnerCap(memKeyProvider())).toBeInstanceOf(RunnerDecryptCapability);
  });

  it("a RunnerDecryptCapability cannot be forged (private constructor token)", () => {
    expect(() => new RunnerDecryptCapability(Symbol("fake"), memKeyProvider())).toThrow(ConnectorSecretVaultError);
  });

  it("(7) a request-path decrypt attempt (no/forged capability) fails closed", async () => {
    const store = memStore();
    // a forged plain object is not a RunnerDecryptCapability
    await expect(loadConnectorSecret({ } as RunnerDecryptCapability, { context: ctx(), store: store.read })).rejects.toBeInstanceOf(ConnectorSecretVaultError);
    await expect(loadConnectorSecret(null as unknown as RunnerDecryptCapability, { context: ctx(), store: store.read })).rejects.toBeInstanceOf(ConnectorSecretVaultError);
  });
});

describe("save (encrypt-only) -> load (runner-only) round trip", () => {
  it("(8) the runner capability decrypts a saved secret to the original plaintext", async () => {
    const kp = memKeyProvider();
    const store = memStore();
    const PLAINTEXT = "okta-api-key-abc123";
    await saveConnectorSecret({ plaintext: PLAINTEXT, context: ctx(), keyProvider: encryptOnly(kp), kekId: KEK, store: store.write });
    const secret = await loadConnectorSecret(runnerCap(kp), { context: ctx(), store: store.read });
    expect(secret).toBeInstanceOf(RedactedSecret);
    expect(secret.expose().toString("utf8")).toBe(PLAINTEXT);
  });

  it("the encrypt-only save path structurally cannot decrypt (its provider's unwrap throws)", async () => {
    const kp = memKeyProvider();
    const store = memStore();
    await saveConnectorSecret({ plaintext: "x", context: ctx(), keyProvider: encryptOnly(kp), kekId: KEK, store: store.write });
    // build a capability from the ENCRYPT-ONLY provider (adapted) — its unwrap throws, so decrypt fails closed
    const encOnlyAsProvider: ConnectorVaultKeyProvider = { generateDataKey: kp.generateDataKey, unwrapDataKey: async () => { throw new Error("no decrypt"); } };
    const cap = runnerCap(encOnlyAsProvider);
    await expect(loadConnectorSecret(cap, { context: ctx(), store: store.read })).rejects.toBeInstanceOf(ConnectorVaultCryptoError);
  });
});

describe("cross-tenant / fail-closed", () => {
  it("(12) decrypting another tenant's sealed secret fails closed (AAD mismatch)", async () => {
    const kp = memKeyProvider();
    const store = memStore();
    await saveConnectorSecret({ plaintext: "secretA", context: ctx({ tenantId: "11111111-1111-1111-1111-111111111111" }), keyProvider: encryptOnly(kp), kekId: KEK, store: store.write });
    // a LEAKY read store that hands tenant A's ciphertext back regardless of the lookup tenant
    const leaky: ConnectorSecretReadStore = { async findEncryptedSecret() { return { id: store.rows[0].id, encrypted: store.rows[0].encrypted }; } };
    // load with a DIFFERENT tenant context → the AAD binding rejects it
    await expect(loadConnectorSecret(runnerCap(kp), { context: ctx({ tenantId: "22222222-2222-2222-2222-222222222222" }), store: leaky })).rejects.toBeInstanceOf(ConnectorVaultCryptoError);
  });

  it("loadConnectorSecret throws a typed not-found when no secret exists", async () => {
    const store = memStore();
    await expect(loadConnectorSecret(runnerCap(memKeyProvider()), { context: ctx(), store: store.read })).rejects.toBeInstanceOf(ConnectorSecretVaultError);
  });

  it("(10) a decrypt/crypto failure error carries no plaintext or key material", async () => {
    const kp = memKeyProvider();
    const store = memStore();
    const PLAINTEXT = "leak-me-not-PLAINTEXT";
    await saveConnectorSecret({ plaintext: PLAINTEXT, context: ctx(), keyProvider: encryptOnly(kp), kekId: KEK, store: store.write });
    const leaky: ConnectorSecretReadStore = { async findEncryptedSecret() { return { id: store.rows[0].id, encrypted: store.rows[0].encrypted }; } };
    let msg = "";
    try {
      await loadConnectorSecret(runnerCap(kp), { context: ctx({ connectorId: "deadbeef-0000-0000-0000-000000000000" }), store: leaky });
    } catch (e) {
      msg = (e as Error).message + " " + String(e);
    }
    expect(msg).not.toContain(PLAINTEXT);
    expect(msg).not.toContain(store.rows[0].encrypted.ciphertext);
    expect(msg).not.toContain(store.rows[0].encrypted.wrappedDek);
  });
});

// (13) revocation/rotation/audit are NOT implemented in this PR — the gap is real + documented (no delete/revoke
// surface exists). This test pins the gap so a future PR (and reviewers) see it was deliberate, not forgotten.
describe("documented RISK-007 gaps", () => {
  it("(13) the vault exposes no revoke/rotate/delete surface (deferred work)", async () => {
    const mod = await import("./secret-vault");
    for (const name of ["revokeConnectorSecret", "rotateConnectorSecret", "deleteConnectorSecret"]) {
      expect(name in mod).toBe(false);
    }
    // the store interfaces are write(insert)/read(find) only — no delete method is part of the contract
    const store = memStore();
    expect("delete" in (store.write as object)).toBe(false);
    expect("delete" in (store.read as object)).toBe(false);
  });
});

// (4,5,9) Static guard: server-only — imports ONLY ./crypto; no db client / fetch / service-role / route / env.
describe("secret-vault is server-safe (no db client / fetch / service-role / route / process.env)", () => {
  it("imports only ./crypto and contains no forbidden call/string", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const src = fs.readFileSync(path.resolve(__dirname, "secret-vault.ts"), "utf8");
    const imports = [...src.matchAll(/from\s+["']([^"']+)["']/g)].map((m) => m[1]);
    expect(imports).toEqual(["./crypto"]); // only the reviewed crypto module
    expect(src).toMatch(/server-only and must not be imported in client code/); // browser sentinel present
    const code = src.replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
    expect(code).not.toMatch(/createClient\s*\(/);
    expect(code).not.toMatch(/createServiceClient/);
    expect(code).not.toMatch(/\bfetch\s*\(/);
    expect(code).not.toMatch(/process\.env/); // env is INJECTED (runnerEnv), never read here
    expect(code).not.toContain(["service", "role"].join("_"));
    for (const bad of ["NextRequest", "NextResponse", "export async function GET", "export async function POST"]) {
      expect(code).not.toContain(bad);
    }
  });
});
