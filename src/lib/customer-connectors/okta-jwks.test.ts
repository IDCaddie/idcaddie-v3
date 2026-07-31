// O2C.1 — the published staging JWKS artifact and its publication manifest.
//
// This asserts the SHIPPED BYTES, not a generator's intent: the artifact is what Okta will actually fetch, so a defect here is a
// defect in production authentication regardless of how correct the generator was.
//
// The load-bearing assertion is that `published_not_active` is real — the published KID must NOT be the active contract KID during
// O2C.1, and the hosted signer must therefore keep failing closed.

import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const MANIFEST = join(ROOT, "src", "lib", "customer-connectors", "okta-jwks-manifest.json");

const EXPECTED_KID = "p7AyvDK0yI95_HdQBxdhBSOTt9mMYPczGL-4USxaMto";
// O2C.2 cut the contract over to the published key, so these are now the SAME value. The retired one must not reappear.
const ACTIVE_CONTRACT_KID = EXPECTED_KID;
const RETIRED_KID = "VDkZAQoJl_prLRU83WiPreOBGoP6Fib3qC0CG880wz0";

// V3 does NOT host the JWKS — a dedicated static project does, so there is exactly one authoritative URL. What V3 owns is the
// MANIFEST (which URL is authoritative, which KID is published, which is active) and the proxy exclusion. The artifact's own
// schema/thumbprint/leakage tests live in the connector-runner beside the generator that produces it.
const manifest = JSON.parse(readFileSync(MANIFEST, "utf8")) as Record<string, unknown>;

// ── published_not_active ────────────────────────────────────────────────────────────────────────────────────────
describe("publication manifest — the O2C.2 live verification is REAL", () => {
  it("declares the live-verified state and the scope it is limited to", () => {
    expect(manifest.publication_status).toBe("live_verified");
    // The scope note is load-bearing: one users read proves the users grant and the admin role, and nothing about groups or apps.
    // Each read scope is claimed ONLY because it has its own live call behind it, and the two unproven surfaces are named
    // explicitly. "Okta is verified" must never be able to stand in for "memberships and assignments work too".
    const m = manifest.capability_matrix as Record<string, string>;
    expect(m.authentication).toBe("verified");
    expect(m.users_read).toBe("verified");
    expect(m.groups_read).toBe("verified");
    expect(m.apps_read).toBe("verified");
    expect(m.memberships).toBe("not_verified");
    expect(m.assignments).toBe("not_verified");
    expect(m.scheduled_sync).toBe("disabled");
    expect(m.production).toBe("disabled");
    expect(manifest.environment).toBe("staging");
    expect(manifest.contract_version).toBe("1.2.0");
    expect(manifest.thumbprint_method).toBe("RFC7638");
  });

  it("the PUBLISHED kid IS now the active contract kid — the signer no longer fails closed", () => {
    // The inverse of the O2C.1 assertion, and deliberately so: while these differed the signer refused to sign, which was the
    // whole meaning of published_not_active. They match only because the cutover really happened in both repositories.
    expect(manifest.active_contract_kid).toBe(ACTIVE_CONTRACT_KID);
    expect(manifest.signing_kid).toBe(EXPECTED_KID);
    expect(manifest.active_contract_kid).toBe(manifest.signing_kid);
    expect(manifest.active_contract_kid).not.toBe(RETIRED_KID);
  });

  it("declares exactly the one published kid", () => {
    expect(manifest.published_kids).toEqual([EXPECTED_KID]);
  });

  it("carries no infrastructure metadata", () => {
    const blob = JSON.stringify(manifest);
    expect(blob).not.toMatch(/arn:aws|\b\d{12}\b|secretsmanager|role\//i);
  });

  it("names ONE authoritative URL on the custom hostname, not a platform URL", () => {
    // Exactly one authoritative endpoint: V3 must never also serve a JWKS, or two could diverge. And the contract URL must be the
    // custom hostname — a *.vercel.app URL is operational only and must never become customer configuration.
    expect(manifest.jwks_url).toBe("https://jwks.staging.idcaddie.com/.well-known/idcaddie-okta-jwks.json");
    expect(manifest.jwks_url).not.toMatch(/vercel\.app/);
    expect(String(manifest.hosting)).toMatch(/dedicated static/i);
    expect(String(manifest.hosting)).toMatch(/no AWS credentials at request time/i);
  });

  it("records that the endpoint was publicly verified on a matching TLS certificate", () => {
    expect(manifest.verified_publicly).toBe(true);
    expect(String(manifest.tls)).toMatch(/jwks\.staging\.idcaddie\.com/);
  });

  it("V3 does not host a competing JWKS artifact", () => {
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
