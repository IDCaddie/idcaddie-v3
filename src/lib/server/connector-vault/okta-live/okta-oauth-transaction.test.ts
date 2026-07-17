import { describe, it, expect } from "vitest";
import { createHmacStateSigner } from "../oauth-state";
import {
  createPkce, isSafeReturnRoute, buildOktaOAuthTransaction, toOktaTransactionRecord,
} from "./okta-oauth-transaction";

// P5E18a Phase 4/19 — OAuth transaction model + PKCE + safe return-route allowlist + single-use.

const signer = createHmacStateSigner(Buffer.from("synthetic-test-state-secret-not-real"), "test-key");
const NOW = 1_700_000_000_000;
const baseInput = {
  tenantId: "11111111-1111-1111-1111-111111111111",
  organizationId: "22222222-2222-2222-2222-222222222222",
  subject: "33333333-3333-3333-3333-333333333333",
  requestedScopes: ["okta.users.read"],
  issuerUrl: "https://acme.okta.com",
  orgHostname: "acme.okta.com",
  redirectUri: "https://idcaddie-v3.vercel.app/connectors/oauth/callback",
  returnRoute: "/connectors/okta/status",
  correlationId: "corr-okta-001",
};

describe("PKCE (S256)", () => {
  it("produces a 43-char base64url verifier and a matching S256 challenge", () => {
    const p = createPkce(Buffer.alloc(32, 7)); // deterministic
    expect(p.method).toBe("S256");
    expect(p.verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(p.challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
    // deterministic given fixed bytes
    expect(createPkce(Buffer.alloc(32, 7)).challenge).toBe(p.challenge);
    // different verifier → different challenge
    expect(createPkce(Buffer.alloc(32, 8)).challenge).not.toBe(p.challenge);
  });
});

describe("isSafeReturnRoute (open-redirect defense)", () => {
  it("accepts same-site connector paths, rejects everything else", () => {
    for (const ok of ["/connectors", "/connectors/okta", "/connectors/okta/status", "/connectors/okta/"]) expect(isSafeReturnRoute(ok)).toBe(true);
    for (const bad of ["https://evil.com", "//evil.com", "/connectors/../admin", "/admin", "javascript:alert(1)", "/connectors\\evil", "", "http://x", "/connectors/okta?x=1", "/connectors/x y"]) {
      expect(isSafeReturnRoute(bad)).toBe(false);
    }
  });
});

describe("buildOktaOAuthTransaction", () => {
  const deps = { signer, authorizeActor: async () => true, now: NOW, ttlSeconds: 300, pkceVerifierBytes: Buffer.alloc(32, 3), nonce: "nonce-fixed" };

  it("builds a fully-bound single-use transaction; verifier is returned SEPARATELY and is NOT on the record", async () => {
    const r = await buildOktaOAuthTransaction(baseInput, deps);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.transaction.provider).toBe("okta");
    expect(r.transaction.pkceMethod).toBe("S256");
    expect(r.transaction.pkceChallenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(r.transaction.expiresAt).toBe(NOW + 300_000);
    expect(r.transaction.singleUse).toBe(true);
    expect(r.transaction.consumedAt).toBeNull();
    // the verifier is a secret held separately — it must NOT appear anywhere on the transaction
    expect(r.pkceVerifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(JSON.stringify(r.transaction)).not.toContain(r.pkceVerifier);
    // the persistable record has NO verifier and only a hash of the nonce
    const rec = toOktaTransactionRecord(r.transaction, r.stateNonce);
    expect(JSON.stringify(rec)).not.toContain(r.pkceVerifier);
    expect(JSON.stringify(rec)).not.toContain(r.stateNonce);
    expect(rec.stateNonceHash).toMatch(/^[a-f0-9]{64}$/);
    expect("pkceVerifier" in (rec as object)).toBe(false);
  });

  it("fails closed when the actor authorization gate denies", async () => {
    const r = await buildOktaOAuthTransaction(baseInput, { ...deps, authorizeActor: async () => false });
    expect(r).toEqual({ ok: false, reason: "actor_not_authorized" });
  });

  it("rejects a non-exact scope set, an unsafe return route, and a non-https issuer", async () => {
    expect((await buildOktaOAuthTransaction({ ...baseInput, requestedScopes: ["okta.users.read", "okta.groups.read"] }, deps)).ok).toBe(false);
    expect((await buildOktaOAuthTransaction({ ...baseInput, returnRoute: "https://evil.com" }, deps)).ok).toBe(false);
    expect((await buildOktaOAuthTransaction({ ...baseInput, issuerUrl: "http://acme.okta.com" }, deps)).ok).toBe(false);
    const scopeR = await buildOktaOAuthTransaction({ ...baseInput, requestedScopes: [] }, deps);
    expect(scopeR.ok === false && scopeR.reason).toBe("scope_not_exact");
  });
});
