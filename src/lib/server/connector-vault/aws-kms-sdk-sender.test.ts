import { describe, it, expect, vi, afterEach } from "vitest";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { GenerateDataKeyCommand, DecryptCommand } from "@aws-sdk/client-kms";
import {
  awsKmsSenderFromClient,
  createAwsKmsSdkSender,
  createAwsKmsSdkSenderFromEnv,
  AwsKmsSdkError,
  type AwsKmsSdkClient,
} from "./aws-kms-sdk-sender";
import { createAwsKmsClient } from "./aws-kms-client";
import { createKmsKeyProvider } from "./kms-key-provider";
import { encryptConnectorSecret, decryptConnectorSecret, type SecretContext } from "./crypto";

const REGION = "us-east-1";
const KEK = "arn:aws:kms:us-east-1:111122223333:key/abcd-1234";

// A MOCK AWS SDK client (NO real KMSClient, NO network, NO credentials). Its `send` receives a real
// GenerateDataKeyCommand/DecryptCommand instance, reads `command.input`, and simulates AWS KMS envelope
// behavior over a single in-process KEK (KeyId bound as AAD so a wrong KeyId on Decrypt fails). It RECORDS
// the SDK command objects so a test can assert their shape.
function makeMockSdkClient() {
  const kek = randomBytes(32);
  const sent: unknown[] = [];
  const client: AwsKmsSdkClient = {
    send: vi.fn(async (command: unknown) => {
      sent.push(command);
      const input = (command as { input: Record<string, unknown> }).input;
      if (command instanceof GenerateDataKeyCommand) {
        const dek = randomBytes(32);
        const iv = randomBytes(12);
        const cipher = createCipheriv("aes-256-gcm", kek, iv);
        cipher.setAAD(Buffer.from(String(input.KeyId), "utf8"));
        const ct = Buffer.concat([cipher.update(dek), cipher.final()]);
        const blob = Buffer.concat([iv, cipher.getAuthTag(), ct]); // iv|tag|ct
        return { Plaintext: Uint8Array.from(dek), CiphertextBlob: Uint8Array.from(blob) };
      }
      // DecryptCommand
      const blob = Buffer.from(input.CiphertextBlob as Uint8Array);
      const iv = blob.subarray(0, 12);
      const tag = blob.subarray(12, 28);
      const ct = blob.subarray(28);
      const decipher = createDecipheriv("aes-256-gcm", kek, iv);
      decipher.setAAD(Buffer.from(String(input.KeyId), "utf8"));
      decipher.setAuthTag(tag);
      return { Plaintext: Uint8Array.from(Buffer.concat([decipher.update(ct), decipher.final()])) }; // throws on wrong KeyId/tamper
    }),
  };
  return { client, sent };
}

describe("createAwsKmsSdkSender — fail closed on bad config (no client constructed, no network)", () => {
  it("throws on null / missing-or-garbage region", () => {
    // @ts-expect-error — null config
    expect(() => createAwsKmsSdkSender(null)).toThrow(AwsKmsSdkError);
    // @ts-expect-error — no region
    expect(() => createAwsKmsSdkSender({})).toThrow(AwsKmsSdkError);
    expect(() => createAwsKmsSdkSender({ region: "" })).toThrow(AwsKmsSdkError);
    expect(() => createAwsKmsSdkSender({ region: "not-a-region" })).toThrow(AwsKmsSdkError);
  });

  it("awsKmsSenderFromClient fails closed when given no client", () => {
    // @ts-expect-error — null client
    expect(() => awsKmsSenderFromClient(null)).toThrow(AwsKmsSdkError);
    // @ts-expect-error — no send
    expect(() => awsKmsSenderFromClient({})).toThrow(AwsKmsSdkError);
  });
});

describe("awsKmsSenderFromClient — command-shape mapping (mocked client, no live call)", () => {
  it("maps wrap to a GenerateDataKeyCommand { KeyId, KeySpec: AES_256 } and returns the mapped response", async () => {
    const { client, sent } = makeMockSdkClient();
    const sender = awsKmsSenderFromClient(client);
    const res = await sender({ name: "GenerateDataKey", input: { KeyId: KEK, KeySpec: "AES_256" } });
    expect(client.send).toHaveBeenCalledTimes(1); // routed through the injected mock — no real network
    expect(sent[0]).toBeInstanceOf(GenerateDataKeyCommand);
    expect((sent[0] as GenerateDataKeyCommand).input).toEqual({ KeyId: KEK, KeySpec: "AES_256" });
    expect(res.Plaintext instanceof Uint8Array && res.Plaintext.length).toBe(32);
    expect(res.CiphertextBlob instanceof Uint8Array).toBe(true);
  });

  it("maps unwrap to a DecryptCommand { KeyId, CiphertextBlob }", async () => {
    const { client, sent } = makeMockSdkClient();
    const sender = awsKmsSenderFromClient(client);
    const gen = await sender({ name: "GenerateDataKey", input: { KeyId: KEK, KeySpec: "AES_256" } });
    const dec = await sender({ name: "Decrypt", input: { KeyId: KEK, CiphertextBlob: gen.CiphertextBlob! } });
    const decCmd = sent.find((c) => c instanceof DecryptCommand) as DecryptCommand;
    expect(decCmd).toBeInstanceOf(DecryptCommand);
    expect(decCmd.input.KeyId).toBe(KEK);
    expect(decCmd.input.CiphertextBlob instanceof Uint8Array).toBe(true);
    expect(dec.Plaintext instanceof Uint8Array && dec.Plaintext.length).toBe(32);
  });
});

