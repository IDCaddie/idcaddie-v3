import { describe, it, expect } from "vitest";
import {
  createRunnerConnectorSecretLifecycleWriter,
  ConnectorSecretLifecycleError,
  LIFECYCLE_WRITE_SQL,
} from "./connector-secret-lifecycle";
import type { RunnerConnection } from "./runner-db-client";

const TENANT = "11111111-1111-1111-1111-111111111111";
const CONNECTOR = "22222222-2222-2222-2222-222222222222";
const KIND = "oauth_access";
const target = (over: Record<string, unknown> = {}) => ({ tenantId: TENANT, connectorId: CONNECTOR, dbSecretKind: KIND, version: 1, ...over });

type Stmt = { sql: string; params: readonly unknown[] };
type LifecycleRow = { version: unknown; lifecycle_event_type: unknown; reason_class: unknown; actor_type: unknown };
type AuditRow = { tenant_id: unknown; action: string; resource_type: unknown; after_json: Record<string, unknown> };

// A mock RunnerConnection that models the single ATOMIC CTE (LIFECYCLE_WRITE_SQL): a version in `existing` ->
// lifecycle row + attempted + succeeded (lifecycle_inserted=1); a version NOT in `existing` -> attempted + failed,
// NO lifecycle row (lifecycle_inserted=0). `failCte` makes the whole statement throw (nothing persists — atomic).
function lifecycleMockConn(opts: { existing?: Set<number>; failCte?: boolean } = {}) {
  const existing = opts.existing ?? new Set<number>([1]);
  const allStatements: Stmt[] = [];
  const persistedLifecycle: LifecycleRow[] = [];
  const persistedAudits: AuditRow[] = [];
  const conn: RunnerConnection = {
    async runSequence(statements) {
      for (const s of statements) allStatements.push({ sql: s.sql, params: s.params });
      const results: { rows: ReadonlyArray<Record<string, unknown>> }[] = [];
      for (const s of statements) {
        if (/^\s*set\s+role/i.test(s.sql)) { results.push({ rows: [] }); continue; }
        if (/^with\s+ins_lifecycle\s+as/i.test(s.sql)) {
          if (opts.failCte) throw new Error("forced CTE failure"); // atomic: nothing persists
          const p = s.params;
          const version = p[3] as number;
          const exists = existing.has(version);
          const audit = (action: unknown, json: unknown): AuditRow => ({ tenant_id: p[0], action: String(action), resource_type: p[8], after_json: JSON.parse(String(json)) });
          persistedAudits.push(audit(p[9], p[10])); // attempted — UNCONDITIONAL
          if (exists) {
            persistedLifecycle.push({ version, lifecycle_event_type: p[4], reason_class: p[5], actor_type: p[6] });
            persistedAudits.push(audit(p[11], p[12])); // succeeded
          } else {
            persistedAudits.push(audit(p[13], p[14])); // failed (target_not_found)
          }
          results.push({ rows: [{ lifecycle_inserted: exists ? 1 : 0 }] });
          continue;
        }
        results.push({ rows: [] });
      }
      return results;
    },
  };
  return { conn, allStatements, persistedLifecycle, persistedAudits };
}

const actions = (a: AuditRow[]) => a.map((x) => x.action);
const terminalCount = (a: AuditRow[], op: string) => a.filter((x) => x.action === `connector_secret.${op}.succeeded` || x.action === `connector_secret.${op}.failed`).length;
const hasMutation = (s: Stmt[]) => s.some((x) => /update\s+public\.|delete\s+from\s+public\./i.test(x.sql));

