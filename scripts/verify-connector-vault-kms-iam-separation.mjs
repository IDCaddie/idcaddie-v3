#!/usr/bin/env node
// verify-connector-vault-kms-iam-separation.mjs
//
// INERT BY DEFAULT. An allowed/denied MATRIX verifier for the hosted connector-vault KMS/IAM SEPARATION boundary
// (RISK-007 closure prerequisite, docs/49). Unlike verify-staging-kms-iam-separation-dry-run.mjs (which PRINTS a
// human runbook), this EVALUATES the boundary and returns a PASS/FAIL matrix — driven in `selftest` by MOCKED
// IAM/KMS clients (proving the matrix LOGIC, with no AWS), and in the operator-only `live` mode by real access
// EVALUATION (`iam:SimulatePrincipalPolicy` + `kms:ListAliases`), which decide access WITHOUT executing anything.
//
// SAFETY MODEL — by construction this never decrypts and never reads a secret value:
//   * It uses ONLY iam:SimulatePrincipalPolicy (evaluates whether a principal WOULD be allowed an action on a
//     resource — it does NOT perform the action) and kms:ListAliases (alias metadata). It calls NO kms:Decrypt,
//     NO kms:GenerateDataKey, NO secretsmanager:GetSecretValue, NO ECS, and touches NO DB.
//   * The agent + CI run ONLY `selftest` (mocked functions, zero AWS). `live` is OPERATOR-RUN ONLY and is
//     fail-closed: it refuses unless every guard/env is set, rejects the production ref, requires the staging ref
//     and an explicit confirmation phrase.
//   * Output is verdicts + metadata ONLY (identity LABEL, action, resource ALIAS/redacted-ARN tail, expected,
//     actual, PASS/FAIL). It NEVER prints a secret value, a DB URL, key material, or a full secret ARN.
//   * The LOAD-BEARING negatives are DENIALS: web/request AND execution roles MUST be denied kms:Decrypt on the
//     vault CMK; the execution role MUST be denied GetSecretValue on the connector secret; the task role MUST be
//     denied kms:Decrypt on a DECOY CMK (proves the KMS grant is scoped to the CMK, not wildcarded `Resource:*`).
//
// A green live run is hosted evidence for the KMS/IAM separation only. It stores no secret and does NOT, on its
// own, close RISK-007 (audited access/use + rotation/revocation + lifecycle remain). RISK-007 remains OPEN;
// Phase C remains BLOCKED.
//
// Operator (live — the agent/CI never run this):
//   CONNECTOR_VAULT_KMS_IAM_VERIFY=1 CONNECTOR_VAULT_KMS_IAM_VERIFY_CONFIRM="RUN KMS IAM SEPARATION VERIFY" \
//   AWS_REGION=ca-central-1 AWS_PROFILE=<admin-readonly profile that may call iam:SimulatePrincipalPolicy> \
//   CONNECTOR_VAULT_TASK_ROLE_ARN=… CONNECTOR_VAULT_EXEC_ROLE_ARN=… CONNECTOR_VAULT_WEB_ROLE_ARN=… \
//   CONNECTOR_VAULT_CMK_ARN=… CONNECTOR_VAULT_DECOY_CMK_ARN=… CONNECTOR_VAULT_EXPECTED_ALIAS=alias/idcaddie-staging-connector-vault \
//   CONNECTOR_VAULT_DB_URL_SECRET_ARN=… CONNECTOR_VAULT_CONNECTOR_SECRET_ARN=… \
//   node scripts/verify-connector-vault-kms-iam-separation.mjs
//
// Self-test (no AWS, mocks only, CI): node scripts/verify-connector-vault-kms-iam-separation.mjs selftest

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const STAGING_REF = "ycdpzduxugdsffjqyoai"; // the only permitted ref
const PRODUCTION_REF = "dzbfxulvxchdemcettrx"; // must NEVER be touched
const CONFIRM_PHRASE = "RUN KMS IAM SEPARATION VERIFY";
const EXPECT_REGION = "ca-central-1";

