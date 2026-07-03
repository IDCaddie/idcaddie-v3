import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SEPARATION_MATRIX,
  evaluateSeparation,
  correctMockSimulate,
  formatMatrix,
  runSelftest,
  REQUIRED_ENV,
} from "./verify-connector-vault-kms-iam-separation.mjs";

const SCRIPT = fileURLToPath(new URL("./verify-connector-vault-kms-iam-separation.mjs", import.meta.url));
const STAGING = "ycdpzduxugdsffjqyoai";
const PROD = "dzbfxulvxchdemcettrx";

const A = { task: "arn:aws:iam::123456789012:role/task", exec: "arn:aws:iam::123456789012:role/exec", web: "arn:aws:iam::123456789012:role/web", cmk: "arn:aws:kms:ca-central-1:123456789012:key/CMK", decoyCmk: "arn:aws:kms:ca-central-1:123456789012:key/DECOY", dbUrlSecret: "arn:aws:secretsmanager:ca-central-1:123456789012:secret:dburl", connectorSecret: "arn:aws:secretsmanager:ca-central-1:123456789012:secret:conn" };
const ALIAS = "alias/idcaddie-staging-connector-vault";
const okAliases = () => [ALIAS];

// spawn the script with a temp ref file; the script opens NO connection in any path these tests hit.
function run(extraEnv: Record<string, string> = {}, args: string[] = [], ref: string | null = STAGING) {
  const dir = mkdtempSync(join(tmpdir(), "kmsiam-verify-"));
  const env = { ...process.env };
  for (const k of ["CONNECTOR_VAULT_KMS_IAM_VERIFY", "CONNECTOR_VAULT_KMS_IAM_VERIFY_CONFIRM", ...REQUIRED_ENV]) delete env[k];
  Object.assign(env, extraEnv);
  if (ref === null) env.CONNECTOR_VAULT_KMS_IAM_VERIFY_REF_FILE = join(dir, "missing");
  else { const f = join(dir, "project-ref"); writeFileSync(f, ref + "\n"); env.CONNECTOR_VAULT_KMS_IAM_VERIFY_REF_FILE = f; }
  try {
    const stdout = execFileSync("node", [SCRIPT, ...args], { env, encoding: "utf8" });
    return { code: 0, out: stdout };
  } catch (e: unknown) {
    const err = e as { status?: number; stdout?: string };
    return { code: err.status ?? 1, out: err.stdout ?? "" };
  }
}

