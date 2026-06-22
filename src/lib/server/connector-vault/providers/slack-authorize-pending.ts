// Server-only SLACK authorize-time `oauth_pending` PERSISTENCE (docs/42 §50, gated vault). It composes the
// PR #127 Slack authorize-URL builder with the `oauth_pending` replay-store shape: at authorize-time it
// creates the single-use REPLAY-PROTECTION row a FUTURE callback PR consumes exactly once (PR #116/#120).
// **Slack remains non-functional for real connections.** It exchanges NO code, stores NO token/credential,
// touches NO `connector_secrets`, calls NO Slack API, marks NO connector connected, and creates NO sync run.
//
// THE INSERT IS AN INJECTED SEAM (not a request-path write). `oauth_pending` is Tier-2 deny-all to anon/
// authenticated (`0020`), and `connector_runner` was granted SELECT + UPDATE but DELIBERATELY NOT INSERT
// (`0021` deferred authorize-time create). So a request-path Supabase client CANNOT write this row, and this
// PR adds NO migration and NO global service-role client. Instead the privileged INSERT is delegated to an
// injected `SlackPendingInserter` — the runner-identity-backed inserter (with the future INSERT grant) is a
// later gated PR; tests inject a mock, so there is NO live DB write and NO credentials in tests.
//
// REDACTION: the raw nonce is NEVER materialized here (the builder returns only one-way hashes), so it can
// never be stored, returned, or logged. The persisted row carries `state_jti = sha256(state)` +
// `nonce_hash = sha256(nonce)` only (RAW state and RAW nonce are never stored). The result returns the Slack
// authorize URL (the signed `state` is the intended redirect carrier, not a secret) + safe metadata only.
//
// SERVER-ONLY: under `src/lib/server/`, the runtime browser sentinel below, and `no-client-import.test.ts`.
// Library-only — NO app route / server action / connect button is added (a UI affordance is a later PR).

import {
  buildSlackAuthorizeUrl,
  SLACK_PROVIDER_ID,
  type SlackAuthorizeReason,
} from "./slack-oauth";
import { isSupportedConnectorProvider } from "../provider-registry";
import type { OAuthStateSigner } from "../oauth-state";

// Runtime server-only sentinel — throw if evaluated in a browser.
if (typeof (globalThis as { window?: unknown }).window !== "undefined") {
  throw new Error("connector-vault/providers/slack-authorize-pending is server-only and must not be imported in client code");
}

// The exact oauth_pending row this helper writes — SAFE-METADATA-ONLY (hashes + ids; never a raw nonce/state/
// token/secret). Mirrors the `0020` columns. `expiresAt` is an ISO timestamptz string.
export type OAuthPendingInsertRow = {
  tenantId: string;
  organizationId: string | null;
  provider: "slack";
  connectorId: string | null;
  subject: string | null;
  stateJti: string;
  nonceHash: string;
  intent: "connect";
  expiresAt: string;
};

// The injected privileged-insert seam (the future runner-identity-backed inserter — NOT request-reachable).
// `duplicate` ⇒ a UNIQUE(state_jti|nonce_hash) conflict; `db_error` ⇒ any other failure. Tests inject a mock.
export interface SlackPendingInserter {
  insertPending(row: OAuthPendingInsertRow): Promise<{ ok: true } | { ok: false; reason: "duplicate" | "db_error" }>;
}

export type SlackAuthorizePersistReason =
  | SlackAuthorizeReason
  | "missing_inserter"
  | "unsupported_provider"
  | "missing_tenant"
  | "duplicate_pending"
  | "persist_failed";

export type SlackAuthorizePersistInput = {
  tenantId: string;
  organizationId?: string | null; // optional (nullable in oauth_pending)
  connectorId?: string | null; // null for a fresh connect
  subject?: string | null; // initiating user (auth.uid()); optional/nullable
  clientId: string; // INJECTED — never hardcoded / env-read here
  redirectUri: string; // validated (https only) by the builder
  signer: OAuthStateSigner; // the existing oauth-state signer boundary
  now: number;
  ttlSeconds?: number;
  scopes?: readonly string[];
  nonce?: string; // injectable for deterministic tests (never returned/stored raw)
};

export type SlackAuthorizePersistResult =
  | { ok: true; url: string; stateJti: string; expiresAt: number } // safe metadata only (url carries the signed state)
  | { ok: false; reason: SlackAuthorizePersistReason };

// Create the Slack authorize URL AND persist its single-use oauth_pending replay row via the injected
// inserter. Fails closed (safe reason) on a missing inserter, missing tenant, unsupported provider, any
// builder/config error, or an insert conflict/error. NO token exchange, NO Slack call, NO connector_secrets.
export async function persistSlackAuthorizePending(
  input: SlackAuthorizePersistInput,
  inserter: SlackPendingInserter,
): Promise<SlackAuthorizePersistResult> {
  if (!inserter || typeof inserter.insertPending !== "function")
    return { ok: false, reason: "missing_inserter" };
  // The Slack provider must be a supported registry entry (defensive — fail closed if it is ever removed).
  if (!isSupportedConnectorProvider(SLACK_PROVIDER_ID)) return { ok: false, reason: "unsupported_provider" };
  if (typeof input?.tenantId !== "string" || input.tenantId.length === 0)
    return { ok: false, reason: "missing_tenant" };
  if (input.organizationId != null && (typeof input.organizationId !== "string" || input.organizationId.length === 0))
    return { ok: false, reason: "missing_tenant" };
  if (input.subject != null && (typeof input.subject !== "string" || input.subject.length === 0))
    return { ok: false, reason: "missing_tenant" };

  // Build the authorize URL + the one-way hashes (the builder validates clientId/redirectUri/signer/scopes
  // and never returns the raw nonce). A bad config fails closed with the builder's safe reason.
  const auth = buildSlackAuthorizeUrl({
    ctx: {
      tenantId: input.tenantId,
      provider: SLACK_PROVIDER_ID,
      connectorId: input.connectorId ?? null,
      subject: input.subject ?? null,
      redirectIntent: "connect",
    },
    clientId: input.clientId,
    redirectUri: input.redirectUri,
    signer: input.signer,
    now: input.now,
    ttlSeconds: input.ttlSeconds,
    scopes: input.scopes,
    nonce: input.nonce,
  });
  if (!auth.ok) return { ok: false, reason: auth.reason };

  // The single privileged write — the future-consume replay row (hashes only; raw nonce/state never stored).
  const result = await inserter.insertPending({
    tenantId: input.tenantId,
    organizationId: input.organizationId ?? null,
    provider: "slack",
    connectorId: input.connectorId ?? null,
    subject: input.subject ?? null,
    stateJti: auth.stateJti,
    nonceHash: auth.nonceHash,
    intent: "connect",
    expiresAt: new Date(auth.expiresAt).toISOString(),
  });
  if (!result.ok) return { ok: false, reason: result.reason === "duplicate" ? "duplicate_pending" : "persist_failed" };

  return { ok: true, url: auth.url, stateJti: auth.stateJti, expiresAt: auth.expiresAt };
}
