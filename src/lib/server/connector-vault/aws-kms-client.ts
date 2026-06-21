// Server-only AWS KMS client adapter skeleton (docs/42 §32.1/§35/§36, gated vault).
//
// This is the concrete `KmsClient` (PR #113 boundary) for the §32.1 chosen provider — AWS KMS. It maps the
// envelope-KMS operations to the AWS KMS command SHAPES — `GenerateDataKey` (wrap) and `Decrypt` (unwrap) —
// and sends them through an INJECTED command sender. It DOES NOT store any credential, read/write
// `connector_secrets`, access a database, import a Supabase client, exchange OAuth codes, or use a
// privileged path.
//
// NO SDK DEPENDENCY (yet). Following PR #113's dependency-free discipline, the actual `@aws-sdk/client-kms`
// call surface is reduced to a tiny injected `AwsKmsCommandSender` — `(command) => Promise<response>`. This
// adapter builds the exact AWS KMS command objects and validates the responses; **wiring a real SDK-backed
// sender is the NEXT gate** (a later PR adds `@aws-sdk/client-kms` as the ONLY place an SDK is introduced,
// constructs `new KMSClient({region}).send(new GenerateDataKeyCommand(...))`, and mocks the SDK in tests).
// Keeping the sender injected means THIS adapter's unit tests need NO AWS credentials and make NO live KMS
// call — a mock sender returns canned responses, and the tests assert the command shapes.
//
// SERVER-ONLY. Same discipline as crypto.ts / kms-key-provider.ts: under `src/lib/server/`, a runtime
// browser sentinel, and the `no-client-import.test.ts` guard. The only import is the erased `KmsClient` type.
//
// REDACTION (docs/42 §11): every thrown error is a fixed safe message — NEVER a plaintext data key, the
// wrapped/ciphertext blob, the KEK, the region, or the injected sender's underlying error. Nothing logs.
// Key ids/aliases + region are non-sensitive metadata (they name a KMS key / a place), never the key.

import type { KmsClient } from "./kms-key-provider";

// Runtime server-only sentinel — throw if evaluated in a browser.
if (typeof (globalThis as { window?: unknown }).window !== "undefined") {
  throw new Error("connector-vault/aws-kms-client is server-only and must not be imported in client code");
}

const DEK_BYTES = 32; // AES-256 — must match crypto.ts / kms-key-provider.ts

// A typed, safe-to-surface error. Its message is a fixed static string — never key/blob/region/SDK detail.
export class AwsKmsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AwsKmsError";
  }
}

// The AWS KMS command shapes this adapter emits (the exact GenerateDataKey / Decrypt inputs a real
// `@aws-sdk/client-kms` sender would forward). KeySpec AES_256 → a 32-byte plaintext DEK + a wrapped blob.
export type AwsKmsCommand =
  | { name: "GenerateDataKey"; input: { KeyId: string; KeySpec: "AES_256" } }
  | { name: "Decrypt"; input: { KeyId: string; CiphertextBlob: Uint8Array } };

// The AWS KMS response shapes (a subset). AWS returns binary fields as `Uint8Array`.
export type AwsKmsResponse = {
  Plaintext?: Uint8Array;
  CiphertextBlob?: Uint8Array;
};

// The injected boundary a future SDK-backed implementation satisfies (its body would be
// `kmsClient.send(commandFor(name, input))`). Tests inject a mock — no SDK, no network, no credentials.
export type AwsKmsCommandSender = (command: AwsKmsCommand) => Promise<AwsKmsResponse>;

export type AwsKmsConfig = {
  send: AwsKmsCommandSender;
  region: string; // an AWS region (e.g. us-east-1) — metadata; validated, not a secret
};

// AWS region format (e.g. us-east-1, eu-west-2, ap-southeast-1, us-gov-west-1). A loose-but-real check —
// rejects an empty/garbage region so a misconfigured deploy fails closed before any KMS call.
const AWS_REGION_RE = /^[a-z]{2}-[a-z-]+-\d+$/;

