// Server-only OAuth callback state/nonce validation skeleton (docs/42 §7/§16, gated sequence PR F).
//
// This is the CSRF/replay validation infrastructure the OAuth connect flow needs BEFORE any provider is
// wired (docs/42 §20/§21 — PR F). It is PURE: it generates and validates a tamper-evident `state` value
// and nothing else. It does NOT talk to a provider, exchange an authorization code for tokens, store any
// token/credential, touch `connector_secrets`, access a database, import a Supabase client, or use a
// privileged path. The vault stays NOT usable for real credentials.
//
// SERVER-ONLY. Same discipline as crypto.ts / run-lifecycle.ts: it lives under `src/lib/server/`, carries
// the runtime browser sentinel below, and `no-client-import.test.ts` asserts no `"use client"` / `src/app`
// file imports it. Its only import is `node:crypto` (HMAC + constant-time compare + random nonce).
//
// MODEL (docs/42 §7 + §90.2, B2a): a stateless, HMAC-signed `state` binds the callback to ALL EIGHT of
// `{ sub (actor), tid (tenant), prov (provider), cid (connector), redir (EXACT redirect URI), corr
// (correlation/operation id), exp (expiry), nonce (single-use) }`. Generation is GATED by an actor authorization
// check (`generateBoundOAuthState`) so an actor cannot mint a state for a tenant/connector they cannot access.
// On the provider's redirect back, the callback recomputes the HMAC and then compares EACH bound field against
// the completing request/session — rejecting any tamper / wrong key, missing session, subject/tenant/provider/
// connector/redirect/correlation mismatch, expiry, replay, or missing nonce — fail-closed, with safe reason CODES
// only (never the key, nonce, code, session, or any provider payload). The single-use marker is enforced atomically
// by `oauth-pending-consume.ts` (one atomic UPDATE; a concurrent second consume fails closed). The signing key is held by an INJECTED signer (a server-only secret / KMS in
// production — NOT in this PR; a test-only in-memory signer in tests). Single-use REPLAY rejection needs a
// shared consumed-nonce store; an optional in-memory store is supported for tests, and the production
// (DB-backed, single-use `oauth_pending`) store remains a gate — see docs/42 §16/§30.
//
// REDACTION (docs/42 §11): validation returns a typed reason CODE, never a secret/nonce/token/code value.
// Nothing here calls console.* and nothing logs the raw authorization code or query params.

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

// Runtime server-only sentinel — throw if evaluated in a browser.
if (typeof (globalThis as { window?: unknown }).window !== "undefined") {
  throw new Error("connector-vault/oauth-state is server-only and must not be imported in client code");
}

// ── Public types ───────────────────────────────────────────────────────────────────────────────────
// The context an initiator binds a state to. tenantId/provider/redirectIntent are required; connectorId
// (for a re-auth of an existing connector) and subject (the initiating user) are optional.
export type OAuthStateContext = {
  tenantId: string;
  provider: string;
  connectorId?: string | null;
  subject?: string | null;
  redirectIntent: string;
  // B2a (docs/42 §90.2): the EXACT redirect URI (absolute HTTPS) bound at authorize and compared FULL-STRING at
  // callback. It MUST be a server-trusted/configured value — NEVER reconstructed from request-controlled inputs
  // (Host, X-Forwarded-Host, Forwarded, request URL, origin, query). Use `serverTrustedRedirectUri`.
  redirectUri: string;
  // B2a: a grammar-safe correlation/operation id (mirrors the #166 grammar) bound at authorize.
  correlationId: string;
};

