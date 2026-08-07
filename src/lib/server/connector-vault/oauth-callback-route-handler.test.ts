import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  handleSyntheticSlackOAuthCallback,
  isSyntheticCallbackEnabled,
  makeSyntheticOrchestratorRunner,
  type SyntheticCallbackHandlerDeps,
} from "./oauth-callback-route-handler";
import { orchestrateSlackOAuthCallback } from "./oauth-callback-orchestrator";
import { createOAuthState, createHmacStateSigner } from "./oauth-state";
import type { SlackHttpClient } from "./slack-oauth-exchange";

// B2c-route: the production-SHAPED but SYNTHETIC Slack OAuth callback handler. Marked, searchable sentinels prove no
// request material / token / client secret survives into a response/log/error. Synthetic only — no real Slack call.
const CODE_SENTINEL = "CODE-MUSTNOTLEAK-authcode";
const STATE_SENTINEL = "STATE-MUSTNOTLEAK-statevalue";
const SESSION_SENTINEL = "0a000000-0000-0000-0000-00000000aaaa"; // the resolved subject (a session-derived value)
const TOKEN_SENTINEL = "xoxb-9999999999-8888888888-MUSTNOTLEAKsynthroute"; // the synthetic runner's bot token
const CLIENT_SECRET_SENTINEL = "MUSTNOTLEAK-synthetic-route-client-secret";

const signer = () => createHmacStateSigner("test-only-b2c-route-secret-NOT-real", "test");
const NOW = 1_750_000_000_000;
const EXPECTED = {
  tenantId: "11111111-1111-1111-1111-111111111111",
  connectorId: "17000000-0000-0000-0000-0000000000a1",
  provider: "slack",
  redirectUri: "https://app.example.com/connectors/oauth/callback",
  correlationId: "corr-b2c-route-test",
};
const mintState = (subject = SESSION_SENTINEL) =>
  createOAuthState(
    { tenantId: EXPECTED.tenantId, provider: EXPECTED.provider, connectorId: EXPECTED.connectorId, subject, redirectIntent: "connect", redirectUri: EXPECTED.redirectUri, correlationId: EXPECTED.correlationId },
    { signer: signer(), ttlSeconds: 600, now: NOW },
  ).state;
// A runOrchestrator wired to the REAL B2c-wire orchestrator with synthetic deps + a spy http client (proves the
// route reaches/gates the exchange + makes no real network call).
const realRunner = (httpClient: SlackHttpClient): SyntheticCallbackHandlerDeps["runOrchestrator"] =>
  async ({ state, code, subject }) =>
    orchestrateSlackOAuthCallback(
      { state, code },
      { expectedContext: { subject, redirectIntent: "connect", ...EXPECTED }, signer: signer(), now: NOW + 1000, clientId: "c", clientSecret: { read: async () => CLIENT_SECRET_SENTINEL }, httpClient, store: async () => ({ ok: true, ref: { secretId: "s" } }), version: 1 },
    );
const botHttp = () => { const calls: string[] = []; const client: SlackHttpClient = async (url) => { calls.push(url); return { ok: true, status: 200, json: async () => ({ ok: true, access_token: TOKEN_SENTINEL, token_type: "bot", scope: "users:read,users:read.email,usergroups:read" }) }; }; return { client, calls }; };

const reqWith = (params: Record<string, string>) => new Request(`https://app.example.com/connectors/oauth/callback?${new URLSearchParams(params).toString()}`);

let consoleDump: string[];
beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("REAL NETWORK BLOCKED — the synthetic route must never reach slack.com"); }));
  consoleDump = [];
  for (const m of ["log", "info", "warn", "error", "debug"] as const) vi.spyOn(console, m).mockImplementation((...a: unknown[]) => { consoleDump.push(a.map(String).join(" ")); });
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const base = (over: Partial<SyntheticCallbackHandlerDeps> = {}): SyntheticCallbackHandlerDeps => ({
  enabled: true, resolveSubject: async () => SESSION_SENTINEL, runOrchestrator: async () => ({ ok: true, ref: {} }), ...over,
});
const run = async (req: Request, over: Partial<SyntheticCallbackHandlerDeps> = {}) => {
  const res = await handleSyntheticSlackOAuthCallback(req, base(over));
  const body = await res.clone().text();
  const dump = JSON.stringify({ status: res.status, headers: [...res.headers], body, console: consoleDump });
  return { res, body, dump };
};
const noLeak = (dump: string) => {
  for (const s of [CODE_SENTINEL, STATE_SENTINEL, SESSION_SENTINEL, TOKEN_SENTINEL, CLIENT_SECRET_SENTINEL, "MUSTNOTLEAK"]) expect(dump).not.toContain(s);
};

