// Phase 8K — sealing the Slack authorization code to the completion worker's public key. Server-only.
//
// V3 holds the PUBLIC half and can only encrypt. The private half lives in the isolated worker process and nowhere else,
// so the database (including a dashboard session, a privileged role, and a backup) holds bytes it cannot open, and so
// does this repository. There is deliberately no opener in `src/`: the reference decryption lives in this module's test
// file, where it proves the wire format without giving the web tier the capability.
//
// This adds NO dependency and NO KMS. `node:crypto` covers X25519, HKDF-SHA256 and AES-256-GCM, which is exactly why
// `oauth_completion_jobs_payload_scheme_check` constrains the scheme to that triple.
//
// ── WIRE FORMAT (PR 4 opens this) ────────────────────────────────────────────────────────────────────────────────────
//
//   offset  size  meaning
//   0       1     envelope version, 0x01
//   1       32    ephemeral X25519 public key, raw
//   33      12    AES-GCM nonce
//   45      n     ciphertext
//   45+n    16    AES-GCM authentication tag
//
//   shared   = X25519(ephemeral_private, worker_public)
//   key      = HKDF-SHA256(ikm = shared, salt = ephemeral_public || worker_public, info = HKDF_INFO, length = 32)
//   envelope = AES-256-GCM(key, nonce, plaintext = authorization code, aad = canonicalSealAad(binding))
//
// The version byte at offset 0 is INSIDE the AAD (see `canonicalSealAad`), so an opener that reads it and then
// authenticates cannot be steered onto the wrong parse path: a flipped version byte fails the tag.
//
// The salt binds BOTH public keys, so a key-substitution attempt derives a different key rather than the same one. The
// AAD binds every field of the handoff request that must not change between sealing and completion — a worker handed a
// substituted body cannot open the code at all, which is the real body binding in this protocol (see
// `oauth-handoff-protocol.ts` for why the OIDC assertion cannot provide one).
//
// SERVER-ONLY: under `src/lib/server/`, the runtime browser sentinel below, and `no-client-import.test.ts`.

import {
  createCipheriv,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
  type KeyObject,
} from "node:crypto";
import {
  CORRELATION_ID_RE,
  HANDOFF_PAYLOAD_SCHEME,
  HANDOFF_PROTOCOL_VERSION,
  HANDOFF_PROVIDER,
  HANDOFF_REDIRECT_URI,
  NONCE_HASH_RE,
  PAYLOAD_KEY_ID_RE,
  SLACK_TEAM_ID_RE,
  UUID_RE,
} from "./oauth-handoff-protocol";

if (typeof (globalThis as { window?: unknown }).window !== "undefined") {
  throw new Error("connector-vault/oauth-payload-seal is server-only and must not be imported in client code");
}

export const ENVELOPE_VERSION = 1;
export const X25519_PUBLIC_KEY_BYTES = 32;
export const AES_GCM_NONCE_BYTES = 12;
export const AES_GCM_TAG_BYTES = 16;
export const DERIVED_KEY_BYTES = 32;

/** Pinned into HKDF's `info`, so a key derived for this protocol cannot collide with one derived for anything else. */
export const HKDF_INFO = `idcaddie:oauth-completion-handoff:v${HANDOFF_PROTOCOL_VERSION}:${HANDOFF_PAYLOAD_SCHEME}`;
/** The first line of the AAD. Domain separation, for the same reason. */
export const AAD_DOMAIN = `idcaddie:oauth-completion-handoff:v${HANDOFF_PROTOCOL_VERSION}`;

export type SealRefusal =
  | "worker_public_key_malformed"
  | "worker_public_key_id_invalid"
  | "seal_binding_invalid"
  | "authorization_code_invalid"
  | "seal_failed";

export class PayloadSealError extends Error {
  readonly reason: SealRefusal;
  constructor(reason: SealRefusal) {
    // The reason IS the message. There is nothing else in it — no key, no code, no configured value.
    super(reason);
    this.name = "PayloadSealError";
    this.reason = reason;
  }
}

/** The parsed worker key. `keyId` travels with it so a seal can never be produced under a key id that names a different
 *  key than the one it was actually sealed to. */
export type WorkerSealKey = { key: KeyObject; keyId: string; raw: Buffer };

/** Everything the AAD binds. Each field is grammar-checked before it is joined, because the join is newline-delimited
 *  and a value able to contain a newline could shift a field boundary — the same reasoning migration 0081 applies to
 *  its own digest. */
