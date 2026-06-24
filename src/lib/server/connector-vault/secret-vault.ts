// Server-only CONNECTOR SECRET VAULT — the storage/decrypt BOUNDARY for connector credentials (docs/42 §76,
// RISK-007 foundation). It wires the reviewed envelope crypto (`crypto.ts`) to the `connector_secrets` store
// behind TWO structurally-separate capabilities:
//
//   * SAVE (encrypt-only): `saveConnectorSecret` encrypts a credential and writes ONLY ciphertext to the
//     store. It accepts an ENCRYPT-ONLY key provider (`generateDataKey` only) — it is given NO decrypt key, so
//     even this write path CANNOT decrypt. Its result is a REDACTED reference: NO plaintext, NO ciphertext.
//   * DECRYPT/LOAD (runner-only): `loadConnectorSecret` REQUIRES a `RunnerDecryptCapability` — an unforgeable
//     token produced ONLY by `acquireRunnerDecryptCapability`, and ONLY when the runner-runtime marker is
//     present AND a decrypt-capable KMS provider is supplied. The request-path runtime holds neither, so it
//     cannot decrypt — the boundary is a held capability, not merely a server-only import.
//
// WHY THIS IS NOT JUST A SERVER-ONLY FILE. Decrypt depends on a capability the request-path runtime does not
// possess. In production the cryptographic boundary is the KMS `Decrypt` grant: the runner's IAM identity has
// `kms:Decrypt`; the web/request-path identity does NOT — so its KMS client's `decrypt` fails even with the
// ciphertext in hand. Layered with: (a) `connector_secrets` is request-path deny-all (RLS-enabled, zero
// policies, `authenticated`/`anon` zero grant — 0017/0018/T39/T40, preserved); the runner reads/writes only via
// its narrow 0029 `SELECT`+`INSERT` grant under `SET ROLE connector_runner`; (b) the AAD binds
// {tenant,connector,kind,version}, so a row read cross-tenant fails to decrypt; (c) this capability gate. The
// env-marker + capability type are CODE-LEVEL defense-in-depth; the KMS-grant separation is the real boundary
// and is verified only in a hosted deploy — see docs/42 §76, RISK-007 stays OPEN.
//
// REDACTION. The save result type carries no secret bytes. Decrypted plaintext is returned ONLY inside a
// `RedactedSecret` wrapper whose `toString`/`toJSON`/inspect are redacted — the bytes are reachable only via
// `.expose()` (runner use). Errors are typed, static, secret-free.
//
// THIS MODULE: stores NO real token, calls NO provider/Okta API, exchanges NO OAuth code, imports NO Supabase
// client / service-role, exposes NO route/UI. Its only imports are the sibling crypto type/functions. The DB is
// reached through an INJECTED runner-backed store (never service-role; never request-path).
//
// SERVER-ONLY: under `src/lib/server/`, the runtime browser sentinel below, and `no-client-import.test.ts`.

import {
  encryptConnectorSecret,
  decryptConnectorSecret,
  ConnectorVaultCryptoError,
  type SecretContext,
  type SecretKind,
  type EncryptedConnectorSecret,
  type ConnectorVaultKeyProvider,
} from "./crypto";

// Runtime server-only sentinel — throw if evaluated in a browser.
if (typeof (globalThis as { window?: unknown }).window !== "undefined") {
  throw new Error("connector-vault/secret-vault is server-only and must not be imported in client code");
}

// A typed, safe-to-surface error — its message is always a fixed static string, never secret/key material.
export class ConnectorSecretVaultError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConnectorSecretVaultError";
  }
}

// The runner-runtime self-identification marker. The hosted RUNNER process sets
// `process.env.CONNECTOR_VAULT_RUNNER` to this; the web/request-path process never does. The runner entrypoint
// reads it and passes it to `acquireRunnerDecryptCapability` (so this module stays env-injection-testable).
export const RUNNER_RUNTIME_MARKER = "connector-vault-runner" as const;

