import { describe, it, expect } from "vitest";
import { SELECT_CREDENTIAL_REFERENCE_SQL, type ConnectorCredentialReference } from "../connector-credential-reference-store";

// The credential-reference boundary: the app DB stores only a POINTER + non-secret metadata; NO token / refresh token / client
// secret / authorization code / PKCE verifier / private key appears in a schema, DTO, or returned object. (The Model-A OAuth
// transaction-record assertions were removed with that cluster; the Okta credential is a signing key in Secrets Manager,
// referenced only by the pointer below.)

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
});
