import { describe, it, expect } from "vitest";
import {
  createOAuthPendingExecutor,
  OAuthPendingExecutorError,
  type RunnerDbClient,
} from "./oauth-pending-executor";
import {
  consumeOAuthPending,
  type OAuthPendingConsumeInput,
} from "./oauth-pending-consume";

const TENANT = "11111111-1111-1111-1111-111111111111";
const CONNECTOR = "17000000-0000-0000-0000-0000000000a1";
const NOW = 1_750_000_000_000;
const FUTURE = new Date(NOW + 600_000).toISOString();
const PAST = new Date(NOW - 1_000).toISOString();

type Row = {
  tenant_id: string;
  provider: string;
  connector_id: string | null;
  state_jti: string;
  nonce_hash: string;
  consumed_at: string | null;
  expires_at: string;
};

// In-memory mock RunnerDbClient (NO real DB, NO network, NO credentials). It GENUINELY models the two
// statements the executor issues: the atomic consume UPDATE (set consumed_at iff the row matches + is
// unconsumed + unexpired) and the read-only classify SELECT. Records the calls so a test can assert the
// SQL/param shape and that exactly one mutation is issued.
function makeRunnerClient(rows: Row[]): RunnerDbClient & { calls: { sql: string; params: readonly unknown[] }[]; byJti: Map<string, Row> } {
  const byJti = new Map(rows.map((r) => [r.state_jti, { ...r }]));
  const calls: { sql: string; params: readonly unknown[] }[] = [];
  return {
    calls,
    byJti,
    async run(sql, params) {
      calls.push({ sql, params });
      const s = sql.trim().toLowerCase();
      if (s.startsWith("update")) {
        const [nowIso, stateJti, nonceHash, tenantId, provider, connectorId] = params as string[];
        const r = byJti.get(stateJti);
        if (!r) return { rows: [] };
        const matches =
          r.nonce_hash === nonceHash &&
          r.tenant_id === tenantId &&
          r.provider === provider &&
          r.connector_id === (connectorId ?? null) &&
          r.consumed_at == null &&
          Date.parse(r.expires_at) > Date.parse(nowIso);
        if (!matches) return { rows: [] };
        r.consumed_at = nowIso; // single-use: mark consumed
        return { rows: [{ state_jti: r.state_jti, consumed_at: r.consumed_at }] };
      }
      // select (classify)
      const stateJti = (params as string[])[0];
      const r = byJti.get(stateJti);
      return {
        rows: r
          ? [{ tenant_id: r.tenant_id, provider: r.provider, connector_id: r.connector_id, nonce_hash: r.nonce_hash, consumed_at: r.consumed_at, expires_at: r.expires_at }]
          : [],
      };
    },
  };
}

function row(over: Partial<Row> = {}): Row {
  return { tenant_id: TENANT, provider: "github", connector_id: CONNECTOR, state_jti: "jti-1", nonce_hash: "nh-1", consumed_at: null, expires_at: FUTURE, ...over };
}
function input(over: Partial<OAuthPendingConsumeInput> = {}): OAuthPendingConsumeInput {
  return { tenantId: TENANT, provider: "github", connectorId: CONNECTOR, stateJti: "jti-1", nonceHash: "nh-1", now: NOW, ...over };
}

describe("createOAuthPendingExecutor — fail closed / config", () => {
  it("throws (typed) when the runner DB client is missing/invalid", () => {
    // @ts-expect-error — null client
    expect(() => createOAuthPendingExecutor(null)).toThrow(OAuthPendingExecutorError);
    // @ts-expect-error — no run()
    expect(() => createOAuthPendingExecutor({})).toThrow(OAuthPendingExecutorError);
  });
});

