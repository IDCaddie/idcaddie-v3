// Server-only RUNNER-BACKED connector-secret LIFECYCLE WRITE helpers — revoke / tombstone (docs/42 §87, RISK-007).
// Model B (docs/42 §85): revocation/tombstone is an INSERT-only lifecycle event on connector_secret_lifecycle_events;
// `connector_secrets` is NEVER mutated (no UPDATE, no DELETE). These helpers APPEND a `revoked`/`tombstoned` event
// for an EXISTING (tenant, connector, kind, version) and audit the operation — atomically, with EXACTLY ONE
// terminal outcome (succeeded | failed) per call.
//
// SINGLE ATOMIC CTE (one statement = one transaction; the single source of truth is the lifecycle INSERT):
//   with ins_lifecycle as ( INSERT … where EXISTS (the target connector_secrets row) RETURNING version ),
//        ins_attempted  as ( INSERT audit <op>.attempted  — UNCONDITIONAL: always records the request ),
//        ins_succeeded  as ( INSERT audit <op>.succeeded  where EXISTS     (select from ins_lifecycle) ),
//        ins_failed     as ( INSERT audit <op>.failed      where NOT EXISTS (select from ins_lifecycle) )
//   select count(*) from ins_lifecycle  -> 0 = the target version does not exist; 1 = it does.
//   * `succeeded` and `failed` BOTH derive from the lifecycle INSERT's RETURNING (`ins_lifecycle`), so they are
//     mutually exclusive BY CONSTRUCTION — exactly one terminal audit row commits, never both, never neither, and
//     there is NO independent second EXISTS predicate that could race.
//   * ORPHAN INVARIANT: a lifecycle row is created ONLY for an existing target (`ins_lifecycle` WHERE EXISTS).
//     The attempted/failed AUDIT rows MAY reference a nonexistent requested version — they record the failed
//     attempt (the orphan invariant binds lifecycle rows, not audit rows).
//   * NONEXISTENT target: `ins_lifecycle` no-ops -> attempted + `failed` (reason `target_not_found`) commit, NO
//     lifecycle row, NO `succeeded`; the helper THROWS (the caller gets an explicit failure, NEVER `{ ok }`).
//   * ATOMIC: it is ONE statement — if ANY of the inserts errors (e.g. the succeeded audit), the whole statement
//     rolls back (no lifecycle row without its audit, no compensating DELETE); the helper then fails closed.
//
// MONOTONIC + PERMANENT: only a terminal `revoked`/`tombstoned` event is ever INSERTed. NO unrevoke/reactivate/
// restore, NO rotation helper. SAFE BY CONSTRUCTION: runner-only (`set role connector_runner`); the lifecycle
// INSERT names ONLY the eight 0033-granted safe-metadata columns; each audit row is the #166 allowlist builder's
// output ONLY (no plaintext/ciphertext/DEK/tag/nonce/aad_digest/raw error — a static `target_not_found` class on
// failure). The helpers return `{ ok: true }` on success and THROW on failure — NEVER a secret/envelope/key
// material. No service-role/global/request-path client, no Supabase client, no `fetch`, no `process.env`, no route.
//
// SERVER-ONLY: under `src/lib/server/`, the runtime browser sentinel below, and `no-client-import.test.ts`.

import type { RunnerConnection } from "./runner-db-client";
import { buildConnectorSecretAuditEvent, type ConnectorSecretAuditEvent, type ConnectorSecretAuditRecord } from "./secret-audit";
import type { RunnerStatement } from "./secret-audit-writer";

// Runtime server-only sentinel — throw if evaluated in a browser.
if (typeof (globalThis as { window?: unknown }).window !== "undefined") {
  throw new Error("connector-vault/connector-secret-lifecycle is server-only and must not be imported in client code");
}

// A typed, safe-to-surface error — its message is always a fixed static string, never secret/key material.
export class ConnectorSecretLifecycleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConnectorSecretLifecycleError";
  }
}

// The SAFE STATIC reason classes a revoke/tombstone may record (never free-form, never a raw error). Anything
// outside this allowlist collapses to "unspecified".
export const CONNECTOR_SECRET_LIFECYCLE_REASONS = ["manual", "compromised", "superseded", "policy", "unspecified"] as const;
export type ConnectorSecretLifecycleReason = (typeof CONNECTOR_SECRET_LIFECYCLE_REASONS)[number];

// The single ATOMIC CTE: lifecycle INSERT (the existence source of truth) + the three audit rows, exactly one
// terminal outcome. The lifecycle INSERT names ONLY the eight 0033-granted safe-metadata columns; `succeeded` and
// `failed` derive from `ins_lifecycle` (NOT a second independent EXISTS). RETURNING is `version` (the runner has
// SELECT on `version`, NOT on `id`). The final SELECT reports whether the lifecycle row was inserted.
export const LIFECYCLE_WRITE_SQL =
  "with ins_lifecycle as (" +
  " insert into public.connector_secret_lifecycle_events" +
  " (tenant_id, connector_id, secret_kind, version, lifecycle_event_type, reason_class, actor_type, correlation_id)" +
  " select $1, $2, $3, $4, $5, $6, $7, $8" +
  " where exists (select 1 from public.connector_secrets cs" +
  " where cs.tenant_id = $1 and cs.connector_id = $2 and cs.secret_kind = $3 and cs.version = $4)" +
  " returning version)," +
  " ins_attempted as (" +
  " insert into public.audit_logs (tenant_id, action, resource_type, after_json)" +
  " values ($1, $10, $9, $11::jsonb) returning 1)," +
  " ins_succeeded as (" +
  " insert into public.audit_logs (tenant_id, action, resource_type, after_json)" +
  " select $1, $12, $9, $13::jsonb where exists (select 1 from ins_lifecycle) returning 1)," +
  " ins_failed as (" +
  " insert into public.audit_logs (tenant_id, action, resource_type, after_json)" +
  " select $1, $14, $9, $15::jsonb where not exists (select 1 from ins_lifecycle) returning 1)" +
  " select count(*)::int as lifecycle_inserted from ins_lifecycle";

