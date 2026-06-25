import { describe, it, expect } from "vitest";
import {
  createRunnerDbClient,
  createRunnerPendingInserter,
  createRunnerOAuthPendingConsumer,
  RunnerDbError,
  type RunnerConnection,
} from "./runner-db-client";
import { persistSlackAuthorizePending } from "./providers/slack-authorize-pending";
import { consumeOAuthPending, type OAuthPendingConsumeInput } from "./oauth-pending-consume";
import type { OAuthPendingInsertRow } from "./providers/slack-authorize-pending";

const TENANT = "aaaa1111-1111-1111-1111-111111111111";
const ORG = "bbbb2222-2222-2222-2222-222222222222";
const SUBJECT = "cccc3333-3333-3333-3333-333333333333";
const NOW = 1_750_000_000_000;
const FUTURE_ISO = new Date(NOW + 600_000).toISOString();

function row(over: Partial<OAuthPendingInsertRow> = {}): OAuthPendingInsertRow {
  return { tenantId: TENANT, organizationId: ORG, provider: "slack", connectorId: null, subject: SUBJECT, stateJti: "jti-1", nonceHash: "nh-1", intent: "connect", expiresAt: FUTURE_ISO, ...over };
}

// A recording mock RunnerConnection (NO real DB, NO network, NO credentials). By default it records every
// statement sequence and returns empty rows. Tests pass a custom `behave` to model real semantics.
type Stmt = { sql: string; params: readonly unknown[] };
function makeConn(behave?: (stmts: Stmt[]) => Array<{ rows: ReadonlyArray<Record<string, unknown>> }>): RunnerConnection & { calls: Stmt[][] } {
  const calls: Stmt[][] = [];
  return {
    calls,
    async runSequence(statements) {
      const stmts = statements.map((s) => ({ sql: s.sql, params: s.params }));
      calls.push(stmts);
      return behave ? behave(stmts) : statements.map(() => ({ rows: [] }));
    },
  };
}

describe("createRunnerPendingInserter — authorize-time INSERT via the runner connection", () => {
  it("SET ROLE connector_runner, then a parameterized INSERT of ONLY the 9 allowed columns", async () => {
    const conn = makeConn();
    const res = await createRunnerPendingInserter(conn).insertPending(row());
    expect(res).toEqual({ ok: true });
    expect(conn.calls).toHaveLength(1);
    const [setRole, insert] = conn.calls[0];
    // SET ROLE is issued before the operation
    expect(setRole.sql).toBe("set role connector_runner");
    const sql = insert.sql.toLowerCase();
    expect(sql).toContain("insert into public.oauth_pending");
    // exactly the 9 authorize-time columns, in order, as bound params
    expect(sql).toContain("(tenant_id, organization_id, connector_id, provider, subject, state_jti, nonce_hash, intent, expires_at)");
    expect(insert.params).toEqual([TENANT, ORG, null, "slack", SUBJECT, "jti-1", "nh-1", "connect", FUTURE_ISO]);
    // NEVER the consume/counter columns
    for (const forbidden of ["consumed_at", "attempt_count", "last_rejected_code"]) {
      expect(sql).not.toContain(forbidden);
    }
  });

  it("fails closed on a duplicate (UNIQUE violation → reason 'duplicate'), no raw error surfaced", async () => {
    const conn = makeConn(() => { throw Object.assign(new Error("duplicate key value violates unique constraint"), { code: "23505" }); });
    expect(await createRunnerPendingInserter(conn).insertPending(row())).toEqual({ ok: false, reason: "duplicate" });
  });

  it("redacts a DB error to reason 'db_error' (never the raw error/value)", async () => {
    const conn = makeConn(() => { throw new Error("RAW-DB-ERROR-leaking-nh-1-and-secrets"); });
    const res = await createRunnerPendingInserter(conn).insertPending(row());
    expect(res).toEqual({ ok: false, reason: "db_error" });
    expect(JSON.stringify(res)).not.toContain("RAW-DB-ERROR");
    expect(JSON.stringify(res)).not.toContain("nh-1");
  });

  it("fails closed (typed throw) on a missing/invalid runner connection", () => {
    // @ts-expect-error — null connection
    expect(() => createRunnerPendingInserter(null)).toThrow(RunnerDbError);
    // @ts-expect-error — no runSequence
    expect(() => createRunnerPendingInserter({})).toThrow(RunnerDbError);
  });
});