describe("connector-secret-lifecycle — EXISTING target: attempted + succeeded, exactly one terminal, no failed", () => {
  it("revoke existing -> { ok }, commits lifecycle row + attempted + succeeded (no failed)", async () => {
    const m = lifecycleMockConn({ existing: new Set([1]) });
    expect(await createRunnerConnectorSecretLifecycleWriter(m.conn).revoke(target({ reasonClass: "compromised" }))).toEqual({ ok: true });
    expect(m.persistedLifecycle).toHaveLength(1);
    expect(m.persistedLifecycle[0]).toMatchObject({ version: 1, lifecycle_event_type: "revoked", reason_class: "compromised", actor_type: "connector_runner" });
    expect(actions(m.persistedAudits)).toEqual(["connector_secret.revocation.attempted", "connector_secret.revocation.succeeded"]);
    expect(terminalCount(m.persistedAudits, "revocation")).toBe(1); // EXACTLY one terminal
    expect(hasMutation(m.allStatements)).toBe(false);
  });

  it("tombstone existing -> { ok }, commits lifecycle row + attempted + succeeded (no failed)", async () => {
    const m = lifecycleMockConn({ existing: new Set([2]) });
    expect(await createRunnerConnectorSecretLifecycleWriter(m.conn).tombstone(target({ version: 2 }))).toEqual({ ok: true });
    expect(m.persistedLifecycle[0]).toMatchObject({ version: 2, lifecycle_event_type: "tombstoned" });
    expect(actions(m.persistedAudits)).toEqual(["connector_secret.tombstone.attempted", "connector_secret.tombstone.succeeded"]);
    expect(terminalCount(m.persistedAudits, "tombstone")).toBe(1);
  });
});

describe("connector-secret-lifecycle — NONEXISTENT target: EXPLICIT FAILURE; attempted + failed; no lifecycle, no succeeded", () => {
  it("revoke nonexistent THROWS (never { ok }); commits attempted + failed(target_not_found); NO lifecycle, NO succeeded", async () => {
    const m = lifecycleMockConn({ existing: new Set([]) }); // version 1 does not exist
    let returned: unknown = "SENTINEL";
    await expect((async () => { returned = await createRunnerConnectorSecretLifecycleWriter(m.conn).revoke(target()); })()).rejects.toBeInstanceOf(ConnectorSecretLifecycleError);
    expect(returned).toBe("SENTINEL"); // the caller NEVER received { ok }
    expect(m.persistedLifecycle).toHaveLength(0); // NO lifecycle row (orphan prevented)
    expect(actions(m.persistedAudits)).toEqual(["connector_secret.revocation.attempted", "connector_secret.revocation.failed"]);
    expect(m.persistedAudits.find((a) => a.action.endsWith(".failed"))!.after_json.error_class).toBe("target_not_found");
    expect(actions(m.persistedAudits)).not.toContain("connector_secret.revocation.succeeded"); // NO succeeded
    expect(terminalCount(m.persistedAudits, "revocation")).toBe(1); // EXACTLY one terminal (failed)
  });

  it("tombstone nonexistent THROWS; commits attempted + failed(target_not_found); NO lifecycle, NO succeeded", async () => {
    const m = lifecycleMockConn({ existing: new Set([]) });
    await expect(createRunnerConnectorSecretLifecycleWriter(m.conn).tombstone(target())).rejects.toBeInstanceOf(ConnectorSecretLifecycleError);
    expect(m.persistedLifecycle).toHaveLength(0);
    expect(actions(m.persistedAudits)).toEqual(["connector_secret.tombstone.attempted", "connector_secret.tombstone.failed"]);
    expect(m.persistedAudits.find((a) => a.action.endsWith(".failed"))!.after_json.error_class).toBe("target_not_found");
    expect(terminalCount(m.persistedAudits, "tombstone")).toBe(1);
  });

  it("the failed audit carries NO secret/envelope/key material (only the #166 allowlist + target_not_found)", async () => {
    const m = lifecycleMockConn({ existing: new Set([]) });
    await createRunnerConnectorSecretLifecycleWriter(m.conn).revoke(target()).catch(() => {});
    const json = JSON.stringify(m.persistedAudits);
    for (const bad of ["ciphertext", "dek", "wrapped", "aead", "nonce", "plaintext", "token", "kek"]) expect(json.toLowerCase()).not.toContain(bad);
    for (const a of m.persistedAudits) for (const k of Object.keys(a.after_json)) expect(["event", "connector_id", "secret_kind", "version", "result", "actor_type", "error_class", "correlation_id"]).toContain(k);
  });
});

describe("connector-secret-lifecycle — fail closed on a DB error (single atomic statement)", () => {
  it("a forced statement failure THROWS and commits NOTHING (no lifecycle row, no audit row, no compensating delete)", async () => {
    const m = lifecycleMockConn({ existing: new Set([1]), failCte: true });
    await expect(createRunnerConnectorSecretLifecycleWriter(m.conn).revoke(target())).rejects.toBeInstanceOf(ConnectorSecretLifecycleError);
    expect(m.persistedLifecycle).toHaveLength(0);
    expect(m.persistedAudits).toHaveLength(0);
    expect(hasMutation(m.allStatements)).toBe(false);
  });

  it("a thrown error carries a redacted static message — no secret material", async () => {
    const m = lifecycleMockConn({ failCte: true });
    try {
      await createRunnerConnectorSecretLifecycleWriter(m.conn).revoke(target());
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(ConnectorSecretLifecycleError);
      for (const bad of ["plaintext", "ciphertext", "dek", "token", "kek"]) expect(String((e as Error).message).toLowerCase()).not.toContain(bad);
    }
  });
});

