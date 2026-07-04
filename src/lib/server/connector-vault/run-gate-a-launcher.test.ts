import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
// The INERT RUN GATE A operator pre-flight launcher (scripts/run-gate-a-b2c-real-exchange-launcher.mjs). It assembles
// NOTHING and runs NO exchange — it refuses unsafe conditions and emits the procedure. These tests prove the guards +
// that the launcher's gate matches the real wiring gate + that the replay/correlation invariants it relies on hold.
import {
  assertStagingRef,
  assertGateEnabled,
  gateEnabled,
  assertConfirm,
  assertAppEnv,
  assertRedirectUri,
  assertNoArgvSecret,
  assertNoEnvSecret,
  preflight,
  runSelftest,
} from "../../../../scripts/run-gate-a-b2c-real-exchange-launcher.mjs";
import { isRealExchangeEnabled, makeRealOrchestratorDeps, makeReplayConsume } from "./oauth-real-exchange-wiring";
import { hashOAuthValue } from "./oauth-pending";
import type { OAuthPendingConsumer } from "./oauth-pending-consume";
import type { OAuthStatePayload } from "./oauth-state";

const STAGING = "ycdpzduxugdsffjqyoai";
const PROD = "dzbfxulvxchdemcettrx";
const CONFIRM = "RUN B2C FIRST REAL TOKEN STAGING";
const REDIRECT = "https://idcaddie-v3.vercel.app/connectors/oauth/callback";
const SENTINEL = "MUSTNOTLEAK-run-gate-a-secret";
const NOW = Date.parse("2025-06-01T00:00:00Z");
const grabMsg = (fn: () => void) => { try { fn(); return ""; } catch (e) { return e instanceof Error ? e.message : String(e); } };
const goodPreflight = { argv: [`--confirm=${CONFIRM}`, "--app-env=staging"], env: { CONNECTOR_OAUTH_REAL_EXCHANGE_ENABLED: "1" }, ref: STAGING, confirm: CONFIRM, appEnv: "staging", redirectUri: REDIRECT };

// A faithful fake oauth_pending consumer (matches the OAuthPendingConsumer interface). `row=null` → no durable row.
const payload = (over: Record<string, unknown> = {}): OAuthStatePayload =>
  ({ sub: "user-1", tid: "tenant-A", prov: "slack", cid: "conn-1", corr: "state-jti-1", nonce: "nonce-abc", redir: REDIRECT, iat: 1, exp: 2, v: 1, ...over } as unknown as OAuthStatePayload);
const rowFor = (p: OAuthStatePayload, over: Record<string, unknown> = {}) =>
  ({ stateJti: p.corr, tenantId: p.tid, provider: p.prov, connectorId: p.cid, nonceHash: hashOAuthValue(p.nonce), expiresAt: "2999-01-01T00:00:00Z", ...over });
function fakeConsumer(row: ReturnType<typeof rowFor> | null): OAuthPendingConsumer {
  let consumedAt: string | null = null;
  return {
    async runAtomicConsume(pp) {
      if (!row) return null;
      const match = row.stateJti === pp.stateJti && row.tenantId === pp.tenantId && row.provider === pp.provider &&
        (row.connectorId ?? null) === (pp.connectorId ?? null) && row.nonceHash === pp.nonceHash &&
        consumedAt === null && Date.parse(row.expiresAt as string) > Date.parse(pp.nowIso);
      if (!match) return null;
      consumedAt = "2025-06-01T00:00:05Z";
      return { stateJti: pp.stateJti, consumedAt };
    },
    async readPendingState(stateJti) {
      if (!row || row.stateJti !== stateJti) return null;
      return { tenantId: row.tenantId as string, provider: row.provider as string, connectorId: (row.connectorId ?? null) as string | null, nonceHash: row.nonceHash as string, consumedAt, expiresAt: row.expiresAt as string };
    },
  };
}