describe("executor.runAtomicConsume — the atomic UPDATE shape", () => {
  it("issues the consume UPDATE (set consumed_at, where unconsumed + unexpired) and returns the row", async () => {
    const client = makeRunnerClient([row()]);
    const ex = createOAuthPendingExecutor(client);
    const res = await ex.runAtomicConsume({ tenantId: TENANT, provider: "github", connectorId: CONNECTOR, stateJti: "jti-1", nonceHash: "nh-1", nowIso: new Date(NOW).toISOString() });
    expect(res).toEqual({ stateJti: "jti-1", consumedAt: new Date(NOW).toISOString() });
    expect(client.calls).toHaveLength(1);
    const sql = client.calls[0].sql.toLowerCase();
    expect(sql).toContain("update public.oauth_pending set consumed_at");
    expect(sql).toContain("consumed_at is null");
    expect(sql).toContain("expires_at > $1");
    expect(sql).toContain("connector_id is not distinct from $6"); // null-safe connector match
    // the consume sets ONLY consumed_at — never an identity column.
    expect(sql).not.toMatch(/set[^=]*tenant_id|set[^=]*state_jti|set[^=]*nonce_hash/);
    // the nonce HASH + ids are bound params (never inlined into the SQL text).
    expect(client.calls[0].params).toEqual([new Date(NOW).toISOString(), "jti-1", "nh-1", TENANT, "github", CONNECTOR]);
  });

  it("returns null when 0 rows changed (already-consumed / mismatch is classified by the caller)", async () => {
    const client = makeRunnerClient([row({ consumed_at: PAST })]);
    const ex = createOAuthPendingExecutor(client);
    expect(await ex.runAtomicConsume({ tenantId: TENANT, provider: "github", connectorId: CONNECTOR, stateJti: "jti-1", nonceHash: "nh-1", nowIso: new Date(NOW).toISOString() })).toBeNull();
  });
});

describe("executor.readPendingState — the classify SELECT", () => {
  it("reads the safe row state by state_jti (hash + ids + timestamps only)", async () => {
    const client = makeRunnerClient([row()]);
    const ex = createOAuthPendingExecutor(client);
    const st = await ex.readPendingState("jti-1");
    expect(st).toEqual({ tenantId: TENANT, provider: "github", connectorId: CONNECTOR, nonceHash: "nh-1", consumedAt: null, expiresAt: FUTURE });
    const sql = client.calls[0].sql.toLowerCase();
    expect(sql).toContain("select"); expect(sql).toContain("from public.oauth_pending where state_jti = $1");
  });

  it("returns null when no row matches the state_jti", async () => {
    const ex = createOAuthPendingExecutor(makeRunnerClient([]));
    expect(await ex.readPendingState("nope")).toBeNull();
  });
});

describe("full chain — consumeOAuthPending through the runner executor (mocked DB, no live call)", () => {
  it("consumes exactly once; a second consume fails closed (already_consumed)", async () => {
    const ex = createOAuthPendingExecutor(makeRunnerClient([row()]));
    expect((await consumeOAuthPending(input(), ex)).ok).toBe(true);
    expect(await consumeOAuthPending(input({ now: NOW + 1000 }), ex)).toEqual({ ok: false, reason: "already_consumed" });
  });

  it("a fresh-connect (null connector) row consumes on a null input", async () => {
    const ex = createOAuthPendingExecutor(makeRunnerClient([row({ connector_id: null })]));
    expect((await consumeOAuthPending(input({ connectorId: null }), ex)).ok).toBe(true);
  });

  it("every failure case maps to its safe reason via the executor's classify read", async () => {
    expect(await consumeOAuthPending(input(), createOAuthPendingExecutor(makeRunnerClient([])))).toEqual({ ok: false, reason: "not_found" });
    expect(await consumeOAuthPending(input(), createOAuthPendingExecutor(makeRunnerClient([row({ expires_at: PAST })])))).toEqual({ ok: false, reason: "expired" });
    expect(await consumeOAuthPending(input(), createOAuthPendingExecutor(makeRunnerClient([row({ consumed_at: PAST })])))).toEqual({ ok: false, reason: "already_consumed" });
    expect(await consumeOAuthPending(input(), createOAuthPendingExecutor(makeRunnerClient([row({ tenant_id: "22222222-2222-2222-2222-222222222222" })])))).toEqual({ ok: false, reason: "tenant_mismatch" });
    expect(await consumeOAuthPending(input(), createOAuthPendingExecutor(makeRunnerClient([row({ provider: "slack" })])))).toEqual({ ok: false, reason: "provider_mismatch" });
    expect(await consumeOAuthPending(input(), createOAuthPendingExecutor(makeRunnerClient([row({ connector_id: "17000000-0000-0000-0000-0000000000b1" })])))).toEqual({ ok: false, reason: "connector_mismatch" });
    expect(await consumeOAuthPending(input(), createOAuthPendingExecutor(makeRunnerClient([row({ nonce_hash: "OTHER" })])))).toEqual({ ok: false, reason: "nonce_mismatch" });
  });
});