// Map the crypto secret-kind vocabulary -> the `connector_secrets.secret_kind` CHECK vocabulary (0017). The
// AAD always binds the crypto kind (the caller supplies it at BOTH save and load); this map is only for the
// stored/queried column value.
const CRYPTO_TO_DB_KIND: Record<SecretKind, string> = {
  oauth_access_token: "oauth_access",
  oauth_refresh_token: "oauth_refresh",
  api_key: "api_key",
  personal_access_token: "pat",
  webhook_secret: "webhook_signing",
};

// An ENCRYPT-ONLY key provider — it can wrap a fresh DEK (KMS GenerateDataKey) but holds NO decrypt key. This
// is all the SAVE path is ever given, so the save path cannot decrypt by construction.
export type EncryptOnlyKeyProvider = Pick<ConnectorVaultKeyProvider, "generateDataKey">;

// The at-rest payload the store persists (maps to connector_secrets columns) — NEVER plaintext.
export type StoredEncryptedSecret = { id: string; encrypted: EncryptedConnectorSecret };

// ── at-rest envelope column mapping (the COMPLETE 8-field envelope ↔ connector_secrets columns; 0030) ───────
// The exact `connector_secrets` envelope columns. Binary fields are Buffers (bytea); the rest are scalars. The
// runner-backed store uses these mappers to write/read a COMPLETE EncryptedConnectorSecret — every field of the
// `crypto.ts` payload now has a column (0030 added aead_tag/envelope_version/aead_alg). NEVER plaintext.
export type ConnectorSecretEnvelopeColumns = {
  ciphertext: Buffer;        // <- EncryptedConnectorSecret.ciphertext (base64-decoded)
  dek_wrapped: Buffer;       // <- .wrappedDek
  aead_nonce: Buffer;        // <- .iv
  aead_tag: Buffer;          // <- .tag (the 16-byte GCM auth tag; 0030)
  aad_digest: string;        // <- .aadDigest (hex)
  key_id: string;            // <- .kekId
  envelope_version: number;  // <- .v (0030)
  aead_alg: string;          // <- .alg (0030)
};

// Map a validated EncryptedConnectorSecret onto the at-rest envelope columns (base64/hex -> bytea/text).
export function encryptedSecretToColumns(e: EncryptedConnectorSecret): ConnectorSecretEnvelopeColumns {
  return {
    ciphertext: Buffer.from(e.ciphertext, "base64"),
    dek_wrapped: Buffer.from(e.wrappedDek, "base64"),
    aead_nonce: Buffer.from(e.iv, "base64"),
    aead_tag: Buffer.from(e.tag, "base64"),
    aad_digest: e.aadDigest,
    key_id: e.kekId,
    envelope_version: e.v,
    aead_alg: e.alg,
  };
}

// Reconstruct the EncryptedConnectorSecret from the at-rest envelope columns. Fails closed (typed error) on an
// INCOMPLETE row (a legacy/partial envelope with NULL tag/version/alg) or an unsupported version/algorithm — so
// a half-written secret can never be decoded into a usable payload.
export function columnsToEncryptedSecret(c: Partial<ConnectorSecretEnvelopeColumns>): EncryptedConnectorSecret {
  const need = (b: Buffer | null | undefined, label: string): Buffer => {
    if (!Buffer.isBuffer(b) || b.length === 0) throw new ConnectorSecretVaultError(`incomplete stored envelope: ${label}`);
    return b;
  };
  if (typeof c.aad_digest !== "string" || c.aad_digest.length === 0) throw new ConnectorSecretVaultError("incomplete stored envelope: aad_digest");
  if (typeof c.key_id !== "string" || c.key_id.length === 0) throw new ConnectorSecretVaultError("incomplete stored envelope: key_id");
  if (c.envelope_version !== 1) throw new ConnectorSecretVaultError("unsupported stored envelope version");
  if (c.aead_alg !== "AES-256-GCM") throw new ConnectorSecretVaultError("unsupported stored envelope algorithm");
  return {
    v: 1,
    alg: "AES-256-GCM",
    kekId: c.key_id,
    wrappedDek: need(c.dek_wrapped, "dek_wrapped").toString("base64"),
    iv: need(c.aead_nonce, "aead_nonce").toString("base64"),
    ciphertext: need(c.ciphertext, "ciphertext").toString("base64"),
    tag: need(c.aead_tag, "aead_tag").toString("base64"),
    aadDigest: c.aad_digest,
  };
}