// The identity/config the operator supplies via env (ARNs are identifiers, not secret values; never printed in full).
export const REQUIRED_ENV = [
  "AWS_REGION",
  "CONNECTOR_VAULT_TASK_ROLE_ARN",
  "CONNECTOR_VAULT_EXEC_ROLE_ARN",
  "CONNECTOR_VAULT_WEB_ROLE_ARN",
  "CONNECTOR_VAULT_CMK_ARN",
  "CONNECTOR_VAULT_DECOY_CMK_ARN",
  "CONNECTOR_VAULT_EXPECTED_ALIAS",
  "CONNECTOR_VAULT_DB_URL_SECRET_ARN",
  "CONNECTOR_VAULT_CONNECTOR_SECRET_ARN",
];

// The allowed/denied SEPARATION MATRIX (the whole contract). identity ∈ {task,exec,web}; resource ∈
// {cmk,decoyCmk,dbUrlSecret,connectorSecret}; expect ∈ {"allowed","denied"}. Every row is a claim about whether a
// principal WOULD be permitted an action on a resource — evaluated, never executed.
export const SEPARATION_MATRIX = [
  { id: "task/kms:Decrypt/cmk",                  identity: "task", action: "kms:Decrypt",                    resource: "cmk",             expect: "allowed", note: "runner CAN decrypt the vault CMK" },
  { id: "task/kms:GenerateDataKey/cmk",          identity: "task", action: "kms:GenerateDataKey",            resource: "cmk",             expect: "allowed", note: "runner CAN wrap a DEK on the vault CMK" },
  { id: "task/kms:Decrypt/decoyCMK",             identity: "task", action: "kms:Decrypt",                    resource: "decoyCmk",        expect: "denied",  note: "KMS Decrypt grant is scoped to the CMK — NOT wildcarded (decoy denied)" },
  { id: "task/kms:GenerateDataKey/decoyCMK",     identity: "task", action: "kms:GenerateDataKey",            resource: "decoyCmk",        expect: "denied",  note: "KMS GenerateDataKey grant is scoped to the CMK — NOT wildcarded (decoy denied)" },
  { id: "web/kms:Decrypt/cmk",                   identity: "web",  action: "kms:Decrypt",                    resource: "cmk",             expect: "denied",  note: "LOAD-BEARING: web/request runtime CANNOT decrypt vault material" },
  { id: "exec/kms:Decrypt/cmk",                  identity: "exec", action: "kms:Decrypt",                    resource: "cmk",             expect: "denied",  note: "LOAD-BEARING: execution role CANNOT decrypt vault material" },
  { id: "exec/GetSecretValue/dbUrl",             identity: "exec", action: "secretsmanager:GetSecretValue",  resource: "dbUrlSecret",     expect: "allowed", note: "execution role MAY read only the DB-URL secret (to inject it)" },
  { id: "exec/GetSecretValue/connectorSecret",   identity: "exec", action: "secretsmanager:GetSecretValue",  resource: "connectorSecret", expect: "denied",  note: "execution role must NOT read the connector/source secret (role separation)" },
  { id: "task/GetSecretValue/connectorSecret",   identity: "task", action: "secretsmanager:GetSecretValue",  resource: "connectorSecret", expect: "allowed", note: "task role MAY read the intended connector secret (where applicable)" },
];

