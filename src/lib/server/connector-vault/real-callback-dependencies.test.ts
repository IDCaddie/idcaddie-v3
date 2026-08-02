// Phase 8F — the real callback's dependency construction, and the no-fallback rule.
//
// The rule this file exists to protect: when the environment says real mode is on, a failure to assemble the real path
// must REFUSE. It must never quietly hand the request to the synthetic handler, because a customer who completes a
// Slack consent screen and lands on a success page has connected nothing, and nothing in the product would say so.

import { describe, it, expect } from "vitest";
import { buildRealCallbackRunnerFromEnvironment } from "./real-callback-dependencies";
import {
  STAGING_VERCEL_PROJECT_ID,
  STAGING_SUPABASE_REF,
  STAGING_CALLBACK_URI,
} from "./staging-environment-identity";

const VALID: Record<string, string | undefined> = {
  IDCADDIE_ENVIRONMENT: "staging",
  IDCADDIE_VERCEL_PROJECT_ID: STAGING_VERCEL_PROJECT_ID,
  NEXT_PUBLIC_SUPABASE_URL: `https://${STAGING_SUPABASE_REF}.supabase.co`,
  OAUTH_COMPLETER_DB_URL: `postgresql://oauth_completer_login:not-a-real-token@db.${STAGING_SUPABASE_REF}.supabase.co:5432/postgres`,
  CONNECTOR_OAUTH_REDIRECT_URI: STAGING_CALLBACK_URI,
  CONNECTOR_OAUTH_REAL_EXCHANGE_ENABLED: "1",
  CONNECTOR_OAUTH_EXPECTED_SLACK_TEAM_ID: "T0ABCDEF123",
  CONNECTOR_OAUTH_EXPECTED_TENANT_ID: "aaaa1111-1111-1111-1111-111111111111",
  CONNECTOR_OAUTH_EXPECTED_CONNECTOR_ID: "1575cde3-0000-4000-8000-00000000bbbb",
  CONNECTOR_OAUTH_EXPECTED_CORRELATION_ID: "corr-live-run-1",
  SLACK_CLIENT_ID: "1234.5678",
  CONNECTOR_OAUTH_STATE_SECRET: "state-secret-not-real",
  CONNECTOR_OAUTH_STATE_KEY_ID: "k1",
  CONNECTOR_VAULT_KEK_ID: "arn:aws:kms:ca-central-1:000000000000:key/not-real",
};
const withOut = (...k: string[]) => { const e = { ...VALID }; for (const x of k) delete e[x]; return e; };

describe("real callback dependency construction", () => {
  it("refuses on ENVIRONMENT grounds before constructing anything", () => {
    // A non-staging environment must not reach state-secret or KMS checks at all — the reason proves the order.
    const r = buildRealCallbackRunnerFromEnvironment(withOut("IDCADDIE_ENVIRONMENT"));
    expect(r).toEqual({ ok: false, reason: "environment_marker_missing" });
  });

  it("refuses without a state signing key rather than signing with a placeholder", () => {
    for (const k of ["CONNECTOR_OAUTH_STATE_SECRET", "CONNECTOR_OAUTH_STATE_KEY_ID"]) {
      expect(buildRealCallbackRunnerFromEnvironment(withOut(k))).toEqual({ ok: false, reason: "state_secret_missing" });
    }
  });

  it("refuses without KMS configuration rather than taking a plaintext path", () => {
    expect(buildRealCallbackRunnerFromEnvironment(withOut("CONNECTOR_VAULT_KEK_ID")))
      .toEqual({ ok: false, reason: "kms_configuration_missing" });
  });

  // The current, truthful state: the `oauth_completer` role from docs/83 §3.1 is not provisioned, so the wiring
  // throws and the build refuses. This test is what stops that throw ever being "fixed" with a placeholder that makes
  // the route claim a working connection.
  it("refuses when the oauth_completer wiring is not provisioned — never returns a half-wired runner", () => {
    const r = buildRealCallbackRunnerFromEnvironment(VALID);
    expect(r).toEqual({ ok: false, reason: "dependency_construction_failed" });
  });

  // (10) no secret or environment value in an error.
  it("never places an environment value in a refusal", () => {
    const cases = [VALID, withOut("CONNECTOR_VAULT_KEK_ID"), withOut("CONNECTOR_OAUTH_STATE_SECRET"), withOut("IDCADDIE_ENVIRONMENT")];
    for (const env of cases) {
      const r = buildRealCallbackRunnerFromEnvironment(env);
      expect(r.ok).toBe(false);
      const s = JSON.stringify(r);
      expect(s).not.toMatch(/not-a-real-token|state-secret|postgresql:\/\/|supabase\.co|arn:aws|prj_|vercel\.app|1234\.5678/i);
      expect(Object.keys(r).sort()).toEqual(["ok", "reason"]);
      expect((r as { reason: string }).reason).toMatch(/^[a-z_]+$/);
    }
  });
});

// (9) no synthetic fallback when real mode is enabled.
describe("the route has no synthetic fallback in real mode", () => {
  const routeSource = () =>
    // Read the route as text: the property is structural, and asserting it against the source is what makes it
    // impossible to reintroduce by editing the route without noticing.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    (require("node:fs") as typeof import("node:fs"))
      .readFileSync("src/app/(authenticated)/connectors/oauth/callback/route.ts", "utf8");

  it("refuses instead of falling through when the real build fails", () => {
    const src = routeSource();
    // The real branch must return on a failed build, before any synthetic construction is reachable.
    expect(src).toMatch(/if \(!built\.ok\) return refuse\(built\.reason\);/);
  });

  it("constructs the synthetic runner only OUTSIDE the real branch", () => {
    const src = routeSource();
    const realBranch = src.slice(src.indexOf("if (identity.ok)"), src.indexOf("// ── NOT THE PINNED STAGING"));
    expect(realBranch.length).toBeGreaterThan(0);
    // Nothing in the real branch may reference the synthetic runner or its enable flag.
    expect(realBranch).not.toMatch(/syntheticRunner\(\)/);
    expect(realBranch).not.toMatch(/isSyntheticCallbackEnabled/);
  });

  it("never labels a refusal as a success", () => {
    const src = routeSource();
    expect(src).toMatch(/oauth=error/);
    // `refuse` must not be able to emit a success outcome.
    const refuseFn = src.slice(src.indexOf("function refuse("), src.indexOf("async function handle"));
    expect(refuseFn).not.toMatch(/oauth=success/);
  });
});
