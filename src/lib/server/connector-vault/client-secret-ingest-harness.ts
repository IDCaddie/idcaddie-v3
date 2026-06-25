// Server-only SAFE client-secret ingestion HARNESS CORE (PR B2c-run prep — RISK-007, docs/42 §90.3 / docs/45).
// SYNTHETIC-ONLY in tests; the reviewed logic the hosted runner runtime calls at B2c-run to load the REAL Slack
// OAuth client secret through the existing B2c-secret KMS/envelope boundary.
//
// This is the deep-gate surface: a flaw here changes how the real master credential is loaded later. Invariants:
//   * the secret is read from a stream (stdin) or a caller-supplied buffer — NEVER from argv and NEVER from
//     `process.env.SLACK_CLIENT_SECRET` (`assertSafeInvocation` refuses both);
//   * the secret is handed STRAIGHT to `saveSlackClientSecret` (encrypt-immediately via the injected KMS/envelope +
//     runner app-secret store) and is NEVER printed, logged, returned, or placed in a thrown error;
//   * the result is a REDACTED `{ ok, secretId }` or a SAFE STATIC `{ ok:false, reason }` — fail-closed on missing
//     KMS/store deps, invalid app_env/version, empty/oversize input, or ANY save failure;
//   * the catch path returns a fixed reason and NEVER surfaces the caught error (it could carry plaintext/args).
//
// It adds NO real Slack client secret, NO real token, NO Slack API call, NO OAuth run, NO production enablement.
// RISK-001 / RISK-007 remain OPEN. The real KMS provider + runner `RunnerConnection` (connector_runner_login) are
// B2c-run prerequisites supplied by the caller (docs/45); this module takes them as INJECTED deps.
//
// SERVER-ONLY: under `src/lib/server/`, the runtime browser sentinel below, and `no-client-import.test.ts`.

import { saveSlackClientSecret, type AppSecretEnvelopeStore } from "./slack-client-secret-store";
import type { ConnectorVaultKeyProvider } from "./crypto";

// Runtime server-only sentinel — throw if evaluated in a browser.
if (typeof (globalThis as { window?: unknown }).window !== "undefined") {
  throw new Error("connector-vault/client-secret-ingest-harness is server-only and must not be imported in client code");
}

export class ClientSecretIngestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ClientSecretIngestError";
  }
}

// B2c-run prep is STAGING-only. A client secret is short; cap the input to reject anything suspicious.
const ALLOWED_APP_ENV = "staging" as const;
const MAX_SECRET_BYTES = 8 * 1024;
// The ONLY flags accepted — exactly the NON-secret config the documented run uses (the KEK id comes from env, the
// secret ONLY from stdin). A positional arg (a likely secret) and any other flag are refused. Kept minimal so the
// allow-list can never quietly admit a future file-path-as-secret / extra-flag pattern on this master-credential path.
const ALLOWED_FLAGS = new Set(["--app-env", "--version", "--confirm"]);

// Refuse an unsafe invocation BEFORE any secret is read: the secret must NEVER arrive via argv or env. Error messages
// are GENERIC — they never echo an argv value (which could be the secret).
export function assertSafeInvocation(ctx: { argv: readonly string[]; env: Record<string, string | undefined> }): void {
  if (!ctx || !Array.isArray(ctx.argv) || !ctx.env) throw new ClientSecretIngestError("invalid invocation context");
  if (typeof ctx.env.SLACK_CLIENT_SECRET === "string" && ctx.env.SLACK_CLIENT_SECRET.length > 0)
    throw new ClientSecretIngestError("refuse: SLACK_CLIENT_SECRET must NOT be set in the environment — the client secret is read from stdin only");
  for (let i = 0; i < ctx.argv.length; i++) {
    const a = ctx.argv[i];
    if (typeof a !== "string") throw new ClientSecretIngestError("refuse: invalid argument");
    if (a.startsWith("--")) {
      const key = a.split("=", 1)[0];
      if (!ALLOWED_FLAGS.has(key)) throw new ClientSecretIngestError("refuse: unknown flag (the secret must NOT be passed as a flag value)");
      if (!a.includes("=")) i++; // skip this flag's separate value token (a non-secret config value)
      continue;
    }
    // a bare positional token is refused — it could be the secret, which must come via stdin, never argv.
    throw new ClientSecretIngestError("refuse: positional argument not allowed — the client secret must be piped via stdin, never passed on the command line");
  }
}

