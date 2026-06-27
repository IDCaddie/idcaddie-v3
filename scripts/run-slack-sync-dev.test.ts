import { describe, it, expect } from "vitest";
import { isLocalDevRunEnabled, assertNoSecretInArgv, assertNotProduction } from "./run-slack-sync-dev.mjs";

// The .mjs pre-flight is dev-only and never run in CI; this proves its guards. No token is involved.
describe("run-slack-sync-dev.mjs — guards", () => {
  it("isLocalDevRunEnabled: only local dev + opt-in; fails closed everywhere else", () => {
    expect(isLocalDevRunEnabled({ NODE_ENV: "development", ID_CADDIE_DEV_SLACK_SYNC_ENABLED: "1" })).toBe(true);
    for (const env of [{}, { NODE_ENV: "production", ID_CADDIE_DEV_SLACK_SYNC_ENABLED: "1" },
      { NODE_ENV: "development", VERCEL_ENV: "preview", ID_CADDIE_DEV_SLACK_SYNC_ENABLED: "1" },
      { NODE_ENV: "test", ID_CADDIE_DEV_SLACK_SYNC_ENABLED: "1" }, { NODE_ENV: "development" }])
      expect(isLocalDevRunEnabled(env)).toBe(false);
  });
  it("assertNoSecretInArgv: only --confirm allowed; any other arg (a possible token/JWT) refused", () => {
    expect(() => assertNoSecretInArgv(["--confirm"])).not.toThrow();
    expect(() => assertNoSecretInArgv([])).not.toThrow();
    for (const argv of [["xoxb-secret"], ["--token=x"], ["--jwt", "y"]]) expect(() => assertNoSecretInArgv(argv)).toThrow();
  });
  it("assertNotProduction: refuses the production ref", () => {
    expect(() => assertNotProduction("dzbfxulvxchdemcettrx")).toThrow();
    expect(() => assertNotProduction("ycdpzduxugdsffjqyoai")).not.toThrow();
  });
});
