import { describe, it, expect } from "vitest";
import { randomBytes } from "node:crypto";
import {
  createRunnerConnectorSecretStore,
  ConnectorSecretStoreError,
  INSERT_SECRET_SQL,
  SELECT_SECRET_SQL,
} from "./connector-secret-store";
import { encryptedSecretToColumns } from "./secret-vault";
import { encryptConnectorSecret, decryptConnectorSecret, type ConnectorVaultKeyProvider, type SecretContext } from "./crypto";
import type { RunnerConnection } from "./runner-db-client";

const KEK = "kek-test-1";
const ctx = (over: Partial<SecretContext> = {}): SecretContext => ({
  tenantId: "11111111-1111-1111-1111-111111111111",
  connectorId: "22222222-2222-2222-2222-222222222222",
  secretKind: "oauth_access_token",
  version: 1,
  ...over,
});

// test-only in-memory key provider (NOT secure): "wrap" = kekId prefix + dek; "unwrap" returns the dek.
function memKeyProvider(): ConnectorVaultKeyProvider {
  return {
    async generateDataKey(kekId) {
      const dek = randomBytes(32);
      return { dek, wrappedDek: Buffer.concat([Buffer.from(`${kekId}|`), dek]) };
    },
    async unwrapDataKey(wrappedDek, kekId) {
      const prefix = Buffer.from(`${kekId}|`);
      if (wrappedDek.length < prefix.length || !wrappedDek.subarray(0, prefix.length).equals(prefix)) throw new Error("wrong kek");
      return Buffer.from(wrappedDek.subarray(prefix.length));
    },
  };
}

// A mock RunnerConnection that records every runSequence call and returns canned rows per statement kind.
function mockConn(opts: { insertRows?: Record<string, unknown>[]; selectRows?: Record<string, unknown>[] } = {}) {
  const calls: { sql: string; params: readonly unknown[] }[][] = [];
  const conn: RunnerConnection = {
    async runSequence(statements) {
      calls.push(statements.map((s) => ({ sql: s.sql, params: s.params })));
      return statements.map((s) => {
        if (/^\s*set\s+role/i.test(s.sql)) return { rows: [] };
        if (/^\s*insert/i.test(s.sql)) return { rows: opts.insertRows ?? [{ id: "sec-1" }] };
        if (/^\s*select/i.test(s.sql)) return { rows: opts.selectRows ?? [] };
        return { rows: [] };
      });
    },
  };
  return { conn, calls };
}
// the last recorded runSequence call (a save/load issues exactly one runSequence of [set role, stmt]).
const lastCall = (calls: { sql: string; params: readonly unknown[] }[][]) => calls[calls.length - 1];

describe("connector-secret-store — runner-backed save (insert)", () => {
  it("runs SET ROLE connector_runner then the parameterized INSERT, and returns ONLY a row id", async () => {
    const { conn, calls } = mockConn({ insertRows: [{ id: "sec-9" }] });
    const store = createRunnerConnectorSecretStore(conn);
    const encrypted = await encryptConnectorSecret({ plaintext: "okta-token-PLAINTEXT", context: ctx(), keyProvider: memKeyProvider(), kekId: KEK });
    const result = await store.insertEncryptedSecret({ tenantId: ctx().tenantId, connectorId: ctx().connectorId, dbSecretKind: "oauth_access", version: 1, encrypted });

    expect(result).toEqual({ id: "sec-9" });
    // no plaintext, no ciphertext, no wrapped DEK in the returned result
    const json = JSON.stringify(result);
    expect(json).not.toContain("PLAINTEXT");
    expect(json).not.toContain(encrypted.ciphertext);
    expect(json).not.toContain(encrypted.wrappedDek);
    for (const k of ["ciphertext", "tag", "dek", "plaintext"]) expect(json).not.toContain(k);

    // statement 1 = SET ROLE connector_runner; statement 2 = the INSERT with 12 parameterized values
    const seq = lastCall(calls);
    expect(seq[0].sql.trim().toLowerCase()).toBe("set role connector_runner");
    expect(seq[1].sql).toBe(INSERT_SECRET_SQL);
    const cols = encryptedSecretToColumns(encrypted);
    expect(seq[1].params).toEqual([
      ctx().tenantId, ctx().connectorId, "oauth_access", 1,
      cols.ciphertext, cols.dek_wrapped, cols.aead_nonce, cols.aad_digest, cols.key_id, cols.aead_tag, cols.envelope_version, cols.aead_alg,
    ]);
  });

  it("fails closed when the insert returns no row id", async () => {
    const store = createRunnerConnectorSecretStore(mockConn({ insertRows: [] }).conn);
    const encrypted = await encryptConnectorSecret({ plaintext: "x", context: ctx(), keyProvider: memKeyProvider(), kekId: KEK });
    await expect(store.insertEncryptedSecret({ tenantId: ctx().tenantId, connectorId: ctx().connectorId, dbSecretKind: "oauth_access", version: 1, encrypted }))
      .rejects.toBeInstanceOf(ConnectorSecretStoreError);
  });
});