const SET_ROLE: RunnerStatement = { sql: "set role connector_runner", params: [] };

function asNumber(v: unknown): number | undefined {
  return typeof v === "number" ? v : undefined;
}

// The identity a lifecycle write + its audit target.
export type LifecycleTarget = {
  tenantId: string;
  connectorId: string;
  dbSecretKind: string;
  version: number;
  reasonClass?: ConnectorSecretLifecycleReason;
  correlationId?: string;
};

type LifecycleOp = "revocation" | "tombstone";
const EVENT_TYPE: Record<LifecycleOp, "revoked" | "tombstoned"> = { revocation: "revoked", tombstone: "tombstoned" };

function reasonOf(r: ConnectorSecretLifecycleReason | undefined): ConnectorSecretLifecycleReason {
  return r !== undefined && (CONNECTOR_SECRET_LIFECYCLE_REASONS as readonly string[]).includes(r) ? r : "unspecified";
}

// Build a #166 allowlist audit record for a lifecycle event (validates ids/secret_kind/version/correlation, drops
// any non-allowlisted field). `target_not_found` is the static class on the failed (nonexistent) terminal.
function record(op: LifecycleOp, suffix: "attempted" | "succeeded" | "failed", t: LifecycleTarget): ConnectorSecretAuditRecord {
  return buildConnectorSecretAuditEvent({
    event: `connector_secret.${op}.${suffix}` as ConnectorSecretAuditEvent,
    tenantId: t.tenantId,
    connectorId: t.connectorId,
    secretKind: t.dbSecretKind,
    version: t.version,
    actorType: "connector_runner",
    ...(suffix === "failed" ? { errorClass: "target_not_found" as const } : {}),
    ...(t.correlationId !== undefined ? { correlationId: t.correlationId } : {}),
  });
}

// Run the single ATOMIC CTE. The records are built up front (this VALIDATES the ids / secret_kind / version /
// correlation via the #166 builder — a malformed input throws cleanly, before any DB work).
async function writeLifecycleEvent(conn: RunnerConnection, op: LifecycleOp, t: LifecycleTarget): Promise<{ ok: true }> {
  const attempted = record(op, "attempted", t);
  const succeeded = record(op, "succeeded", t);
  const failed = record(op, "failed", t);
  const stmt: RunnerStatement = {
    sql: LIFECYCLE_WRITE_SQL,
    params: [
      t.tenantId, t.connectorId, t.dbSecretKind, t.version, EVENT_TYPE[op], reasonOf(t.reasonClass), "connector_runner", t.correlationId ?? null,
      "connector_secret", // $9 resource_type (shared by all three audit rows)
      attempted.action, JSON.stringify(attempted.afterJson), // $10/$11
      succeeded.action, JSON.stringify(succeeded.afterJson), // $12/$13
      failed.action, JSON.stringify(failed.afterJson), // $14/$15
    ],
  };

  let results: Array<{ rows: ReadonlyArray<Record<string, unknown>> }>;
  try {
    results = await conn.runSequence([SET_ROLE, stmt]);
  } catch {
    // ANY insert in the CTE errored → the whole statement rolled back: NO lifecycle row, NO audit row. Fail closed.
    throw new ConnectorSecretLifecycleError(`connector secret ${op} failed`);
  }
  const lifecycleInserted = asNumber(results[results.length - 1]?.rows[0]?.lifecycle_inserted) ?? 0;
  if (lifecycleInserted < 1) {
    // The target connector_secrets version did NOT exist → NO lifecycle row, NO succeeded audit; the attempted +
    // `failed` (target_not_found) audit rows WERE committed. Fail with an explicit not-found — NEVER report { ok }.
    throw new ConnectorSecretLifecycleError("target connector secret version does not exist");
  }
  return { ok: true };
}

// The runner-backed lifecycle WRITER. revoke/tombstone APPEND a terminal event for an EXISTING secret version,
// atomically with exactly one terminal audit outcome. There is NO unrevoke/reactivate/restore, NO rotation helper,
// and NO secret return. revoke/tombstone of a NONEXISTENT version THROW (the caller never receives `{ ok }`).
export function createRunnerConnectorSecretLifecycleWriter(conn: RunnerConnection): {
  revoke(target: LifecycleTarget): Promise<{ ok: true }>;
  tombstone(target: LifecycleTarget): Promise<{ ok: true }>;
} {
  return {
    revoke: (target) => writeLifecycleEvent(conn, "revocation", target),
    tombstone: (target) => writeLifecycleEvent(conn, "tombstone", target),
  };
}
