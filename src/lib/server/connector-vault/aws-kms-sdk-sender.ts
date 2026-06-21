// Server-only AWS KMS SDK sender wiring (docs/42 §32.1/§36/§37, gated vault).
//
// This is the concrete, SDK-backed implementation of the `AwsKmsCommandSender` seam that PR #114's
// `createAwsKmsClient` consumes — the ONE place `@aws-sdk/client-kms` is introduced. It builds the real
// AWS KMS `GenerateDataKeyCommand` / `DecryptCommand` objects and calls `KMSClient.send(...)`. It DOES NOT
// store any credential, read/write `connector_secrets`, access a database, import a Supabase client,
// exchange OAuth codes, or use a privileged path. It is wired to NOTHING (no connector, no OAuth callback,
// no route) — a later gated PR composes it into the runner.
//
// INERT WITHOUT CONFIG. `createAwsKmsSdkSender` validates the region and fails closed if missing/garbage;
// `createAwsKmsSdkSenderFromEnv()` returns null unless `CONNECTOR_VAULT_AWS_KMS_REGION` is set (this PR sets
// no env). The AWS credentials come from the runner's IAM identity via the SDK's default provider chain —
// NEVER hardcoded, never read from a vault-managed secret here. **The vault stays NOT usable for real
// credentials.**
//
// TESTABLE WITHOUT AWS. The SDK call is isolated behind `awsKmsSenderFromClient(client)`, which takes any
// `{ send(command) }` — the real `KMSClient` satisfies it, and tests inject a MOCK client. So this module's
// tests need NO AWS credentials and make NO live KMS call (the mock returns canned responses and asserts
// the emitted `GenerateDataKeyCommand`/`DecryptCommand` shapes).
//
// SERVER-ONLY. Under `src/lib/server/`, a runtime browser sentinel, and the `no-client-import.test.ts`
// guard. The SDK import is server-only and reached by no client/route code.
//
// REDACTION (docs/42 §11): a send failure / malformed response throws a typed `AwsKmsSdkError` with a fixed
// safe message — NEVER a plaintext DEK, a ciphertext blob, the KEK, the region, or the raw AWS error body.
// Nothing logs.

import { KMSClient, GenerateDataKeyCommand, DecryptCommand } from "@aws-sdk/client-kms";
import {
  awsKmsConfigFromEnv,
  type AwsKmsCommand,
  type AwsKmsCommandSender,
  type AwsKmsResponse,
} from "./aws-kms-client";

// Runtime server-only sentinel — throw if evaluated in a browser.
if (typeof (globalThis as { window?: unknown }).window !== "undefined") {
  throw new Error("connector-vault/aws-kms-sdk-sender is server-only and must not be imported in client code");
}

const AWS_REGION_RE = /^[a-z]{2}-[a-z-]+-\d+$/;

// A typed, safe-to-surface error. Its message is a fixed static string — never key/blob/region/AWS detail.
export class AwsKmsSdkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AwsKmsSdkError";
  }
}

// The minimal AWS SDK client surface this module uses (`new KMSClient(...)` satisfies it). Tests inject a
// mock `{ send }` — no SDK client is constructed, no network call is made.
export type AwsKmsSdkClient = {
  send(command: unknown): Promise<{ Plaintext?: Uint8Array; CiphertextBlob?: Uint8Array } | undefined>;
};

// The testable core: turn our `AwsKmsCommand` into the real AWS KMS Command object, send it via the injected
// client, and map the SDK output back to our `AwsKmsResponse`. Redacts any send error / malformed response.
export function awsKmsSenderFromClient(client: AwsKmsSdkClient): AwsKmsCommandSender {
  if (!client || typeof client.send !== "function")
    throw new AwsKmsSdkError("AWS KMS SDK sender is not configured (no client)");
  return async (command: AwsKmsCommand): Promise<AwsKmsResponse> => {
    const sdkCommand =
      command.name === "GenerateDataKey"
        ? new GenerateDataKeyCommand({ KeyId: command.input.KeyId, KeySpec: command.input.KeySpec })
        : new DecryptCommand({ KeyId: command.input.KeyId, CiphertextBlob: command.input.CiphertextBlob });
    let out: { Plaintext?: Uint8Array; CiphertextBlob?: Uint8Array } | undefined;
    try {
      out = await client.send(sdkCommand);
    } catch {
      // swallow the raw AWS/SDK error — never surface its body/region/key/blob. The downstream
      // createAwsKmsClient adapter (§36) treats this as a redacted failure and never logs it.
      throw new AwsKmsSdkError("AWS KMS send failed");
    }
    if (!out || typeof out !== "object")
      throw new AwsKmsSdkError("AWS KMS returned a malformed response");
    // Map only the safe fields the adapter validates; never log them.
    return { Plaintext: out.Plaintext, CiphertextBlob: out.CiphertextBlob };
  };
}

// Build the SDK sender from explicit config. FAILS CLOSED on a missing/garbage region (validated before any
// client is constructed). Constructs `new KMSClient({ region })` — credentials resolve lazily from the
// runner's IAM identity via the AWS default provider chain (never hardcoded, never read here).
export function createAwsKmsSdkSender(config: { region: string }): AwsKmsCommandSender {
  if (!config || typeof config !== "object")
    throw new AwsKmsSdkError("AWS KMS SDK sender is not configured");
  const { region } = config;
  if (typeof region !== "string" || !AWS_REGION_RE.test(region))
    throw new AwsKmsSdkError("AWS KMS SDK sender is not configured (invalid region)");
  return awsKmsSenderFromClient(new KMSClient({ region }) as unknown as AwsKmsSdkClient);
}

// Build the SDK sender from server-only env, or null when UNCONFIGURED (fail closed — no region, no sender).
// This PR sets no env, so it returns null and a production deploy stays inert until the region is wired and
// reviewed. It reads NO credential and returns NO key material.
export function createAwsKmsSdkSenderFromEnv(): AwsKmsCommandSender | null {
  const config = awsKmsConfigFromEnv();
  if (!config) return null;
  return createAwsKmsSdkSender(config);
}
