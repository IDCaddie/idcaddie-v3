// Server-only KMS-backed ConnectorVaultKeyProvider adapter skeleton (docs/42 §32.1, gated vault).
//
// This is the reviewed production key-provider BOUNDARY required before any real connector credential may
// be stored (docs/42 §32.4 gate 2). It adapts the §32.1 decision — an EXTERNAL managed KMS (AWS KMS / GCP
// KMS) holds the KEK; only the WRAPPED DEK is persisted — to the PR C `ConnectorVaultKeyProvider` interface
// the crypto wrapper already consumes. It DOES NOT store any credential, read/write `connector_secrets`,
// access a database, import a Supabase client, exchange OAuth codes, or use a privileged path.
//
// NO SDK DEPENDENCY. The actual AWS/GCP call surface is reduced to a tiny dependency-free `KmsClient`
// boundary (two methods that map 1:1 to AWS KMS `GenerateDataKey`/`Decrypt` and GCP KMS `encrypt`/
// `decrypt`). A real KMS-backed `KmsClient` is wired in a LATER gated PR (and would be the ONLY place an
// SDK is introduced, with mocked tests); THIS PR ships only the adapter + a test-only fake. Keeping the
// adapter SDK-free means unit tests need NO AWS/GCP credentials and make NO network call.
//
// SERVER-ONLY. Same discipline as crypto.ts: it lives under `src/lib/server/`, carries the runtime browser
// sentinel below, and `no-client-import.test.ts` asserts no `"use client"` / `src/app` file imports it. Its
// only import is the TYPE of `ConnectorVaultKeyProvider` (erased at runtime) — no Supabase, no service-role.
//
// REDACTION (docs/42 §11): wrap/unwrap failures throw a typed, safe-message error — NEVER a plaintext DEK,
// wrapped-DEK bytes, ciphertext, or KEK material. Key ids/aliases are non-sensitive METADATA (they name a
// KMS key, they are not the key) but are still never pushed to a browser surface. Nothing here logs.

import type { ConnectorVaultKeyProvider } from "./crypto";

// Runtime server-only sentinel — throw if evaluated in a browser.
if (typeof (globalThis as { window?: unknown }).window !== "undefined") {
  throw new Error("connector-vault/kms-key-provider is server-only and must not be imported in client code");
}

const DEK_BYTES = 32; // AES-256 — must match crypto.ts

// A typed, safe-to-surface error. Its message is a fixed static string — never key/ciphertext/plaintext.
export class ConnectorVaultKeyProviderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConnectorVaultKeyProviderError";
  }
}

// The minimal envelope-KMS boundary (NO SDK). A production implementation backs this with AWS KMS
// `GenerateDataKey` + `Decrypt` (or GCP KMS) under the runner's IAM identity — wired in a later PR. Tests
// inject an in-memory fake. The plaintext DEK exists only transiently here; the KEK never leaves the KMS.
export interface KmsClient {
  // GenerateDataKey under the named KEK: a fresh random DEK + its KMS-wrapped form. MUST NOT return the KEK.
  generateDataKey(kekId: string): Promise<{ dek: Buffer; wrappedDek: Buffer }>;
  // Decrypt a wrapped DEK under the named KEK. MUST throw on wrong KEK / tamper. MUST NOT return the KEK.
  decrypt(wrappedDek: Buffer, kekId: string): Promise<Buffer>;
}

// Adapter config. `currentKekId` is the KMS key id/alias new secrets are wrapped under; `previousKekIds`
// are kept decryptable during a rotation grace window (docs/42 §32.1 — rotate by alias, no re-encryption).
export type KmsKeyProviderConfig = {
  kmsClient: KmsClient;
  currentKekId: string;
  previousKekIds?: readonly string[];
};

// The adapter return type: the standard provider PLUS the explicit (non-secret) key-id metadata a future
// storage/runner records (which KEK is current, and the full set that may still be unwrapped).
export type KmsConnectorVaultKeyProvider = ConnectorVaultKeyProvider & {
  readonly currentKekId: string;
  readonly allowedKekIds: readonly string[];
};

function assertValidDek(dek: unknown): asserts dek is Buffer {
  if (!Buffer.isBuffer(dek) || dek.length !== DEK_BYTES)
    throw new ConnectorVaultKeyProviderError("KMS returned an invalid data key");
}

