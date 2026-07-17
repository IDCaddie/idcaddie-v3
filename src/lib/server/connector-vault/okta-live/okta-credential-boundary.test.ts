import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { SELECT_CREDENTIAL_REFERENCE_SQL, type ConnectorCredentialReference } from "../connector-credential-reference-store";
import { toOktaTransactionRecord, type OktaOAuthTransaction } from "./okta-oauth-transaction";

// P5E18a Phase 9/19 — the credential-reference boundary: the app DB stores only a POINTER + non-secret metadata; NO token /
// refresh token / client secret / authorization code / PKCE verifier appears in a schema, DTO, returned object, or record.

const FORBIDDEN_SECRET_FIELDS = ["access_token", "accesstoken", "refresh_token", "refreshtoken", "client_secret", "clientsecret", "authorization_code", "authorizationcode", "pkce_verifier", "pkceverifier", "code_verifier", "private_key", "id_token"];

describe("okta credential-reference boundary", () => {
  it("the credential-reference DTO is a POINTER — exactly 5 non-secret fields, no token/secret value", () => {
    const sample: ConnectorCredentialReference = {
      connectorId: "c", tenantId: "t", provider: "okta", credentialSecretRef: "ref-pointer", credentialVersion: "v1",
    };
    expect(Object.keys(sample).sort()).toEqual(["connectorId", "credentialSecretRef", "credentialVersion", "provider", "tenantId"]);
    const keys = Object.keys(sample).map((k) => k.toLowerCase());
    for (const f of FORBIDDEN_SECRET_FIELDS) expect(keys.includes(f)).toBe(false);
  });

  it("the credential-reference SELECT reads no token/secret column", () => {
    const sql = SELECT_CREDENTIAL_REFERENCE_SQL.toLowerCase();
    for (const f of FORBIDDEN_SECRET_FIELDS) expect(sql.includes(f)).toBe(false);
    // it selects only the pointer + version + identity columns
    expect(sql).toContain("credential_secret_ref");
    expect(sql).toContain("credential_version");
  });

  it("the OAuth transaction persistable RECORD has no verifier/token/code/secret field", () => {
    const txn: OktaOAuthTransaction = {
      provider: "okta", correlationId: "c", tenantId: "t", organizationId: "o", connectorId: null, subject: "s",
      requestedScopes: ["okta.users.read"], issuerUrl: "https://acme.okta.com", orgHostname: "acme.okta.com",
      redirectUri: "https://idcaddie-v3.vercel.app/connectors/oauth/okta/callback", returnRoute: "/connectors/okta/status",
      pkceChallenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM", pkceMethod: "S256", state: "signed.state",
      createdAt: 1, expiresAt: 2, singleUse: true, consumedAt: null, failureReason: null,
    };
    const rec = toOktaTransactionRecord(txn, "raw-nonce-value");
    const keys = Object.keys(rec).map((k) => k.toLowerCase());
    for (const f of FORBIDDEN_SECRET_FIELDS) expect(keys.includes(f)).toBe(false);
    expect(keys.includes("pkceverifier")).toBe(false); // only the challenge (non-secret) is persisted
    expect(rec.pkceChallenge).toBeTruthy();
  });

  it("no okta-live RECORD/DTO type declares a forbidden secret PERSISTENCE field", () => {
    // Scan the module sources for a forbidden field DECLARED on a persisted record shape. Inputs to the (dormant) exchange/
    // transaction legitimately reference authorizationCode/pkceVerifier as CONSUMED inputs — those are NOT persisted; we assert
    // the persistable *Record types carry none. Here we assert the *store/record* modules never declare a secret column name.
    const dir = __dirname;
    const recordModules = ["okta-oauth-transaction.ts"];
    for (const f of recordModules) {
      const src = fs.readFileSync(path.join(dir, f), "utf8");
      // the Record type block must not contain a persisted verifier/token/secret field name
      const recBlock = src.slice(src.indexOf("OktaOAuthTransactionRecord"));
      expect(/verifier\s*:/i.test(recBlock.slice(0, 800))).toBe(false);
      expect(/access_token|refresh_token|client_secret/i.test(recBlock.slice(0, 800))).toBe(false);
    }
  });
});
