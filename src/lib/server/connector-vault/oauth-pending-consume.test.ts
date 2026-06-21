import { describe, it, expect } from "vitest";
import {
  consumeOAuthPending,
  OAuthPendingConsumeError,
  type OAuthPendingConsumer,
  type OAuthPendingConsumeInput,
} from "./oauth-pending-consume";

const TENANT = "11111111-1111-1111-1111-111111111111";
const CONNECTOR = "17000000-0000-0000-0000-0000000000a1";
const NOW = 1_750_000_000_000;
const FUTURE = new Date(NOW + 600_000).toISOString(); // +10 min
const PAST = new Date(NOW - 1_000).toISOString();

type Row = {
  tenantId: string;
  provider: string;
  connectorId: string | null;
  stateJti: string;
  nonceHash: string;
  consumedAt: string | null;
  expiresAt: string;
};

// In-memory fake that GENUINELY enforces the atomic single-use semantics (the WHERE: all identity match +
// consumed_at IS NULL + expires_at > now → set consumed_at, return the row; else null) and a read-only
// classify lookup. Tracks `atomicCalls` so a test can prove the consume issues exactly one atomic mutation.
function makeFakeConsumer(rows: Row[]): OAuthPendingConsumer & { atomicCalls: number; rowsByJti: Map<string, Row> } {
  const byJti = new Map(rows.map((r) => [r.stateJti, { ...r }]));
  const state = { atomicCalls: 0 };
  return {
    get atomicCalls() {
      return state.atomicCalls;
    },
    rowsByJti: byJti,
    async runAtomicConsume(p) {
      state.atomicCalls++;
      const r = byJti.get(p.stateJti);
      if (!r) return null;
      const now = Date.parse(p.nowIso);
      if (
        r.tenantId !== p.tenantId ||
        r.provider !== p.provider ||
        r.connectorId !== p.connectorId ||
        r.nonceHash !== p.nonceHash ||
        r.consumedAt != null ||
        !(Date.parse(r.expiresAt) > now)
      ) {
        return null; // the atomic UPDATE changed 0 rows
      }
      r.consumedAt = p.nowIso; // single-use: mark consumed
      return { stateJti: r.stateJti, consumedAt: r.consumedAt };
    },
    async readPendingState(jti) {
      const r = byJti.get(jti);
      return r
        ? { tenantId: r.tenantId, provider: r.provider, connectorId: r.connectorId, nonceHash: r.nonceHash, consumedAt: r.consumedAt, expiresAt: r.expiresAt }
        : null;
    },
  };
}

function row(over: Partial<Row> = {}): Row {
  return { tenantId: TENANT, provider: "github", connectorId: CONNECTOR, stateJti: "jti-1", nonceHash: "nh-1", consumedAt: null, expiresAt: FUTURE, ...over };
}
function input(over: Partial<OAuthPendingConsumeInput> = {}): OAuthPendingConsumeInput {
  return { tenantId: TENANT, provider: "github", connectorId: CONNECTOR, stateJti: "jti-1", nonceHash: "nh-1", now: NOW, ...over };
}

describe("consumeOAuthPending — atomic single-use", () => {
  it("consumes exactly one matching pending row (and issues exactly one atomic mutation)", async () => {
    const c = makeFakeConsumer([row()]);
    const res = await consumeOAuthPending(input(), c);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.consumed.stateJti).toBe("jti-1");
      expect(res.consumed.consumedAt).toBeTruthy();
    }
    expect(c.atomicCalls).toBe(1);
    expect(c.rowsByJti.get("jti-1")!.consumedAt).not.toBeNull(); // the row is now consumed
  });

  it("a second consume of the same state fails closed (already_consumed — single-use)", async () => {
    const c = makeFakeConsumer([row()]);
    expect((await consumeOAuthPending(input(), c)).ok).toBe(true);
    const second = await consumeOAuthPending(input({ now: NOW + 1000 }), c);
    expect(second).toEqual({ ok: false, reason: "already_consumed" });
  });

  it("a fresh-connect row (connector_id null) consumes when input connectorId is null", async () => {
    const c = makeFakeConsumer([row({ connectorId: null })]);
    const res = await consumeOAuthPending(input({ connectorId: null }), c);
    expect(res.ok).toBe(true);
  });
});

