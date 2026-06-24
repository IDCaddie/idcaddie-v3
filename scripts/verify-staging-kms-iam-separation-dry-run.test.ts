import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Local guard test for scripts/verify-staging-kms-iam-separation-dry-run.mjs. It runs the script with a TEMP ref
// file and never sets a real AWS/KMS identity — the script connects to NOTHING in any mode, so no hosted call
// ever happens. These assert the production-refusal / staging-only / confirmation / required-env / redaction /
// synthetic-only / negative-decrypt guards only.

const SCRIPT = fileURLToPath(new URL("./verify-staging-kms-iam-separation-dry-run.mjs", import.meta.url));
const STAGING = "ycdpzduxugdsffjqyoai";
const PROD = "dzbfxulvxchdemcettrx";
const PHRASE = "RUN KMS IAM SEPARATION STAGING DRY RUN";
const SYNTH = "synthetic-kms-dry-run-not-a-token";
const RUNNER_PROFILE = "runner-profile-SECRETVALUE";
const WEB_PROFILE = "web-profile-SECRETVALUE";
const KEK = "alias/idcaddie-vault-kek-SECRETVALUE";

function run(ref: string | null, extraEnv: Record<string, string> = {}, args: string[] = []) {
  const dir = mkdtempSync(join(tmpdir(), "kmsiam-"));
  const env = { ...process.env };
  for (const k of ["CONNECTOR_VAULT_KMS_IAM_DRY_RUN_CONFIRM", "CONNECTOR_VAULT_AWS_KMS_REGION", "CONNECTOR_VAULT_KMS_KEY_ID", "CONNECTOR_VAULT_RUNNER_AWS_PROFILE", "CONNECTOR_VAULT_WEB_AWS_PROFILE"]) delete env[k];
  if (ref === null) {
    env.CONNECTOR_VAULT_KMS_IAM_DRY_RUN_REF_FILE = join(dir, "missing-ref");
  } else {
    const f = join(dir, "project-ref");
    writeFileSync(f, ref + "\n");
    env.CONNECTOR_VAULT_KMS_IAM_DRY_RUN_REF_FILE = f;
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

const FULL_ENV = {
  CONNECTOR_VAULT_KMS_IAM_DRY_RUN_CONFIRM: PHRASE,
  CONNECTOR_VAULT_AWS_KMS_REGION: "us-east-1",
  CONNECTOR_VAULT_KMS_KEY_ID: KEK,
  CONNECTOR_VAULT_RUNNER_AWS_PROFILE: RUNNER_PROFILE,
  CONNECTOR_VAULT_WEB_AWS_PROFILE: WEB_PROFILE,
};

describe("verify-staging-kms-iam-separation-dry-run.mjs guards", () => {
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

  it("refuses (no hosted action) when confirmation is missing — default mode", () => {
    const r = run(STAGING, {});
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/REFUSE/i);
    expect(r.out).toMatch(/connects to nothing|performs NO hosted action|not executed by the agent/i);
    expect(r.out).not.toMatch(/\[RUNBOOK\]/);
    // default mode emits no KMS commands
    expect(r.out).not.toMatch(/kms generate-data-key/i);
  });

  it("refuses when confirmed but a required env is missing", () => {
    const r = run(STAGING, { CONNECTOR_VAULT_KMS_IAM_DRY_RUN_CONFIRM: PHRASE });
    expect(r.code).not.toBe(0);
    expect(r.out).toMatch(/missing required env/i);
    expect(r.out).toContain("CONNECTOR_VAULT_RUNNER_AWS_PROFILE");
    expect(r.out).toContain("CONNECTOR_VAULT_WEB_AWS_PROFILE");
  });

  it("emits the runbook when confirmed + staging + required env (and runs no hosted command)", () => {
    const r = run(STAGING, FULL_ENV);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/\[RUNBOOK\]/);
    expect(r.out).toMatch(/this script opens no connection/i);
  });

  it("redacts — never prints an env secret VALUE (profile/KEK), only the var name", () => {
    const r = run(STAGING, FULL_ENV);
    expect(r.out).not.toContain("SECRETVALUE");
    expect(r.out).not.toContain(RUNNER_PROFILE);
    expect(r.out).not.toContain(WEB_PROFILE);
    expect(r.out).not.toContain(KEK);
    expect(r.out).toContain("$CONNECTOR_VAULT_RUNNER_AWS_PROFILE");
    expect(r.out).toContain("$CONNECTOR_VAULT_WEB_AWS_PROFILE");
    expect(r.out).toContain("$CONNECTOR_VAULT_KMS_KEY_ID");
  });

  it("uses only the synthetic plaintext — no provider token / token-exchange / OAuth strings", () => {
    const r = run(STAGING, FULL_ENV);
    expect(r.out).toContain(SYNTH);
    for (const tok of ["access_token", "refresh_token", "grant_type", "token_endpoint", "client_secret", "xoxb-", "ya29.", "Bearer ", "authorization:", "oauth"]) {
      expect(r.out).not.toContain(tok);
    }
  });

  it("the LOAD-BEARING test is the web/request NEGATIVE: web identity kms:Decrypt must be DENIED", () => {
    const r = run(STAGING, FULL_ENV);
    // step 1: runner positive (CAN decrypt)
    expect(r.out).toMatch(/RUNNER POSITIVE/);
    expect(r.out).toMatch(/can GenerateDataKey \+ Encrypt \+ Decrypt|GenerateDataKey\/Encrypt\/Decrypt/i);
    // step 2: web negative (MUST be denied) — the proof of separation
    expect(r.out).toMatch(/WEB\/REQUEST NEGATIVE/);
    expect(r.out).toMatch(/EXPECT a non-zero exit \+ AccessDeniedException/);
    expect(r.out).toMatch(/Expect: DENIED/);
    expect(r.out).toMatch(/If this SUCCEEDS, the separation is BROKEN/);
  });

  it("the runbook adds NO grant, touches NO connector_secrets / connector_runner DB grant, makes no DB write", () => {
    const r = run(STAGING, FULL_ENV);
    const lower = r.out.toLowerCase();
    expect(lower).not.toMatch(/grant\s+(select|insert|update|delete|all)\b/);
    expect(lower).not.toMatch(/connector_runner/);          // KMS-only test; no DB grant role involved
    expect(lower).not.toMatch(/insert\s+into|update\s+|delete\s+from|set role/); // no DB statements at all
  });

  it("records what is/ is not proven: DB shape (#163), KMS/IAM separation (this run), real-credential still blocked", () => {
    const r = run(STAGING, FULL_ENV);
    expect(r.out).toMatch(/DB grant shape: already proven by the #163/);
    expect(r.out).toMatch(/KMS\/IAM separation: PROVEN by THIS run only if step 1 = PASS AND step 2 = DENIED/);
    expect(r.out).toMatch(/real credential readiness: STILL blocked until audit \+ rotation\/revocation \+ lifecycle/);
    expect(r.out).toMatch(/does NOT, on/);
    expect(r.out).toMatch(/RISK-001 remains OPEN/);
    expect(r.out).toMatch(/RISK-007 remains OPEN/);
    expect(r.out).toMatch(/Cutover remains BLOCKED/);
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
});

// Static source guards: the script never opens a KMS/AWS/DB/provider client at the top level and carries no secret.
describe("verify-staging-kms-iam-separation-dry-run.mjs source is connect-to-nothing + scoped", () => {
  it("imports only node:fs; no aws-sdk / supabase / DB driver / fetch / service-role", () => {
    const src = readFileSync(fileURLToPath(new URL("./verify-staging-kms-iam-separation-dry-run.mjs", import.meta.url)), "utf8");
    const imports = [...src.matchAll(/from\s+["']([^"']+)["']/g)].map((m) => m[1]);
    expect(imports).toEqual(["node:fs"]);
    const code = src.replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
    for (const bad of ["@aws-sdk", "KMSClient", "createClient", "@supabase", "pg.Client", "new Client(", "fetch(", ["service", "role", "key"].join("_")]) {
      expect(code).not.toContain(bad);
    }
    expect(src).toContain(SYNTH); // the synthetic plaintext is present; no real provider token
  });
});