export type SealBinding = {
  tenantId: string;
  connectorId: string;
  correlationId: string;
  expectedTeamId: string;
  payloadKeyId: string;
  /** v2. `sha256(nonce)` hex. Bound because it is the single-use key of the `oauth_pending` row the worker will
   *  consume: a substituted nonce hash would let a valid-looking handoff point the consume at a DIFFERENT pending row,
   *  and AES-GCM authenticating it means such a body cannot open the authorization code at all. */
  nonceHash: string;
  /** v2. The initiating `auth.uid()`. Bound for the same reason — it is half of the row's identity in 0079's WHERE. */
  subject: string;
};

export type SealedPayload = {
  protectedPayload: Buffer;
  payloadScheme: typeof HANDOFF_PAYLOAD_SCHEME;
  payloadKeyId: string;
};

/**
 * A Slack authorization code, bounded. OAuth 2.0 permits a wide character set; this narrows it to what a code can
 * actually be and caps the length, so an attacker-supplied `?code=` cannot become an oversized or newline-bearing
 * plaintext. The value itself is never logged, echoed or included in an error.
 */
const AUTHORIZATION_CODE_RE = /^[A-Za-z0-9._~+/=-]{1,512}$/;

/** An X25519 SubjectPublicKeyInfo is 12 bytes of algorithm identifier plus the 32-byte key. */
export const X25519_SPKI_DER_BYTES = 44;

/**
 * Parse and validate the configured worker public key: standard base64 of the SPKI DER.
 *
 * SPKI, not raw bytes — and this is not a stylistic preference. An X25519 public key and an Ed25519 public key are both
 * exactly 32 raw bytes, so a raw encoding gives Node nothing to check: told `crv: "X25519"`, it will happily import a
 * signing key as a key-agreement key, and the mistake surfaces as a worker that cannot decrypt anything. SPKI carries
 * the curve OID, so an Ed25519 key is refused HERE, where a person can still fix it.
 *
 * One format, not several. There is no "try the other encoding" path, because a public key that needs guessing is a
 * misconfiguration.
 */
export function parseWorkerSealKey(publicKeySpkiBase64: string | undefined, keyId: string | undefined): WorkerSealKey {
  if (typeof keyId !== "string" || !PAYLOAD_KEY_ID_RE.test(keyId)) throw new PayloadSealError("worker_public_key_id_invalid");
  if (typeof publicKeySpkiBase64 !== "string" || publicKeySpkiBase64.length === 0) throw new PayloadSealError("worker_public_key_malformed");

  const der = Buffer.from(publicKeySpkiBase64, "base64");
  // Round-tripping rejects the strings Buffer.from silently tolerates (stray characters, wrong padding) — a key that
  // does not re-encode to the configured value is not the key that was configured.
  if (der.byteLength !== X25519_SPKI_DER_BYTES || der.toString("base64") !== publicKeySpkiBase64) {
    throw new PayloadSealError("worker_public_key_malformed");
  }

  let key: KeyObject;
  try {
    key = createPublicKey({ key: der, format: "der", type: "spki" });
  } catch {
    throw new PayloadSealError("worker_public_key_malformed");
  }
  if (key.asymmetricKeyType !== "x25519") throw new PayloadSealError("worker_public_key_malformed");

  // The raw 32 bytes, for the HKDF salt. Taken from the imported key rather than sliced out of the DER, so the salt is
  // whatever Node actually agreed to use.
  const raw = Buffer.from(key.export({ format: "jwk" }).x as string, "base64url");
  if (raw.byteLength !== X25519_PUBLIC_KEY_BYTES) throw new PayloadSealError("worker_public_key_malformed");
  return { key, keyId, raw };
}

/**
 * The additional authenticated data. Written out field by field with a fixed order, not derived from an object, so the
 * bytes cannot drift with a refactor. Both halves must build this identically or the tag simply does not verify.
 */
export function canonicalSealAad(binding: SealBinding): Buffer {
  assertBinding(binding);
  return Buffer.from(
    [
      AAD_DOMAIN,
      String(HANDOFF_PROTOCOL_VERSION),
      // THE ENVELOPE VERSION IS AUTHENTICATED. Byte 0 of the envelope sits outside the ciphertext and outside the tag,
      // so without this line it is the one field an attacker who can rewrite `oauth_completion_jobs.protected_payload`
      // could flip undetected — and the moment a v2 layout exists, flipping it forces a v2 envelope down a v1 parse
      // path. Binding it here means a flipped byte derives a different AAD and the tag simply does not verify.
      // (Found in adversarial review of PR #398.)
      String(ENVELOPE_VERSION),
      binding.tenantId,
      binding.connectorId,
      HANDOFF_PROVIDER,
      binding.correlationId,
      HANDOFF_REDIRECT_URI,
      binding.expectedTeamId,
      binding.payloadKeyId,
      // v2. Appended after the v1 fields; the AAD's first two lines already carry the protocol version, so a v1 and a
      // v2 AAD can never collide even before these are read. Both are grammar-checked below, and neither grammar
      // admits a newline, so no value can shift a field boundary.
      binding.nonceHash,
      binding.subject,
      "",
    ].join("\n"),
    "utf8",
  );
}

