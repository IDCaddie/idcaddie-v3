import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  exchangeSlackOAuthCode,
  SlackOAuthExchangeError,
  SLACK_TOKEN_URL,
  type SlackHttpClient,
  type SlackHttpResponse,
  type ClientSecretProvider,
  type ExchangeStoreHandoff,
  type SlackExchangeInput,
  type SlackExchangeDeps,
} from "./slack-oauth-exchange";

// A TOKEN-SHAPED synthetic sentinel: a real Slack `xoxb-` form (matches the scanner's xoxb pattern) carrying the
// approved MUSTNOTLEAK marker so the scanner excuses it AND so the no-leak tests prove a REAL-shaped token would not
// survive into a result/error/log. NOT a generic placeholder.
const TOKEN_SENTINEL = "xoxb-2222222222-3333333333-MUSTNOTLEAKbbbbbbbbbbbb";
// A client-secret sentinel — clearly NOT a realistic client secret (no real hex shape), marker-carrying.
const SECRET_SENTINEL = "MUSTNOTLEAK-slack-client-secret-sentinel";
const CODE = "synthetic-auth-code-MUSTNOTLEAK";
const REDIRECT = "https://app.example.com/connectors/oauth/callback";

const input = (over: Partial<SlackExchangeInput> = {}): SlackExchangeInput => ({
  code: CODE,
  redirectUri: REDIRECT,
  tenantId: "11111111-1111-1111-1111-111111111111",
  connectorId: "22222222-2222-2222-2222-222222222222",
  version: 1,
  correlationId: "corr-exchange-01",
  ...over,
});

const okSecret = (): ClientSecretProvider => ({ read: async () => SECRET_SENTINEL });
const httpReturning = (body: unknown, opts: { ok?: boolean; status?: number; throwNetwork?: boolean; badJson?: boolean } = {}): { client: SlackHttpClient; calls: { url: string; body: string }[] } => {
  const calls: { url: string; body: string }[] = [];
  const client: SlackHttpClient = async (url, init) => {
    calls.push({ url, body: init.body });
    if (opts.throwNetwork) throw new Error("ETIMEDOUT");
    const resp: SlackHttpResponse = {
      ok: opts.ok ?? true,
      status: opts.status ?? 200,
      json: async () => { if (opts.badJson) throw new SyntaxError("Unexpected token"); return body; },
    };
    return resp;
  };
  return { client, calls };
};
// A mock store that CAPTURES the handed-off plaintext (to prove the handoff) and returns a redacted ref.
const captureStore = (opts: { fail?: boolean } = {}) => {
  const captured: { plaintext: string }[] = [];
  const store: ExchangeStoreHandoff = async (i) => {
    captured.push({ plaintext: i.plaintext });
    return opts.fail ? { ok: false } : { ok: true, ref: { secretId: "sec-1" } };
  };
  return { store, captured };
};
const botResponse = (over: Record<string, unknown> = {}) => ({ ok: true, access_token: TOKEN_SENTINEL, token_type: "bot", scope: "channels:read", bot_user_id: "U123", extra_field: "ignored", ...over });

// Capture EVERYTHING a leak could ride out on: the result, any thrown error, and every console call.
let consoleDump: string[];
beforeEach(() => {
  // NO-NETWORK GUARANTEE: stub global fetch to FAIL LOUD — the wrapper must use ONLY the injected client.
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("REAL NETWORK BLOCKED — exchange must use the injected client, never slack.com"); }));
  consoleDump = [];
  for (const m of ["log", "info", "warn", "error", "debug"] as const) {
    vi.spyOn(console, m).mockImplementation((...args: unknown[]) => { consoleDump.push(args.map(String).join(" ")); });
  }
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const run = async (deps: Partial<SlackExchangeDeps> & Pick<SlackExchangeDeps, "httpClient" | "clientSecret" | "store">, over: Partial<SlackExchangeInput> = {}) => {
  let result: unknown; let thrown: unknown;
  try { result = await exchangeSlackOAuthCode(input(over), { clientId: "11111.22222", ...deps }); } catch (e) { thrown = e; }
  return { result, thrown, dump: JSON.stringify({ result, thrown: thrown instanceof Error ? thrown.message : thrown, console: consoleDump }) };
};
const noLeak = (dump: string) => { expect(dump).not.toContain(TOKEN_SENTINEL); expect(dump).not.toContain(SECRET_SENTINEL); expect(dump.toLowerCase()).not.toContain("xoxb-2222"); };