describe("consumeOAuthPending — failure cases (safe reason codes)", () => {
  it("missing row → not_found", async () => {
    const c = makeFakeConsumer([]);
    expect(await consumeOAuthPending(input(), c)).toEqual({ ok: false, reason: "not_found" });
  });

  it("expired → expired", async () => {
    const c = makeFakeConsumer([row({ expiresAt: PAST })]);
    expect(await consumeOAuthPending(input(), c)).toEqual({ ok: false, reason: "expired" });
  });

  it("already consumed → already_consumed", async () => {
    const c = makeFakeConsumer([row({ consumedAt: PAST })]);
    expect(await consumeOAuthPending(input(), c)).toEqual({ ok: false, reason: "already_consumed" });
  });

  it("wrong tenant → tenant_mismatch", async () => {
    const c = makeFakeConsumer([row({ tenantId: "22222222-2222-2222-2222-222222222222" })]);
    expect(await consumeOAuthPending(input(), c)).toEqual({ ok: false, reason: "tenant_mismatch" });
  });

  it("wrong provider → provider_mismatch", async () => {
    const c = makeFakeConsumer([row({ provider: "slack" })]);
    expect(await consumeOAuthPending(input(), c)).toEqual({ ok: false, reason: "provider_mismatch" });
  });

  it("wrong connector (when connector_id is present) → connector_mismatch", async () => {
    const c = makeFakeConsumer([row({ connectorId: "17000000-0000-0000-0000-0000000000b1" })]);
    expect(await consumeOAuthPending(input(), c)).toEqual({ ok: false, reason: "connector_mismatch" });
    // and a fresh-connect input (null) against a row bound to a connector also mismatches
    const c2 = makeFakeConsumer([row()]);
    expect(await consumeOAuthPending(input({ connectorId: null }), c2)).toEqual({ ok: false, reason: "connector_mismatch" });
  });

  it("wrong nonce → nonce_mismatch", async () => {
    const c = makeFakeConsumer([row({ nonceHash: "DIFFERENT" })]);
    expect(await consumeOAuthPending(input(), c)).toEqual({ ok: false, reason: "nonce_mismatch" });
  });

  it("malformed input → malformed_input (never throws a raw value)", async () => {
    const c = makeFakeConsumer([row()]);
    for (const bad of [{ tenantId: "" }, { provider: "" }, { stateJti: "" }, { nonceHash: "" }, { now: NaN }] as Partial<OAuthPendingConsumeInput>[]) {
      expect(await consumeOAuthPending(input(bad), c)).toEqual({ ok: false, reason: "malformed_input" });
    }
    expect(c.atomicCalls).toBe(0); // a malformed input never reaches the atomic mutation
  });

  it("throws (typed) when no consumer is supplied", async () => {
    // @ts-expect-error — missing consumer
    await expect(consumeOAuthPending(input(), null)).rejects.toBeInstanceOf(OAuthPendingConsumeError);
  });

  it("fails closed (already_consumed) on a TOCTOU race: atomic returns null but the row still looks consumable", async () => {
    // A row consumed by a concurrent caller BETWEEN the atomic update (0 rows) and the classify read: the
    // atomic returns null, yet readPendingState reports a fully-matching, unconsumed, unexpired row. The
    // consume must NEVER report success here — it fails closed to already_consumed.
    const racey: OAuthPendingConsumer = {
      async runAtomicConsume() {
        return null; // the atomic mutation changed 0 rows (another caller won the race)
      },
      async readPendingState() {
        return { tenantId: TENANT, provider: "github", connectorId: CONNECTOR, nonceHash: "nh-1", consumedAt: null, expiresAt: FUTURE };
      },
    };
    expect(await consumeOAuthPending(input(), racey)).toEqual({ ok: false, reason: "already_consumed" });
  });
});

describe("consumeOAuthPending — safe labels (no raw input/secret in the result)", () => {
  it("a failure result is just { ok:false, reason } — no tenant/nonce/state echoed back", async () => {
    const c = makeFakeConsumer([row({ nonceHash: "the-secret-nonce-hash-XYZ" })]);
    const res = await consumeOAuthPending(input({ nonceHash: "attacker-supplied-nonce-hash-ABC" }), c);
    const flat = JSON.stringify(res);
    expect(res).toEqual({ ok: false, reason: "nonce_mismatch" });
    expect(flat).not.toContain("the-secret-nonce-hash-XYZ");
    expect(flat).not.toContain("attacker-supplied-nonce-hash-ABC");
  });
});

// Static guards: the consume module is pure server-only — no DB/Supabase/service-role/connector_secrets/
// token exchange. And the OAuth callback route still exchanges no code and stores no token.
describe("oauth-pending-consume module is pure (no DB / Supabase / service-role / connector_secrets / token)", () => {
  it("has no imports and no forbidden call/string", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const src = fs.readFileSync(path.resolve(__dirname, "oauth-pending-consume.ts"), "utf8");
    const imports = [...src.matchAll(/from\s+["']([^"']+)["']/g)].map((m) => m[1]);
    expect(imports).toEqual([]); // pure TS — no module imports at all
    const code = src.replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
    expect(code).not.toMatch(/createClient\s*\(/);
    expect(code).not.toMatch(/process\.env/);
    expect(code).not.toMatch(/\bfetch\s*\(/);
    const secretsTable = ["connector", "secrets"].join("_");
    expect(code).not.toContain(secretsTable);
    const forbidden = ["service", "role"].join("_");
    expect(code).not.toContain(forbidden);
    for (const tok of ["access_token", "refresh_token", "token_endpoint", "grant_type"]) {
      expect(code).not.toContain(tok);
    }
  });

  it("the OAuth callback route still does NO token exchange and stores NO token", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const route = fs.readFileSync(
      path.resolve(__dirname, "..", "..", "..", "app", "(authenticated)", "connectors", "oauth", "callback", "route.ts"),
      "utf8",
    );
    const code = route.replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
    expect(code).not.toMatch(/\bfetch\s*\(/);
    expect(code).not.toMatch(/createClient\s*\(/);
    for (const bad of [["connector", "secrets"].join("_"), "access_token", "refresh_token", "token_endpoint", "grant_type"]) {
      expect(code).not.toContain(bad);
    }
  });
});