let dump: string[];
beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("REAL NETWORK BLOCKED — launcher/preflight must never call fetch"); }));
  dump = [];
  for (const m of ["log", "info", "warn", "error", "debug"] as const) vi.spyOn(console, m).mockImplementation((...a: unknown[]) => { dump.push(a.map(String).join(" ")); });
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("RUN GATE A launcher — refuses production / missing confirm / wrong ref / gate off / wrong app-env-redirect", () => {
  it("the launcher selftest passes (guards only, no AWS/Supabase/Slack/DB/secret)", () => {
    expect(runSelftest()).toEqual({ ok: true, checks: 5 });
  });
  it("PRODUCTION refuses — production ref, and production environment", () => {
    expect(() => assertStagingRef(PROD)).toThrow(/production/i);
    expect(() => assertGateEnabled({ CONNECTOR_OAUTH_REAL_EXCHANGE_ENABLED: "1", VERCEL_ENV: "production" })).toThrow(/production/i);
    expect(() => assertGateEnabled({ CONNECTOR_OAUTH_REAL_EXCHANGE_ENABLED: "1", NODE_ENV: "production" })).toThrow(/production/i);
    expect(() => preflight({ ...goodPreflight, ref: PROD })).toThrow(/production/i);
  });
  it("MISSING/incorrect confirmation refuses", () => {
    expect(() => assertConfirm(undefined as unknown as string)).toThrow();
    expect(() => assertConfirm("run b2c first real token staging")).toThrow(); // wrong case
    expect(() => assertConfirm(CONFIRM)).not.toThrow();
    expect(() => preflight({ ...goodPreflight, confirm: undefined })).toThrow(/confirmation/i);
  });
  it("WRONG ref refuses; only the exact staging ref passes", () => {
    expect(() => assertStagingRef("something-else")).toThrow();
    expect(() => assertStagingRef(`${STAGING}\n`)).not.toThrow(); // trims
    expect(() => assertStagingRef(STAGING)).not.toThrow();
  });
  it("gate OFF refuses; wrong app-env refuses; wrong/insecure redirect refuses", () => {
    expect(() => assertGateEnabled({})).toThrow(/gate OFF/i);
    expect(() => assertAppEnv("production")).toThrow();
    expect(() => assertRedirectUri("http://idcaddie-v3.vercel.app/connectors/oauth/callback")).toThrow(); // not https
    expect(() => assertRedirectUri("https://evil.example.com/connectors/oauth/callback")).toThrow(); // wrong host
    expect(() => assertRedirectUri(REDIRECT)).not.toThrow();
  });
});

