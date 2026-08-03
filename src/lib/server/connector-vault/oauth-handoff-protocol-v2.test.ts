// Phase 8M — what protocol v2 adds, and what it deliberately still does not carry.
//
// v1 could not complete an OAuth flow correctly: `oauth_completer_consume_oauth_pending` (migration 0079) matches its
// row on `nonce_hash` and `subject`, and v1 carried neither, so the worker could never consume the pending row. v2
// carries exactly those two values.
//
// The assertions here are as much about what is ABSENT as what is present. A protocol that fixed the consume by
// shipping the raw nonce, or the session's email, would have traded a correctness bug for a disclosure one.

import { describe, it, expect } from "vitest";
import { createHash, generateKeyPairSync, type KeyObject } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  HANDOFF_ENVIRONMENT,
  HANDOFF_PAYLOAD_SCHEME,
  HANDOFF_PROTOCOL_VERSION,
  HANDOFF_PROVIDER,
  HANDOFF_REDIRECT_URI,
  NONCE_HASH_RE,
  canonicalHandoffBody,
  handoffBodyDigest,
  handoffRequestSchema,
  type HandoffRequest,
} from "./oauth-handoff-protocol";
import { canonicalSealAad, parseWorkerSealKey, sealAuthorizationCode, type SealBinding } from "./oauth-payload-seal";
import { hashOAuthValue } from "./oauth-pending";

const spki = (k: KeyObject) => (k.export({ format: "der", type: "spki" }) as Buffer).toString("base64");
const worker = generateKeyPairSync("x25519");
const KEY_ID = "worker-seal-v1";

/** A raw single-use CSRF nonce. It must never appear in ANYTHING that leaves this process. */
const RAW_NONCE = "n0nce-RAW-MUSTNOTLEAK-9c1f2a3b4d5e6f70";
const NONCE_HASH = hashOAuthValue(RAW_NONCE);
const SUBJECT = "7f3e1c22-0000-4000-8000-0000000000aa";
const TENANT = "aaaa1111-1111-1111-1111-111111111111";
const CONNECTOR = "1575cde3-0000-4000-8000-00000000bbbb";
const CORRELATION = "corr-live-run-1";
const TEAM = "T0ABCDEF123";
const CODE = "1234567890123.9876543210987.abcdef0123456789abcdef0123456789abcdef01";

const BINDING: SealBinding = {
  tenantId: TENANT, connectorId: CONNECTOR, correlationId: CORRELATION,
  expectedTeamId: TEAM, payloadKeyId: KEY_ID, nonceHash: NONCE_HASH, subject: SUBJECT,
};

const REQUEST: HandoffRequest = {
  version: HANDOFF_PROTOCOL_VERSION,
  environment: HANDOFF_ENVIRONMENT,
  correlationId: CORRELATION,
  tenantId: TENANT,
  connectorId: CONNECTOR,
  provider: HANDOFF_PROVIDER,
  redirectUri: HANDOFF_REDIRECT_URI,
  expectedTeamId: TEAM,
  payloadScheme: HANDOFF_PAYLOAD_SCHEME,
  payloadKeyId: KEY_ID,
  protectedPayload: sealAuthorizationCode(CODE, parseWorkerSealKey(spki(worker.publicKey), KEY_ID), BINDING).protectedPayload.toString("base64"),
  nonceHash: NONCE_HASH,
  subject: SUBJECT,
};

