// Phase 8F — the environment-identity gate for real Slack OAuth.
//
// The property under test is that this gate is CONJUNCTIVE and fails CLOSED: removing or corrupting any single fact
// must refuse, and a refusal must never carry the value that caused it. Each `it` below removes exactly one thing from
// an otherwise-valid environment, so a pass can only mean that fact is load-bearing.

import { describe, it, expect } from "vitest";
import {
  resolveStagingEnvironmentIdentity,
  isRealSlackOAuthEnabled,
  STAGING_VERCEL_PROJECT_ID,
  STAGING_SUPABASE_REF,
  PRODUCTION_SUPABASE_REF,
  STAGING_CALLBACK_URI,
} from "./staging-environment-identity";

const TEAM = "T0ABCDEF123";
const OTHER_REF = "someotherproject";
const TENANT = "aaaa1111-1111-1111-1111-111111111111";
const CONNECTOR = "1575cde3-0000-4000-8000-00000000bbbb";
const CORR = "corr-live-run-1";
// Shaped like the real thing so the assertions about what must NOT leak are meaningful.
// Credentials carry the `not-a-real-token` sentinel so check-no-real-tokens can tell a fixture from a leak, and the
// Supabase host is composed from the exported constant so no literal Supabase URL is committed under src/.
const COMPLETER_URL = `postgresql://oauth_completer_login:not-a-real-token@db.${STAGING_SUPABASE_REF}.supabase.co:5432/postgres`;

// The exact idcaddie-v3 staging configuration. It holds NO database credential of any kind: after the doc 83 §2
// correction, completion belongs to a worker and the presence of a completer connection string here is a refusal.
const VALID: Record<string, string | undefined> = {
  IDCADDIE_ENVIRONMENT: "staging",
  IDCADDIE_VERCEL_PROJECT_ID: STAGING_VERCEL_PROJECT_ID,
  NEXT_PUBLIC_SUPABASE_URL: `https://${STAGING_SUPABASE_REF}.supabase.co`,
  CONNECTOR_OAUTH_REDIRECT_URI: STAGING_CALLBACK_URI,
  CONNECTOR_OAUTH_REAL_EXCHANGE_ENABLED: "1",
  CONNECTOR_OAUTH_EXPECTED_SLACK_TEAM_ID: TEAM,
  CONNECTOR_OAUTH_EXPECTED_TENANT_ID: TENANT,
  CONNECTOR_OAUTH_EXPECTED_CONNECTOR_ID: CONNECTOR,
  CONNECTOR_OAUTH_EXPECTED_CORRELATION_ID: CORR,
  SLACK_CLIENT_ID: "1234.5678",
};
const withOut = (...keys: string[]) => { const e = { ...VALID }; for (const k of keys) delete e[k]; return e; };
const withVal = (o: Record<string, string | undefined>) => ({ ...VALID, ...o });

describe("environment identity — the exact idcaddie-v3 staging configuration", () => {
  // (8) accepted
  it("accepts the exact staging configuration", () => {
    const r = resolveStagingEnvironmentIdentity(VALID);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r).toMatchObject({ tenantId: TENANT, connectorId: CONNECTOR, correlationId: CORR, expectedTeamId: TEAM, callbackUri: STAGING_CALLBACK_URI });
    expect(isRealSlackOAuthEnabled(VALID)).toBe(true);
  });

  // The old gate was `VERCEL_ENV !== "production"`. Our staging IS served on Vercel's Production channel, so the new
  // gate must be indifferent to that label — and must still refuse when the identity facts are absent.
  it("is indifferent to the Vercel channel label, which is not an environment", () => {
    for (const label of ["production", "preview", "development", undefined]) {
      expect(resolveStagingEnvironmentIdentity(withVal({ VERCEL_ENV: label })).ok).toBe(true);
    }
  });

  it("refuses an otherwise-empty environment", () => {
    expect(resolveStagingEnvironmentIdentity({}).ok).toBe(false);
    expect(isRealSlackOAuthEnabled({})).toBe(false);
  });
});

