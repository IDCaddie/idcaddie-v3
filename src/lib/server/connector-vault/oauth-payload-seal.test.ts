// Phase 8K — sealing the Slack authorization code to the completion worker's public key.
//
// THE REFERENCE OPENER LIVES HERE, NOT IN src/. That is deliberate: `src/` must hold no capability to decrypt this
// envelope, because the whole point of sealing to the worker is that the web tier cannot read what it hands over. The
// opener below is test-only, it proves the wire format is real rather than merely documented, and PR 4 implements it
// from the layout comment in `oauth-payload-seal.ts` — not by importing anything from here.
//
// No key material is committed. Every key pair is generated in this process, so nothing random ever lands in the
// repository and `check-no-real-tokens.sh` has nothing to trip over.

import { describe, it, expect } from "vitest";
import { createDecipheriv, createPublicKey, diffieHellman, generateKeyPairSync, hkdfSync, type KeyObject } from "node:crypto";
import {
  AES_GCM_NONCE_BYTES,
  AES_GCM_TAG_BYTES,
  DERIVED_KEY_BYTES,
  ENVELOPE_VERSION,
  HKDF_INFO,
  PayloadSealError,
  X25519_PUBLIC_KEY_BYTES,
  X25519_SPKI_DER_BYTES,
  canonicalSealAad,
  parseWorkerSealKey,
  sealAuthorizationCode,
  type SealBinding,
} from "./oauth-payload-seal";
import {
  HANDOFF_PAYLOAD_SCHEME,
  MAX_PROTECTED_PAYLOAD_BYTES,
  MIN_PROTECTED_PAYLOAD_BYTES,
} from "./oauth-handoff-protocol";

// ── Test key material ────────────────────────────────────────────────────────────────────────────────────────────────
const rawPublic = (key: KeyObject) => Buffer.from(key.export({ format: "jwk" }).x as string, "base64url");
const spki = (key: KeyObject) => (key.export({ format: "der", type: "spki" }) as Buffer).toString("base64");
const worker = generateKeyPairSync("x25519");
const impostor = generateKeyPairSync("x25519");
const WORKER_PUBLIC_B64 = spki(worker.publicKey);
const KEY_ID = "worker-seal-v1";

const BINDING: SealBinding = {
  tenantId: "aaaa1111-1111-1111-1111-111111111111",
  connectorId: "1575cde3-0000-4000-8000-00000000bbbb",
  correlationId: "corr-live-run-1",
  expectedTeamId: "T0ABCDEF123",
  payloadKeyId: KEY_ID,
};
// A Slack-shaped authorization code. Not a token and not a secret — Slack codes are single-use and expire in minutes —
// but it is the value the whole envelope exists to protect, so the assertions below hunt for it everywhere.
const CODE = "1234567890123.9876543210987.abcdef0123456789abcdef0123456789abcdef01";

const key = () => parseWorkerSealKey(WORKER_PUBLIC_B64, KEY_ID);

/**
 * THE REFERENCE OPENER — what PR 4's worker does with the private half. Test-only, by design.
 */
function openEnvelope(envelope: Buffer, privateKey: KeyObject, workerPublicRaw: Buffer, aad: Buffer): string {
  expect(envelope[0]).toBe(ENVELOPE_VERSION);
  const ephemeralRaw = envelope.subarray(1, 1 + X25519_PUBLIC_KEY_BYTES);
  const nonce = envelope.subarray(1 + X25519_PUBLIC_KEY_BYTES, 1 + X25519_PUBLIC_KEY_BYTES + AES_GCM_NONCE_BYTES);
  const rest = envelope.subarray(1 + X25519_PUBLIC_KEY_BYTES + AES_GCM_NONCE_BYTES);
  const ciphertext = rest.subarray(0, rest.length - AES_GCM_TAG_BYTES);
  const tag = rest.subarray(rest.length - AES_GCM_TAG_BYTES);

  const ephemeralPublic = createPublicKey({
    key: { kty: "OKP", crv: "X25519", x: ephemeralRaw.toString("base64url") },
    format: "jwk",
  });
  const shared = diffieHellman({ privateKey, publicKey: ephemeralPublic });
  const derived = Buffer.from(
    hkdfSync("sha256", shared, Buffer.concat([ephemeralRaw, workerPublicRaw]), Buffer.from(HKDF_INFO, "utf8"), DERIVED_KEY_BYTES),
  );

  const decipher = createDecipheriv("aes-256-gcm", derived, nonce);
  decipher.setAAD(aad);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}