describe("connector-vault KMS/IAM separation verifier — matrix logic (mocks only) + fail-closed guards", () => {
  it("the built-in selftest passes (6 matrix-logic checks, no AWS)", () => {
    expect(runSelftest()).toEqual({ ok: true, checks: 6 });
  });

  it("a correct hosted policy PASSES the full allowed/denied matrix + alias-scope", () => {
    const r = evaluateSeparation({ arns: A, expectedAlias: ALIAS, simulate: correctMockSimulate(A), resolveAliases: okAliases });
    expect(r.allPass).toBe(true);
    expect(r.rows).toHaveLength(SEPARATION_MATRIX.length + 1); // + alias row
    // the load-bearing negatives are present and expected-denied
    for (const id of ["web/kms:Decrypt/cmk", "exec/kms:Decrypt/cmk", "exec/GetSecretValue/connectorSecret", "task/kms:Decrypt/decoyCMK"])
      expect(r.rows.find((x: { id: string }) => x.id === id)?.expect).toBe("denied");
  });

  it("DETECTS a WILDCARDED KMS resource (task can decrypt the decoy CMK) → FAIL", () => {
    const r = evaluateSeparation({ arns: A, expectedAlias: ALIAS, resolveAliases: okAliases,
      simulate: (p: string, act: string, res: string) => (act === "kms:Decrypt" || act === "kms:GenerateDataKey") ? (p === A.task ? "allowed" : "denied") : correctMockSimulate(A)(p, act, res) });
    expect(r.rows.find((x: { id: string }) => x.id === "task/kms:Decrypt/decoyCMK")?.pass).toBe(false);
    expect(r.allPass).toBe(false);
  });

  it("DETECTS web/request OR execution role able to decrypt the vault CMK → FAIL", () => {
    const r = evaluateSeparation({ arns: A, expectedAlias: ALIAS, resolveAliases: okAliases,
      simulate: (p: string, act: string, res: string) => (act === "kms:Decrypt" && res === A.cmk) ? "allowed" : correctMockSimulate(A)(p, act, res) });
    expect(r.rows.find((x: { id: string }) => x.id === "web/kms:Decrypt/cmk")?.pass).toBe(false);
    expect(r.rows.find((x: { id: string }) => x.id === "exec/kms:Decrypt/cmk")?.pass).toBe(false);
  });

  it("DETECTS a WRONG CMK/alias (CMK does not resolve to the expected vault alias) → FAIL", () => {
    const r = evaluateSeparation({ arns: A, expectedAlias: ALIAS, simulate: correctMockSimulate(A), resolveAliases: () => ["alias/some-other-key"] });
    expect(r.rows.find((x: { id: string }) => x.id === "cmk/alias-scope")?.pass).toBe(false);
    expect(r.allPass).toBe(false);
  });

  it("DETECTS exec role reading the connector secret (Secrets Manager role separation broken) → FAIL", () => {
    const r = evaluateSeparation({ arns: A, expectedAlias: ALIAS, resolveAliases: okAliases,
      simulate: (p: string, act: string, res: string) => (p === A.exec && act === "secretsmanager:GetSecretValue") ? "allowed" : correctMockSimulate(A)(p, act, res) });
    expect(r.rows.find((x: { id: string }) => x.id === "exec/GetSecretValue/connectorSecret")?.pass).toBe(false);
  });

  it("output is redacted — verdicts/metadata only, no account id / full ARN / secret shape", () => {
    const out = formatMatrix(evaluateSeparation({ arns: A, expectedAlias: ALIAS, simulate: correctMockSimulate(A), resolveAliases: okAliases }));
    expect(out).not.toMatch(/123456789012/);          // no account id
    expect(out).not.toMatch(/arn:aws:/);              // no full ARN
    expect(out).not.toMatch(/xox[bp]-|postgres:\/\//);// no token / DB URL shape
    expect(out).toContain("ALL SEPARATION CHECKS PASS");
  });

  it("is INERT by default: `selftest` needs no AWS/env and exits 0; bare run refuses (exit 1)", () => {
    const st = run({}, ["selftest"]);
    expect(st.code).toBe(0);
    expect(st.out).toContain("SELFTEST PASS");
    const bare = run({}, []);
    expect(bare.code).toBe(1);
    expect(bare.out).toMatch(/INERT by default|REFUSED/);
  });

  it("live path fails closed: missing env / no confirm / production ref are all refused", () => {
    // enabled but no confirmation
    expect(run({ CONNECTOR_VAULT_KMS_IAM_VERIFY: "1" }).out).toMatch(/no confirmation/);
    // enabled + confirmed + PRODUCTION ref → refuse production (never proceeds to any AWS call)
    const prod = run({ CONNECTOR_VAULT_KMS_IAM_VERIFY: "1", CONNECTOR_VAULT_KMS_IAM_VERIFY_CONFIRM: "RUN KMS IAM SEPARATION VERIFY" }, [], PROD);
    expect(prod.code).toBe(1);
    expect(prod.out).toMatch(/production/i);
    // enabled + confirmed + staging ref but missing the required identity env → fail closed
    const staging = run({ CONNECTOR_VAULT_KMS_IAM_VERIFY: "1", CONNECTOR_VAULT_KMS_IAM_VERIFY_CONFIRM: "RUN KMS IAM SEPARATION VERIFY" }, [], STAGING);
    expect(staging.code).toBe(1);
    expect(staging.out).toMatch(/missing required env/);
  });
});
