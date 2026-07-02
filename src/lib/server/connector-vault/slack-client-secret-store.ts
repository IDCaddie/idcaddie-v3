// Server-only VAULT-GRADE Slack OAuth client-secret store (PR B2c-secret — RISK-007, docs/42 §90.3). SYNTHETIC ONLY.
//
// The Slack client secret is the OAuth MASTER CREDENTIAL — it converts authorization codes into bot tokens, so its
// compromise is app-wide (worse than one tenant's token). It is **app-scoped, NOT tenant-scoped**: one per Slack app,
// keyed by {appEnv, provider, secretKind, version} — it does NOT belong in the per-tenant `connector_secrets` table
// and is NEVER bound to a tenant_id or protected by tenant RLS. It is stored as the SAME AES-256-GCM envelope (DEK
// wrapped by a KEK in external KMS) as the bot-token vault, but with an APP-SCOPE AAD (a distinct domain prefix), so
// a staging ciphertext cannot decrypt as production and a wrong provider/kind/version fails closed.
//
// LOAD-BEARING DECRYPT BOUNDARY: there is deliberately NO `loadClientSecret(): string` API. The only way to obtain
// the plaintext is the scoped `withSlackClientSecret(identity, deps, exchange)` closure — it decrypts, passes the
// plaintext to `exchange` (the server-side Slack EXCHANGE callback, the runner identity), wipes the buffer
// immediately after, and returns ONLY `exchange`'s redacted result. The plaintext is NEVER returned, logged, thrown, or
// persisted. This mirrors B2c-wire (the orchestrator never sees the bot token). Decrypt runs through the injected
// runner-backed store + KMS provider — NOT available to the web/request identity, arbitrary app code, or any route.
//
// B2c-secret adds NO real Slack client secret, NO real token, NO Slack API call, NO production callback route, NO live
// connector, NO request-path decrypt, NO production enablement. The app-secret USE audit (docs/42 §90.7) is NOT
// implemented here — it remains FUTURE. RISK-001 / RISK-007 remain OPEN.
//
// SERVER-ONLY: under `src/lib/server/`, the runtime browser sentinel below, and `no-client-import.test.ts`.

import {
  encryptAppSecret,
  decryptAppSecret,
  type EncryptedConnectorSecret,
  type ConnectorVaultKeyProvider,
  type AppSecretKind,
} from "./crypto";
import type { RunnerConnection } from "./runner-connection";

// Runtime server-only sentinel — throw if evaluated in a browser.
if (typeof (globalThis as { window?: unknown }).window !== "undefined") {
  throw new Error("connector-vault/slack-client-secret-store is server-only and must not be imported in client code");
}

// The Slack client secret's app-scope identity is pinned to this provider + kind.
export const SLACK_APP_PROVIDER = "slack" as const;
export const SLACK_CLIENT_SECRET_KIND: AppSecretKind = "oauth_client_secret";

export class SlackClientSecretStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SlackClientSecretStoreError";
  }
}

// The injected envelope store (runner-backed in prod via `createRunnerAppSecretStore`; in-memory in tests). It moves
// ONLY the at-rest envelope (ciphertext + metadata) — NEVER plaintext.
export interface AppSecretEnvelopeStore {
  // INSERT a new versioned envelope row; returns a REDACTED ref (row id only).
  insertEnvelope(row: {
    appEnv: string;
    provider: string;
    secretKind: string;
    version: number;
    encrypted: EncryptedConnectorSecret;
  }): Promise<{ secretId: string }>;
  // SELECT the ACTIVE/latest envelope for an app-scope identity (highest active version); null if none.
  loadActiveEnvelope(q: {
    appEnv: string;
    provider: string;
    secretKind: string;
  }): Promise<{ version: number; encrypted: EncryptedConnectorSecret } | null>;
}

// Store the synthetic Slack client secret as an envelope (no plaintext at rest). Returns a redacted ref. The
// plaintext is handed straight to the encrypt path and never logged/returned.
export async function saveSlackClientSecret(
  input: { plaintext: string | Buffer; appEnv: string; version: number },
  deps: { keyProvider: ConnectorVaultKeyProvider; kekId: string; store: AppSecretEnvelopeStore },
): Promise<{ secretId: string }> {
  if (typeof input.appEnv !== "string" || input.appEnv.length === 0)
    throw new SlackClientSecretStoreError("invalid appEnv");
  const context = {
    appEnv: input.appEnv,
    provider: SLACK_APP_PROVIDER,
    secretKind: SLACK_CLIENT_SECRET_KIND,
    version: input.version,
  };
  const encrypted = await encryptAppSecret({ plaintext: input.plaintext, context, keyProvider: deps.keyProvider, kekId: deps.kekId });
  const { secretId } = await deps.store.insertEnvelope({
    appEnv: input.appEnv,
    provider: SLACK_APP_PROVIDER,
    secretKind: SLACK_CLIENT_SECRET_KIND,
    version: input.version,
    encrypted,
  });
  return { secretId }; // REDACTED — row id only; never plaintext/ciphertext
}

export type WithClientSecretResult<T> =
  | { ok: true; value: T }
  | { ok: false; reason: "not_found" | "decrypt_failed" | "use_failed" };