// PURE evaluator. `simulate(principalArn, action, resourceArn) -> "allowed" | "denied"` abstracts
// iam:SimulatePrincipalPolicy's EvalDecision (allowed vs explicit/implicit deny). `resolveAliases(cmkArn) ->
// string[]` abstracts kms:ListAliases. No AWS here — the caller injects real or mock functions. Returns the
// verdict rows + an alias-scope verdict + allPass. Fail-closed: an evaluator throw is caught → that row FAILs.
export function evaluateSeparation({ arns, expectedAlias, simulate, resolveAliases }) {
  const rows = SEPARATION_MATRIX.map((r) => {
    let actual;
    try {
      actual = simulate(arns[r.identity], r.action, arns[r.resource]);
      if (actual !== "allowed" && actual !== "denied") actual = "error";
    } catch {
      actual = "error";
    }
    return { id: r.id, identity: r.identity, action: r.action, resource: r.resource, expect: r.expect, actual, pass: actual === r.expect, note: r.note };
  });
  // Alias scoping: the CMK the roles are granted on must resolve to the EXPECTED vault alias (not some other key).
  let aliasActual, aliasPass;
  try {
    const aliases = resolveAliases(arns.cmk) || [];
    aliasActual = aliases.includes(expectedAlias) ? "match" : "mismatch";
    aliasPass = aliasActual === "match";
  } catch {
    aliasActual = "error";
    aliasPass = false;
  }
  const aliasRow = { id: "cmk/alias-scope", identity: "cmk", action: "kms:ListAliases", resource: "cmk", expect: `alias=${expectedAlias}`, actual: aliasActual, pass: aliasPass, note: "CMK resolves to the expected vault alias" };
  const all = [...rows, aliasRow];
  return { rows: all, allPass: all.every((r) => r.pass) };
}

// Redact an ARN for output: keep the last ':'-segment only (identifier tail), never the account or full path.
const tail = (arn) => (typeof arn === "string" && arn ? String(arn).split(":").slice(-1)[0].slice(0, 48) : "<unset>");

export function formatMatrix(result) {
  const line = (r) => `  [${r.pass ? "PASS" : "FAIL"}] ${r.identity.padEnd(4)} ${r.action.padEnd(28)} expect=${String(r.expect).padEnd(20)} actual=${r.actual}`;
  return result.rows.map(line).join("\n") + `\n  => ${result.allPass ? "ALL SEPARATION CHECKS PASS" : "SEPARATION CHECK FAILED"}`;
}

// ── selftest: prove the matrix LOGIC with MOCK functions only (zero AWS) ─────────────────────────────────────
// A mock "correct" hosted policy: task may decrypt/genkey the CMK + read the connector secret; nobody else can
// decrypt; exec reads only the DB-URL secret; the CMK is scoped (decoy denied); alias matches.
export function correctMockSimulate(A) {
  return (principal, action, resource) => {
    if (action === "kms:Decrypt" || action === "kms:GenerateDataKey")
      return principal === A.task && resource === A.cmk ? "allowed" : "denied"; // ONLY task, ONLY the real CMK
    if (action === "secretsmanager:GetSecretValue") {
      if (principal === A.exec && resource === A.dbUrlSecret) return "allowed";
      if (principal === A.task && resource === A.connectorSecret) return "allowed";
      return "denied";
    }
    return "denied";
  };
}

