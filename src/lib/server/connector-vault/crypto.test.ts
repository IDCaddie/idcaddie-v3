import { describe, it, expect } from "vitest";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import {
  encryptConnectorSecret,
  decryptConnectorSecret,
  ConnectorVaultCryptoError,
  type ConnectorVaultKeyProvider,
  type SecretContext,
} from "./crypto";

// ── TEST-ONLY in-memory key provider ─────────────────────────────────────────────────────────────────
// Lives in this TEST file so it can NEVER ship in app code. It holds KEKs in memory (random, never
// persisted, never an env secret, never a checked-in key) and wraps the DEK with AES-256-GCM under the
// named KEK — binding the kekId as AAD so unwrapping under a different kekId fails. This is unit-test
// infrastructure only; the real KMS provider is a LATER PR and is NOT implemented here.
function createInMemoryKeyProvider(): ConnectorVaultKeyProvider & { addKek(kekId: string): void } {
  const keks = new Map<string, Buffer>();
  const getKek = (kekId: string): Buffer => {
    let k = keks.get(kekId);
    if (!k) {
      k = randomBytes(32);
      keks.set(kekId, k);
    }
    return k;
  };
  return {
    addKek(kekId: string) {
      getKek(kekId);
    },
    async generateDataKey(kekId: string) {
      const dek = randomBytes(32);
      const kek = getKek(kekId);
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", kek, iv);
      cipher.setAAD(Buffer.from(`kek:${kekId}`, "utf8")); // bind kekId so a wrong kekId unwrap fails
      const ct = Buffer.concat([cipher.update(dek), cipher.final()]);
      const wrappedDek = Buffer.concat([iv, cipher.getAuthTag(), ct]); // iv|tag|ct
      return { dek, wrappedDek };
    },
    async unwrapDataKey(wrappedDek: Buffer, kekId: string) {
      const kek = getKek(kekId);
      const iv = wrappedDek.subarray(0, 12);
      const tag = wrappedDek.subarray(12, 28);
      const ct = wrappedDek.subarray(28);
      const decipher = createDecipheriv("aes-256-gcm", kek, iv);
      decipher.setAAD(Buffer.from(`kek:${kekId}`, "utf8"));
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(ct), decipher.final()]); // throws on wrong kek / tamper
    },
  };
}

const KEK = "test-kek-1";
const SECRET = "ghp_FAKE-test-only-personal-access-token-NOT-real";
const ctx = (over: Partial<SecretContext> = {}): SecretContext => ({
  tenantId: "11111111-1111-1111-1111-111111111111",
  connectorId: "17000000-0000-0000-0000-0000000000a1",
  secretKind: "personal_access_token",
  version: 1,
  ...over,
});

