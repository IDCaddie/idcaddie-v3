import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Local guard test for scripts/verify-staging-connector-secret-store-dry-run.mjs. It runs the script with a TEMP
// ref file and never sets a real DB/KMS URL — the script connects to NOTHING in any mode, so no hosted call ever
// happens. These assert the production-refusal / staging-only / confirmation / required-env / redaction /
// synthetic-only / parameterized-narrow-SQL guards only.

const SCRIPT = fileURLToPath(new URL("./verify-staging-connector-secret-store-dry-run.mjs", import.meta.url));
const STAGING = "ycdpzduxugdsffjqyoai";
const PROD = "dzbfxulvxchdemcettrx";
const PHRASE = "RUN CONNECTOR SECRET STORE STAGING DRY RUN";
const SYNTH = "synthetic-vault-dry-run-not-a-token";
const RUNNER_URL = "postgres://runner:SUPERSECRETPW@db.example.com:5432/postgres";
const SETUP_URL = "postgres://admin:ADMINSECRETPW@db.example.com:5432/postgres";

function run(ref: string | null, extraEnv: Record<string, string> = {}, args: string[] = []) {
  const dir = mkdtempSync(join(tmpdir(), "cssdry-"));
  const env = { ...process.env };
  for (const k of ["CONNECTOR_SECRET_STORE_DRY_RUN_CONFIRM", "CONNECTOR_RUNNER_DB_URL", "CONNECTOR_VAULT_SETUP_DB_URL", "CONNECTOR_VAULT_AWS_KMS_REGION", "CONNECTOR_VAULT_KMS_KEY_ID"]) delete env[k];
  if (ref === null) {
    env.CONNECTOR_SECRET_STORE_DRY_RUN_REF_FILE = join(dir, "missing-ref");
  } else {
    const f = join(dir, "project-ref");
    writeFileSync(f, ref + "\n");
    env.CONNECTOR_SECRET_STORE_DRY_RUN_REF_FILE = f;
  }
  Object.assign(env, extraEnv);
  try {
    const out = execFileSync("node", [SCRIPT, ...args], { env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return { code: 0, out };
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string };
    return { code: err.status ?? -1, out: (err.stdout ?? "") + (err.stderr ?? "") };
  }
}

const FULL_ENV = { CONNECTOR_SECRET_STORE_DRY_RUN_CONFIRM: PHRASE, CONNECTOR_RUNNER_DB_URL: RUNNER_URL, CONNECTOR_VAULT_SETUP_DB_URL: SETUP_URL };

describe("verify-staging-connector-secret-store-dry-run.mjs guards", () => {
  it("REFUSES the production ref explicitly", () => {
    const r = run(PROD, FULL_ENV);
    expect(r.code).not.toBe(0);
    expect(r.out).toMatch(/REFUSED|FATAL/i);
    expect(r.out).toContain(PROD);
  });

  it("fails closed when the ref is not staging (unknown ref)", () => {
    const r = run("some-other-ref", FULL_ENV);
    expect(r.code).not.toBe(0);
    expect(r.out).toMatch(/refus/i);
  });

  it("fails closed when there is no ref file and no --ref", () => {
    const r = run(null, FULL_ENV);
    expect(r.code).not.toBe(0);
    expect(r.out).toMatch(/FATAL/i);
  });

  it("refuses (no hosted mutation) when confirmation is missing — default mode", () => {
    const r = run(STAGING, {}); // no confirm, no env
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/REFUSE/i);
    expect(r.out).toMatch(/connects to nothing|performs NO hosted mutation|not executed by the agent/i);
    expect(r.out).not.toMatch(/\[RUNBOOK\]/);
    // default mode emits no SQL
    expect(r.out).not.toMatch(/insert\s+into\s+public\.connector_secrets/i);
  });

  it("refuses when confirmed but a required env is missing", () => {
    const r = run(STAGING, { CONNECTOR_SECRET_STORE_DRY_RUN_CONFIRM: PHRASE }); // confirm but no DB env
    expect(r.code).not.toBe(0);
    expect(r.out).toMatch(/missing required env/i);
    expect(r.out).toContain("CONNECTOR_RUNNER_DB_URL");
  });

  it("emits the runbook when confirmed + staging + required env (and runs no hosted command)", () => {
    const r = run(STAGING, FULL_ENV);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/\[RUNBOOK\]/);
    expect(r.out).toMatch(/this script opens no connection/i);
    expect(r.out).toMatch(/set role connector_runner/);
  });

  it("redacts secrets — never prints an env secret VALUE, only the var name", () => {
    const r = run(STAGING, FULL_ENV);
    expect(r.out).not.toContain("SUPERSECRETPW");
    expect(r.out).not.toContain("ADMINSECRETPW");
    expect(r.out).not.toContain(RUNNER_URL);
    expect(r.out).not.toContain(SETUP_URL);
    expect(r.out).toContain("$CONNECTOR_RUNNER_DB_URL");
    expect(r.out).toContain("$CONNECTOR_VAULT_SETUP_DB_URL");
  });

  it("uses only the synthetic non-secret payload — no provider token strings or token-exchange endpoints", () => {
    const r = run(STAGING, FULL_ENV);
    expect(r.out).toContain(SYNTH);
    for (const tok of ["access_token", "refresh_token", "grant_type", "token_endpoint", "client_secret", "authorization:", "xoxb-", "ya29.", "Bearer "]) {
      expect(r.out).not.toContain(tok);
    }
  });

  it("the secret INSERT names the adapter's exact 12 allowed columns; never id/is_active/created_at/revoked_at", () => {
    const r = run(STAGING, FULL_ENV);
    // the connector_secrets INSERT names exactly the 12 allowed columns (the adapter shape)
    expect(r.out).toMatch(/insert into public\.connector_secrets/i);
    expect(r.out).toContain("(tenant_id, connector_id, secret_kind, version, ciphertext, dek_wrapped, aead_nonce,");
    expect(r.out).toContain("aad_digest, key_id, aead_tag, envelope_version, aead_alg)");
    // the secret INSERT starts with tenant_id (NOT id — a leading "(id, tenant_id, connector_id" would mean id is written)
    expect(r.out).not.toMatch(/\(id, tenant_id, connector_id/);
    // these non-granted columns never appear anywhere in the runbook
    for (const bad of ["is_active", "created_at", "revoked_at"]) expect(r.out).not.toContain(bad);
    // the LOAD filters active + non-expired
    expect(r.out).toMatch(/status='active' and \(expires_at is null or expires_at > now\(\)\)/);
  });

  it("SQL is parameterized ($1..) and adds NO grant (does not broaden connector_runner)", () => {
    const r = run(STAGING, FULL_ENV);
    expect(r.out).toContain("$1"); expect(r.out).toContain("$12");
    expect(r.out).toMatch(/values \(\$1,\$2,\$3,\$4,\$5,\$6,\$7,\$8,\$9,\$10,\$11,\$12\) returning id/);
    // no GRANT statement (no privilege broadening of the runner)
    expect(r.out).not.toMatch(/grant\s+(select|insert|update|delete|all)\b/i);
  });

  it("introduces NO broad connector_secrets mutation; cleanup is narrow + synthetic-keyed only", () => {
    const r = run(STAGING, FULL_ENV);
    const lower = r.out.toLowerCase();
    // no UPDATE against connector_secrets, no unqualified/broad delete, no truncate
    expect(lower).not.toMatch(/update\s+public\.connector_secrets/);
    expect(lower).not.toMatch(/delete\s+from\s+public\.connector_secrets\s*;/);
    expect(lower).not.toMatch(/truncate/);
    // the cleanup delete IS narrow + synthetic-keyed (synthetic tenant + 'dryrun-kek-%' key prefix)
    expect(r.out).toMatch(/delete from public\.connector_secrets where tenant_id = \$1 and key_id like 'dryrun-kek-%'/);
  });

  it("--help prints usage and exits 0 without any hosted action", () => {
    const r = run(STAGING, {}, ["--help"]);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/Usage:/);
    expect(r.out).not.toMatch(/\[RUNBOOK\]/);
  });

  it("the --ref override is honored — staging emits the runbook, production is refused", () => {
    const ok = run(null, FULL_ENV, ["--ref", STAGING]);
    expect(ok.code).toBe(0);
    expect(ok.out).toMatch(/\[RUNBOOK\]/);
    const prod = run(null, FULL_ENV, ["--ref", PROD]);
    expect(prod.code).not.toBe(0);
    expect(prod.out).toContain(PROD);
    expect(prod.out).toMatch(/REFUSED|PRODUCTION/i);
  });

  it("records RISK-007 OPEN and cutover BLOCKED in both the refuse and runbook modes", () => {
    for (const r of [run(STAGING, {}), run(STAGING, FULL_ENV)]) {
      expect(r.out).toMatch(/RISK-007 remains\s+OPEN/i);
      expect(r.out).toMatch(/Cutover remains BLOCKED/i);
    }
  });
});

// Static source guards: the script never opens a DB/KMS client at the top level and carries no real secret.
describe("verify-staging-connector-secret-store-dry-run.mjs source is connect-to-nothing + scoped", () => {
  it("imports only node:fs; no DB driver / aws-sdk / supabase client / fetch / service-role", () => {
    const src = readFileSync(fileURLToPath(new URL("./verify-staging-connector-secret-store-dry-run.mjs", import.meta.url)), "utf8");
    const imports = [...src.matchAll(/from\s+["']([^"']+)["']/g)].map((m) => m[1]);
    expect(imports).toEqual(["node:fs"]);
    const code = src.replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
    for (const bad of ["createClient", "@supabase", "@aws-sdk", "pg.Client", "new Client(", "fetch(", ["service", "role", "key"].join("_")]) {
      expect(code).not.toContain(bad);
    }
    expect(src).toContain(SYNTH); // the synthetic sentinel is present; no real provider token
  });
});
