import { describe, it, expect } from "vitest";
import {
  createOAuthState,
  generateBoundOAuthState,
  validateOAuthState,
  serverTrustedRedirectUri,
  createHmacStateSigner,
  OAuthStateError,
  type OAuthStateContext,
  type OAuthStateSigner,
  type ConsumedNonceStore,
  type AuthorizeActorForState,
} from "./oauth-state";

// B2a (docs/42 §90.2): OAuth state binds ALL EIGHT fields (sub, tid, prov, cid, redir, corr, exp, nonce) and the
// callback compares EACH against the completing request/session, failing closed on ANY mismatch. These tests prove
// the binding + the per-field comparison + generation-time authorization + confused-deputy prevention. Synthetic
// only — no Slack exchange, no real token, no network.

const signer = (): OAuthStateSigner => createHmacStateSigner("test-only-b2a-state-secret-NOT-real", "test");
const SERVER_REDIRECT = "https://app.example.com/connectors/oauth/callback";
const NOW = 1_750_000_000_000;
const TTL = 600;

// The canonical completing context (the eight bound fields). Each per-field test mismatches EXACTLY ONE of these.
const SUBJECT = "0a000000-0000-0000-0000-000000000001";
const TENANT = "11111111-1111-1111-1111-111111111111";
const CONNECTOR = "17000000-0000-0000-0000-0000000000a1";
const ctx = (over: Partial<OAuthStateContext> = {}): OAuthStateContext => ({
  tenantId: TENANT,
  provider: "slack",
  connectorId: CONNECTOR,
  subject: SUBJECT,
  redirectIntent: "connect",
  redirectUri: SERVER_REDIRECT,
  correlationId: "corr-b2a-01",
  ...over,
});
const memNonce = (): ConsumedNonceStore => {
  const seen = new Set<string>();
  return { has: (n) => seen.has(n), add: (n) => void seen.add(n) };
};
// Mint a state bound to `ctx()`, then validate against a (possibly mismatched) completing `expected` context.
const mintThenValidate = (expected: OAuthStateContext, opts: { now?: number; store?: ConsumedNonceStore } = {}) => {
  const s = signer();
  const { state } = createOAuthState(ctx(), { signer: s, ttlSeconds: TTL, now: NOW });
  return validateOAuthState(state, expected, { signer: s, now: opts.now ?? NOW + 1000, consumedNonces: opts.store });
};

describe("B2a generation — binds all eight fields", () => {
  it("a minted state carries sub/tid/prov/cid/redir/corr/exp/nonce", () => {
    const { state } = createOAuthState(ctx(), { signer: signer(), ttlSeconds: TTL, now: NOW });
    const res = validateOAuthState(state, ctx(), { signer: signer(), now: NOW + 1000 });
    expect(res.ok).toBe(true);
    if (res.ok) {
      const p = res.payload;
      expect(p.sub).toBe(SUBJECT); expect(p.tid).toBe(TENANT); expect(p.prov).toBe("slack");
      expect(p.cid).toBe(CONNECTOR); expect(p.redir).toBe(SERVER_REDIRECT); expect(p.corr).toBe("corr-b2a-01");
      expect(typeof p.exp).toBe("number"); expect(p.nonce.length).toBeGreaterThan(0);
    }
  });
  it("generation REQUIRES the actor subject + exact-https redirect + grammar-safe correlation (else throws, no state)", () => {
    const s = signer();
    expect(() => createOAuthState(ctx({ subject: null }), { signer: s, ttlSeconds: TTL, now: NOW })).toThrow(OAuthStateError);
    expect(() => createOAuthState(ctx({ redirectUri: "http://insecure/cb" }), { signer: s, ttlSeconds: TTL, now: NOW })).toThrow(OAuthStateError);
    expect(() => createOAuthState(ctx({ correlationId: "ABCDEF0123456789abcdef0123456789" }), { signer: s, ttlSeconds: TTL, now: NOW })).toThrow(OAuthStateError);
  });
});

describe("B2a generation-time authorization (an actor cannot mint state for a tenant/connector they cannot access)", () => {
  // The authorizer: the actor may bind only TENANT + (CONNECTOR or a fresh connect).
  const authorizer: AuthorizeActorForState = ({ subject, tenantId, connectorId }) =>
    subject === SUBJECT && tenantId === TENANT && (connectorId === null || connectorId === CONNECTOR);

  it("an authorized actor mints a usable state for the allowed tenant/connector", async () => {
    const { state } = await generateBoundOAuthState(ctx(), { signer: signer(), ttlSeconds: TTL, now: NOW, authorizeActor: authorizer });
    expect(validateOAuthState(state, ctx(), { signer: signer(), now: NOW + 1000 }).ok).toBe(true);
  });
  it("an actor CANNOT mint state for a tenant they are not a member of (throws, no usable state)", async () => {
    let minted: unknown = "NONE";
    await expect((async () => { minted = await generateBoundOAuthState(ctx({ tenantId: "22222222-2222-2222-2222-222222222222" }), { signer: signer(), ttlSeconds: TTL, now: NOW, authorizeActor: authorizer }); })())
      .rejects.toBeInstanceOf(OAuthStateError);
    expect(minted).toBe("NONE");
  });
  it("an actor CANNOT mint state for a connector they are not allowed to configure (throws, no usable state)", async () => {
    await expect(generateBoundOAuthState(ctx({ connectorId: "17000000-0000-0000-0000-0000000000ff" }), { signer: signer(), ttlSeconds: TTL, now: NOW, authorizeActor: authorizer }))
      .rejects.toBeInstanceOf(OAuthStateError);
  });
  it("the signer is never invoked when authorization fails (no state material is produced)", async () => {
    let signCalls = 0;
    const countingSigner: OAuthStateSigner = { keyId: "k", sign: (m) => { signCalls++; return signer().sign(m); } };
    await generateBoundOAuthState(ctx({ tenantId: "99999999-9999-9999-9999-999999999999" }), { signer: countingSigner, ttlSeconds: TTL, now: NOW, authorizeActor: authorizer }).catch(() => {});
    expect(signCalls).toBe(0);
  });
});