// ── 1. The version, and the refusal of v1 ────────────────────────────────────────────────────────────────────────────
describe("protocol v2 — v1 cannot reach live completion", () => {
  it("the pinned version is 2", () => {
    expect(HANDOFF_PROTOCOL_VERSION).toBe(2);
  });

  it("a v1-SHAPED body — the exact eleven fields v1 sent — is refused", () => {
    const { nonceHash: _n, subject: _s, ...v1Shape } = REQUEST;
    expect(Object.keys(v1Shape)).toHaveLength(11);
    expect(handoffRequestSchema.safeParse(v1Shape).success).toBe(false);
    // …and it is refused for the RIGHT reason: the two new fields are missing, not some incidental mismatch.
    const parsed = handoffRequestSchema.safeParse(v1Shape);
    const missing = parsed.success ? [] : parsed.error.issues.map((i) => i.path.join("."));
    expect(missing.sort()).toEqual(["nonceHash", "subject"]);
  });

  it("a body declaring version 1 is refused even if it carries the new fields", () => {
    expect(handoffRequestSchema.safeParse({ ...REQUEST, version: 1 }).success).toBe(false);
    expect(handoffRequestSchema.safeParse({ ...REQUEST, version: 3 }).success).toBe(false);
  });

  it("there is no negotiation surface — no `minVersion`, `supportedVersions` or downgrade path in the module", () => {
    // Comment-stripped: the module's own header explains at length that there IS no downgrade, and saying so must
    // not read as doing it.
    const src = readFileSync(new URL("./oauth-handoff-protocol.ts", import.meta.url), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
    expect(src).not.toMatch(/minVersion|supportedVersions|acceptVersions|downgrade|legacyVersion/i);
    // The version is a literal, not a range.
    expect(src).toMatch(/version: z\.literal\(HANDOFF_PROTOCOL_VERSION\)/);
  });
});

// ── 2. The new fields are bound everywhere they must be ──────────────────────────────────────────────────────────────
describe("protocol v2 — the new fields are bound into serialization, digest and AAD", () => {
  it("the canonical body carries both, in a fixed position", () => {
    const body = canonicalHandoffBody(REQUEST);
    expect(JSON.parse(body)).toHaveProperty("nonceHash", NONCE_HASH);
    expect(JSON.parse(body)).toHaveProperty("subject", SUBJECT);
    expect(Object.keys(JSON.parse(body))).toEqual([
      "version", "environment", "correlationId", "tenantId", "connectorId", "provider", "redirectUri",
      "expectedTeamId", "payloadScheme", "payloadKeyId", "protectedPayload", "nonceHash", "subject",
    ]);
  });

  it("the TRANSPORT DIGEST changes when either field changes", () => {
    const base = handoffBodyDigest(canonicalHandoffBody(REQUEST));
    for (const over of [
      { nonceHash: hashOAuthValue("a different nonce") },
      { subject: "8f3e1c22-0000-4000-8000-0000000000bb" },
    ]) {
      expect(handoffBodyDigest(canonicalHandoffBody({ ...REQUEST, ...over }))).not.toBe(base);
    }
  });

  it("the SEAL AAD changes when either field changes — so a substituted body cannot open the code", () => {
    const base = canonicalSealAad(BINDING).toString("utf8");
    for (const over of [
      { nonceHash: hashOAuthValue("a different nonce") },
      { subject: "8f3e1c22-0000-4000-8000-0000000000bb" },
    ]) {
      expect(canonicalSealAad({ ...BINDING, ...over }).toString("utf8")).not.toBe(base);
    }
  });

  it("the AAD's domain and the HKDF info both carry v2, so a v1 envelope can never be opened as a v2 one", () => {
    expect(canonicalSealAad(BINDING).toString("utf8")).toMatch(/^idcaddie:oauth-completion-handoff:v2\n/);
  });

  it("rejects malformed, missing and unknown fields", () => {
    for (const over of [
      { nonceHash: undefined },
      { subject: undefined },
      { nonceHash: "not-hex" },
      { nonceHash: NONCE_HASH.toUpperCase() },
      { nonceHash: NONCE_HASH.slice(0, 63) },
      { nonceHash: `${NONCE_HASH}0` },
      { subject: "not-a-uuid" },
      { subject: SUBJECT.toUpperCase() },
      { subject: "" },
      { nonceExtra: "x" },      // an unknown key is a refusal, not an ignored extra
      { subjectEmail: "a@b.c" },
    ]) {
      expect(handoffRequestSchema.safeParse({ ...REQUEST, ...over }).success, JSON.stringify(over)).toBe(false);
    }
    expect(handoffRequestSchema.safeParse(REQUEST).success).toBe(true);
  });

  it("the nonce hash grammar is exactly sha256 hex — what the column actually holds", () => {
    expect(NONCE_HASH_RE.test(NONCE_HASH)).toBe(true);
    expect(NONCE_HASH).toHaveLength(64);
    expect(NONCE_HASH).toBe(createHash("sha256").update(RAW_NONCE, "utf8").digest("hex"));
  });
});

// ── 3. WHAT IS NOT CARRIED ───────────────────────────────────────────────────────────────────────────────────────────
describe("protocol v2 — the raw nonce and every human identifier stay behind", () => {
  it("THE RAW NONCE APPEARS NOWHERE in the body, the digest input, or the AAD", () => {
    const body = canonicalHandoffBody(REQUEST);
    const aad = canonicalSealAad(BINDING).toString("utf8");
    for (const blob of [body, aad, JSON.stringify(REQUEST), REQUEST.protectedPayload]) {
      expect(blob).not.toContain(RAW_NONCE);
      expect(blob).not.toContain("MUSTNOTLEAK");
    }
    // Only its hash travels, and a hash is not reversible to the nonce.
    expect(body).toContain(NONCE_HASH);
  });

  it("the schema has no field that could carry an email, a name, a token or the code", () => {
    const keys = Object.keys(handoffRequestSchema.shape);
    for (const forbidden of ["email", "name", "token", "accessToken", "code", "nonce", "secret", "password", "state"]) {
      expect(keys.filter((k) => k.toLowerCase() === forbidden.toLowerCase()), forbidden).toEqual([]);
    }
    // `nonceHash` is permitted precisely because it is NOT the nonce.
    expect(keys).toContain("nonceHash");
    expect(keys).not.toContain("nonce");
  });

  it("the callback path hashes the nonce rather than forwarding it", () => {
    const src = readFileSync(new URL("./oauth-callback-handoff.ts", import.meta.url), "utf8");
    expect(src).toMatch(/hashOAuthValue\(validated\.payload\.nonce\)/);
    // The raw nonce is never assigned to a request field or a seal binding field.
    expect(src).not.toMatch(/nonce:\s*validated\.payload\.nonce/);
    expect(src).not.toMatch(/nonceHash:\s*validated\.payload\.nonce\b/);
  });

  it("nothing on the handoff path logs", () => {
    for (const f of ["oauth-handoff-protocol.ts", "oauth-payload-seal.ts", "oauth-callback-handoff.ts", "oauth-handoff-client.ts"]) {
      const src = readFileSync(new URL(`./${f}`, import.meta.url), "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
      expect(src, f).not.toMatch(/console\./);
    }
  });
});