describe("createRunnerDbClient — SET ROLE wrapping + redaction", () => {
  it("prepends SET ROLE connector_runner and returns the last statement's rows", async () => {
    const conn = makeConn((stmts) => stmts.map((s, i) => ({ rows: i === stmts.length - 1 ? [{ ok: 1 }] : [] })));
    const res = await createRunnerDbClient(conn).run("select 1", []);
    expect(res.rows).toEqual([{ ok: 1 }]);
    expect(conn.calls[0][0].sql).toBe("set role connector_runner");
    expect(conn.calls[0][1].sql).toBe("select 1");
  });

  it("redacts a DB error to a fixed RunnerDbError message", async () => {
    const conn = makeConn(() => { throw new Error("RAW-CONN-ERROR-with-password"); });
    await expect(createRunnerDbClient(conn).run("select 1", [])).rejects.toThrow("runner db operation failed");
    await expect(createRunnerDbClient(conn).run("select 1", [])).rejects.toBeInstanceOf(RunnerDbError);
  });

  it("fails closed on a missing connection", () => {
    // @ts-expect-error — null
    expect(() => createRunnerDbClient(null)).toThrow(RunnerDbError);
  });
});

// In-memory oauth_pending modeled at the runSequence level — set role is a no-op; INSERT enforces
// UNIQUE(state_jti)/UNIQUE(nonce_hash); the §38 consume UPDATE + the classify SELECT behave like the real
// runner path. Proves the FULL authorize-persist -> callback-consume wiring through the runner client.
function makeInMemoryConn(): RunnerConnection & { rows: Map<string, Record<string, unknown>> } {
  const rows = new Map<string, Record<string, unknown>>();
  const nonces = new Set<string>();
  return {
    rows,
    async runSequence(statements) {
      const out: Array<{ rows: ReadonlyArray<Record<string, unknown>> }> = [];
      for (const st of statements) {
        const sql = st.sql.trim().toLowerCase();
        const p = st.params as unknown[];
        if (sql.startsWith("set role")) { out.push({ rows: [] }); continue; }
        if (sql.startsWith("insert into public.oauth_pending")) {
          const [tenant_id, organization_id, connector_id, provider, subject, state_jti, nonce_hash, intent, expires_at] = p as (string | null)[];
          if (rows.has(state_jti as string) || nonces.has(nonce_hash as string))
            throw Object.assign(new Error("duplicate key"), { code: "23505" });
          rows.set(state_jti as string, { tenant_id, organization_id, connector_id, provider, subject, state_jti, nonce_hash, intent, expires_at, consumed_at: null });
          nonces.add(nonce_hash as string);
          out.push({ rows: [] });
        } else if (sql.startsWith("update public.oauth_pending set consumed_at")) {
          // params: [nowIso, stateJti, nonceHash, tenantId, provider, connectorId]
          const [nowIso, stateJti, nonceHash, tenantId, provider, connectorId] = p as (string | null)[];
          const r = rows.get(stateJti as string);
          const matches = r && r.nonce_hash === nonceHash && r.tenant_id === tenantId && r.provider === provider &&
            r.connector_id === (connectorId ?? null) && r.consumed_at == null && Date.parse(r.expires_at as string) > Date.parse(nowIso as string);
          if (!matches) { out.push({ rows: [] }); continue; }
          r!.consumed_at = nowIso;
          out.push({ rows: [{ state_jti: r!.state_jti, consumed_at: r!.consumed_at }] });
        } else if (sql.startsWith("select") && sql.includes("from public.oauth_pending where state_jti")) {
          const r = rows.get((p as string[])[0]);
          out.push({ rows: r ? [{ tenant_id: r.tenant_id, provider: r.provider, connector_id: r.connector_id, nonce_hash: r.nonce_hash, consumed_at: r.consumed_at, expires_at: r.expires_at }] : [] });
        } else {
          out.push({ rows: [] });
        }
      }
      return out;
    },
  };
}

