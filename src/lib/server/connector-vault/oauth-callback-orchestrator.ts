// Server-only SYNTHETIC OAuth callback orchestration (PR B2c-wire — RISK-007, docs/42 §90). MOCKED/SYNTHETIC ONLY.
//
// Composes the three already-proven pieces into ONE callback path, with B2a validation as the authoritative GATE:
//
//     B2a validateOAuthState  ──(only if ok)──▶  B2b exchangeSlackOAuthCode (mocked)  ──▶  B1 store/encrypt handoff
//
// This is a PURE FUNCTION orchestrator — NOT a route. There is no production OAuth callback route, no real Slack
// network call (the http client + client-secret provider are injected, mocked in tests), no real token, no real
// client secret, no request-path decrypt, no production enablement. B2c-wire only wires the synthetic flow; the
// real client-secret store (B2c-secret) and the first real-token event (B2c-run) are SEPARATE, future, explicitly-
// authorized steps. RISK-001 / RISK-007 remain OPEN.
//
// SINGLE SOURCE OF TRUTH: after validation succeeds, the security-bound fields the orchestrator threads downstream —
// tenant, connector, provider (Slack), exact redirect, correlation — come ONLY from the VALIDATED state payload
// (`v.payload`), NEVER re-read from the untrusted callback query. The untrusted query is read ONLY for `state` +
// `code` (the artifacts validation/exchange consume); any other query field (a tenant/connector/provider decoy) is
// ignored. This makes a self-consistent-but-mismatched request unable to redirect the store to a different tenant.
//
// CAUSAL GATING: `validateOAuthState`'s `ok` is the ONLY thing that unlocks the exchange. Validation is authoritative
// (its `payload` drives the data flow), not advisory. The exchange stage is unreachable for any state that did not
// pass validation, and the store stage is unreachable for any exchange that did not succeed (the latter enforced
// inside B2b, which never returns the token).
//
// SERVER-ONLY: under `src/lib/server/`, the runtime browser sentinel below, and `no-client-import.test.ts`.

import {
  validateOAuthState,
  type OAuthStateContext,
  type OAuthStateSigner,
  type ConsumedNonceStore,
} from "./oauth-state";
import {
  exchangeSlackOAuthCode,
  type SlackHttpClient,
  type ClientSecretProvider,
  type ExchangeStoreHandoff,
} from "./slack-oauth-exchange";
import {
  ingestStagingConnectorSecret,
  ALLOWED_INGEST_PROVIDER,
  ALLOWED_INGEST_CREDENTIAL_KIND,
  type StagingConnectorSecretIngestDeps,
} from "./connector-secret-ingest";

// Runtime server-only sentinel — throw if evaluated in a browser.
if (typeof (globalThis as { window?: unknown }).window !== "undefined") {
  throw new Error("connector-vault/oauth-callback-orchestrator is server-only and must not be imported in client code");
}

// The untrusted callback query. ONLY `state` + `code` are ever read; security-bound fields come from validated state.
export type SyntheticCallbackQuery = Record<string, string | undefined>;

export type OrchestratorDeps = {
  // B2a — the GATE. `expectedContext` MUST be server-trusted (subject from the resolved session, redirect from
  // server config via `serverTrustedRedirectUri`, tenant/connector/provider/correlation from the server-side
  // oauth_pending lookup), NEVER reconstructed from the callback query.
  expectedContext: OAuthStateContext;
  signer: OAuthStateSigner;
  now: number;
  consumedNonces?: ConsumedNonceStore;
  // B2b (mocked) — the injected Slack http client + client-secret provider (never env).
  httpClient: SlackHttpClient;
  clientId: string;
  clientSecret: ClientSecretProvider;
  // B1 — the store/encrypt handoff (use `b1StoreHandoff` to wire the real ingestion; tests inject an equivalent).
  store: ExchangeStoreHandoff;
  version: number; // explicit credential version threaded to B1
};