describe("connector-secret-store — runner-backed load (select)", () => {
  async function completeRow(id = "sec-2") {
    const encrypted = await encryptConnectorSecret({ plaintext: "okta-api-key-abc123", context: ctx(), keyProvider: memKeyProvider(), kekId: KEK });
    const c = encryptedSecretToColumns(encrypted);
    return { encrypted, row: { id, ciphertext: c.ciphertext, dek_wrapped: c.dek_wrapped, aead_nonce: c.aead_nonce, aad_digest: c.aad_digest, key_id: c.key_id, aead_tag: c.aead_tag, envelope_version: c.envelope_version, aead_alg: c.aead_alg } };
  }

  it("runs SET ROLE then the parameterized active/non-expired SELECT, reconstructs the COMPLETE envelope, and decrypts", async () => {
    const kp = memKeyProvider();
    const encrypted = await encryptConnectorSecret({ plaintext: "round-trip-PLAINTEXT", context: ctx(), keyProvider: kp, kekId: KEK });
    const c = encryptedSecretToColumns(encrypted);
    const row = { id: "sec-7", ciphertext: c.ciphertext, dek_wrapped: c.dek_wrapped, aead_nonce: c.aead_nonce, aad_digest: c.aad_digest, key_id: c.key_id, aead_tag: c.aead_tag, envelope_version: c.envelope_version, aead_alg: c.aead_alg };
    const { conn, calls } = mockConn({ selectRows: [row] });
    const store = createRunnerConnectorSecretStore(conn);

    const found = await store.findEncryptedSecret({ tenantId: ctx().tenantId, connectorId: ctx().connectorId, dbSecretKind: "oauth_access", version: 1 });
    expect(found).not.toBeNull();
    expect(found!.id).toBe("sec-7");
    expect(found!.encrypted).toEqual(encrypted); // complete envelope reconstructed byte-identical
    // and it still decrypts to the original plaintext
    const pt = await decryptConnectorSecret({ encrypted: found!.encrypted, context: ctx(), keyProvider: kp });
    expect(pt.toString("utf8")).toBe("round-trip-PLAINTEXT");

    const seq = lastCall(calls);
    expect(seq[0].sql.trim().toLowerCase()).toBe("set role connector_runner");
    expect(seq[1].sql).toBe(SELECT_SECRET_SQL);
    expect(seq[1].params).toEqual([ctx().tenantId, ctx().connectorId, "oauth_access", 1]);
    // the SELECT filters to active + non-expired, parameterized identity only
    expect(seq[1].sql).toMatch(/status = 'active'/);
    expect(seq[1].sql).toMatch(/expires_at is null or expires_at > now\(\)/);
  });

  it("returns null when no matching active secret exists", async () => {
    const store = createRunnerConnectorSecretStore(mockConn({ selectRows: [] }).conn);
    expect(await store.findEncryptedSecret({ tenantId: ctx().tenantId, connectorId: ctx().connectorId, dbSecretKind: "oauth_access", version: 1 })).toBeNull();
  });

  it("fails closed when more than one active secret matches (ambiguous)", async () => {
    const { row: r1 } = await completeRow("a");
    const { row: r2 } = await completeRow("b");
    const store = createRunnerConnectorSecretStore(mockConn({ selectRows: [r1, r2] }).conn);
    await expect(store.findEncryptedSecret({ tenantId: ctx().tenantId, connectorId: ctx().connectorId, dbSecretKind: "oauth_access", version: 1 }))
      .rejects.toBeInstanceOf(ConnectorSecretStoreError);
  });

  it("fails closed on an INCOMPLETE stored row (missing aead_tag — a pre-0030/partial envelope)", async () => {
    const { row } = await completeRow();
    delete (row as Record<string, unknown>).aead_tag; // the GCM tag is required to decrypt
    const store = createRunnerConnectorSecretStore(mockConn({ selectRows: [row] }).conn);
    await expect(store.findEncryptedSecret({ tenantId: ctx().tenantId, connectorId: ctx().connectorId, dbSecretKind: "oauth_access", version: 1 }))
      .rejects.toThrow();
  });
});

