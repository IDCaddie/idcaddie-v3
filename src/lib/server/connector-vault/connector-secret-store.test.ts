import { describe, it, expect } from "vitest";
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
const KIND = "oauth_access";
const idInput = { tenantId: ctx().tenantId, connectorId: ctx().connectorId, dbSecretKind: KIND, version: 1 };

function memKeyProvider(): ConnectorVaultKeyProvider {
  return {
    async generateDataKey(kekId) {
      const { randomBytes } = await import("node:crypto");
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

type Stmt = { sql: string; params: readonly unknown[] };
type AuditRow = { tenant_id: unknown; action: string; resource_type: unknown; after_json: Record<string, unknown> };

// A TRANSACTION-MODELING mock RunnerConnection. It records every statement, models begin/commit (an explicit
// transaction flushes its writes ONLY on commit; a statement failure before commit rolls the pending writes back),
// and exposes the COMMITTED connector_secrets + audit_logs rows so a test can prove real persistence + atomicity.
function txMockConn(opts: {
  insertSecretRows?: Record<string, unknown>[];
  selectRows?: Record<string, unknown>[];
  failSecretInsert?: boolean;
  // return true to make THIS audit insert throw; `inTx` = it is inside a begin/commit (the atomic store path).
  failAuditWhen?: (stmt: Stmt, inTx: boolean) => boolean;
} = {}) {
  const allStatements: Stmt[] = [];
  const persistedSecrets: { params: readonly unknown[] }[] = [];
  const persistedAudits: AuditRow[] = [];
  const isInsertSecret = (s: Stmt) => /insert\s+into\s+public\.connector_secrets/i.test(s.sql);
  const isInsertAudit = (s: Stmt) => /insert\s+into\s+public\.audit_logs/i.test(s.sql);

  const conn: RunnerConnection = {
    async runSequence(statements) {
      for (const s of statements) allStatements.push({ sql: s.sql, params: s.params });
      const inTx = statements.some((s) => /^\s*begin\s*$/i.test(s.sql));
      const pendSecrets: { params: readonly unknown[] }[] = [];
      const pendAudits: AuditRow[] = [];
      const results: { rows: ReadonlyArray<Record<string, unknown>> }[] = [];
      let committed = false;
      for (const s of statements) {
        if (/^\s*set\s+role/i.test(s.sql) || /^\s*begin\s*$/i.test(s.sql)) { results.push({ rows: [] }); continue; }
        if (/^\s*commit\s*$/i.test(s.sql)) { committed = true; results.push({ rows: [] }); continue; }
        if (isInsertSecret(s)) {
          if (opts.failSecretInsert) throw new Error("secret insert failed"); // tx rejects; pending not flushed
          pendSecrets.push({ params: s.params });
          results.push({ rows: opts.insertSecretRows ?? [{ id: "sec-1" }] });
          continue;
        }
        if (isInsertAudit(s)) {
          if (opts.failAuditWhen?.(s, inTx)) throw new Error("audit insert failed"); // tx/auto rejects; not flushed
          pendAudits.push({ tenant_id: s.params[0], action: String(s.params[1]), resource_type: s.params[2], after_json: JSON.parse(String(s.params[3])) });
          results.push({ rows: [] });
          continue;
        }
        if (/^\s*select/i.test(s.sql)) { results.push({ rows: opts.selectRows ?? [] }); continue; }
        results.push({ rows: [] });
      }
      // explicit tx flushes only on commit; an auto-commit sequence (no begin) flushes its single write.
      if (!inTx || committed) { persistedSecrets.push(...pendSecrets); persistedAudits.push(...pendAudits); }
      return results;
    },
  };
  return { conn, allStatements, persistedSecrets, persistedAudits };
}

async function anEncrypted() {
  return encryptConnectorSecret({ plaintext: "okta-token-PLAINTEXT", context: ctx(), keyProvider: memKeyProvider(), kekId: KEK });
}
const auditActions = (audits: AuditRow[]) => audits.map((a) => a.action);
const hasDelete = (stmts: Stmt[]) => stmts.some((s) => /delete\s+from\s+public\.connector_secrets/i.test(s.sql));
const hasUpdateSecret = (stmts: Stmt[]) => stmts.some((s) => /update\s+public\.connector_secrets/i.test(s.sql));

describe("connector-secret-store — store emits ATOMIC, persisted audit (attempted + succeeded)", () => {
  it("persists store.attempted + store.succeeded for a successful insert; secret + succeeded-audit share one tx", async () => {
    const m = txMockConn({ insertSecretRows: [{ id: "sec-9" }] });
    const store = createRunnerConnectorSecretStore(m.conn);
    const encrypted = await anEncrypted();
    const result = await store.insertEncryptedSecret({ ...idInput, encrypted });

    expect(result).toEqual({ id: "sec-9" });
    // both audit rows persisted; the secret row persisted.
    expect(auditActions(m.persistedAudits)).toEqual(["connector_secret.store.attempted", "connector_secret.store.succeeded"]);
    expect(m.persistedSecrets).toHaveLength(1);

    // the SUCCESS path is ONE transaction containing BOTH the secret INSERT and the succeeded-audit INSERT.
    const atomic = m.allStatements;
    const beginIdx = atomic.findIndex((s) => /^\s*begin\s*$/i.test(s.sql));
    const commitIdx = atomic.findIndex((s) => /^\s*commit\s*$/i.test(s.sql));
    expect(beginIdx).toBeGreaterThanOrEqual(0);
    expect(commitIdx).toBeGreaterThan(beginIdx);
    const inTx = atomic.slice(beginIdx, commitIdx + 1);
    expect(inTx.some((s) => /insert\s+into\s+public\.connector_secrets/i.test(s.sql))).toBe(true);
    expect(inTx.some((s) => /insert\s+into\s+public\.audit_logs/i.test(s.sql))).toBe(true);
    // NO compensating delete / no UPDATE/DELETE on connector_secrets anywhere.
    expect(hasDelete(m.allStatements)).toBe(false);
    expect(hasUpdateSecret(m.allStatements)).toBe(false);
  });

  it("the persisted audit row carries ONLY the #166 allowlist payload — no secret material", async () => {
    const m = txMockConn({ insertSecretRows: [{ id: "sec-1" }] });
    const store = createRunnerConnectorSecretStore(m.conn);
    const encrypted = await anEncrypted();
    await store.insertEncryptedSecret({ ...idInput, encrypted });

    const succeeded = m.persistedAudits.find((a) => a.action === "connector_secret.store.succeeded")!;
    expect(succeeded.tenant_id).toBe(ctx().tenantId);
    expect(succeeded.resource_type).toBe("connector_secret");
    expect(Object.keys(succeeded.after_json).sort()).toEqual(["actor_type", "connector_id", "event", "result", "secret_kind", "version"]);
    expect(succeeded.after_json).toMatchObject({ event: "connector_secret.store.succeeded", connector_id: ctx().connectorId, secret_kind: KIND, version: 1, result: "succeeded", actor_type: "connector_runner" });
    // no secret/ciphertext/key material anywhere in the serialized audit row.
    const json = JSON.stringify(m.persistedAudits);
    for (const bad of ["PLAINTEXT", encrypted.ciphertext, encrypted.wrappedDek, encrypted.tag, encrypted.iv, "ciphertext", "dek", "wrapped", "aead", "nonce", "plaintext"]) {
      expect(json).not.toContain(bad);
    }
  });
});

describe("connector-secret-store — store fail-closed (atomic rollback)", () => {
  it("persists store.failed and commits NO secret when the connector_secrets insert fails", async () => {
    const m = txMockConn({ failSecretInsert: true });
    const store = createRunnerConnectorSecretStore(m.conn);
    await expect(store.insertEncryptedSecret({ ...idInput, encrypted: await anEncrypted() })).rejects.toBeInstanceOf(ConnectorSecretStoreError);
    expect(m.persistedSecrets).toHaveLength(0);
    expect(auditActions(m.persistedAudits)).toEqual(["connector_secret.store.attempted", "connector_secret.store.failed"]);
    expect(m.persistedAudits.find((a) => a.action === "connector_secret.store.failed")!.after_json.error_class).toBe("store_failed");
    expect(hasDelete(m.allStatements)).toBe(false); // no compensating delete
  });

  it("FAILS CLOSED: if the in-transaction succeeded-audit insert fails, the whole tx rolls back — NO secret row", async () => {
    const m = txMockConn({ failAuditWhen: (_s, inTx) => inTx }); // fail ONLY the audit insert inside the atomic tx
    const store = createRunnerConnectorSecretStore(m.conn);
    await expect(store.insertEncryptedSecret({ ...idInput, encrypted: await anEncrypted() })).rejects.toBeInstanceOf(ConnectorSecretStoreError);
    // the atomic tx rolled back: no secret persisted, no succeeded audit; a failed audit was recorded out-of-band.
    expect(m.persistedSecrets).toHaveLength(0);
    expect(auditActions(m.persistedAudits)).not.toContain("connector_secret.store.succeeded");
    expect(auditActions(m.persistedAudits)).toContain("connector_secret.store.failed");
    expect(hasDelete(m.allStatements)).toBe(false); // NO compensating delete — atomic rollback only
  });

  it("FAILS CLOSED before any insert: if the attempted-audit write fails, no secret is inserted at all", async () => {
    const m = txMockConn({ failAuditWhen: (s) => String(s.params[1]) === "connector_secret.store.attempted" });
    const store = createRunnerConnectorSecretStore(m.conn);
    await expect(store.insertEncryptedSecret({ ...idInput, encrypted: await anEncrypted() })).rejects.toBeInstanceOf(ConnectorSecretStoreError);
    expect(m.persistedSecrets).toHaveLength(0);
    expect(m.allStatements.some((s) => /insert\s+into\s+public\.connector_secrets/i.test(s.sql))).toBe(false);
  });

  it("fails closed when the insert returns no row id (after a committed audit, surfaces a redacted error)", async () => {
    const m = txMockConn({ insertSecretRows: [] });
    const store = createRunnerConnectorSecretStore(m.conn);
    await expect(store.insertEncryptedSecret({ ...idInput, encrypted: await anEncrypted() })).rejects.toBeInstanceOf(ConnectorSecretStoreError);
  });
});

describe("connector-secret-store — load emits persisted audit, fail-closed on audit failure", () => {
  async function completeRow(id = "sec-2") {
    const encrypted = await encryptConnectorSecret({ plaintext: "round-trip-PLAINTEXT", context: ctx(), keyProvider: memKeyProvider(), kekId: KEK });
    const c = encryptedSecretToColumns(encrypted);
    return { encrypted, row: { id, ciphertext: c.ciphertext, dek_wrapped: c.dek_wrapped, aead_nonce: c.aead_nonce, aad_digest: c.aad_digest, key_id: c.key_id, aead_tag: c.aead_tag, envelope_version: c.envelope_version, aead_alg: c.aead_alg } };
  }

  it("persists load.attempted + load.succeeded for a successful read, reconstructs the envelope, decrypts", async () => {
    const kp = memKeyProvider();
    const encrypted = await encryptConnectorSecret({ plaintext: "round-trip-PLAINTEXT", context: ctx(), keyProvider: kp, kekId: KEK });
    const c = encryptedSecretToColumns(encrypted);
    const row = { id: "sec-7", ciphertext: c.ciphertext, dek_wrapped: c.dek_wrapped, aead_nonce: c.aead_nonce, aad_digest: c.aad_digest, key_id: c.key_id, aead_tag: c.aead_tag, envelope_version: c.envelope_version, aead_alg: c.aead_alg };
    const m = txMockConn({ selectRows: [row] });
    const store = createRunnerConnectorSecretStore(m.conn);

    const found = await store.findEncryptedSecret(idInput);
    expect(found!.id).toBe("sec-7");
    expect(found!.encrypted).toEqual(encrypted);
    expect((await decryptConnectorSecret({ encrypted: found!.encrypted, context: ctx(), keyProvider: kp })).toString("utf8")).toBe("round-trip-PLAINTEXT");
    expect(auditActions(m.persistedAudits)).toEqual(["connector_secret.load.attempted", "connector_secret.load.succeeded"]);
    // the read uses the parameterized active/non-expired SELECT.
    const sel = m.allStatements.find((s) => s.sql === SELECT_SECRET_SQL)!;
    expect(sel.params).toEqual([ctx().tenantId, ctx().connectorId, KIND, 1]);
  });

  it("returns null + load.succeeded when no matching active secret exists", async () => {
    const m = txMockConn({ selectRows: [] });
    const store = createRunnerConnectorSecretStore(m.conn);
    expect(await store.findEncryptedSecret(idInput)).toBeNull();
    expect(auditActions(m.persistedAudits)).toEqual(["connector_secret.load.attempted", "connector_secret.load.succeeded"]);
  });

  it("persists load.failed (ambiguous_match) and throws when >1 active rows match", async () => {
    const { row: r1 } = await completeRow("a");
    const { row: r2 } = await completeRow("b");
    const m = txMockConn({ selectRows: [r1, r2] });
    const store = createRunnerConnectorSecretStore(m.conn);
    await expect(store.findEncryptedSecret(idInput)).rejects.toBeInstanceOf(ConnectorSecretStoreError);
    expect(auditActions(m.persistedAudits)).toEqual(["connector_secret.load.attempted", "connector_secret.load.failed"]);
    expect(m.persistedAudits.find((a) => a.action === "connector_secret.load.failed")!.after_json.error_class).toBe("ambiguous_match");
  });

  it("persists load.failed (invalid_envelope) on an incomplete stored row (missing aead_tag)", async () => {
    const { row } = await completeRow();
    delete (row as Record<string, unknown>).aead_tag;
    const m = txMockConn({ selectRows: [row] });
    const store = createRunnerConnectorSecretStore(m.conn);
    await expect(store.findEncryptedSecret(idInput)).rejects.toBeInstanceOf(ConnectorSecretStoreError);
    expect(m.persistedAudits.find((a) => a.action === "connector_secret.load.failed")!.after_json.error_class).toBe("invalid_envelope");
  });

  it("FAILS CLOSED: if the load.succeeded audit write fails, the load throws and returns NO encrypted payload", async () => {
    const { row } = await completeRow("sec-x");
    const m = txMockConn({ selectRows: [row], failAuditWhen: (s) => String(s.params[1]) === "connector_secret.load.succeeded" });
    const store = createRunnerConnectorSecretStore(m.conn);
    let returned: unknown = "SENTINEL";
    await expect((async () => { returned = await store.findEncryptedSecret(idInput); })()).rejects.toBeInstanceOf(ConnectorSecretStoreError);
    expect(returned).toBe("SENTINEL"); // the caller never received the secret/envelope
  });
});

describe("connector-secret-store — allowlist glue: hostile/benign extra input fields cannot reach the audit row", () => {
  it("drops secret-shaped AND benign unknown fields on the store input; only the allowlist payload is audited", async () => {
    const m = txMockConn({ insertSecretRows: [{ id: "sec-1" }] });
    const store = createRunnerConnectorSecretStore(m.conn);
    const encrypted = await anEncrypted();
    // a careless caller passes secret-shaped AND benign extra props alongside the real input.
    const hostile = {
      ...idInput,
      encrypted,
      plaintext: "leaky-PLAINTEXT",
      access_token: "gho_LEAKLEAKLEAKLEAK",
      ciphertext: "CIPHERTEXT-LEAK",
      wrappedDek: "WRAPPED-LEAK",
      favoriteColor: "blurple",
    } as unknown as Parameters<typeof store.insertEncryptedSecret>[0];
    await store.insertEncryptedSecret(hostile);

    const json = JSON.stringify(m.persistedAudits);
    for (const bad of ["leaky-PLAINTEXT", "gho_LEAK", "CIPHERTEXT-LEAK", "WRAPPED-LEAK", "favoriteColor", "blurple", "plaintext", "access_token"]) {
      expect(json).not.toContain(bad);
    }
    // every audit row carries ONLY the allowlist keys.
    for (const a of m.persistedAudits) {
      for (const k of Object.keys(a.after_json)) {
        expect(["event", "connector_id", "secret_kind", "version", "result", "actor_type", "error_class", "correlation_id"]).toContain(k);
      }
    }
  });

  it("a failed audit write surfaces a redacted static error — no secret material in the thrown error", async () => {
    const m = txMockConn({ failAuditWhen: () => true });
    const store = createRunnerConnectorSecretStore(m.conn);
    try {
      await store.insertEncryptedSecret({ ...idInput, encrypted: await anEncrypted() });
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(ConnectorSecretStoreError);
      const msg = String((e as Error).message);
      for (const bad of ["PLAINTEXT", "ciphertext", "dek", "token"]) expect(msg.toLowerCase()).not.toContain(bad.toLowerCase());
    }
  });
});

describe("connector-secret-store — only store/load events; no decrypt/rotation/revocation; no UPDATE/DELETE", () => {
  it("never emits a decrypt / rotation / revocation / delete / update audit event (no such call site)", async () => {
    const m = txMockConn({ insertSecretRows: [{ id: "s" }], selectRows: [] });
    const store = createRunnerConnectorSecretStore(m.conn);
    await store.insertEncryptedSecret({ ...idInput, encrypted: await anEncrypted() });
    await store.findEncryptedSecret(idInput);
    const actions = auditActions(m.persistedAudits).join(" ");
    for (const bad of ["decrypt", "rotation", "revocation", "delete", "update"]) expect(actions).not.toContain(bad);
    // every emitted action is one of the six wired store/load events.
    for (const a of m.persistedAudits) {
      expect(/^connector_secret\.(store|load)\.(attempted|succeeded|failed)$/.test(a.action)).toBe(true);
    }
  });

  it("the INSERT shape is unchanged and the lifecycle-aware SELECT contains no UPDATE/DELETE/TRUNCATE", () => {
    expect(INSERT_SECRET_SQL).toContain("(tenant_id, connector_id, secret_kind, version, ciphertext, dek_wrapped, aead_nonce, aad_digest, key_id, aead_tag, envelope_version, aead_alg)");
    expect(INSERT_SECRET_SQL).toContain("returning id");
    expect(INSERT_SECRET_SQL).not.toMatch(/\(id,/);
    // the SELECT keeps the active/non-expired filter AND adds the lifecycle NOT EXISTS (revoked/tombstoned).
    expect(SELECT_SECRET_SQL).toContain("cs.status = 'active' and (cs.expires_at is null or cs.expires_at > now())");
    expect(SELECT_SECRET_SQL).toContain("not exists (select 1 from public.connector_secret_lifecycle_events le");
    expect(SELECT_SECRET_SQL).toContain("le.lifecycle_event_type in ('revoked', 'tombstoned')");
    // the SELECT only READS the lifecycle table — never writes/mutates it.
    for (const sql of [INSERT_SECRET_SQL, SELECT_SECRET_SQL]) {
      expect(sql.toLowerCase()).not.toMatch(/\bupdate\b/);
      expect(sql.toLowerCase()).not.toMatch(/\bdelete\b/);
      expect(sql.toLowerCase()).not.toMatch(/\btruncate\b/);
      // never INSERTs into the lifecycle table (no lifecycle write in this PR).
      expect(sql.toLowerCase()).not.toMatch(/insert\s+into\s+public\.connector_secret_lifecycle_events/);
    }
  });
});

// A lifecycle-modeling mock: the secret SELECT returns rows PER VERSION (so a test can simulate the DB excluding
// a revoked/tombstoned/expired version by returning [] for that version), and `select max(version)` returns a
// configured highest version. It records EVERY version the adapter queried, so a test can prove the latest-intent
// load queries ONLY the highest version and NEVER falls back to a lower one. Audit writes always succeed.
function lifecycleMockConn(opts: { maxVersion?: number | null; secretRowsByVersion?: Record<number, Record<string, unknown>[]> }) {
  const allStatements: Stmt[] = [];
  const selectVersionsQueried: number[] = [];
  const persistedAudits: AuditRow[] = [];
  const conn: RunnerConnection = {
    async runSequence(statements) {
      for (const s of statements) allStatements.push({ sql: s.sql, params: s.params });
      return statements.map((s) => {
        if (/^\s*(set\s+role|begin|commit)/i.test(s.sql)) return { rows: [] };
        if (/insert\s+into\s+public\.audit_logs/i.test(s.sql)) {
          persistedAudits.push({ tenant_id: s.params[0], action: String(s.params[1]), resource_type: s.params[2], after_json: JSON.parse(String(s.params[3])) });
          return { rows: [] };
        }
        if (/select\s+max\(version\)/i.test(s.sql)) return { rows: [{ version: opts.maxVersion ?? null }] };
        if (/select\s+cs\.id[\s\S]*from\s+public\.connector_secrets\s+cs/i.test(s.sql)) {
          const v = s.params[3] as number;
          selectVersionsQueried.push(v);
          return { rows: opts.secretRowsByVersion?.[v] ?? [] };
        }
        return { rows: [] };
      });
    },
  };
  return { conn, allStatements, selectVersionsQueried, persistedAudits };
}

// A complete connector_secrets SELECT row (the projected envelope columns) the adapter can reconstruct + decrypt.
async function aSecretRow(id = "sec-1") {
  const c = encryptedSecretToColumns(await anEncrypted());
  return { id, ciphertext: c.ciphertext, dek_wrapped: c.dek_wrapped, aead_nonce: c.aead_nonce, aad_digest: c.aad_digest, key_id: c.key_id, aead_tag: c.aead_tag, envelope_version: c.envelope_version, aead_alg: c.aead_alg };
}

describe("connector-secret-store — EXACT lifecycle-aware load (the SELECT carries the lifecycle NOT EXISTS)", () => {
  it("exact version active, no lifecycle event -> returns (params unchanged from #167; lifecycle subquery present)", async () => {
    const m = lifecycleMockConn({ secretRowsByVersion: { 1: [await aSecretRow("sec-7")] } });
    const found = await createRunnerConnectorSecretStore(m.conn).findEncryptedSecret(idInput);
    expect(found!.id).toBe("sec-7");
    const sel = m.allStatements.find((s) => /from\s+public\.connector_secrets\s+cs/i.test(s.sql))!;
    expect(sel.params).toEqual([ctx().tenantId, ctx().connectorId, KIND, 1]); // unchanged identity params
    expect(sel.sql).toContain("connector_secret_lifecycle_events"); // lifecycle-aware
    expect(auditActions(m.persistedAudits)).toEqual(["connector_secret.load.attempted", "connector_secret.load.succeeded"]);
  });

  it("exact version excluded by the DB (revoked / tombstoned / expired -> 0 rows) -> null, fail closed", async () => {
    // the lifecycle/status/expiry filtering happens in SQL (proven in T51/T53); here the DB returns [] for v1.
    const m = lifecycleMockConn({ secretRowsByVersion: { 1: [] } });
    expect(await createRunnerConnectorSecretStore(m.conn).findEncryptedSecret(idInput)).toBeNull();
    expect(auditActions(m.persistedAudits)).toEqual(["connector_secret.load.attempted", "connector_secret.load.succeeded"]);
  });
});

describe("connector-secret-store — LATEST-INTENT load: highest version first, then THAT version only, NO fallback", () => {
  it("highest active -> returns the highest version (queries max, then loads only the max)", async () => {
    const m = lifecycleMockConn({ maxVersion: 5, secretRowsByVersion: { 5: [await aSecretRow("sec-hi")] } });
    const found = await createRunnerConnectorSecretStore(m.conn).findLatestEncryptedSecret(idInput);
    expect(found!.id).toBe("sec-hi");
    expect(m.selectVersionsQueried).toEqual([5]); // only the highest version was loaded
  });

  it("highest REVOKED with a lower ACTIVE -> null, and NEVER queries the lower version (the load-bearing claim)", async () => {
    // max version 5 is excluded by the DB (revoked/tombstoned lifecycle event -> [] rows); v1 WOULD be loadable.
    const m = lifecycleMockConn({ maxVersion: 5, secretRowsByVersion: { 5: [], 1: [await aSecretRow("sec-low")] } });
    const found = await createRunnerConnectorSecretStore(m.conn).findLatestEncryptedSecret(idInput);
    expect(found).toBeNull();
    expect(m.selectVersionsQueried).toEqual([5]);          // only v5 was ever queried
    expect(m.selectVersionsQueried).not.toContain(1);      // NO fallback to the lower valid version
  });

  it("highest TOMBSTONED with a lower active -> null, no fallback", async () => {
    const m = lifecycleMockConn({ maxVersion: 7, secretRowsByVersion: { 7: [], 2: [await aSecretRow("sec-low")] } });
    expect(await createRunnerConnectorSecretStore(m.conn).findLatestEncryptedSecret(idInput)).toBeNull();
    expect(m.selectVersionsQueried).toEqual([7]);
  });

  it("highest EXPIRED with a lower valid -> null, no fallback", async () => {
    const m = lifecycleMockConn({ maxVersion: 9, secretRowsByVersion: { 9: [], 3: [await aSecretRow("sec-low")] } });
    expect(await createRunnerConnectorSecretStore(m.conn).findLatestEncryptedSecret(idInput)).toBeNull();
    expect(m.selectVersionsQueried).toEqual([9]);
  });

  it("all revoked (highest -> 0 rows) -> null", async () => {
    const m = lifecycleMockConn({ maxVersion: 4, secretRowsByVersion: { 4: [] } });
    expect(await createRunnerConnectorSecretStore(m.conn).findLatestEncryptedSecret(idInput)).toBeNull();
    expect(m.selectVersionsQueried).toEqual([4]);
  });

  it("no versions exist -> null, and no secret SELECT is issued", async () => {
    const m = lifecycleMockConn({ maxVersion: null });
    expect(await createRunnerConnectorSecretStore(m.conn).findLatestEncryptedSecret(idInput)).toBeNull();
    expect(m.selectVersionsQueried).toEqual([]);
    expect(auditActions(m.persistedAudits)).toEqual([]); // no secret loaded -> no load audit
  });

  it("the latest-intent audit records ONLY the highest version (never a lower one)", async () => {
    const m = lifecycleMockConn({ maxVersion: 5, secretRowsByVersion: { 5: [], 1: [await aSecretRow()] } });
    await createRunnerConnectorSecretStore(m.conn).findLatestEncryptedSecret(idInput);
    for (const a of m.persistedAudits) expect(a.after_json.version).toBe(5);
  });
});

// Static guard: server-only — imports only sibling modules; no db/supabase client, no service-role, no fetch,
// no process.env, no route. Runs as connector_runner via the runner connection only.
describe("connector-secret-store is server-safe (runner-only; no service-role/client/fetch/route/env)", () => {
  it("imports only sibling vault modules and contains no forbidden call/string", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const src = fs.readFileSync(path.resolve(__dirname, "connector-secret-store.ts"), "utf8");
    const imports = [...src.matchAll(/from\s+["']([^"']+)["']/g)].map((m) => m[1]).sort();
    expect(imports).toEqual(["./runner-db-client", "./secret-audit", "./secret-audit-writer", "./secret-vault"]);
    expect(src).toMatch(/server-only and must not be imported in client code/);
    expect(src).toMatch(/set role connector_runner/);
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
