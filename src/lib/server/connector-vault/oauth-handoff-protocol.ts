// Phase 8K — the V3 → OAuth-completion-worker handoff PROTOCOL. Server-only.
//
// This is the SHARED contract. V3 (this repo) is the CLIENT: it builds the canonical body and presents a Vercel OIDC
// assertion. The completion worker (a separate deployable, PR 4) is the SERVER: it verifies the assertion, verifies the
// body, and calls `oauth_completer_enqueue_oauth_completion_job` (migration 0081). Both halves must agree byte for byte,
// so both halves read THIS file — the verification half is implemented here, in PR 3, precisely so PR 4 cannot invent a
// weaker one.
//
// ── WHAT THE ASSERTION CAN AND CANNOT BIND ───────────────────────────────────────────────────────────────────────────
// A Vercel OIDC token is minted by Vercel for a deployment. Its claims are Vercel's; a caller CANNOT add a nonce, a body
// digest, a tenant or a correlation id to it. Pretending otherwise would be the worst kind of security theatre, so the
// binding is split across three mechanisms, each doing only what it can actually do:
//
//   1. The ASSERTION authenticates the CALLER — issuer, audience, subject, team, project, Vercel environment, and a
//      bounded lifetime. It answers "is this our staging deployment", and nothing else.
//   2. The AAD of the sealed payload (`oauth-payload-seal.ts`) cryptographically binds the request FIELDS — protocol
//      version, envelope version, tenant, connector, provider, correlation, redirect, workspace, payload key id, and
//      as of v2 the NONCE HASH and SUBJECT. A substituted body cannot open the authorization code, because AES-GCM
//      authenticates the AAD. This is the real body binding — and binding the v2 fields is what stops a valid-looking
//      handoff pointing the pending-row consume at a different row.
//   3. The TRANSPORT DIGEST header binds the exact serialized bytes the worker received, so truncation or alteration in
//      the channel is a refusal rather than a partially-parsed request.
//
// A digest cannot cover itself, which is why the transport digest is a HEADER and not a body field.
//
// ── WHAT IS DELIBERATELY NOT HERE ────────────────────────────────────────────────────────────────────────────────────
// No fetch, no JWKS retrieval, no database. `verifyHandoffAssertion` REQUIRES an injected signature verifier and refuses
// without one — a decoded JWT is not an authenticated JWT, and the type system says so. PR 4 supplies the verifier from
// Vercel's JWKS; PR 3's tests supply one built from a locally generated key pair.
//
// Nothing in this file calls `console.*`. No assertion, claim set, payload or environment value may reach a log or an
// error message; every refusal is a bounded static code.
//
// SERVER-ONLY: under `src/lib/server/`, the runtime browser sentinel below, and `no-client-import.test.ts`.

import { createHash, createPublicKey, timingSafeEqual, verify as verifySignatureWithKey } from "node:crypto";
import { z } from "zod";
import { STAGING_CALLBACK_URI, STAGING_ENVIRONMENT_MARKER, STAGING_VERCEL_PROJECT_ID } from "./staging-environment-identity";

if (typeof (globalThis as { window?: unknown }).window !== "undefined") {
  throw new Error("connector-vault/oauth-handoff-protocol is server-only and must not be imported in client code");
}

