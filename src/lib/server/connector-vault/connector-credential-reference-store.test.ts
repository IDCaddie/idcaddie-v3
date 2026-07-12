import { describe, it, expect } from "vitest";
import {
  createRunnerConnectorCredentialReferenceStore,
  ConnectorCredentialReferenceStoreError,
  SELECT_CREDENTIAL_REFERENCE_SQL,
} from "./connector-credential-reference-store";
import type { RunnerConnection } from "./runner-db-client";

// Synthetic values only.
const TENANT = "a2000000-0000-4000-8000-000000000001";
const CONN = "a3000000-0000-4000-8000-000000000001";
const PROVIDER = "microsoft_entra";
const REF = "EXAMPLE-external-secret-reference";
const VER = "v1";
const okRow = { connector_id: CONN, tenant_id: TENANT, provider: PROVIDER, credential_secret_ref: REF, credential_version: VER };

type Stmt = { sql: string; params: readonly unknown[] };
// A mock RunnerConnection that records every statement and returns `impl()`'s rows as the LAST statement's rows.
function mockConn(impl: () => Record<string, unknown>[]) {
  const seen: Stmt[] = [];
  const conn: RunnerConnection = {
    async runSequence(stmts: readonly Stmt[]) {
      seen.push(...stmts);
      const rows = impl();
      return stmts.map((_, i) => (i === stmts.length - 1 ? { rows } : { rows: [] }));
    },
  };
  return { conn, seen };
}

describe("connector-credential-reference-store · runner-backed, tenant-scoped, exact-one-row, fail-closed", () => {
  it("runs ONE lookup as connector_runner with the EXACT tenant/connector/provider params, and returns the pointer projection", async () => {
    const { conn, seen } = mockConn(() => [okRow]);
    const out = await createRunnerConnectorCredentialReferenceStore(conn).findOwnedCredentialReference({ tenantId: TENANT, connectorId: CONN, provider: PROVIDER });
    expect(out).toEqual({ connectorId: CONN, tenantId: TENANT, provider: PROVIDER, credentialSecretRef: REF, credentialVersion: VER });
    // set role connector_runner, then the exact scoped SELECT with [tenant, connector, provider]
    expect(seen).toHaveLength(2);
    expect(seen[0].sql).toBe("set role connector_runner");
    expect(seen[1].sql).toBe(SELECT_CREDENTIAL_REFERENCE_SQL);
    expect(seen[1].params).toEqual([TENANT, CONN, PROVIDER]);
  });

  it("the SQL is a fixed, tenant+connector+provider-scoped, exact-one-row read from the dedicated table joined to connectors", () => {
    const s = SELECT_CREDENTIAL_REFERENCE_SQL;
    expect(s).toContain("from public.connector_credential_references r");
    expect(s).toContain("join public.connectors c on c.id = r.connector_id and c.tenant_id = r.tenant_id and c.provider = r.provider");
    expect(s).toContain("where r.tenant_id = $1 and r.connector_id = $2 and r.provider = $3 and c.status = 'active'");
    expect(s).toContain("limit 2");
    expect(s).not.toMatch(/\bilike\b|\blike\b| or |offset|order by/i); // no fuzzy/search/fallback
    expect(s).not.toMatch(/select \*/i); // column-scoped, never select *
  });

  it("fails closed on zero rows (absent / not active / NULL metadata) -> null", async () => {
    const { conn } = mockConn(() => []);
    const out = await createRunnerConnectorCredentialReferenceStore(conn).findOwnedCredentialReference({ tenantId: TENANT, connectorId: CONN, provider: PROVIDER });
    expect(out).toBeNull();
  });

  it("throws on multiple rows (ambiguous match)", async () => {
    const { conn } = mockConn(() => [okRow, okRow]);
    await expect(createRunnerConnectorCredentialReferenceStore(conn).findOwnedCredentialReference({ tenantId: TENANT, connectorId: CONN, provider: PROVIDER }))
      .rejects.toBeInstanceOf(ConnectorCredentialReferenceStoreError);
  });

  it("throws on an incomplete row (missing reference or version)", async () => {
    for (const bad of [{ ...okRow, credential_secret_ref: null }, { ...okRow, credential_version: undefined }, { ...okRow, connector_id: null }]) {
      const { conn } = mockConn(() => [bad]);
      await expect(createRunnerConnectorCredentialReferenceStore(conn).findOwnedCredentialReference({ tenantId: TENANT, connectorId: CONN, provider: PROVIDER }))
        .rejects.toBeInstanceOf(ConnectorCredentialReferenceStoreError);
    }
  });

  it("throws on an identity mismatch (returned row does not match the requested tenant/connector/provider)", async () => {
    for (const bad of [{ ...okRow, tenant_id: "b2000000-0000-4000-8000-000000000002" }, { ...okRow, connector_id: "a3000000-0000-4000-8000-0000000000ee" }, { ...okRow, provider: "slack" }]) {
      const { conn } = mockConn(() => [bad]);
      await expect(createRunnerConnectorCredentialReferenceStore(conn).findOwnedCredentialReference({ tenantId: TENANT, connectorId: CONN, provider: PROVIDER }))
        .rejects.toBeInstanceOf(ConnectorCredentialReferenceStoreError);
    }
  });

  it("redacts a DB error — the thrown message carries no DB exception text / reference / ids", async () => {
    const conn: RunnerConnection = { async runSequence() { throw new Error("PGERROR: relation leak " + REF + " " + TENANT); } };
    let thrown: unknown;
    try { await createRunnerConnectorCredentialReferenceStore(conn).findOwnedCredentialReference({ tenantId: TENANT, connectorId: CONN, provider: PROVIDER }); }
    catch (e) { thrown = e; }
    expect(thrown).toBeInstanceOf(ConnectorCredentialReferenceStoreError);
    const msg = String((thrown as Error).message);
    expect(msg).toBe("connector credential reference lookup failed");
    for (const leak of ["PGERROR", REF, TENANT]) expect(msg).not.toContain(leak);
  });
});
