// Phase 8K — the real callback's dependency construction, and the no-fallback rule.
//
// The rule this file exists to protect: when the environment says real mode is on, a failure to assemble the real path
// must REFUSE. It must never quietly hand the request to the synthetic handler, because a customer who completes a
// Slack consent screen and lands on a success page has connected nothing, and nothing in the product would say so.
//
// What changed in 8K is WHAT gets assembled. There is no database connection and no KMS client here any more — the
// dependencies are a state signer, a worker endpoint, a public key and an OIDC assertion reader.

import { describe, it, expect } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { buildRealCallbackRunnerFromEnvironment } from "./real-callback-dependencies";
import { WORKER_ALLOWED_HOSTS } from "./oauth-handoff-client";
import { HANDOFF_PATH } from "./oauth-handoff-protocol";
import {
  STAGING_VERCEL_PROJECT_ID,
  STAGING_SUPABASE_REF,
  STAGING_CALLBACK_URI,
} from "./staging-environment-identity";

// A real X25519 public key in the configured format (base64 SPKI), generated at test time. Nothing key-shaped is
// committed to the repository.
const workerPublicKey = (generateKeyPairSync("x25519").publicKey.export({ format: "der", type: "spki" }) as Buffer).toString("base64");

const WORKER_HOST = "oauth-completion-worker.internal.example";
const VALID: Record<string, string | undefined> = {
  IDCADDIE_ENVIRONMENT: "staging",
  IDCADDIE_VERCEL_PROJECT_ID: STAGING_VERCEL_PROJECT_ID,
  NEXT_PUBLIC_SUPABASE_URL: `https://${STAGING_SUPABASE_REF}.supabase.co`,
  CONNECTOR_OAUTH_REDIRECT_URI: STAGING_CALLBACK_URI,
  CONNECTOR_OAUTH_REAL_EXCHANGE_ENABLED: "1",
  CONNECTOR_OAUTH_EXPECTED_SLACK_TEAM_ID: "T0ABCDEF123",
  CONNECTOR_OAUTH_EXPECTED_TENANT_ID: "aaaa1111-1111-1111-1111-111111111111",
  CONNECTOR_OAUTH_EXPECTED_CONNECTOR_ID: "1575cde3-0000-4000-8000-00000000bbbb",
  CONNECTOR_OAUTH_EXPECTED_CORRELATION_ID: "corr-live-run-1",
  SLACK_CLIENT_ID: "1234.5678",
  CONNECTOR_OAUTH_STATE_SECRET: "state-secret-not-real",
  CONNECTOR_OAUTH_STATE_KEY_ID: "k1",
  OAUTH_COMPLETION_WORKER_URL: `https://${WORKER_HOST}${HANDOFF_PATH}`,
  OAUTH_COMPLETION_WORKER_OIDC_AUDIENCE: "https://idcaddie.example/oauth-completion-worker",
  OAUTH_COMPLETION_WORKER_PUBLIC_KEY: workerPublicKey,
  OAUTH_COMPLETION_WORKER_PUBLIC_KEY_ID: "worker-seal-v1",
};
const withOut = (...k: string[]) => { const e = { ...VALID }; for (const x of k) delete e[x]; return e; };
const withVal = (o: Record<string, string | undefined>) => ({ ...VALID, ...o });

