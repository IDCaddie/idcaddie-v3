import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

// Static analysis of the metadata-only Secrets Manager verifier. The allow/deny lists live HERE (in the test), so
// scanning the script for forbidden strings can never self-match.
const SRC = fs.readFileSync(path.resolve(__dirname, "check-runner-secret-metadata.sh"), "utf8");
const CODE_LINES = SRC.split("\n").filter((l) => !/^\s*#/.test(l));
const code = CODE_LINES.join("\n");

// the ONLY aws actions allowed, both read-only metadata/identity — NO get-secret-value.
const ALLOWED = new Set(["sts get-caller-identity", "secretsmanager describe-secret"]);
// vars that could hold metadata identifiers must never reach a stdout printer (defense-in-depth; describe-secret never
// returns the value, but the raw ARN / KMS id are captured to vars and reported only as match booleans).
const SECRET_VARS = ["arn", "kms", "name", "live_acct"];

describe("runner secret metadata — operator-only, read-only, metadata-only, fail-closed (static analysis)", () => {
  it("invokes only read-only sts + secretsmanager describe-secret (deny-by-default; NO get-secret-value)", () => {
    // match BOTH the `_aws` wrapper and any bare `aws` invocation (so a non-wrapper call can't evade the allowlist)
    const awsCalls = [...code.matchAll(/\b_?aws\s+([a-z][a-z0-9-]*)\s+([a-z][a-z0-9-]*)/g)].map((m) => `${m[1]} ${m[2]}`);
    expect(awsCalls.length, "expected the script to invoke aws actions").toBeGreaterThan(0);
    expect(awsCalls.filter((p) => !ALLOWED.has(p)), `non-allowlisted aws actions: ${[...new Set(awsCalls)].join(", ")}`).toEqual([]);
    expect(awsCalls).toContain("secretsmanager describe-secret");
    expect(awsCalls).not.toContain("secretsmanager get-secret-value");
  });

  it("NEVER invokes get-secret-value / value-read / secret-write / KMS crypto / deploy / IAM-mutation / Postgres", () => {
    // the invocation form (bare or wrapped); comments/messages may mention `get-secret-value` as the thing that is forbidden.
    expect(/\b_?aws\s+secretsmanager\s+get-secret-value/.test(code), "must never invoke get-secret-value").toBe(false);
    const forbidden = [
      "put-secret-value", "create-secret", "update-secret", "delete-secret", "restore-secret", "rotate-secret", "tag-resource",
      "kms decrypt", "kms encrypt", "generate-data-key", "re-encrypt", "put-key-policy", "create-grant",
      "create-access-key", "delete-access-key", "put-user-policy", "attach-user-policy", "simulate-principal-policy",
      "ecs run-task", "ecs start-task", "register-task-definition", "update-service",
      "cloudformation deploy", "terraform apply", "cdk deploy", "docker push", "kubectl apply",
      "SecretString", "SecretBinary", "psql ", "supabase db", "DATABASE_URL", "PGPASSWORD",
    ];
    for (const f of forbidden) expect(code.includes(f), `forbidden command/string present: ${f}`).toBe(false);
  });

  it("never dumps raw JSON and never prints captured metadata identifiers (ARN/KMS id/account)", () => {
    expect(code).not.toContain("--output json");
    const calls = code.split(/_aws /).slice(1);
    for (const c of calls) {
      const head = c.split("\n").slice(0, 2).join("\n");
      if (/--output/.test(head)) expect(head, `aws call must use --query: ${head.split("\n")[0].trim()}`).toMatch(/--query/);
    }
    const segments = code.split(/\n|&&|\|\||;/).map((s) => s.trim());
    for (const seg of segments) {
      // strip a leading control-flow keyword so `then _row …` / `else _row …` / `do echo …` are also treated as printers
      const s = seg.replace(/^(then|else|elif|do)\b\s*/, "");
      const printsToStdout = /^[({]*\s*(_row|echo|cat|tee|logger)\b/.test(s) || (/^[({]*\s*printf\b/.test(s) && !s.includes("|"));
      if (printsToStdout) for (const v of SECRET_VARS) expect(s.includes(`$${v}`) || s.includes(`\${${v}`), `captured metadata var ${v} may reach stdout: ${seg}`).toBe(false);
    }
  });

  it("is fail-closed + opt-in + production-guarded, and embeds no real account / token / secret", () => {
    expect(code).toContain("ID_CADDIE_RUNNER_SECRET_METADATA");
    expect(code).toContain("check_guards");
    expect(code).toContain("dzbfxulvxchdemcettrx"); // production ref hard-abort
    expect(code).toContain("/idcaddie/staging/slack/oauth-client-secret"); // the pinned staging secret name
    expect(code.replace(/\b0{12}\b/g, "PLACEHOLDER")).not.toMatch(/\b\d{12}\b/); // no real 12-digit account
    for (const bad of ["xoxb-", "xapp-", "AKIA", "sb_secret_", "BEGIN PRIVATE KEY"]) expect(SRC).not.toContain(bad);
    expect(SRC).not.toMatch(/postgres(ql)?:\/\/[^:@/]+:[^@/]{6,}@/);
  });
});