describe("environment identity — every fact is load-bearing", () => {
  // (1) no explicit staging marker
  it("refuses when the staging marker is absent", () => {
    expect(resolveStagingEnvironmentIdentity(withOut("IDCADDIE_ENVIRONMENT")))
      .toEqual({ ok: false, reason: "environment_marker_missing" });
  });
  it("refuses a marker that is not staging", () => {
    for (const v of ["production", "prod", "Staging ", "dev", ""]) {
      const r = resolveStagingEnvironmentIdentity(withVal({ IDCADDIE_ENVIRONMENT: v }));
      expect(r.ok, `marker ${JSON.stringify(v)} must not pass`).toBe(false);
    }
  });

  // (2) wrong Vercel project id
  it("refuses a wrong Vercel project id", () => {
    expect(resolveStagingEnvironmentIdentity(withVal({ IDCADDIE_VERCEL_PROJECT_ID: "prj_SOMEOTHERPROJECT00000000" })))
      .toEqual({ ok: false, reason: "vercel_project_mismatch" });
  });
  it("refuses a missing Vercel project id", () => {
    expect(resolveStagingEnvironmentIdentity(withOut("IDCADDIE_VERCEL_PROJECT_ID")))
      .toEqual({ ok: false, reason: "vercel_project_missing" });
  });

  // (3) wrong Supabase project
  it("refuses a Supabase URL for a different project", () => {
    expect(resolveStagingEnvironmentIdentity(withVal({ NEXT_PUBLIC_SUPABASE_URL: `https://${OTHER_REF}.supabase.co` })))
      .toEqual({ ok: false, reason: "supabase_project_mismatch" });
  });
  it("refuses a missing Supabase URL", () => {
    expect(resolveStagingEnvironmentIdentity(withOut("NEXT_PUBLIC_SUPABASE_URL")))
      .toEqual({ ok: false, reason: "supabase_project_missing" });
  });

  // (4) production Supabase ref present ANYWHERE
  it("refuses when the production project ref appears in any variable", () => {
    for (const key of ["SOME_UNRELATED_VAR", "DATABASE_URL", "NOTES", "OAUTH_COMPLETER_DB_URL"]) {
      const r = resolveStagingEnvironmentIdentity(withVal({ [key]: `something-${PRODUCTION_SUPABASE_REF}-something` }));
      expect(r, `production ref in ${key} must refuse`).toEqual({ ok: false, reason: "production_supabase_ref_present" });
    }
  });
  it("refuses when the production ref appears in a variable NAME", () => {
    expect(resolveStagingEnvironmentIdentity(withVal({ [`URL_${PRODUCTION_SUPABASE_REF}`]: "x" })))
      .toEqual({ ok: false, reason: "production_supabase_ref_present" });
  });

  // (5) wrong callback URI
  it("refuses a callback URI that is not the exact pinned one", () => {
    for (const bad of [
      "https://idcaddie-v3.vercel.app/connectors/oauth/callback/",     // trailing slash
      "http://idcaddie-v3.vercel.app/connectors/oauth/callback",       // scheme
      "https://idcaddie-v3.vercel.app.attacker.example/connectors/oauth/callback",
      "https://staging.idcaddie.com/connectors/oauth/callback",        // allowlisted elsewhere, not pinned HERE
    ]) {
      const r = resolveStagingEnvironmentIdentity(withVal({ CONNECTOR_OAUTH_REDIRECT_URI: bad }));
      expect(r, `${bad} must refuse`).toEqual({ ok: false, reason: "callback_uri_mismatch" });
    }
  });
  it("refuses a missing callback URI rather than defaulting to one", () => {
    expect(resolveStagingEnvironmentIdentity(withOut("CONNECTOR_OAUTH_REDIRECT_URI")))
      .toEqual({ ok: false, reason: "callback_uri_missing" });
  });

  // (6) missing Slack team id
  it("refuses when the Slack workspace is not configured — absence is not a wildcard", () => {
    expect(resolveStagingEnvironmentIdentity(withOut("CONNECTOR_OAUTH_EXPECTED_SLACK_TEAM_ID")))
      .toEqual({ ok: false, reason: "expected_workspace_missing" });
  });
  it("refuses a malformed Slack workspace id", () => {
    for (const bad of ["", "t0abcdef", "XABCDEF", "T", "T0ABC DEF"]) {
      expect(resolveStagingEnvironmentIdentity(withVal({ CONNECTOR_OAUTH_EXPECTED_SLACK_TEAM_ID: bad })).ok).toBe(false);
    }
  });

  // (7) real mode disabled
  it("refuses when real mode is not explicitly enabled", () => {
    for (const v of [undefined, "", "0", "true", "yes"]) {
      const r = resolveStagingEnvironmentIdentity(withVal({ CONNECTOR_OAUTH_REAL_EXCHANGE_ENABLED: v }));
      expect(r, `flag ${JSON.stringify(v)} must not enable real mode`).toEqual({ ok: false, reason: "real_exchange_disabled" });
    }
  });

  // The narrow identity from docs/83.
  it("refuses when the runner's own credential is present anywhere in the environment", () => {
    const r = resolveStagingEnvironmentIdentity(withVal({
      SOME_DB_URL: `postgresql://connector_runner_login:not-a-real-token@db.${STAGING_SUPABASE_REF}.supabase.co:5432/postgres`,
    }));
    expect(r).toEqual({ ok: false, reason: "runner_credential_present" });
  });
  // Phase 8K INVERTED this. An earlier design authenticated the web tier as `oauth_completer` directly, which required
  // a Postgres driver in a public request path and violated doc 46 §11; the gate REQUIRED the credential. Completion
  // moved to a worker, so the same variable is now evidence that the rejected design is being rebuilt.
  it("refuses when a completer connection string is present under its own name", () => {
    expect(resolveStagingEnvironmentIdentity(withVal({ OAUTH_COMPLETER_DB_URL: COMPLETER_URL })))
      .toEqual({ ok: false, reason: "completer_credential_present" });
  });
  it("refuses when the completer role appears in a value under ANY variable name", () => {
    // Renaming the variable is the obvious way around a name-only check, so the value is scanned too.
    expect(resolveStagingEnvironmentIdentity(withVal({ SOME_OTHER_DB_URL: COMPLETER_URL })))
      .toEqual({ ok: false, reason: "completer_credential_present" });
  });
  it("refuses an EMPTY completer variable — the hazard is the variable existing, not its value", () => {
    expect(resolveStagingEnvironmentIdentity(withVal({ OAUTH_COMPLETER_DB_URL: "" })))
      .toEqual({ ok: false, reason: "completer_credential_present" });
  });
  it("accepts the staging configuration precisely BECAUSE no database credential is present", () => {
    expect(resolveStagingEnvironmentIdentity(VALID).ok).toBe(true);
  });

  it.each(["CONNECTOR_OAUTH_EXPECTED_TENANT_ID", "CONNECTOR_OAUTH_EXPECTED_CONNECTOR_ID", "CONNECTOR_OAUTH_EXPECTED_CORRELATION_ID"])(
    "refuses when %s is absent — there is no default trusted context",
    (k) => { expect(resolveStagingEnvironmentIdentity(withOut(k))).toEqual({ ok: false, reason: "expected_context_missing" }); },
  );

  it("refuses a missing Slack client id", () => {
    expect(resolveStagingEnvironmentIdentity(withOut("SLACK_CLIENT_ID")))
      .toEqual({ ok: false, reason: "slack_client_id_missing" });
  });
});

