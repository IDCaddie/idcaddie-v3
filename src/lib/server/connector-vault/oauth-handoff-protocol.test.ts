// Phase 8K — the V3 → completion-worker handoff protocol, and the OIDC claim contract PR 4 must implement.
//
// The property under test is that EVERY pinned fact is load-bearing. Each case below alters exactly one thing about an
// otherwise-valid assertion or request, so a pass can only mean that thing is actually checked. A contract whose tests
// only prove the happy path is a contract that has not been tested.
//
// NO JWT LITERAL IS COMMITTED. Every token here is assembled and signed at test time from a key pair generated in this
// process — `check-auth-safety.sh` fails on a hardcoded `eyJ…` anywhere under src/, and rightly so.

import { describe, it, expect } from "vitest";
import { createSign, generateKeyPairSync, type KeyObject } from "node:crypto";
import {
  CORRELATION_ID_RE,
  HANDOFF_CORRELATION_HEADER,
  HANDOFF_DIGEST_HEADER,
  HANDOFF_ENVIRONMENT,
  HANDOFF_PATH,
  HANDOFF_PAYLOAD_SCHEME,
  HANDOFF_PROTOCOL_VERSION,
  HANDOFF_PROVIDER,
  HANDOFF_REDIRECT_URI,
  HANDOFF_VERSION_HEADER,
  MAX_HANDOFF_BODY_BYTES,
  MIN_PROTECTED_PAYLOAD_BYTES,
  STAGING_VERCEL_PROJECT_ID,
  STAGING_VERCEL_TEAM_ID,
  VERCEL_OIDC_ISSUER_PREFIX,
  canonicalHandoffBody,
  handoffAckSchema,
  handoffBodyDigest,
  handoffRequestSchema,
  makeJwksSignatureVerifier,
  verifyHandoffAssertion,
  verifyHandoffRequest,
  type HandoffAssertionExpectation,
  type HandoffRequest,
} from "./oauth-handoff-protocol";

// ── Test key material and a minimal RS256 signer ─────────────────────────────────────────────────────────────────────
const KID = "test-kid-1";
const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
const otherRsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwkOf = (key: KeyObject, kid: string) => {
  const jwk = key.export({ format: "jwk" }) as { n: string; e: string };
  return { kid, kty: "RSA", alg: "RS256", use: "sig", n: jwk.n, e: jwk.e };
};
const jwks = [jwkOf(rsa.publicKey, KID)];
const verifySignature = makeJwksSignatureVerifier(jwks);

const b64url = (s: string | Buffer) => Buffer.from(s as never).toString("base64url");
function signJwt(payload: Record<string, unknown>, opts: { key?: KeyObject; alg?: string; kid?: string | null } = {}): string {
  const header: Record<string, unknown> = { alg: opts.alg ?? "RS256", typ: "JWT" };
  if (opts.kid !== null) header.kid = opts.kid ?? KID;
  const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
  const signer = createSign("sha256").update(signingInput);
  return `${signingInput}.${signer.sign(opts.key ?? rsa.privateKey, "base64url")}`;
}

const NOW = 1_800_000_000;
const EXPECTED: HandoffAssertionExpectation = {
  issuer: `${VERCEL_OIDC_ISSUER_PREFIX}idcaddie`,
  audience: "https://idcaddie.example/oauth-completion-worker",
  subject: "owner:idcaddie:project:idcaddie-v3:environment:production",
  teamId: STAGING_VERCEL_TEAM_ID,
  projectId: STAGING_VERCEL_PROJECT_ID,
  vercelEnvironment: "production",
};
const CLAIMS = {
  iss: EXPECTED.issuer,
  aud: EXPECTED.audience,
  sub: EXPECTED.subject,
  owner_id: EXPECTED.teamId,
  project_id: EXPECTED.projectId,
  environment: EXPECTED.vercelEnvironment,
  iat: NOW - 60,
  nbf: NOW - 60,
  exp: NOW + 600,
};
const token = (over: Record<string, unknown> = {}, opts?: Parameters<typeof signJwt>[1]) => signJwt({ ...CLAIMS, ...over }, opts);
const verify = (t: string | null | undefined, over: Partial<HandoffAssertionExpectation> = {}) =>
  verifyHandoffAssertion(t, { ...EXPECTED, ...over }, { nowSeconds: NOW, verifySignature });