// The INJECTED store boundary. Backed by the runner DB client (`SET ROLE connector_runner`, the narrow 0029
// SELECT+INSERT grant) when wired — NEVER a service-role / request-path client. Tests inject a mock.
export interface ConnectorSecretWriteStore {
  // INSERT a new encrypted secret row (runner INSERT). Returns the new row id. Writes ONLY ciphertext columns.
  insertEncryptedSecret(input: {
    tenantId: string;
    connectorId: string;
    dbSecretKind: string;
    version: number;
    encrypted: EncryptedConnectorSecret;
  }): Promise<{ id: string }>;
}
export interface ConnectorSecretReadStore {
  // SELECT the active encrypted secret for a context (runner SELECT). Null when none. Returns ONLY ciphertext.
  findEncryptedSecret(input: {
    tenantId: string;
    connectorId: string;
    dbSecretKind: string;
    version: number;
  }): Promise<StoredEncryptedSecret | null>;
}

// The REDACTED save result handed back to the (possibly request-path-initiated) caller: a reference only.
// NO plaintext, NO ciphertext, NO wrapped DEK — just non-secret identifiers + the (non-secret) KEK handle.
export type SavedSecretRef = {
  secretId: string;
  tenantId: string;
  connectorId: string;
  secretKind: SecretKind;
  version: number;
  kekId: string;
};

// A redaction wrapper around decrypted plaintext. The bytes are private; string/JSON/inspect conversions are
// redacted, so the secret can never be logged or serialized by accident. Reach the bytes ONLY via `.expose()`.
const REDACTED = "[REDACTED connector secret]";
export class RedactedSecret {
  #plaintext: Buffer;
  constructor(plaintext: Buffer) {
    this.#plaintext = plaintext;
  }
  // Runner-only: get the raw bytes to USE (e.g. a provider API call). The caller must never log the result.
  expose(): Buffer {
    return this.#plaintext;
  }
  toString(): string {
    return REDACTED;
  }
  toJSON(): string {
    return REDACTED;
  }
  // node's util.inspect / console.log hook — redact here too.
  [Symbol.for("nodejs.util.inspect.custom")](): string {
    return REDACTED;
  }
}

// ── runner-only decrypt capability ──────────────────────────────────────────────────────────────────────
// A module-private token: the capability constructor REQUIRES it, and it is never exported — so a
// `RunnerDecryptCapability` cannot be forged by request-path code (only `acquireRunnerDecryptCapability` holds
// the token). The capability carries the decrypt-capable key provider; without the capability there is no
// provider to decrypt with.
const CAP_TOKEN = Symbol("connector-vault-runner-decrypt-capability");

export class RunnerDecryptCapability {
  readonly #keyProvider: ConnectorVaultKeyProvider;
  constructor(token: symbol, keyProvider: ConnectorVaultKeyProvider) {
    if (token !== CAP_TOKEN)
      throw new ConnectorSecretVaultError("RunnerDecryptCapability cannot be constructed directly");
    this.#keyProvider = keyProvider;
  }
  /** internal — used only by loadConnectorSecret within this module. */
  _provider(): ConnectorVaultKeyProvider {
    return this.#keyProvider;
  }
}

// Acquire the runner-only decrypt capability. Returns null (fail closed) UNLESS the runner-runtime marker is
// present AND a decrypt-capable key provider is supplied — so the request-path runtime (no marker, no decrypt
// provider) can never obtain it. The runner entrypoint passes `process.env.CONNECTOR_VAULT_RUNNER` as
// `runnerEnv` and the KMS-backed decrypt provider as `keyProvider`.
export function acquireRunnerDecryptCapability(input: {
  runnerEnv: string | undefined;
  keyProvider: ConnectorVaultKeyProvider;
}): RunnerDecryptCapability | null {
  if (!input || input.runnerEnv !== RUNNER_RUNTIME_MARKER) return null;
  if (!input.keyProvider || typeof input.keyProvider.unwrapDataKey !== "function") return null;
  return new RunnerDecryptCapability(CAP_TOKEN, input.keyProvider);
}