describe("full wiring — Slack authorize persist -> callback consume through the runner client", () => {
  const signer = { keyId: "k1", sign: (m: string) => Buffer.from(`sig:${m}`) };
  function consumeInput(stateJti: string, nonceHash: string, over: Partial<OAuthPendingConsumeInput> = {}): OAuthPendingConsumeInput {
    return { tenantId: TENANT, provider: "slack", connectorId: null, stateJti, nonceHash, now: NOW + 1000, ...over };
  }

  it("persists the authorize row, then the runner consumer consumes it exactly once", async () => {
    const conn = makeInMemoryConn();
    const persist = await persistSlackAuthorizePending(
      { tenantId: TENANT, organizationId: ORG, subject: SUBJECT, correlationId: "corr-auth-test", clientId: "11111.22222", redirectUri: "https://app.example.com/cb", signer, now: NOW, nonce: "nonce-A" },
      createRunnerPendingInserter(conn),
    );
    expect(persist.ok).toBe(true);
    expect(conn.rows.size).toBe(1);
    if (!persist.ok) return;

    // derive the consume keys the persisted row carries (stateJti = sha256(state), nonceHash = sha256(nonce))
    const { createHash } = await import("node:crypto");
    const persistedJti = persist.stateJti;
    const nonceHash = createHash("sha256").update("nonce-A", "utf8").digest("hex");

    const consumer = createRunnerOAuthPendingConsumer(conn);
    const first = await consumeOAuthPending(consumeInput(persistedJti, nonceHash), consumer);
    expect(first.ok).toBe(true);
    const second = await consumeOAuthPending(consumeInput(persistedJti, nonceHash), consumer);
    expect(second).toEqual({ ok: false, reason: "already_consumed" });
  });

  it("a duplicate authorize persist (same nonce) fails closed", async () => {
    const conn = makeInMemoryConn();
    const inserter = createRunnerPendingInserter(conn);
    const args = { tenantId: TENANT, organizationId: ORG, subject: SUBJECT, correlationId: "corr-auth-test", clientId: "11111.22222", redirectUri: "https://app.example.com/cb", signer, now: NOW, nonce: "dup" } as const;
    expect((await persistSlackAuthorizePending(args, inserter)).ok).toBe(true);
    expect(await persistSlackAuthorizePending(args, inserter)).toEqual({ ok: false, reason: "duplicate_pending" });
    expect(conn.rows.size).toBe(1);
  });

  it("the runner consumer issues SET ROLE connector_runner before consuming", async () => {
    const conn = makeInMemoryConn();
    await persistSlackAuthorizePending(
      { tenantId: TENANT, organizationId: ORG, subject: SUBJECT, correlationId: "corr-auth-test", clientId: "c", redirectUri: "https://app.example.com/cb", signer, now: NOW, nonce: "n2" },
      createRunnerPendingInserter(conn),
    );
    // spy on the raw sequences by wrapping
    const seqs: string[][] = [];
    const spy: RunnerConnection = { runSequence: (s) => { seqs.push(s.map((x) => x.sql.trim().toLowerCase())); return conn.runSequence(s); } };
    const { createHash } = await import("node:crypto");
    await consumeOAuthPending({ tenantId: TENANT, provider: "slack", connectorId: null, stateJti: "ignored", nonceHash: createHash("sha256").update("n2").digest("hex"), now: NOW + 1000 }, createRunnerOAuthPendingConsumer(spy));
    // every runner sequence starts with the SET ROLE statement
    expect(seqs.length).toBeGreaterThan(0);
    for (const seq of seqs) expect(seq[0]).toBe("set role connector_runner");
  });
});

describe("provider registry still marks Slack non-functional (this wiring does not flip it)", () => {
  it("Slack stays an inert skeleton", async () => {
    const { getConnectorProvider } = await import("./provider-registry");
    expect(getConnectorProvider("slack")?.status).toBe("skeleton");
    expect(getConnectorProvider("slack")?.enabled).toBe(false);
  });
});

// Static guards: server-only, no service-role/DB-driver/Slack-API/connector_secrets/token/KMS, no client import.
describe("runner-db-client module is server-only + scoped", () => {
  it("imports only its server-only siblings; no forbidden call/string", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const src = fs.readFileSync(path.resolve(__dirname, "runner-db-client.ts"), "utf8");
    const imports = [...src.matchAll(/from\s+["']([^"']+)["']/g)].map((m) => m[1]).sort();
    expect(imports).toEqual(["./oauth-pending-consume", "./oauth-pending-executor", "./providers/slack-authorize-pending"].sort());
    const code = src.replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
    expect(code).not.toMatch(/\bfetch\s*\(/); // no Slack API / no token endpoint
    expect(code).not.toMatch(/createClient\s*\(/); // no global service-role / supabase client
    expect(code).not.toMatch(/process\.env/);
    const secretsTable = ["connector", "secrets"].join("_");
    expect(code).not.toContain(secretsTable);
    const serviceRole = ["service", "role"].join("_");
    expect(code).not.toContain(serviceRole);
    for (const tok of ["oauth.v2.access", "access_token", "refresh_token", "client_secret", "grant_type", "GenerateDataKey", "Decrypt", "@supabase", "from \"pg\"", "require('pg')"]) {
      expect(code).not.toContain(tok);
    }
    // it only ever names oauth_pending (never connector_secrets / connectors / connector_runs)
    expect(code).toContain("public.oauth_pending");
  });

  it("the OAuth callback route is still inert — no token exchange, no runner-db-client import", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const route = fs.readFileSync(
      path.resolve(__dirname, "..", "..", "..", "app", "(authenticated)", "connectors", "oauth", "callback", "route.ts"),
      "utf8",
    );
    const code = route.replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
    expect(code).not.toMatch(/\bfetch\s*\(/);
    expect(code).not.toContain("runner-db-client");
    for (const bad of [["connector", "secrets"].join("_"), "access_token", "refresh_token", "oauth.v2.access", "grant_type"]) {
      expect(code).not.toContain(bad);
    }
  });
});