// (10) no secret or environment value in an error
describe("refusals never carry a value", () => {
  it("returns a bounded reason code and nothing else", () => {
    const cases = [
      withOut("IDCADDIE_ENVIRONMENT"),
      withVal({ IDCADDIE_VERCEL_PROJECT_ID: "prj_LEAKME_WRONGPROJECT" }),
      withVal({ NEXT_PUBLIC_SUPABASE_URL: `https://LEAKME-${OTHER_REF}.supabase.co` }),
      withVal({ NOTES: `leak-${PRODUCTION_SUPABASE_REF}` }),
      withVal({ CONNECTOR_OAUTH_REDIRECT_URI: "https://LEAKME.example/connectors/oauth/callback" }),
      withVal({ OAUTH_COMPLETER_DB_URL: "postgresql://postgres:LEAKME-not-a-real-token@host/db" }),
      withVal({ SOME_DB_URL: "postgresql://connector_runner_login:LEAKME-not-a-real-token@host/db" }),
    ];
    for (const env of cases) {
      const r = resolveStagingEnvironmentIdentity(env);
      expect(r.ok).toBe(false);
      const serialized = JSON.stringify(r);
      // Nothing from the environment — no password, no host, no project id, no connection string, no ref.
      expect(serialized).not.toMatch(/LEAKME|s3cr3t|password|postgresql:\/\/|supabase\.co|prj_|vercel\.app/i);
      expect(serialized).not.toContain(PRODUCTION_SUPABASE_REF);
      expect(serialized).not.toContain(STAGING_SUPABASE_REF);
      // Exactly the two keys, and a reason that is a snake_case code rather than prose.
      expect(Object.keys(r).sort()).toEqual(["ok", "reason"]);
      expect((r as { reason: string }).reason).toMatch(/^[a-z_]+$/);
    }
  });

  it("does not leak the accepted values into a thrown error either", () => {
    // The success path returns values by design; what must not happen is them escaping through an exception.
    expect(() => resolveStagingEnvironmentIdentity(VALID)).not.toThrow();
  });
});