// THE decrypt-and-use boundary. Loads the active envelope, decrypts the client secret, and hands the plaintext ONLY
// to `exchange` (the exchange callback). After it settles, the plaintext buffer is wiped and the closure returns ONLY
// the callback's redacted result — the plaintext is never returned/logged/thrown/persisted. An `exchange` failure (or
// a decrypt failure) fails closed without surfacing the secret. (The transient plaintext STRING cannot be wiped — a
// V8-heap residual remains until GC, docs/44 §2 step 7 — but it never escapes this closure.)
export async function withSlackClientSecret<T>(
  identity: { appEnv: string },
  deps: { keyProvider: ConnectorVaultKeyProvider; store: AppSecretEnvelopeStore },
  exchange: (clientSecret: string) => Promise<T>,
): Promise<WithClientSecretResult<T>> {
  if (typeof exchange !== "function") throw new SlackClientSecretStoreError("missing exchange callback");
  if (!identity || typeof identity.appEnv !== "string" || identity.appEnv.length === 0)
    throw new SlackClientSecretStoreError("invalid appEnv");

  const loaded = await deps.store.loadActiveEnvelope({
    appEnv: identity.appEnv,
    provider: SLACK_APP_PROVIDER,
    secretKind: SLACK_CLIENT_SECRET_KIND,
  });
  if (!loaded) return { ok: false, reason: "not_found" };

  let plaintextBuf: Buffer;
  try {
    plaintextBuf = await decryptAppSecret({
      encrypted: loaded.encrypted,
      context: { appEnv: identity.appEnv, provider: SLACK_APP_PROVIDER, secretKind: SLACK_CLIENT_SECRET_KIND, version: loaded.version },
      keyProvider: deps.keyProvider,
    });
  } catch {
    return { ok: false, reason: "decrypt_failed" }; // fail closed — no plaintext
  }

  try {
    const clientSecret = plaintextBuf.toString("utf8");
    try {
      const value = await exchange(clientSecret); // the ONLY consumer of the plaintext
      return { ok: true, value }; // `value` is the exchange's REDACTED result — never the secret
    } finally {
      plaintextBuf.fill(0); // drop the live reference (best-effort buffer wipe)
    }
  } catch {
    return { ok: false, reason: "use_failed" }; // forced post-decrypt failure → no secret leak
  }
}

// ── Runner-backed envelope store (the ONLY production access path) ─────────────────────────────────────
// Reaches `connector_app_secrets` solely under `SET ROLE connector_runner` (the BYPASSRLS runner identity with the
// column-scoped grant + the KMS kms:Decrypt boundary) — never the web/request identity, never the broad service role. App-
// scoped: NO tenant_id, NO RLS tenant predicate (the table is deny-all to authenticated/anon; only the runner reads).
const SET_ROLE = { sql: "set role connector_runner", params: [] as const };
const INSERT_SQL =
  "insert into public.connector_app_secrets (app_env, provider, secret_kind, version, ciphertext, dek_wrapped, aead_nonce, aead_tag, aad_digest, kek_id, envelope_version, aead_alg) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) returning id";
const SELECT_ACTIVE_SQL =
  "select id, version, ciphertext, dek_wrapped, aead_nonce, aead_tag, aad_digest, kek_id, envelope_version, aead_alg from public.connector_app_secrets where app_env=$1 and provider=$2 and secret_kind=$3 and is_active order by version desc limit 1";

const b64ToBuf = (s: string) => Buffer.from(s, "base64");
const toBuf = (v: unknown): Buffer => (Buffer.isBuffer(v) ? v : typeof v === "string" ? Buffer.from(v, v.startsWith("\\x") ? "hex" : "base64") : Buffer.alloc(0));

export function createRunnerAppSecretStore(conn: RunnerConnection): AppSecretEnvelopeStore {
  return {
    async insertEnvelope(row): Promise<{ secretId: string }> {
      const e = row.encrypted;
      let results: Array<{ rows: ReadonlyArray<Record<string, unknown>> }>;
      try {
        results = await conn.runSequence([
          SET_ROLE,
          {
            sql: INSERT_SQL,
            params: [
              row.appEnv, row.provider, row.secretKind, row.version,
              b64ToBuf(e.ciphertext), b64ToBuf(e.wrappedDek), b64ToBuf(e.iv), b64ToBuf(e.tag),
              e.aadDigest, e.kekId, e.v, e.alg,
            ],
          },
        ]);
      } catch {
        throw new SlackClientSecretStoreError("app secret insert failed");
      }
      const id = results[results.length - 1]?.rows[0]?.id;
      if (typeof id !== "string" || id.length === 0)
        throw new SlackClientSecretStoreError("app secret insert did not return a row id");
      return { secretId: id }; // REDACTED — row id only
    },

    async loadActiveEnvelope(q): Promise<{ version: number; encrypted: EncryptedConnectorSecret } | null> {
      let results: Array<{ rows: ReadonlyArray<Record<string, unknown>> }>;
      try {
        results = await conn.runSequence([SET_ROLE, { sql: SELECT_ACTIVE_SQL, params: [q.appEnv, q.provider, q.secretKind] }]);
      } catch {
        throw new SlackClientSecretStoreError("app secret load failed");
      }
      const r = results[results.length - 1]?.rows[0];
      if (!r) return null;
      const version = Number(r.version);
      const encrypted: EncryptedConnectorSecret = {
        v: Number(r.envelope_version) as 1,
        alg: String(r.aead_alg) as "AES-256-GCM",
        kekId: String(r.kek_id),
        wrappedDek: toBuf(r.dek_wrapped).toString("base64"),
        iv: toBuf(r.aead_nonce).toString("base64"),
        ciphertext: toBuf(r.ciphertext).toString("base64"),
        tag: toBuf(r.aead_tag).toString("base64"),
        aadDigest: String(r.aad_digest),
      };
      return { version, encrypted };
    },
  };
}