function toBuffer(v: unknown): Buffer | null {
  if (Buffer.isBuffer(v)) return v;
  if (v instanceof Uint8Array) return Buffer.from(v);
  return null;
}

// Build the concrete AWS KMS `KmsClient`. FAILS CLOSED on missing/invalid config (no `send`, missing/garbage
// `region`) — an unconfigured deploy can never silently no-op. The wrap/unwrap KMS calls are delegated to
// the injected sender and wrapped in try/catch so a KMS/SDK failure surfaces as a safe, redacted error.
export function createAwsKmsClient(config: AwsKmsConfig): KmsClient {
  if (!config || typeof config !== "object")
    throw new AwsKmsError("AWS KMS client is not configured");
  const { send, region } = config;
  if (typeof send !== "function")
    throw new AwsKmsError("AWS KMS client is not configured (no command sender)");
  if (typeof region !== "string" || !AWS_REGION_RE.test(region))
    throw new AwsKmsError("AWS KMS client is not configured (invalid region)");

  return {
    async generateDataKey(kekId: string): Promise<{ dek: Buffer; wrappedDek: Buffer }> {
      if (typeof kekId !== "string" || kekId.length === 0)
        throw new AwsKmsError("invalid KEK id");
      let res: AwsKmsResponse;
      try {
        // AWS KMS GenerateDataKey: KeySpec AES_256 → { Plaintext (the DEK), CiphertextBlob (wrapped DEK) }.
        res = await send({ name: "GenerateDataKey", input: { KeyId: kekId, KeySpec: "AES_256" } });
      } catch {
        throw new AwsKmsError("AWS KMS GenerateDataKey failed");
      }
      const dek = toBuffer(res?.Plaintext);
      const wrappedDek = toBuffer(res?.CiphertextBlob);
      if (!dek || dek.length !== DEK_BYTES || !wrappedDek || wrappedDek.length === 0)
        throw new AwsKmsError("AWS KMS returned a malformed GenerateDataKey response");
      return { dek, wrappedDek };
    },

    async decrypt(wrappedDek: Buffer, kekId: string): Promise<Buffer> {
      if (typeof kekId !== "string" || kekId.length === 0)
        throw new AwsKmsError("invalid KEK id");
      if (!Buffer.isBuffer(wrappedDek) || wrappedDek.length === 0)
        throw new AwsKmsError("invalid wrapped data key");
      let res: AwsKmsResponse;
      try {
        // AWS KMS Decrypt: passing KeyId makes KMS ENFORCE the blob was wrapped under that key (it errors
        // on a mismatch — defense in depth) rather than inferring it from the blob.
        res = await send({ name: "Decrypt", input: { KeyId: kekId, CiphertextBlob: Uint8Array.from(wrappedDek) } });
      } catch {
        // wrong KEK / tamper / KMS unavailable — fail closed, never surface key/blob/region/SDK bytes.
        throw new AwsKmsError("AWS KMS Decrypt failed (wrong KEK or tampered wrapped key)");
      }
      const dek = toBuffer(res?.Plaintext);
      if (!dek || dek.length !== DEK_BYTES)
        throw new AwsKmsError("AWS KMS returned a malformed Decrypt response");
      return dek;
    },
  };
}

// Read the (non-secret) AWS region config from server-only env. Returns null when UNCONFIGURED (fail closed
// — no region, no client). This is METADATA only; it binds NO command sender (the real `@aws-sdk/client-kms`
// sender is the next gate), so a production deploy stays inert until BOTH the region config AND a reviewed
// SDK-backed sender are wired. It never reads or returns key material.
export function awsKmsConfigFromEnv(): { region: string } | null {
  const region = process.env.CONNECTOR_VAULT_AWS_KMS_REGION;
  if (!region || !AWS_REGION_RE.test(region)) return null;
  return { region };
}