// ── The pinned protocol ──────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Bumping this is a coordinated change on both sides; a mismatched version is a refusal, never a downgrade.
 *
 * ── VERSION 2 (Phase 8M): `nonceHash` and `subject` ──────────────────────────────────────────────────────────────
 * Version 1 could not complete an OAuth flow correctly, and the defect was structural rather than a bug in either
 * half. `oauth_completer_consume_oauth_pending` (migration 0079) matches its row on
 *
 *     state_jti = p_state_jti AND nonce_hash = p_nonce_hash AND tenant_id = p_tenant_id
 *     AND provider = 'slack' AND connector_id IS NOT DISTINCT FROM p_connector_id
 *     AND subject IS NOT DISTINCT FROM p_subject AND consumed_at IS NULL AND expires_at > p_now
 *
 * and additionally refuses outright when `p_nonce_hash` is null or empty. Version 1 carried NEITHER `nonce_hash` NOR
 * `subject`, and the worker holds no table grant with which to look either up — so no value reachable from the worker
 * could satisfy that WHERE, and the single-use consume was simply never performed. The `oauth_pending` row was left to
 * expire on its own.
 *
 * Version 2 carries exactly those two values and nothing else. They are the MINIMUM the existing wrapper requires:
 * every other column in its WHERE (`state_jti`, `tenant_id`, `connector_id`, the pinned provider, and the redirect the
 * wrapper re-checks) was already in version 1.
 *
 * WHAT IS DELIBERATELY NOT CARRIED: the raw nonce (only its sha256 — the raw value is a live CSRF secret and the
 * database itself has never stored it, doc 42 §32.3), the authorization code (that is what the sealed payload is for),
 * any token, the state signing secret, and any human-readable identifier such as an email. `subject` is the `auth.uid()`
 * UUID the authorize half already bound into the signed state — an opaque identifier, and the only thing the row can be
 * matched on.
 *
 * THERE IS NO NEGOTIATION AND NO DOWNGRADE. A version-1 body fails the strict schema, and a version-1 header fails the
 * header comparison before the body is even parsed, so a v1 caller cannot reach live completion. That is the intended
 * backward compatibility: v1 is refused, not tolerated.
 */
export const HANDOFF_PROTOCOL_VERSION = 2 as const;
/** The ID Caddie environment identity, carried explicitly. It is NOT the Vercel `environment` claim: staging is served
 *  on Vercel's Production channel (see `staging-environment-identity.ts`), so the two disagree on purpose. */
export const HANDOFF_ENVIRONMENT = STAGING_ENVIRONMENT_MARKER;
export const HANDOFF_PROVIDER = "slack" as const;
export const HANDOFF_REDIRECT_URI = STAGING_CALLBACK_URI;
/** The scheme migration 0081's CHECK constrains. `oauth-payload-seal.ts` implements exactly this and nothing else. */
export const HANDOFF_PAYLOAD_SCHEME = "X25519-HKDF-SHA256-AES-256-GCM" as const;

/** The one path a handoff may be posted to. Pinned in code rather than configured, so a misconfigured endpoint cannot
 *  quietly retarget the request within an allowlisted host. */
export const HANDOFF_PATH = "/internal/oauth-completion/handoff" as const;

export const HANDOFF_VERSION_HEADER = "x-idcaddie-handoff-version" as const;
export const HANDOFF_CORRELATION_HEADER = "x-idcaddie-correlation-id" as const;
export const HANDOFF_DIGEST_HEADER = "x-idcaddie-body-digest" as const;

/** Every serialized handoff is far below this; the ceiling exists so an oversized body is refused before it is parsed. */
export const MAX_HANDOFF_BODY_BYTES = 16_384;
/** Mirrors `oauth_completion_jobs_payload_bound` — the same floor and ceiling the database enforces. */
export const MIN_PROTECTED_PAYLOAD_BYTES = 60;
export const MAX_PROTECTED_PAYLOAD_BYTES = 8192;

// Grammars, each matching the migration-0081 CHECK for the same field. They exist here as well as in the database
// because a bounded refusal beats a constraint-violation message reaching a redirect — and because the AAD in
// `oauth-payload-seal.ts` joins these values with newlines, so a value that could contain one would be forgeable.
export const CORRELATION_ID_RE = /^[A-Za-z0-9_.:-]{1,64}$/;
export const PAYLOAD_KEY_ID_RE = /^[A-Za-z0-9_.:-]{1,128}$/;
export const SLACK_TEAM_ID_RE = /^T[A-Z0-9]{2,30}$/;
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;
const SHA256_HEX_RE = /^[0-9a-f]{64}$/;
/** `oauth_pending.nonce_hash` is `sha256(nonce)` in lowercase hex — the RAW nonce is never stored and never sent. */
export const NONCE_HASH_RE = SHA256_HEX_RE;