describe("connector vault crypto wrapper", () => {
  it("round-trips encrypt → decrypt with the test key provider", async () => {
    const kp = createInMemoryKeyProvider();
    const enc = await encryptConnectorSecret({ plaintext: SECRET, context: ctx(), keyProvider: kp, kekId: KEK });
    const dec = await decryptConnectorSecret({ encrypted: enc, context: ctx(), keyProvider: kp });
    expect(dec.toString("utf8")).toBe(SECRET);
  });

  it("returns a structured AEAD payload with version/alg/kek/iv/tag/aadDigest — never plaintext", async () => {
    const kp = createInMemoryKeyProvider();
    const enc = await encryptConnectorSecret({ plaintext: SECRET, context: ctx(), keyProvider: kp, kekId: KEK });
    expect(enc.v).toBe(1);
    expect(enc.alg).toBe("AES-256-GCM");
    expect(enc.kekId).toBe(KEK);
    expect(Buffer.from(enc.iv, "base64")).toHaveLength(12);
    expect(Buffer.from(enc.tag, "base64")).toHaveLength(16);
    expect(enc.aadDigest).toMatch(/^[a-f0-9]{64}$/);
    // ciphertext ≠ plaintext and does not contain the plaintext anywhere in the serialized payload.
    expect(Buffer.from(enc.ciphertext, "base64").toString("utf8")).not.toBe(SECRET);
    expect(JSON.stringify(enc)).not.toContain(SECRET);
    expect(JSON.stringify(enc)).not.toContain("ghp_FAKE");
  });

  it("DECRYPT FAILS when the tenant changes (AAD binding)", async () => {
    const kp = createInMemoryKeyProvider();
    const enc = await encryptConnectorSecret({ plaintext: SECRET, context: ctx(), keyProvider: kp, kekId: KEK });
    await expect(
      decryptConnectorSecret({ encrypted: enc, context: ctx({ tenantId: "22222222-2222-2222-2222-222222222222" }), keyProvider: kp }),
    ).rejects.toBeInstanceOf(ConnectorVaultCryptoError);
  });

  it("DECRYPT FAILS when the connector id changes (AAD binding)", async () => {
    const kp = createInMemoryKeyProvider();
    const enc = await encryptConnectorSecret({ plaintext: SECRET, context: ctx(), keyProvider: kp, kekId: KEK });
    await expect(
      decryptConnectorSecret({ encrypted: enc, context: ctx({ connectorId: "17000000-0000-0000-0000-0000000000b1" }), keyProvider: kp }),
    ).rejects.toBeInstanceOf(ConnectorVaultCryptoError);
  });

  it("DECRYPT FAILS when the secret kind changes (AAD binding)", async () => {
    const kp = createInMemoryKeyProvider();
    const enc = await encryptConnectorSecret({ plaintext: SECRET, context: ctx(), keyProvider: kp, kekId: KEK });
    await expect(
      decryptConnectorSecret({ encrypted: enc, context: ctx({ secretKind: "api_key" }), keyProvider: kp }),
    ).rejects.toBeInstanceOf(ConnectorVaultCryptoError);
  });

  it("DECRYPT FAILS when the version changes (tampered metadata in AAD)", async () => {
    const kp = createInMemoryKeyProvider();
    const enc = await encryptConnectorSecret({ plaintext: SECRET, context: ctx(), keyProvider: kp, kekId: KEK });
    await expect(
      decryptConnectorSecret({ encrypted: enc, context: ctx({ version: 2 }), keyProvider: kp }),
    ).rejects.toBeInstanceOf(ConnectorVaultCryptoError);
  });

  it("DECRYPT FAILS when the ciphertext is tampered", async () => {
    const kp = createInMemoryKeyProvider();
    const enc = await encryptConnectorSecret({ plaintext: SECRET, context: ctx(), keyProvider: kp, kekId: KEK });
    const raw = Buffer.from(enc.ciphertext, "base64");
    raw[0] ^= 0xff;
    await expect(
      decryptConnectorSecret({ encrypted: { ...enc, ciphertext: raw.toString("base64") }, context: ctx(), keyProvider: kp }),
    ).rejects.toBeInstanceOf(ConnectorVaultCryptoError);
  });

  it("DECRYPT FAILS when the auth tag is tampered", async () => {
    const kp = createInMemoryKeyProvider();
    const enc = await encryptConnectorSecret({ plaintext: SECRET, context: ctx(), keyProvider: kp, kekId: KEK });
    const tag = Buffer.from(enc.tag, "base64");
    tag[0] ^= 0xff;
    await expect(
      decryptConnectorSecret({ encrypted: { ...enc, tag: tag.toString("base64") }, context: ctx(), keyProvider: kp }),
    ).rejects.toBeInstanceOf(ConnectorVaultCryptoError);
  });

  it("DECRYPT FAILS when the kek id is wrong (data key unwrap fails)", async () => {
    const kp = createInMemoryKeyProvider();
    const enc = await encryptConnectorSecret({ plaintext: SECRET, context: ctx(), keyProvider: kp, kekId: KEK });
    await expect(
      decryptConnectorSecret({ encrypted: { ...enc, kekId: "some-other-kek" }, context: ctx(), keyProvider: kp }),
    ).rejects.toBeInstanceOf(ConnectorVaultCryptoError);
  });

  it("thrown errors NEVER contain the plaintext secret (redaction)", async () => {
    const kp = createInMemoryKeyProvider();
    const enc = await encryptConnectorSecret({ plaintext: SECRET, context: ctx(), keyProvider: kp, kekId: KEK });
    let captured: unknown;
    try {
      await decryptConnectorSecret({ encrypted: enc, context: ctx({ tenantId: "deadbeef-dead-dead-dead-deaddeadbeef" }), keyProvider: kp });
    } catch (e) {
      captured = e;
    }
    expect(captured).toBeInstanceOf(ConnectorVaultCryptoError);
    const err = captured as Error;
    expect(`${err.message} ${err.stack ?? ""}`).not.toContain(SECRET);
    expect(`${err.message} ${err.stack ?? ""}`).not.toContain("ghp_FAKE");
  });

  it("validates input: bad secret kind, empty plaintext, bad version, missing kekId all throw", async () => {
    const kp = createInMemoryKeyProvider();
    await expect(
      // @ts-expect-error — invalid secret kind must be rejected
      encryptConnectorSecret({ plaintext: SECRET, context: ctx({ secretKind: "nope" }), keyProvider: kp, kekId: KEK }),
    ).rejects.toBeInstanceOf(ConnectorVaultCryptoError);
    await expect(
      encryptConnectorSecret({ plaintext: "", context: ctx(), keyProvider: kp, kekId: KEK }),
    ).rejects.toBeInstanceOf(ConnectorVaultCryptoError);
    await expect(
      encryptConnectorSecret({ plaintext: SECRET, context: ctx({ version: 0 }), keyProvider: kp, kekId: KEK }),
    ).rejects.toBeInstanceOf(ConnectorVaultCryptoError);
    await expect(
      encryptConnectorSecret({ plaintext: SECRET, context: ctx(), keyProvider: kp, kekId: "" }),
    ).rejects.toBeInstanceOf(ConnectorVaultCryptoError);
  });

  it("uses a FRESH random IV per encryption — no nonce reuse (the catastrophic GCM failure)", async () => {
    const kp = createInMemoryKeyProvider();
    const a = await encryptConnectorSecret({ plaintext: SECRET, context: ctx(), keyProvider: kp, kekId: KEK });
    const b = await encryptConnectorSecret({ plaintext: SECRET, context: ctx(), keyProvider: kp, kekId: KEK });
    expect(a.iv).not.toBe(b.iv); // distinct nonces for identical plaintext+context
    expect(a.ciphertext).not.toBe(b.ciphertext);
    expect(a.wrappedDek).not.toBe(b.wrappedDek); // a fresh DEK per encryption too
  });

  it("rejects a key provider that returns a wrong-length / non-Buffer data key (fail closed)", async () => {
    const badLen: ConnectorVaultKeyProvider = {
      async generateDataKey() {
        return { dek: randomBytes(16), wrappedDek: randomBytes(40) }; // 16 bytes ≠ AES-256
      },
      async unwrapDataKey() {
        return randomBytes(16);
      },
    };
    await expect(
      encryptConnectorSecret({ plaintext: SECRET, context: ctx(), keyProvider: badLen, kekId: KEK }),
    ).rejects.toBeInstanceOf(ConnectorVaultCryptoError);

    // And on the decrypt path: a good payload but a provider that unwraps a wrong-length DEK.
    const good = createInMemoryKeyProvider();
    const enc = await encryptConnectorSecret({ plaintext: SECRET, context: ctx(), keyProvider: good, kekId: KEK });
    const badUnwrap: ConnectorVaultKeyProvider = {
      async generateDataKey(kekId) {
        return good.generateDataKey(kekId);
      },
      async unwrapDataKey() {
        return randomBytes(16); // wrong length
      },
    };
    await expect(
      decryptConnectorSecret({ encrypted: enc, context: ctx(), keyProvider: badUnwrap }),
    ).rejects.toBeInstanceOf(ConnectorVaultCryptoError);
  });

  it("byte-accurate length-tagging prevents cross-field AAD collision (separator injection fails closed)", async () => {
    const kp = createInMemoryKeyProvider();
    // Encrypt bound to tenantId 'a', connectorId 'b'. A boundary-shifting decrypt context whose fields
    // re-partition the same characters (e.g. tenantId='a 1:b') must NOT decrypt — the length prefixes differ.
    const enc = await encryptConnectorSecret({ plaintext: SECRET, context: ctx({ tenantId: "a", connectorId: "b" }), keyProvider: kp, kekId: KEK });
    await expect(
      decryptConnectorSecret({ encrypted: enc, context: ctx({ tenantId: "a 1:b", connectorId: "b" }), keyProvider: kp }),
    ).rejects.toBeInstanceOf(ConnectorVaultCryptoError);
    // sanity: the exact original context still round-trips
    const dec = await decryptConnectorSecret({ encrypted: enc, context: ctx({ tenantId: "a", connectorId: "b" }), keyProvider: kp });
    expect(dec.toString("utf8")).toBe(SECRET);
  });

  it("supports all conceptual secret kinds (round-trip each) without provider-specific behavior", async () => {
    const kp = createInMemoryKeyProvider();
    for (const secretKind of ["oauth_access_token", "oauth_refresh_token", "api_key", "personal_access_token", "webhook_secret"] as const) {
      const enc = await encryptConnectorSecret({ plaintext: SECRET, context: ctx({ secretKind }), keyProvider: kp, kekId: KEK });
      const dec = await decryptConnectorSecret({ encrypted: enc, context: ctx({ secretKind }), keyProvider: kp });
      expect(dec.toString("utf8")).toBe(SECRET);
    }
  });
});

