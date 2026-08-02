import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { randomBytes } from "node:crypto";
import {
  isRealExchangeEnabled,
  makeReplayConsume,
  makeBoundClientSecretProvider,
  makeRealOrchestratorDeps,
  RealExchangeWiringError,
} from "./oauth-real-exchange-wiring";
import { orchestrateSlackOAuthCallback, type OrchestratorDeps } from "./oauth-callback-orchestrator";
import { createOAuthState, createHmacStateSigner, type OAuthStateContext } from "./oauth-state";
import type { SlackHttpClient, SlackHttpResponse, ClientSecretProvider, ExchangeStoreHandoff } from "./slack-oauth-exchange";
import { hashOAuthValue } from "./oauth-pending";
import type { OAuthPendingConsumer } from "./oauth-pending-consume";
import { saveSlackClientSecret, type AppSecretEnvelopeStore } from "./slack-client-secret-store";
import { encryptAppSecret, decryptAppSecret, type ConnectorVaultKeyProvider, type EncryptedConnectorSecret } from "./crypto";

// PR 5 (B2c real-exchange hardening): prove the REAL wiring is GATED + fail-closed and, with the flag + FAKE deps,
// composes into an envelope-only, replay-protected, no-leak flow. No real OAuth/AWS/KMS/DB/secret — synthetic only.
const TOKEN_SENTINEL = "xoxb-2222222222-3333333333-MUSTNOTLEAKbbbbbbbbbbbb";
const SECRET_SENTINEL = "MUSTNOTLEAK-slack-client-secret-sentinel";
const CODE_SENTINEL = "synthetic-auth-code-MUSTNOTLEAK-cccc";
const KEK = "synthetic-kek";
const NOW = 1_750_000_000_000;
const TTL = 600;
const SUBJECT = "0a000000-0000-0000-0000-000000000001";
const TENANT = "11111111-1111-1111-1111-111111111111";
const CONNECTOR = "17000000-0000-0000-0000-0000000000a1";
const REDIRECT = "https://app.example.com/connectors/oauth/callback";
const CORR = "corr-b2c-real-01";
// Phase 8F: the flag alone no longer enables real mode. The gate is now a POSITIVE environment-identity check, so an
// "enabled" environment must also prove WHICH environment it is — staging marker, Vercel project, Supabase project,
// the narrow oauth_completer identity, the exact callback, the workspace and the trusted context.
const ENABLED_ENV = {
  IDCADDIE_ENVIRONMENT: "staging",
  IDCADDIE_VERCEL_PROJECT_ID: "prj_l30QMLpF3dNLwKBP2CTG7v9rIon0",
  NEXT_PUBLIC_SUPABASE_URL: `https://${"ycdpzduxugdsffjqyoai"}.supabase.co`,
  OAUTH_COMPLETER_DB_URL: `postgresql://oauth_completer_login:not-a-real-token@db.${"ycdpzduxugdsffjqyoai"}.supabase.co/postgres`,
  CONNECTOR_OAUTH_REDIRECT_URI: "https://idcaddie-v3.vercel.app/connectors/oauth/callback",
  CONNECTOR_OAUTH_REAL_EXCHANGE_ENABLED: "1",
  CONNECTOR_OAUTH_EXPECTED_SLACK_TEAM_ID: "T0ABCDEF123",
  CONNECTOR_OAUTH_EXPECTED_TENANT_ID: "aaaa1111-1111-1111-1111-111111111111",
  CONNECTOR_OAUTH_EXPECTED_CONNECTOR_ID: "1575cde3-0000-4000-8000-00000000bbbb",
  CONNECTOR_OAUTH_EXPECTED_CORRELATION_ID: "corr-live-run-1",
  SLACK_CLIENT_ID: "1234.5678",
};

const signer = () => createHmacStateSigner("test-only-b2c-real-secret-NOT-real", "test");
const stateCtx = (over: Partial<OAuthStateContext> = {}): OAuthStateContext => ({
  tenantId: TENANT, provider: "slack", connectorId: CONNECTOR, subject: SUBJECT,
  redirectIntent: "connect", redirectUri: REDIRECT, correlationId: CORR, ...over,
});
const mint = (over: Partial<OAuthStateContext> = {}) => createOAuthState(stateCtx(over), { signer: signer(), ttlSeconds: TTL, now: NOW });

const botResponse = (over: Record<string, unknown> = {}) => ({ ok: true, access_token: TOKEN_SENTINEL, token_type: "bot", scope: "channels:read", ...over });
const httpReturning = (body: unknown, opts: { ok?: boolean; status?: number } = {}): SlackHttpClient =>
  async () => ({ ok: opts.ok ?? true, status: opts.status ?? 200, json: async () => body } as SlackHttpResponse);
const okSecret = (): ClientSecretProvider => ({ read: async () => SECRET_SENTINEL });
const captureStore = (opts: { fail?: boolean } = {}) => {
  const captured: { plaintext: string; tenantId: string; connectorId: string; version: number }[] = [];
  const store: ExchangeStoreHandoff = async (i) => { captured.push({ plaintext: i.plaintext, tenantId: i.tenantId, connectorId: i.connectorId, version: i.version }); return opts.fail ? { ok: false } : { ok: true, ref: { secretId: "sec-1" } }; };
  return { store, captured };
};

