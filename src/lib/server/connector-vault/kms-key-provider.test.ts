import { describe, it, expect, afterEach } from "vitest";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import {
  createKmsKeyProvider,
  kmsKeyProviderConfigFromEnv,
  ConnectorVaultKeyProviderError,
  type KmsClient,
} from "./kms-key-provider";
import {
  encryptConnectorSecret,
  decryptConnectorSecret,
  type SecretContext,
} from "./crypto";

// ── Test-only in-memory fake KmsClient (NO AWS/GCP SDK, NO network, NO real credential) ───────────────
// Models an envelope KMS: each KEK id maps to a random in-process 32-byte key; generateDataKey returns a
// random DEK + the DEK AES-256-GCM-wrapped under the KEK (kekId bound as AAD so a wrong KEK fails). It can
// hold MULTIPLE KEK ids to simulate rotation (current + previous). The KEK never leaves the fake.
function createInMemoryKmsClient(kekIds: string[]): KmsClient {
  const keks = new Map<string, Buffer>();
  for (const id of kekIds) keks.set(id, randomBytes(32));
  const kek = (kekId: string): Buffer => {
    const k = keks.get(kekId);
    if (!k) throw new Error("fake KMS: no such KEK"); // the real KMS would reject an unknown key id too
    return k;
  };
  return {
    async generateDataKey(kekId) {
      const dek = randomBytes(32);
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", kek(kekId), iv);
      cipher.setAAD(Buffer.from(`kek:${kekId}`, "utf8"));
      const ct = Buffer.concat([cipher.update(dek), cipher.final()]);
      return { dek, wrappedDek: Buffer.concat([iv, cipher.getAuthTag(), ct]) }; // iv|tag|ct
    },
    async decrypt(wrappedDek, kekId) {
      const iv = wrappedDek.subarray(0, 12);
      const tag = wrappedDek.subarray(12, 28);
      const ct = wrappedDek.subarray(28);
      const decipher = createDecipheriv("aes-256-gcm", kek(kekId), iv);
      decipher.setAAD(Buffer.from(`kek:${kekId}`, "utf8"));
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(ct), decipher.final()]); // throws on wrong KEK / tamper
    },
  };
}

const K1 = "alias/connector-vault-kek-v1";
const K2 = "alias/connector-vault-kek-v2";

describe("createKmsKeyProvider — config / fail-closed", () => {
  it("exposes the current + allowed KEK id metadata (non-secret)", () => {
    const kp = createKmsKeyProvider({ kmsClient: createInMemoryKmsClient([K1, K2]), currentKekId: K2, previousKekIds: [K1] });
    expect(kp.currentKekId).toBe(K2);
    expect([...kp.allowedKekIds]).toEqual([K2, K1]);
  });

  it("fails closed on missing config (no client / no current KEK id / null)", () => {
    // @ts-expect-error — null config must be rejected
    expect(() => createKmsKeyProvider(null)).toThrow(ConnectorVaultKeyProviderError);
    // @ts-expect-error — missing kmsClient
    expect(() => createKmsKeyProvider({ currentKekId: K1 })).toThrow(ConnectorVaultKeyProviderError);
    expect(() => createKmsKeyProvider({ kmsClient: createInMemoryKmsClient([K1]), currentKekId: "" })).toThrow(ConnectorVaultKeyProviderError);
  });
});

describe("createKmsKeyProvider — wrap / unwrap + rotation", () => {
  it("wraps a DEK under the current KEK and unwraps it back", async () => {
    const kp = createKmsKeyProvider({ kmsClient: createInMemoryKmsClient([K1]), currentKekId: K1 });
    const { dek, wrappedDek } = await kp.generateDataKey(K1);
    expect(dek.length).toBe(32);
    expect(wrappedDek.length).toBeGreaterThan(0);
    const back = await kp.unwrapDataKey(wrappedDek, K1);
    expect(back.equals(dek)).toBe(true);
  });

  it("rotation: a DEK wrapped under the PREVIOUS KEK still unwraps; new wraps use only the current KEK", async () => {
    const client = createInMemoryKmsClient([K1, K2]);
    // a secret was wrapped earlier under K1 (now the previous key)
    const old = createKmsKeyProvider({ kmsClient: client, currentKekId: K1 });
    const wrappedUnderK1 = (await old.generateDataKey(K1)).wrappedDek;
    // after rotation, current = K2, previous = [K1]
    const rotated = createKmsKeyProvider({ kmsClient: client, currentKekId: K2, previousKekIds: [K1] });
    // old row still unwraps under K1 (grace window)
    expect((await rotated.unwrapDataKey(wrappedUnderK1, K1)).length).toBe(32);
    // new secrets wrap under K2
    expect((await rotated.generateDataKey(K2)).dek.length).toBe(32);
    // refusing to wrap a NEW secret under the retired key
    await expect(rotated.generateDataKey(K1)).rejects.toBeInstanceOf(ConnectorVaultKeyProviderError);
  });

  it("rejects an unknown / unsupported KEK id on unwrap (before any KMS call)", async () => {
    const kp = createKmsKeyProvider({ kmsClient: createInMemoryKmsClient([K1]), currentKekId: K1 });
    const { wrappedDek } = await kp.generateDataKey(K1);
    await expect(kp.unwrapDataKey(wrappedDek, "alias/some-other-key")).rejects.toBeInstanceOf(ConnectorVaultKeyProviderError);
  });
});