// SAFE STATIC outcomes — a stage + a safe reason (never a token/secret/code/raw-response). `validate` reasons are the
// B2a `OAuthStateReason` set (+ `missing_code`/`connector_required`); `exchange` reasons are the B2b set.
export type OrchestratorResult =
  | { ok: true; ref: { secretId?: string } } // REDACTED — non-secret reference only
  | { ok: false; stage: "validate" | "exchange"; reason: string };

// Orchestrate one synthetic Slack OAuth callback. Validation gates exchange; the validated payload is the single
// source of truth for every downstream security-bound field. Returns a redacted ref or a safe staged failure.
export async function orchestrateSlackOAuthCallback(
  query: SyntheticCallbackQuery,
  deps: OrchestratorDeps,
): Promise<OrchestratorResult> {
  // Read ONLY state + code from the untrusted query. (Nothing else from the query drives the flow.)
  const state = typeof query?.state === "string" ? query.state : undefined;
  const code = typeof query?.code === "string" ? query.code : undefined;

  // STAGE 1 — VALIDATE (the gate). On any failure, STOP: the exchange is never called.
  const v = validateOAuthState(state, deps.expectedContext, {
    signer: deps.signer,
    now: deps.now,
    consumedNonces: deps.consumedNonces,
  });
  if (!v.ok) return { ok: false, stage: "validate", reason: v.reason };

  // The code is request-sourced but is reached ONLY after validation has gated the flow.
  if (typeof code !== "string" || code.length === 0) return { ok: false, stage: "validate", reason: "missing_code" };
  // The synthetic store wiring requires a connector-bound state (a fresh-connect with no connector is out of scope).
  if (typeof v.payload.cid !== "string" || v.payload.cid.length === 0)
    return { ok: false, stage: "validate", reason: "connector_required" };

  // STAGE 2+3 — EXCHANGE (mocked) → STORE, threading ONLY the VALIDATED payload (SSOT) + the gated code. B2b does
  // the exchange then the store handoff internally and NEVER returns the token; the store stage is unreachable if the
  // exchange fails. The orchestrator never sees the token.
  const x = await exchangeSlackOAuthCode(
    {
      code,
      redirectUri: v.payload.redir,
      tenantId: v.payload.tid,
      connectorId: v.payload.cid,
      version: deps.version,
      correlationId: v.payload.corr,
    },
    { httpClient: deps.httpClient, clientId: deps.clientId, clientSecret: deps.clientSecret, store: deps.store },
  );
  if (!x.ok) return { ok: false, stage: "exchange", reason: x.reason };

  // STAGE 4 — REDACTED success (non-secret ref only).
  return { ok: true, ref: x.ref };
}

// Adapter: wire the REAL B1 `ingestStagingConnectorSecret` as the B2b store handoff. The bot token (synthetic in
// B2c-wire) is handed to B1, encrypted envelope-only, and a redacted ref returned; ANY B1 failure (production block,
// allowlist, encrypt/store/audit) fails closed to `{ ok: false }` WITHOUT surfacing the token or the B1 error. This
// is the documented production wiring; the orchestrator/tests inject it (or a faithful equivalent).
export function b1StoreHandoff(deps: StagingConnectorSecretIngestDeps): ExchangeStoreHandoff {
  return async (i) => {
    try {
      const ref = await ingestStagingConnectorSecret(
        {
          provider: ALLOWED_INGEST_PROVIDER,
          credentialKind: ALLOWED_INGEST_CREDENTIAL_KIND,
          tenantId: i.tenantId,
          connectorId: i.connectorId,
          version: i.version,
          correlationId: i.correlationId,
          plaintext: i.plaintext,
        },
        deps,
      );
      return { ok: true, ref: { secretId: ref.secretId } };
    } catch {
      return { ok: false }; // fail closed — never surface the B1 error or the token
    }
  };
}