function assertBinding(binding: SealBinding): void {
  if (
    !binding ||
    typeof binding !== "object" ||
    !UUID_RE.test(binding.tenantId ?? "") ||
    !UUID_RE.test(binding.connectorId ?? "") ||
    !CORRELATION_ID_RE.test(binding.correlationId ?? "") ||
    !SLACK_TEAM_ID_RE.test(binding.expectedTeamId ?? "") ||
    !PAYLOAD_KEY_ID_RE.test(binding.payloadKeyId ?? "") ||
    !NONCE_HASH_RE.test(binding.nonceHash ?? "") ||
    !UUID_RE.test(binding.subject ?? "")
  ) {
    throw new PayloadSealError("seal_binding_invalid");
  }
}

/**
 * Seal one authorization code to the worker's public key.
 *
 * A fresh ephemeral key pair and a fresh nonce per call, with no injectable seam for either: a deterministic seal is
 * exactly the failure this envelope must not have, and a test that needs one can generate its own worker key pair and
 * decrypt. Two seals of the same code therefore differ, which is why migration 0081 treats a re-seal as a NEW request
 * and refuses it — a caller that has re-sealed should read the job's status instead of enqueuing again.
 *
 * The plaintext never leaves this function. The shared secret, derived key and plaintext buffers are zeroed before it
 * returns; the code arrives as a string and JavaScript strings cannot be wiped, which is why the caller keeps it in
 * scope for as short a time as possible and never persists it.
 */
export function sealAuthorizationCode(
  authorizationCode: string,
  workerKey: WorkerSealKey,
  binding: SealBinding,
): SealedPayload {
  if (typeof authorizationCode !== "string" || !AUTHORIZATION_CODE_RE.test(authorizationCode)) {
    throw new PayloadSealError("authorization_code_invalid");
  }
  if (!workerKey || workerKey.key?.asymmetricKeyType !== "x25519") throw new PayloadSealError("worker_public_key_malformed");
  assertBinding(binding);
  // The key id in the AAD must name the key the bytes are actually sealed to, or the worker would look up one key and
  // need another.
  if (binding.payloadKeyId !== workerKey.keyId) throw new PayloadSealError("seal_binding_invalid");

  const aad = canonicalSealAad(binding);
  const ephemeral = generateKeyPairSync("x25519");
  const ephemeralPublicRaw = Buffer.from(ephemeral.publicKey.export({ format: "jwk" }).x as string, "base64url");

  let shared: Buffer | null = null;
  let derived: Buffer | null = null;
  let plaintext: Buffer | null = null;
  try {
    shared = diffieHellman({ privateKey: ephemeral.privateKey, publicKey: workerKey.key });
    derived = Buffer.from(
      hkdfSync("sha256", shared, Buffer.concat([ephemeralPublicRaw, workerKey.raw]), Buffer.from(HKDF_INFO, "utf8"), DERIVED_KEY_BYTES),
    );

    const nonce = randomBytes(AES_GCM_NONCE_BYTES);
    const cipher = createCipheriv("aes-256-gcm", derived, nonce);
    cipher.setAAD(aad);
    plaintext = Buffer.from(authorizationCode, "utf8");
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const tag = cipher.getAuthTag();

    return {
      protectedPayload: Buffer.concat([Buffer.from([ENVELOPE_VERSION]), ephemeralPublicRaw, nonce, ciphertext, tag]),
      payloadScheme: HANDOFF_PAYLOAD_SCHEME,
      payloadKeyId: workerKey.keyId,
    };
  } catch (error) {
    // A PayloadSealError already carries only a bounded reason. Anything else is discarded rather than wrapped: a crypto
    // error can embed buffer contents, and this value reaches a redirect.
    throw error instanceof PayloadSealError ? error : new PayloadSealError("seal_failed");
  } finally {
    shared?.fill(0);
    derived?.fill(0);
    plaintext?.fill(0);
  }
}
