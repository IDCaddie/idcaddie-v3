import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { randomBytes } from "node:crypto";
import { orchestrateSlackOAuthCallback, b1StoreHandoff, type OrchestratorDeps } from "./oauth-callback-orchestrator";
import { createOAuthState, createHmacStateSigner, type OAuthStateContext, type ConsumedNonceStore } from "./oauth-state";
import type { SlackHttpClient, SlackHttpResponse, ClientSecretProvider, ExchangeStoreHandoff } from "./slack-oauth-exchange";
import type { EncryptOnlyKeyProvider } from "./secret-vault";
import { createRunnerConnectorSecretStore } from "./connector-secret-store";
import type { RunnerConnection } from "./runner-db-client";

// B2c-wire: prove the SYNTHETIC composition B2a validate -> B2b mocked exchange -> B1 store works, with B2a as the
// authoritative gate and the VALIDATED payload (not the raw query) as the single source of truth. Uses the REAL
// validateOAuthState (states minted by the real createOAuthState). Synthetic only — no real Slack call/token/secret.

// Three DETECTABLE sentinels (token is structurally xoxb-...MUSTNOTLEAK...; secret + code are marked + searchable).
const TOKEN_SENTINEL = "xoxb-2222222222-3333333333-MUSTNOTLEAKbbbbbbbbbbbb";
const SECRET_SENTINEL = "MUSTNOTLEAK-slack-client-secret-sentinel";
const CODE_SENTINEL = "synthetic-auth-code-MUSTNOTLEAK-cccc";

const signer = () => createHmacStateSigner("test-only-b2c-wire-secret-NOT-real", "test");
const NOW = 1_750_000_000_000;
const TTL = 600;
const SUBJECT = "0a000000-0000-0000-0000-000000000001";
const TENANT = "11111111-1111-1111-1111-111111111111";
const CONNECTOR = "17000000-0000-0000-0000-0000000000a1";
const REDIRECT = "https://app.example.com/connectors/oauth/callback";
const CORR = "corr-b2c-wire-01";
const ctx = (over: Partial<OAuthStateContext> = {}): OAuthStateContext => ({
  tenantId: TENANT, provider: "slack", connectorId: CONNECTOR, subject: SUBJECT,
  redirectIntent: "connect", redirectUri: REDIRECT, correlationId: CORR, ...over,
});
const mintState = (over: Partial<OAuthStateContext> = {}) => createOAuthState(ctx(over), { signer: signer(), ttlSeconds: TTL, now: NOW }).state;

const botResponse = (over: Record<string, unknown> = {}) => ({ ok: true, access_token: TOKEN_SENTINEL, token_type: "bot", scope: "channels:read", ...over });
const httpReturning = (body: unknown, opts: { ok?: boolean; status?: number; throwNetwork?: boolean } = {}) => {
  const calls: { url: string; body: string }[] = [];
  const client: SlackHttpClient = async (url, init) => {
    calls.push({ url, body: init.body });
    if (opts.throwNetwork) throw new Error("ETIMEDOUT");
    const resp: SlackHttpResponse = { ok: opts.ok ?? true, status: opts.status ?? 200, json: async () => body };
    return resp;
  };
  return { client, calls };
};
const okSecret = (): ClientSecretProvider => ({ read: async () => SECRET_SENTINEL });
// A faithful injected B1 equivalent: captures the handed-off plaintext + binding, returns a redacted ref (or fails).
const captureStore = (opts: { fail?: boolean } = {}) => {
  const captured: { plaintext: string; tenantId: string; connectorId: string; version: number; correlationId: string }[] = [];
  const store: ExchangeStoreHandoff = async (i) => { captured.push({ ...i }); return opts.fail ? { ok: false } : { ok: true, ref: { secretId: "sec-1" } }; };
  return { store, captured };
};
const memNonce = (): ConsumedNonceStore => { const s = new Set<string>(); return { has: (n) => s.has(n), add: (n) => void s.add(n) }; };

