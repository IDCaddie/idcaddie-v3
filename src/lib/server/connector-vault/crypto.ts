// Server-only connector vault crypto wrapper (docs/42 §6, gated sequence PR C).
//
// This is the reviewed envelope-encryption boundary the vault sequence requires BEFORE any connector
// credential may be stored (docs/42 §20/§21). It does NOT store anything, talk to a database, import a
// Supabase client, or use a privileged/admin path — it is pure AEAD over an injected key provider.
//
// SERVER-ONLY. This module must never be imported by client/browser code. Three guards enforce that:
//   (1) it lives under `src/lib/server/` (a server-only path by convention);
//   (2) the runtime sentinel below throws if it is ever evaluated in a browser (a defensive backstop —
//       Node's `crypto` would already fail to bundle for the browser, but we fail loud and early); and
//   (3) a static test (`no-client-import.test.ts`) asserts no `"use client"` / app file imports it.
//
// ENVELOPE MODEL (docs/42 §1.2/§4): each secret is sealed with a per-secret DATA key (DEK) under
// AES-256-GCM; the DEK is wrapped by a key-encryption key (KEK) held by an injected `KeyProvider` (a real
// KMS in production — NOT in this PR; an in-memory provider in tests only). The AAD binds the ciphertext
// to `{tenant_id, connector_id, secret_kind, version}` so a row copied/replayed into another tenant,
// connector, kind, or version fails to decrypt — a structural defense against confused-deputy / replay.
//
// REDACTION (docs/42 §11): plaintext and key material NEVER appear in thrown errors or logs. Errors carry
// safe, static messages only. Nothing here calls console.* .

import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

// (2) Runtime server-only sentinel. `globalThis.window` only exists in a browser; throw before doing any
// crypto if this module is somehow evaluated client-side.
if (typeof (globalThis as { window?: unknown }).window !== "undefined") {
  throw new Error("connector-vault/crypto is server-only and must not be imported in client code");
}

// ── Public types ────────────────────────────────────────────────────────────────────────────────────
// The conceptual secret kinds the vault supports (docs/42 §4). This module stores NONE of them; the kind
// is only AAD-binding context. No provider-specific behavior.
export const SECRET_KINDS = [
  "oauth_access_token",
  "oauth_refresh_token",
  "api_key",
  "personal_access_token",
  "webhook_secret",
] as const;
export type SecretKind = (typeof SECRET_KINDS)[number];

// The AAD-binding context. Every field is required and folded into the AEAD additional data, so changing
// any of them on decrypt fails closed.
export type SecretContext = {
  tenantId: string;
  connectorId: string;
  secretKind: SecretKind;
  version: number;
};

// Injected key-wrapping provider (the KMS abstraction). A real KMS implements this in a LATER PR; tests
// inject an in-memory provider. Async because real KMS calls are async. The provider holds the KEKs — this
// module never sees or stores a KEK.
export interface ConnectorVaultKeyProvider {
  // GenerateDataKey: return a fresh random DEK plus its wrapped form under the named KEK.
  generateDataKey(kekId: string): Promise<{ dek: Buffer; wrappedDek: Buffer }>;
  // Unwrap a previously-wrapped DEK under the named KEK. MUST throw on KEK mismatch / tampering.
  unwrapDataKey(wrappedDek: Buffer, kekId: string): Promise<Buffer>;
}

// The structured, at-rest payload. Maps to `connector_secrets` columns later (ciphertext, dek_wrapped,
// aead_nonce, aad_digest); `v`/`alg`/`kekId`/`tag` are the format + key + auth-tag metadata. All binary
// fields are base64. This is NEVER plaintext — only `decryptConnectorSecret` returns plaintext.
//
// NOTE on `aadDigest`: it is a NON-AUTHORITATIVE convenience field (a fast fail-fast lookup/debug aid).
// The SOLE cryptographic binding of the context to the ciphertext is the GCM auth tag over the AAD — a
// caller must NEVER treat a matching `aadDigest` as proof of context binding. `decryptConnectorSecret`
// uses it only as a pre-check; the GCM `final()` is what actually authenticates.
export type EncryptedConnectorSecret = {
  v: 1; // payload format version
  alg: "AES-256-GCM"; // authenticated encryption algorithm
  kekId: string; // which KEK wrapped the DEK (non-sensitive handle)
  wrappedDek: string; // base64 — DEK wrapped by the KEK (-> connector_secrets.dek_wrapped)
  iv: string; // base64 — 12-byte GCM nonce (-> aead_nonce)
  ciphertext: string; // base64 (-> ciphertext)
  tag: string; // base64 — 16-byte GCM auth tag
  aadDigest: string; // sha256(canonical AAD) hex (-> aad_digest); non-authoritative (see note above)
};

// A typed, safe-to-surface error. Its message is one of a small fixed set — never plaintext/ciphertext/keys.
export class ConnectorVaultCryptoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConnectorVaultCryptoError";
  }
}

const IV_BYTES = 12; // GCM standard nonce length
const DEK_BYTES = 32; // AES-256

// ── Internals ───────────────────────────────────────────────────────────────────────────────────────
// Canonical, deterministic AAD bytes for a context. Fixed field order + byte-accurate length-tagging
// (UTF-8 byte length, not UTF-16 code-unit count) so distinct contexts can never collide — even if a
// field value contains the separator or the `len:` syntax. Folding `version` in means a tampered version
// fails decryption (§4). NOTE: nothing is encrypted yet, so this canonical form may still evolve freely;
// once a real credential is stored, changing it would be a breaking format change requiring re-encryption.
function canonicalAad(ctx: SecretContext): Buffer {
  const parts = [ctx.tenantId, ctx.connectorId, ctx.secretKind, String(ctx.version)];
  const tagged = parts.map((p) => `${Buffer.byteLength(p, "utf8")}:${p}`).join(" ");
  return Buffer.from(`idcaddie-connector-vault v1 ${tagged}`, "utf8");
}