describe("createKmsKeyProvider — errors are safe / redacted", () => {
  it("an unwrap failure error contains no plaintext/key/wrapped bytes", async () => {
    // a client whose decrypt always fails (wrong KEK / tamper / KMS down)
    const failing: KmsClient = {
      async generateDataKey() {
        return { dek: randomBytes(32), wrappedDek: Buffer.from("SECRET-WRAPPED-BYTES-aaaa", "utf8") };
      },
      async decrypt() {
        throw new Error("PLAINTEXT-KEK-LEAK-should-never-surface");
      },
    };
    const kp = createKmsKeyProvider({ kmsClient: failing, currentKekId: K1 });
    const { wrappedDek } = await kp.generateDataKey(K1);
    let msg = "";
    try {
      await kp.unwrapDataKey(wrappedDek, K1);
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toMatch(/unwrap failed/);
    expect(msg).not.toContain("PLAINTEXT-KEK-LEAK");
    expect(msg).not.toContain("SECRET-WRAPPED-BYTES");
  });

  it("a wrap failure (and an invalid DEK from KMS) errors safely with no key bytes", async () => {
    const wrapFails: KmsClient = {
      async generateDataKey() {
        throw new Error("INTERNAL-KMS-KEY-MATERIAL-leak");
      },
      async decrypt() {
        return randomBytes(32);
      },
    };
    const kp1 = createKmsKeyProvider({ kmsClient: wrapFails, currentKekId: K1 });
    let m1 = "";
    try { await kp1.generateDataKey(K1); } catch (e) { m1 = (e as Error).message; }
    expect(m1).toMatch(/generate-data-key failed/);
    expect(m1).not.toContain("INTERNAL-KMS-KEY-MATERIAL");

    // KMS returns a wrong-length DEK → invalid-data-key (fail closed), no bytes in message.
    const badDek: KmsClient = {
      async generateDataKey() { return { dek: randomBytes(16), wrappedDek: randomBytes(40) }; },
      async decrypt() { return randomBytes(16); },
    };
    const kp2 = createKmsKeyProvider({ kmsClient: badDek, currentKekId: K1 });
    await expect(kp2.generateDataKey(K1)).rejects.toBeInstanceOf(ConnectorVaultKeyProviderError);
  });
});

describe("crypto wrapper round-trip THROUGH the KMS provider abstraction", () => {
  const ctx: SecretContext = {
    tenantId: "11111111-1111-1111-1111-111111111111",
    connectorId: "17000000-0000-0000-0000-0000000000a1",
    secretKind: "oauth_access_token",
    version: 1,
  };
  const SECRET = "ghp_FAKE-test-only-personal-access-token-NOT-real";

  it("encryptConnectorSecret + decryptConnectorSecret work via the KMS-backed provider (no real KMS)", async () => {
    const kp = createKmsKeyProvider({ kmsClient: createInMemoryKmsClient([K1]), currentKekId: K1 });
    const enc = await encryptConnectorSecret({ plaintext: SECRET, context: ctx, keyProvider: kp, kekId: K1 });
    expect(enc.kekId).toBe(K1);
    expect(enc.ciphertext).not.toContain(SECRET);
    const dec = await decryptConnectorSecret({ encrypted: enc, context: ctx, keyProvider: kp });
    expect(dec.toString("utf8")).toBe(SECRET);
  });
});

describe("kmsKeyProviderConfigFromEnv — fail closed by default", () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
  });

  it("returns null when the KEK id env is unset (this PR sets nothing → inert/not configured)", () => {
    delete process.env.CONNECTOR_VAULT_KMS_KEY_ID;
    expect(kmsKeyProviderConfigFromEnv()).toBeNull();
  });

  it("returns the (non-secret) key-id metadata when configured, parsing previous ids", () => {
    process.env.CONNECTOR_VAULT_KMS_KEY_ID = K2;
    process.env.CONNECTOR_VAULT_KMS_PREVIOUS_KEY_IDS = `${K1}, , ${K1}`;
    const cfg = kmsKeyProviderConfigFromEnv();
    expect(cfg).toEqual({ currentKekId: K2, previousKekIds: [K1, K1] });
  });
});

// Static guard: the adapter touches no DB / Supabase / service-role / connector_secrets, and makes no SDK
// network call itself (the injected KmsClient does). It may read process.env ONLY in the config helper.
describe("kms-key-provider module is pure-ish (no DB / Supabase / service-role / connector_secrets / fetch)", () => {
  it("imports only the ConnectorVaultKeyProvider type and contains no forbidden call", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const src = fs.readFileSync(path.resolve(__dirname, "kms-key-provider.ts"), "utf8");
    const imports = [...src.matchAll(/from\s+["']([^"']+)["']/g)].map((m) => m[1]);
    expect(imports).toEqual(["./crypto"]); // a type-only sibling import (erased at runtime)
    expect(src).toMatch(/import type \{ ConnectorVaultKeyProvider \} from "\.\/crypto"/);
    const code = src.replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
    expect(code).not.toMatch(/createClient\s*\(/);
    expect(code).not.toMatch(/\bfetch\s*\(/); // the adapter makes no network call; the KmsClient does
    const secretsTable = ["connector", "secrets"].join("_");
    expect(code).not.toContain(secretsTable);
    const forbidden = ["service", "role"].join("_");
    expect(code).not.toContain(forbidden);
  });
});
