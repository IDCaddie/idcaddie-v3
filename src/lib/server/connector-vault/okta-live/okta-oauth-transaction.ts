// P5E18a — the Okta OAuth TRANSACTION model + PKCE (Phase 4). PURE, server-only, NO network/DB/secret-store. It mints the short-
// lived, single-use, fully-bound transaction that a FUTURE authorized connect flow would create — reusing the provider-neutral
// HMAC-signed `state` (oauth-state.ts) for the CSRF/replay/tenant binding, and adding Okta-required PKCE (S256).
//
// SECURITY POSTURE:
//  - The PKCE code_verifier is a SECRET held server-side ONLY. It is returned SEPARATELY from the persistable shape and is NEVER
//    part of the transaction record, NEVER persisted through oauth_pending (whose helper forbids `verifier`), NEVER logged.
//  - Only the PKCE code_challenge (S256, non-secret) rides the authorize request.
//  - The `state` is signed + binds subject/tenant/provider/connector/redirect/correlation/expiry/nonce; the nonce is single-use.
//  - The intended return route is allowlisted (open-redirect defense) — never an arbitrary/external URL.
//  - Okta failure reason codes live in THIS module's own union — they are NOT the oauth_pending.last_rejected_code CHECK set, so
//    no DB CHECK-constraint drift is introduced.
//
// DORMANT: this builds an in-memory model for tests; it is not wired to any live route, never persists a row, and never contacts
// Okta. SERVER-ONLY: under src/lib/server/, the runtime browser sentinel below, and no-client-import.test.ts.

import { createHash, randomBytes } from "node:crypto";
import { generateBoundOAuthState, type AuthorizeActorForState, type OAuthStateSigner } from "../oauth-state";
import { OKTA_PROVIDER_ID, scopesExactlyApproved } from "./okta-provider-contract";

// Runtime server-only sentinel — throw if evaluated in a browser.
if (typeof (globalThis as { window?: unknown }).window !== "undefined") {
  throw new Error("connector-vault/okta-live/okta-oauth-transaction is server-only and must not be imported in client code");
}

function b64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// ── PKCE (S256) ──────────────────────────────────────────────────────────────────────────────────────
export type Pkce = { verifier: string; challenge: string; method: "S256" };

// Generate a PKCE pair. The verifier is 43 chars of base64url (32 random bytes) — within RFC 7636's 43-128 range. The challenge
// is base64url(sha256(verifier)). The verifier is a SECRET — the caller must hold it server-side and never persist/log it.
export function createPkce(verifierBytes?: Buffer): Pkce {
  const raw = verifierBytes ?? randomBytes(32); // injectable for deterministic tests
  const verifier = b64url(raw);
  const challenge = b64url(createHash("sha256").update(verifier, "utf8").digest());
  return { verifier, challenge, method: "S256" };
}

// ── Return-route allowlist (open-redirect defense) ────────────────────────────────────────────────────
// A safe post-connection return route is a SAME-SITE ABSOLUTE PATH under the connectors area — never a scheme, never protocol-
// relative ("//host"), never containing "\\", "..", whitespace, or a control char. Rejects attacker-controlled callback targets.
const SAFE_RETURN_ROUTE_RE = /^\/connectors(\/[A-Za-z0-9._~%-]+)*\/?$/;
export function isSafeReturnRoute(route: unknown): route is string {
  if (typeof route !== "string" || route.length === 0 || route.length > 512) return false;
  if (route.startsWith("//") || route.includes("\\") || route.includes("..")) return false;
  if (/[\s\x00-\x1f]/.test(route)) return false;
  if (/^[a-z][a-z0-9+.-]*:/i.test(route)) return false; // no scheme
  return SAFE_RETURN_ROUTE_RE.test(route);
}

// ── Transaction model ─────────────────────────────────────────────────────────────────────────────────
export type OktaOAuthFailureReason =
  | "invalid_input"
  | "scope_not_exact"
  | "unsafe_return_route"
  | "actor_not_authorized"
  | "expired"
  | "already_consumed"
  | "state_mismatch";

// The FULL transaction (in memory). NOTE: it deliberately does NOT contain the PKCE verifier — that is returned separately and
// held server-side. It carries only the non-secret challenge.
export type OktaOAuthTransaction = {
  provider: typeof OKTA_PROVIDER_ID;
  correlationId: string;
  tenantId: string;
  organizationId: string;
  connectorId: string | null;
  subject: string; // initiating user
  requestedScopes: readonly string[];
  issuerUrl: string; // the eventual Okta issuer origin (https://<org>.okta.com)
  orgHostname: string;
  redirectUri: string; // the exact server-trusted callback URI
  returnRoute: string; // allowlisted same-site return path
  pkceChallenge: string;
  pkceMethod: "S256";
  state: string; // the signed, browser-carried state
  createdAt: number; // epoch ms
  expiresAt: number; // epoch ms — short TTL
  singleUse: true;
  consumedAt: number | null;
  failureReason: OktaOAuthFailureReason | null;
};

// The SAFE persistable projection a future single-use store would write. It holds ONLY non-secret metadata: NO verifier, NO token,
// NO code, NO signed state bytes — only the state's correlation id + a sha256 of the state nonce (the single-use key). This mirrors
// the oauth_pending SAFE-METADATA posture without ever touching that Slack/Entra table.
export type OktaOAuthTransactionRecord = {
  provider: typeof OKTA_PROVIDER_ID;
  correlationId: string;
  tenantId: string;
  organizationId: string;
  connectorId: string | null;
  subject: string;
  requestedScopes: readonly string[];
  issuerUrl: string;
  orgHostname: string;
  redirectUri: string;
  returnRoute: string;
  pkceChallenge: string; // non-secret
  pkceMethod: "S256";
  stateNonceHash: string; // sha256(nonce) — single-use key; raw nonce never stored
  createdAt: number;
  expiresAt: number;
  consumedAt: number | null;
};

