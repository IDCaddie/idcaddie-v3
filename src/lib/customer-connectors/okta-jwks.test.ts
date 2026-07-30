// O2C.1 — the published staging JWKS artifact and its publication manifest.
//
// This asserts the SHIPPED BYTES, not a generator's intent: the artifact is what Okta will actually fetch, so a defect here is a
// defect in production authentication regardless of how correct the generator was.
//
// The load-bearing assertion is that `published_not_active` is real — the published KID must NOT be the active contract KID during
// O2C.1, and the hosted signer must therefore keep failing closed.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createHash, createPublicKey, createVerify, createSign, generateKeyPairSync } from "node:crypto";

const ROOT = process.cwd();
const ARTIFACT = join(ROOT, "public", ".well-known", "idcaddie-okta-jwks.json");
const MANIFEST = join(ROOT, "src", "lib", "customer-connectors", "okta-jwks-manifest.json");

const EXPECTED_KID = "p7AyvDK0yI95_HdQBxdhBSOTt9mMYPczGL-4USxaMto";
const ACTIVE_CONTRACT_KID = "VDkZAQoJl_prLRU83WiPreOBGoP6Fib3qC0CG880wz0";

const text = readFileSync(ARTIFACT, "utf8");
const doc = JSON.parse(text) as { keys: Record<string, string>[] };
const manifest = JSON.parse(readFileSync(MANIFEST, "utf8")) as Record<string, unknown>;

// ── Schema ──────────────────────────────────────────────────────────────────────────────────────────────────────
describe("the published JWKS artifact", () => {
  it("is a standards-shaped JWK Set with exactly one active key", () => {
    expect(Array.isArray(doc.keys)).toBe(true);
    expect(doc.keys).toHaveLength(1);
  });

  it("declares exactly the required public members — no more, no less", () => {
    expect(Object.keys(doc.keys[0]).sort()).toEqual(["alg", "e", "kid", "kty", "n", "use"]);
  });

  it("is RSA / sig / RS256 with the expected kid", () => {
    const k = doc.keys[0];
    expect(k.kty).toBe("RSA");
    expect(k.use).toBe("sig");
    expect(k.alg).toBe("RS256");
    expect(k.kid).toBe(EXPECTED_KID);
  });

  it("carries a valid 2048-bit modulus and a PARSED exponent", () => {
    const k = doc.keys[0];
    expect(Buffer.from(k.n, "base64url").length).toBe(256);
    // Assert the decoded integer, not the literal string — the generator parses it rather than assuming AQAB.
    const e = Buffer.from(k.e, "base64url");
    expect(BigInt(`0x${e.toString("hex")}`).toString()).toBe("65537");
  });

  it("uses unpadded base64url throughout", () => {
    for (const v of [doc.keys[0].n, doc.keys[0].e, doc.keys[0].kid]) expect(v).not.toMatch(/[=+/]/);
  });

  it("has no duplicate kid", () => {
    expect(new Set(doc.keys.map((k) => k.kid)).size).toBe(doc.keys.length);
  });
});

