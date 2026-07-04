#!/usr/bin/env node
// verify-connector-vault-kms-iam-separation.mjs
//
// INERT BY DEFAULT. An allowed/denied MATRIX verifier for the hosted connector-vault KMS/IAM SEPARATION boundary
// (RISK-007 closure prerequisite, docs/49). Unlike verify-staging-kms-iam-separation-dry-run.mjs (which PRINTS a
// human runbook), this EVALUATES the boundary and returns a PASS/FAIL matrix — driven in `selftest` by MOCKED
// IAM/KMS clients (proving the matrix LOGIC, with no AWS), and in the operator-only `live` mode by real access
// EVALUATION, which decides access WITHOUT executing anything.
//
// SAFETY MODEL — by construction this never decrypts and never reads a secret value. It uses ONLY these read-only calls:
//   * KMS rows → `kms:GetKeyPolicy` (key-policy METADATA) + STRUCTURAL analysis: does the CMK key policy grant THIS
//     principal THIS action? IAM's simulator cannot faithfully evaluate a ROLE against a KMS key policy via
//     --resource-policy (it needs a concrete caller a role ARN can't imply — "Invalid caller …"), so KMS separation is
//     read from the key policy itself. NO simulate call, NO kms:Decrypt, NO kms:GenerateDataKey for KMS rows.
//   * Secrets-Manager rows → `iam:SimulatePrincipalPolicy` (identity-policy EVALUATION; no --resource-policy → no caller
//     needed). Evaluates whether the principal WOULD be allowed — it does NOT read a secret value.
//   * Alias → `kms:ListAliases` (metadata). It calls NO secretsmanager:GetSecretValue, NO ECS, and touches NO DB.
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
// Web evidence has TWO modes (docs/49):
//   A. web ROLE mode — CONNECTOR_VAULT_WEB_ROLE_ARN=arn:… → the web role is SIMULATED and must be DENIED kms:Decrypt.
//   B. NO_WEB_AWS_PRINCIPAL mode — CONNECTOR_VAULT_WEB_ROLE_ARN=NONE (exact) → the web/request runtime has no AWS
//      identity (Vercel + Supabase RLS); web rows are recorded `no_web_aws_principal` (not simulated). STRONGER evidence:
//      no principal ⇒ cannot authenticate to AWS at all. All other rows are unchanged. Only EXACTLY `NONE` triggers it.
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
//
// `noWebPrincipal` (docs/49 mode B): the v3 web/request runtime is Vercel + Supabase-RLS and has NO AWS identity by
// design — no credential, no role, no `@aws-sdk` on the request path. That is STRONGER than "a web role that is denied":
// with no principal it cannot authenticate to AWS at all, so it cannot perform ANY action. In this mode the web rows are
// NOT simulated (there is no principal to simulate); each is recorded as `no_web_aws_principal` and passes ONLY when the
// row expects "denied" (a hypothetical "allowed" web row would FAIL — absence can never satisfy an allow). This affects
// ONLY `identity === "web"` rows; task/exec/decoy/secret/alias rows are evaluated exactly as before.
export function evaluateSeparation({ arns, expectedAlias, simulate, resolveAliases, noWebPrincipal = false }) {
  const rows = SEPARATION_MATRIX.map((r) => {
    if (noWebPrincipal && r.identity === "web") {
      return { id: r.id, identity: r.identity, action: r.action, resource: r.resource, expect: r.expect, actual: "no_web_aws_principal", pass: r.expect === "denied", note: r.note };
    }
    let actual;
    try {
      actual = simulate(arns[r.identity], r.action, arns[r.resource]);
      // `overbroad` (a KMS grant via "*"/root) is preserved as a distinct verdict — it is NOT "allowed", so it fails an
      // expected-allowed row, and it never equals "denied" either. Anything else unexpected collapses to "error".
      if (actual !== "allowed" && actual !== "denied" && actual !== "overbroad") actual = "error";
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

// ── Secrets-Manager simulate argv (no AWS; unit-tested) ──────────────────────────────────────────────────────
// Build the `aws iam simulate-principal-policy` argv for a NON-KMS (Secrets Manager) row. No `--resource-policy` (that
// caused the role+resource-policy caller error for KMS), so identity-policy evaluation needs no caller. `--resource-arns`
// never receives the literal `*` (the API rejects it); a wildcard/absent resource omits the flag (defaults to `*`).
export function buildSimulateArgs(principalArn, action, resourceArn, region) {
  const isWildcard = !resourceArn || resourceArn === "*";
  const args = ["iam", "simulate-principal-policy", "--policy-source-arn", principalArn, "--action-names", action];
  if (!isWildcard) args.push("--resource-arns", resourceArn); // NEVER push "*" — omitting defaults ResourceArns to "*"
  args.push("--region", region, "--query", "EvaluationResults[0].EvalDecision", "--output", "text");
  return args;
}

// ── KMS key-policy structural analysis (no AWS; unit-tested) ─────────────────────────────────────────────────
// WHY not simulate: `iam:SimulatePrincipalPolicy` cannot faithfully evaluate a ROLE principal against a KMS key policy
// supplied via `--resource-policy` — resource-policy evaluation needs a concrete caller ("Invalid caller — Caller is not
// present and cannot be implied from policySourceArn"), which a role ARN cannot imply, and KMS authorization (key policy
// + grants + IAM) is not modeled by the IAM simulator. So KMS separation is evidenced STRUCTURALLY from the CMK key
// policy (`kms:GetKeyPolicy` — metadata, no key material, no decrypt), asserting which principals get which KMS actions.

// Boundary: this reads ONLY the CMK key policy — it does NOT enumerate KMS grants (kms:ListGrants). A grant-only decrypt
// path (not named in the key policy, no root delegation) would read "denied"; the vault CMK does not use grants for the
// runner, and a grant-based path is a separate check. (docs/49.)

// The string ARNs inside a policy Principal element ({AWS: "arn"|["arn",…]} or "*").
function principalArns(principal) {
  const out = [];
  const walk = (v) => { if (typeof v === "string") out.push(v); else if (Array.isArray(v)) v.forEach(walk); else if (v && typeof v === "object") Object.values(v).forEach(walk); };
  walk(principal);
  return out;
}
// Is a principal value account-root delegation (grants to EVERY IAM principal in the account)? AWS treats the account-root
// ARN `arn:aws:iam::<acct>:root` AND the bare 12-digit account id `<acct>` identically — both must be flagged overbroad.
const isAccountRoot = (a) => typeof a === "string" && (/:root$/.test(a) || /^\d{12}$/.test(a));
// Does a Principal element include `principalArn`? `overbroad` = it grants via `*` (any principal) or account-root (ARN or
// bare account id) — never the tight, explicit role grant the vault CMK requires. An overbroad principal is treated as
// matching every principal (so it also breaks the DENIED rows).
export function principalMatch(principal, principalArn) {
  const arns = principalArns(principal);
  const overbroad = arns.some((a) => a === "*" || isAccountRoot(a));
  return { matches: overbroad || arns.includes(principalArn), overbroad };
}
// Does an Action element cover `wanted`? AWS action matching is CASE-INSENSITIVE and treats `*` (any run) and `?` (one
// char) as wildcards ANYWHERE — so `kms:*`, `kms:Decrypt*`, `kms:*Decrypt`, and `*` all match `kms:Decrypt`. Under-matching
// an action is the dangerous (fail-open) direction, so this is a full glob, not just the trailing-`:*` case.
export function actionMatch(action, wanted) {
  const acts = Array.isArray(action) ? action : [action];
  const w = String(wanted).toLowerCase();
  return acts.some((a) => {
    if (typeof a !== "string") return false;
    const rx = new RegExp("^" + a.toLowerCase().replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".") + "$");
    return rx.test(w);
  });
}
// Structural key-policy decision for (principalArn, action): explicit Deny > explicit Allow > implicit deny. Returns
// { decision: "allow"|"deny"|"error", overbroad }. `error` = policy unparseable/empty OR carries a construct this simple
// structural model cannot safely evaluate (`NotPrincipal`/`NotAction` invert matching; `Condition` can gate an Allow/Deny)
// — treated as NON-ANALYZABLE → fail-closed (never a silent skip that could hide a broad grant on a DENIED row).
export function evaluateKeyPolicyAccess(policyJson, principalArn, action) {
  let p;
  try { p = JSON.parse(policyJson); } catch { return { decision: "error", overbroad: false }; }
  if (!p || typeof p !== "object") return { decision: "error", overbroad: false };
  const stmts = Array.isArray(p.Statement) ? p.Statement : p.Statement ? [p.Statement] : [];
  let allow = false, deny = false, overbroad = false;
  for (const s of stmts) {
    if (!s || typeof s !== "object") continue;
    if (s.NotPrincipal !== undefined || s.NotAction !== undefined || s.Condition !== undefined)
      return { decision: "error", overbroad: false }; // non-analyzable → human review, not a structural pass
    if (!actionMatch(s.Action, action)) continue;
    const pm = principalMatch(s.Principal, principalArn);
    if (!pm.matches) continue;
    if (s.Effect === "Deny") deny = true;
    else if (s.Effect === "Allow") { allow = true; overbroad = overbroad || pm.overbroad; }
  }
  return { decision: deny ? "deny" : allow ? "allow" : "deny", overbroad };
}
// Map the structural decision to a matrix verdict: "allowed" | "denied" | "overbroad" | "error". `overbroad` (allowed
// ONLY via a `*`/root principal) is deliberately NOT "allowed" — it fails an expected-allowed row, and because such a
// grant matches every principal it also flips the expected-denied rows to "overbroad" → a broadly-granting key policy
// fails separation either way. A missing/unparseable policy is "error" (fail-closed) — never a silent pass.
export function kmsAccessFromKeyPolicy(policyJson, principalArn, action) {
  if (!policyJson) return "error";
  const { decision, overbroad } = evaluateKeyPolicyAccess(policyJson, principalArn, action);
  if (decision === "error") return "error";
  if (decision === "allow") return overbroad ? "overbroad" : "allowed";
  return "denied";
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

  // 7) NO_WEB_AWS_PRINCIPAL mode: web rows are recorded as `no_web_aws_principal` and PASS by absence, WITHOUT calling
  // simulate for them. Simulate throws if ever asked about the web principal — proving web rows never reach it.
  const noWebSim = (p, act, res) => { if (p === A.web) fail("web principal must NOT be simulated in NO_WEB mode"); return correctMockSimulate(A)(p, act, res); };
  const noWeb = evaluateSeparation({ arns: A, expectedAlias: alias, simulate: noWebSim, resolveAliases: okAliases, noWebPrincipal: true });
  noWeb.allPass || fail("NO_WEB mode with an otherwise-correct policy must pass the full matrix");
  const webRow = noWeb.rows.find((r) => r.id === "web/kms:Decrypt/cmk");
  (webRow.actual === "no_web_aws_principal" && webRow.pass === true) || fail("web row must read no_web_aws_principal and PASS in NO_WEB mode");

  // 8) NO_WEB mode must NOT skip or weaken NON-web rows. With exec able to decrypt the CMK, the exec row must STILL FAIL
  // (the sentinel affects web rows only) — this is the load-bearing guard against the sentinel masking a real leak.
  const noWebExecLeak = evaluateSeparation({ arns: A, expectedAlias: alias, resolveAliases: okAliases, noWebPrincipal: true,
    simulate: (p, act, res) => (p === A.exec && act === "kms:Decrypt" && res === A.cmk) ? "allowed" : correctMockSimulate(A)(p, act, res) });
  noWebExecLeak.rows.find((r) => r.id === "exec/kms:Decrypt/cmk").pass === false || fail("NO_WEB mode must NOT skip the exec decrypt check — exec leak must still FAIL");
  noWebExecLeak.allPass === false || fail("NO_WEB mode must still fail overall when a non-web row leaks");

  // 9) Secrets-Manager simulate builder NEVER emits `--resource-arns "*"` and NEVER a `--resource-policy` (the caller error).
  const noStar = (args) => { const i = args.indexOf("--resource-arns"); return i === -1 || args[i + 1] !== "*"; };
  const wild = buildSimulateArgs(A.task, "secretsmanager:GetSecretValue", "*", "ca-central-1");
  (noStar(wild) && !wild.includes("--resource-arns")) || fail("a wildcard resource must OMIT --resource-arns (never send the literal '*')");
  (noStar(buildSimulateArgs(A.task, "secretsmanager:GetSecretValue", undefined, "ca-central-1")) && !buildSimulateArgs(A.task, "s", undefined, "r").includes("--resource-arns")) || fail("an absent resource must OMIT --resource-arns");
  const real = buildSimulateArgs(A.exec, "secretsmanager:GetSecretValue", A.connectorSecret, "ca-central-1");
  (real[real.indexOf("--resource-arns") + 1] === A.connectorSecret && noStar(real) && !real.includes("--resource-policy")) || fail("a real ARN must be passed via --resource-arns; no --resource-policy");

  // 10) KMS separation is decided STRUCTURALLY from the key policy — the load-bearing checks:
  const vault = JSON.stringify({ Statement: [{ Effect: "Allow", Principal: { AWS: A.task }, Action: ["kms:Decrypt", "kms:GenerateDataKey"], Resource: "*" }] });
  kmsAccessFromKeyPolicy(vault, A.task, "kms:Decrypt") === "allowed" || fail("task must be ALLOWED vault decrypt by the key policy");
  kmsAccessFromKeyPolicy(vault, A.task, "kms:GenerateDataKey") === "allowed" || fail("task must be ALLOWED vault generateDataKey");
  kmsAccessFromKeyPolicy(vault, A.exec, "kms:Decrypt") === "denied" || fail("exec must be DENIED vault decrypt (not in the key policy)");
  kmsAccessFromKeyPolicy(JSON.stringify({ Statement: [{ Effect: "Allow", Principal: { AWS: A.exec }, Action: "kms:*", Resource: "*" }] }), A.task, "kms:Decrypt") === "denied" || fail("decoy that grants only exec must DENY task");
  // overbroad (star/root) grant is NOT a clean allow, and it also flips a denied principal → both fail separation:
  const broad = JSON.stringify({ Statement: [{ Effect: "Allow", Principal: { AWS: "*" }, Action: "kms:Decrypt", Resource: "*" }] });
  kmsAccessFromKeyPolicy(broad, A.task, "kms:Decrypt") === "overbroad" || fail("a `*`-principal grant must read `overbroad`, not `allowed`");
  kmsAccessFromKeyPolicy(broad, A.exec, "kms:Decrypt") === "overbroad" || fail("a `*`-principal grant must also flag the exec principal");
  // explicit Deny wins; a missing/unparseable policy is fail-closed `error` (NEVER a silent pass):
  kmsAccessFromKeyPolicy(JSON.stringify({ Statement: [{ Effect: "Allow", Principal: { AWS: A.task }, Action: "kms:*", Resource: "*" }, { Effect: "Deny", Principal: { AWS: A.task }, Action: "kms:Decrypt", Resource: "*" }] }), A.task, "kms:Decrypt") === "denied" || fail("explicit Deny must win over Allow");
  (kmsAccessFromKeyPolicy("", A.task, "kms:Decrypt") === "error" && kmsAccessFromKeyPolicy("not json", A.task, "kms:Decrypt") === "error") || fail("a missing/unparseable key policy must be `error` (fail-closed)");

  // 11) fail-OPEN guards: bare-account-id root == overbroad; partial action wildcard matches; NotPrincipal/NotAction/Condition → error.
  kmsAccessFromKeyPolicy(JSON.stringify({ Statement: [{ Effect: "Allow", Principal: { AWS: "123456789012" }, Action: "kms:Decrypt", Resource: "*" }] }), A.exec, "kms:Decrypt") === "overbroad" || fail("a bare account-id principal must be overbroad (root-equivalent)");
  kmsAccessFromKeyPolicy(JSON.stringify({ Statement: [{ Effect: "Allow", Principal: { AWS: A.exec }, Action: "kms:Decrypt*", Resource: "*" }] }), A.exec, "kms:Decrypt") === "allowed" || fail("a partial action wildcard (kms:Decrypt*) must match kms:Decrypt");
  kmsAccessFromKeyPolicy(JSON.stringify({ Statement: [{ Effect: "Allow", NotPrincipal: { AWS: A.exec }, Action: "kms:Decrypt", Resource: "*" }] }), A.exec, "kms:Decrypt") === "error" || fail("NotPrincipal must be non-analyzable → error (fail-closed)");
  kmsAccessFromKeyPolicy(JSON.stringify({ Statement: [{ Effect: "Deny", Principal: { AWS: A.task }, Action: "kms:Decrypt", Resource: "*", Condition: { Bool: {} } }] }), A.task, "kms:Decrypt") === "error" || fail("a Condition must be non-analyzable → error (fail-closed)");

  return { ok: true, checks: 11 };
}

// ── live decide/alias via the AWS CLI (OPERATOR-ONLY; never called by selftest/CI) ────────────────────────────
// KMS rows → STRUCTURAL key-policy analysis (kms:GetKeyPolicy metadata → evaluateKeyPolicyAccess): no simulate, no
// --resource-policy, no caller — sidesteps the role+resource-policy caller error and models KMS access from the policy.
// Secrets-Manager rows → iam:SimulatePrincipalPolicy identity evaluation (no --resource-policy → no caller needed).
// NONE of these perform an action: no kms:Decrypt, no kms:GenerateDataKey, no secretsmanager:GetSecretValue, no ECS.
function liveDecide(region) {
  // Cache the CMK key policy (a RESOURCE-based policy — metadata, NOT key material). kms:GetKeyPolicy decrypts nothing.
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
    if (action.startsWith("kms:")) {
      // Structural: does the CMK key policy grant THIS principal THIS action? → allowed | denied | overbroad | error.
      return kmsAccessFromKeyPolicy(keyPolicy(resourceArn), principalArn, action);
    }
    // Secrets Manager: iam:SimulatePrincipalPolicy EVALUATES access — performs NO action, reads NO secret value.
    const out = execFileSync("aws", buildSimulateArgs(principalArn, action, resourceArn, region), { encoding: "utf8" }).trim();
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
  // Mode B (docs/49): the EXACT sentinel `NONE` asserts there is no web/request AWS principal → the web ARN is not
  // required (there is none to supply). Anything else — unset, empty, a typo like "none"/"None ", or a real ARN — is NOT
  // the sentinel, so the web ARN stays required (unset/empty → refuse) or is simulated live (a bogus value → error → FAIL).
  const noWebPrincipal = process.env.CONNECTOR_VAULT_WEB_ROLE_ARN === "NONE";
  const required = noWebPrincipal ? REQUIRED_ENV.filter((k) => k !== "CONNECTOR_VAULT_WEB_ROLE_ARN") : REQUIRED_ENV;
  const missing = required.filter((k) => !process.env[k]);
  if (missing.length) return refuse(`missing required env (values never printed): ${missing.join(", ")}.`);

  const region = process.env.AWS_REGION;
  const arns = {
    task: process.env.CONNECTOR_VAULT_TASK_ROLE_ARN, exec: process.env.CONNECTOR_VAULT_EXEC_ROLE_ARN,
    web: process.env.CONNECTOR_VAULT_WEB_ROLE_ARN, cmk: process.env.CONNECTOR_VAULT_CMK_ARN,
    decoyCmk: process.env.CONNECTOR_VAULT_DECOY_CMK_ARN, dbUrlSecret: process.env.CONNECTOR_VAULT_DB_URL_SECRET_ARN,
    connectorSecret: process.env.CONNECTOR_VAULT_CONNECTOR_SECRET_ARN,
  };
  console.log("  [LIVE] connector-vault KMS/IAM separation verify — KMS rows via kms:GetKeyPolicy structural analysis,");
  console.log("  Secrets-Manager rows via iam:SimulatePrincipalPolicy, alias via kms:ListAliases. NO decrypt, NO");
  console.log("  generateDataKey, NO get-secret-value, NO ECS, NO DB. Verdicts + metadata only; no secret values.");
  if (noWebPrincipal) {
    console.log("  [web] NO_WEB_AWS_PRINCIPAL mode: the web/request runtime has NO AWS identity (Vercel + Supabase RLS).");
    console.log("        web rows are recorded by ABSENCE (not simulated). Evidence anchors: (1) IAM role list shows no");
    console.log("        web/request role; (2) check-app-runtime-imports.sh bars @aws-sdk/client-kms & Secrets-Manager");
    console.log("        GetSecretValue on the request path in CI; (3) the request-path token source hard-throws. docs/49.");
  }
  console.log("");
  const result = evaluateSeparation({ arns, expectedAlias: process.env.CONNECTOR_VAULT_EXPECTED_ALIAS, simulate: liveDecide(region), resolveAliases: liveResolveAliases(region), noWebPrincipal });
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
