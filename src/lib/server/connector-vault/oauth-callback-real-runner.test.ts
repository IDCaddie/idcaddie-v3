// Phase 8E — the real callback runner's refusals, and the workspace binding the exchange now enforces.
//
// Every dependency is injected and fake. Nothing here reaches Slack, KMS or a database: the point of the whole vault
// design is that the real path is assembled from seams, so the seams are what get tested.

import { describe, it, expect } from "vitest";
import { buildRealCallbackRunner } from "./oauth-callback-real-runner";
import { exchangeSlackOAuthCode, type SlackHttpClient, type ExchangeStoreHandoff } from "./slack-oauth-exchange";
import { realConnectorOAuthRedirectUri, expectedSlackTeamId, ConnectorOAuthHostError } from "./connector-oauth-config";
import { createHmacStateSigner, createOAuthState, type OAuthStateContext } from "./oauth-state";

const TEAM = "T0ABCDEF123";
const TENANT = "aaaa1111-0000-4000-8000-00000000aaaa";
const CONNECTOR = "1575cde3-0000-4000-8000-00000000bbbb";
const CORR = "corr-phase-8e-test";
const REDIRECT = "https://idcaddie-v3.vercel.app/connectors/oauth/callback";

// Phase 8F: the gate is now a POSITIVE environment-identity check, so a valid environment must state which
// environment it is, which Vercel project, which Supabase project, and that the narrow oauth_completer identity is the
// one present. "Not production" is no longer a passing answer.
const okEnv = (over: Record<string, string | undefined> = {}) => ({
  NODE_ENV: "test",
  IDCADDIE_ENVIRONMENT: "staging",
  IDCADDIE_VERCEL_PROJECT_ID: "prj_l30QMLpF3dNLwKBP2CTG7v9rIon0",
  NEXT_PUBLIC_SUPABASE_URL: `https://${"ycdpzduxugdsffjqyoai"}.supabase.co`,
  OAUTH_COMPLETER_DB_URL: `postgresql://oauth_completer_login:not-a-real-token@db.${"ycdpzduxugdsffjqyoai"}.supabase.co/postgres`,
  CONNECTOR_OAUTH_REAL_EXCHANGE_ENABLED: "1",
  CONNECTOR_OAUTH_REDIRECT_URI: REDIRECT,
  CONNECTOR_OAUTH_EXPECTED_SLACK_TEAM_ID: TEAM,
  CONNECTOR_OAUTH_EXPECTED_TENANT_ID: TENANT,
  CONNECTOR_OAUTH_EXPECTED_CONNECTOR_ID: CONNECTOR,
  CONNECTOR_OAUTH_EXPECTED_CORRELATION_ID: CORR,
  SLACK_CLIENT_ID: "1234.5678",
  ...over,
});

// A pending consumer that succeeds ONCE per state_jti, then behaves like a consumed row — the durable replay gate.
function singleUseConsumer() {
  const consumed = new Set<string>();
  return {
    consumed,
    consumer: {
      runAtomicConsume: async (p: { stateJti: string }) => {
        if (consumed.has(p.stateJti)) return null; // already consumed → 0 rows → fail closed
        consumed.add(p.stateJti);
        return { stateJti: p.stateJti, consumedAt: new Date(0).toISOString() };
      },
      readPendingState: async () => null,
    },
  };
}

// A runner build only needs these to be present; none is exercised by a refusal.
const deps = () => ({
  signer: createHmacStateSigner("test-state-secret-not-real", "test"),
  pendingConsumer: singleUseConsumer().consumer as never,
  httpClient: (async () => { throw new Error("must not be called"); }) as unknown as SlackHttpClient,
  keyProvider: {} as never,
  appSecretStore: {} as never,
  ingestDeps: {} as never,
});

const SIGNER = createHmacStateSigner("test-state-secret-not-real", "test");
const ctx = (over: Partial<OAuthStateContext> = {}): OAuthStateContext => ({
  tenantId: TENANT, provider: "slack", connectorId: CONNECTOR, subject: "user-1",
  redirectIntent: "connect", redirectUri: REDIRECT, correlationId: CORR, ...over,
});
const stateFor = (over: Partial<OAuthStateContext> = {}, ttlSeconds = 300, now = Date.now()) =>
  createOAuthState(ctx(over), { signer: SIGNER, ttlSeconds, now }).state;

