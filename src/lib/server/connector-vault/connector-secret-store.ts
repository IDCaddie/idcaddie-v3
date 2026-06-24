// Server-only RUNNER-BACKED connector_secrets STORE ADAPTER with ATOMIC, fail-closed AUDIT (docs/42 §78/§84,
// RISK-007 foundation). It implements the injected `ConnectorSecretWriteStore` / `ConnectorSecretReadStore`
// boundaries (secret-vault.ts) against the real `connector_secrets` table, ONLY through the runner DB connection
// (`SET ROLE connector_runner` — the narrow COLUMN-scoped 0029/0030 INSERT/SELECT grant + the 0031 audit-INSERT
// grant). It persists/loads the COMPLETE encrypted envelope via the secret-vault mappers, and emits a persisted
// connector-secret lifecycle audit row (the #166 allowlist builder) for every store/load attempt/success/failure.
//
// FAIL-CLOSED AUDIT (the load-bearing semantics — docs/42 §84):
//   * STORE is ATOMIC: the `connector_secrets` INSERT and its `connector_secret.store.succeeded` audit INSERT run
//     in ONE runner transaction (`begin … commit`) on ONE connection as `connector_runner`. The secret row commits
//     ONLY if its audit row commits; if the audit INSERT fails, the WHOLE transaction rolls back — there is NEVER
//     an orphaned, unaudited secret, and there is NO compensating DELETE. (Proven under the runner role in T52.)
//   * LOAD is fail-closed by ordering: a load returns the encrypted envelope ONLY after its
//     `connector_secret.load.succeeded` audit row is written. If the audit write fails, the load throws and the
//     caller receives NO secret/envelope. (A load is a read — there is no row to roll back.)
//   * The `attempted` and `failed` audit rows are audit-only writes (no paired secret insert) — each fail-closed
//     (a failed audit write throws and aborts the operation). NO best-effort audit; NO "insert then audit" outside
//     the shared transaction.
//
// SAFE BY CONSTRUCTION: runner-only (every statement runs under `set role connector_runner` on the injected
// `RunnerConnection`; NO service-role/global/request-path client; NO Supabase client; NO `fetch`; NO `process.env`;
// NO route/UI). Column-scoped: the secret INSERT names ONLY the 12 granted write columns; the audit INSERT names
// ONLY the four 0031-granted columns; the SELECT reads ONLY granted columns and filters to one ACTIVE, non-expired
// row. There is NO UPDATE and NO DELETE on `connector_secrets` (rotation/revocation deferred — RISK-007). Audit
// metadata is the #166 allowlist builder's output ONLY — NEVER plaintext/ciphertext/DEK/tag/nonce/aad_digest/raw
// error; only a static error CLASS. Every value is PARAMETERIZED. Errors are redacted to a fixed static message.
//
// This stores NO real provider token (nothing calls it with one yet), exchanges NO OAuth code, calls NO provider
// API, and does NOT decrypt. RISK-007 remains OPEN.
//
// SERVER-ONLY: under `src/lib/server/`, the runtime browser sentinel below, and `no-client-import.test.ts`.

import type { RunnerConnection } from "./runner-db-client";
import {
  encryptedSecretToColumns,
  columnsToEncryptedSecret,
  type ConnectorSecretWriteStore,
  type ConnectorSecretReadStore,
  type StoredEncryptedSecret,
  type ConnectorSecretEnvelopeColumns,
} from "./secret-vault";
import {
  buildConnectorSecretAuditEvent,
  type ConnectorSecretAuditEvent,
  type ConnectorSecretErrorClass,
} from "./secret-audit";
import { buildAuditInsertStatement, type RunnerStatement } from "./secret-audit-writer";

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

// LOAD (lifecycle-aware, Model B — docs/42 §85): read ONLY granted columns; filter to one ACTIVE, non-expired row
// for (tenant, connector, kind, version) AND fail closed if that version has a terminal `revoked`/`tombstoned`
// lifecycle event. The `not exists` is purely ADDITIVE — when there are no lifecycle rows it is always true, so the
// no-lifecycle path is byte-for-byte the pre-lifecycle behavior (#163/#167). `limit 2` detects an ambiguous match.
export const SELECT_SECRET_SQL =
  "select cs.id, cs.ciphertext, cs.dek_wrapped, cs.aead_nonce, cs.aad_digest, cs.key_id, cs.aead_tag, cs.envelope_version, cs.aead_alg " +
  "from public.connector_secrets cs " +
  "where cs.tenant_id = $1 and cs.connector_id = $2 and cs.secret_kind = $3 and cs.version = $4 " +
  "and cs.status = 'active' and (cs.expires_at is null or cs.expires_at > now()) " +
  "and not exists (select 1 from public.connector_secret_lifecycle_events le " +
  "where le.tenant_id = cs.tenant_id and le.connector_id = cs.connector_id and le.secret_kind = cs.secret_kind " +
  "and le.version = cs.version and le.lifecycle_event_type in ('revoked', 'tombstoned')) limit 2";