// A faithful single-use oauth_pending consumer keyed by state_jti, with a fully-matching row so a 2nd consume → already_consumed.
const singleUseConsumer = (nonce: string): OAuthPendingConsumer => {
  const at = new Map<string, string>();
  const row = { tenantId: TENANT, provider: "slack", connectorId: CONNECTOR, nonceHash: hashOAuthValue(nonce) };
  return {
    async runAtomicConsume(p) { if (at.has(p.stateJti)) return null; at.set(p.stateJti, "2025-06-01T00:00:00Z"); return { stateJti: p.stateJti, consumedAt: at.get(p.stateJti)! }; },
    async readPendingState(jti) { return { ...row, consumedAt: at.get(jti) ?? null, expiresAt: "2999-01-01T00:00:00Z" }; },
  };
};

// synthetic KMS + app-secret store (for the client-secret decrypt boundary test)
const memKeyProvider = (opts: { failUnwrap?: boolean } = {}): ConnectorVaultKeyProvider => ({
  async generateDataKey(kekId) { const dek = randomBytes(32); return { dek, wrappedDek: Buffer.concat([Buffer.from(`${kekId}|`), dek]) }; },
  async unwrapDataKey(wrappedDek, kekId) { if (opts.failUnwrap) throw new Error("denied"); const p = Buffer.from(`${kekId}|`); if (!wrappedDek.subarray(0, p.length).equals(p)) throw new Error("wrong KEK"); return wrappedDek.subarray(p.length); },
});
const memAppStore = () => {
  const rows: { appEnv: string; provider: string; secretKind: string; version: number; encrypted: EncryptedConnectorSecret }[] = [];
  const store: AppSecretEnvelopeStore = {
    async insertEnvelope(row) { rows.push({ ...row }); return { secretId: `appsec-${rows.length}` }; },
    async loadActiveEnvelope(q) { const m = rows.filter((r) => r.appEnv === q.appEnv && r.provider === q.provider && r.secretKind === q.secretKind); if (!m.length) return null; return { version: m[m.length - 1].version, encrypted: m[m.length - 1].encrypted }; },
  };
  return store;
};

let dump: string[];
beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("REAL NETWORK BLOCKED — must use the injected client"); }));
  dump = [];
  for (const m of ["log", "info", "warn", "error", "debug"] as const) vi.spyOn(console, m).mockImplementation((...a: unknown[]) => { dump.push(a.map(String).join(" ")); });
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
const noLeak = (blob: string) => { expect(blob).not.toContain(SECRET_SENTINEL); expect(blob).not.toContain(TOKEN_SENTINEL); expect(blob).not.toContain("MUSTNOTLEAK"); };

// Compose deps for a composed orchestrator run (replay gate wired via makeReplayConsume; other deps FAKE).
const composed = (over: Partial<OrchestratorDeps> = {}, consumer?: OAuthPendingConsumer): OrchestratorDeps => ({
  expectedContext: stateCtx(), signer: signer(), now: NOW + 1000, clientId: "11111.22222", clientSecret: okSecret(),
  httpClient: httpReturning(botResponse()), store: captureStore().store, version: 1,
  ...(consumer ? { pendingConsume: makeReplayConsume(consumer, () => NOW + 1000) } : {}), ...over,
});

