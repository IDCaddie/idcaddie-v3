import { describe, it, expect } from "vitest";
// The guarded operator pre-flight launcher (scripts/b2c-ingest-client-secret.mjs). It NEVER reads/holds the secret;
// it refuses unsafe conditions and emits the procedure. These tests prove the guards + that no input echoes a secret.
import {
  assertStagingRef,
  assertNoEnvSecret,
  assertNoArgvSecret,
  preflight,
} from "../../../../scripts/b2c-ingest-client-secret.mjs";

const STAGING = "ycdpzduxugdsffjqyoai";
const SENTINEL = "MUSTNOTLEAK-launcher-secret";
const grabMsg = (fn: () => void) => { try { fn(); return ""; } catch (e) { return e instanceof Error ? e.message : String(e); } };

describe("b2c-ingest launcher — refuses production / env / argv secret; never echoes a secret", () => {
  it("requires the staging ref; refuses production and anything else", () => {
    expect(() => assertStagingRef(STAGING)).not.toThrow();
    expect(() => assertStagingRef(`${STAGING}\n`)).not.toThrow(); // trims
    expect(() => assertStagingRef("dzbfxulvxchdemcettrx")).toThrow(/production/i);
    expect(() => assertStagingRef("something-else")).toThrow();
  });
  it("refuses SLACK_CLIENT_SECRET in env, and the error never echoes it", () => {
    expect(() => assertNoEnvSecret({ SLACK_CLIENT_SECRET: SENTINEL })).toThrow();
    expect(grabMsg(() => assertNoEnvSecret({ SLACK_CLIENT_SECRET: SENTINEL }))).not.toContain(SENTINEL);
    expect(() => assertNoEnvSecret({})).not.toThrow();
  });
  it("refuses a positional argv (a likely secret) and unknown flags; allows only --confirm; never echoes the arg", () => {
    expect(() => assertNoArgvSecret([SENTINEL])).toThrow();
    expect(grabMsg(() => assertNoArgvSecret([SENTINEL]))).not.toContain(SENTINEL);
    expect(() => assertNoArgvSecret(["--evil=x"])).toThrow();
    expect(() => assertNoArgvSecret(["--confirm"])).not.toThrow();
    expect(() => assertNoArgvSecret([])).not.toThrow();
  });
  it("preflight refuses without --confirm; with --confirm + staging + clean env/argv it returns the procedure (no secret)", () => {
    expect(() => preflight({ argv: [], env: {}, ref: STAGING, confirm: false })).toThrow(/--confirm/);
    const out = preflight({ argv: ["--confirm"], env: {}, ref: STAGING, confirm: true });
    expect(out).toContain("PRE-FLIGHT OK");
    expect(out).toContain("docs/45");
    expect(out).not.toContain(SENTINEL);
    // and preflight still enforces the guards:
    expect(() => preflight({ argv: [], env: { SLACK_CLIENT_SECRET: SENTINEL }, ref: STAGING, confirm: true })).toThrow();
    expect(() => preflight({ argv: [], env: {}, ref: "dzbfxulvxchdemcettrx", confirm: true })).toThrow(/production/i);
  });
});