describe("awsKmsSenderFromClient — redaction / fail closed", () => {
  it("swallows the raw AWS/SDK error (no underlying message surfaces)", async () => {
    const client: AwsKmsSdkClient = {
      send: vi.fn(async () => {
        throw new Error("AWS-RAW-ERROR-region-and-creds-and-key-LEAK");
      }),
    };
    const sender = awsKmsSenderFromClient(client);
    let m = "";
    try {
      await sender({ name: "GenerateDataKey", input: { KeyId: KEK, KeySpec: "AES_256" } });
    } catch (e) {
      m = (e as Error).message;
    }
    expect(m).toBe("AWS KMS send failed");
    expect(m).not.toContain("AWS-RAW-ERROR");
  });

  it("a malformed (null) SDK response fails closed", async () => {
    const client: AwsKmsSdkClient = { send: vi.fn(async () => undefined) };
    const sender = awsKmsSenderFromClient(client);
    await expect(sender({ name: "GenerateDataKey", input: { KeyId: KEK, KeySpec: "AES_256" } })).rejects.toBeInstanceOf(AwsKmsSdkError);
  });

  it("a missing-Plaintext response fails closed through the createAwsKmsClient adapter", async () => {
    const client: AwsKmsSdkClient = { send: vi.fn(async () => ({ CiphertextBlob: Uint8Array.from(randomBytes(40)) })) };
    const kms = createAwsKmsClient({ send: awsKmsSenderFromClient(client), region: REGION });
    await expect(kms.generateDataKey(KEK)).rejects.toThrow(); // adapter validates Plaintext (32 bytes) → fails closed
  });
});

describe("the SDK sender (mocked) composes through the adapter + provider + crypto wrapper (no real KMS)", () => {
  const ctx: SecretContext = {
    tenantId: "11111111-1111-1111-1111-111111111111",
    connectorId: "17000000-0000-0000-0000-0000000000a1",
    secretKind: "oauth_access_token",
    version: 1,
  };
  const SECRET = "ghp_FAKE-test-only-personal-access-token-NOT-real";

  it("encrypt/decrypt round-trips through createKmsKeyProvider(createAwsKmsClient(awsKmsSenderFromClient(mock)))", async () => {
    const { client } = makeMockSdkClient();
    const sender = awsKmsSenderFromClient(client);
    const kp = createKmsKeyProvider({ kmsClient: createAwsKmsClient({ send: sender, region: REGION }), currentKekId: KEK });
    const enc = await encryptConnectorSecret({ plaintext: SECRET, context: ctx, keyProvider: kp, kekId: KEK });
    expect(enc.ciphertext).not.toContain(SECRET);
    const dec = await decryptConnectorSecret({ encrypted: enc, context: ctx, keyProvider: kp });
    expect(dec.toString("utf8")).toBe(SECRET);
  });
});

describe("createAwsKmsSdkSenderFromEnv — fail closed by default", () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
  });

  it("returns null when the region env is unset (this PR sets nothing → inert)", () => {
    delete process.env.CONNECTOR_VAULT_AWS_KMS_REGION;
    expect(createAwsKmsSdkSenderFromEnv()).toBeNull();
  });
});

// Static guard: the SDK sender imports ONLY the AWS KMS SDK + the (sibling) command-shape module, touches no
// DB / Supabase / service-role / connector_secrets, and makes no raw fetch itself.
describe("aws-kms-sdk-sender module is scoped (only @aws-sdk/client-kms + ./aws-kms-client; no DB/secrets/service-role)", () => {
  it("imports only the AWS KMS SDK and ./aws-kms-client; no forbidden call", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const src = fs.readFileSync(path.resolve(__dirname, "aws-kms-sdk-sender.ts"), "utf8");
    const imports = [...src.matchAll(/from\s+["']([^"']+)["']/g)].map((m) => m[1]);
    expect(imports).toEqual(["@aws-sdk/client-kms", "./aws-kms-client"]);
    const code = src.replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
    expect(code).not.toMatch(/createClient\s*\(/);
    expect(code).not.toMatch(/\bfetch\s*\(/);
    expect(code).not.toContain("@google-cloud");
    const secretsTable = ["connector", "secrets"].join("_");
    expect(code).not.toContain(secretsTable);
    const forbidden = ["service", "role"].join("_");
    expect(code).not.toContain(forbidden);
  });
});