describe("buildRealCallbackRunner — fail-closed assembly", () => {
  it("refuses when the real-exchange gate is off (the default)", () => {
    const r = buildRealCallbackRunner(deps(), okEnv({ CONNECTOR_OAUTH_REAL_EXCHANGE_ENABLED: undefined }));
    expect(r).toEqual({ ok: false, reason: "real_exchange_disabled" });
  });

  // Phase 8F: idcaddie-v3.vercel.app IS our staging environment, served on Vercel's "Production" channel. The label
  // describes a deployment channel, not a database, so the gate is indifferent to it — and instead refuses on the
  // identity facts, which a copy of this configuration to another project cannot satisfy.
  it("is indifferent to the Vercel channel label", () => {
    for (const label of [{ VERCEL_ENV: "production" }, { VERCEL_ENV: "preview" }, { NODE_ENV: "production" }]) {
      expect(buildRealCallbackRunner(deps(), okEnv(label)).ok, JSON.stringify(label)).toBe(true);
    }
  });

  it("refuses when the environment does not identify itself as staging", () => {
    expect(buildRealCallbackRunner(deps(), okEnv({ IDCADDIE_ENVIRONMENT: undefined })))
      .toEqual({ ok: false, reason: "environment_marker_missing" });
  });

  it("refuses when copied to a different Vercel project", () => {
    expect(buildRealCallbackRunner(deps(), okEnv({ IDCADDIE_VERCEL_PROJECT_ID: "prj_ANOTHERPROJECT000000000" })))
      .toEqual({ ok: false, reason: "vercel_project_mismatch" });
  });

  it("refuses when pointed at a different Supabase project", () => {
    expect(buildRealCallbackRunner(deps(), okEnv({ NEXT_PUBLIC_SUPABASE_URL: `https://${"otherproject"}.supabase.co` })))
      .toEqual({ ok: false, reason: "supabase_project_mismatch" });
  });

  it("refuses when the runner's own credential is present in this tier", () => {
    expect(buildRealCallbackRunner(deps(), okEnv({ SOME_DB_URL: "postgresql://connector_runner_login:not-a-real-token@h/db" })))
      .toEqual({ ok: false, reason: "runner_credential_present" });
  });

  it("refuses a callback host that is not on the allowlist, rather than falling back to the default", () => {
    const r = buildRealCallbackRunner(deps(), okEnv({ CONNECTOR_OAUTH_REDIRECT_URI: "https://evil.example/connectors/oauth/callback" }));
    // The identity gate pins the exact callback and runs first, so this is refused before the allowlist is consulted.
    expect(r).toEqual({ ok: false, reason: "callback_uri_mismatch" });
  });

  it("refuses when no workspace is configured — unset must not mean 'any workspace'", () => {
    const r = buildRealCallbackRunner(deps(), okEnv({ CONNECTOR_OAUTH_EXPECTED_SLACK_TEAM_ID: undefined }));
    expect(r).toEqual({ ok: false, reason: "expected_workspace_missing" });
  });

  it("refuses a malformed workspace id", () => {
    const r = buildRealCallbackRunner(deps(), okEnv({ CONNECTOR_OAUTH_EXPECTED_SLACK_TEAM_ID: "not-a-team" }));
    expect(r).toEqual({ ok: false, reason: "expected_workspace_missing" });
  });

  it.each(["CONNECTOR_OAUTH_EXPECTED_TENANT_ID", "CONNECTOR_OAUTH_EXPECTED_CONNECTOR_ID", "CONNECTOR_OAUTH_EXPECTED_CORRELATION_ID"])(
    "refuses when %s is missing — there is no default tenant, connector or correlation",
    (key) => {
      const r = buildRealCallbackRunner(deps(), okEnv({ [key]: undefined }));
      expect(r).toEqual({ ok: false, reason: "expected_context_missing" });
    },
  );

  it("refuses a missing client id", () => {
    const r = buildRealCallbackRunner(deps(), okEnv({ SLACK_CLIENT_ID: undefined }));
    expect(r).toEqual({ ok: false, reason: "slack_client_id_missing" });
  });

  it("refuses if the production project ref appears in any real-run input", () => {
    const r = buildRealCallbackRunner(deps(), okEnv({ CONNECTOR_OAUTH_EXPECTED_TENANT_ID: "dzbfxulvxchdemcettrx" }));
    expect(r).toEqual({ ok: false, reason: "production_supabase_ref_present" });
  });

  it("assembles when every server-trusted input is present", () => {
    const r = buildRealCallbackRunner(deps(), okEnv());
    expect(r.ok).toBe(true);
  });

  it("never surfaces an env value, host or id in a refusal reason", () => {
    const r = buildRealCallbackRunner(deps(), okEnv({ CONNECTOR_OAUTH_REDIRECT_URI: "https://secret-host.example/connectors/oauth/callback" }));
    expect(JSON.stringify(r)).not.toMatch(/secret-host|1234\.5678|aaaa1111/);
  });
});