// LATEST-INTENT (docs/42 §85.6): the HIGHEST version across ALL rows for (tenant, connector, kind) — INCLUDING
// revoked/tombstoned/superseded/expired/inactive rows. NO status/expiry/lifecycle filter here: this finds the
// highest version's NUMBER only (no secret bytes), so the eligibility of ONLY that single highest version is then
// checked by the lifecycle-aware exact load. There is NO fallback to a lower version.
export const SELECT_MAX_VERSION_SQL =
  "select max(version) as version from public.connector_secrets " +
  "where tenant_id = $1 and connector_id = $2 and secret_kind = $3";

// Transaction control statements spliced into the runner `runSequence` (one connection, in order).
const SET_ROLE: RunnerStatement = { sql: "set role connector_runner", params: [] };
const BEGIN: RunnerStatement = { sql: "begin", params: [] };
const COMMIT: RunnerStatement = { sql: "commit", params: [] };

function asBuffer(v: unknown): Buffer | undefined {
  return Buffer.isBuffer(v) ? v : undefined;
}
function asString(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}
function asNumber(v: unknown): number | undefined {
  return typeof v === "number" ? v : undefined;
}

// The identity an audit row needs — picked EXPLICITLY (allowlist) from the store input; never the whole input.
type AuditIds = { tenantId: string; connectorId: string; dbSecretKind: string; version: number };

// Build the #166 allowlist audit record (actor = the runner) and the audit_logs INSERT statement to enlist.
function auditStatement(event: ConnectorSecretAuditEvent, ids: AuditIds, errorClass?: ConnectorSecretErrorClass): RunnerStatement {
  const record = buildConnectorSecretAuditEvent({
    event,
    tenantId: ids.tenantId,
    connectorId: ids.connectorId,
    secretKind: ids.dbSecretKind,
    version: ids.version,
    actorType: "connector_runner",
    ...(errorClass !== undefined ? { errorClass } : {}),
  });
  return buildAuditInsertStatement(record);
}

// Run an AUDIT-ONLY write (attempted / failed) as its own single-statement, auto-committed runner write. Throws a
// redacted error on ANY failure — the caller treats that as a fail-closed abort (no unaudited store/load proceeds).
async function emitAudit(conn: RunnerConnection, event: ConnectorSecretAuditEvent, ids: AuditIds, errorClass?: ConnectorSecretErrorClass): Promise<void> {
  try {
    await conn.runSequence([SET_ROLE, auditStatement(event, ids, errorClass)]);
  } catch {
    throw new ConnectorSecretStoreError("connector secret audit write failed");
  }
}

// EXACT-version lifecycle-aware load (the #167 fail-closed read, now also fail-closed on a revoked/tombstoned
// lifecycle event via SELECT_SECRET_SQL). Emits load.attempted/succeeded/failed; the caller gets the envelope ONLY
// after load.succeeded commits. Reused by BOTH `findEncryptedSecret` (exact) and `findLatestEncryptedSecret`
// (latest-intent — it resolves the highest version, then loads THAT version's eligibility through here).
async function loadExactSecret(conn: RunnerConnection, ids: AuditIds): Promise<StoredEncryptedSecret | null> {
  // 1) load.attempted — fail-closed.
  await emitAudit(conn, "connector_secret.load.attempted", ids);

  // 2) the SELECT (a read — nothing to roll back). Redact DB errors; record load.failed; abort.
  let rows: ReadonlyArray<Record<string, unknown>>;
  try {
    const results = await conn.runSequence([
      SET_ROLE,
      { sql: SELECT_SECRET_SQL, params: [ids.tenantId, ids.connectorId, ids.dbSecretKind, ids.version] },
    ]);
    rows = results[results.length - 1]?.rows ?? [];
  } catch {
    await emitAudit(conn, "connector_secret.load.failed", ids, "load_failed");
    throw new ConnectorSecretStoreError("connector secret load failed");
  }

  // 3) classify the read outcome → on any problem, record load.failed (with a STATIC class) and abort.
  let result: StoredEncryptedSecret | null;
  try {
    if (rows.length > 1) {
      await emitAudit(conn, "connector_secret.load.failed", ids, "ambiguous_match");
      throw new ConnectorSecretStoreError("ambiguous active connector secret (multiple matching rows)");
    }
    if (rows.length === 0) {
      result = null;
    } else {
      const row = rows[0];
      const id = asString(row.id);
      if (!id) {
        await emitAudit(conn, "connector_secret.load.failed", ids, "load_failed");
        throw new ConnectorSecretStoreError("connector secret row is missing its id");
      }
      const colVals: Partial<ConnectorSecretEnvelopeColumns> = {
        ciphertext: asBuffer(row.ciphertext),
        dek_wrapped: asBuffer(row.dek_wrapped),
        aead_nonce: asBuffer(row.aead_nonce),
        aead_tag: asBuffer(row.aead_tag),
        aad_digest: asString(row.aad_digest),
        key_id: asString(row.key_id),
        envelope_version: asNumber(row.envelope_version),
        aead_alg: asString(row.aead_alg),
      };
      let encrypted;
      try {
        // columnsToEncryptedSecret fails closed on an incomplete/unsupported envelope.
        encrypted = columnsToEncryptedSecret(colVals);
      } catch {
        await emitAudit(conn, "connector_secret.load.failed", ids, "invalid_envelope");
        throw new ConnectorSecretStoreError("connector secret stored envelope is invalid or unsupported");
      }
      result = { id, encrypted };
    }
  } catch (e) {
    if (e instanceof ConnectorSecretStoreError) throw e; // already audited above as load.failed
    await emitAudit(conn, "connector_secret.load.failed", ids, "load_failed");
    throw new ConnectorSecretStoreError("connector secret load failed");
  }

  // 4) load.succeeded — fail-closed: write the audit row BEFORE returning. If it fails, the caller gets NO payload.
  await emitAudit(conn, "connector_secret.load.succeeded", ids);
  return result;
}

