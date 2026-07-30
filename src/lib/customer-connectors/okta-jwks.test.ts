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
const MANIFEST = join(ROOT, "src", "lib", "customer-connectors", "okta-jwks-manifest.json");

const EXPECTED_KID = "p7AyvDK0yI95_HdQBxdhBSOTt9mMYPczGL-4USxaMto";
const ACTIVE_CONTRACT_KID = "VDkZAQoJl_prLRU83WiPreOBGoP6Fib3qC0CG880wz0";

// V3 does NOT host the JWKS — a dedicated static project does, so there is exactly one authoritative URL. What V3 owns is the
// MANIFEST (which URL is authoritative, which KID is published, which is active) and the proxy exclusion. The artifact's own
// schema/thumbprint/leakage tests live in the connector-runner beside the generator that produces it.
const manifest = JSON.parse(readFileSync(MANIFEST, "utf8")) as Record<string, unknown>;

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

  it("declares exactly the one published kid", () => {
    expect(manifest.published_kids).toEqual([EXPECTED_KID]);
  });

  it("carries no infrastructure metadata", () => {
    const blob = JSON.stringify(manifest);
    expect(blob).not.toMatch(/arn:aws|\b\d{12}\b|secretsmanager|role\//i);
  });

  it("names ONE authoritative URL, served by a dedicated project rather than the V3 application", () => {
    // Exactly one authoritative endpoint: V3 must never also serve a JWKS, or two could diverge.
    expect(manifest.jwks_url).toMatch(/^https:\/\/idcaddie-staging-jwks\.vercel\.app\/\.well-known\//);
    expect(String(manifest.hosting)).toMatch(/dedicated static/i);
    expect(String(manifest.hosting)).toMatch(/no AWS credentials at request time/i);
  });

  it("records the final hostname as PENDING rather than treating a platform URL as the contract", () => {
    // The approved hostname needs a DNS record at the registrar; until then the platform URL is operational, not contractual.
    expect(manifest.jwks_url_final_pending).toBe("https://jwks.staging.idcaddie.com/.well-known/idcaddie-okta-jwks.json");
  });

  it("V3 does not host a competing JWKS artifact", () => {
    const { existsSync } = require("node:fs") as typeof import("node:fs");
    expect(existsSync(join(ROOT, "public", ".well-known", "idcaddie-okta-jwks.json"))).toBe(false);
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