describe("OIDC assertion — the pinned claim contract", () => {
  it("accepts the exact expected assertion", () => {
    const r = verify(token());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.claims.project_id).toBe(STAGING_VERCEL_PROJECT_ID);
    expect(r.claims.owner_id).toBe(STAGING_VERCEL_TEAM_ID);
  });

  it("refuses a MISSING assertion", () => {
    for (const t of [null, undefined, ""]) expect(verify(t)).toEqual({ ok: false, reason: "assertion_missing" });
  });

  it("refuses a malformed assertion", () => {
    for (const t of ["a.b", "a.b.c.d", "....", "not-a-jwt", "a.b.", "%%%.%%%.%%%"]) {
      expect(verify(t).ok, t).toBe(false);
    }
  });

  // A DECODED jwt is not an AUTHENTICATED jwt. The verifier is required by the type and re-checked at runtime, so a
  // caller cannot omit it and get a "successful" decode.
  it("refuses outright when no signature verifier is supplied", () => {
    expect(
      verifyHandoffAssertion(token(), EXPECTED, { nowSeconds: NOW, verifySignature: undefined as never }),
    ).toEqual({ ok: false, reason: "assertion_verifier_missing" });
  });

  it("refuses a valid-looking token signed by the WRONG key", () => {
    expect(verify(token({}, { key: otherRsa.privateKey }))).toEqual({ ok: false, reason: "assertion_bad_signature" });
  });

  it("refuses an ALTERED payload under a signature that was valid for the original", () => {
    const original = token();
    const [h, , s] = original.split(".");
    const tampered = `${h}.${b64url(JSON.stringify({ ...CLAIMS, project_id: "prj_ATTACKER" }))}.${s}`;
    expect(verify(tampered)).toEqual({ ok: false, reason: "assertion_bad_signature" });
  });

  it("refuses alg=none and every alg that is not RS256 — before any claim is read", () => {
    for (const alg of ["none", "HS256", "RS512", "ES256"]) {
      expect(verify(token({}, { alg })), alg).toEqual({ ok: false, reason: "assertion_alg_not_permitted" });
    }
  });

  it("refuses when the kid is absent or names a key that is not in the key set", () => {
    expect(verify(token({}, { kid: null }))).toEqual({ ok: false, reason: "assertion_bad_signature" });
    expect(verify(token({}, { kid: "some-other-kid" }))).toEqual({ ok: false, reason: "assertion_bad_signature" });
  });

  it("refuses an issuer that is not a Vercel OIDC issuer at all", () => {
    expect(verify(token({ iss: "https://oidc.attacker.example/idcaddie" }, {}))).toEqual({ ok: false, reason: "assertion_issuer_not_vercel" });
  });

  it("refuses the WRONG Vercel issuer", () => {
    expect(verify(token({ iss: `${VERCEL_OIDC_ISSUER_PREFIX}some-other-team` }))).toEqual({ ok: false, reason: "assertion_issuer_mismatch" });
  });

  it("refuses the WRONG audience — including Vercel's default team audience", () => {
    expect(verify(token({ aud: "https://vercel.com/idcaddie" }))).toEqual({ ok: false, reason: "assertion_audience_mismatch" });
    expect(verify(token({ aud: [EXPECTED.audience, "https://vercel.com/idcaddie"] }))).toEqual({ ok: false, reason: "assertion_audience_mismatch" });
    // A single-element array naming exactly this worker is the same assertion in a different shape.
    expect(verify(token({ aud: [EXPECTED.audience] })).ok).toBe(true);
  });

  it("refuses the WRONG deployment subject", () => {
    expect(verify(token({ sub: "owner:idcaddie:project:some-other-project:environment:production" })))
      .toEqual({ ok: false, reason: "assertion_subject_mismatch" });
  });

  it("refuses the WRONG team id", () => {
    expect(verify(token({ owner_id: "team_SOMEONEELSE0000000000" }))).toEqual({ ok: false, reason: "assertion_team_mismatch" });
  });

  it("refuses the WRONG project id", () => {
    expect(verify(token({ project_id: "prj_SOMEOTHERPROJECT00000" }))).toEqual({ ok: false, reason: "assertion_project_mismatch" });
  });

  it("refuses the WRONG Vercel environment", () => {
    for (const e of ["preview", "development", "staging"]) {
      expect(verify(token({ environment: e })), e).toEqual({ ok: false, reason: "assertion_environment_mismatch" });
    }
  });

  it("refuses an EXPIRED assertion, with no skew grace on expiry", () => {
    expect(verify(token({ exp: NOW - 1 }))).toEqual({ ok: false, reason: "assertion_expired" });
    expect(verify(token({ exp: NOW }))).toEqual({ ok: false, reason: "assertion_expired" });
    expect(verify(token({ exp: NOW + 1 })).ok).toBe(true);
  });

  it("refuses an assertion issued too far in the FUTURE", () => {
    expect(verify(token({ iat: NOW + 31, nbf: NOW + 31 }))).toEqual({ ok: false, reason: "assertion_issued_in_future" });
    // …while tolerating bounded clock drift.
    expect(verify(token({ iat: NOW + 5, nbf: NOW + 5 })).ok).toBe(true);
  });

  it("refuses an assertion that is not yet valid", () => {
    expect(verify(token({ nbf: NOW + 120, iat: NOW - 60 }))).toEqual({ ok: false, reason: "assertion_not_yet_valid" });
  });

  it("refuses an assertion that is too OLD or claims too long a lifetime", () => {
    expect(verify(token({ iat: NOW - 7200, exp: NOW + 600, nbf: NOW - 7200 }))).toEqual({ ok: false, reason: "assertion_too_old" });
    expect(verifyHandoffAssertion(token({ iat: NOW - 10, exp: NOW + 100_000 }), EXPECTED, { nowSeconds: NOW, verifySignature }))
      .toEqual({ ok: false, reason: "assertion_lifetime_too_long" });
  });

  // `JSON.parse("null")` returns null, and a payload that is a scalar or an array is not a claim set either. Each must
  // return the bounded refusal this function's type promises — in PR 4's worker endpoint an unhandled TypeError is a
  // 500 with a stack where the contract advertises a refusal. (Found in adversarial review of PR #398.)
  it("refuses a payload that is not a claims OBJECT rather than throwing on it", () => {
    for (const payload of ["null", "5", '"a string"', "[]", '[{"iss":"x"}]', "true"]) {
      const token = `${b64url(JSON.stringify({ alg: "RS256", kid: KID }))}.${b64url(payload)}`;
      const signed = `${token}.${createSign("sha256").update(token).sign(rsa.privateKey, "base64url")}`;
      expect(() => verify(signed), payload).not.toThrow();
      expect(verify(signed), payload).toEqual({ ok: false, reason: "assertion_malformed" });
    }
  });

  it("refuses a token missing any pinned claim rather than defaulting it", () => {
    for (const k of ["iss", "aud", "sub", "owner_id", "project_id", "environment", "iat", "exp"]) {
      const claims: Record<string, unknown> = { ...CLAIMS };
      delete claims[k];
      expect(verify(signJwt(claims)), k).toEqual({ ok: false, reason: "assertion_malformed" });
    }
  });

  it("the JWKS verifier refuses a non-RSA, mis-alg'd or use-mismatched key", () => {
    // The fixture is REALLY SIGNED, so the baseline accepts and the metadata guard is the only difference between the
    // accept case and each refuse case. With an unsigned fixture every case returned false and all three guards could
    // be deleted with this test still green. (Found in adversarial review of PR #398.)
    const signingInput = "a.b";
    const input = {
      signingInput,
      signature: createSign("sha256").update(signingInput).sign(rsa.privateKey),
      algorithm: "RS256",
      keyId: KID,
    };
    expect(makeJwksSignatureVerifier(jwks)(input), "baseline: the correct key must ACCEPT this fixture").toBe(true);

    expect(makeJwksSignatureVerifier([{ ...jwks[0], kty: "oct" }])(input), "kty").toBe(false);
    expect(makeJwksSignatureVerifier([{ ...jwks[0], alg: "RS512" }])(input), "alg").toBe(false);
    expect(makeJwksSignatureVerifier([{ ...jwks[0], use: "enc" }])(input), "use").toBe(false);
    expect(makeJwksSignatureVerifier([{ ...jwks[0], kid: "another-kid" }])(input), "kid").toBe(false);
    expect(makeJwksSignatureVerifier([])(input), "empty key set").toBe(false);
    // A key set entry missing its modulus must return false, not throw.
    expect(makeJwksSignatureVerifier([{ kid: KID, kty: "RSA", e: "AQAB" }])(input), "no n").toBe(false);
  });

  it("never places the assertion or a claim value in a refusal", () => {
    const leaky = token({ project_id: "prj_LEAKME_SECRET_VALUE" });
    const r = verify(leaky);
    const s = JSON.stringify(r);
    expect(s).not.toContain("LEAKME");
    expect(s).not.toContain(leaky);
    expect(Object.keys(r).sort()).toEqual(["ok", "reason"]);
  });
});