export function runSelftest() {
  const A = { task: "arn:task", exec: "arn:exec", web: "arn:web", cmk: "arn:cmk", decoyCmk: "arn:decoy", dbUrlSecret: "arn:dburl", connectorSecret: "arn:conn" };
  const alias = "alias/idcaddie-staging-connector-vault";
  const okAliases = () => [alias];
  const fail = (m) => { throw new Error(`SELFTEST FAILED: ${m}`); };

  // 1) correct policy → allPass, and the redacted output leaks nothing.
  const good = evaluateSeparation({ arns: A, expectedAlias: alias, simulate: correctMockSimulate(A), resolveAliases: okAliases });
  good.allPass || fail("a correct hosted policy must pass the full matrix");
  good.rows.length === SEPARATION_MATRIX.length + 1 || fail("matrix + alias row expected");

  // 2) WILDCARD KMS resource (task can decrypt ANY key incl. the decoy — Resource:*) → must FAIL.
  const wildcard = evaluateSeparation({ arns: A, expectedAlias: alias, resolveAliases: okAliases,
    simulate: (p, act, res) => (act === "kms:Decrypt" || act === "kms:GenerateDataKey")
      ? (p === A.task ? "allowed" : "denied")      // task allowed on ANY key incl. the decoy → over-broad
      : correctMockSimulate(A)(p, act, res) });
  wildcard.rows.find((r) => r.id === "task/kms:Decrypt/decoyCMK").pass === false || fail("a wildcarded KMS resource must FAIL the decoy row");
  wildcard.allPass === false || fail("wildcard policy must fail overall");

  // 3) WEB or EXEC can decrypt the CMK → must FAIL the load-bearing negative.
  const leak = evaluateSeparation({ arns: A, expectedAlias: alias, resolveAliases: okAliases,
    simulate: (p, act, res) => (act === "kms:Decrypt" && res === A.cmk) ? "allowed" : correctMockSimulate(A)(p, act, res) });
  leak.rows.find((r) => r.id === "web/kms:Decrypt/cmk").pass === false || fail("web decrypt must FAIL");
  leak.rows.find((r) => r.id === "exec/kms:Decrypt/cmk").pass === false || fail("exec decrypt must FAIL");

  // 4) WRONG CMK/alias: the CMK does not resolve to the expected alias → alias row FAILs.
  const wrongAlias = evaluateSeparation({ arns: A, expectedAlias: alias, simulate: correctMockSimulate(A), resolveAliases: () => ["alias/some-other-key"] });
  wrongAlias.rows.find((r) => r.id === "cmk/alias-scope").pass === false || fail("wrong alias must FAIL the alias-scope row");
  wrongAlias.allPass === false || fail("wrong alias must fail overall");

  // 5) exec reading the connector secret → must FAIL role separation.
  const execLeak = evaluateSeparation({ arns: A, expectedAlias: alias, resolveAliases: okAliases,
    simulate: (p, act, res) => (p === A.exec && act === "secretsmanager:GetSecretValue") ? "allowed" : correctMockSimulate(A)(p, act, res) });
  execLeak.rows.find((r) => r.id === "exec/GetSecretValue/connectorSecret").pass === false || fail("exec reading the connector secret must FAIL");

  // 6) output redaction: no ARN account/path, no secret shapes.
  const out = formatMatrix(good) + tail("arn:aws:kms:ca-central-1:123456789012:key/abc");
  /123456789012/.test(out) && fail("output must not contain an account id");
  return { ok: true, checks: 6 };
}

// ── live simulate/alias via the AWS CLI (OPERATOR-ONLY; never called by selftest/CI) ─────────────────────────
function liveSimulate(region) {
  // Cache the CMK key policy (a RESOURCE-based policy — metadata, NOT a secret). For KMS actions the effective
  // authorization is identity-policy ∪ key-policy, so we pass the key policy via --resource-policy; otherwise a
  // decrypt granted DIRECTLY in the key policy (not IAM) would be invisible and a load-bearing DENIED row could
  // wrongly PASS. kms:GetKeyPolicy reads no key material and decrypts nothing.
  const keyPolicyCache = {};
  const keyPolicy = (cmkArn) => {
    if (!(cmkArn in keyPolicyCache)) {
      try {
        keyPolicyCache[cmkArn] = execFileSync("aws", ["kms", "get-key-policy", "--key-id", cmkArn, "--policy-name",
          "default", "--region", region, "--query", "Policy", "--output", "text"], { encoding: "utf8" }).trim();
      } catch { keyPolicyCache[cmkArn] = ""; }
    }
    return keyPolicyCache[cmkArn];
  };
  return (principalArn, action, resourceArn) => {
    // iam:SimulatePrincipalPolicy EVALUATES access; it performs NO action, reads NO secret, decrypts NOTHING.
    const args = ["iam", "simulate-principal-policy", "--policy-source-arn", principalArn, "--action-names", action,
      "--resource-arns", resourceArn, "--region", region, "--query", "EvaluationResults[0].EvalDecision", "--output", "text"];
    if (action.startsWith("kms:")) { const kp = keyPolicy(resourceArn); if (kp) args.push("--resource-policy", kp); }
    const out = execFileSync("aws", args, { encoding: "utf8" }).trim();
    return out === "allowed" ? "allowed" : "denied"; // explicitDeny/implicitDeny → denied
  };
}
function liveResolveAliases(region) {
  return (cmkArn) => {
    const out = execFileSync("aws", ["kms", "list-aliases", "--key-id", cmkArn, "--region", region,
      "--query", "Aliases[].AliasName", "--output", "text"], { encoding: "utf8" }).trim();
    return out ? out.split(/\s+/) : [];
  };
}

