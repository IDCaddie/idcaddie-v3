import { describe, it, expect } from "vitest";
import { createDecipheriv, createPublicKey, diffieHellman, generateKeyPairSync, hkdfSync, type KeyObject } from "node:crypto";
import {
  AES_GCM_NONCE_BYTES, AES_GCM_TAG_BYTES, DERIVED_KEY_BYTES, HKDF_INFO,
  X25519_PUBLIC_KEY_BYTES, canonicalSealAad, parseWorkerSealKey, sealAuthorizationCode, type SealBinding,
} from "./oauth-payload-seal";

const rawPublic = (k: KeyObject) => Buffer.from(k.export({ format: "jwk" }).x as string, "base64url");
const spki = (k: KeyObject) => (k.export({ format: "der", type: "spki" }) as Buffer).toString("base64");
const worker = generateKeyPairSync("x25519");
const KEY_ID = "worker-seal-v1";
const BINDING: SealBinding = {
  tenantId: "aaaa1111-1111-1111-1111-111111111111",
  connectorId: "1575cde3-0000-4000-8000-00000000bbbb",
  correlationId: "corr-live-run-1",
  expectedTeamId: "T0ABCDEF123",
  payloadKeyId: KEY_ID,
};
const CODE = "1234567890123.9876543210987.abcdef0123456789abcdef0123456789abcdef01";

// The reference opener MINUS the version assertion — i.e. exactly what PR 4 writes if it parses
// the layout comment and does not independently decide to reject an unexpected version byte.
function openNoVersionCheck(envelope: Buffer, privateKey: KeyObject, workerPublicRaw: Buffer, aad: Buffer): string {
  const ephemeralRaw = envelope.subarray(1, 1 + X25519_PUBLIC_KEY_BYTES);
  const nonce = envelope.subarray(1 + X25519_PUBLIC_KEY_BYTES, 1 + X25519_PUBLIC_KEY_BYTES + AES_GCM_NONCE_BYTES);
  const rest = envelope.subarray(1 + X25519_PUBLIC_KEY_BYTES + AES_GCM_NONCE_BYTES);
  const ciphertext = rest.subarray(0, rest.length - AES_GCM_TAG_BYTES);
  const tag = rest.subarray(rest.length - AES_GCM_TAG_BYTES);
  const ephemeralPublic = createPublicKey({ key: { kty: "OKP", crv: "X25519", x: ephemeralRaw.toString("base64url") }, format: "jwk" });
  const shared = diffieHellman({ privateKey, publicKey: ephemeralPublic });
  const derived = Buffer.from(hkdfSync("sha256", shared, Buffer.concat([ephemeralRaw, workerPublicRaw]), Buffer.from(HKDF_INFO, "utf8"), DERIVED_KEY_BYTES));
  const decipher = createDecipheriv("aes-256-gcm", derived, nonce);
  decipher.setAAD(aad);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}

describe("probe", () => {
  it("PROBE A: a flipped version byte still decrypts cleanly when the opener does not check it", () => {
    const sealed = sealAuthorizationCode(CODE, parseWorkerSealKey(spki(worker.publicKey), KEY_ID), BINDING).protectedPayload;
    const tampered = Buffer.from(sealed);
    tampered[0] ^= 0x01;                       // 0x01 -> 0x00
    expect(tampered[0]).toBe(0);
    const out = openNoVersionCheck(tampered, worker.privateKey, rawPublic(worker.publicKey), canonicalSealAad(BINDING));
    expect(out).toBe(CODE);                    // AEAD did NOT reject the alteration
  });

  it("PROBE B: same flip at any OTHER offset does break authentication", () => {
    const sealed = sealAuthorizationCode(CODE, parseWorkerSealKey(spki(worker.publicKey), KEY_ID), BINDING).protectedPayload;
    for (const i of [5, 1 + X25519_PUBLIC_KEY_BYTES + 3, 1 + X25519_PUBLIC_KEY_BYTES + AES_GCM_NONCE_BYTES + 2, sealed.length - 3]) {
      const t = Buffer.from(sealed); t[i] ^= 0x01;
      expect(() => openNoVersionCheck(t, worker.privateKey, rawPublic(worker.publicKey), canonicalSealAad(BINDING)), `offset ${i}`).toThrow();
    }
  });

  it("PROBE C: vitest toThrow() does swallow an inner expect() failure", () => {
    expect(() => { expect(1).toBe(2); }).toThrow();
  });

  it("PROBE D: version byte 0xFF also decrypts — arbitrary value, not just a single-bit flip", () => {
    const sealed = sealAuthorizationCode(CODE, parseWorkerSealKey(spki(worker.publicKey), KEY_ID), BINDING).protectedPayload;
    const t = Buffer.from(sealed); t[0] = 0xff;
    expect(openNoVersionCheck(t, worker.privateKey, rawPublic(worker.publicKey), canonicalSealAad(BINDING))).toBe(CODE);
  });
});