export type BuildOktaTransactionInput = {
  tenantId: string;
  organizationId: string;
  connectorId?: string | null;
  subject: string;
  requestedScopes: readonly string[];
  issuerUrl: string;
  orgHostname: string;
  redirectUri: string;
  returnRoute: string;
  correlationId: string;
};

export type BuildOktaTransactionDeps = {
  signer: OAuthStateSigner;
  authorizeActor: AuthorizeActorForState;
  now: number;
  ttlSeconds: number;
  pkceVerifierBytes?: Buffer; // test injection
  nonce?: string; // test injection
};

export type BuildOktaTransactionResult =
  | { ok: true; transaction: OktaOAuthTransaction; pkceVerifier: string; stateNonce: string }
  | { ok: false; reason: OktaOAuthFailureReason };

const nonEmpty = (v: unknown): v is string => typeof v === "string" && v.length > 0;

// Build a fully-bound, single-use Okta OAuth transaction. Validates the scope set (EXACT approved), the return route (allowlist),
// and required identity; creates PKCE (verifier held separately); and mints the signed, actor-authorized state. It throws NOTHING
// on bad input — it returns a typed failure. It performs NO network/DB/secret access. This function is behind the connect gate in
// any real flow; the gate fails closed at certificationOnly so it is never reached live in P5E18a.
export async function buildOktaOAuthTransaction(
  input: BuildOktaTransactionInput,
  deps: BuildOktaTransactionDeps,
): Promise<BuildOktaTransactionResult> {
  if (!nonEmpty(input.tenantId) || !nonEmpty(input.organizationId) || !nonEmpty(input.subject) ||
      !nonEmpty(input.issuerUrl) || !nonEmpty(input.orgHostname) || !nonEmpty(input.redirectUri) || !nonEmpty(input.correlationId)) {
    return { ok: false, reason: "invalid_input" };
  }
  if (scopesExactlyApproved(input.requestedScopes).ok !== true) return { ok: false, reason: "scope_not_exact" };
  if (!isSafeReturnRoute(input.returnRoute)) return { ok: false, reason: "unsafe_return_route" };
  if (!input.issuerUrl.startsWith("https://")) return { ok: false, reason: "invalid_input" };

  const pkce = createPkce(deps.pkceVerifierBytes);

  let minted: { state: string; nonce: string };
  try {
    minted = await generateBoundOAuthState(
      {
        tenantId: input.tenantId,
        provider: OKTA_PROVIDER_ID,
        connectorId: input.connectorId ?? null,
        subject: input.subject,
        redirectIntent: "okta_connect",
        redirectUri: input.redirectUri,
        correlationId: input.correlationId,
      },
      { signer: deps.signer, ttlSeconds: deps.ttlSeconds, now: deps.now, authorizeActor: deps.authorizeActor, nonce: deps.nonce },
    );
  } catch {
    // generateBoundOAuthState throws only when the actor authorization gate denies (or input is invalid) — fail closed.
    return { ok: false, reason: "actor_not_authorized" };
  }

  const transaction: OktaOAuthTransaction = {
    provider: OKTA_PROVIDER_ID,
    correlationId: input.correlationId,
    tenantId: input.tenantId,
    organizationId: input.organizationId,
    connectorId: input.connectorId ?? null,
    subject: input.subject,
    requestedScopes: [...input.requestedScopes],
    issuerUrl: input.issuerUrl,
    orgHostname: input.orgHostname,
    redirectUri: input.redirectUri,
    returnRoute: input.returnRoute,
    pkceChallenge: pkce.challenge,
    pkceMethod: "S256",
    state: minted.state,
    createdAt: deps.now,
    expiresAt: deps.now + deps.ttlSeconds * 1000,
    singleUse: true,
    consumedAt: null,
    failureReason: null,
  };
  return { ok: true, transaction, pkceVerifier: pkce.verifier, stateNonce: minted.nonce };
}

// Project a transaction to its SAFE persistable record (no verifier/secret/state bytes). `stateNonce` is the raw nonce — it is
// hashed here (sha256) and never retained. This is what a future single-use store would write; nothing is persisted in P5E18a.
export function toOktaTransactionRecord(t: OktaOAuthTransaction, stateNonce: string): OktaOAuthTransactionRecord {
  if (!nonEmpty(stateNonce)) throw new Error("stateNonce required");
  return {
    provider: t.provider,
    correlationId: t.correlationId,
    tenantId: t.tenantId,
    organizationId: t.organizationId,
    connectorId: t.connectorId,
    subject: t.subject,
    requestedScopes: [...t.requestedScopes],
    issuerUrl: t.issuerUrl,
    orgHostname: t.orgHostname,
    redirectUri: t.redirectUri,
    returnRoute: t.returnRoute,
    pkceChallenge: t.pkceChallenge,
    pkceMethod: t.pkceMethod,
    stateNonceHash: createHash("sha256").update(stateNonce, "utf8").digest("hex"),
    createdAt: t.createdAt,
    expiresAt: t.expiresAt,
    consumedAt: t.consumedAt,
  };
}
