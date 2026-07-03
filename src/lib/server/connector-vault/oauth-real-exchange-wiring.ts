// Server-only REAL B2c OAuth-exchange WIRING (RISK-007, docs/50). GATED + FAIL-CLOSED — assembled but NOT executed.
//
// Hardens the trusted B2c path by ASSEMBLING the real dependency seams the synthetic orchestrator leaves injectable —
// the durable single-use REPLAY gate, the client-secret DECRYPT boundary, the real HTTP client, and the envelope-only
// STORE — into one `OrchestratorDeps`, behind an EXPLICIT operator gate. Nothing here performs a real OAuth call, a real
// KMS decrypt, a DB read, or a secret read: it only COMPOSES the pieces. The gate refuses to assemble the real path
// unless `CONNECTOR_OAUTH_REAL_EXCHANGE_ENABLED=1` and the environment is non-production. The agent + CI never set the
// flag (they test with the flag passed explicitly + FAKE deps), so a real exchange is unreachable here.
//
// The FIRST real-token run (B2c-run) is a SEPARATE, explicitly-Sam-approved step on a disposable Slack dev workspace
// (docs/50). RISK-007 remains OPEN; Phase C remains BLOCKED.
//
// SERVER-ONLY: under `src/lib/server/`, the runtime browser sentinel below, and `no-client-import.test.ts`.

import type { OrchestratorDeps } from "./oauth-callback-orchestrator";
import { b1StoreHandoff } from "./oauth-callback-orchestrator";
import { consumeOAuthPending, type OAuthPendingConsumer } from "./oauth-pending-consume";
import { hashOAuthValue } from "./oauth-pending";
import type { OAuthStateContext, OAuthStateSigner, OAuthStatePayload, ConsumedNonceStore } from "./oauth-state";
import type { ClientSecretProvider, SlackHttpClient } from "./slack-oauth-exchange";
import { withSlackClientSecret, type AppSecretEnvelopeStore } from "./slack-client-secret-store";
import type { ConnectorVaultKeyProvider } from "./crypto";
import type { StagingConnectorSecretIngestDeps } from "./connector-secret-ingest";

// Runtime server-only sentinel — throw if evaluated in a browser.
if (typeof (globalThis as { window?: unknown }).window !== "undefined") {
  throw new Error("connector-vault/oauth-real-exchange-wiring is server-only and must not be imported in client code");
}

export class RealExchangeWiringError extends Error {
  constructor(message: string) { super(message); this.name = "RealExchangeWiringError"; }
}

// THE GATE. Real exchange is assembled ONLY on an explicit opt-in AND never in production (belt-and-braces with the
// downstream ingest/prod guards). Default OFF. CI/agent never set the flag.
export function isRealExchangeEnabled(env: Record<string, string | undefined> = process.env): boolean {
  if (env.VERCEL_ENV === "production" || env.NODE_ENV === "production") return false; // never in prod
  return env.CONNECTOR_OAUTH_REAL_EXCHANGE_ENABLED === "1"; // explicit opt-in required (default off)
}

// Adapt the DB atomic single-use consume into the orchestrator's `pendingConsume(payload)` REPLAY gate. Maps ONLY the
// validated payload → the oauth_pending single-use key (nonce is hashed, never raw). A replayed/reused state → the row
// is already consumed / absent → `{ok:false, reason}` (fail closed). `now` is injectable for deterministic tests.
export function makeReplayConsume(
  consumer: OAuthPendingConsumer,
  now: () => number = () => Date.now(),
): (payload: OAuthStatePayload) => Promise<{ ok: boolean; reason?: string }> {
  return async (payload) => {
    const r = await consumeOAuthPending(
      {
        tenantId: payload.tid,
        provider: payload.prov,
        connectorId: payload.cid,
        subject: payload.sub,
        stateJti: payload.corr, // ponytail: corr IS the operation/correlation id bound at authorize-time; confirm it equals the persisted oauth_pending.state_jti before the real B2c run.
        nonceHash: hashOAuthValue(payload.nonce),
        now: now(),
      },
      consumer,
    );
    return r.ok ? { ok: true } : { ok: false, reason: r.reason };
  };
}

// The client-secret DECRYPT BOUNDARY as a `ClientSecretProvider`. `read()` decrypts the app-level client secret ONLY
// inside `withSlackClientSecret` (the server trusted boundary: runner decrypt capability + KMS + connector_app_secrets,
// buffer-wiped after use). Fails closed (throws) on not_found/decrypt_failed → the exchange records a safe reason and
// never proceeds. ponytail: `read()` returns the plaintext string the form-POST already requires; the buffer wipe still
// happens inside withSlackClientSecret. A future refactor could run the whole POST inside the closure to avoid the string.
export function makeBoundClientSecretProvider(
  identity: { appEnv: string },
  deps: { keyProvider: ConnectorVaultKeyProvider; store: AppSecretEnvelopeStore },
): ClientSecretProvider {
  return {
    read: async () => {
      const r = await withSlackClientSecret(identity, deps, async (clientSecret) => clientSecret);
      if (!r.ok) throw new RealExchangeWiringError(`client_secret_unavailable:${r.reason}`); // static reason class only
      return r.value;
    },
  };
}

// Everything the operator supplies for a real run (all server-trusted; NONE from the callback query). In this PR every
// field is injected by a FAKE in tests; a real run supplies the real signer/context/clients — a SEPARATE approved step.
export type RealExchangeConfig = {
  env?: Record<string, string | undefined>;
  expectedContext: OAuthStateContext; // server-trusted (session subject + config redirect + oauth_pending lookup)
  signer: OAuthStateSigner;
  now: number;
  consumedNonces?: ConsumedNonceStore;
  pendingConsumer: OAuthPendingConsumer; // the DB oauth_pending single-use consumer (durable replay gate)
  httpClient: SlackHttpClient; // the real Slack HTTP client (injected; never global fetch)
  clientId: string;
  clientSecretIdentity: { appEnv: string };
  clientSecretDeps: { keyProvider: ConnectorVaultKeyProvider; store: AppSecretEnvelopeStore };
  ingestDeps: StagingConnectorSecretIngestDeps; // the envelope-only store (b1StoreHandoff)
  version: number;
};

// Assemble the REAL `OrchestratorDeps`. FAIL-CLOSED: throws unless the gate is on — the real path cannot be built
// without the explicit flag. Composes the durable replay gate + the client-secret decrypt boundary + the real http
// client + the envelope-only store. Returns deps only; running them is the orchestrator's job (and a later approval).
export function makeRealOrchestratorDeps(config: RealExchangeConfig): OrchestratorDeps {
  if (!isRealExchangeEnabled(config.env))
    throw new RealExchangeWiringError("real_exchange_disabled — set CONNECTOR_OAUTH_REAL_EXCHANGE_ENABLED=1 (non-prod). INERT by default.");
  return {
    expectedContext: config.expectedContext,
    signer: config.signer,
    now: config.now,
    consumedNonces: config.consumedNonces,
    pendingConsume: makeReplayConsume(config.pendingConsumer, () => config.now),
    httpClient: config.httpClient,
    clientId: config.clientId,
    clientSecret: makeBoundClientSecretProvider(config.clientSecretIdentity, config.clientSecretDeps),
    store: b1StoreHandoff(config.ingestDeps),
    version: config.version,
  };
}
