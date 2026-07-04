// RISK-007 RUN GATE A — the AUTHORIZE (front) half. Staging-only, server-only, INERT: it builds the Slack authorize URL +
// persists the single-use oauth_pending replay row via an INJECTED inserter (tests inject a fake — no hosted DB), and
// emits ONLY safe metadata for the operator to paste into the runner task. It NEVER calls Slack, NEVER exchanges a code,
// NEVER reads a secret (the signer is injected). The persisted `oauth_pending.state_jti = corr` — the SAME key the runner
// consume (makeReplayConsume) matches on — so the two halves are aligned (this is the contract the state_jti fix pins).
//
// Output is the aligned triple the operator needs: the authorize URL, the signed `state` (→ CONNECTOR_OAUTH_CALLBACK_STATE
// task env), and the expectedContext env (→ IDCADDIE_RUNNER_RUN_GATE_A_TENANT_ID/CONNECTOR_ID/SUBJECT/CORRELATION_ID).
// No client secret / OAuth code / bot token / DB URL is produced or accepted. RISK-007 remains OPEN; RUN GATE A PENDING.

import { randomUUID } from "node:crypto";
import { persistSlackAuthorizePending, type SlackPendingInserter, type SlackAuthorizePersistReason } from "./providers/slack-authorize-pending";
import type { OAuthStateSigner } from "./oauth-state";

const PRODUCTION_REF = "dzbfxulvxchdemcettrx"; // must NEVER appear

export type RunGateAAuthorizeConfig = {
  appEnv: string; // MUST be "staging"
  tenantId: string;
  connectorId?: string | null; // null for a fresh connect
  subject: string; // the initiating actor (bound into the state)
  clientId: string; // the Slack DEV app client_id
  redirectUri: string; // https, staging
  correlationId?: string; // optional — a fresh unique corr is generated if absent (state_jti must be unique)
  now?: number;
  ttlSeconds?: number;
  scopes?: readonly string[];
  nonce?: string; // deterministic tests only
};

export type RunGateAAuthorizeResult =
  | {
      ok: true;
      url: string; // the Slack authorize URL the operator opens on the disposable DEV workspace
      callbackState: string; // the signed state → CONNECTOR_OAUTH_CALLBACK_STATE (a signed single-use token, not a secret)
      correlationId: string; // = oauth_pending.state_jti = the runner consume key
      expiresAt: number;
      taskEnv: Record<string, string>; // the aligned expectedContext env for the runner task (safe metadata)
    }
  | { ok: false; reason: SlackAuthorizePersistReason | "not_staging" | "production_ref" | "missing_state" };

// Prepare RUN GATE A: build the authorize URL + persist the aligned oauth_pending row. Fails closed on non-staging, a
// production ref, or any builder/insert error. Emits ONLY safe metadata.
export async function prepareRunGateAAuthorize(
  config: RunGateAAuthorizeConfig,
  deps: { signer: OAuthStateSigner; inserter: SlackPendingInserter },
): Promise<RunGateAAuthorizeResult> {
  if (config.appEnv !== "staging") return { ok: false, reason: "not_staging" };
  if (
    config.redirectUri?.includes(PRODUCTION_REF) ||
    config.tenantId?.includes(PRODUCTION_REF) ||
    (config.connectorId ?? "").includes(PRODUCTION_REF)
  )
    return { ok: false, reason: "production_ref" };

  const correlationId = config.correlationId ?? randomUUID(); // unique corr ⇒ unique state_jti (UNIQUE(state_jti))
  const res = await persistSlackAuthorizePending(
    {
      tenantId: config.tenantId,
      connectorId: config.connectorId ?? null,
      subject: config.subject,
      correlationId,
      clientId: config.clientId,
      redirectUri: config.redirectUri,
      signer: deps.signer,
      now: config.now ?? Date.now(),
      ttlSeconds: config.ttlSeconds,
      scopes: config.scopes,
      nonce: config.nonce,
    },
    deps.inserter,
  );
  if (!res.ok) return { ok: false, reason: res.reason };

  const callbackState = new URL(res.url).searchParams.get("state") ?? "";
  if (!callbackState) return { ok: false, reason: "missing_state" }; // defensive — the builder always sets it
  return {
    ok: true,
    url: res.url,
    callbackState,
    correlationId,
    expiresAt: res.expiresAt,
    taskEnv: {
      IDCADDIE_RUNNER_RUN_GATE_A_TENANT_ID: config.tenantId,
      IDCADDIE_RUNNER_RUN_GATE_A_CONNECTOR_ID: config.connectorId ?? "",
      IDCADDIE_RUNNER_RUN_GATE_A_SUBJECT: config.subject,
      IDCADDIE_RUNNER_RUN_GATE_A_CORRELATION_ID: correlationId,
      CONNECTOR_OAUTH_CALLBACK_STATE: callbackState,
    },
  };
}
