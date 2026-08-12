// Phase 8K — the real callback: what it does, and the much longer list of what it must not.
//
// The load-bearing property is that a successful handoff is NOT a successful connection. Everything else here — the
// state binding, the seal, the assertion — is upstream of that one sentence, and every assertion below either proves a
// refusal happens or proves nothing was claimed that had not happened.

import { describe, it, expect, vi } from "vitest";
import { generateKeyPairSync, type KeyObject } from "node:crypto";
import { createHmacStateSigner, createOAuthState, type OAuthStateContext } from "./oauth-state";
import { parseWorkerSealKey } from "./oauth-payload-seal";
import { HANDOFF_PROTOCOL_VERSION, HANDOFF_REDIRECT_URI, canonicalHandoffBody, handoffRequestSchema } from "./oauth-handoff-protocol";
import {
  PENDING_PATH,
  handleHandoffCallback,
  makeHandoffCallbackRunner,
  type HandoffCallbackDeps,
  type HandoffCallbackRunner,
} from "./oauth-callback-handoff";
import { STAGING_VERCEL_PROJECT_ID, STAGING_VERCEL_TEAM_ID } from "./oauth-handoff-protocol";

const spki = (key: KeyObject) => (key.export({ format: "der", type: "spki" }) as Buffer).toString("base64");
const workerKeyPair = generateKeyPairSync("x25519");
const workerKey = parseWorkerSealKey(spki(workerKeyPair.publicKey), "worker-seal-v1");

const NOW = 1_800_000_000_000;
const SUBJECT = "11111111-2222-3333-4444-555555555555";
const TENANT = "aaaa1111-1111-1111-1111-111111111111";
const CONNECTOR = "1575cde3-0000-4000-8000-00000000bbbb";
const CORR = "corr-live-run-1";
const TEAM = "T0ABCDEF123";
const AUDIENCE = "https://idcaddie.example/oauth-completion-worker";
const CODE = "1234567890123.9876543210987.abcdef0123456789abcdef0123456789abcdef01";

const signer = createHmacStateSigner("state-secret-not-real", "k1");
const b64url = (s: string) => Buffer.from(s).toString("base64url");
const assertion = (over: Record<string, unknown> = {}) =>
  `${b64url(JSON.stringify({ alg: "RS256", kid: "k" }))}.${b64url(JSON.stringify({
    // The full six-claim identity the preflight pins (Phase 8R). Incomplete claims would fail the preflight here for
    // the wrong reason and mask whatever the test is actually about.
    aud: AUDIENCE,
    iss: "https://oidc.vercel.com/idc-projects-f977cea1",
    sub: "owner:idc-projects-f977cea1:project:idcaddie-v3:environment:production",
    environment: "production",
    project_id: STAGING_VERCEL_PROJECT_ID, owner_id: STAGING_VERCEL_TEAM_ID, exp: Math.floor(NOW / 1000) + 600, ...over,
  }))}.${b64url("signature-bytes")}`;

const stateContext = (over: Partial<OAuthStateContext> = {}): OAuthStateContext => ({
  tenantId: TENANT,
  connectorId: CONNECTOR,
  provider: "slack",
  subject: SUBJECT,
  redirectIntent: "connect",
  redirectUri: HANDOFF_REDIRECT_URI,
  correlationId: CORR,
  ...over,
});
const validState = (over: Partial<OAuthStateContext> = {}) =>
  createOAuthState(stateContext(over), { signer, ttlSeconds: 600, now: NOW }).state;

const accepted = async () => new Response(JSON.stringify({ version: HANDOFF_PROTOCOL_VERSION, status: "accepted" }), { status: 200 });

function deps(over: Partial<HandoffCallbackDeps> = {}): HandoffCallbackDeps {
  return {
    signer,
    expected: { tenantId: TENANT, connectorId: CONNECTOR, correlationId: CORR, expectedTeamId: TEAM, redirectUri: HANDOFF_REDIRECT_URI },
    config: { endpoint: "https://worker.internal.example/internal/oauth-completion/handoff", audience: AUDIENCE, workerKey },
    readAssertion: async () => ({ ok: true, token: assertion() } as const),
    fetchImpl: accepted,
    now: () => NOW,
    ...over,
  };
}