// The signed payload carried in `state` (compact keys; all non-secret EXCEPT the nonce, which is a
// single-use random value, not a long-lived secret). `exp` is an epoch-ms expiry. B2a binds all eight fields
// (docs/42 §90.2): sub, tid, prov, cid, redir (exact URI), corr, exp, nonce (single-use).
export type OAuthStatePayload = {
  v: 1;
  tid: string; // tenant_id
  prov: string; // provider
  cid: string | null; // connector_id (re-auth) or null
  sub: string | null; // initiating subject (actor) — B2a binds + compares this
  intent: string; // redirect/callback intent (logical label)
  redir: string; // B2a: the EXACT redirect URI (compared full-string at callback)
  corr: string; // B2a: correlation/operation id
  nonce: string; // single-use CSRF nonce
  exp: number; // epoch ms expiry
};

// The injected signer (the secret provider). A real deployment backs this with a server-only secret / KMS
// (NOT in this PR); tests inject an in-memory HMAC signer. `keyId` is a non-sensitive handle for rotation.
export interface OAuthStateSigner {
  keyId: string;
  sign(message: string): Buffer; // HMAC of `message` under the server-held key
}

// Optional single-use nonce store for REPLAY rejection. In-memory impl is test-only; the production store
// (DB-backed single-use `oauth_pending`) remains a gate (docs/42 §16/§30).
export interface ConsumedNonceStore {
  has(nonce: string): boolean;
  add(nonce: string): void;
}

export type OAuthStateReason =
  | "missing_state"
  | "malformed_state"
  | "bad_signature"
  | "missing_nonce"
  | "expired"
  | "replayed"
  | "session_required" // B2a: the callback supplied no completing session/actor subject
  | "subject_mismatch" // B2a: state.sub != the completing session's authenticated subject
  | "tenant_mismatch"
  | "provider_mismatch"
  | "connector_mismatch"
  | "redirect_uri_mismatch" // B2a: state.redir != the server-trusted expected redirect URI
  | "correlation_mismatch"; // B2a: state.corr != the expected correlation/operation id

export type OAuthStateValidation =
  | { ok: true; payload: OAuthStatePayload }
  | { ok: false; reason: OAuthStateReason };

export class OAuthStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OAuthStateError";
  }
}

const NONCE_BYTES = 16;

// Grammar-safe correlation/operation id — a uuid OR a short prefixed id. Mirrors the #166 `SAFE_CORRELATION_RE`
// (kept inline so this module's only import stays `node:crypto`); structurally rejects an opaque high-entropy blob.
const SAFE_CORRELATION_RE =
  /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|(run|job|req|corr|trace|span)[-_][A-Za-z0-9][A-Za-z0-9_-]{0,62})$/i;

// A redirect URI is acceptable only if it is an absolute HTTPS URL (no `http:`/`javascript:`/`data:`/relative) —
// the same rule `buildSlackAuthorizeUrl` applies. The EXACT string is what is bound + compared.
function isAbsoluteHttpsUrl(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0) return false;
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

// B2a: resolve the EXACT redirect URI to compare against — ONLY from server-trusted config, NEVER from a request.
// The callback MUST feed `validateOAuthState`'s `expectedContext.redirectUri` from this (a server constant/env),
// not from Host/X-Forwarded-Host/Forwarded/request URL/origin/query — otherwise a spoofed Host could move the
// comparison target. This helper deliberately takes NO request argument.
export function serverTrustedRedirectUri(configuredRedirectUri: string): string {
  if (!isAbsoluteHttpsUrl(configuredRedirectUri))
    throw new OAuthStateError("invalid server-configured redirect uri (must be absolute https)");
  return configuredRedirectUri;
}

// A pure HMAC-SHA256 signer factory (used by the route to build a signer from a server-only secret, and by
// tests to build a test-only signer). The secret is passed in — this module NEVER reads it from env.
export function createHmacStateSigner(secret: Buffer | string, keyId: string): OAuthStateSigner {
  const key = typeof secret === "string" ? Buffer.from(secret, "utf8") : secret;
  if (key.length === 0) throw new OAuthStateError("invalid signing secret");
  if (typeof keyId !== "string" || keyId.length === 0) throw new OAuthStateError("invalid keyId");
  return { keyId, sign: (message: string) => createHmac("sha256", key).update(message, "utf8").digest() };
}