// Build the runner-backed store adapter. The injected `RunnerConnection.runSequence` runs the given statements IN
// ORDER on ONE connection — so a single sequence containing `begin … commit` is one transaction. Never service-role.
export function createRunnerConnectorSecretStore(
  conn: RunnerConnection,
): ConnectorSecretWriteStore & ConnectorSecretReadStore {
  return {
    async insertEncryptedSecret(input): Promise<{ id: string }> {
      const ids: AuditIds = {
        tenantId: input.tenantId,
        connectorId: input.connectorId,
        dbSecretKind: input.dbSecretKind,
        version: input.version,
      };
      // 1) store.attempted — fail-closed: no store proceeds unaudited.
      await emitAudit(conn, "connector_secret.store.attempted", ids);

      // 2) ATOMIC: the connector_secrets INSERT + the store.succeeded audit INSERT in ONE runner transaction.
      //    The secret commits ONLY if its audit commits; if the audit INSERT fails, the whole tx rolls back.
      const cols = encryptedSecretToColumns(input.encrypted);
      const sequence: RunnerStatement[] = [
        SET_ROLE,
        BEGIN,
        {
          sql: INSERT_SECRET_SQL,
          params: [
            input.tenantId, input.connectorId, input.dbSecretKind, input.version,
            cols.ciphertext, cols.dek_wrapped, cols.aead_nonce, cols.aad_digest,
            cols.key_id, cols.aead_tag, cols.envelope_version, cols.aead_alg,
          ],
        },
        auditStatement("connector_secret.store.succeeded", ids),
        COMMIT,
      ];
      let results: Array<{ rows: ReadonlyArray<Record<string, unknown>> }>;
      try {
        results = await conn.runSequence(sequence);
      } catch {
        // The atomic transaction failed (secret INSERT or its audit INSERT) → rolled back → NO secret committed,
        // NO compensating DELETE. Record the failure (its own audit write, also fail-closed) and abort.
        await emitAudit(conn, "connector_secret.store.failed", ids, "store_failed");
        throw new ConnectorSecretStoreError("connector secret store failed");
      }
      // results indexes: 0=set role, 1=begin, 2=INSERT … RETURNING id, 3=audit INSERT, 4=commit.
      const id = asString(results[2]?.rows[0]?.id);
      if (!id) throw new ConnectorSecretStoreError("connector secret insert did not return a row id");
      return { id }; // REDACTED: row id only — never plaintext, never ciphertext
    },

    // EXACT-version lifecycle-aware load — fail closed unless the exact version is active, non-expired, well-formed,
    // and has NO revoked/tombstoned lifecycle event.
    async findEncryptedSecret(input): Promise<StoredEncryptedSecret | null> {
      return loadExactSecret(conn, {
        tenantId: input.tenantId,
        connectorId: input.connectorId,
        dbSecretKind: input.dbSecretKind,
        version: input.version,
      });
    },

    // LATEST-INTENT lifecycle-aware load (docs/42 §85.6): resolve the HIGHEST version across ALL rows (incl.
    // revoked/tombstoned/superseded/expired/inactive), then load the eligibility of THAT single version only. It
    // NEVER falls back to a lower version: if the highest version is revoked/tombstoned/expired/inactive/malformed
    // it returns null (or throws on a malformed envelope) — exactly as `findEncryptedSecret(highest)` would.
    async findLatestEncryptedSecret(input): Promise<StoredEncryptedSecret | null> {
      // highest version = a NUMBER only (no secret bytes), so this metadata read needs no load audit.
      let maxVersion: number | undefined;
      try {
        const results = await conn.runSequence([
          SET_ROLE,
          { sql: SELECT_MAX_VERSION_SQL, params: [input.tenantId, input.connectorId, input.dbSecretKind] },
        ]);
        maxVersion = asNumber(results[results.length - 1]?.rows[0]?.version);
      } catch {
        throw new ConnectorSecretStoreError("connector secret latest-version lookup failed");
      }
      if (maxVersion === undefined) return null; // no version rows exist for (tenant, connector, kind)
      // eligibility of ONLY the highest version (audited, lifecycle-aware). NO fallback to a lower version.
      return loadExactSecret(conn, {
        tenantId: input.tenantId,
        connectorId: input.connectorId,
        dbSecretKind: input.dbSecretKind,
        version: maxVersion,
      });
    },
  };
}