describe("B2a validation — ONE isolated mismatch per bound field (other seven match)", () => {
  // Each case mismatches EXACTLY ONE field; removing that field's comparison from validation would make the case pass.
  it("field 1 — subject mismatch → subject_mismatch", () => {
    const r = mintThenValidate(ctx({ subject: "0b000000-0000-0000-0000-0000000000ff" }));
    expect(r).toEqual({ ok: false, reason: "subject_mismatch" });
  });
  it("field 2 — tenant mismatch → tenant_mismatch", () => {
    const r = mintThenValidate(ctx({ tenantId: "22222222-2222-2222-2222-222222222222" }));
    expect(r).toEqual({ ok: false, reason: "tenant_mismatch" });
  });
  it("field 3 — provider mismatch → provider_mismatch", () => {
    const r = mintThenValidate(ctx({ provider: "github" }));
    expect(r).toEqual({ ok: false, reason: "provider_mismatch" });
  });
  it("field 4 — connector mismatch → connector_mismatch", () => {
    const r = mintThenValidate(ctx({ connectorId: "17000000-0000-0000-0000-0000000000ff" }));
    expect(r).toEqual({ ok: false, reason: "connector_mismatch" });
  });
  it("field 5 — redirect URI mismatch → redirect_uri_mismatch", () => {
    const r = mintThenValidate(ctx({ redirectUri: "https://app.example.com/OTHER/callback" }));
    expect(r).toEqual({ ok: false, reason: "redirect_uri_mismatch" });
  });
  it("field 6 — correlation id mismatch → correlation_mismatch", () => {
    const r = mintThenValidate(ctx({ correlationId: "corr-DIFFERENT-99" }));
    expect(r).toEqual({ ok: false, reason: "correlation_mismatch" });
  });
  it("field 7 — expiry: an expired state → expired", () => {
    const r = mintThenValidate(ctx(), { now: NOW + TTL * 1000 + 1 });
    expect(r).toEqual({ ok: false, reason: "expired" });
  });
  it("field 8 — single-use: a replayed nonce → replayed", () => {
    const store = memNonce();
    const s = signer();
    const { state } = createOAuthState(ctx(), { signer: s, ttlSeconds: TTL, now: NOW });
    expect(validateOAuthState(state, ctx(), { signer: s, now: NOW + 1000, consumedNonces: store }).ok).toBe(true);
    expect(validateOAuthState(state, ctx(), { signer: s, now: NOW + 2000, consumedNonces: store })).toEqual({ ok: false, reason: "replayed" });
  });
  it("all eight match → ok", () => {
    expect(mintThenValidate(ctx()).ok).toBe(true);
  });

  it("correlation is the AUDIT-correlation binding — compared only when an expected value is supplied (by design); the seven SECURITY bindings still fail closed", () => {
    // doc 42 §90.2: the correlation id is carried for audit correlation and compared "if applicable" — it is NOT a
    // confused-deputy defense. An empty expected correlation skips ONLY that compare; subject/tenant/redirect remain.
    expect(mintThenValidate(ctx({ correlationId: "" })).ok).toBe(true); // empty expected → correlation not compared
    // …but a SECURITY binding mismatch alongside an empty correlation still fails closed:
    expect(mintThenValidate(ctx({ correlationId: "", subject: "0b000000-0000-0000-0000-0000000000ff" }))).toEqual({ ok: false, reason: "subject_mismatch" });
    expect(mintThenValidate(ctx({ correlationId: "", redirectUri: "https://app.example.com/OTHER/cb" }))).toEqual({ ok: false, reason: "redirect_uri_mismatch" });
  });
});

