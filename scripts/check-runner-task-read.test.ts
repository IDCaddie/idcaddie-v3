import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

// Static analysis of the operator-run task-read READINESS harness. The allow/deny lists live HERE (in the test), so
// scanning the script for forbidden strings can never self-match.
const SRC = fs.readFileSync(path.resolve(__dirname, "check-runner-task-read.sh"), "utf8");
const CODE_LINES = SRC.split("\n").filter((l) => !/^\s*#/.test(l));
const code = CODE_LINES.join("\n");

// the ONLY aws actions allowed, all read-only: identity + metadata + IAM simulation. NO get-secret-value.
const ALLOWED = new Set(["sts get-caller-identity", "secretsmanager describe-secret", "iam simulate-principal-policy"]);
// captured identifiers (resource / principal ARNs) must never reach a stdout printer
const SECRET_VARS = ["arn", "role_arn", "decoy_arn", "prod_arn", "live_acct"];

describe("runner task-read readiness — operator-only, metadata+simulate only, fail-closed (static analysis)", () => {
  it("invokes only sts + secretsmanager describe-secret + iam simulate-principal-policy (deny-by-default; NO get-secret-value)", () => {
    const awsCalls = [...code.matchAll(/\b_?aws\s+([a-z][a-z0-9-]*)\s+([a-z][a-z0-9-]*)/g)].map((m) => `${m[1]} ${m[2]}`);
    expect(awsCalls.length, "expected the script to invoke aws actions").toBeGreaterThan(0);
    expect(awsCalls.filter((p) => !ALLOWED.has(p)), `non-allowlisted aws actions: ${[...new Set(awsCalls)].join(", ")}`).toEqual([]);
    expect(awsCalls).toContain("iam simulate-principal-policy");
    // the IAM ACTION NAME `secretsmanager:GetSecretValue` (for simulation) is allowed; an INVOCATION of get-secret-value is not
    expect(/\b_?aws\s+secretsmanager\s+get-secret-value/.test(code), "must never INVOKE get-secret-value").toBe(false);
  });

  it("NEVER invokes value-read / secret-write / KMS crypto / deploy / IAM-mutation / Postgres", () => {
    const forbidden = [
      "put-secret-value", "create-secret", "update-secret", "delete-secret",
      "kms decrypt", "kms encrypt", "generate-data-key", "put-key-policy", "create-grant",
      "create-access-key", "delete-access-key", "put-user-policy", "attach-user-policy",
      "ecs run-task", "ecs start-task", "register-task-definition", "cloudformation deploy", "terraform apply", "cdk deploy",
      "SecretString", "SecretBinary", "psql ", "supabase db", "DATABASE_URL", "PGPASSWORD",
    ];
    for (const f of forbidden) expect(code.includes(f), `forbidden command/string present: ${f}`).toBe(false);
  });

  it("never dumps raw JSON and never prints captured identifiers (ARN/account/role)", () => {
    expect(code).not.toContain("--output json");
    const calls = code.split(/_aws /).slice(1);
    for (const c of calls) {
      const head = c.split("\n").slice(0, 2).join("\n");
      if (/--output/.test(head)) expect(head, `aws call must use --query: ${head.split("\n")[0].trim()}`).toMatch(/--query/);
    }
    const segments = code.split(/\n|&&|\|\||;/).map((s) => s.trim());
    for (const seg of segments) {
      const s = seg.replace(/^(then|else|elif|do)\b\s*/, "");
      const printsToStdout = /^[({]*\s*(_row|echo|cat|tee|logger)\b/.test(s) || (/^[({]*\s*printf\b/.test(s) && !s.includes("|"));
      if (printsToStdout) for (const v of SECRET_VARS) expect(s.includes(`$${v}`) || s.includes(`\${${v}`), `captured var ${v} may reach stdout: ${seg}`).toBe(false);
    }
  });

  it("is fail-closed + opt-in + production-guarded, and embeds no real account / token / secret", () => {
    expect(code).toContain("ID_CADDIE_RUNNER_TASK_READ");
    expect(code).toContain("check_guards");
    expect(code).toContain("dzbfxulvxchdemcettrx"); // production ref hard-abort
    expect(code).toContain("/idcaddie/staging/slack/oauth-client-secret"); // the pinned staging secret name
    expect(code.replace(/\b0{12}\b/g, "PLACEHOLDER")).not.toMatch(/\b\d{12}\b/); // no real 12-digit account
    for (const bad of ["xoxb-", "xapp-", "AKIA", "sb_secret_", "BEGIN PRIVATE KEY"]) expect(SRC).not.toContain(bad);
    expect(SRC).not.toMatch(/postgres(ql)?:\/\/[^:@/]+:[^@/]{6,}@/);
  });
});