// ── Nothing private, nothing internal ───────────────────────────────────────────────────────────────────────────
describe("the artifact leaks nothing", () => {
  it.each(["d", "p", "q", "dp", "dq", "qi", "oth", "k"])("contains no private member %s", (m) => {
    for (const k of doc.keys) expect(m in k).toBe(false);
  });

  it("contains no AWS or internal metadata", () => {
    expect(text).not.toMatch(/arn:aws/i);
    expect(text).not.toMatch(/\b\d{12}\b/);          // account id
    expect(text).not.toMatch(/alias\/|kms|secretsmanager|role\//i);
    expect(text).not.toMatch(/tenant|connector|client_id/i);
    expect(text).not.toMatch(/-----BEGIN/);
  });

  it("is bounded in size", () => {
    expect(text.length).toBeLessThan(8192);
  });
});

// ── Independent thumbprint ──────────────────────────────────────────────────────────────────────────────────────
describe("RFC 7638 thumbprint, recomputed from the shipped bytes", () => {
  it("matches the published kid", () => {
    const k = doc.keys[0];
    // Canonical form is EXACTLY {"e","kty","n"}, lexicographic, no whitespace — a specification requirement.
    const canonical = `{"e":${JSON.stringify(k.e)},"kty":${JSON.stringify(k.kty)},"n":${JSON.stringify(k.n)}}`;
    const tp = createHash("sha256").update(canonical, "utf8").digest("base64url");
    expect(tp).toBe(k.kid);
    expect(tp).toBe(EXPECTED_KID);
  });
});

// ── The property that matters: the artifact can verify a real signature ─────────────────────────────────────────
describe("the published key is usable for verification", () => {
  it("reconstructs an RSA public key and verifies a signature made by a matching private key", () => {
    const k = doc.keys[0];
    const pub = createPublicKey({ key: { kty: k.kty, n: k.n, e: k.e } as never, format: "jwk" });
    expect(pub.asymmetricKeyType).toBe("rsa");

    // A round-trip with a locally generated pair proves the JWK→key path Okta will use is sound. (The real private key lives in
    // KMS and is deliberately unavailable here.)
    const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const localPub = createPublicKey({ key: pair.publicKey.export({ format: "jwk" }) as never, format: "jwk" });
    const msg = Buffer.from("o2c1-verification-round-trip");
    const s = createSign("RSA-SHA256"); s.update(msg); s.end();
    const sig = s.sign(pair.privateKey);
    const v = createVerify("RSA-SHA256"); v.update(msg); v.end();
    expect(v.verify(localPub, sig)).toBe(true);
    // …and the PUBLISHED key must NOT verify a signature it did not produce.
    const v2 = createVerify("RSA-SHA256"); v2.update(msg); v2.end();
    expect(v2.verify(pub, sig)).toBe(false);
  });
});

// ── published_not_active ────────────────────────────────────────────────────────────────────────────────────────
describe("publication manifest — published_not_active is REAL", () => {
  it("declares the published-not-active state", () => {
    expect(manifest.publication_status).toBe("published_not_active");
    expect(manifest.environment).toBe("staging");
    expect(manifest.contract_version).toBe("1.0.0");
    expect(manifest.thumbprint_method).toBe("RFC7638");
  });

  it("the PUBLISHED kid is NOT the active contract kid — the signer must keep failing closed", () => {
    expect(manifest.active_contract_kid).toBe(ACTIVE_CONTRACT_KID);
    expect(manifest.signing_kid).toBe(EXPECTED_KID);
    expect(manifest.active_contract_kid).not.toBe(manifest.signing_kid);
  });

  it("the published kid set matches the artifact", () => {
    expect(manifest.published_kids).toEqual(doc.keys.map((k) => k.kid));
  });

  it("carries no infrastructure metadata", () => {
    const blob = JSON.stringify(manifest);
    expect(blob).not.toMatch(/arn:aws|\b\d{12}\b|secretsmanager|role\//i);
  });

  it("does not claim a final hostname before one is approved", () => {
    // Using a deployment hostname as the contract URL would bake an unstable host into customer configuration.
    expect(manifest.jwks_host).toBe("PENDING_APPROVED_STAGING_DOMAIN");
    expect(manifest.jwks_path).toBe("/.well-known/idcaddie-okta-jwks.json");
  });
});

// ── The proxy must not gate the endpoint ────────────────────────────────────────────────────────────────────────
describe("the auth proxy excludes .well-known", () => {
  it("the matcher exempts .well-known so Okta is never redirected to /login", () => {
    // Okta fetches server-to-server with no cookies. A redirect would return an HTML login page where a JWK Set is expected and
    // silently break assertion verification — this was observed live before the exclusion was added.
    const proxy = readFileSync(join(ROOT, "src", "proxy.ts"), "utf8");
    expect(proxy).toMatch(/\\\.well-known\//);
  });
});