// ── The request ──────────────────────────────────────────────────────────────────────────────────────────────────────
// STRICT: an unknown key is a refusal, not an ignored extra. There is no forward-compatible extension point on purpose —
// `version` is how this protocol changes, and a field the receiver does not understand must never ride along unnoticed.
export const handoffRequestSchema = z.strictObject({
  version: z.literal(HANDOFF_PROTOCOL_VERSION),
  environment: z.literal(HANDOFF_ENVIRONMENT),
  correlationId: z.string().regex(CORRELATION_ID_RE),
  tenantId: z.string().regex(UUID_RE),
  connectorId: z.string().regex(UUID_RE),
  provider: z.literal(HANDOFF_PROVIDER),
  redirectUri: z.literal(HANDOFF_REDIRECT_URI),
  expectedTeamId: z.string().regex(SLACK_TEAM_ID_RE),
  payloadScheme: z.literal(HANDOFF_PAYLOAD_SCHEME),
  payloadKeyId: z.string().regex(PAYLOAD_KEY_ID_RE),
  /** base64 of the sealed envelope. Opaque here: nothing in this file parses it, so nothing here can leak part of it. */
  protectedPayload: z.string().regex(BASE64_RE),
  /** v2. `sha256(nonce)` hex — what `oauth_pending.nonce_hash` actually holds. NEVER the raw nonce. */
  nonceHash: z.string().regex(NONCE_HASH_RE),
  /** v2. The initiating `auth.uid()`, exactly as the authorize half bound it into the signed state and the pending
   *  row. Required rather than nullable: `slack-authorize-pending` refuses to create a row without a subject, so a
   *  null here could only ever describe a row this flow cannot produce. */
  subject: z.string().regex(UUID_RE),
});
export type HandoffRequest = z.infer<typeof handoffRequestSchema>;

/** The whole acknowledgement vocabulary. `duplicate` is the honest answer when 0081 refuses a re-sealed retry for a
 *  correlation that already has a job: the job exists, so the browser belongs on the pending page either way. */
export const handoffAckSchema = z.strictObject({
  version: z.literal(HANDOFF_PROTOCOL_VERSION),
  status: z.enum(["accepted", "duplicate"]),
});
export type HandoffAck = z.infer<typeof handoffAckSchema>;

/**
 * The canonical serialization. Key order is written out rather than derived, so the bytes cannot drift with an object
 * literal's shape or a JSON library's ordering rules. Both halves compute the transport digest over exactly this.
 */
export function canonicalHandoffBody(request: HandoffRequest): string {
  return JSON.stringify({
    version: request.version,
    environment: request.environment,
    correlationId: request.correlationId,
    tenantId: request.tenantId,
    connectorId: request.connectorId,
    provider: request.provider,
    redirectUri: request.redirectUri,
    expectedTeamId: request.expectedTeamId,
    payloadScheme: request.payloadScheme,
    payloadKeyId: request.payloadKeyId,
    protectedPayload: request.protectedPayload,
    // v2, appended rather than interleaved: the transport digest covers the whole body either way, and appending
    // keeps the v1 prefix legible in a diff. Both halves write this order out by hand for the same reason the rest of
    // it is written out — so the bytes cannot drift with an object literal's shape.
    nonceHash: request.nonceHash,
    subject: request.subject,
  });
}

/** sha256, lowercase hex, over the exact serialized body bytes. */
export function handoffBodyDigest(serializedBody: string): string {
  return createHash("sha256").update(serializedBody, "utf8").digest("hex");
}

// ── The OIDC assertion contract ──────────────────────────────────────────────────────────────────────────────────────

/** Vercel's OIDC issuer is always this prefix plus the team slug. Pinned structurally so a configured issuer pointing at
 *  some other identity provider is refused even if it is otherwise "exact". */
export const VERCEL_OIDC_ISSUER_PREFIX = "https://oidc.vercel.com/" as const;
/** The team and project this deployment is, from docs/83. Not configurable: they are facts about which code this is. */
export const STAGING_VERCEL_TEAM_ID = "team_PYYzXw6Wn7HVtPvvcQWNRSlC" as const;
export { STAGING_VERCEL_PROJECT_ID };

/** RS256 only. `none` and every symmetric alg are refused before any claim is read. */
const PERMITTED_ALG = "RS256" as const;