// ── The request envelope ─────────────────────────────────────────────────────────────────────────────────────────────
const REQUEST: HandoffRequest = {
  version: HANDOFF_PROTOCOL_VERSION,
  environment: HANDOFF_ENVIRONMENT,
  correlationId: "corr-live-run-1",
  tenantId: "aaaa1111-1111-1111-1111-111111111111",
  connectorId: "1575cde3-0000-4000-8000-00000000bbbb",
  provider: HANDOFF_PROVIDER,
  redirectUri: HANDOFF_REDIRECT_URI,
  expectedTeamId: "T0ABCDEF123",
  payloadScheme: HANDOFF_PAYLOAD_SCHEME,
  payloadKeyId: "worker-seal-v1",
  // 61 bytes: one over the floor the database and this module both enforce.
  protectedPayload: Buffer.alloc(MIN_PROTECTED_PAYLOAD_BYTES + 1, 7).toString("base64"),
  nonceHash: "a3f1c0de5b7248e9a1b2c3d4e5f60718293a4b5c6d7e8f9012345678abcdef01",
  subject: "7f3e1c22-0000-4000-8000-0000000000aa",
};

const envelope = (request: HandoffRequest = REQUEST, over: Partial<{ body: string; headers: Record<string, string | undefined> }> = {}) => {
  // The headers always describe `request`. Overriding `body` therefore simulates alteration IN TRANSIT — the digest
  // that arrived no longer describes the bytes that arrived — which is the case a transport binding exists to catch.
  return {
    token: token(),
    rawBody: over.body ?? canonicalHandoffBody(request),
    headers: {
      [HANDOFF_VERSION_HEADER]: String(HANDOFF_PROTOCOL_VERSION),
      [HANDOFF_CORRELATION_HEADER]: request.correlationId,
      [HANDOFF_DIGEST_HEADER]: handoffBodyDigest(canonicalHandoffBody(request)),
      ...over.headers,
    },
    expected: EXPECTED,
    nowSeconds: NOW,
    verifySignature,
  };
};