describe("slack-oauth-exchange — happy path (mocked): token-shaped sentinel → store handoff, nothing leaks", () => {
  it("a valid bot-token response hands the xoxb- token to the store and returns a REDACTED ref (no token)", async () => {
    const http = httpReturning(botResponse());
    const st = captureStore();
    const { result, dump } = await run({ httpClient: http.client, clientSecret: okSecret(), store: st.store });
    expect(result).toEqual({ ok: true, ref: { secretId: "sec-1" } });
    // the token reached the store (handoff proven) …
    expect(st.captured).toHaveLength(1);
    expect(st.captured[0].plaintext).toBe(TOKEN_SENTINEL);
    // … but the token (and the client secret) appear NOWHERE in the result / error / logs.
    noLeak(dump);
    // the exchange targeted the Slack token endpoint via the INJECTED client (no global fetch).
    expect(http.calls[0].url).toBe(SLACK_TOKEN_URL);
    expect(SLACK_TOKEN_URL).toBe("https://slack.com/api/oauth.v2.access");
  });
  it("the success result contains NO token field (only a redacted ref)", async () => {
    const { result } = await run({ httpClient: httpReturning(botResponse()).client, clientSecret: okSecret(), store: captureStore().store });
    expect(JSON.stringify(result)).not.toContain("access_token");
    expect(JSON.stringify(result)).not.toContain(TOKEN_SENTINEL);
  });
});

describe("slack-oauth-exchange — Slack response handling (fail closed; no raw response/token/secret leaks)", () => {
  it("ok:false → slack_error (sanitized — the raw Slack `error` is never echoed)", async () => {
    const { result, dump } = await run({ httpClient: httpReturning({ ok: false, error: "invalid_code_SHOULD_NOT_APPEAR" }).client, clientSecret: okSecret(), store: captureStore().store });
    expect(result).toEqual({ ok: false, reason: "slack_error" });
    expect(dump).not.toContain("invalid_code_SHOULD_NOT_APPEAR");
  });
  it("missing bot token → missing_bot_token", async () => {
    expect((await run({ httpClient: httpReturning(botResponse({ access_token: undefined })).client, clientSecret: okSecret(), store: captureStore().store })).result).toEqual({ ok: false, reason: "missing_bot_token" });
  });
  it("unexpected token type → unexpected_token_type", async () => {
    expect((await run({ httpClient: httpReturning(botResponse({ token_type: "user" })).client, clientSecret: okSecret(), store: captureStore().store })).result).toEqual({ ok: false, reason: "unexpected_token_type" });
  });
  it("extra Slack response fields are ignored (only the bot token is read)", async () => {
    const st = captureStore();
    const { result } = await run({ httpClient: httpReturning(botResponse({ refresh_token: "xoxe-SHOULD-BE-IGNORED", enterprise: { id: "E1" } })).client, clientSecret: okSecret(), store: st.store });
    expect(result).toEqual({ ok: true, ref: { secretId: "sec-1" } });
    expect(JSON.stringify(result)).not.toContain("xoxe-");
  });
  it("malformed JSON → malformed_response", async () => {
    expect((await run({ httpClient: httpReturning(null, { badJson: true }).client, clientSecret: okSecret(), store: captureStore().store })).result).toEqual({ ok: false, reason: "malformed_response" });
  });
  it("a non-object body → malformed_response", async () => {
    expect((await run({ httpClient: httpReturning("a string").client, clientSecret: okSecret(), store: captureStore().store })).result).toEqual({ ok: false, reason: "malformed_response" });
  });
  it("network timeout/failure → exchange_http_error (no token/secret)", async () => {
    const { result, dump } = await run({ httpClient: httpReturning(null, { throwNetwork: true }).client, clientSecret: okSecret(), store: captureStore().store });
    expect(result).toEqual({ ok: false, reason: "exchange_http_error" });
    noLeak(dump);
  });
  it("non-2xx HTTP → exchange_http_error", async () => {
    expect((await run({ httpClient: httpReturning(botResponse(), { ok: false, status: 500 }).client, clientSecret: okSecret(), store: captureStore().store })).result).toEqual({ ok: false, reason: "exchange_http_error" });
  });
  it("a store failure → store_failed (no half state, no leak)", async () => {
    const { result, dump } = await run({ httpClient: httpReturning(botResponse()).client, clientSecret: okSecret(), store: captureStore({ fail: true }).store });
    expect(result).toEqual({ ok: false, reason: "store_failed" });
    noLeak(dump);
  });
});