// ── save (encrypt-only) ─────────────────────────────────────────────────────────────────────────────────
// Wrap an encrypt-only provider into the full crypto interface with a DECRYPT that always throws — so the save
// path structurally cannot decrypt even though crypto's type wants both methods (encrypt uses only generate).
function asEncryptOnly(provider: EncryptOnlyKeyProvider): ConnectorVaultKeyProvider {
  return {
    generateDataKey: (kekId: string) => provider.generateDataKey(kekId),
    unwrapDataKey: async () => {
      throw new ConnectorSecretVaultError("encrypt-only key provider cannot decrypt");
    },
  };
}

// Save a connector secret: encrypt the plaintext and write ONLY ciphertext to the store. The tenant is bound
// from the server-supplied `context` (never a provider payload). Returns a REDACTED reference with no secret
// bytes. Fails closed (typed, redacted error) on any crypto/store failure.
export async function saveConnectorSecret(input: {
  plaintext: Buffer | string;
  context: SecretContext;
  keyProvider: EncryptOnlyKeyProvider;
  kekId: string;
  store: ConnectorSecretWriteStore;
}): Promise<SavedSecretRef> {
  const { context, kekId, store } = input;
  if (!store || typeof store.insertEncryptedSecret !== "function")
    throw new ConnectorSecretVaultError("missing or invalid secret write store");

  let encrypted: EncryptedConnectorSecret;
  try {
    encrypted = await encryptConnectorSecret({
      plaintext: input.plaintext,
      context,
      keyProvider: asEncryptOnly(input.keyProvider),
      kekId,
    });
  } catch (e) {
    // crypto already throws a safe, redacted ConnectorVaultCryptoError; never re-surface bytes.
    if (e instanceof ConnectorVaultCryptoError) throw e;
    throw new ConnectorSecretVaultError("failed to encrypt connector secret");
  }

  const { id } = await store.insertEncryptedSecret({
    tenantId: context.tenantId, // server/auth context — NOT a payload value
    connectorId: context.connectorId,
    dbSecretKind: CRYPTO_TO_DB_KIND[context.secretKind],
    version: context.version,
    encrypted,
  });

  // REDACTED result: identifiers + non-secret KEK handle only. No plaintext, no ciphertext, no wrapped DEK.
  return {
    secretId: id,
    tenantId: context.tenantId,
    connectorId: context.connectorId,
    secretKind: context.secretKind,
    version: context.version,
    kekId,
  };
}

// ── load / decrypt (runner-only) ────────────────────────────────────────────────────────────────────────
// Decrypt a connector secret. REQUIRES a runner-only `RunnerDecryptCapability` — request-path code cannot
// construct one, so it cannot decrypt. Reads ciphertext via the (runner-backed) read store, then decrypts with
// the capability's decrypt-capable provider. The AAD binds the context, so a row sealed for another tenant/
// connector/kind/version fails closed. Returns plaintext ONLY inside a `RedactedSecret`.
export async function loadConnectorSecret(
  capability: RunnerDecryptCapability,
  input: { context: SecretContext; store: ConnectorSecretReadStore },
): Promise<RedactedSecret> {
  if (!(capability instanceof RunnerDecryptCapability))
    throw new ConnectorSecretVaultError("decrypt requires a runner-only capability");
  const { context, store } = input;
  if (!store || typeof store.findEncryptedSecret !== "function")
    throw new ConnectorSecretVaultError("missing or invalid secret read store");

  const found = await store.findEncryptedSecret({
    tenantId: context.tenantId,
    connectorId: context.connectorId,
    dbSecretKind: CRYPTO_TO_DB_KIND[context.secretKind],
    version: context.version,
  });
  if (!found) throw new ConnectorSecretVaultError("connector secret not found");

  const plaintext = await decryptConnectorSecret({
    encrypted: found.encrypted,
    context,
    keyProvider: capability._provider(),
  });
  return new RedactedSecret(plaintext);
}