describe("real-mode state binding is not weakened", () => {
  const build = () => {
    const b = buildRealCallbackRunner({ ...deps(), signer: SIGNER }, okEnv());
    if (!b.ok) throw new Error(`build failed: ${b.reason}`);
    return b;
  };

  it.each([
    ["tenant", { tenantId: "bbbb2222-0000-4000-8000-00000000cccc" }],
    ["connector", { connectorId: "9999cde3-0000-4000-8000-00000000dddd" }],
    ["correlation", { correlationId: "corr-someone-elses" }],
    ["redirect", { redirectUri: "https://staging.idcaddie.com/connectors/oauth/callback" }],
  ] as const)("a state bound to a different %s is refused at VALIDATE — Slack is never reached", async (_label, wrong) => {
    const res = await build().run({ state: stateFor(wrong), code: "code-1", subject: "user-1" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.stage).toBe("validate");
  });

  it("a state for a different SUBJECT is refused (session binding)", async () => {
    const res = await build().run({ state: stateFor(), code: "code-1", subject: "someone-else" });
    expect(res).toEqual({ ok: false, stage: "validate", reason: "subject_mismatch" });
  });

  it("an expired state is refused before the exchange", async () => {
    const stale = stateFor({}, 1, Date.now() - 60_000);
    const res = await build().run({ state: stale, code: "code-1", subject: "user-1" });
    expect(res).toEqual({ ok: false, stage: "validate", reason: "expired" });
  });

  it("a tampered state fails the signature check", async () => {
    const good = stateFor();
    const tampered = `${good.slice(0, -3)}${good.slice(-3) === "AAA" ? "BBB" : "AAA"}`;
    const res = await build().run({ state: tampered, code: "code-1", subject: "user-1" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.stage).toBe("validate");
  });

  it("a valid state with no code never reaches the exchange", async () => {
    const res = await build().run({ state: stateFor(), subject: "user-1" });
    expect(res).toEqual({ ok: false, stage: "validate", reason: "missing_code" });
  });

  it("a REPLAYED state is denied by the durable single-use gate, and the code is never presented twice", async () => {
    const su = singleUseConsumer();
    let slackCalls = 0;
    const b = buildRealCallbackRunner(
      { ...deps(), signer: SIGNER, pendingConsumer: su.consumer as never,
        httpClient: (async () => { slackCalls++; throw new Error("network blocked in test"); }) as unknown as SlackHttpClient },
      okEnv(),
    );
    if (!b.ok) throw new Error("build failed");
    const state = stateFor();

    // First use consumes the pending row and proceeds past the replay gate (the exchange then fails, by design here).
    const first = await b.run({ state, code: "code-1", subject: "user-1" });
    expect(su.consumed.has(CORR)).toBe(true);
    expect(first.ok).toBe(false);
    const callsAfterFirst = slackCalls;

    // Replay: the row is already consumed → refused at VALIDATE, and Slack is NOT called again.
    const replay = await b.run({ state, code: "code-1", subject: "user-1" });
    expect(replay.ok).toBe(false);
    if (!replay.ok) expect(replay.stage).toBe("validate");
    expect(slackCalls).toBe(callsAfterFirst);
  });
});

// ── The workspace binding itself ────────────────────────────────────────────────────────────────────────
const exchangeDeps = (over: Partial<{ body: unknown; httpOk: boolean; store: ExchangeStoreHandoff; throws: Error }> = {}) => {
  const httpClient: SlackHttpClient = async () => {
    if (over.throws) throw over.throws;
    return { ok: over.httpOk ?? true, status: 200, json: async () => over.body ?? { ok: true, access_token: "xoxb-fake", token_type: "bot", team: { id: TEAM, name: "Controlled" } } };
  };
  return {
    httpClient,
    clientId: "1234.5678",
    clientSecret: { read: async () => "fake-client-secret" },
    store: over.store ?? (async () => ({ ok: true as const, ref: { secretId: "sec-1" } })),
  };
};
const input = (over: Record<string, unknown> = {}) => ({
  code: "code-1", redirectUri: REDIRECT, tenantId: TENANT, connectorId: CONNECTOR, version: 1,
  correlationId: CORR, expectedTeamId: TEAM, ...over,
});

describe("exchange — Slack workspace binding", () => {
  it("accepts the authorized workspace", async () => {
    const r = await exchangeSlackOAuthCode(input(), exchangeDeps());
    expect(r).toEqual({ ok: true, ref: { secretId: "sec-1" } });
  });

  it("refuses a token for a DIFFERENT workspace, and never stores it", async () => {
    let stored = false;
    const r = await exchangeSlackOAuthCode(
      input(),
      exchangeDeps({
        body: { ok: true, access_token: "xoxb-fake", token_type: "bot", team: { id: "T9OTHERWORKSPACE", name: "Someone else" } },
        store: async () => { stored = true; return { ok: true, ref: {} }; },
      }),
    );
    expect(r).toEqual({ ok: false, reason: "workspace_mismatch" });
    // The load-bearing half: refused BEFORE the store, so a wrong-workspace token never reaches the vault.
    expect(stored).toBe(false);
  });

  it("refuses when the response names no workspace at all", async () => {
    const r = await exchangeSlackOAuthCode(input(), exchangeDeps({ body: { ok: true, access_token: "xoxb-fake", token_type: "bot" } }));
    expect(r).toEqual({ ok: false, reason: "missing_workspace" });
  });

  it("compares the team ID, not the team name", async () => {
    const r = await exchangeSlackOAuthCode(
      input(),
      exchangeDeps({ body: { ok: true, access_token: "xoxb-fake", token_type: "bot", team: { id: "T9OTHER", name: "Controlled" } } }),
    );
    expect(r).toEqual({ ok: false, reason: "workspace_mismatch" });
  });

  it("a Slack error is sanitized into a static reason", async () => {
    const r = await exchangeSlackOAuthCode(input(), exchangeDeps({ body: { ok: false, error: "invalid_code_with_context" } }));
    expect(r).toEqual({ ok: false, reason: "slack_error" });
    expect(JSON.stringify(r)).not.toMatch(/invalid_code_with_context/);
  });

  it("a timeout or network failure fails closed without surfacing the cause", async () => {
    const r = await exchangeSlackOAuthCode(input(), exchangeDeps({ throws: Object.assign(new Error("connect ETIMEDOUT 1.2.3.4:443"), { name: "AbortError" }) }));
    expect(r).toEqual({ ok: false, reason: "exchange_http_error" });
    expect(JSON.stringify(r)).not.toMatch(/ETIMEDOUT|1\.2\.3\.4/);
  });

  it("a token-store failure can never be reported as success", async () => {
    for (const store of [
      (async () => ({ ok: false as const })) as ExchangeStoreHandoff,
      (async () => { throw new Error("kms unavailable"); }) as ExchangeStoreHandoff,
    ]) {
      const r = await exchangeSlackOAuthCode(input(), exchangeDeps({ store }));
      expect(r).toEqual({ ok: false, reason: "store_failed" });
    }
  });

  it("never returns the bot token or the client secret on any path", async () => {
    const results = [
      await exchangeSlackOAuthCode(input(), exchangeDeps()),
      await exchangeSlackOAuthCode(input(), exchangeDeps({ body: { ok: true, access_token: "xoxb-fake", token_type: "bot", team: { id: "T9OTHER" } } })),
    ];
    for (const r of results) expect(JSON.stringify(r)).not.toMatch(/xoxb-|fake-client-secret/);
  });
});

describe("callback allowlist", () => {
  it("accepts the allowlisted staging callbacks", () => {
    for (const host of ["idcaddie-v3.vercel.app", "staging.idcaddie.com"])
      expect(realConnectorOAuthRedirectUri({ CONNECTOR_OAUTH_REDIRECT_URI: `https://${host}/connectors/oauth/callback` }))
        .toBe(`https://${host}/connectors/oauth/callback`);
  });

  it("rejects a shape-valid URL anywhere else", () => {
    // REDIRECT_RE accepts every one of these; the allowlist is what makes them refusals.
    for (const bad of [
      "https://attacker.example/connectors/oauth/callback",
      "https://idcaddie-v3.vercel.app.attacker.example/connectors/oauth/callback",
      "https://staging-idcaddie.com/connectors/oauth/callback",
    ])
      expect(() => realConnectorOAuthRedirectUri({ CONNECTOR_OAUTH_REDIRECT_URI: bad })).toThrow(ConnectorOAuthHostError);
  });

  it("only accepts a well-formed Slack team id", () => {
    expect(expectedSlackTeamId({ CONNECTOR_OAUTH_EXPECTED_SLACK_TEAM_ID: TEAM })).toBe(TEAM);
    for (const bad of [undefined, "", "t0abcdef", "XABCDEF", "T"])
      expect(expectedSlackTeamId({ CONNECTOR_OAUTH_EXPECTED_SLACK_TEAM_ID: bad })).toBeNull();
  });
});