describe("connector-secret-store — SQL uses ONLY allowed columns; no UPDATE/DELETE", () => {
  it("the INSERT names exactly the 12 granted write columns + RETURNING id; no disallowed column", () => {
    expect(INSERT_SECRET_SQL).toContain("(tenant_id, connector_id, secret_kind, version, ciphertext, dek_wrapped, aead_nonce, aad_digest, key_id, aead_tag, envelope_version, aead_alg)");
    expect(INSERT_SECRET_SQL).toContain("returning id");
    // never writes id (server default) or non-granted columns
    for (const bad of ["is_active", "created_at", "revoked_at"]) expect(INSERT_SECRET_SQL).not.toContain(bad);
    // the INSERT column-list must NOT include id (it is RETURNING id, not inserting it)
    expect(INSERT_SECRET_SQL).not.toMatch(/\(id,/);
  });

  it("the SELECT reads only granted columns and filters active/non-expired by parameterized identity", () => {
    expect(SELECT_SECRET_SQL).toContain("select id, ciphertext, dek_wrapped, aead_nonce, aad_digest, key_id, aead_tag, envelope_version, aead_alg");
    expect(SELECT_SECRET_SQL).toContain("where tenant_id = $1 and connector_id = $2 and secret_kind = $3 and version = $4");
    for (const bad of ["is_active", "created_at", "revoked_at"]) expect(SELECT_SECRET_SQL).not.toContain(bad);
  });

  it("neither SQL statement performs an UPDATE or DELETE", () => {
    for (const sql of [INSERT_SECRET_SQL, SELECT_SECRET_SQL]) {
      expect(sql.toLowerCase()).not.toMatch(/\bupdate\b/);
      expect(sql.toLowerCase()).not.toMatch(/\bdelete\b/);
      expect(sql.toLowerCase()).not.toMatch(/\btruncate\b/);
    }
  });
});

// Static guard: server-only — imports only sibling modules; no db/supabase client, no service-role, no fetch,
// no process.env, no route. Runs as connector_runner via the runner DB client path only.
describe("connector-secret-store is server-safe (runner-only; no service-role/client/fetch/route/env)", () => {
  it("imports only sibling vault modules and contains no forbidden call/string", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const src = fs.readFileSync(path.resolve(__dirname, "connector-secret-store.ts"), "utf8");
    const imports = [...src.matchAll(/from\s+["']([^"']+)["']/g)].map((m) => m[1]).sort();
    expect(imports).toEqual(["./runner-db-client", "./secret-vault"]);
    expect(src).toMatch(/server-only and must not be imported in client code/); // browser sentinel present
    expect(src).toMatch(/set role connector_runner/); // runs under the runner role (via createRunnerDbClient)
    const code = src.replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
    expect(code).not.toMatch(/createClient\s*\(/);
    expect(code).not.toMatch(/createServiceClient/);
    expect(code).not.toMatch(/@supabase/);
    expect(code).not.toMatch(/\bfetch\s*\(/);
    expect(code).not.toMatch(/process\.env/);
    expect(code).not.toContain(["service", "role", "key"].join("_"));
    for (const bad of ["NextRequest", "NextResponse", "export async function GET", "export async function POST"]) {
      expect(code).not.toContain(bad);
    }
  });
});