describe("B2a — no completing session / App Router route-handler reality", () => {
  it("validation fails closed without a completing actor/session subject → session_required", () => {
    expect(mintThenValidate(ctx({ subject: null }))).toEqual({ ok: false, reason: "session_required" });
    expect(mintThenValidate(ctx({ subject: "" }))).toEqual({ ok: false, reason: "session_required" });
  });
  it("validation fails with a DIFFERENT actor/session subject → subject_mismatch (a layout cannot substitute for the per-request check)", () => {
    expect(mintThenValidate(ctx({ subject: "0b000000-0000-0000-0000-0000000000ee" }))).toEqual({ ok: false, reason: "subject_mismatch" });
  });
  it("the failure reason is a safe/static code; no raw state/session leaks in the result", () => {
    const r = mintThenValidate(ctx({ subject: null }));
    expect(JSON.stringify(r)).not.toContain(SERVER_REDIRECT);
    expect(JSON.stringify(r)).not.toContain("corr-b2a-01");
    if (!r.ok) expect(typeof r.reason).toBe("string");
  });
});

describe("B2a redirect URI — exact, server-trusted; Host/X-Forwarded-Host spoofing cannot satisfy it", () => {
  it("serverTrustedRedirectUri returns the configured value and takes NO request input (cannot be moved by a Host header)", () => {
    expect(serverTrustedRedirectUri(SERVER_REDIRECT)).toBe(SERVER_REDIRECT);
    expect(() => serverTrustedRedirectUri("http://insecure/cb")).toThrow(OAuthStateError);
  });
  it("a legit state validates against the SERVER-TRUSTED redirect regardless of a spoofed Host", () => {
    // The callback derives expected.redirectUri ONLY from server config — a spoofed Host header never reaches it.
    const spoofedHost = "evil.attacker.example"; // present in a (hypothetical) request, but IGNORED by the resolver
    void spoofedHost;
    const expected = ctx({ redirectUri: serverTrustedRedirectUri(SERVER_REDIRECT) });
    expect(mintThenValidate(expected).ok).toBe(true);
  });
  it("if the callback WRONGLY built the redirect from a spoofed Host, the mismatched redirect FAILS CLOSED (never validates)", () => {
    const hostReconstructed = "https://evil.attacker.example/connectors/oauth/callback"; // what a Host-spoof would yield
    expect(mintThenValidate(ctx({ redirectUri: hostReconstructed }))).toEqual({ ok: false, reason: "redirect_uri_mismatch" });
  });
  it("an attacker-chosen redirect baked into the state cannot complete against the server-trusted redirect", () => {
    // Mint a state whose `redir` is the attacker's URL; the callback compares against the SERVER config → reject.
    const s = signer();
    const { state } = createOAuthState(ctx({ redirectUri: "https://evil.attacker.example/cb" }), { signer: s, ttlSeconds: TTL, now: NOW });
    expect(validateOAuthState(state, ctx({ redirectUri: serverTrustedRedirectUri(SERVER_REDIRECT) }), { signer: s, now: NOW + 1000 }))
      .toEqual({ ok: false, reason: "redirect_uri_mismatch" });
  });
});

describe("B2a confused-deputy — a state minted for one identity cannot be completed by another", () => {
  it("attacker-initiated state cannot be completed by a victim session (subject differs)", () => {
    // The state was minted by the attacker (sub=attacker); the victim's session (sub=victim) completes it → reject.
    const attacker = "0a000000-0000-0000-0000-00000000aaaa";
    const victim = "0a000000-0000-0000-0000-00000000bbbb";
    const s = signer();
    const { state } = createOAuthState(ctx({ subject: attacker }), { signer: s, ttlSeconds: TTL, now: NOW });
    expect(validateOAuthState(state, ctx({ subject: victim }), { signer: s, now: NOW + 1000 }))
      .toEqual({ ok: false, reason: "subject_mismatch" });
  });
  it("tenant A state cannot complete tenant B", () => {
    const s = signer();
    const { state } = createOAuthState(ctx({ tenantId: "aaaa1111-1111-1111-1111-111111111111" }), { signer: s, ttlSeconds: TTL, now: NOW });
    expect(validateOAuthState(state, ctx({ tenantId: "bbbb2222-2222-2222-2222-222222222222" }), { signer: s, now: NOW + 1000 }))
      .toEqual({ ok: false, reason: "tenant_mismatch" });
  });
  it("connector A state cannot complete connector B; provider Slack cannot complete another provider", () => {
    const s = signer();
    const { state } = createOAuthState(ctx(), { signer: s, ttlSeconds: TTL, now: NOW });
    expect(validateOAuthState(state, ctx({ connectorId: "17000000-0000-0000-0000-0000000000bb" }), { signer: s, now: NOW + 1000 }).ok).toBe(false);
    const g = createOAuthState(ctx({ provider: "slack" }), { signer: s, ttlSeconds: TTL, now: NOW });
    expect(validateOAuthState(g.state, ctx({ provider: "okta" }), { signer: s, now: NOW + 1000 })).toEqual({ ok: false, reason: "provider_mismatch" });
  });
  it("redirect A state cannot complete redirect B; expired + replayed + no-session all fail closed", () => {
    expect(mintThenValidate(ctx({ redirectUri: "https://app.example.com/B/callback" }))).toEqual({ ok: false, reason: "redirect_uri_mismatch" });
    expect(mintThenValidate(ctx(), { now: NOW + TTL * 1000 + 1 })).toEqual({ ok: false, reason: "expired" });
    expect(mintThenValidate(ctx({ subject: null }))).toEqual({ ok: false, reason: "session_required" });
  });
});
