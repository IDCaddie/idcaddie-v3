// Server-only RUNNER-BACKED connector CREDENTIAL-REFERENCE read (migration 0043). It reads the EXACT owned connector's
// credential-reference METADATA — the external secret reference (a pointer, e.g. an AWS Secrets Manager ARN) + its version —
// ONLY through the runner DB connection (`SET ROLE connector_runner` — the narrow COLUMN-scoped 0043 SELECT grant). It returns
// a POINTER, never a credential VALUE: the actual secret lives in the external store and is fetched separately through that
// store's own IAM/role boundary. The read is tenant-scoped, exact-one-row, and fail-closed.
//
// SAFE BY CONSTRUCTION: runner-only (every statement runs under `set role connector_runner` on the injected
// `RunnerConnection`; NO service-role/global/request-path client; NO Supabase client; NO `fetch`; NO `process.env`; NO
// route/UI). Column-scoped: the SELECT reads ONLY the 0043-granted columns and filters to one ACTIVE row with non-null
// credential metadata for (tenant, connector, provider). `limit 2` detects an ambiguous match. NO list/search/fallback, NO
// connection-id-only lookup, NO write. Every value is PARAMETERIZED. Errors are redacted to a fixed static message — never a
// tenant/connector id, a reference, a row, or a DB exception. RISK-007 remains OPEN.
//
// SERVER-ONLY: under `src/lib/server/`, the runtime browser sentinel below, and `no-client-import.test.ts`.

import type { RunnerConnection } from "./runner-db-client";

// Runtime server-only sentinel — throw if evaluated in a browser.
if (typeof (globalThis as { window?: unknown }).window !== "undefined") {
  throw new Error("connector-vault/connector-credential-reference-store is server-only and must not be imported in client code");
}

// A typed, safe-to-surface error — its message is always a fixed static string, never id/reference/row/DB material.
export class ConnectorCredentialReferenceStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConnectorCredentialReferenceStoreError";
  }
}

// The narrow projection the runner needs — identity + the credential REFERENCE (a pointer), never a credential value.
export type ConnectorCredentialReference = {
  readonly connectorId: string;
  readonly tenantId: string;
  readonly provider: string;
  readonly credentialSecretRef: string;
  readonly credentialVersion: string;
};

// The tenant-scoped, exact-one-row read: read ONLY the 0043-granted reference columns from the dedicated deny-all
// connector_credential_references table, JOINed to connectors on the composite key so the owning connector is verified ACTIVE
// and its provider matches, for the exact (tenant, connector, provider). The columns are NOT NULL, so a ROW is a present
// reference; `limit 2` detects an ambiguous match. NO secret value is read; the reference is a pointer only.
export const SELECT_CREDENTIAL_REFERENCE_SQL =
  "select r.connector_id, r.tenant_id, r.provider, r.credential_secret_ref, r.credential_version " +
  "from public.connector_credential_references r " +
  "join public.connectors c on c.id = r.connector_id and c.tenant_id = r.tenant_id and c.provider = r.provider " +
  "where r.tenant_id = $1 and r.connector_id = $2 and r.provider = $3 and c.status = 'active' limit 2";

const SET_ROLE = { sql: "set role connector_runner", params: [] as readonly unknown[] };
const asString = (v: unknown): string | undefined => (typeof v === "string" && v.length > 0 ? v : undefined);

export type CredentialReferenceQuery = { tenantId: string; connectorId: string; provider: string };

// Build the runner-backed credential-reference read store. The injected `RunnerConnection.runSequence` runs the statements in
// order on ONE connection as `connector_runner`. Never service-role. One lookup per call; no retry/fallback.
export function createRunnerConnectorCredentialReferenceStore(conn: RunnerConnection) {
  return {
    async findOwnedCredentialReference(input: CredentialReferenceQuery): Promise<ConnectorCredentialReference | null> {
      let rows: ReadonlyArray<Record<string, unknown>>;
      try {
        const results = await conn.runSequence([
          SET_ROLE,
          { sql: SELECT_CREDENTIAL_REFERENCE_SQL, params: [input.tenantId, input.connectorId, input.provider] },
        ]);
        rows = results[results.length - 1]?.rows ?? [];
      } catch {
        throw new ConnectorCredentialReferenceStoreError("connector credential reference lookup failed"); // redact the DB error
      }

      if (rows.length > 1) throw new ConnectorCredentialReferenceStoreError("ambiguous connector credential reference (multiple matching rows)");
      if (rows.length === 0) return null; // absent / not active / NULL metadata -> fail closed (not found)

      const row = rows[0];
      const connectorId = asString(row.connector_id);
      const tenantId = asString(row.tenant_id);
      const provider = asString(row.provider);
      const credentialSecretRef = asString(row.credential_secret_ref);
      const credentialVersion = asString(row.credential_version);
      if (!connectorId || !tenantId || !provider || !credentialSecretRef || !credentialVersion) {
        throw new ConnectorCredentialReferenceStoreError("connector credential reference row is incomplete"); // never echo the row
      }
      // Defense in depth: the returned identity MUST equal what was asked (the query is already tenant-scoped).
      if (tenantId !== input.tenantId || connectorId !== input.connectorId || provider !== input.provider) {
        throw new ConnectorCredentialReferenceStoreError("connector credential reference identity mismatch");
      }
      return { connectorId, tenantId, provider, credentialSecretRef, credentialVersion }; // a POINTER only — no credential value
    },
  };
}
