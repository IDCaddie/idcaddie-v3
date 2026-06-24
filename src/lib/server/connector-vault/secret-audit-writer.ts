// Server-only connector-secret AUDIT WRITER that ENLISTS in the runner transaction (docs/42 §84, RISK-007 audit
// wiring, PR #167). It does NOT open a connection, use a separate role, or own a transaction. Its sole job is to
// turn a #166 allowlist audit RECORD into the `audit_logs` INSERT `{sql, params}` STATEMENT that the runner-backed
// store adapter splices into its OWN `runSequence` — so the audit INSERT runs as the SAME `connector_runner` role,
// on the SAME connection, inside the SAME `begin`/`commit` as the `connector_secrets` INSERT (atomic fail-closed).
//
// It writes ONLY the four columns `connector_runner` is granted on `audit_logs` (0031): tenant_id, action,
// resource_type, after_json — NEVER actor_user_id/resource_id/before_json/ip_address/user_agent. The payload is
// the #166 builder's already-allowlisted record; this module forwards ONLY its allowlisted fields (no passthrough).
//
// SERVER-ONLY: under `src/lib/server/`, the runtime browser sentinel below, and `no-client-import.test.ts`. PURE
// (no DB, no Supabase, no service-role, no `fetch`, no `process.env`) — it constructs a parameterized statement only.

import type { ConnectorSecretAuditRecord } from "./secret-audit";

// Runtime server-only sentinel — throw if evaluated in a browser.
if (typeof (globalThis as { window?: unknown }).window !== "undefined") {
  throw new Error("connector-vault/secret-audit-writer is server-only and must not be imported in client code");
}

// INSERT ONLY the four columns 0031 grants `connector_runner` on `audit_logs`. `created_at` is the DB default
// `now()` (the audit layer does not own timestamps); identity/sensitive columns are never named.
export const INSERT_AUDIT_LOG_SQL =
  "insert into public.audit_logs (tenant_id, action, resource_type, after_json) values ($1, $2, $3, $4)";

// A parameterized statement ready to splice into the runner's `runSequence` (same connection / role / transaction).
export type RunnerStatement = { sql: string; params: readonly unknown[] };

// Build the audit INSERT statement from a #166 allowlist audit record. Reads ONLY the record's allowlisted fields
// (tenantId, action, resourceType, afterJson) — never the caller's raw input — and serializes the allowlisted
// after_json. NO arbitrary metadata can reach the row: the record itself is the #166 allowlist output.
export function buildAuditInsertStatement(record: ConnectorSecretAuditRecord): RunnerStatement {
  return {
    sql: INSERT_AUDIT_LOG_SQL,
    params: [record.tenantId, record.action, record.resourceType, JSON.stringify(record.afterJson)],
  };
}