function refFrom() {
  const f = process.env.CONNECTOR_VAULT_KMS_IAM_VERIFY_REF_FILE || "supabase/.temp/project-ref";
  try { return readFileSync(f, "utf8").trim(); } catch { return ""; }
}

function main(argv) {
  if (argv.includes("selftest")) {
    const r = runSelftest();
    console.log(`SELFTEST PASS — ${r.checks} matrix-logic checks (mocks only; no AWS, no decrypt, no get-secret-value).`);
    return 0;
  }
  // LIVE — fail-closed guards; the agent/CI never reach here (they pass `selftest`).
  if (process.env.CONNECTOR_VAULT_KMS_IAM_VERIFY !== "1")
    return refuse('disabled — set CONNECTOR_VAULT_KMS_IAM_VERIFY=1 (or run `selftest`). This tool is INERT by default.');
  if (process.env.CONNECTOR_VAULT_KMS_IAM_VERIFY_CONFIRM !== CONFIRM_PHRASE)
    return refuse(`no confirmation — set CONNECTOR_VAULT_KMS_IAM_VERIFY_CONFIRM="${CONFIRM_PHRASE}".`);
  const ref = process.env.CONNECTOR_VAULT_KMS_IAM_VERIFY_REF || refFrom();
  if (ref === PRODUCTION_REF) return refuse(`production ref (${PRODUCTION_REF}) must NOT be touched.`);
  if (ref !== STAGING_REF) return refuse(`wrong/unknown project ref (expected staging ${STAGING_REF}).`);
  if (process.env.AWS_REGION && process.env.AWS_REGION !== EXPECT_REGION) return refuse(`wrong region (expected ${EXPECT_REGION}).`);
  const missing = REQUIRED_ENV.filter((k) => !process.env[k]);
  if (missing.length) return refuse(`missing required env (values never printed): ${missing.join(", ")}.`);

  const region = process.env.AWS_REGION;
  const arns = {
    task: process.env.CONNECTOR_VAULT_TASK_ROLE_ARN, exec: process.env.CONNECTOR_VAULT_EXEC_ROLE_ARN,
    web: process.env.CONNECTOR_VAULT_WEB_ROLE_ARN, cmk: process.env.CONNECTOR_VAULT_CMK_ARN,
    decoyCmk: process.env.CONNECTOR_VAULT_DECOY_CMK_ARN, dbUrlSecret: process.env.CONNECTOR_VAULT_DB_URL_SECRET_ARN,
    connectorSecret: process.env.CONNECTOR_VAULT_CONNECTOR_SECRET_ARN,
  };
  console.log("  [LIVE] connector-vault KMS/IAM separation verify (iam:SimulatePrincipalPolicy + kms:ListAliases —");
  console.log("  NO decrypt, NO get-secret-value, NO ECS, NO DB). Verdicts + metadata only; no secret values.\n");
  const result = evaluateSeparation({ arns, expectedAlias: process.env.CONNECTOR_VAULT_EXPECTED_ALIAS, simulate: liveSimulate(region), resolveAliases: liveResolveAliases(region) });
  console.log(formatMatrix(result));
  console.log("\n  KMS/IAM separation is hosted evidence only — it stores no secret and does NOT close RISK-007");
  console.log("  (audited access/use + rotation/revocation + lifecycle remain). RISK-007 OPEN; Phase C BLOCKED.");
  return result.allPass ? 0 : 1;
}

function refuse(msg) { console.log(`KMS/IAM VERIFY REFUSED: ${msg}`); return 1; }

// Only run when invoked directly (never on import by the test).
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = main(process.argv.slice(2));
}