// Build a KMS-backed ConnectorVaultKeyProvider. FAILS CLOSED on missing/invalid config (no kmsClient, no
// currentKekId) — an unconfigured production deploy can never silently no-op into a weak path. Wrapping a
// NEW secret only happens under `currentKekId`; unwrapping accepts the current OR a previous (grace-window)
// KEK; any other key id is rejected. The wrap/unwrap KMS calls are delegated to the injected client and
// wrapped in try/catch so a KMS failure surfaces as a safe, redacted error.
export function createKmsKeyProvider(config: KmsKeyProviderConfig): KmsConnectorVaultKeyProvider {
  if (!config || typeof config !== "object")
    throw new ConnectorVaultKeyProviderError("KMS key provider is not configured");
  const { kmsClient, currentKekId } = config;
  if (!kmsClient || typeof kmsClient.generateDataKey !== "function" || typeof kmsClient.decrypt !== "function")
    throw new ConnectorVaultKeyProviderError("KMS key provider is not configured (no KMS client)");
  if (typeof currentKekId !== "string" || currentKekId.length === 0)
    throw new ConnectorVaultKeyProviderError("KMS key provider is not configured (no current KEK id)");
  const previous = (config.previousKekIds ?? []).filter((k) => typeof k === "string" && k.length > 0);
  const allowed = [currentKekId, ...previous.filter((k) => k !== currentKekId)];
  const allowedSet = new Set(allowed);

  return {
    currentKekId,
    allowedKekIds: allowed,

    async generateDataKey(kekId: string): Promise<{ dek: Buffer; wrappedDek: Buffer }> {
      // New secrets are ONLY wrapped under the current KEK (an old key is read-only during rotation).
      if (kekId !== currentKekId)
        throw new ConnectorVaultKeyProviderError("refusing to wrap a new data key under a non-current KEK id");
      let result: { dek: Buffer; wrappedDek: Buffer };
      try {
        result = await kmsClient.generateDataKey(kekId);
      } catch {
        throw new ConnectorVaultKeyProviderError("KMS generate-data-key failed");
      }
      assertValidDek(result?.dek);
      if (!Buffer.isBuffer(result.wrappedDek) || result.wrappedDek.length === 0)
        throw new ConnectorVaultKeyProviderError("KMS returned an invalid wrapped data key");
      return { dek: result.dek, wrappedDek: result.wrappedDek };
    },

    async unwrapDataKey(wrappedDek: Buffer, kekId: string): Promise<Buffer> {
      // Reject an unknown key id BEFORE any KMS call (a row referencing a retired/foreign KEK fails closed).
      if (!allowedSet.has(kekId))
        throw new ConnectorVaultKeyProviderError("unknown or unsupported KEK id");
      if (!Buffer.isBuffer(wrappedDek) || wrappedDek.length === 0)
        throw new ConnectorVaultKeyProviderError("invalid wrapped data key");
      let dek: Buffer;
      try {
        dek = await kmsClient.decrypt(wrappedDek, kekId);
      } catch {
        // wrong KEK / tamper / KMS unavailable — fail closed, never surface key/ciphertext/plaintext bytes.
        throw new ConnectorVaultKeyProviderError("KMS unwrap failed (wrong KEK or tampered wrapped key)");
      }
      assertValidDek(dek);
      return dek;
    },
  };
}

// Read the (non-secret) KEK id/alias config from server-only env. Returns null when UNCONFIGURED (fail
// closed — a production wiring that forgets to set the key id gets no provider, never a default). This is
// METADATA only: it names KMS keys, it never reads or returns key material, and it binds NO `KmsClient`
// (the real KMS-backed client is a later gated PR), so a production deploy stays inert until BOTH the env
// config AND a real client are wired and reviewed.
export function kmsKeyProviderConfigFromEnv(): { currentKekId: string; previousKekIds: string[] } | null {
  const currentKekId = process.env.CONNECTOR_VAULT_KMS_KEY_ID;
  if (!currentKekId) return null;
  const previousKekIds = (process.env.CONNECTOR_VAULT_KMS_PREVIOUS_KEY_IDS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return { currentKekId, previousKekIds };
}
