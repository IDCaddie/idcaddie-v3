import { describe, it, expect } from "vitest";
import { createHmac } from "node:crypto";
import {
  createOAuthState,
  validateOAuthState,
  handleOAuthCallback,
  createHmacStateSigner,
  OAuthStateError,
  type OAuthStateContext,
  type OAuthStateSigner,
  type ConsumedNonceStore,
} from "./oauth-state";

// Test-only HMAC signer (the secret never comes from env — it is a fixed test string). Mirrors the
// production injected-signer shape; a DIFFERENT secret here is how "wrong signing key fails" is exercised.
function testSigner(secret = "test-only-oauth-state-secret-NOT-real", keyId = "test"): OAuthStateSigner {
  return createHmacStateSigner(secret, keyId);
}

// Test-only in-memory single-use nonce store (replay rejection). Production uses a DB-backed store — a
// remaining gate (docs/42 §16/§31).
function memoryNonceStore(): ConsumedNonceStore {
  const seen = new Set<string>();
  return { has: (n) => seen.has(n), add: (n) => void seen.add(n) };
}

const CTX: OAuthStateContext = {
  tenantId: "11111111-1111-1111-1111-111111111111",
  provider: "github",
  connectorId: "17000000-0000-0000-0000-0000000000a1",
  subject: "0a000000-0000-0000-0000-000000000001",
  redirectIntent: "connect",
};
const NOW = 1_750_000_000_000;
const TTL = 600; // 10 min

describe("createOAuthState", () => {
  it("produces an opaque two-part state and a nonce; validates round-trip", () => {
    const signer = testSigner();
    const { state, nonce } = createOAuthState(CTX, { signer, ttlSeconds: TTL, now: NOW });
    expect(state.split(".")).toHaveLength(2);
    expect(nonce.length).toBeGreaterThan(0);
    const res = validateOAuthState(state, CTX, { signer, now: NOW + 1000 });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.payload.tid).toBe(CTX.tenantId);
      expect(res.payload.prov).toBe("github");
      expect(res.payload.nonce).toBe(nonce);
    }
  });

  it("rejects invalid context / opts", () => {
    const signer = testSigner();
    expect(() => createOAuthState({ ...CTX, tenantId: "" }, { signer, ttlSeconds: TTL, now: NOW })).toThrow(OAuthStateError);
    expect(() => createOAuthState({ ...CTX, provider: "" }, { signer, ttlSeconds: TTL, now: NOW })).toThrow(OAuthStateError);
    expect(() => createOAuthState(CTX, { signer, ttlSeconds: 0, now: NOW })).toThrow(OAuthStateError);
  });
});