describe("B2c-route — production-disabled guard (refuses earliest; generic 404; no disclosure)", () => {
  it("disabled → generic 404, orchestrator NOT called, no request material logged, no route-purpose/guard disclosure", async () => {
    const spy = vi.fn(async () => ({ ok: true as const, ref: {} }));
    const resolveSpy = vi.fn(async () => SESSION_SENTINEL);
    const { res, body, dump } = await run(reqWith({ state: STATE_SENTINEL, code: CODE_SENTINEL }), { enabled: false, runOrchestrator: spy, resolveSubject: resolveSpy });
    expect(res.status).toBe(404);
    expect(body).toBe("Not Found"); // generic; does not reveal an OAuth callback
    expect(spy).not.toHaveBeenCalled(); // refusal does not call the orchestrator
    expect(resolveSpy).not.toHaveBeenCalled(); // …and does NO session work before the 404 (guard is the first statement)
    noLeak(dump); // no code/state/session logged or returned
    for (const leak of ["oauth", "callback", "slack", "synthetic", "CONNECTOR_OAUTH", "state", "code"]) expect(dump.toLowerCase()).not.toContain(leak.toLowerCase());
  });
  it("the guard reads TRUSTED env only — production + missing opt-in are disabled; a request value cannot enable it", () => {
    expect(isSyntheticCallbackEnabled({ VERCEL_ENV: "production", CONNECTOR_OAUTH_SYNTHETIC_CALLBACK_ENABLED: "1" })).toBe(false);
    expect(isSyntheticCallbackEnabled({ NODE_ENV: "production", CONNECTOR_OAUTH_SYNTHETIC_CALLBACK_ENABLED: "1" })).toBe(false);
    expect(isSyntheticCallbackEnabled({ NODE_ENV: "test" })).toBe(false); // missing opt-in → disabled
    expect(isSyntheticCallbackEnabled({ NODE_ENV: "test", CONNECTOR_OAUTH_SYNTHETIC_CALLBACK_ENABLED: "1" })).toBe(true);
    // `enabled` is computed from env (server config), never from the request — the handler takes it as `deps.enabled`.
  });
});

describe("B2c-route — explicit session resolution (no layout auth)", () => {
  it("no session → safe error redirect; orchestrator NOT called", async () => {
    const spy = vi.fn(async () => ({ ok: true as const, ref: {} }));
    const { res } = await run(reqWith({ state: STATE_SENTINEL, code: CODE_SENTINEL }), { resolveSubject: async () => null, runOrchestrator: spy });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/connectors?oauth=error");
    expect(spy).not.toHaveBeenCalled();
  });
  it("a session-resolution failure → safe error, no leak", async () => {
    const { res, dump } = await run(reqWith({ state: STATE_SENTINEL, code: CODE_SENTINEL }), { resolveSubject: async () => { throw new Error(`session blew up ${SESSION_SENTINEL}`); } });
    expect(res.headers.get("location")).toBe("/connectors?oauth=error");
    noLeak(dump);
  });
});

describe("B2c-route — safe/static responses + request-path discipline (no raw code/state/session leaks)", () => {
  it("success → 303 /connectors?oauth=success; failures → ?oauth=error; never raw code/state/reason in Location", async () => {
    const ok = await run(reqWith({ state: STATE_SENTINEL, code: CODE_SENTINEL }), { runOrchestrator: async () => ({ ok: true, ref: {} }) });
    expect(ok.res.status).toBe(303);
    expect(ok.res.headers.get("location")).toBe("/connectors?oauth=success");
    noLeak(ok.dump);
    const err = await run(reqWith({ state: STATE_SENTINEL, code: CODE_SENTINEL }), { runOrchestrator: async () => ({ ok: false, stage: "validate", reason: "bad_signature" }) });
    expect(err.res.headers.get("location")).toBe("/connectors?oauth=error"); // no raw reason in the redirect
    noLeak(err.dump);
  });
  it("an orchestrator THROW → safe error (never surfaces the error/code/state)", async () => {
    const { res, dump } = await run(reqWith({ state: STATE_SENTINEL, code: CODE_SENTINEL }), { runOrchestrator: async () => { throw new Error(`boom ${CODE_SENTINEL} ${STATE_SENTINEL}`); } });
    expect(res.headers.get("location")).toBe("/connectors?oauth=error");
    noLeak(dump);
  });
});

