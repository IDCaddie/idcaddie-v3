import { describe, it, expect, afterEach } from "vitest";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import {
  createAwsKmsClient,
  awsKmsConfigFromEnv,
  AwsKmsError,
  type AwsKmsCommand,
  type AwsKmsCommandSender,
  type AwsKmsResponse,
} from "./aws-kms-client";
import { createKmsKeyProvider } from "./kms-key-provider";
import { encryptConnectorSecret, decryptConnectorSecret, type SecretContext } from "./crypto";

const REGION = "us-east-1";
const KEK = "arn:aws:kms:us-east-1:111122223333:key/abcd-1234";

// ── Mock AWS KMS command sender (NO @aws-sdk, NO network, NO real credentials) ─────────────────────────
// Models AWS KMS GenerateDataKey/Decrypt envelope behavior over a single in-process KEK using AES-256-GCM
// (KeyId bound as AAD so a wrong KeyId on Decrypt fails). It RECORDS the commands it receives so a test can
// assert the exact AWS command shape the adapter emits. The KEK never leaves the mock.
function makeMockKms() {
  const kek = randomBytes(32);
  const commands: AwsKmsCommand[] = [];
  const send: AwsKmsCommandSender = async (command) => {
    commands.push(command);
    if (command.name === "GenerateDataKey") {
      const dek = randomBytes(32);
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", kek, iv);
      cipher.setAAD(Buffer.from(command.input.KeyId, "utf8"));
      const ct = Buffer.concat([cipher.update(dek), cipher.final()]);
      const blob = Buffer.concat([iv, cipher.getAuthTag(), ct]); // iv|tag|ct
      return { Plaintext: Uint8Array.from(dek), CiphertextBlob: Uint8Array.from(blob) };
    }
    // Decrypt
    const blob = Buffer.from(command.input.CiphertextBlob);
    const iv = blob.subarray(0, 12);
    const tag = blob.subarray(12, 28);
    const ct = blob.subarray(28);
    const decipher = createDecipheriv("aes-256-gcm", kek, iv);
    decipher.setAAD(Buffer.from(command.input.KeyId, "utf8"));
    decipher.setAuthTag(tag);
    const dek = Buffer.concat([decipher.update(ct), decipher.final()]); // throws on wrong KeyId / tamper
    return { Plaintext: Uint8Array.from(dek) };
  };
  return { send, commands };
}

describe("createAwsKmsClient — config / fail-closed", () => {
  it("fails closed on missing config (null / no sender / missing-or-garbage region)", () => {
    const { send } = makeMockKms();
    // @ts-expect-error — null config rejected
    expect(() => createAwsKmsClient(null)).toThrow(AwsKmsError);
    // @ts-expect-error — no sender
    expect(() => createAwsKmsClient({ region: REGION })).toThrow(AwsKmsError);
    expect(() => createAwsKmsClient({ send, region: "" })).toThrow(AwsKmsError);
    expect(() => createAwsKmsClient({ send, region: "not-a-region" })).toThrow(AwsKmsError);
  });
});

describe("createAwsKmsClient — command-shape mapping", () => {
  it("maps wrap to a GenerateDataKey command (KeyId + KeySpec AES_256)", async () => {
    const { send, commands } = makeMockKms();
    const client = createAwsKmsClient({ send, region: REGION });
    const { dek, wrappedDek } = await client.generateDataKey(KEK);
    expect(dek.length).toBe(32);
    expect(wrappedDek.length).toBeGreaterThan(0);
    expect(commands[0]).toEqual({ name: "GenerateDataKey", input: { KeyId: KEK, KeySpec: "AES_256" } });
  });

  it("maps unwrap to a Decrypt command (KeyId + CiphertextBlob)", async () => {
    const { send, commands } = makeMockKms();
    const client = createAwsKmsClient({ send, region: REGION });
    const { wrappedDek } = await client.generateDataKey(KEK);
    const back = await client.decrypt(wrappedDek, KEK);
    expect(back.length).toBe(32);
    const decryptCmd = commands.find((c) => c.name === "Decrypt");
    expect(decryptCmd?.name).toBe("Decrypt");
    expect(decryptCmd && decryptCmd.input.KeyId).toBe(KEK);
    expect(decryptCmd && decryptCmd.input.CiphertextBlob instanceof Uint8Array).toBe(true);
  });

  it("a mocked GenerateDataKey success returns the plaintext + wrapped DEK only through the contract", async () => {
    const { send } = makeMockKms();
    const client = createAwsKmsClient({ send, region: REGION });
    const { dek, wrappedDek } = await client.generateDataKey(KEK);
    expect(Buffer.isBuffer(dek) && Buffer.isBuffer(wrappedDek)).toBe(true);
    // round-trips through the same mock
    expect((await client.decrypt(wrappedDek, KEK)).equals(dek)).toBe(true);
  });
});