describe("connector-secret-lifecycle — SQL is single-source-of-truth, append-only, scoped", () => {
  it("succeeded/failed derive from the lifecycle INSERT (ins_lifecycle), not a second independent EXISTS", () => {
    expect(LIFECYCLE_WRITE_SQL).toContain("with ins_lifecycle as");
    expect(LIFECYCLE_WRITE_SQL).toContain("returning version"); // the single source of truth
    // succeeded fires iff the lifecycle insert produced a row; failed iff it did not — both reference ins_lifecycle.
    expect(LIFECYCLE_WRITE_SQL).toContain("where exists (select 1 from ins_lifecycle)");
    expect(LIFECYCLE_WRITE_SQL).toContain("where not exists (select 1 from ins_lifecycle)");
    // the lifecycle insert is the ONLY existence check against connector_secrets.
    expect((LIFECYCLE_WRITE_SQL.match(/from public\.connector_secrets/g) ?? [])).toHaveLength(1);
    // attempted audit is UNCONDITIONAL (a plain values insert, not gated on existence).
    expect(LIFECYCLE_WRITE_SQL).toContain("values ($1, $10, $9, $11::jsonb)");
  });

  it("the lifecycle INSERT names only the eight 0033-granted safe columns; no UPDATE/DELETE/TRUNCATE; no id/created_at/audit_log_id", () => {
    expect(LIFECYCLE_WRITE_SQL).toContain("(tenant_id, connector_id, secret_kind, version, lifecycle_event_type, reason_class, actor_type, correlation_id)");
    expect(LIFECYCLE_WRITE_SQL).not.toMatch(/\(id,/);
    for (const bad of ["created_at", "audit_log_id"]) expect(LIFECYCLE_WRITE_SQL).not.toContain(bad);
    for (const bad of ["update ", "delete ", "truncate"]) expect(LIFECYCLE_WRITE_SQL.toLowerCase()).not.toContain(bad);
  });

  it("only revoke/tombstone events are ever emitted (no rotation/decrypt/store/load/update/delete event)", async () => {
    const m = lifecycleMockConn({ existing: new Set([1]) });
    const w = createRunnerConnectorSecretLifecycleWriter(m.conn);
    await w.revoke(target());
    await w.tombstone(target());
    for (const a of m.persistedAudits) expect(/^connector_secret\.(revocation|tombstone)\.(attempted|succeeded|failed)$/.test(a.action)).toBe(true);
    for (const bad of ["rotation", "decrypt", ".store.", ".load.", ".update.", ".delete."]) expect(actions(m.persistedAudits).join(" ")).not.toContain(bad);
  });
});

// Static guard: server-only — imports only sibling modules; no db/supabase client, no service-role, no fetch,
// no process.env, no route, no rotation/unrevoke. Returns no secret.
describe("connector-secret-lifecycle is server-safe (runner-only; no service-role/client/fetch/route/env/rotation)", () => {
  it("imports only sibling vault modules and contains no forbidden call/string", async () => {
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const src = readFileSync(fileURLToPath(new URL("./connector-secret-lifecycle.ts", import.meta.url)), "utf8");
    const imports = [...src.matchAll(/from\s+["']([^"']+)["']/g)].map((m) => m[1]).sort();
    expect(imports).toEqual(["./runner-db-client", "./secret-audit", "./secret-audit-writer"]);
    expect(src).toMatch(/server-only and must not be imported in client code/);
    expect(src).toMatch(/set role connector_runner/);
    const code = src.replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
    for (const bad of ["createClient", "@supabase", "@aws-sdk", "pg.Client", "new Client(", "fetch(", "process.env", ["service", "role", "key"].join("_"), "NextRequest", "NextResponse", "rotation", "unrevoke", "reactivate"]) {
      expect(code).not.toContain(bad);
    }
  });
});
