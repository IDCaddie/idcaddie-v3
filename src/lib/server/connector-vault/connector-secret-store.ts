// Server-only RUNNER-BACKED connector_secrets STORE ADAPTER (docs/42 §78, RISK-007 foundation). It implements
// the injected `ConnectorSecretWriteStore` / `ConnectorSecretReadStore` boundaries (secret-vault.ts) against the
// real `connector_secrets` table, ONLY through the runner DB client path (`SET ROLE connector_runner` — the
// narrow COLUMN-scoped 0029/0030 INSERT/SELECT grant). It persists/loads the COMPLETE encrypted envelope using
// the secret-vault mappers, so a save/load round-trips every field of the `crypto.ts` payload.
//
// SAFE BY CONSTRUCTION:
//   * runner-only: every statement runs under `set role connector_runner` via the injected `RunnerConnection`
//     (the same seam as runner-db-client.ts). NO service-role / global / request-path client; NO Supabase
//     client import; NO `fetch`; NO `process.env`; NO route/UI. Tests inject a mock connection.
//   * column-scoped: the INSERT names ONLY the 12 granted write columns (identity + the encrypted envelope) —
//     never `id` (server default), never is_active/status/created_at/revoked_at. The SELECT reads ONLY granted
//     columns and filters to one ACTIVE, non-expired row for (tenant, connector, kind, version). There is NO
//     UPDATE and NO DELETE here (revocation/rotation is deferred — RISK-007). Every value is PARAMETERIZED.
//   * fail closed: a missing insert id, MORE THAN ONE matching active row, or an INCOMPLETE/unsupported stored
//     envelope (the secret-vault mapper rejects it) all throw a typed, secret-free error. The save RESULT is a
//     row id only — NEVER plaintext, NEVER ciphertext.
//
// This stores NO real provider token (nothing calls it with one yet), exchanges NO OAuth code, calls NO provider
// API, and does NOT decrypt (decrypt stays the runner-only KMS capability path in secret-vault.ts). RISK-007
// remains OPEN: this is the DB read/write adapter only — NOT hosted KMS/IAM separation, audit, rotation, or live
// token storage.
//
// SERVER-ONLY: under `src/lib/server/`, the runtime browser sentinel below, and `no-client-import.test.ts`.

import { createRunnerDbClient, type RunnerConnection } from "./runner-db-client";
import {
  encryptedSecretToColumns,
  columnsToEncryptedSecret,
  type ConnectorSecretWriteStore,
  type ConnectorSecretReadStore,
  type StoredEncryptedSecret,
  type ConnectorSecretEnvelopeColumns,
} from "./secret-vault";

// Runtime server-only sentinel — throw if evaluated in a browser.
if (typeof (globalThis as { window?: unknown }).window !== "undefined") {
  throw new Error("connector-vault/connector-secret-store is server-only and must not be imported in client code");
}

// A typed, safe-to-surface error — its message is always a fixed static string, never secret/key material.
export class ConnectorSecretStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConnectorSecretStoreError";
  }
}

// SAVE: insert ONLY the 12 granted write columns (identity + the complete encrypted envelope). NOT id (server
// default), NOT is_active/status/created_at/revoked_at. RETURNING id (id is SELECT-granted). Values parameterized.
export const INSERT_SECRET_SQL =
  "insert into public.connector_secrets " +
  "(tenant_id, connector_id, secret_kind, version, " +
  "ciphertext, dek_wrapped, aead_nonce, aad_digest, key_id, aead_tag, envelope_version, aead_alg) " +
  "values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) returning id";

// LOAD: read ONLY granted columns; filter to one ACTIVE, non-expired row for (tenant, connector, kind, version).
// `limit 2` so an ambiguous (>1) active match is detected and rejected rather than silently picking one.
export const SELECT_SECRET_SQL =
  "select id, ciphertext, dek_wrapped, aead_nonce, aad_digest, key_id, aead_tag, envelope_version, aead_alg " +
  "from public.connector_secrets " +
  "where tenant_id = $1 and connector_id = $2 and secret_kind = $3 and version = $4 " +
  "and status = 'active' and (expires_at is null or expires_at > now()) limit 2";

function asBuffer(v: unknown): Buffer | undefined {
  return Buffer.isBuffer(v) ? v : undefined;
}
function asString(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}
function asNumber(v: unknown): number | undefined {
  return typeof v === "number" ? v : undefined;
}

// Build the runner-backed store adapter. The injected `RunnerConnection` is wrapped by `createRunnerDbClient`,
// which prepends `set role connector_runner` to every statement and redacts raw DB errors. Never service-role.
export function createRunnerConnectorSecretStore(
  conn: RunnerConnection,
): ConnectorSecretWriteStore & ConnectorSecretReadStore {
  const db = createRunnerDbClient(conn); // SET ROLE connector_runner + error redaction (runner DB client path)

  return {
    async insertEncryptedSecret(input): Promise<{ id: string }> {
      const cols = encryptedSecretToColumns(input.encrypted);
      const { rows } = await db.run(INSERT_SECRET_SQL, [
        input.tenantId,
        input.connectorId,
        input.dbSecretKind,
        input.version,
        cols.ciphertext,
        cols.dek_wrapped,
        cols.aead_nonce,
        cols.aad_digest,
        cols.key_id,
        cols.aead_tag,
        cols.envelope_version,
        cols.aead_alg,
      ]);
      const id = asString(rows[0]?.id);
      if (!id) throw new ConnectorSecretStoreError("connector secret insert did not return a row id");
      return { id }; // REDACTED: row id only — never plaintext, never ciphertext
    },

    async findEncryptedSecret(input): Promise<StoredEncryptedSecret | null> {
      const { rows } = await db.run(SELECT_SECRET_SQL, [
        input.tenantId,
        input.connectorId,
        input.dbSecretKind,
        input.version,
      ]);
      if (rows.length === 0) return null;
      if (rows.length > 1) throw new ConnectorSecretStoreError("ambiguous active connector secret (multiple matching rows)");
      const row = rows[0];
      const id = asString(row.id);
      if (!id) throw new ConnectorSecretStoreError("connector secret row is missing its id");
      const cols: Partial<ConnectorSecretEnvelopeColumns> = {
        ciphertext: asBuffer(row.ciphertext),
        dek_wrapped: asBuffer(row.dek_wrapped),
        aead_nonce: asBuffer(row.aead_nonce),
        aead_tag: asBuffer(row.aead_tag),
        aad_digest: asString(row.aad_digest),
        key_id: asString(row.key_id),
        envelope_version: asNumber(row.envelope_version),
        aead_alg: asString(row.aead_alg),
      };
      // columnsToEncryptedSecret fails closed on an incomplete (pre-0030 / partial) or unsupported envelope.
      return { id, encrypted: columnsToEncryptedSecret(cols) };
    },
  };
}