describe("worker public key", () => {
  it("accepts the base64 SPKI of an X25519 public key", () => {
    const k = key();
    expect(k.keyId).toBe(KEY_ID);
    expect(k.raw.byteLength).toBe(X25519_PUBLIC_KEY_BYTES);
    expect(k.raw.equals(rawPublic(worker.publicKey))).toBe(true);
    expect(k.key.asymmetricKeyType).toBe("x25519");
  });

  it("refuses a malformed public key rather than guessing an encoding", () => {
    const bad = [
      "",                                                        // absent
      "not-base64!!",                                            // not base64 at all
      rawPublic(worker.publicKey).toString("base64"),            // the RAW key, not the SPKI
      Buffer.alloc(X25519_SPKI_DER_BYTES, 1).toString("base64"), // right length, not a valid SPKI
      spki(worker.publicKey).replace(/=+$/, "").replace(/\+/g, "-"), // right bytes, wrong alphabet (round-trip fails)
      Buffer.concat([Buffer.from(spki(worker.publicKey), "base64"), Buffer.alloc(1)]).toString("base64"), // trailing byte
    ];
    for (const v of bad) {
      expect(() => parseWorkerSealKey(v, KEY_ID), JSON.stringify(v)).toThrow(PayloadSealError);
      try { parseWorkerSealKey(v, KEY_ID); } catch (e) {
        expect((e as PayloadSealError).reason, JSON.stringify(v)).toBe("worker_public_key_malformed");
      }
    }
  });

  it("refuses a missing or malformed key id", () => {
    for (const id of [undefined, "", "has spaces", "x".repeat(129)]) {
      try {
        parseWorkerSealKey(WORKER_PUBLIC_B64, id);
        throw new Error(`expected a refusal for ${JSON.stringify(id)}`);
      } catch (e) {
        expect((e as PayloadSealError).reason, JSON.stringify(id)).toBe("worker_public_key_id_invalid");
      }
    }
  });

  // The reason the configured format is SPKI and not raw bytes. An Ed25519 public key is ALSO exactly 32 raw bytes, so
  // a raw encoding gives Node nothing to check and it would import a signing key as a key-agreement key without
  // complaint — producing an envelope the worker can never open. SPKI carries the curve OID, so this is caught here.
  it("refuses an Ed25519 or RSA key offered where an X25519 key belongs", () => {
    for (const [name, kp] of [["ed25519", generateKeyPairSync("ed25519")], ["rsa", generateKeyPairSync("rsa", { modulusLength: 2048 })]] as const) {
      try {
        parseWorkerSealKey(spki(kp.publicKey), KEY_ID);
        throw new Error(`expected a refusal for ${name}`);
      } catch (e) {
        expect((e as PayloadSealError).reason, name).toBe("worker_public_key_malformed");
      }
    }
    // …and the raw 32 bytes of an Ed25519 key, which a raw-encoding parser would have accepted.
    expect(() => parseWorkerSealKey(rawPublic(generateKeyPairSync("ed25519").publicKey).toString("base64"), KEY_ID))
      .toThrow(PayloadSealError);
  });
});