describe("B2c-route — orchestrator integration + no real egress (REAL B2c-wire + synthetic deps)", () => {
  it("a valid synthetic request REACHES the exchange and yields success; global fetch is never called", async () => {
    const http = botHttp();
    const { res, dump } = await run(reqWith({ state: mintState(), code: CODE_SENTINEL }), { resolveSubject: async () => SESSION_SENTINEL, runOrchestrator: realRunner(http.client) });
    expect(res.headers.get("location")).toBe("/connectors?oauth=success");
    expect(http.calls).toHaveLength(1); // reached the (synthetic) exchange
    expect(http.calls[0]).toBe("https://slack.com/api/oauth.v2.access"); // via the injected client only
    expect(globalThis.fetch).not.toHaveBeenCalled(); // NO real egress
    noLeak(dump); // no token/secret/code/state in the response/log
  });
  it("an invalid/tampered state does NOT reach the exchange (B2a gate); generic error", async () => {
    const http = botHttp();
    const { res } = await run(reqWith({ state: "tampered.bad", code: CODE_SENTINEL }), { resolveSubject: async () => SESSION_SENTINEL, runOrchestrator: realRunner(http.client) });
    expect(res.headers.get("location")).toBe("/connectors?oauth=error");
    expect(http.calls).toHaveLength(0); // exchange UNREACHABLE without successful validation
  });
  it("a WRONG session (subject != state.sub) does NOT reach the exchange (subject_mismatch); generic error", async () => {
    const http = botHttp();
    const { res } = await run(reqWith({ state: mintState("0a000000-0000-0000-0000-00000000bbbb"), code: CODE_SENTINEL }), { resolveSubject: async () => SESSION_SENTINEL, runOrchestrator: realRunner(http.client) });
    expect(res.headers.get("location")).toBe("/connectors?oauth=error");
    expect(http.calls).toHaveLength(0);
  });
  it("a missing code does NOT reach the exchange; generic error", async () => {
    const http = botHttp();
    const { res } = await run(reqWith({ state: mintState() }), { resolveSubject: async () => SESSION_SENTINEL, runOrchestrator: realRunner(http.client) });
    expect(res.headers.get("location")).toBe("/connectors?oauth=error");
    expect(http.calls).toHaveLength(0);
  });
  it("the makeSyntheticOrchestratorRunner factory uses ONLY a synthetic client (no global fetch) and leaks nothing", async () => {
    const runner = makeSyntheticOrchestratorRunner({ signer: signer(), expected: EXPECTED, now: () => NOW + 1000 });
    const { res, dump } = await run(reqWith({ state: mintState(), code: CODE_SENTINEL }), { resolveSubject: async () => SESSION_SENTINEL, runOrchestrator: runner });
    expect(res.headers.get("location")).toBe("/connectors?oauth=success");
    expect(globalThis.fetch).not.toHaveBeenCalled();
    noLeak(dump);
  });
});

describe("B2c-route — import boundary (no client-secret decrypt, no real Slack client, no request-path decrypt)", () => {
  it("neither the handler nor the route imports withSlackClientSecret / a real Slack client / a decrypt path", async () => {
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const handlerSrc = readFileSync(fileURLToPath(new URL("./oauth-callback-route-handler.ts", import.meta.url)), "utf8");
    const routeSrc = readFileSync(fileURLToPath(new URL("../../../app/(authenticated)/connectors/oauth/callback/route.ts", import.meta.url)), "utf8");
    for (const src of [handlerSrc, routeSrc]) {
      const code = src.replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
      expect(code).not.toContain("withSlackClientSecret");
      expect(code).not.toContain("slack-client-secret-store");
      expect(code).not.toContain("decryptConnectorSecret");
      expect(code).not.toContain("decryptAppSecret");
      expect(code).not.toMatch(/\bfetch\(/);
      expect(code).not.toContain("@slack/");
    }
    expect(handlerSrc).toMatch(/server-only and must not be imported in client code/);
  });
});
