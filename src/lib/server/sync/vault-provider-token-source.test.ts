import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { createVaultProviderTokenSource, isVaultProviderTokenSourceEnabled } from "./vault-provider-token-source";

const REQ = { provider: "slack" as const, tenantId: "t", connectorId: "c", purpose: "sync" };

describe("vault provider-token source — typed FAIL-CLOSED placeholder", () => {
  it("getProviderToken ALWAYS throws (no token loading) — independent of env/request", async () => {
    await expect(createVaultProviderTokenSource().getProviderToken(REQ)).rejects.toThrow("vault provider-token source is not available");
  });

  it("isVaultProviderTokenSourceEnabled is ALWAYS false (production credential path not provisioned — RISK-007 OPEN)", () => {
    for (const env of [
      {}, { NODE_ENV: "development", ID_CADDIE_VAULT_PROVIDER_TOKEN_SOURCE_ENABLED: "1" },
      { NODE_ENV: "production", ID_CADDIE_VAULT_PROVIDER_TOKEN_SOURCE_ENABLED: "1" }, { NODE_ENV: "production" },
    ]) expect(isVaultProviderTokenSourceEnabled(env)).toBe(false);
  });

  it("the thrown error carries no token / env value / request field", async () => {
    try {
      await createVaultProviderTokenSource().getProviderToken({ provider: "slack", tenantId: "SECRET_TENANT", connectorId: "SECRET_CONN", purpose: "p" });
      expect.unreachable();
    } catch (e) {
      const m = (e as Error).message;
      for (const bad of ["xoxb", "SECRET_TENANT", "SECRET_CONN", "ID_CADDIE_DEV_SLACK_TOKEN"]) expect(m).not.toContain(bad);
    }
  });

  it("imports/instantiates NOTHING from the vault/runner/KMS/AWS layer and reads no token env (static)", () => {
    const src = fs.readFileSync(path.resolve(__dirname, "vault-provider-token-source.ts"), "utf8");
    const importLines = src.split("\n").filter((l) => /^import\b/.test(l));
    for (const line of importLines)
      for (const bad of ["@aws-sdk", "secret-vault", "runner", "connector-secret-store", "aws-kms", "createDevProviderTokenSource"])
        expect(line, `import must not reference ${bad}`).not.toContain(bad);
    expect(src).not.toContain("ID_CADDIE_DEV_SLACK_TOKEN"); // never reads the dev (or any) token env
    expect(importLines.length).toBe(1); // only the seam import
  });
});