describe("createAwsKmsClient — redacted errors / fail closed on bad response", () => {
  it("a KMS/SDK error is redacted (no underlying message surfaces)", async () => {
    const send: AwsKmsCommandSender = async () => {
      throw new Error("AWS-INTERNAL-KEY-MATERIAL-should-never-surface");
    };
    const client = createAwsKmsClient({ send, region: REGION });
    let m = "";
    try { await client.generateDataKey(KEK); } catch (e) { m = (e as Error).message; }
    expect(m).toMatch(/GenerateDataKey failed/);
    expect(m).not.toContain("AWS-INTERNAL-KEY-MATERIAL");

    let m2 = "";
    try { await client.decrypt(Buffer.from("x"), KEK); } catch (e) { m2 = (e as Error).message; }
    expect(m2).toMatch(/Decrypt failed/);
    expect(m2).not.toContain("AWS-INTERNAL-KEY-MATERIAL");
  });

  it("a malformed/missing KMS response fails closed (no plaintext / wrong-length DEK)", async () => {
    const missing: AwsKmsCommandSender = async (c) =>
      c.name === "GenerateDataKey" ? ({ CiphertextBlob: Uint8Array.from(randomBytes(40)) } as AwsKmsResponse) : ({} as AwsKmsResponse);
    const c1 = createAwsKmsClient({ send: missing, region: REGION });
    await expect(c1.generateDataKey(KEK)).rejects.toBeInstanceOf(AwsKmsError); // no Plaintext
    await expect(c1.decrypt(Buffer.from(randomBytes(40)), KEK)).rejects.toBeInstanceOf(AwsKmsError); // no Plaintext

    const shortDek: AwsKmsCommandSender = async () => ({ Plaintext: Uint8Array.from(randomBytes(16)), CiphertextBlob: Uint8Array.from(randomBytes(40)) });
    const c2 = createAwsKmsClient({ send: shortDek, region: REGION });
    await expect(c2.generateDataKey(KEK)).rejects.toBeInstanceOf(AwsKmsError); // 16-byte DEK ≠ AES-256
    // a present-but-short Plaintext on the DECRYPT path also fails closed (pins that branch)
    await expect(c2.decrypt(Buffer.from(randomBytes(40)), KEK)).rejects.toBeInstanceOf(AwsKmsError);
  });

  it("a wrong KeyId on Decrypt fails closed (the mock KMS rejects it)", async () => {
    const { send } = makeMockKms();
    const client = createAwsKmsClient({ send, region: REGION });
    const { wrappedDek } = await client.generateDataKey(KEK);
    await expect(client.decrypt(wrappedDek, "arn:aws:kms:us-east-1:111122223333:key/OTHER")).rejects.toBeInstanceOf(AwsKmsError);
  });
});

describe("the AWS KMS adapter composes with the key provider + crypto wrapper (no real KMS)", () => {
  const ctx: SecretContext = {
    tenantId: "11111111-1111-1111-1111-111111111111",
    connectorId: "17000000-0000-0000-0000-0000000000a1",
    secretKind: "oauth_access_token",
    version: 1,
  };
  const SECRET = "ghp_FAKE-test-only-personal-access-token-NOT-real";

  it("encrypt/decrypt round-trips through createKmsKeyProvider(createAwsKmsClient(mock))", async () => {
    const { send } = makeMockKms();
    const kp = createKmsKeyProvider({ kmsClient: createAwsKmsClient({ send, region: REGION }), currentKekId: KEK });
    const enc = await encryptConnectorSecret({ plaintext: SECRET, context: ctx, keyProvider: kp, kekId: KEK });
    expect(enc.ciphertext).not.toContain(SECRET);
    const dec = await decryptConnectorSecret({ encrypted: enc, context: ctx, keyProvider: kp });
    expect(dec.toString("utf8")).toBe(SECRET);
  });
});

describe("awsKmsConfigFromEnv — fail closed by default", () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
  });

  it("returns null when the region env is unset / invalid (this PR sets nothing → inert)", () => {
    delete process.env.CONNECTOR_VAULT_AWS_KMS_REGION;
    expect(awsKmsConfigFromEnv()).toBeNull();
    process.env.CONNECTOR_VAULT_AWS_KMS_REGION = "garbage";
    expect(awsKmsConfigFromEnv()).toBeNull();
  });

  it("returns the (non-secret) region metadata when configured", () => {
    process.env.CONNECTOR_VAULT_AWS_KMS_REGION = REGION;
    expect(awsKmsConfigFromEnv()).toEqual({ region: REGION });
  });
});

// Static guard: the adapter touches no DB / Supabase / service-role / connector_secrets, adds NO SDK, and
// makes no network call itself (the injected sender does). It may read process.env ONLY in the config helper.
describe("aws-kms-client module is pure-ish (no DB / Supabase / service-role / connector_secrets / SDK / fetch)", () => {
  it("imports only the KmsClient type and contains no forbidden call or SDK import", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const src = fs.readFileSync(path.resolve(__dirname, "aws-kms-client.ts"), "utf8");
    const imports = [...src.matchAll(/from\s+["']([^"']+)["']/g)].map((m) => m[1]);
    expect(imports).toEqual(["./kms-key-provider"]); // a type-only sibling import (erased at runtime)
    expect(src).toMatch(/import type \{ KmsClient \} from "\.\/kms-key-provider"/);
    const code = src.replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
    expect(code).not.toMatch(/createClient\s*\(/);
    expect(code).not.toMatch(/\bfetch\s*\(/);
    expect(code).not.toContain("@aws-sdk"); // NO SDK dependency imported in code
    expect(code).not.toContain("@google-cloud");
    const secretsTable = ["connector", "secrets"].join("_");
    expect(code).not.toContain(secretsTable);
    const forbidden = ["service", "role"].join("_");
    expect(code).not.toContain(forbidden);
  });
});
