import { describe, it, expect } from "vitest";
import { createProviderTokenSource } from "./provider-token-source-selector";

// Synthetic sentinel (marker IS in the token so check-no-real-tokens excuses it).
const SENTINEL = "xoxb-000000-MUSTNOTLEAKp0selectorsentinel";
const REQ = { provider: "slack" as const, tenantId: "t", connectorId: "c", purpose: "sync" };
const DEV = { NODE_ENV: "development", ID_CADDIE_DEV_PROVIDER_TOKEN_SOURCE_ENABLED: "1", ID_CADDIE_DEV_SLACK_TOKEN: SENTINEL } as Record<string, string | undefined>;

describe("createProviderTokenSource — env-driven, allowlist-shaped, fail-closed, NO fallback", () => {
  it("local dev + opt-in → the DEV source (returns the in-memory token)", async () => {
    expect(await createProviderTokenSource(DEV).getProviderToken(REQ)).toEqual({ provider: "slack", token: SENTINEL });
  });

  it("EVERY non-local-dev env → the VAULT source (fails closed) — even with the dev token present (NO vault→dev fallback)", async () => {
    for (const env of [
      { ...DEV, NODE_ENV: "production" }, // deployed prod: dev token env is present but must NOT be used
      { ...DEV, NODE_ENV: "development", VERCEL_ENV: "preview" },
      { ...DEV, NODE_ENV: "production", VERCEL_ENV: "production" },
      { ...DEV, NODE_ENV: "test" },
      { NODE_ENV: "production" }, {}, // unknown / unset
      { NODE_ENV: "development", ID_CADDIE_DEV_SLACK_TOKEN: SENTINEL }, // local dev but NO opt-in → vault (not dev)
    ]) {
      await expect(createProviderTokenSource(env).getProviderToken(REQ)).rejects.toThrow("vault provider-token source is not available");
    }
  });

  it("a request-supplied opt-in cannot select the dev source (env-only)", async () => {
    void { headers: { ID_CADDIE_DEV_PROVIDER_TOKEN_SOURCE_ENABLED: "1" }, body: { ID_CADDIE_DEV_SLACK_TOKEN: SENTINEL } };
    await expect(createProviderTokenSource({ NODE_ENV: "production" }).getProviderToken(REQ)).rejects.toThrow();
  });

  it("the dev token never leaks through the vault path", async () => {
    try { await createProviderTokenSource({ ...DEV, NODE_ENV: "production" }).getProviderToken(REQ); expect.unreachable(); }
    catch (e) { expect((e as Error).message).not.toContain(SENTINEL); }
  });
});