describe("handoff request — the envelope PR 4 verifies", () => {
  it("accepts a well-formed request", () => {
    const r = verifyHandoffRequest(envelope());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.request).toEqual(REQUEST);
    expect(r.protectedPayload.byteLength).toBe(MIN_PROTECTED_PAYLOAD_BYTES + 1);
  });

  it("refuses the whole request when the ASSERTION fails, before reading the body", () => {
    expect(verifyHandoffRequest({ ...envelope(), token: null })).toEqual({ ok: false, reason: "assertion_missing" });
  });

  it("refuses a wrong or absent protocol version header", () => {
    for (const v of [undefined, "", "1", "3", "2.0", " 2"]) {
      expect(verifyHandoffRequest(envelope(REQUEST, { headers: { [HANDOFF_VERSION_HEADER]: v } })), String(v))
        .toEqual({ ok: false, reason: "handoff_version_header_mismatch" });
    }
  });

  it("refuses a wrong nonce — the correlation header must equal the body's correlation id", () => {
    expect(verifyHandoffRequest(envelope(REQUEST, { headers: { [HANDOFF_CORRELATION_HEADER]: "corr-some-other-run" } })))
      .toEqual({ ok: false, reason: "handoff_correlation_header_mismatch" });
    expect(verifyHandoffRequest(envelope(REQUEST, { headers: { [HANDOFF_CORRELATION_HEADER]: undefined } })))
      .toEqual({ ok: false, reason: "handoff_correlation_header_mismatch" });
  });

  it("refuses a missing or malformed body digest", () => {
    for (const d of [undefined, "", "not-hex", "ABCDEF", handoffBodyDigest("x").slice(0, 63)]) {
      expect(verifyHandoffRequest(envelope(REQUEST, { headers: { [HANDOFF_DIGEST_HEADER]: d } })), String(d))
        .toEqual({ ok: false, reason: "handoff_digest_header_missing" });
    }
  });

  // The headline binding: a body altered in transit no longer matches the digest that came with it.
  it("refuses an ALTERED body against the digest it arrived with", () => {
    const good = canonicalHandoffBody(REQUEST);
    const altered = canonicalHandoffBody({ ...REQUEST, tenantId: "bbbb2222-2222-2222-2222-222222222222" });
    expect(verifyHandoffRequest(envelope(REQUEST, { body: altered, headers: { [HANDOFF_DIGEST_HEADER]: handoffBodyDigest(good) } })))
      .toEqual({ ok: false, reason: "handoff_digest_mismatch" });
  });

  // Alteration IN TRANSIT: the headers are the originals, so the digest no longer describes the body that arrived.
  // Every field is covered because the digest is over the whole canonical body, not a chosen subset of it.
  it("refuses an altered tenant, connector, provider, redirect, scheme, correlation or environment in transit", () => {
    const mutations: Array<Partial<HandoffRequest>> = [
      { tenantId: "bbbb2222-2222-2222-2222-222222222222" },
      { connectorId: "bbbb2222-2222-2222-2222-222222222222" },
      { provider: "okta" as never },
      { redirectUri: "https://attacker.example/connectors/oauth/callback" as never },
      { payloadScheme: "AES-256-CBC" as never },
      { correlationId: "corr-some-other-run" },
      { environment: "production" as never },
      { version: 1 as never },
      { expectedTeamId: "T9ZZZZZZZZZ" },
      { payloadKeyId: "worker-seal-v2" },
      { protectedPayload: Buffer.alloc(MIN_PROTECTED_PAYLOAD_BYTES + 1, 9).toString("base64") },
    ];
    for (const m of mutations) {
      const altered = canonicalHandoffBody({ ...REQUEST, ...m });
      expect(verifyHandoffRequest(envelope(REQUEST, { body: altered })), JSON.stringify(m))
        .toEqual({ ok: false, reason: "handoff_digest_mismatch" });
    }
  });

  // …and a re-digested body carrying a value outside the pinned vocabulary is refused on its own terms, so an attacker
  // who controls the digest header as well gains nothing.
  it("refuses structurally invalid values even when the digest is recomputed to match", () => {
    const mutations: Array<Partial<HandoffRequest>> = [
      { provider: "okta" as never },
      { redirectUri: "https://attacker.example/connectors/oauth/callback" as never },
      { payloadScheme: "AES-256-CBC" as never },
      { environment: "production" as never },
      { version: 1 as never },
      { tenantId: "not-a-uuid" as never },
      { expectedTeamId: "not-a-team" as never },
      { correlationId: "corr with spaces" as never },
    ];
    for (const m of mutations) {
      expect(verifyHandoffRequest(envelope({ ...REQUEST, ...m })), JSON.stringify(m))
        .toEqual({ ok: false, reason: "handoff_request_invalid" });
    }
  });

  it("refuses a self-consistent body whose correlation no longer matches the header", () => {
    const altered = { ...REQUEST, correlationId: "corr-some-other-run" };
    const body = canonicalHandoffBody(altered);
    expect(verifyHandoffRequest(envelope(REQUEST, { body, headers: { [HANDOFF_DIGEST_HEADER]: handoffBodyDigest(body) } })))
      .toEqual({ ok: false, reason: "handoff_correlation_header_mismatch" });
  });

  it("rejects UNKNOWN fields rather than ignoring them", () => {
    const body = JSON.stringify({ ...JSON.parse(canonicalHandoffBody(REQUEST)), deadline: "2026-08-02T00:00:00Z" });
    expect(verifyHandoffRequest(envelope(REQUEST, { body, headers: { [HANDOFF_DIGEST_HEADER]: handoffBodyDigest(body) } })))
      .toEqual({ ok: false, reason: "handoff_request_invalid" });
  });

  it("refuses a NON-CANONICAL body that parses to the right fields", () => {
    // Same fields, different key order. It would enqueue identically, but it is not a body this client can produce, and
    // accepting it would mean the digest covered something other than the canonical form.
    const reordered = JSON.stringify({ correlationId: REQUEST.correlationId, ...JSON.parse(canonicalHandoffBody(REQUEST)) });
    expect(verifyHandoffRequest(envelope(REQUEST, { body: reordered, headers: { [HANDOFF_DIGEST_HEADER]: handoffBodyDigest(reordered) } })))
      .toEqual({ ok: false, reason: "handoff_body_malformed" });
  });

  it("refuses an oversized body before parsing it", () => {
    const body = "x".repeat(MAX_HANDOFF_BODY_BYTES + 1);
    expect(verifyHandoffRequest(envelope(REQUEST, { body, headers: { [HANDOFF_DIGEST_HEADER]: handoffBodyDigest(body) } })))
      .toEqual({ ok: false, reason: "handoff_body_too_large" });
  });

  it("refuses a body that is not JSON", () => {
    const body = "definitely not json";
    expect(verifyHandoffRequest(envelope(REQUEST, { body, headers: { [HANDOFF_DIGEST_HEADER]: handoffBodyDigest(body) } })))
      .toEqual({ ok: false, reason: "handoff_body_malformed" });
  });

  it("refuses a payload outside the database's own size bounds", () => {
    for (const size of [0, MIN_PROTECTED_PAYLOAD_BYTES - 1, 8193]) {
      const request = { ...REQUEST, protectedPayload: Buffer.alloc(size, 3).toString("base64") };
      const r = verifyHandoffRequest(envelope(request));
      expect(r.ok, String(size)).toBe(false);
      expect(["handoff_payload_bounds_invalid", "handoff_request_invalid"]).toContain((r as { reason: string }).reason);
    }
  });

  // `verifyHandoffRequest` forwards the three lifetime options to `verifyHandoffAssertion`. That forwarding is the
  // whole reason those options exist as parameters (doc 83 §8.4 says PR 4 must tighten them), and nothing exercised it:
  // dropping all three, or swapping maxAge and maxLifetime, left the suite green — so PR 4 could pass a tightened
  // ceiling, watch its tests pass, and ship a worker silently applying the 1-hour default.
  // (Found in adversarial review of PR #398.)
  it("FORWARDS the assertion lifetime options rather than silently applying the defaults", () => {
    // Well inside the 3600s defaults, so only a forwarded tighter ceiling can reject these.
    const old = () => envelope(REQUEST, { headers: {} });
    const withToken = (over: Record<string, unknown>) => ({ ...old(), token: token(over) });

    // 600s old, 900s claimed lifetime — accepted under the defaults.
    const aged = withToken({ iat: NOW - 600, nbf: NOW - 600, exp: NOW + 300 });
    expect(verifyHandoffRequest(aged).ok, "accepted under the defaults").toBe(true);

    // …and refused once PR 4 tightens the AGE ceiling to 300s.
    expect(verifyHandoffRequest({ ...aged, maxAgeSeconds: 300 })).toEqual({ ok: false, reason: "assertion_too_old" });
    // …and refused once PR 4 tightens the LIFETIME ceiling to 300s. These are two different ceilings, so a swap of the
    // two parameters is caught as well.
    expect(verifyHandoffRequest({ ...aged, maxLifetimeSeconds: 300 })).toEqual({ ok: false, reason: "assertion_lifetime_too_long" });
    // …and the skew is forwarded too: a token 20s in the future passes the 30s default and fails a 5s ceiling.
    const future = withToken({ iat: NOW + 20, nbf: NOW + 20, exp: NOW + 620 });
    expect(verifyHandoffRequest(future).ok, "20s drift accepted under the 30s default").toBe(true);
    expect(verifyHandoffRequest({ ...future, clockSkewSeconds: 5 })).toEqual({ ok: false, reason: "assertion_issued_in_future" });
  });

  it("matches headers case-insensitively", () => {
    const e = envelope();
    const upper = Object.fromEntries(Object.entries(e.headers).map(([k, v]) => [k.toUpperCase(), v]));
    expect(verifyHandoffRequest({ ...e, headers: upper }).ok).toBe(true);
  });

  it("never places the body, payload or assertion in a refusal", () => {
    const r = verifyHandoffRequest({ ...envelope(), token: token({ aud: "https://vercel.com/LEAKME" }) });
    const s = JSON.stringify(r);
    expect(s).not.toContain("LEAKME");
    expect(s).not.toContain(REQUEST.protectedPayload);
    expect(Object.keys(r).sort()).toEqual(["ok", "reason"]);
  });
});