describe("slack-oauth-exchange — client-secret boundary (injected; never env; never surfaced)", () => {
  it("missing client secret (provider returns empty) → missing_client_secret (no Slack call made)", async () => {
    const http = httpReturning(botResponse());
    const { result } = await run({ httpClient: http.client, clientSecret: { read: async () => "" }, store: captureStore().store });
    expect(result).toEqual({ ok: false, reason: "missing_client_secret" });
    expect(http.calls).toHaveLength(0); // failed before any exchange
  });
  it("client-secret access denied (provider throws) → client_secret_denied; the secret never surfaces", async () => {
    const { result, dump } = await run({ httpClient: httpReturning(botResponse()).client, clientSecret: { read: async () => { throw new Error(`denied for ${SECRET_SENTINEL}`); } }, store: captureStore().store });
    expect(result).toEqual({ ok: false, reason: "client_secret_denied" });
    noLeak(dump); // even the thrown provider error (which embedded the sentinel) is not surfaced
  });
  it("a forced failure AFTER the secret is read does not surface the client secret in the result/error/logs", async () => {
    const { dump } = await run({ httpClient: httpReturning(null, { throwNetwork: true }).client, clientSecret: okSecret(), store: captureStore().store });
    expect(dump).not.toContain(SECRET_SENTINEL);
  });
});

describe("slack-oauth-exchange — NO NETWORK: only the injected client reaches Slack; global fetch is never used", () => {
  it("a successful exchange does NOT touch global fetch (which is stubbed to fail loud)", async () => {
    await run({ httpClient: httpReturning(botResponse()).client, clientSecret: okSecret(), store: captureStore().store });
    expect(globalThis.fetch).not.toHaveBeenCalled(); // the loud-failing stub was never invoked
  });
  it("the wrapper FAILS LOUD (throws) if no injected http client / client-secret provider / store is supplied", async () => {
    await expect(exchangeSlackOAuthCode(input(), { clientId: "c", clientSecret: okSecret(), store: captureStore().store } as unknown as SlackExchangeDeps)).rejects.toBeInstanceOf(SlackOAuthExchangeError);
    await expect(exchangeSlackOAuthCode(input(), { clientId: "c", httpClient: httpReturning(botResponse()).client, store: captureStore().store } as unknown as SlackExchangeDeps)).rejects.toBeInstanceOf(SlackOAuthExchangeError);
    await expect(exchangeSlackOAuthCode(input(), { clientId: "c", httpClient: httpReturning(botResponse()).client, clientSecret: okSecret() } as unknown as SlackExchangeDeps)).rejects.toBeInstanceOf(SlackOAuthExchangeError);
  });
  it("the raw authorization code is never logged or returned", async () => {
    const { dump } = await run({ httpClient: httpReturning(botResponse()).client, clientSecret: okSecret(), store: captureStore().store });
    expect(dump).not.toContain(CODE);
  });
});

describe("slack-oauth-exchange — source is server-only + scope-fenced (no global fetch / decrypt / route / real token)", () => {
  it("imports nothing, contains no fetch(/decrypt/route/real-token, declares the server-only sentinel", async () => {
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const src = readFileSync(fileURLToPath(new URL("./slack-oauth-exchange.ts", import.meta.url)), "utf8");
    const imports = [...src.matchAll(/from\s+["']([^"']+)["']/g)].map((m) => m[1]);
    expect(imports).toEqual([]); // no imports at all (pure)
    expect(src).toMatch(/server-only and must not be imported in client code/);
    const code = src.replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
    for (const bad of ["fetch(", "process.env", "decryptConnectorSecret", "loadConnectorSecret", "createClient", "@supabase", "NextRequest", "NextResponse"]) {
      expect(code).not.toContain(bad);
    }
    // the ONLY xoxb / token literal anywhere is in tests; the module carries no real or realistic token.
    expect(code).not.toMatch(/xox[baprs]-[0-9]/);
  });
});