/**
 * Ceilings on the assertion's own timestamps. THE reviewed lifetime contract.
 *
 * ONE VALUE, USED BY BOTH REPOSITORIES — and it is worth saying how that is actually held, because for one merge it
 * was not true. The runner does not import this file; it vendors a BYTE-PINNED copy, checked by `vendor:verify`
 * against the pinned v3 SHA. So between #404 landing here and the runner's vendor re-sync, v3 declared 7200 while the
 * runner's copy still declared 3600 and its gate stayed green, because the gate compares against the PIN rather than
 * against v3 tip. That window is closed by the re-sync; the mechanism that allowed it is inherent to vendoring, so the
 * rule it leaves behind is: a change to this block is not complete until the runner pin moves with it.
 *
 * CITED, not assumed. This was 3600 with a comment saying the lifetime "is not something this repository can observe".
 * It is documented:
 *   * Vercel's OIDC reference: "Function tokens for `preview` and `production` expire after **two hours**." One hour is
 *     the BUILD-token lifetime, which is the token this design does NOT use.
 *   * Vercel's custom-audience changelog: the exchange "[u]pdates the `iat` to the current timestamp" and "[p]reserves
 *     all original claims (project, environment, owner, **expiration**)", carrying the original issue time in `act.iat`.
 *
 * So on the EXCHANGED assertion the worker actually receives, `exp` is inherited from the platform token and `iat` is
 * the exchange moment. `exp - iat` is therefore the platform token's REMAINING life — at most 7200, usually less. A
 * 3600 ceiling would have refused any exchange performed in the first hour of a platform token's life, i.e. most real
 * callbacks, and it would have presented as an assertion fault rather than as a ceiling we chose.
 *
 * `maxAge` (`now - iat`) is left AT the lifetime rather than tightened, and that is a deliberate hold, not an oversight:
 * because V3 exchanges per request with no cache, a real `iat` should be seconds old, and the honest tightening is
 * large. But the value is not yet OBSERVED, and a ceiling below the truth refuses real customers intermittently — the
 * failure mode the 3600 bug just demonstrated. Doc 83 §8.4a defines the first-live-run evidence that settles it, and
 * both remain parameters so tightening needs no code change.
 *
 * The replay window that actually matters is neither of these: it is the correlation's uniqueness in
 * `oauth_completion_jobs` plus that job's ten-minute deadline.
 */
export const DEFAULT_MAX_ASSERTION_LIFETIME_SECONDS = 7200;
export const DEFAULT_MAX_ASSERTION_AGE_SECONDS = 7200;
/** A token issued more than this far in the future is refused outright — clock drift, not a licence to pre-date. */
export const DEFAULT_CLOCK_SKEW_SECONDS = 30;

/** Every claim the worker pins. Each is an EXACT comparison; there is no prefix, suffix or pattern match among them. */
export type HandoffAssertionExpectation = {
  /** Exact `iss`. Must also start with `VERCEL_OIDC_ISSUER_PREFIX`. */
  issuer: string;
  /** Exact `aud` — an audience DEDICATED to the OAuth-completion worker, never Vercel's default team audience. */
  audience: string;
  /** Exact `sub` — `owner:<team>:project:<project>:environment:<vercel-environment>`. The deployment identity. */
  subject: string;
  /** Exact `owner_id`. */
  teamId: string;
  /** Exact `project_id`. */
  projectId: string;
  /** Exact `environment` — Vercel's own channel name, which for this deployment is NOT the string "staging". */
  vercelEnvironment: string;
};

export type HandoffAssertionClaims = {
  iss: string;
  aud: string;
  sub: string;
  owner_id: string;
  project_id: string;
  environment: string;
  iat: number;
  exp: number;
  nbf?: number;
};

export type HandoffAssertionRefusal =
  | "assertion_missing"
  | "assertion_malformed"
  | "assertion_verifier_missing"
  | "assertion_alg_not_permitted"
  | "assertion_bad_signature"
  | "assertion_issuer_not_vercel"
  | "assertion_issuer_mismatch"
  | "assertion_audience_mismatch"
  | "assertion_subject_mismatch"
  | "assertion_team_mismatch"
  | "assertion_project_mismatch"
  | "assertion_environment_mismatch"
  | "assertion_expired"
  | "assertion_not_yet_valid"
  | "assertion_issued_in_future"
  | "assertion_too_old"
  | "assertion_lifetime_too_long";