let consoleDump: string[];
beforeEach(() => {
  // NO-NETWORK: stub global fetch to FAIL LOUD — the whole flow must use the injected client only.
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("REAL NETWORK BLOCKED — synthetic callback must use the injected client"); }));
  consoleDump = [];
  for (const m of ["log", "info", "warn", "error", "debug"] as const) vi.spyOn(console, m).mockImplementation((...a: unknown[]) => { consoleDump.push(a.map(String).join(" ")); });
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const baseDeps = (over: Partial<OrchestratorDeps> = {}): OrchestratorDeps => ({
  expectedContext: ctx(), signer: signer(), now: NOW + 1000, clientId: "11111.22222", clientSecret: okSecret(),
  httpClient: httpReturning(botResponse()).client, store: captureStore().store, version: 1, ...over,
});
const orchestrate = async (query: Record<string, string | undefined>, over: Partial<OrchestratorDeps> = {}) => {
  let result: unknown, thrown: unknown;
  try { result = await orchestrateSlackOAuthCallback(query, baseDeps(over)); } catch (e) { thrown = e; }
  return { result, thrown, dump: JSON.stringify({ result, thrown: thrown instanceof Error ? thrown.message : thrown, console: consoleDump }) };
};
// No-leak: none of the three sentinels may appear in result + thrown error + console.
const noLeak = (dump: string) => {
  expect(dump).not.toContain(TOKEN_SENTINEL);
  expect(dump).not.toContain(SECRET_SENTINEL);
  expect(dump).not.toContain(CODE_SENTINEL);
  expect(dump.toLowerCase()).not.toContain("xoxb-2222");
};

describe("B2c-wire — happy path: validate -> exchange -> store, redacted result, nothing leaks", () => {
  it("a valid state drives the full synthetic flow and returns ONLY a redacted ref", async () => {
    const http = httpReturning(botResponse());
    const st = captureStore();
    const { result, dump } = await orchestrate({ state: mintState(), code: CODE_SENTINEL }, { httpClient: http.client, store: st.store });
    expect(result).toEqual({ ok: true, ref: { secretId: "sec-1" } });
    expect(http.calls).toHaveLength(1); // exchange ran
    expect(st.captured).toHaveLength(1); // store ran
    expect(st.captured[0].plaintext).toBe(TOKEN_SENTINEL); // token handed ONLY to the store
    noLeak(dump); // token/secret/code appear nowhere in result/error/logs
    expect(JSON.stringify(result)).not.toContain("access_token");
  });
});

describe("B2c-wire — single source of truth: downstream uses the VALIDATED payload, never the raw query", () => {
  it("decoy tenant/connector/provider in the query are IGNORED; the store binds the validated tenant + connector", async () => {
    const st = captureStore();
    const query = { state: mintState(), code: CODE_SENTINEL, tenant: "deadbeef-dead-dead-dead-deaddeaddead", connector: "deadc0de-dead-dead-dead-deaddeaddead", provider: "decoy-provider", redirect_uri: "https://evil.example/cb" };
    const { result } = await orchestrate(query, { store: st.store });
    expect(result).toEqual({ ok: true, ref: { secretId: "sec-1" } });
    expect(st.captured[0].tenantId).toBe(TENANT); // validated tid, NOT the decoy
    expect(st.captured[0].connectorId).toBe(CONNECTOR); // validated cid, NOT the decoy
    expect(st.captured[0].correlationId).toBe(CORR); // validated corr
  });
  it("the orchestrator reads ONLY state + code from the untrusted query (source scan)", async () => {
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const src = readFileSync(fileURLToPath(new URL("./oauth-callback-orchestrator.ts", import.meta.url)), "utf8").replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
    const queryReads = [...src.matchAll(/query\??\.(\w+)/g)].map((m) => m[1]);
    expect([...new Set(queryReads)].sort()).toEqual(["code", "state"]); // never query.tenant/connector/provider/redirect
  });
});

describe("B2c-wire — stage ordering + causal gating (validation is the ONLY thing that unlocks exchange)", () => {
  it("validation FAILURE stops the flow: exchange + store are never called", async () => {
    const http = httpReturning(botResponse());
    const st = captureStore();
    const { result } = await orchestrate({ state: "tampered.bad", code: CODE_SENTINEL }, { httpClient: http.client, store: st.store });
    expect(result).toMatchObject({ ok: false, stage: "validate" });
    expect(http.calls).toHaveLength(0); // exchange UNREACHABLE without successful validation
    expect(st.captured).toHaveLength(0);
  });
  it("a missing code after a VALID state fails closed at validate, before exchange", async () => {
    const http = httpReturning(botResponse());
    const { result } = await orchestrate({ state: mintState() }, { httpClient: http.client });
    expect(result).toEqual({ ok: false, stage: "validate", reason: "missing_code" });
    expect(http.calls).toHaveLength(0);
  });
  it("exchange FAILURE stops the flow: store is never called", async () => {
    const st = captureStore();
    const { result } = await orchestrate({ state: mintState(), code: CODE_SENTINEL }, { httpClient: httpReturning({ ok: false, error: "invalid_code_HIDE" }).client, store: st.store });
    expect(result).toMatchObject({ ok: false, stage: "exchange", reason: "slack_error" });
    expect(st.captured).toHaveLength(0); // store UNREACHABLE without successful exchange
  });
});