describe("executor — redacted errors (no raw value / DB body surfaces)", () => {
  it("a DB error on the consume is redacted (no raw error / nonce / state in the message)", async () => {
    const failing: RunnerDbClient = {
      async run() {
        throw new Error("RAW-DB-ERROR-leaking-nh-1-and-jti-1-and-secrets");
      },
    };
    const ex = createOAuthPendingExecutor(failing);
    let m = "";
    try {
      await ex.runAtomicConsume({ tenantId: TENANT, provider: "github", connectorId: CONNECTOR, stateJti: "jti-1", nonceHash: "nh-1", nowIso: new Date(NOW).toISOString() });
    } catch (e) {
      m = (e as Error).message;
    }
    expect(m).toBe("oauth_pending consume failed");
    expect(m).not.toContain("RAW-DB-ERROR");
    expect(m).not.toContain("nh-1");
    expect(m).not.toContain("jti-1");
  });

  it("a DB error on the classify read is redacted", async () => {
    const failing: RunnerDbClient = { async run() { throw new Error("RAW-DB-READ-ERROR"); } };
    const ex = createOAuthPendingExecutor(failing);
    await expect(ex.readPendingState("jti-1")).rejects.toThrow("oauth_pending read failed");
  });
});

// Static guards: the executor is pure server-only (only the ./oauth-pending-consume TYPES; no DB/Supabase/
// service-role/connector_secrets/token/provider-connector), and the OAuth callback route is still inert.
describe("oauth-pending-executor module is server-only + scoped (no DB/Supabase/service-role/connector_secrets/token)", () => {
  it("imports only the consume types; no forbidden call/string", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const src = fs.readFileSync(path.resolve(__dirname, "oauth-pending-executor.ts"), "utf8");
    const imports = [...src.matchAll(/from\s+["']([^"']+)["']/g)].map((m) => m[1]);
    expect(imports).toEqual(["./oauth-pending-consume"]); // a type-only sibling import (erased at runtime)
    expect(src).toMatch(/import type \{/);
    const code = src.replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
    expect(code).not.toMatch(/createClient\s*\(/);
    expect(code).not.toMatch(/process\.env/);
    expect(code).not.toMatch(/\bfetch\s*\(/);
    const secretsTable = ["connector", "secrets"].join("_");
    expect(code).not.toContain(secretsTable);
    const forbidden = ["service", "role"].join("_");
    expect(code).not.toContain(forbidden);
    for (const tok of ["access_token", "refresh_token", "token_endpoint", "grant_type", "@supabase"]) {
      expect(code).not.toContain(tok);
    }
  });

  it("the OAuth callback route is still inert — no token exchange, no executor import", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const route = fs.readFileSync(
      path.resolve(__dirname, "..", "..", "..", "app", "(authenticated)", "connectors", "oauth", "callback", "route.ts"),
      "utf8",
    );
    const code = route.replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
    expect(code).not.toMatch(/\bfetch\s*\(/);
    expect(code).not.toContain("oauth-pending-executor"); // the route does NOT call the runner executor
    for (const bad of [["connector", "secrets"].join("_"), "access_token", "refresh_token", "token_endpoint", "grant_type"]) {
      expect(code).not.toContain(bad);
    }
  });
});