describe("the handoff callback runner", () => {
  it("validates, seals and hands off — reporting PENDING, never a connection", async () => {
    const fetchImpl = vi.fn(accepted);
    const r = await makeHandoffCallbackRunner(deps({ fetchImpl }))({ state: validState(), code: CODE, subject: SUBJECT });
    expect(r).toEqual({ ok: true, correlationId: CORR, outcome: "accepted" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    // The body is the canonical protocol request, and it carries an opaque envelope rather than the code.
    const body = (fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1].body as string;
    const parsed = handoffRequestSchema.parse(JSON.parse(body));
    expect(canonicalHandoffBody(parsed)).toBe(body);
    expect(parsed).toMatchObject({ tenantId: TENANT, connectorId: CONNECTOR, correlationId: CORR, provider: "slack", expectedTeamId: TEAM });
    expect(body).not.toContain(CODE);
    expect(Buffer.from(parsed.protectedPayload, "base64").toString("latin1")).not.toContain(CODE);
  });

  it("reports a duplicate as a real outcome — the job exists, so the browser belongs on the pending page", async () => {
    const r = await makeHandoffCallbackRunner(deps({
      fetchImpl: async () => new Response(JSON.stringify({ version: HANDOFF_PROTOCOL_VERSION, status: "duplicate" }), { status: 409 }),
    }))({ state: validState(), code: CODE, subject: SUBJECT });
    expect(r).toEqual({ ok: true, correlationId: CORR, outcome: "duplicate" });
  });

  it("refuses every state binding mismatch BEFORE the code is touched", async () => {
    const fetchImpl = vi.fn(accepted);
    const run = makeHandoffCallbackRunner(deps({ fetchImpl }));
    const cases: Array<[string, Awaited<ReturnType<typeof run>>["ok"] extends never ? never : Parameters<typeof run>[0], string]> = [
      ["missing state", { code: CODE, subject: SUBJECT }, "missing_state"],
      ["forged signature", { state: `${validState()}x`, code: CODE, subject: SUBJECT }, "bad_signature"],
      ["another subject", { state: validState(), code: CODE, subject: "99999999-9999-9999-9999-999999999999" }, "subject_mismatch"],
      ["another tenant", { state: validState({ tenantId: "bbbb2222-2222-2222-2222-222222222222" }), code: CODE, subject: SUBJECT }, "tenant_mismatch"],
      ["another connector", { state: validState({ connectorId: "bbbb2222-2222-2222-2222-222222222222" }), code: CODE, subject: SUBJECT }, "connector_mismatch"],
      ["another provider", { state: validState({ provider: "okta" }), code: CODE, subject: SUBJECT }, "provider_mismatch"],
      ["another redirect", { state: validState({ redirectUri: "https://attacker.example/connectors/oauth/callback" }), code: CODE, subject: SUBJECT }, "redirect_uri_mismatch"],
      ["another correlation", { state: validState({ correlationId: "corr-some-other-run" }), code: CODE, subject: SUBJECT }, "correlation_mismatch"],
    ];
    for (const [name, input, reason] of cases) {
      expect(await run(input), name).toEqual({ ok: false, reason });
    }
    expect(fetchImpl, "nothing may be handed off on a failed binding").not.toHaveBeenCalled();
  });

  it("refuses an expired state", async () => {
    const state = createOAuthState(stateContext(), { signer, ttlSeconds: 60, now: NOW });
    const r = await makeHandoffCallbackRunner(deps({ now: () => NOW + 61_000 }))({ state: state.state, code: CODE, subject: SUBJECT });
    expect(r).toEqual({ ok: false, reason: "expired" });
  });

  it("refuses when the provider itself reported an error, and never surfaces its value", async () => {
    const r = await makeHandoffCallbackRunner(deps())({ state: validState(), code: CODE, providerError: "access_denied", subject: SUBJECT });
    expect(r).toEqual({ ok: false, reason: "provider_reported_error" });
  });

  it("refuses a missing or unusable authorization code", async () => {
    const run = makeHandoffCallbackRunner(deps());
    expect(await run({ state: validState(), subject: SUBJECT })).toEqual({ ok: false, reason: "authorization_code_missing" });
    expect(await run({ state: validState(), code: "", subject: SUBJECT })).toEqual({ ok: false, reason: "authorization_code_missing" });
    expect(await run({ state: validState(), code: "code with spaces", subject: SUBJECT })).toEqual({ ok: false, reason: "authorization_code_invalid" });
  });

  it("refuses when the configured callback is not the pinned one, even with a state that agrees with it", async () => {
    // The state is minted for the SAME non-pinned URI, so `validateOAuthState` would be perfectly happy: this proves the
    // pinning check itself, not the state binding underneath it. Without the check the body would be sealed with the
    // pinned redirect while the code was actually issued against a different one — an envelope the worker can open and
    // a job the database would then reject. Mutation testing found the earlier version of this test unable to tell the
    // two apart, because both paths return the same reason code.
    const other = "https://staging.idcaddie.com/connectors/oauth/callback";
    const fetchImpl = vi.fn(accepted);
    const r = await makeHandoffCallbackRunner(deps({
      fetchImpl,
      expected: { tenantId: TENANT, connectorId: CONNECTOR, correlationId: CORR, expectedTeamId: TEAM, redirectUri: other },
    }))({ state: validState({ redirectUri: other }), code: CODE, subject: SUBJECT });
    expect(r).toEqual({ ok: false, reason: "redirect_uri_mismatch" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("refuses without an OIDC assertion, and hands nothing off", async () => {
    const fetchImpl = vi.fn(accepted);
    const r = await makeHandoffCallbackRunner(deps({ readAssertion: async () => ({ ok: false, reason: "handoff_assertion_missing" } as const), fetchImpl }))({ state: validState(), code: CODE, subject: SUBJECT });
    expect(r).toEqual({ ok: false, reason: "handoff_assertion_missing" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("refuses an assertion for the wrong audience or project, and hands nothing off", async () => {
    const fetchImpl = vi.fn(accepted);
    expect(await makeHandoffCallbackRunner(deps({ readAssertion: async () => ({ ok: true, token: assertion({ aud: "https://vercel.com/idcaddie" }) } as const), fetchImpl }))(
      { state: validState(), code: CODE, subject: SUBJECT },
    )).toEqual({ ok: false, reason: "handoff_assertion_audience_mismatch" });
    expect(await makeHandoffCallbackRunner(deps({ readAssertion: async () => ({ ok: true, token: assertion({ project_id: "prj_OTHER" }) } as const), fetchImpl }))(
      { state: validState(), code: CODE, subject: SUBJECT },
    )).toEqual({ ok: false, reason: "handoff_assertion_project_mismatch" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("surfaces a handoff failure as a bounded reason, with nothing of the attempt in it", async () => {
    const r = await makeHandoffCallbackRunner(deps({
      fetchImpl: async () => { throw new Error(`connect ECONNREFUSED worker.internal.example LEAKME`); },
    }))({ state: validState(), code: CODE, subject: SUBJECT });
    expect(r).toEqual({ ok: false, reason: "handoff_transport_failed" });
    expect(JSON.stringify(r)).not.toMatch(/LEAKME|ECONNREFUSED|internal\.example/);
  });

  it("never places the authorization code in ANY result", async () => {
    const run = makeHandoffCallbackRunner(deps({ fetchImpl: async () => new Response("nope", { status: 500 }) }));
    for (const input of [
      { state: validState(), code: CODE, subject: SUBJECT },
      { state: "forged", code: CODE, subject: SUBJECT },
      { state: validState(), code: `${CODE}!!!`, subject: SUBJECT },
    ]) {
      const r = await run(input);
      expect(JSON.stringify(r)).not.toContain(CODE);
    }
  });
});

// ── The request-path handler ─────────────────────────────────────────────────────────────────────────────────────────
const callbackUrl = (params: Record<string, string>) =>
  `https://idcaddie-v3.vercel.app/connectors/oauth/callback?${new URLSearchParams(params).toString()}`;

describe("the callback handler", () => {
  const runOk: HandoffCallbackRunner = async () => ({ ok: true, correlationId: CORR, outcome: "accepted" });

  // WHAT THE HANDLER HANDS THE RUNNER. Every other test in this block stubs `run` with a function that ignores its
  // argument, so the parse-and-forward step was entirely unproven: forwarding a request-supplied `?sub=` instead of the
  // resolved session subject would defeat the state's subject binding — user B completing user A's callback — and no
  // test would have noticed. (Found in adversarial review of PR #398.)
  it("forwards the parsed query and the RESOLVED session subject, and nothing else", async () => {
    const run = vi.fn(runOk);
    const state = validState();
    await handleHandoffCallback(
      // `sub` and `subject` are decoys: nothing request-supplied may become the authenticated subject.
      new Request(callbackUrl({ code: CODE, state, error: "access_denied", sub: "99999999-9999-9999-9999-999999999999", subject: "attacker" })),
      { resolveSubject: async () => SUBJECT, run },
    );
    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0][0]).toEqual({ state, code: CODE, providerError: "access_denied", subject: SUBJECT });
  });

  it("forwards absent query parameters as undefined rather than inventing them", async () => {
    const run = vi.fn(runOk);
    await handleHandoffCallback(new Request("https://idcaddie-v3.vercel.app/connectors/oauth/callback"), {
      resolveSubject: async () => SUBJECT,
      run,
    });
    expect(run.mock.calls[0][0]).toEqual({ state: undefined, code: undefined, providerError: undefined, subject: SUBJECT });
  });

  it("sends the browser to the PENDING page — never to a success page", async () => {
    const res = await handleHandoffCallback(new Request(callbackUrl({ code: CODE, state: validState() })), {
      resolveSubject: async () => SUBJECT,
      run: runOk,
    });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(`${PENDING_PATH}?c=${CORR}`);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("location")).not.toMatch(/success|connected/i);
  });

  it("fails closed without a session, before running anything", async () => {
    const run = vi.fn(runOk);
    for (const resolveSubject of [async () => null, async () => "", async () => { throw new Error("session backend down"); }]) {
      const res = await handleHandoffCallback(new Request(callbackUrl({ code: CODE })), { resolveSubject, run });
      expect(res.status).toBe(303);
      expect(res.headers.get("location")).toBe("/connectors?oauth=error&reason=session_required");
    }
    expect(run).not.toHaveBeenCalled();
  });

  it("turns a refusal into a bounded error redirect carrying only the code", async () => {
    const res = await handleHandoffCallback(new Request(callbackUrl({ code: CODE })), {
      resolveSubject: async () => SUBJECT,
      run: async () => ({ ok: false, reason: "handoff_transport_failed" }),
    });
    expect(res.headers.get("location")).toBe("/connectors?oauth=error&reason=handoff_transport_failed");
  });

  it("never echoes the code, state or provider error into the response", async () => {
    const state = validState();
    const res = await handleHandoffCallback(
      new Request(callbackUrl({ code: CODE, state, error: "access_denied_LEAKME" })),
      { resolveSubject: async () => SUBJECT, run: async () => ({ ok: false, reason: "provider_reported_error" }) },
    );
    const serialized = `${res.headers.get("location")}\n${[...res.headers].join()}\n${await res.text()}`;
    expect(serialized).not.toContain(CODE);
    expect(serialized).not.toContain(state);
    expect(serialized).not.toContain("LEAKME");
  });

  it("survives a thrown runner without leaking anything", async () => {
    const res = await handleHandoffCallback(new Request(callbackUrl({ code: CODE })), {
      resolveSubject: async () => SUBJECT,
      run: async () => { throw new Error(`boom ${CODE}`); },
    });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).not.toContain(CODE);
  });

  it("never contacts Slack — the only outbound call is the handoff", () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fs = require("node:fs") as typeof import("node:fs");
    // Comments are stripped first: this module's own documentation says out loud that it does not call `oauth.v2.access`,
    // and a guard that cannot tell prose from code would flag the sentence describing the property it is checking.
    const code = fs
      .readFileSync("src/lib/server/connector-vault/oauth-callback-handoff.ts", "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    expect(code).not.toMatch(/slack\.com|oauth\.v2\.access|slack-oauth-exchange|slack-http-client|withSlackClientSecret/);
    expect(code).not.toMatch(/oauth-callback-orchestrator|oauth-real-exchange-wiring|connector-secret|kms/i);
    // …and the comment-stripping itself works, so the assertions above are not passing on an empty string.
    expect(code).toMatch(/makeHandoffCallbackRunner/);
    expect(code.length).toBeGreaterThan(1000);
  });
});
