import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Local guard test for scripts/verify-staging-connector-vault-dry-run.mjs. It runs the script with a TEMP
// ref file and never sets a real DB/KMS URL — the script connects to NOTHING in any mode, so no hosted call
// ever happens. These assert the production-refusal / confirmation / required-env / redaction guards only.

const SCRIPT = fileURLToPath(new URL("./verify-staging-connector-vault-dry-run.mjs", import.meta.url));
const STAGING = "ycdpzduxugdsffjqyoai";
const PROD = "dzbfxulvxchdemcettrx";
const PHRASE = "RUN CONNECTOR VAULT STAGING DRY RUN";
const SYNTH = "synthetic-vault-dry-run-not-a-token";
const SECRET = "postgres://runner:SUPERSECRETPW@db.example.com:5432/postgres";

function run(ref: string | null, extraEnv: Record<string, string> = {}, args: string[] = []) {
  const dir = mkdtempSync(join(tmpdir(), "cvdry-"));
  const env = { ...process.env };
  // Never inherit any hosted secret/confirmation; each case sets exactly what it needs.
  for (const k of ["CONNECTOR_VAULT_DRY_RUN_CONFIRM", "CONNECTOR_RUNNER_DB_URL", "CONNECTOR_VAULT_AWS_KMS_REGION", "CONNECTOR_VAULT_KMS_KEY_ID", "CONNECTOR_VAULT_SETUP_DB_URL", "CONNECTOR_OAUTH_STATE_SECRET"]) delete env[k];
  if (ref === null) {
    env.CONNECTOR_VAULT_DRY_RUN_REF_FILE = join(dir, "missing-ref");
  } else {
    const f = join(dir, "project-ref");
    writeFileSync(f, ref + "\n");
    env.CONNECTOR_VAULT_DRY_RUN_REF_FILE = f;
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

const FULL_ENV = { CONNECTOR_VAULT_DRY_RUN_CONFIRM: PHRASE, CONNECTOR_RUNNER_DB_URL: SECRET, CONNECTOR_VAULT_AWS_KMS_REGION: "us-east-1", CONNECTOR_VAULT_KMS_KEY_ID: "alias/idcaddie-connector-vault-kek-staging" };

describe("verify-staging-connector-vault-dry-run.mjs guards", () => {
  it("REFUSES the production ref explicitly", () => {
    const r = run(PROD, FULL_ENV);
    expect(r.code).not.toBe(0);
    expect(r.out).toMatch(/REFUSED|FATAL/i);
    expect(r.out).toContain(PROD);
  });

  it("fails closed when the ref is not staging", () => {
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
    // default mode does not emit the hosted runbook (no consume statement printed)
    expect(r.out).not.toMatch(/\[RUNBOOK\]/);
    expect(r.out).not.toMatch(/update public\.oauth_pending set consumed_at/i);
  });

  it("refuses when confirmed but a required env/config is missing", () => {
    const r = run(STAGING, { CONNECTOR_VAULT_DRY_RUN_CONFIRM: PHRASE }); // confirm but no DB/KMS env
    expect(r.code).not.toBe(0);
    expect(r.out).toMatch(/missing required env/i);
    expect(r.out).toContain("CONNECTOR_RUNNER_DB_URL");
  });

  it("emits the runbook when confirmed + staging + all env present (and runs no hosted command)", () => {
    const r = run(STAGING, FULL_ENV);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/\[RUNBOOK\]/);
    expect(r.out).toMatch(/consume exactly once/i);
    expect(r.out).toMatch(/this script opens no connection/i);
  });

  it("redacts secrets — never prints an env secret VALUE, only the var name", () => {
    const r = run(STAGING, FULL_ENV);
    expect(r.out).not.toContain("SUPERSECRETPW");
    expect(r.out).not.toContain(SECRET);
    expect(r.out).toContain("$CONNECTOR_RUNNER_DB_URL"); // references the var by name only
  });

  it("uses only the synthetic non-secret payload — no provider token strings", () => {
    const r = run(STAGING, FULL_ENV);
    expect(r.out).toContain(SYNTH);
    for (const tok of ["access_token", "refresh_token", "grant_type", "token_endpoint"]) {
      expect(r.out).not.toContain(tok);
    }
  });

  it("runs NO hosted INSERT/UPDATE/DELETE on connector_secrets; proves the narrow column-scoped grant + deny-all", () => {
    const r = run(STAGING, FULL_ENV);
    const lower = r.out.toLowerCase();
    // the runbook performs NO hosted mutation against the secret table (read-only catalog + SELECT only)
    expect(lower).not.toMatch(/insert\s+into\s+public\.connector_secrets/);
    expect(lower).not.toMatch(/update\s+public\.connector_secrets/);
    expect(lower).not.toMatch(/delete\s+from\s+public\.connector_secrets/);
    // it describes the NEW intended post-0029 state: a COLUMN-scoped grant (not table-level), read via catalog
    expect(r.out).toMatch(/column-scoped/i);
    expect(r.out).toMatch(/role_column_grants/);
    expect(r.out).toMatch(/has_table_privilege\('connector_runner','public\.connector_secrets','SELECT'\) is FALSE/i);
    expect(r.out).toMatch(/NO UPDATE\/DELETE/i);
    // request-path stays fully denied; a non-granted column read is permission denied
    expect(r.out).toMatch(/permission denied/i);
    expect(r.out).toMatch(/anon AND as authenticated/i);
  });

  it("--help prints usage and exits 0 without any hosted action", () => {
    const r = run(STAGING, {}, ["--help"]);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/Usage:/);
    expect(r.out).not.toMatch(/\[RUNBOOK\]/);
  });

  it("the --ref override is honored — staging emits the runbook, production is refused", () => {
    const ok = run(null, FULL_ENV, ["--ref", STAGING]); // no ref file; ref comes from the flag
    expect(ok.code).toBe(0);
    expect(ok.out).toMatch(/\[RUNBOOK\]/);
    const prod = run(null, FULL_ENV, ["--ref", PROD]);
    expect(prod.code).not.toBe(0);
    expect(prod.out).toContain(PROD);
    expect(prod.out).toMatch(/REFUSED|PRODUCTION/i);
  });

  it("the cleanup delete is narrow (synthetic jti prefix + synthetic tenant) — never an unqualified delete", () => {
    const r = run(STAGING, FULL_ENV);
    expect(r.out).toMatch(/delete from public\.oauth_pending where state_jti like 'dryrun-%' and tenant_id=/i);
    expect(r.out).not.toMatch(/delete\s+from\s+public\.oauth_pending\s*;/i); // no broad/unconditional delete
  });
});

// Static source guards: the script never opens a DB/KMS client at the top level and carries no real secret.
describe("verify-staging-connector-vault-dry-run.mjs source is connect-to-nothing + scoped", () => {
  it("imports only node:fs; no DB driver / aws-sdk / supabase client / fetch", () => {
    const src = readFileSync(fileURLToPath(new URL("./verify-staging-connector-vault-dry-run.mjs", import.meta.url)), "utf8");
    const imports = [...src.matchAll(/from\s+["']([^"']+)["']/g)].map((m) => m[1]);
    expect(imports).toEqual(["node:fs"]);
    const code = src.replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
    for (const bad of ["createClient", "@supabase", "@aws-sdk", "pg.Client", "new Client(", "fetch("]) {
      expect(code).not.toContain(bad);
    }
    // the synthetic sentinel is present; no real provider token
    expect(src).toContain(SYNTH);
  });
});