describe("real callback dependency construction", () => {
  it("refuses on ENVIRONMENT grounds before constructing anything", () => {
    // A non-staging environment must not reach the state-secret or worker checks at all — the reason proves the order.
    expect(buildRealCallbackRunnerFromEnvironment(withOut("IDCADDIE_ENVIRONMENT")))
      .toEqual({ ok: false, reason: "environment_marker_missing" });
  });

  it("refuses without a state signing key rather than signing with a placeholder", () => {
    for (const k of ["CONNECTOR_OAUTH_STATE_SECRET", "CONNECTOR_OAUTH_STATE_KEY_ID"]) {
      expect(buildRealCallbackRunnerFromEnvironment(withOut(k))).toEqual({ ok: false, reason: "state_secret_missing" });
    }
  });

  it("refuses a completer database credential — the web tier holds none", () => {
    expect(buildRealCallbackRunnerFromEnvironment(withVal({
      OAUTH_COMPLETER_DB_URL: `postgresql://oauth_completer_login:not-a-real-token@db.${STAGING_SUPABASE_REF}.supabase.co:5432/postgres`,
    }))).toEqual({ ok: false, reason: "completer_credential_present" });
  });

  it("refuses a missing worker endpoint", () => {
    expect(buildRealCallbackRunnerFromEnvironment(withOut("OAUTH_COMPLETION_WORKER_URL")))
      .toEqual({ ok: false, reason: "worker_url_missing" });
  });

  it("validates the DESTINATION before the rest of the worker configuration", () => {
    // Ordering, asserted rather than assumed: a bearer assertion and a sealed authorization code are about to be posted
    // somewhere, so "where" is settled first. Each of these is missing a different later field and still refuses on the
    // host. Their individual refusals are proven in oauth-handoff-client.test.ts, with an allowlist injected.
    for (const k of ["OAUTH_COMPLETION_WORKER_OIDC_AUDIENCE", "OAUTH_COMPLETION_WORKER_PUBLIC_KEY", "OAUTH_COMPLETION_WORKER_PUBLIC_KEY_ID"]) {
      expect(buildRealCallbackRunnerFromEnvironment(withOut(k)), k).toEqual({ ok: false, reason: "worker_host_not_allowlisted" });
    }
  });

  // The current, truthful state. `WORKER_ALLOWED_HOSTS` is empty because the completion worker is not deployed and its
  // host is not known, so a fully-configured staging environment STILL refuses. This test is what stops that being
  // "fixed" from the environment: opening it requires a reviewed change to the constant.
  it("refuses because no worker host is allowlisted yet — and the allowlist is empty in code", () => {
    expect(WORKER_ALLOWED_HOSTS).toEqual([]);
    expect(buildRealCallbackRunnerFromEnvironment(VALID)).toEqual({ ok: false, reason: "worker_host_not_allowlisted" });
  });

  it("assembles a runner once a host IS allowlisted — the wiring itself is sound", () => {
    const built = buildRealCallbackRunnerFromEnvironment(VALID, fetch, [WORKER_HOST]);
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(typeof built.run).toBe("function");
  });

  // (10) no secret or environment value in an error.
  it("never places an environment value in a refusal", () => {
    const cases = [VALID, withOut("CONNECTOR_OAUTH_STATE_SECRET"), withOut("IDCADDIE_ENVIRONMENT"), withOut("OAUTH_COMPLETION_WORKER_URL")];
    for (const env of cases) {
      const r = buildRealCallbackRunnerFromEnvironment(env);
      expect(r.ok).toBe(false);
      const s = JSON.stringify(r);
      expect(s).not.toMatch(/not-a-real-token|state-secret|postgresql:\/\/|supabase\.co|arn:aws|prj_|vercel\.app|1234\.5678|example/i);
      expect(s).not.toContain(workerPublicKey);
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
    expect(routeSource()).toMatch(/if \(!built\.ok\) return handoffErrorRedirect\(built\.reason\);/);
  });

  it("constructs the synthetic runner only OUTSIDE the real branch", () => {
    const src = routeSource();
    const realBranch = src.slice(src.indexOf("if (identity.ok)"), src.indexOf("// ── NOT THE PINNED STAGING"));
    expect(realBranch.length).toBeGreaterThan(0);
    expect(realBranch).not.toMatch(/syntheticRunner\(\)/);
    expect(realBranch).not.toMatch(/isSyntheticCallbackEnabled/);
    // …and the real branch must not run the SYNTHETIC handler either, whatever runner it is handed.
    expect(realBranch).not.toMatch(/handleSyntheticSlackOAuthCallback/);
  });

  it("never labels the handoff a success", () => {
    const src = routeSource();
    // The real branch's only success destination is the pending page, which reads the job's real status.
    expect(src).not.toMatch(/oauth=success/);
  });
});