describe("RUN GATE A launcher — no secret in argv/env is accepted, and no secret is ever echoed", () => {
  it("refuses a secret-shaped / positional / unknown-flag argv; never echoes the value", () => {
    expect(() => assertNoArgvSecret(["xoxb-111-222-" + SENTINEL])).toThrow();
    expect(grabMsg(() => assertNoArgvSecret(["xoxb-111-222-" + SENTINEL]))).not.toContain(SENTINEL);
    expect(() => assertNoArgvSecret([SENTINEL])).toThrow(); // positional
    expect(grabMsg(() => assertNoArgvSecret([SENTINEL]))).not.toContain(SENTINEL);
    expect(() => assertNoArgvSecret(["--evil=" + SENTINEL])).toThrow();
    expect(grabMsg(() => assertNoArgvSecret(["--evil=" + SENTINEL]))).not.toContain(SENTINEL);
    expect(() => assertNoArgvSecret([`--confirm=${CONFIRM}`, "--app-env=staging", "--redirect-uri=" + REDIRECT])).not.toThrow();
  });
  it("refuses a client secret / bot token / OAuth code / DB URL / password in env; never echoes the value", () => {
    for (const k of ["SLACK_CLIENT_SECRET", "SLACK_BOT_TOKEN", "SLACK_OAUTH_CODE", "DATABASE_URL", "PGPASSWORD"]) {
      expect(() => assertNoEnvSecret({ [k]: SENTINEL })).toThrow();
      expect(grabMsg(() => assertNoEnvSecret({ [k]: SENTINEL }))).not.toContain(SENTINEL);
    }
    expect(() => assertNoEnvSecret({ CONNECTOR_OAUTH_REAL_EXCHANGE_ENABLED: "1" })).not.toThrow();
  });
  it("preflight emits a procedure that contains NO secret and no token/code shape", () => {
    const out = preflight(goodPreflight);
    expect(out).toContain("PRE-FLIGHT OK");
    expect(out).toContain("docs/51");
    expect(out).not.toContain(SENTINEL);
    expect(out).not.toMatch(/xox[baprs]-|eyJ|AKIA|postgres:\/\//);
    expect(dump.join("\n")).not.toContain(SENTINEL);
  });
});

describe("RUN GATE A launcher — gate parity with the real wiring; real deps unbuildable without the flag", () => {
  it("the launcher gate matches isRealExchangeEnabled for every input (no drift)", () => {
    const envs = [{}, { CONNECTOR_OAUTH_REAL_EXCHANGE_ENABLED: "1" }, { CONNECTOR_OAUTH_REAL_EXCHANGE_ENABLED: "0" },
      { CONNECTOR_OAUTH_REAL_EXCHANGE_ENABLED: "1", VERCEL_ENV: "production" }, { CONNECTOR_OAUTH_REAL_EXCHANGE_ENABLED: "1", NODE_ENV: "production" },
      { CONNECTOR_OAUTH_REAL_EXCHANGE_ENABLED: "1", VERCEL_ENV: "preview" }];
    for (const e of envs) expect(gateEnabled(e)).toBe(isRealExchangeEnabled(e));
  });
  it("gate OFF by default; makeRealOrchestratorDeps FAILS CLOSED without the flag (real exchange unbuildable)", () => {
    expect(isRealExchangeEnabled({})).toBe(false);
    expect(() => makeRealOrchestratorDeps({ env: {} } as never)).toThrow(/real_exchange_disabled|INERT/);
  });
});

describe("RUN GATE A launcher — replay/correlation invariants the pre-flight relies on (durable pending row)", () => {
  const consume = (c: OAuthPendingConsumer) => makeReplayConsume(c, () => NOW);
  it("replay consumes EXACTLY once — 2nd consume of the same state → already_consumed (before any exchange)", async () => {
    const c = consume(fakeConsumer(rowFor(payload())));
    expect(await c(payload())).toEqual({ ok: true });
    expect(await c(payload())).toEqual({ ok: false, reason: "already_consumed" });
  });
  it("real exchange CANNOT run without the durable pending row — absent row → not_found (fail closed)", async () => {
    expect(await consume(fakeConsumer(null))(payload())).toEqual({ ok: false, reason: "not_found" });
  });
  it("wrong tenant / provider / connector / correlation refuses BEFORE exchange", async () => {
    expect(await consume(fakeConsumer(rowFor(payload(), { tenantId: "other" })))(payload())).toEqual({ ok: false, reason: "tenant_mismatch" });
    expect(await consume(fakeConsumer(rowFor(payload(), { provider: "github" })))(payload())).toEqual({ ok: false, reason: "provider_mismatch" });
    expect(await consume(fakeConsumer(rowFor(payload(), { connectorId: "conn-9" })))(payload())).toEqual({ ok: false, reason: "connector_mismatch" });
    // wrong correlation: the durable row's state_jti differs from payload.corr → no row on the corr key → not_found
    expect(await consume(fakeConsumer(rowFor(payload(), { stateJti: "different-jti" })))(payload())).toEqual({ ok: false, reason: "not_found" });
  });
  it("correlation is ENFORCED: an empty/absent corr fails closed as correlation_missing (never widens the match)", async () => {
    const c = consume(fakeConsumer(rowFor(payload())));
    expect(await c(payload({ corr: "" }) as OAuthStatePayload)).toEqual({ ok: false, reason: "correlation_missing" });
    expect(await c(payload({ corr: undefined as unknown as string }) as OAuthStatePayload)).toEqual({ ok: false, reason: "correlation_missing" });
  });
});

describe("RUN GATE A launcher — no global fetch, route stays synthetic, no import of the real wiring into the route", () => {
  it("NO global fetch: the preflight + the replay gate never call global fetch", async () => {
    preflight(goodPreflight);
    await makeReplayConsume(fakeConsumer(rowFor(payload())), () => NOW)(payload());
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
  it("the browser callback route stays SYNTHETIC — it does not import the real-exchange wiring / makeRealOrchestratorDeps", () => {
    const route = fs.readFileSync(path.resolve(__dirname, "..", "..", "..", "app", "(authenticated)", "connectors", "oauth", "callback", "route.ts"), "utf8");
    expect(route).not.toContain("oauth-real-exchange-wiring");
    expect(route).not.toContain("makeRealOrchestratorDeps");
    expect(route).toContain("handleSyntheticSlackOAuthCallback"); // synthetic handler only
    // the launcher itself never IMPORTS the real wiring (it is a pure guard/preflight; makeRealOrchestratorDeps is only
    // named in descriptive text). Its SOLE import is node:fs, so it structurally cannot assemble or run a real exchange.
    const launcher = fs.readFileSync(path.resolve(__dirname, "..", "..", "..", "..", "scripts", "run-gate-a-b2c-real-exchange-launcher.mjs"), "utf8");
    const imports = [...launcher.matchAll(/^import .*/gm)].map((m) => m[0]);
    expect(imports).toHaveLength(1);
    expect(imports[0]).toContain('"node:fs"'); // only node:fs — no real-exchange/KMS/Supabase/Slack/DB import
  });
});