describe("validateOAuthState — security cases", () => {
  const signer = testSigner();

  it("a valid state validates", () => {
    const { state } = createOAuthState(CTX, { signer, ttlSeconds: TTL, now: NOW });
    expect(validateOAuthState(state, CTX, { signer, now: NOW + 5000 }).ok).toBe(true);
  });

  it("tampered state (payload bytes flipped) fails with bad_signature", () => {
    const { state } = createOAuthState(CTX, { signer, ttlSeconds: TTL, now: NOW });
    const [p, s] = state.split(".");
    const tampered = `${p.slice(0, -1)}${p.slice(-1) === "A" ? "B" : "A"}.${s}`;
    const res = validateOAuthState(tampered, CTX, { signer, now: NOW + 1000 });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(["bad_signature", "malformed_state"]).toContain(res.reason);
  });

  it("wrong tenant fails", () => {
    const { state } = createOAuthState(CTX, { signer, ttlSeconds: TTL, now: NOW });
    const res = validateOAuthState(state, { ...CTX, tenantId: "22222222-2222-2222-2222-222222222222" }, { signer, now: NOW + 1000 });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("tenant_mismatch");
  });

  it("wrong provider fails", () => {
    const { state } = createOAuthState(CTX, { signer, ttlSeconds: TTL, now: NOW });
    const res = validateOAuthState(state, { ...CTX, provider: "slack" }, { signer, now: NOW + 1000 });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("provider_mismatch");
  });

  it("wrong connector fails", () => {
    const { state } = createOAuthState(CTX, { signer, ttlSeconds: TTL, now: NOW });
    const res = validateOAuthState(state, { ...CTX, connectorId: "17000000-0000-0000-0000-0000000000ZZ" }, { signer, now: NOW + 1000 });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("connector_mismatch");
  });

  it("expired state fails (incl. the exp == now boundary — validity is strict `exp > now`)", () => {
    const { state } = createOAuthState(CTX, { signer, ttlSeconds: TTL, now: NOW });
    const res = validateOAuthState(state, CTX, { signer, now: NOW + (TTL + 1) * 1000 });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("expired");
    // exactly at expiry → still rejected (no off-by-one accept)
    const atExp = validateOAuthState(state, CTX, { signer, now: NOW + TTL * 1000 });
    expect(atExp).toEqual({ ok: false, reason: "expired" });
  });

  it("a real-key-signed payload with a wrong-typed field (exp as a string) is malformed, not accepted", () => {
    const payload = { v: 1, tid: CTX.tenantId, prov: "github", cid: null, sub: null, intent: "connect", nonce: "n", exp: String(NOW + 60_000) };
    const json = JSON.stringify(payload);
    const sig = createHmac("sha256", "test-only-oauth-state-secret-NOT-real").update(json, "utf8").digest();
    const b64url = (b: Buffer) => b.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    const forged = `${b64url(Buffer.from(json))}.${b64url(sig)}`;
    expect(validateOAuthState(forged, CTX, { signer, now: NOW })).toEqual({ ok: false, reason: "malformed_state" });
  });

  it("with no expectedContext the self-contained checks (signature/expiry/nonce) still run", () => {
    const { state } = createOAuthState(CTX, { signer, ttlSeconds: TTL, now: NOW });
    expect(validateOAuthState(state, null, { signer, now: NOW + 1000 }).ok).toBe(true); // valid, no binding asked
    expect(validateOAuthState(state, undefined, { signer, now: NOW + (TTL + 1) * 1000 })).toEqual({ ok: false, reason: "expired" });
    expect(validateOAuthState(state, null, { signer: testSigner("other-secret"), now: NOW + 1000 })).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("missing nonce fails (payload re-signed without a nonce)", () => {
    // Forge a correctly-signed payload that has an empty nonce — proves the nonce-presence check, not the
    // signature check, is what rejects it.
    const payload = { v: 1, tid: CTX.tenantId, prov: "github", cid: null, sub: null, intent: "connect", nonce: "", exp: NOW + 60_000 };
    const json = JSON.stringify(payload);
    const sig = createHmac("sha256", "test-only-oauth-state-secret-NOT-real").update(json, "utf8").digest();
    const b64url = (b: Buffer) => b.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    const state = `${b64url(Buffer.from(json))}.${b64url(sig)}`;
    const res = validateOAuthState(state, CTX, { signer, now: NOW });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("missing_nonce");
  });

  it("wrong signing key fails", () => {
    const { state } = createOAuthState(CTX, { signer, ttlSeconds: TTL, now: NOW });
    const res = validateOAuthState(state, CTX, { signer: testSigner("a-DIFFERENT-test-secret"), now: NOW + 1000 });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("bad_signature");
  });

  it("missing / malformed state fails", () => {
    expect(validateOAuthState(null, CTX, { signer, now: NOW })).toEqual({ ok: false, reason: "missing_state" });
    expect(validateOAuthState("", CTX, { signer, now: NOW })).toEqual({ ok: false, reason: "missing_state" });
    expect(validateOAuthState("no-dot-here", CTX, { signer, now: NOW })).toEqual({ ok: false, reason: "malformed_state" });
  });

  it("reused nonce is rejected when a single-use store is supplied (replay)", () => {
    const store = memoryNonceStore();
    const { state } = createOAuthState(CTX, { signer, ttlSeconds: TTL, now: NOW });
    expect(validateOAuthState(state, CTX, { signer, now: NOW + 1000, consumedNonces: store }).ok).toBe(true);
    const second = validateOAuthState(state, CTX, { signer, now: NOW + 2000, consumedNonces: store });
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.reason).toBe("replayed");
  });

  it("a rejected state does NOT burn the nonce (store only consumes on otherwise-valid state)", () => {
    const store = memoryNonceStore();
    const { state, nonce } = createOAuthState(CTX, { signer, ttlSeconds: TTL, now: NOW });
    // expired → rejected, nonce not consumed
    expect(validateOAuthState(state, CTX, { signer, now: NOW + (TTL + 1) * 1000, consumedNonces: store }).ok).toBe(false);
    expect(store.has(nonce)).toBe(false);
  });
});

describe("validateOAuthState — error messages are safe", () => {
  it("no result ever contains the signing secret, nonce, or payload internals", () => {
    const signer = testSigner();
    const { state, nonce } = createOAuthState(CTX, { signer, ttlSeconds: TTL, now: NOW });
    const bad = validateOAuthState(state, { ...CTX, tenantId: "x".repeat(36) }, { signer, now: NOW + 1000 });
    const flat = JSON.stringify(bad);
    expect(flat).not.toContain("test-only-oauth-state-secret");
    expect(flat).not.toContain(nonce);
    // a failure result is just { ok:false, reason } — a fixed safe code
    expect(bad).toEqual({ ok: false, reason: "tenant_mismatch" });
  });
});

describe("handleOAuthCallback (inert)", () => {
  const signer = testSigner();

  it("with no signer configured → not_configured (skeleton default), never exchanges", () => {
    const out = handleOAuthCallback(new URLSearchParams("code=abc&state=xyz"), { signer: null, now: NOW });
    expect(out).toEqual({ status: "not_configured", httpStatus: 503 });
  });

  it("a provider-reported error → provider_error, the error value is not surfaced", () => {
    const out = handleOAuthCallback(new URLSearchParams("error=access_denied&error_description=user+said+no"), { signer, now: NOW });
    expect(out.status).toBe("provider_error");
    expect(out.reason).toBe("provider_reported_error");
    expect(JSON.stringify(out)).not.toContain("access_denied");
  });

  it("rejects missing state", () => {
    const out = handleOAuthCallback(new URLSearchParams("code=abc"), { signer, now: NOW });
    expect(out).toEqual({ status: "invalid", reason: "missing_state", httpStatus: 400 });
  });

  it("rejects tampered state", () => {
    const { state } = createOAuthState(CTX, { signer, ttlSeconds: TTL, now: NOW });
    const tampered = `${state.slice(0, -2)}ZZ`;
    const out = handleOAuthCallback(new URLSearchParams({ code: "abc", state: tampered }), { signer, now: NOW + 1000 });
    expect(out.status).toBe("invalid");
    expect(out.httpStatus).toBe(400);
  });

  it("a valid state → received, but it does NOT exchange the code or mark connected", () => {
    const { state } = createOAuthState(CTX, { signer, ttlSeconds: TTL, now: NOW });
    const out = handleOAuthCallback(new URLSearchParams({ code: "the-secret-auth-code", state }), { signer, now: NOW + 1000 });
    expect(out).toEqual({ status: "received", httpStatus: 200 });
    // the outcome never carries the code value (it is never read/returned)
    expect(JSON.stringify(out)).not.toContain("the-secret-auth-code");
  });
});

// Static guards: the OAuth state module + route never exchange tokens, never touch connector_secrets, and
// import no Supabase/service-role/DB.
describe("oauth-state module + callback route are token-exchange-free and secret-free", () => {
  it("oauth-state.ts imports only node:crypto; no createClient/process.env/fetch/connector_secrets/token-exchange", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const src = fs.readFileSync(path.resolve(__dirname, "oauth-state.ts"), "utf8");
    const imports = [...src.matchAll(/from\s+["']([^"']+)["']/g)].map((m) => m[1]);
    expect(imports).toEqual(["node:crypto"]);
    const code = src.replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
    expect(code).not.toMatch(/createClient\s*\(/);
    expect(code).not.toMatch(/process\.env/);
    expect(code).not.toMatch(/\bfetch\s*\(/); // no provider token endpoint call
    const secretsTable = ["connector", "secrets"].join("_");
    expect(code).not.toContain(secretsTable);
    const forbidden = ["service", "role"].join("_");
    expect(code).not.toContain(forbidden);
  });

  it("the callback route does no token exchange / connector_secrets / service-role / DB write", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const route = fs.readFileSync(
      path.resolve(__dirname, "..", "..", "..", "app", "(authenticated)", "connectors", "oauth", "callback", "route.ts"),
      "utf8",
    );
    const code = route.replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
    expect(code).not.toMatch(/\bfetch\s*\(/); // never calls a provider token endpoint
    expect(code).not.toMatch(/createClient\s*\(/); // no Supabase client (no DB write/read)
    for (const bad of [["connector", "secrets"].join("_"), ["service", "role"].join("_"), "access_token", "refresh_token", "token_endpoint", "grant_type"]) {
      expect(code).not.toContain(bad);
    }
  });
});