describe("protocol constants and shapes", () => {
  it("pins the values migration 0081 constrains", () => {
    expect(HANDOFF_PAYLOAD_SCHEME).toBe("X25519-HKDF-SHA256-AES-256-GCM");
    expect(HANDOFF_PROVIDER).toBe("slack");
    expect(HANDOFF_REDIRECT_URI).toBe("https://idcaddie-v3.vercel.app/connectors/oauth/callback");
    expect(HANDOFF_ENVIRONMENT).toBe("staging");
    expect(HANDOFF_PATH).toBe("/internal/oauth-completion/handoff");
    expect(CORRELATION_ID_RE.test("corr-live-run-1")).toBe(true);
    expect(CORRELATION_ID_RE.test("corr live run")).toBe(false);
  });

  it("canonical serialization is stable and digest-consistent", () => {
    const a = canonicalHandoffBody(REQUEST);
    const b = canonicalHandoffBody({ ...REQUEST });
    expect(a).toBe(b);
    expect(handoffBodyDigest(a)).toBe(handoffBodyDigest(b));
    expect(handoffBodyDigest(a)).toMatch(/^[0-9a-f]{64}$/);
    expect(handoffRequestSchema.safeParse(JSON.parse(a)).success).toBe(true);
  });

  it("the acknowledgement vocabulary is exactly two words and carries nothing else", () => {
    expect(handoffAckSchema.safeParse({ version: HANDOFF_PROTOCOL_VERSION, status: "accepted" }).success).toBe(true);
    expect(handoffAckSchema.safeParse({ version: HANDOFF_PROTOCOL_VERSION, status: "duplicate" }).success).toBe(true);
    expect(handoffAckSchema.safeParse({ version: HANDOFF_PROTOCOL_VERSION, status: "completed" }).success).toBe(false)
    expect(handoffAckSchema.safeParse({ version: 1, status: "accepted" }).success).toBe(false);
    // No job id, no timestamps, no reason — an acknowledgement is not a status report.
    expect(handoffAckSchema.safeParse({ version: 1, status: "accepted", jobId: "x" }).success).toBe(false);
  });
});
