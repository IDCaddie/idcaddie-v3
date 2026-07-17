import { describe, it, expect, vi } from "vitest";
import { createOktaTokenExchangeAdapter, type OktaHttpTransport, type OktaTokenVaultWriter, type OktaClientAssertionProvider } from "./okta-token-exchange-adapter";
import type { VaultBoundAccessTokenRef, OktaTokenExchangeRequest } from "./okta-token-exchange";

// P5E18b Phase 6/15 — the dormant token-exchange adapter, exercised ONLY with a mocked transport (no real Okta call).

const SYNTH_TOKEN = "SYNTHETIC-access-token-value-must-not-leak-abc123";
const req = (): OktaTokenExchangeRequest => ({
  issuerUrl: "https://acme.okta.com", authorizationCode: "AbCd1234_synthetic_code", pkceVerifier: "synthetic-verifier-43chars-aaaaaaaaaaaaaaaaaa",
  redirectUri: "https://idcaddie-v3.vercel.app/connectors/oauth/okta/callback", clientCredentialReference: "ref-pointer", timeoutMs: 8000,
  signal: new AbortController().signal, correlationId: "corr-1",
});
const assertionProvider: OktaClientAssertionProvider = { assertionFor: async () => "SYNTHETIC.client.assertion" };
const vaultWriter = (): { writer: OktaTokenVaultWriter; seen: { raw: string | null } } => {
  const seen = { raw: null as string | null };
  return { seen, writer: { write: async (i) => { seen.raw = i.rawTokenMaterial; return "vault-ref-xyz" as VaultBoundAccessTokenRef; } } };
};
const transportReturning = (r: { status?: number; contentType?: string; bodyText: string }): OktaHttpTransport => ({
  post: async () => ({ status: r.status ?? 200, contentType: r.contentType ?? "application/json", bodyText: r.bodyText }),
});
const okBody = JSON.stringify({ access_token: SYNTH_TOKEN, token_type: "Bearer", expires_in: 3600, scope: "okta.users.read" });

describe("okta token-exchange adapter", () => {
  it("valid response: hands the RAW token to the vault writer, returns only a reference, never leaks the token", async () => {
    const vw = vaultWriter();
    const adapter = createOktaTokenExchangeAdapter({ transport: transportReturning({ bodyText: okBody }), vaultWriter: vw.writer, assertionProvider, clientId: "0oaEXAMPLEexampleABCDE" });
    const r = await adapter.exchange(req());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.accessTokenRef).toBe("vault-ref-xyz");
    expect(r.value.grantedScopes).toEqual(["okta.users.read"]);
    expect(r.value.tokenType).toBe("Bearer");
    // the raw token went to the vault writer, NOT into the result
    expect(vw.seen.raw).toBe(SYNTH_TOKEN);
    expect(JSON.stringify(r)).not.toContain(SYNTH_TOKEN);
  });

  it("POSTs authorization_code + PKCE verifier + private_key_jwt assertion to the https issuer token endpoint", async () => {
    const post = vi.fn<OktaHttpTransport["post"]>(async () => ({ status: 200, contentType: "application/json", bodyText: okBody }));
    const adapter = createOktaTokenExchangeAdapter({ transport: { post }, vaultWriter: vaultWriter().writer, assertionProvider, clientId: "0oaEXAMPLEexampleABCDE" });
    await adapter.exchange(req());
    expect(post).toHaveBeenCalledOnce();
    const call = post.mock.calls[0]![0];
    expect(call.url).toBe("https://acme.okta.com/oauth2/v1/token");
    expect(call.body).toContain("grant_type=authorization_code");
    expect(call.body).toContain("code_verifier=");
    expect(call.body).toContain("client_assertion_type=urn%3Aietf%3Aparams%3Aoauth%3Aclient-assertion-type%3Ajwt-bearer");
  });

  it("rejects scope escalation, missing scope, wrong content-type, oversize, and error statuses", async () => {
    const mk = (b: { status?: number; contentType?: string; bodyText: string }) =>
      createOktaTokenExchangeAdapter({ transport: transportReturning(b), vaultWriter: vaultWriter().writer, assertionProvider, clientId: "0oaEXAMPLEexampleABCDE" });
    expect(await mk({ bodyText: JSON.stringify({ access_token: "x", token_type: "Bearer", expires_in: 3600, scope: "okta.users.read okta.groups.read" }) }).exchange(req())).toEqual({ ok: false, failure: { classification: "scope_denied" } });
    expect(await mk({ bodyText: JSON.stringify({ access_token: "x", token_type: "Bearer", expires_in: 3600 }) }).exchange(req())).toEqual({ ok: false, failure: { classification: "scope_denied" } });
    expect(await mk({ contentType: "text/html", bodyText: okBody }).exchange(req())).toEqual({ ok: false, failure: { classification: "malformed_response" } });
    expect(await mk({ bodyText: "x".repeat(70000) }).exchange(req())).toEqual({ ok: false, failure: { classification: "malformed_response" } });
    expect(await mk({ status: 400, bodyText: "{}" }).exchange(req())).toEqual({ ok: false, failure: { classification: "invalid_grant" } });
    expect(await mk({ status: 401, bodyText: "{}" }).exchange(req())).toEqual({ ok: false, failure: { classification: "invalid_client" } });
  });

  it("rejects a non-https issuer (never a plaintext token endpoint)", async () => {
    const adapter = createOktaTokenExchangeAdapter({ transport: transportReturning({ bodyText: okBody }), vaultWriter: vaultWriter().writer, assertionProvider, clientId: "0oaEXAMPLEexampleABCDE" });
    const r = await adapter.exchange({ ...req(), issuerUrl: "http://acme.okta.com" });
    expect(r.ok).toBe(false);
  });
});