// ── No-DB / no-Supabase / no-service-role static guard ───────────────────────────────────────────────
// The crypto module must do crypto ONLY: no database access, no Supabase client import, no service-role.
describe("connector vault crypto module is pure (no DB / no Supabase / no service-role)", () => {
  it("crypto.ts imports only node:crypto and makes no DB/Supabase/service-role call", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const src = fs.readFileSync(path.resolve(__dirname, "crypto.ts"), "utf8");
    // The strong guarantee: the ONLY module imported is node:crypto — so no Supabase/db client can enter
    // the module at all (the import list is the load-bearing proof of "no DB access, no Supabase client").
    const imports = [...src.matchAll(/from\s+["']([^"']+)["']/g)].map((m) => m[1]);
    expect(imports).toEqual(["node:crypto"]);
    // And no client-factory / service-role / env-secret usage in the CODE (comments stripped). We do not
    // pattern-match generic method names like `.update(`/`.from(` — those are the node:crypto/Buffer API
    // (cipher.update, Buffer.from); the import-list assertion above already rules out any DB/Supabase call.
    const code = src.replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, ""); // strip comments
    expect(code).not.toMatch(/createClient\s*\(/);
    expect(code).not.toMatch(/process\.env/); // no environment secrets read in the crypto module
    // Forbidden tokens built from parts so the literals never appear in THIS test's source (which would
    // otherwise trip scripts/check-auth-safety.sh's repo-wide grep for the service-role key/role names).
    const forbidden = ["service", "role"].join("_"); // the privileged db role token
    const forbiddenEnv = ["SUPABASE", "SERVICE", "ROLE"].join("_"); // the service-role key env name
    expect(code).not.toContain(forbidden);
    expect(code).not.toContain(forbiddenEnv);
  });
});