describe("B2c-wire — state integration: the REAL B2a validator gates the flow (no advisory validation)", () => {
  const cases: { name: string; query: () => Record<string, string | undefined>; over?: Partial<OrchestratorDeps>; reason: string }[] = [
    { name: "tampered signature", query: () => ({ state: mintState().slice(0, -3) + "zzz", code: CODE_SENTINEL }), reason: "bad_signature" },
    { name: "malformed state", query: () => ({ state: "not-a-state", code: CODE_SENTINEL }), reason: "malformed_state" },
    { name: "missing state", query: () => ({ code: CODE_SENTINEL }), reason: "missing_state" },
    { name: "wrong session subject", query: () => ({ state: mintState(), code: CODE_SENTINEL }), over: { expectedContext: ctx({ subject: "0bffffff-ffff-ffff-ffff-ffffffffffff" }) }, reason: "subject_mismatch" },
    { name: "no session", query: () => ({ state: mintState(), code: CODE_SENTINEL }), over: { expectedContext: ctx({ subject: "" }) }, reason: "session_required" },
    { name: "wrong tenant", query: () => ({ state: mintState(), code: CODE_SENTINEL }), over: { expectedContext: ctx({ tenantId: "22222222-2222-2222-2222-222222222222" }) }, reason: "tenant_mismatch" },
    { name: "wrong connector", query: () => ({ state: mintState(), code: CODE_SENTINEL }), over: { expectedContext: ctx({ connectorId: "17000000-0000-0000-0000-0000000000ff" }) }, reason: "connector_mismatch" },
    { name: "wrong redirect", query: () => ({ state: mintState(), code: CODE_SENTINEL }), over: { expectedContext: ctx({ redirectUri: "https://app.example.com/OTHER/cb" }) }, reason: "redirect_uri_mismatch" },
    { name: "expired state", query: () => ({ state: mintState(), code: CODE_SENTINEL }), over: { now: NOW + TTL * 1000 + 1 }, reason: "expired" },
  ];
  for (const c of cases) {
    it(`${c.name} -> stops at validate (${c.reason}); exchange never runs`, async () => {
      const http = httpReturning(botResponse());
      const { result, dump } = await orchestrate(c.query(), { httpClient: http.client, ...c.over });
      expect(result).toEqual({ ok: false, stage: "validate", reason: c.reason });
      expect(http.calls).toHaveLength(0);
      noLeak(dump);
    });
  }
  it("a replayed state (same nonce consumed twice) is rejected on the second callback", async () => {
    const store = memNonce();
    const state = mintState();
    const first = await orchestrate({ state, code: CODE_SENTINEL }, { consumedNonces: store });
    expect(first.result).toMatchObject({ ok: true });
    const http = httpReturning(botResponse());
    const second = await orchestrate({ state, code: CODE_SENTINEL }, { consumedNonces: store, httpClient: http.client, now: NOW + 2000 });
    expect(second.result).toEqual({ ok: false, stage: "validate", reason: "replayed" });
    expect(http.calls).toHaveLength(0);
  });
});