// ── Internals ──────────────────────────────────────────────────────────────────────────────────────
function b64urlEncode(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function b64urlDecode(s: string): Buffer {
  return Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

function assertContext(ctx: OAuthStateContext): void {
  if (!ctx || typeof ctx !== "object") throw new OAuthStateError("invalid oauth state context");
  if (typeof ctx.tenantId !== "string" || ctx.tenantId.length === 0)
    throw new OAuthStateError("invalid oauth state context: tenantId");
  if (typeof ctx.provider !== "string" || ctx.provider.length === 0)
    throw new OAuthStateError("invalid oauth state context: provider");
  if (typeof ctx.redirectIntent !== "string" || ctx.redirectIntent.length === 0)
    throw new OAuthStateError("invalid oauth state context: redirectIntent");
  // B2a: every minted state binds all eight fields — require the actor subject, the EXACT absolute-HTTPS redirect
  // URI, and a grammar-safe correlation id.
  if (typeof ctx.subject !== "string" || ctx.subject.length === 0)
    throw new OAuthStateError("invalid oauth state context: subject (actor) is required");
  if (!isAbsoluteHttpsUrl(ctx.redirectUri))
    throw new OAuthStateError("invalid oauth state context: redirectUri (must be absolute https)");
  if (!SAFE_CORRELATION_RE.test(ctx.correlationId))
    throw new OAuthStateError("invalid oauth state context: correlationId");
}

// ── Public API ─────────────────────────────────────────────────────────────────────────────────────
// Create a signed `state` for an outbound authorization redirect. Returns the opaque state string + the
// nonce (which a caller would also persist server-side for single-use tracking in production). NO secret
// is returned and nothing is logged. `now`/`nonce` are injectable for deterministic tests.
export function createOAuthState(
  ctx: OAuthStateContext,
  opts: { signer: OAuthStateSigner; ttlSeconds: number; now: number; nonce?: string },
): { state: string; nonce: string } {
  assertContext(ctx);
  if (!opts || !opts.signer) throw new OAuthStateError("missing signer");
  if (!Number.isFinite(opts.now)) throw new OAuthStateError("invalid now");
  if (!Number.isInteger(opts.ttlSeconds) || opts.ttlSeconds <= 0)
    throw new OAuthStateError("invalid ttlSeconds");
  const nonce = opts.nonce ?? b64urlEncode(randomBytes(NONCE_BYTES));
  const payload: OAuthStatePayload = {
    v: 1,
    tid: ctx.tenantId,
    prov: ctx.provider,
    cid: ctx.connectorId ?? null,
    sub: ctx.subject ?? null,
    intent: ctx.redirectIntent,
    redir: ctx.redirectUri,
    corr: ctx.correlationId,
    nonce,
    exp: opts.now + opts.ttlSeconds * 1000,
  };
  const json = JSON.stringify(payload);
  const sig = opts.signer.sign(json);
  const state = `${b64urlEncode(Buffer.from(json, "utf8"))}.${b64urlEncode(sig)}`;
  return { state, nonce };
}

// B2a generation-time authorization (docs/42 §90.1 / §1): the initiating actor MUST be authorized for the
// `tenant_id` AND `connector_id` being bound. An actor must NOT be able to mint a state binding a tenant or
// connector they cannot access — this prevents a *self-consistent* malicious state (the callback equality check
// alone is not enough; both are required). Returns true iff `subject` may bind that tenant + connector.
export type AuthorizeActorForState = (input: {
  subject: string;
  tenantId: string;
  connectorId: string | null;
}) => boolean | Promise<boolean>;

// Mint a fully-bound state ONLY after the actor passes the generation-time authorization check. If the actor is
// not authorized, it THROWS and NO usable state is created (the signer is never invoked). The injected
// `authorizeActor` is the tenant-membership / connector-access gate (a real DB check in B2c; a mock in tests).
export async function generateBoundOAuthState(
  ctx: OAuthStateContext,
  deps: { signer: OAuthStateSigner; ttlSeconds: number; now: number; authorizeActor: AuthorizeActorForState; nonce?: string },
): Promise<{ state: string; nonce: string }> {
  assertContext(ctx); // requires subject + redirectUri + correlationId (+ tenant/provider/intent)
  if (!deps || typeof deps.authorizeActor !== "function")
    throw new OAuthStateError("missing authorizeActor");
  const allowed = await deps.authorizeActor({
    subject: ctx.subject as string,
    tenantId: ctx.tenantId,
    connectorId: ctx.connectorId ?? null,
  });
  if (allowed !== true)
    throw new OAuthStateError("actor is not authorized to mint state for this tenant/connector");
  return createOAuthState(ctx, { signer: deps.signer, ttlSeconds: deps.ttlSeconds, now: deps.now, nonce: deps.nonce });
}

// Validate a `state` returned to the callback. Verifies the HMAC over the EXACT signed bytes BEFORE
// trusting any field, then checks nonce/expiry, optional context binding (tenant/provider/connector), and
// optional single-use replay. Returns a typed result with a safe reason code — never throws on bad input,
// never includes a secret/nonce/token/code in the result. `expectedContext` is optional: when supplied
// (the caller knows the tenant/provider it expects — e.g. re-derived from the session), tenant/provider/
// connector swaps are rejected; when omitted, the self-contained checks (signature/expiry/nonce) still run.
export function validateOAuthState(
  state: string | null | undefined,
  expectedContext: OAuthStateContext | null | undefined,
  opts: { signer: OAuthStateSigner; now: number; consumedNonces?: ConsumedNonceStore },
): OAuthStateValidation {
  if (!opts || !opts.signer) throw new OAuthStateError("missing signer");
  if (typeof state !== "string" || state.length === 0) return { ok: false, reason: "missing_state" };

  const dot = state.indexOf(".");
  if (dot <= 0 || dot === state.length - 1) return { ok: false, reason: "malformed_state" };
  const payloadPart = state.slice(0, dot);
  const sigPart = state.slice(dot + 1);

  let json: string;
  let providedSig: Buffer;
  try {
    json = b64urlDecode(payloadPart).toString("utf8");
    providedSig = b64urlDecode(sigPart);
  } catch {
    return { ok: false, reason: "malformed_state" };
  }

  // Verify the signature over the canonical signed bytes BEFORE parsing/trusting any field (constant-time).
  const expectedSig = opts.signer.sign(json);
  if (providedSig.length !== expectedSig.length || !timingSafeEqual(providedSig, expectedSig))
    return { ok: false, reason: "bad_signature" };

  let payload: OAuthStatePayload;
  try {
    payload = JSON.parse(json) as OAuthStatePayload;
  } catch {
    return { ok: false, reason: "malformed_state" };
  }
  if (
    !payload ||
    payload.v !== 1 ||
    typeof payload.tid !== "string" ||
    typeof payload.prov !== "string" ||
    typeof payload.intent !== "string" ||
    typeof payload.exp !== "number" ||
    // B2a: a fully-bound state MUST carry the actor subject, the exact redirect URI, and the correlation id.
    typeof payload.sub !== "string" || payload.sub.length === 0 ||
    typeof payload.redir !== "string" || payload.redir.length === 0 ||
    typeof payload.corr !== "string" || payload.corr.length === 0
  ) {
    return { ok: false, reason: "malformed_state" };
  }

  if (typeof payload.nonce !== "string" || payload.nonce.length === 0)
    return { ok: false, reason: "missing_nonce" };
  if (!(payload.exp > opts.now)) return { ok: false, reason: "expired" };

  if (expectedContext) {
    // B2a (docs/42 §90.2): compare EACH bound field against the completing request/session; ANY mismatch fails
    // closed. The callback MUST supply the authenticated subject + the server-trusted redirect URI (NOT
    // request-reconstructed) + the expected tenant/provider/connector/correlation.
    if (typeof expectedContext.subject !== "string" || expectedContext.subject.length === 0)
      return { ok: false, reason: "session_required" }; // no completing session/actor → cannot bind
    if (payload.sub !== expectedContext.subject) return { ok: false, reason: "subject_mismatch" };
    if (payload.tid !== expectedContext.tenantId) return { ok: false, reason: "tenant_mismatch" };
    if (payload.prov !== expectedContext.provider) return { ok: false, reason: "provider_mismatch" };
    // UNCONDITIONAL connector compare (null-normalized): a fresh-connect state (cid=null) matches a fresh-connect
    // context (null===null); a re-auth state (cid=A) matches only cid=A — and a re-auth state can NEVER complete a
    // fresh-connect context, nor connector A complete connector B. (Not gated on `!= null`, so it cannot be skipped.)
    if ((payload.cid ?? null) !== (expectedContext.connectorId ?? null))
      return { ok: false, reason: "connector_mismatch" };
    if (payload.redir !== expectedContext.redirectUri) return { ok: false, reason: "redirect_uri_mismatch" };
    // The correlation id is the AUDIT-correlation binding (docs/42 §90.2) — compared ONLY when the caller supplies
    // an expected value ("if applicable"); it is NOT a confused-deputy defense (the seven above are). The seven
    // security bindings (subject/tenant/provider/connector/redirect/expiry/single-use) are unconditional fail-closed.
    if (
      typeof expectedContext.correlationId === "string" &&
      expectedContext.correlationId.length > 0 &&
      payload.corr !== expectedContext.correlationId
    )
      return { ok: false, reason: "correlation_mismatch" };
  }

  // Single-use replay rejection (only when a store is supplied). Consume the nonce only for an otherwise
  // valid state, so a rejected state never burns a nonce.
  if (opts.consumedNonces) {
    if (opts.consumedNonces.has(payload.nonce)) return { ok: false, reason: "replayed" };
    opts.consumedNonces.add(payload.nonce);
  }

  return { ok: true, payload };
}

// ── Callback handler (PURE — used by the inert route; performs NO token exchange, NO DB write) ─────────
export type OAuthCallbackOutcome = {
  status: "not_configured" | "provider_error" | "invalid" | "received";
  reason?: OAuthStateReason | "provider_reported_error";
  httpStatus: number;
};

// Decide the safe, inert outcome for an OAuth callback request. It parses provider/code/state/error from
// the query, validates `state`, and returns a safe status — it NEVER exchanges `code` for a token, NEVER
// reads/writes `connector_secrets`, NEVER marks a connector connected, and NEVER logs the code/state. The
// `code` param is intentionally ignored (presence only); its value is never read, returned, or logged.
export function handleOAuthCallback(
  searchParams: URLSearchParams,
  opts: { signer: OAuthStateSigner | null; now: number; expectedContext?: OAuthStateContext | null; consumedNonces?: ConsumedNonceStore },
): OAuthCallbackOutcome {
  // A provider-reported error (?error=...) — never surface its value, only a safe code.
  if (searchParams.has("error")) {
    return { status: "provider_error", reason: "provider_reported_error", httpStatus: 400 };
  }
  // Skeleton default: with no signer configured (this PR ships none), the callback is inert/not available.
  if (!opts.signer) {
    return { status: "not_configured", httpStatus: 503 };
  }
  const result = validateOAuthState(searchParams.get("state"), opts.expectedContext ?? null, {
    signer: opts.signer,
    now: opts.now,
    consumedNonces: opts.consumedNonces,
  });
  if (!result.ok) {
    return { status: "invalid", reason: result.reason, httpStatus: 400 };
  }
  // Valid state. The skeleton STOPS here — it does not exchange the code, store any token, or mark the
  // connector connected. Those are later gated PRs.
  return { status: "received", httpStatus: 200 };
}
