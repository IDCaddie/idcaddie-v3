import { describe, it, expect } from "vitest";
import { prepareRunGateAAuthorize } from "./run-gate-a-authorize";
import { createHmacStateSigner, validateOAuthState, type OAuthStateContext } from "./oauth-state";
import { makeReplayConsume } from "./oauth-real-exchange-wiring";
import { type OAuthPendingConsumer, type OAuthPendingRowState } from "./oauth-pending-consume";
import type { SlackPendingInserter, OAuthPendingInsertRow } from "./providers/slack-authorize-pending";

// INTEGRATION across BOTH halves: the authorize front-half (prepareRunGateAAuthorize) persists an oauth_pending row, and
// the runner consume half (makeReplayConsume) finds THAT SAME row. This is the test that would have caught the
// state_jti = sha256(state) vs corr bug — it asserts the persisted key equals the validated payload.corr the consume uses.
// No Slack call, no code exchange, no secret/token/DB URL in output.

const SIGNER = createHmacStateSigner("test-state-signing-secret-32bytes-minimum-0", "test-keyid");
const NOW = 1_700_000_000_000;
const REDIRECT = "https://idcaddie-v3.vercel.app/connectors/oauth/callback";
const TENANT = "11111111-1111-1111-1111-111111111111";
const SUBJECT = "22222222-2222-2222-2222-222222222222";

// One shared in-memory oauth_pending table both halves use — the authorize INSERT and the runner CONSUME.
function makeSharedPending() {
  const rows = new Map<string, OAuthPendingInsertRow & { consumedAt: string | null }>();
  const inserter: SlackPendingInserter = {
    async insertPending(row) {
      if (rows.has(row.stateJti)) return { ok: false, reason: "duplicate" };
      rows.set(row.stateJti, { ...row, consumedAt: null });
      return { ok: true };
    },
  };
  const consumer: OAuthPendingConsumer = {
    async runAtomicConsume(p) {
      const r = rows.get(p.stateJti); // the atomic UPDATE keys on state_jti = corr
      if (!r) return null;
      if (r.tenantId !== p.tenantId || r.provider !== p.provider || (r.connectorId ?? null) !== p.connectorId || r.nonceHash !== p.nonceHash) return null;
      if (r.consumedAt != null) return null;
      if (!(Date.parse(r.expiresAt) > Date.parse(p.nowIso))) return null;
      r.consumedAt = p.nowIso;
      return { stateJti: r.stateJti, consumedAt: r.consumedAt };
    },
    async readPendingState(stateJti): Promise<OAuthPendingRowState | null> {
      const r = rows.get(stateJti);
      return r ? { tenantId: r.tenantId, provider: r.provider, connectorId: r.connectorId ?? null, nonceHash: r.nonceHash, consumedAt: r.consumedAt, expiresAt: r.expiresAt } : null;
    },
  };
  return { rows, inserter, consumer };
}

const cfg = (over: Record<string, unknown> = {}) => ({ appEnv: "staging", tenantId: TENANT, connectorId: null, subject: SUBJECT, clientId: "111.222", redirectUri: REDIRECT, now: NOW, nonce: "nonce-int", ...over });
const expectedCtx = (corr: string): OAuthStateContext => ({ tenantId: TENANT, provider: "slack", connectorId: null, subject: SUBJECT, redirectIntent: "connect", redirectUri: REDIRECT, correlationId: corr });

describe("RUN GATE A authorize<->consume integration (state_jti = corr contract)", () => {
  it("the authorize row is FOUND by the runner consume (state_jti = corr); then replay fails closed", async () => {
    const { rows, inserter, consumer } = makeSharedPending();
    const prep = await prepareRunGateAAuthorize(cfg(), { signer: SIGNER, inserter });
    expect(prep.ok).toBe(true);
    if (!prep.ok) return;
    expect(new URL(prep.url).origin).toBe("https://slack.com"); // authorize URL built (no Slack call)
    expect([...rows.keys()]).toEqual([prep.correlationId]); // persisted state_jti === corr
    expect(prep.taskEnv.CONNECTOR_OAUTH_CALLBACK_STATE).toBe(prep.callbackState);

    // runner half: validate the SAME signed state, then consume by payload.corr — must find the persisted row
    const v = validateOAuthState(prep.callbackState, expectedCtx(prep.correlationId), { signer: SIGNER, now: NOW });
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    expect(v.payload.corr).toBe(prep.correlationId); // THE binding the fix pins
    const consume = makeReplayConsume(consumer, () => NOW);
    expect((await consume(v.payload)).ok).toBe(true); // FOUND — sha256(state) would have missed here

    const replay = await consume(v.payload);
    expect(replay.ok).toBe(false);
    if (!replay.ok) expect(replay.reason).toBe("already_consumed"); // single-use, before any exchange

    const flat = JSON.stringify(prep); // no secret/token/code/DB URL in the prepared output
    for (const s of ["client_secret", "xoxb-", "postgres://", "code="]) expect(flat).not.toContain(s);
  });

  it("a corr with no persisted row fails closed as not_found (before exchange)", async () => {
    const { inserter, consumer } = makeSharedPending();
    const prep = await prepareRunGateAAuthorize(cfg(), { signer: SIGNER, inserter });
    expect(prep.ok).toBe(true);
    if (!prep.ok) return;
    const v = validateOAuthState(prep.callbackState, expectedCtx(prep.correlationId), { signer: SIGNER, now: NOW });
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    const consume = makeReplayConsume(consumer, () => NOW);
    const res = await consume({ ...v.payload, corr: "corr-never-persisted" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("not_found");
  });

  it("refuses non-staging + a production ref (fail closed, no row written)", async () => {
    const { rows, inserter } = makeSharedPending();
    expect((await prepareRunGateAAuthorize(cfg({ appEnv: "production" }), { signer: SIGNER, inserter })).ok).toBe(false);
    expect((await prepareRunGateAAuthorize(cfg({ tenantId: "t-dzbfxulvxchdemcettrx" }), { signer: SIGNER, inserter })).ok).toBe(false);
    expect(rows.size).toBe(0);
  });

  it("generates a unique corr per call when none is supplied (unique state_jti)", async () => {
    const { rows, inserter } = makeSharedPending();
    const a = await prepareRunGateAAuthorize(cfg({ nonce: "n-a" }), { signer: SIGNER, inserter });
    const b = await prepareRunGateAAuthorize(cfg({ nonce: "n-b" }), { signer: SIGNER, inserter });
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(a.correlationId).not.toBe(b.correlationId);
    expect(rows.size).toBe(2);
  });
});
