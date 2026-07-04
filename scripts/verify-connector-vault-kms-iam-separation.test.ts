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
  buildSimulateArgs,
  evaluateKeyPolicyAccess,
  kmsAccessFromKeyPolicy,
  principalMatch,
  actionMatch,
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
  it("the built-in selftest passes (11 matrix-logic checks, no AWS)", () => {
    expect(runSelftest()).toEqual({ ok: true, checks: 11 });
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

  // ── NO_WEB_AWS_PRINCIPAL mode (docs/49 mode B) — the web runtime has no AWS identity ────────────────────────
  it("NO_WEB mode: web rows are recorded `no_web_aws_principal` and PASS by absence (never simulated)", () => {
    const simSpy = (p: string, act: string, res: string) => {
      if (p === A.web) throw new Error("web principal must NOT be simulated in NO_WEB mode");
      return correctMockSimulate(A)(p, act, res);
    };
    const r = evaluateSeparation({ arns: A, expectedAlias: ALIAS, simulate: simSpy, resolveAliases: okAliases, noWebPrincipal: true });
    const webRow = r.rows.find((x: { id: string }) => x.id === "web/kms:Decrypt/cmk");
    expect(webRow?.actual).toBe("no_web_aws_principal");
    expect(webRow?.pass).toBe(true);
    expect(r.allPass).toBe(true);
    expect(formatMatrix(r)).toContain("no_web_aws_principal"); // the reason is visible in the redacted output
  });

  it("NO_WEB mode does NOT weaken non-web rows: exec-decrypt / decoy / connector-secret leaks STILL fail", () => {
    // the sentinel affects `identity==='web'` rows only — every non-web load-bearing negative must still be simulated.
    const leaky = (p: string, act: string, res: string) => {
      if (p === A.exec && act === "kms:Decrypt" && res === A.cmk) return "allowed"; // exec can decrypt the CMK
      if (p === A.task && act === "kms:Decrypt" && res === A.decoyCmk) return "allowed"; // KMS grant wildcarded to the decoy
      if (p === A.exec && act === "secretsmanager:GetSecretValue" && res === A.connectorSecret) return "allowed"; // secret role-sep broken
      return correctMockSimulate(A)(p, act, res);
    };
    const r = evaluateSeparation({ arns: A, expectedAlias: ALIAS, resolveAliases: okAliases, noWebPrincipal: true, simulate: leaky });
    for (const id of ["exec/kms:Decrypt/cmk", "task/kms:Decrypt/decoyCMK", "exec/GetSecretValue/connectorSecret"])
      expect(r.rows.find((x: { id: string }) => x.id === id)?.pass).toBe(false);
    expect(r.allPass).toBe(false);
  });

  it("gate: EXACTLY `NONE` drops the web ARN from required; other env stays required (refuses BEFORE any AWS call)", () => {
    // NONE + every other var EXCEPT the connector secret → refuses on the connector secret, NOT on the web ARN.
    const none = run({
      CONNECTOR_VAULT_KMS_IAM_VERIFY: "1", CONNECTOR_VAULT_KMS_IAM_VERIFY_CONFIRM: "RUN KMS IAM SEPARATION VERIFY",
      AWS_REGION: "ca-central-1", CONNECTOR_VAULT_WEB_ROLE_ARN: "NONE",
      CONNECTOR_VAULT_TASK_ROLE_ARN: A.task, CONNECTOR_VAULT_EXEC_ROLE_ARN: A.exec,
      CONNECTOR_VAULT_CMK_ARN: A.cmk, CONNECTOR_VAULT_DECOY_CMK_ARN: A.decoyCmk,
      CONNECTOR_VAULT_EXPECTED_ALIAS: ALIAS, CONNECTOR_VAULT_DB_URL_SECRET_ARN: A.dbUrlSecret,
      // CONNECTOR_VAULT_CONNECTOR_SECRET_ARN intentionally omitted
    });
    expect(none.code).toBe(1);
    expect(none.out).toMatch(/missing required env/);
    expect(none.out).toContain("CONNECTOR_VAULT_CONNECTOR_SECRET_ARN");
    expect(none.out).not.toContain("CONNECTOR_VAULT_WEB_ROLE_ARN"); // dropped from required in NONE mode
  });

  it("gate: a MISSING/typo web ARN (not exactly `NONE`) stays REQUIRED → refuses, never silently passes", () => {
    // every other var present, web ARN UNSET (not "NONE") → the web ARN is the only thing missing → refuse listing it.
    const webUnset = run({
      CONNECTOR_VAULT_KMS_IAM_VERIFY: "1", CONNECTOR_VAULT_KMS_IAM_VERIFY_CONFIRM: "RUN KMS IAM SEPARATION VERIFY",
      AWS_REGION: "ca-central-1",
      CONNECTOR_VAULT_TASK_ROLE_ARN: A.task, CONNECTOR_VAULT_EXEC_ROLE_ARN: A.exec,
      CONNECTOR_VAULT_CMK_ARN: A.cmk, CONNECTOR_VAULT_DECOY_CMK_ARN: A.decoyCmk,
      CONNECTOR_VAULT_EXPECTED_ALIAS: ALIAS, CONNECTOR_VAULT_DB_URL_SECRET_ARN: A.dbUrlSecret,
      CONNECTOR_VAULT_CONNECTOR_SECRET_ARN: A.connectorSecret,
      // CONNECTOR_VAULT_WEB_ROLE_ARN intentionally unset — NOT the sentinel
    });
    expect(webUnset.code).toBe(1);
    expect(webUnset.out).toMatch(/missing required env/);
    expect(webUnset.out).toContain("CONNECTOR_VAULT_WEB_ROLE_ARN"); // still required when not exactly NONE
  });

  // ── Secrets-Manager simulate builder — never send "*"; never a --resource-policy (the role+key-policy caller bug) ──
  const R = "ca-central-1";
  const hasResourceArns = (a: string[]) => a.includes("--resource-arns");
  const resourceArnStar = (a: string[]) => { const i = a.indexOf("--resource-arns"); return i !== -1 && a[i + 1] === "*"; };

  it("buildSimulateArgs NEVER emits `--resource-arns \"*\"` — a wildcard/absent resource OMITS the flag", () => {
    for (const res of ["*", "", undefined as unknown as string, null as unknown as string]) {
      const a = buildSimulateArgs(A.exec, "secretsmanager:GetSecretValue", res, R);
      expect(resourceArnStar(a)).toBe(false);
      expect(hasResourceArns(a)).toBe(false); // omitted → the API defaults ResourceArns to "*" (valid)
      expect(a.join(" ")).not.toContain("--resource-arns *");
    }
  });

  it("buildSimulateArgs passes a REAL ARN via --resource-arns and NEVER a --resource-policy", () => {
    const a = buildSimulateArgs(A.exec, "secretsmanager:GetSecretValue", A.connectorSecret, R);
    expect(a[a.indexOf("--resource-arns") + 1]).toBe(A.connectorSecret);
    expect(resourceArnStar(a)).toBe(false);
    expect(a).not.toContain("--resource-policy"); // resource-policy caused the role caller error → never sent
  });

  // ── KMS separation via STRUCTURAL key-policy analysis (replaces simulate+--resource-policy) — task-5 coverage ──
  const grant = (principal: string, action: string | string[]) => JSON.stringify({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Principal: { AWS: principal }, Action: action, Resource: "*" }] });

  it("kmsAccessFromKeyPolicy: PASSES only when the task role principal + required KMS actions are present for the vault CMK", () => {
    const vault = grant(A.task, ["kms:Decrypt", "kms:GenerateDataKey"]);
    expect(kmsAccessFromKeyPolicy(vault, A.task, "kms:Decrypt")).toBe("allowed");
    expect(kmsAccessFromKeyPolicy(vault, A.task, "kms:GenerateDataKey")).toBe("allowed");
    // kms:* wildcard action also covers the required actions
    expect(kmsAccessFromKeyPolicy(grant(A.task, "kms:*"), A.task, "kms:Decrypt")).toBe("allowed");
  });

  it("kmsAccessFromKeyPolicy: FAILS-closed when the task principal is missing, or only a different action is granted", () => {
    expect(kmsAccessFromKeyPolicy(grant(A.exec, "kms:*"), A.task, "kms:Decrypt")).toBe("denied"); // task not present
    expect(kmsAccessFromKeyPolicy(grant(A.task, "kms:Encrypt"), A.task, "kms:Decrypt")).toBe("denied"); // wrong action
    expect(kmsAccessFromKeyPolicy("", A.task, "kms:Decrypt")).toBe("error"); // no policy fetched
    expect(kmsAccessFromKeyPolicy("not-json", A.task, "kms:Decrypt")).toBe("error"); // unparseable → NOT a pass
  });

  it("kmsAccessFromKeyPolicy: exec allowed / decoy-allows-task / explicit Deny are all detected", () => {
    expect(kmsAccessFromKeyPolicy(grant(A.exec, "kms:Decrypt"), A.exec, "kms:Decrypt")).toBe("allowed"); // exec leak → row (expect denied) FAILs
    expect(kmsAccessFromKeyPolicy(grant(A.task, "kms:Decrypt"), A.task, "kms:Decrypt")).toBe("allowed"); // decoy granting task → task/decoy row FAILs
    const denyWins = JSON.stringify({ Statement: [{ Effect: "Allow", Principal: { AWS: A.task }, Action: "kms:*", Resource: "*" }, { Effect: "Deny", Principal: { AWS: A.task }, Action: "kms:Decrypt", Resource: "*" }] });
    expect(kmsAccessFromKeyPolicy(denyWins, A.task, "kms:Decrypt")).toBe("denied"); // explicit Deny > Allow
  });

  it("kmsAccessFromKeyPolicy: a wildcard/overbroad principal (`*` or account root) reads `overbroad`, never `allowed`", () => {
    for (const p of ["*", "arn:aws:iam::123456789012:root"]) {
      expect(kmsAccessFromKeyPolicy(grant(p, "kms:Decrypt"), A.task, "kms:Decrypt")).toBe("overbroad"); // not a clean allow
      expect(kmsAccessFromKeyPolicy(grant(p, "kms:Decrypt"), A.exec, "kms:Decrypt")).toBe("overbroad"); // also flags the denied principal
    }
  });

  it("FAIL-OPEN regressions closed: bare account-id root, partial action wildcard, NotPrincipal/NotAction/Condition", () => {
    // (1) bare 12-digit account id == account-root delegation → overbroad (same as arn:…:root); must NOT read a clean allow
    for (const root of ["123456789012", "arn:aws:iam::123456789012:root"]) {
      expect(kmsAccessFromKeyPolicy(grant(root, "kms:Decrypt"), A.task, "kms:Decrypt")).toBe("overbroad");
      expect(kmsAccessFromKeyPolicy(grant(root, "kms:Decrypt"), A.exec, "kms:Decrypt")).toBe("overbroad"); // flips the denied principal too
    }
    // (2) partial action wildcards that AWS honors must match (a missed grant on a DENIED principal would fail open)
    for (const act of ["kms:Decrypt*", "kms:De*", "kms:*Decrypt", "kms:decrypt", "*"])
      expect(kmsAccessFromKeyPolicy(grant(A.exec, act), A.exec, "kms:Decrypt")).toBe("allowed"); // exec granted → its denied row would FAIL
    expect(kmsAccessFromKeyPolicy(grant(A.exec, "kms:Encrypt*"), A.exec, "kms:Decrypt")).toBe("denied"); // genuinely unrelated
    // (3) NotPrincipal / NotAction / Condition → non-analyzable → "error" (fail-closed), never a silent skip that passes a denied row
    const notPrincipal = JSON.stringify({ Statement: [{ Effect: "Allow", NotPrincipal: { AWS: "arn:aws:iam::1:role/other" }, Action: "kms:Decrypt", Resource: "*" }] });
    const notAction = JSON.stringify({ Statement: [{ Effect: "Allow", Principal: { AWS: A.exec }, NotAction: "kms:Encrypt", Resource: "*" }] });
    const conditional = JSON.stringify({ Statement: [{ Effect: "Allow", Principal: { AWS: A.task }, Action: "kms:*", Resource: "*" }, { Effect: "Deny", Principal: { AWS: A.task }, Action: "kms:Decrypt", Resource: "*", Condition: { Bool: { "aws:MultiFactorAuthPresent": "false" } } }] });
    for (const pol of [notPrincipal, notAction, conditional])
      for (const who of [A.task, A.exec]) expect(kmsAccessFromKeyPolicy(pol, who, "kms:Decrypt")).toBe("error");
  });

  it("principalMatch / actionMatch building blocks are correct (exact, wildcard, root)", () => {
    expect(principalMatch({ AWS: [A.task, A.exec] }, A.task)).toEqual({ matches: true, overbroad: false });
    expect(principalMatch({ AWS: A.exec }, A.task)).toEqual({ matches: false, overbroad: false });
    expect(principalMatch({ AWS: "*" }, A.task).overbroad).toBe(true);
    expect(principalMatch({ AWS: "arn:aws:iam::1:root" }, A.task).overbroad).toBe(true);
    expect(actionMatch("kms:*", "kms:Decrypt")).toBe(true);
    expect(actionMatch(["kms:Encrypt", "kms:Decrypt"], "kms:Decrypt")).toBe(true);
    expect(actionMatch("kms:Encrypt", "kms:Decrypt")).toBe(false);
    expect(actionMatch("*", "kms:Decrypt")).toBe(true);
    // evaluateKeyPolicyAccess exposes the raw decision + overbroad flag
    expect(evaluateKeyPolicyAccess(grant(A.task, "kms:Decrypt"), A.task, "kms:Decrypt")).toEqual({ decision: "allow", overbroad: false });
    expect(evaluateKeyPolicyAccess(grant("*", "kms:Decrypt"), A.task, "kms:Decrypt")).toEqual({ decision: "allow", overbroad: true });
    expect(evaluateKeyPolicyAccess("nope", A.task, "kms:Decrypt")).toEqual({ decision: "error", overbroad: false });
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