describe("B2c real-exchange wiring — GATED, fail-closed, replay-protected, envelope-only, no-leak", () => {
  it("GATE: default OFF; the FULL staging identity enables; the Vercel channel label is irrelevant", () => {
    expect(isRealExchangeEnabled({})).toBe(false);
    // The flag on its own is no longer enough — that was the weakness of a negative check.
    expect(isRealExchangeEnabled({ CONNECTOR_OAUTH_REAL_EXCHANGE_ENABLED: "1" })).toBe(false);
    expect(isRealExchangeEnabled(ENABLED_ENV)).toBe(true);
    // idcaddie-v3.vercel.app IS our staging environment, served on Vercel's "Production" channel.
    expect(isRealExchangeEnabled({ ...ENABLED_ENV, VERCEL_ENV: "production" })).toBe(true);
    expect(isRealExchangeEnabled({ ...ENABLED_ENV, NODE_ENV: "production" })).toBe(true);
    // …but the production DATABASE ref appearing anywhere still refuses.
    expect(isRealExchangeEnabled({ ...ENABLED_ENV, NOTE: "dzbfxulvxchdemcettrx" })).toBe(false);
  });

  it("makeRealOrchestratorDeps FAILS CLOSED without the flag; assembles the real seams WITH the flag", () => {
    const cfg = {
      expectedContext: stateCtx(), signer: signer(), now: NOW, pendingConsumer: singleUseConsumer("n"),
      httpClient: httpReturning(botResponse()), clientId: "c.1",
      clientSecretIdentity: { appEnv: "staging" }, clientSecretDeps: { keyProvider: memKeyProvider(), store: memAppStore() },
      ingestDeps: {} as never, version: 1,
    };
    expect(() => makeRealOrchestratorDeps(cfg)).toThrow(RealExchangeWiringError); // default env (no flag)
    const deps = makeRealOrchestratorDeps({ ...cfg, env: ENABLED_ENV });
    expect(typeof deps.pendingConsume).toBe("function"); // replay gate wired
    expect(typeof deps.clientSecret.read).toBe("function"); // client-secret decrypt boundary wired
    expect(typeof deps.store).toBe("function"); // envelope-only store wired
  });

  it("makeReplayConsume: first consume OK, a REPLAY (same state) fails closed as already_consumed", async () => {
    const s = mint();
    const consume = makeReplayConsume(singleUseConsumer(s.nonce), () => NOW + 1000);
    const payload = { v: 1 as const, tid: TENANT, prov: "slack", cid: CONNECTOR, sub: SUBJECT, intent: "connect", redir: REDIRECT, corr: CORR, nonce: s.nonce, exp: NOW + TTL * 1000 };
    expect(await consume(payload)).toEqual({ ok: true });
    expect(await consume(payload)).toEqual({ ok: false, reason: "already_consumed" });
  });

  it("ORCHESTRATED: success stores envelope-only + REPLAY of the same state fails closed (validate stage)", async () => {
    const s = mint();
    const cap = captureStore();
    const consumer = singleUseConsumer(s.nonce);
    const deps = composed({ store: cap.store }, consumer);
    const first = await orchestrateSlackOAuthCallback({ state: s.state, code: CODE_SENTINEL }, deps);
    expect(first).toEqual({ ok: true, ref: { secretId: "sec-1" } });
    // the token reached ONLY the store handoff (envelope-only downstream); the bound tenant is the VALIDATED one
    expect(cap.captured[0]).toMatchObject({ tenantId: TENANT, connectorId: CONNECTOR, version: 1 });
    expect(cap.captured[0].plaintext).toBe(TOKEN_SENTINEL); // exchanged token reached ONLY the store handoff (then encrypted)
    expect(JSON.stringify(first)).not.toContain(TOKEN_SENTINEL); // result is a redacted ref
    // REPLAY: same state again → the oauth_pending row is already consumed → fail closed before the exchange
    const replay = await orchestrateSlackOAuthCallback({ state: s.state, code: CODE_SENTINEL }, composed({ store: cap.store }, consumer));
    expect(replay).toEqual({ ok: false, stage: "validate", reason: "already_consumed" });
    expect(cap.captured).toHaveLength(1); // the replay never reached the store
    noLeak(JSON.stringify({ first, replay, dump }));
  });

  it("client-secret DECRYPT boundary: read() returns the secret via withSlackClientSecret; missing envelope fails closed", async () => {
    const kp = memKeyProvider();
    const store = memAppStore();
    await saveSlackClientSecret({ plaintext: SECRET_SENTINEL, appEnv: "staging", version: 1 }, { keyProvider: kp, kekId: KEK, store });
    const provider = makeBoundClientSecretProvider({ appEnv: "staging" }, { keyProvider: kp, store });
    expect(await provider.read()).toBe(SECRET_SENTINEL); // decrypted inside the server boundary
    // no active envelope → fail closed (throws a static reason class, never a value)
    const empty = makeBoundClientSecretProvider({ appEnv: "staging" }, { keyProvider: kp, store: memAppStore() });
    await expect(empty.read()).rejects.toBeInstanceOf(RealExchangeWiringError);
  });

  it("FAIL-CLOSED: invalid state, exchange failure, and malformed provider response each stop before store", async () => {
    // invalid/tampered state → validate stage
    const tampered = mint().state.slice(0, -4) + "AAAA";
    expect(await orchestrateSlackOAuthCallback({ state: tampered, code: CODE_SENTINEL }, composed())).toMatchObject({ ok: false, stage: "validate" });
    // exchange HTTP not-ok → exchange stage, nothing stored
    const capA = captureStore();
    expect(await orchestrateSlackOAuthCallback({ state: mint().state, code: CODE_SENTINEL }, composed({ store: capA.store, httpClient: httpReturning(botResponse(), { ok: false, status: 400 }) }))).toMatchObject({ ok: false, stage: "exchange" });
    expect(capA.captured).toHaveLength(0);
    // malformed body (no access_token) → exchange stage
    const capB = captureStore();
    expect(await orchestrateSlackOAuthCallback({ state: mint().state, code: CODE_SENTINEL }, composed({ store: capB.store, httpClient: httpReturning({ ok: true, token_type: "bot" }) }))).toMatchObject({ ok: false, stage: "exchange" });
    expect(capB.captured).toHaveLength(0);
    noLeak(JSON.stringify(dump));
  });

  it("TENANT SCOPING: a decoy tenantId in the callback query is ignored — the store binds the VALIDATED tenant", async () => {
    const s = mint();
    const cap = captureStore();
    await orchestrateSlackOAuthCallback({ state: s.state, code: CODE_SENTINEL, tenantId: "99999999-9999-9999-9999-999999999999" }, composed({ store: cap.store }));
    expect(cap.captured[0].tenantId).toBe(TENANT); // not the decoy
  });
});