// Read the secret from a Readable (stdin) into a string. Rejects empty/oversize input. NEVER logs the content.
export async function readSecretFromStream(stream: NodeJS.ReadableStream): Promise<string> {
  if (!stream || typeof (stream as { on?: unknown }).on !== "function") throw new ClientSecretIngestError("no input stream");
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of stream) {
    const buf = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : (chunk as Buffer);
    total += buf.length;
    if (total > MAX_SECRET_BYTES) throw new ClientSecretIngestError("refuse: input exceeds the maximum client-secret size");
    chunks.push(buf);
  }
  // trim a single trailing newline (a `cat`/`echo` artifact) but nothing else.
  const value = Buffer.concat(chunks).toString("utf8").replace(/\r?\n$/, "");
  if (value.length === 0) throw new ClientSecretIngestError("refuse: empty client-secret input on stdin");
  return value;
}

export type IngestInput = { plaintext: string; appEnv: string; version: number };
export type IngestDeps = { keyProvider: ConnectorVaultKeyProvider; kekId: string; store: AppSecretEnvelopeStore };
// REDACTED outcome — a non-secret id or a SAFE STATIC reason. NEVER the secret, the ciphertext, or a raw error.
export type IngestReason =
  | "missing_secret"
  | "invalid_app_env"
  | "invalid_version"
  | "missing_kms_config"
  | "missing_store"
  | "ingest_failed";
export type IngestResult = { ok: true; secretId: string } | { ok: false; reason: IngestReason };

// Ingest a (already-read) client secret through the approved B2c-secret boundary. Fails closed on ANY problem with a
// safe static reason; the plaintext + any caught error are NEVER returned/logged/thrown.
export async function ingestClientSecret(input: IngestInput, deps: IngestDeps): Promise<IngestResult> {
  if (!input || typeof input.plaintext !== "string" || input.plaintext.length === 0) return { ok: false, reason: "missing_secret" };
  if (input.appEnv !== ALLOWED_APP_ENV) return { ok: false, reason: "invalid_app_env" }; // staging-only
  if (!Number.isInteger(input.version) || input.version < 1) return { ok: false, reason: "invalid_version" };
  if (!deps || !deps.keyProvider || typeof deps.keyProvider.generateDataKey !== "function" || typeof deps.kekId !== "string" || deps.kekId.length === 0)
    return { ok: false, reason: "missing_kms_config" };
  if (!deps.store || typeof deps.store.insertEnvelope !== "function") return { ok: false, reason: "missing_store" };

  try {
    const ref = await saveSlackClientSecret(
      { plaintext: input.plaintext, appEnv: input.appEnv, version: input.version },
      { keyProvider: deps.keyProvider, kekId: deps.kekId, store: deps.store },
    );
    if (!ref || typeof ref.secretId !== "string" || ref.secretId.length === 0) return { ok: false, reason: "ingest_failed" };
    return { ok: true, secretId: ref.secretId }; // REDACTED — row id only
  } catch {
    // NEVER surface the caught error (could carry plaintext / call args). Fixed static reason only.
    return { ok: false, reason: "ingest_failed" };
  }
}

// The ONLY thing safe to print — a redacted one-line outcome (no secret, no ciphertext, no raw error).
export function formatRedactedOutcome(result: IngestResult): string {
  return result.ok
    ? `OK: stored Slack client secret (envelope-only). secret_id=${result.secretId}`
    : `FAILED (fail-closed): ${result.reason}`;
}