describe("B2c-wire — failure behavior: fail closed + no leak across every seam", () => {
  const seams: { name: string; over: Partial<OrchestratorDeps>; stage: string; reason: string }[] = [
    { name: "mocked client secret missing", over: { clientSecret: { read: async () => "" } }, stage: "exchange", reason: "missing_client_secret" },
    { name: "mocked client secret denied (provider throws with secret embedded)", over: { clientSecret: { read: async () => { throw new Error(`denied ${SECRET_SENTINEL}`); } } }, stage: "exchange", reason: "client_secret_denied" },
    { name: "mocked Slack malformed response", over: { httpClient: httpReturning("not-json").client }, stage: "exchange", reason: "malformed_response" },
    { name: "mocked Slack missing token", over: { httpClient: httpReturning(botResponse({ access_token: undefined })).client }, stage: "exchange", reason: "missing_bot_token" },
    { name: "mocked Slack network failure", over: { httpClient: httpReturning(null, { throwNetwork: true }).client }, stage: "exchange", reason: "exchange_http_error" },
    { name: "store/encrypt failure", over: { store: captureStore({ fail: true }).store }, stage: "exchange", reason: "store_failed" },
  ];
  for (const s of seams) {
    it(`${s.name} -> safe ${s.reason}, no token/secret/code leak`, async () => {
      const { result, dump } = await orchestrate({ state: mintState(), code: CODE_SENTINEL }, s.over);
      expect(result).toEqual({ ok: false, stage: s.stage, reason: s.reason });
      noLeak(dump);
    });
  }
  it("EXCHANGE-SUCCESS / STORE-FAILURE seam (orchestration layer): token is dropped, never surfaced", async () => {
    // The Slack exchange succeeds (returns the token-shaped sentinel) but the store fails. The orchestrator must
    // surface only a safe failure and the token must appear NOWHERE — distinct from B1's internal DB atomicity.
    const http = httpReturning(botResponse());
    const { result, dump } = await orchestrate({ state: mintState(), code: CODE_SENTINEL }, { httpClient: http.client, store: captureStore({ fail: true }).store });
    expect(http.calls).toHaveLength(1); // exchange DID run + got the token...
    expect(result).toEqual({ ok: false, stage: "exchange", reason: "store_failed" }); // ...but store failed
    noLeak(dump); // the token-shaped sentinel is not in the result/error/console
    expect(JSON.stringify(result)).not.toContain("xoxb");
  });
});

describe("B2c-wire — no real Slack egress", () => {
  it("a full successful flow never touches global fetch (stubbed to fail loud)", async () => {
    await orchestrate({ state: mintState(), code: CODE_SENTINEL });
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});

describe("B2c-wire — b1StoreHandoff wires the REAL B1 ingestion (envelope-only; token -> ciphertext)", () => {
  // Minimal synthetic crypto + a capturing runner connection (mirrors the B1 test's atomic store tx).
  const KEK = "kek-staging-1";
  const keyProvider: EncryptOnlyKeyProvider = { async generateDataKey(kekId) { const dek = randomBytes(32); return { dek, wrappedDek: Buffer.concat([Buffer.from(`${kekId}|`), dek]) }; } };
  const captureConn = () => {
    const statements: { sql: string; params: readonly unknown[] }[] = [];
    const conn: RunnerConnection = {
      async runSequence(stmts) {
        const results: { rows: ReadonlyArray<Record<string, unknown>> }[] = [];
        let seq = 0;
        for (const s of stmts) {
          statements.push({ sql: s.sql, params: s.params });
          if (/insert\s+into\s+public\.connector_secrets/i.test(s.sql)) results.push({ rows: [{ id: `sec-${++seq}` }] });
          else results.push({ rows: [] });
        }
        return results;
      },
    };
    return { conn, statements };
  };
  beforeEach(() => { vi.stubEnv("CONNECTOR_VAULT_STAGING_INGEST_ENABLED", "1"); vi.stubEnv("VERCEL_ENV", "preview"); });
  afterEach(() => { vi.unstubAllEnvs(); });

  it("the token-shaped sentinel is encrypted by the real B1 path: only ciphertext is stored, a redacted ref returns", async () => {
    const c = captureConn();
    const store = b1StoreHandoff({ keyProvider, kekId: KEK, store: createRunnerConnectorSecretStore(c.conn) });
    const { result, dump } = await orchestrate({ state: mintState(), code: CODE_SENTINEL }, { store });
    expect(result).toMatchObject({ ok: true, ref: { secretId: expect.any(String) } });
    // serialize every statement the real path committed (Buffers -> hex) and prove the token NEVER appears raw.
    const wire = JSON.stringify(c.statements, (_k, v) => (v?.type === "Buffer" ? Buffer.from(v.data).toString("hex") : v));
    expect(c.statements.some((s) => /insert\s+into\s+public\.connector_secrets/i.test(s.sql))).toBe(true);
    expect(wire).not.toContain(TOKEN_SENTINEL);
    expect(wire).not.toContain("xoxb-2222");
    noLeak(dump);
  });
  it("if the real B1 path is blocked (production), the handoff fails closed without leaking the token", async () => {
    vi.stubEnv("VERCEL_ENV", "production"); // B1 production hard-block -> ingest throws -> handoff returns {ok:false}
    const store = b1StoreHandoff({ keyProvider, kekId: KEK, store: createRunnerConnectorSecretStore(captureConn().conn) });
    const { result, dump } = await orchestrate({ state: mintState(), code: CODE_SENTINEL }, { store });
    expect(result).toEqual({ ok: false, stage: "exchange", reason: "store_failed" });
    noLeak(dump);
  });
});