export type HandoffRequestRefusal =
  | HandoffAssertionRefusal
  | "handoff_version_header_mismatch"
  | "handoff_correlation_header_mismatch"
  | "handoff_digest_header_missing"
  | "handoff_digest_mismatch"
  | "handoff_body_too_large"
  | "handoff_body_malformed"
  | "handoff_request_invalid"
  | "handoff_payload_bounds_invalid";

/**
 * The injected signature verifier. It receives the exact signing input and the decoded signature; PR 4 resolves `kid`
 * against Vercel's JWKS and returns the answer. Returning `true` on a key it could not resolve would defeat the whole
 * contract, so the type is deliberately a plain boolean with no "unknown" — the verifier decides, fail-closed.
 */
export type AssertionSignatureVerifier = (input: {
  signingInput: string;
  signature: Buffer;
  algorithm: string;
  keyId: string | null;
}) => boolean;

type AssertionOptions = {
  maxLifetimeSeconds?: number;
  maxAgeSeconds?: number;
  clockSkewSeconds?: number;
};

function b64urlDecode(segment: string): Buffer {
  return Buffer.from(segment.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

// A JWT segment must be base64url with no padding. Buffer.from is famously permissive, so the shape is asserted first —
// otherwise two different strings could decode to the same bytes and the signing input would be ambiguous.
const JWT_SEGMENT_RE = /^[A-Za-z0-9_-]+$/;

/**
 * Verify a Vercel OIDC assertion against the pinned expectation.
 *
 * The order is not cosmetic: shape, then algorithm, then SIGNATURE, then claims. Nothing in the payload is compared
 * against anything until the signature has passed, so an attacker-chosen claim cannot influence which branch runs.
 */
export function verifyHandoffAssertion(
  token: string | null | undefined,
  expected: HandoffAssertionExpectation,
  opts: {
    nowSeconds: number;
    verifySignature: AssertionSignatureVerifier;
  } & AssertionOptions,
): { ok: true; claims: HandoffAssertionClaims } | { ok: false; reason: HandoffAssertionRefusal } {
  if (typeof opts?.verifySignature !== "function") return { ok: false, reason: "assertion_verifier_missing" };
  if (typeof token !== "string" || token.length === 0) return { ok: false, reason: "assertion_missing" };

  const parts = token.split(".");
  if (parts.length !== 3 || !parts.every((p) => p.length > 0 && JWT_SEGMENT_RE.test(p))) {
    return { ok: false, reason: "assertion_malformed" };
  }
  const [headerPart, payloadPart, signaturePart] = parts;

  let header: { alg?: unknown; kid?: unknown };
  try {
    header = JSON.parse(b64urlDecode(headerPart).toString("utf8")) as { alg?: unknown; kid?: unknown };
  } catch {
    return { ok: false, reason: "assertion_malformed" };
  }
  if (header?.alg !== PERMITTED_ALG) return { ok: false, reason: "assertion_alg_not_permitted" };

  const signatureOk = opts.verifySignature({
    signingInput: `${headerPart}.${payloadPart}`,
    signature: b64urlDecode(signaturePart),
    algorithm: PERMITTED_ALG,
    keyId: typeof header.kid === "string" ? header.kid : null,
  });
  if (signatureOk !== true) return { ok: false, reason: "assertion_bad_signature" };

  // Parse into `unknown` and CHECK before dereferencing. `JSON.parse("null")` returns null, and a cast would let the
  // very next line throw a TypeError instead of returning the bounded refusal this function's type promises — in PR 4
  // that is a 500 with a stack where the contract advertises a refusal. (Found in adversarial review of PR #398.)
  let parsed: unknown;
  try {
    parsed = JSON.parse(b64urlDecode(payloadPart).toString("utf8")) as unknown;
  } catch {
    return { ok: false, reason: "assertion_malformed" };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { ok: false, reason: "assertion_malformed" };
  }
  const raw = parsed as Record<string, unknown>;

  const str = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);
  const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

  const iss = str(raw.iss);
  const sub = str(raw.sub);
  const ownerId = str(raw.owner_id);
  const projectId = str(raw.project_id);
  const environment = str(raw.environment);
  const iat = num(raw.iat);
  const exp = num(raw.exp);
  const nbf = raw.nbf === undefined ? undefined : num(raw.nbf);
  // Vercel issues a single string audience. An array is ACCEPTED as a shape but must name exactly one audience: a token
  // minted for this worker AND something else is a token some other relying party can also present, and is refused —
  // as an audience mismatch, because that is what it is.
  const audRaw = raw.aud;
  const audIsShaped = typeof audRaw === "string" || (Array.isArray(audRaw) && audRaw.every((a) => typeof a === "string"));
  const aud = typeof audRaw === "string" ? audRaw : Array.isArray(audRaw) && audRaw.length === 1 ? (audRaw[0] as string) : null;

  if (iss === null || sub === null || ownerId === null || projectId === null || environment === null || !audIsShaped) {
    return { ok: false, reason: "assertion_malformed" };
  }
  if (iat === null || exp === null || (raw.nbf !== undefined && nbf == null)) {
    return { ok: false, reason: "assertion_malformed" };
  }

  if (!iss.startsWith(VERCEL_OIDC_ISSUER_PREFIX)) return { ok: false, reason: "assertion_issuer_not_vercel" };
  if (iss !== expected.issuer) return { ok: false, reason: "assertion_issuer_mismatch" };
  if (aud !== expected.audience) return { ok: false, reason: "assertion_audience_mismatch" };
  if (sub !== expected.subject) return { ok: false, reason: "assertion_subject_mismatch" };
  if (ownerId !== expected.teamId) return { ok: false, reason: "assertion_team_mismatch" };
  if (projectId !== expected.projectId) return { ok: false, reason: "assertion_project_mismatch" };
  if (environment !== expected.vercelEnvironment) return { ok: false, reason: "assertion_environment_mismatch" };

  const skew = opts.clockSkewSeconds ?? DEFAULT_CLOCK_SKEW_SECONDS;
  const maxLifetime = opts.maxLifetimeSeconds ?? DEFAULT_MAX_ASSERTION_LIFETIME_SECONDS;
  const maxAge = opts.maxAgeSeconds ?? DEFAULT_MAX_ASSERTION_AGE_SECONDS;
  const now = opts.nowSeconds;

  // Expiry gets NO skew grace. Every other clock comparison here is lenient by `skew` in the safe direction; this one
  // would be lenient in the unsafe direction, and a caller that needs a fresh assertion can always mint one.
  if (!(exp > now)) return { ok: false, reason: "assertion_expired" };
  // `iat` is checked before `nbf`: a token DATED in the future is the specific thing this contract refuses, and saying
  // so is more useful than "not yet valid", which is what a legitimately delayed token would report.
  if (iat > now + skew) return { ok: false, reason: "assertion_issued_in_future" };
  if (nbf !== undefined && nbf !== null && nbf > now + skew) return { ok: false, reason: "assertion_not_yet_valid" };
  if (now - iat > maxAge) return { ok: false, reason: "assertion_too_old" };
  if (exp - iat > maxLifetime) return { ok: false, reason: "assertion_lifetime_too_long" };

  return { ok: true, claims: { iss, aud, sub, owner_id: ownerId, project_id: projectId, environment, iat, exp, ...(nbf == null ? {} : { nbf }) } };
}

/**
 * Verify a complete handoff request — the assertion AND the envelope it arrived in. This is the entry point PR 4's
 * worker endpoint calls; everything it needs to decide "accept or refuse" is here, and the only thing left for PR 4 is
 * the JWKS-backed verifier and the 0081 enqueue call.
 *
 * `rawBody` must be the bytes as received, not a re-serialization: the digest is over what arrived.
 */
export function verifyHandoffRequest(input: {
  token: string | null | undefined;
  headers: Readonly<Record<string, string | undefined>>;
  rawBody: string;
  expected: HandoffAssertionExpectation;
  nowSeconds: number;
  verifySignature: AssertionSignatureVerifier;
} & AssertionOptions):
  | { ok: true; claims: HandoffAssertionClaims; request: HandoffRequest; protectedPayload: Buffer }
  | { ok: false; reason: HandoffRequestRefusal } {
  const assertion = verifyHandoffAssertion(input.token, input.expected, {
    nowSeconds: input.nowSeconds,
    verifySignature: input.verifySignature,
    maxLifetimeSeconds: input.maxLifetimeSeconds,
    maxAgeSeconds: input.maxAgeSeconds,
    clockSkewSeconds: input.clockSkewSeconds,
  });
  if (!assertion.ok) return { ok: false, reason: assertion.reason };

  // Header lookup is case-insensitive: Node lowercases incoming header names, but a caller passing a plain object from
  // somewhere else must not accidentally pass the version check by casing.
  const header = (name: string): string | undefined => {
    for (const [k, v] of Object.entries(input.headers)) if (k.toLowerCase() === name) return v;
    return undefined;
  };

  if (header(HANDOFF_VERSION_HEADER) !== String(HANDOFF_PROTOCOL_VERSION)) {
    return { ok: false, reason: "handoff_version_header_mismatch" };
  }
  if (Buffer.byteLength(input.rawBody, "utf8") > MAX_HANDOFF_BODY_BYTES) {
    return { ok: false, reason: "handoff_body_too_large" };
  }

  const digestHeader = header(HANDOFF_DIGEST_HEADER);
  if (typeof digestHeader !== "string" || !SHA256_HEX_RE.test(digestHeader)) {
    return { ok: false, reason: "handoff_digest_header_missing" };
  }
  const actualDigest = handoffBodyDigest(input.rawBody);
  if (!timingSafeEqual(Buffer.from(digestHeader, "hex"), Buffer.from(actualDigest, "hex"))) {
    return { ok: false, reason: "handoff_digest_mismatch" };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(input.rawBody) as unknown;
  } catch {
    return { ok: false, reason: "handoff_body_malformed" };
  }
  const request = handoffRequestSchema.safeParse(parsed);
  if (!request.success) return { ok: false, reason: "handoff_request_invalid" };

  // The correlation id is this request's nonce: unique per authorize, and unique in `oauth_completion_jobs` forever.
  // Requiring the header to agree with the body means a replayed envelope cannot be re-pointed at another correlation.
  if (header(HANDOFF_CORRELATION_HEADER) !== request.data.correlationId) {
    return { ok: false, reason: "handoff_correlation_header_mismatch" };
  }

  // Re-serializing and comparing catches a body that parses to the right fields but is not the canonical form — the
  // digest the worker verified must be the digest of a body the client could actually have produced.
  if (canonicalHandoffBody(request.data) !== input.rawBody) {
    return { ok: false, reason: "handoff_body_malformed" };
  }

  const protectedPayload = Buffer.from(request.data.protectedPayload, "base64");
  if (
    protectedPayload.byteLength < MIN_PROTECTED_PAYLOAD_BYTES ||
    protectedPayload.byteLength > MAX_PROTECTED_PAYLOAD_BYTES ||
    protectedPayload.toString("base64") !== request.data.protectedPayload
  ) {
    return { ok: false, reason: "handoff_payload_bounds_invalid" };
  }

  return { ok: true, claims: assertion.claims, request: request.data, protectedPayload };
}

/**
 * An RS256 verifier built from a JWKS-shaped key set. PR 4 supplies the fetched, cached key set; this function does the
 * matching and the crypto, so the worker's only remaining job is retrieval. Exported here rather than left to PR 4 so
 * that "resolve the kid, then verify" is reviewed once, in the repository that owns the protocol.
 *
 * A missing `kid`, an unmatched `kid`, or a key that is not RSA is a `false` — never a fallback to "try them all".
 */
export function makeJwksSignatureVerifier(
  keys: ReadonlyArray<{ kid?: string; kty?: string; alg?: string; n?: string; e?: string; use?: string }>,
): AssertionSignatureVerifier {
  return ({ signingInput, signature, keyId }) => {
    if (typeof keyId !== "string" || keyId.length === 0) return false;
    const jwk = keys.find((k) => k.kid === keyId);
    if (!jwk || jwk.kty !== "RSA" || typeof jwk.n !== "string" || typeof jwk.e !== "string") return false;
    if (jwk.alg !== undefined && jwk.alg !== PERMITTED_ALG) return false;
    if (jwk.use !== undefined && jwk.use !== "sig") return false;
    try {
      const key = createPublicKey({ key: { kty: "RSA", n: jwk.n, e: jwk.e }, format: "jwk" });
      return verifySignatureWithKey("sha256", Buffer.from(signingInput, "utf8"), key, signature);
    } catch {
      return false;
    }
  };
}