function aadDigestHex(aad: Buffer): string {
  return createHash("sha256").update(aad).digest("hex");
}

function assertContext(ctx: SecretContext): void {
  if (!ctx || typeof ctx !== "object") throw new ConnectorVaultCryptoError("invalid secret context");
  if (typeof ctx.tenantId !== "string" || ctx.tenantId.length === 0)
    throw new ConnectorVaultCryptoError("invalid secret context: tenantId");
  if (typeof ctx.connectorId !== "string" || ctx.connectorId.length === 0)
    throw new ConnectorVaultCryptoError("invalid secret context: connectorId");
  if (!(SECRET_KINDS as readonly string[]).includes(ctx.secretKind))
    throw new ConnectorVaultCryptoError("invalid secret context: secretKind");
  if (!Number.isInteger(ctx.version) || ctx.version < 1)
    throw new ConnectorVaultCryptoError("invalid secret context: version");
}

// ── Public API ──────────────────────────────────────────────────────────────────────────────────────
// Encrypt a connector secret. `plaintext` is the raw credential bytes (a Buffer or utf8 string) — it is
// used only inside this function, never logged, never returned. Returns the structured at-rest payload.
export async function encryptConnectorSecret(input: {
  plaintext: Buffer | string;
  context: SecretContext;
  keyProvider: ConnectorVaultKeyProvider;
  kekId: string;
}): Promise<EncryptedConnectorSecret> {
  const { context, keyProvider, kekId } = input;
  assertContext(context);
  if (typeof kekId !== "string" || kekId.length === 0)
    throw new ConnectorVaultCryptoError("invalid kekId");
  const plaintext = typeof input.plaintext === "string" ? Buffer.from(input.plaintext, "utf8") : input.plaintext;
  if (!Buffer.isBuffer(plaintext) || plaintext.length === 0)
    throw new ConnectorVaultCryptoError("invalid plaintext");

  const { dek, wrappedDek } = await keyProvider.generateDataKey(kekId);
  if (!Buffer.isBuffer(dek) || dek.length !== DEK_BYTES)
    throw new ConnectorVaultCryptoError("key provider returned an invalid data key");

  try {
    const aad = canonicalAad(context);
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv("aes-256-gcm", dek, iv);
    cipher.setAAD(aad);
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const tag = cipher.getAuthTag();
    return {
      v: 1,
      alg: "AES-256-GCM",
      kekId,
      wrappedDek: wrappedDek.toString("base64"),
      iv: iv.toString("base64"),
      ciphertext: ciphertext.toString("base64"),
      tag: tag.toString("base64"),
      aadDigest: aadDigestHex(aad),
    };
  } finally {
    dek.fill(0); // best-effort: clear the plaintext DEK from memory
  }
}

// Decrypt a connector secret. Returns the plaintext Buffer ONLY when the AAD context, the KEK id, the
// wrapped DEK, and the auth tag all verify. Fails closed (throws a safe ConnectorVaultCryptoError) on any
// mismatch/tamper — wrong tenant/connector/kind/version, wrong KEK, or altered ciphertext/metadata.
export async function decryptConnectorSecret(input: {
  encrypted: EncryptedConnectorSecret;
  context: SecretContext;
  keyProvider: ConnectorVaultKeyProvider;
}): Promise<Buffer> {
  const { encrypted, context, keyProvider } = input;
  assertContext(context);
  if (!encrypted || typeof encrypted !== "object")
    throw new ConnectorVaultCryptoError("invalid encrypted payload");
  if (encrypted.v !== 1 || encrypted.alg !== "AES-256-GCM")
    throw new ConnectorVaultCryptoError("unsupported payload version/algorithm");
  for (const f of ["kekId", "wrappedDek", "iv", "ciphertext", "tag", "aadDigest"] as const) {
    if (typeof encrypted[f] !== "string" || encrypted[f].length === 0)
      throw new ConnectorVaultCryptoError(`invalid encrypted payload: ${f}`);
  }

  const aad = canonicalAad(context);
  // Fast fail-closed pre-check: the provided context must match the bound AAD digest (constant-time). This
  // is convenience only — the GCM tag (below) is the sole authority; never trust the digest in isolation.
  const expected = Buffer.from(aadDigestHex(aad), "utf8");
  const actual = Buffer.from(encrypted.aadDigest, "utf8");
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual))
    throw new ConnectorVaultCryptoError("aad mismatch (context does not match sealed secret)");

  let dek: Buffer;
  try {
    dek = await keyProvider.unwrapDataKey(Buffer.from(encrypted.wrappedDek, "base64"), encrypted.kekId);
  } catch {
    throw new ConnectorVaultCryptoError("data key unwrap failed (wrong KEK or tampered wrapped key)");
  }
  if (!Buffer.isBuffer(dek) || dek.length !== DEK_BYTES)
    throw new ConnectorVaultCryptoError("key provider returned an invalid data key");

  try {
    const decipher = createDecipheriv("aes-256-gcm", dek, Buffer.from(encrypted.iv, "base64"));
    decipher.setAAD(aad);
    decipher.setAuthTag(Buffer.from(encrypted.tag, "base64"));
    return Buffer.concat([decipher.update(Buffer.from(encrypted.ciphertext, "base64")), decipher.final()]);
  } catch {
    // GCM auth failure (tampered ciphertext / wrong AAD / wrong DEK). Never surface plaintext or key bytes.
    throw new ConnectorVaultCryptoError("decryption failed (authentication tag mismatch or tampering)");
  } finally {
    dek.fill(0);
  }
}