describe("sealing", () => {
  it("produces the declared scheme and key id, within the database's size bounds", () => {
    const sealed = sealAuthorizationCode(CODE, key(), BINDING);
    expect(sealed.payloadScheme).toBe(HANDOFF_PAYLOAD_SCHEME);
    expect(sealed.payloadKeyId).toBe(KEY_ID);
    expect(sealed.protectedPayload.byteLength).toBe(1 + X25519_PUBLIC_KEY_BYTES + AES_GCM_NONCE_BYTES + CODE.length + AES_GCM_TAG_BYTES);
    expect(sealed.protectedPayload.byteLength).toBeGreaterThanOrEqual(MIN_PROTECTED_PAYLOAD_BYTES);
    expect(sealed.protectedPayload.byteLength).toBeLessThanOrEqual(MAX_PROTECTED_PAYLOAD_BYTES);
  });

  it("the authorization code is ABSENT from the sealed output, in every encoding", () => {
    const sealed = sealAuthorizationCode(CODE, key(), BINDING);
    for (const enc of ["utf8", "base64", "hex", "latin1"] as const) {
      expect(sealed.protectedPayload.toString(enc)).not.toContain(CODE);
    }
    expect(sealed.protectedPayload.toString("base64")).not.toContain(Buffer.from(CODE).toString("base64").slice(0, 20));
    expect(JSON.stringify(sealed)).not.toContain(CODE);
  });

  it("two seals of the same code differ — fresh ephemeral key and fresh nonce every time", () => {
    const a = sealAuthorizationCode(CODE, key(), BINDING);
    const b = sealAuthorizationCode(CODE, key(), BINDING);
    expect(a.protectedPayload.equals(b.protectedPayload)).toBe(false);
    // …and the difference starts at the ephemeral public key, not merely in the ciphertext.
    expect(a.protectedPayload.subarray(1, 33).equals(b.protectedPayload.subarray(1, 33))).toBe(false);
    expect(a.protectedPayload.subarray(33, 45).equals(b.protectedPayload.subarray(33, 45))).toBe(false);
  });

  it("the intended private key recovers the EXACT code", () => {
    const sealed = sealAuthorizationCode(CODE, key(), BINDING);
    expect(openEnvelope(sealed.protectedPayload, worker.privateKey, rawPublic(worker.publicKey), canonicalSealAad(BINDING))).toBe(CODE);
  });

  it("a DIFFERENT private key cannot open it", () => {
    const sealed = sealAuthorizationCode(CODE, key(), BINDING);
    expect(() => openEnvelope(sealed.protectedPayload, impostor.privateKey, rawPublic(worker.publicKey), canonicalSealAad(BINDING))).toThrow();
  });

  it("an altered ciphertext, nonce, tag or ephemeral key fails authentication", () => {
    const flipAt = (buf: Buffer, i: number) => { const c = Buffer.from(buf); c[i] ^= 0x01; return c; };
    const sealed = sealAuthorizationCode(CODE, key(), BINDING).protectedPayload;
    const targets = {
      version: 0,
      ephemeralKey: 5,
      nonce: 1 + X25519_PUBLIC_KEY_BYTES + 3,
      ciphertext: 1 + X25519_PUBLIC_KEY_BYTES + AES_GCM_NONCE_BYTES + 2,
      tag: sealed.length - 3,
    };
    for (const [name, index] of Object.entries(targets)) {
      expect(
        () => openEnvelope(flipAt(sealed, index), worker.privateKey, rawPublic(worker.publicKey), canonicalSealAad(BINDING)),
        name,
      ).toThrow();
    }
  });

  // THE BODY BINDING. AES-GCM authenticates the AAD, so a worker handed a substituted request field cannot open the
  // code at all — this is what binds the handoff body, since a Vercel-issued OIDC token carries no custom claims.
  it("every AAD field is bound — altering any one of them makes the code unopenable", () => {
    const sealed = sealAuthorizationCode(CODE, key(), BINDING).protectedPayload;
    const mutations: Array<[string, SealBinding]> = [
      ["tenant", { ...BINDING, tenantId: "bbbb2222-2222-2222-2222-222222222222" }],
      ["connector", { ...BINDING, connectorId: "bbbb2222-2222-2222-2222-222222222222" }],
      ["correlation", { ...BINDING, correlationId: "corr-some-other-run" }],
      ["workspace", { ...BINDING, expectedTeamId: "T9ZZZZZZZZZ" }],
      ["key id", { ...BINDING, payloadKeyId: "worker-seal-v2" }],
    ];
    for (const [name, mutated] of mutations) {
      expect(() => openEnvelope(sealed, worker.privateKey, rawPublic(worker.publicKey), canonicalSealAad(mutated)), name).toThrow();
    }
    // …and the unaltered AAD still opens it, so the assertions above are not passing for some other reason.
    expect(openEnvelope(sealed, worker.privateKey, rawPublic(worker.publicKey), canonicalSealAad(BINDING))).toBe(CODE);
  });

  it("the AAD pins the protocol version, provider and redirect that no caller supplies", () => {
    const aad = canonicalSealAad(BINDING).toString("utf8");
    expect(aad).toContain("idcaddie:oauth-completion-handoff:v1");
    expect(aad).toContain("slack");
    expect(aad).toContain("https://idcaddie-v3.vercel.app/connectors/oauth/callback");
    expect(aad).toContain(BINDING.tenantId);
    expect(aad).toContain(BINDING.connectorId);
    expect(aad).toContain(BINDING.correlationId);
    expect(aad).toContain(BINDING.expectedTeamId);
    expect(aad).toContain(BINDING.payloadKeyId);
    // Newline-delimited, and every field's grammar excludes a newline — so no value can shift a field boundary.
    expect(aad.split("\n")).toHaveLength(10);
  });

  it("refuses a binding whose key id does not name the key being sealed to", () => {
    try {
      sealAuthorizationCode(CODE, key(), { ...BINDING, payloadKeyId: "worker-seal-v2" });
      throw new Error("expected a refusal");
    } catch (e) {
      expect((e as PayloadSealError).reason).toBe("seal_binding_invalid");
    }
  });

  it("refuses a malformed binding field rather than joining it into the AAD", () => {
    const bad: Array<Partial<SealBinding>> = [
      { tenantId: "not-a-uuid" },
      { connectorId: "" },
      { correlationId: "corr\nwith-a-newline" },
      { expectedTeamId: "not-a-team" },
      { payloadKeyId: "has spaces" },
    ];
    for (const m of bad) {
      try {
        sealAuthorizationCode(CODE, key(), { ...BINDING, ...m });
        throw new Error(`expected a refusal for ${JSON.stringify(m)}`);
      } catch (e) {
        expect((e as PayloadSealError).reason, JSON.stringify(m)).toBe("seal_binding_invalid");
      }
    }
  });

  it("refuses an unusable authorization code", () => {
    for (const c of ["", "code with spaces", "code\nwith-newline", "x".repeat(513), "<script>" ]) {
      try {
        sealAuthorizationCode(c, key(), BINDING);
        throw new Error(`expected a refusal for ${JSON.stringify(c.slice(0, 20))}`);
      } catch (e) {
        expect((e as PayloadSealError).reason).toBe("authorization_code_invalid");
      }
    }
  });

  it("never places the code or key material in a thrown error", () => {
    const attempts = [
      () => sealAuthorizationCode(CODE, key(), { ...BINDING, tenantId: `LEAKME-${CODE}` }),
      () => sealAuthorizationCode(`${CODE} LEAKME`, key(), BINDING),
      () => parseWorkerSealKey(`LEAKME${WORKER_PUBLIC_B64}`, KEY_ID),
      () => parseWorkerSealKey(WORKER_PUBLIC_B64, "LEAKME KEY ID"),
    ];
    for (const attempt of attempts) {
      try {
        attempt();
        throw new Error("expected a refusal");
      } catch (e) {
        const err = e as PayloadSealError;
        expect(err).toBeInstanceOf(PayloadSealError);
        const serialized = `${err.message}\n${err.reason}\n${err.stack?.split("\n")[0] ?? ""}`;
        expect(serialized).not.toContain("LEAKME");
        expect(serialized).not.toContain(CODE);
        expect(serialized).not.toContain(WORKER_PUBLIC_B64);
        // The message IS the reason: a bounded, snake_case code and nothing else.
        expect(err.message).toMatch(/^[a-z_]+$/);
      }
    }
  });

  it("an unsupported scheme has no way to be requested — the scheme is not an input", () => {
    // There is no parameter, no environment variable and no request field that selects a cipher suite. The only scheme
    // this module can produce is the one migration 0081's CHECK permits.
    const sealed = sealAuthorizationCode(CODE, key(), BINDING);
    expect(sealed.payloadScheme).toBe(HANDOFF_PAYLOAD_SCHEME);
    expect(Object.keys(sealed).sort()).toEqual(["payloadKeyId", "payloadScheme", "protectedPayload"]);
  });
});
