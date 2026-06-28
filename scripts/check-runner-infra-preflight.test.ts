import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

// Static analysis of the read-only preflight script. The deny/allow lists live HERE (in the test), so scanning the
// script for forbidden strings can never self-match.
const SRC = fs.readFileSync(path.resolve(__dirname, "check-runner-infra-preflight.sh"), "utf8");
const CODE_LINES = SRC.split("\n").filter((l) => !/^\s*#/.test(l)); // drop full-line comments (which use CamelCase API names)
const code = CODE_LINES.join("\n");

// the ONLY aws service+action pairs the preflight may invoke — all read-only describe/get/simulate
const ALLOWED = new Set([
  "sts get-caller-identity",
  "kms describe-key", "kms list-aliases",
  "iam get-user", "iam get-user-policy", "iam simulate-principal-policy",
  "secretsmanager describe-secret",
  "ec2 describe-instances",
]);

describe("runner infra preflight — read-only, fail-closed (static analysis)", () => {
  it("every aws invocation is an allowlisted read-only action (deny-by-default)", () => {
    // matches `aws <svc> <action>` and the `_aws <svc> <action>` wrapper calls; skips the `aws --profile …` wrapper def
    const pairs = [...code.matchAll(/(?:^|[\s;&|(])_?aws\s+([a-z0-9][a-z0-9-]*)\s+([a-z0-9][a-z0-9-]*)/g)].map((m) => `${m[1]} ${m[2]}`);
    expect(pairs.length, "expected the script to invoke some aws actions").toBeGreaterThan(0);
    const offenders = pairs.filter((p) => !ALLOWED.has(p));
    expect(offenders, `non-allowlisted aws actions invoked: ${[...new Set(offenders)].join(", ")}`).toEqual([]);
  });

  it("invokes none of the forbidden crypto / secret-read / deploy / mutation commands", () => {
    const forbidden = [
      "get-secret-value", "put-secret-value", "create-secret", "update-secret",
      "kms decrypt", "kms encrypt", "generate-data-key", "re-encrypt", "create-key", "put-key-policy",
      "create-user", "create-policy", "put-user-policy", "attach-user-policy", "create-access-key", "update-user",
      "ecs run-task", "ecs start-task", "register-task-definition", "update-service",
      "cloudformation deploy", "create-stack", "update-stack", "get-login-password",
      "terraform apply", "cdk deploy", "pulumi up", "sam deploy", "docker push", "kubectl apply", "helm install", "helm upgrade",
      "psql ", "supabase db", "DATABASE_URL", "PGPASSWORD",
    ];
    for (const f of forbidden) expect(code.includes(f), `forbidden command/string present: ${f}`).toBe(false);
  });

  it("every output-producing aws call pulls a specific safe field with --query, never a raw JSON dump", () => {
    expect(code).not.toContain("--output json");
    // split on each `_aws ` call start; take the call + one continuation line (the simulate call spans two lines).
    // any call that produces output (--output) MUST scope it with --query — no whole-object dump can leak.
    const calls = code.split(/_aws /).slice(1);
    for (const c of calls) {
      const head = c.split("\n").slice(0, 2).join("\n");
      if (/--output/.test(head)) expect(head, `aws call must use --query: _aws ${head.split("\n")[0].trim()}`).toMatch(/--query/);
    }
  });

  it("is fail-closed + opt-in + production-guarded, and embeds no 12-digit account literal", () => {
    expect(code).toContain('ID_CADDIE_RUNNER_PREFLIGHT'); // opt-in
    expect(code).toContain("check_guards"); // guards run before any live call
    expect(code).toContain("dzbfxulvxchdemcettrx"); // production ref hard-abort
    expect(code).toMatch(/ID_CADDIE_RUNNER_PREFLIGHT_EXPECTED_ACCOUNT/); // account passed explicitly, not embedded
    // no REAL 12-digit account id baked into the script body (the account stays in env/docs). The all-zeros value is a
    // synthetic selftest placeholder (the guard requires a 12-digit shape), excused here.
    expect(code.replace(/\b0{12}\b/g, "PLACEHOLDER")).not.toMatch(/\b\d{12}\b/);
  });

  it("carries no real token/secret shapes", () => {
    for (const bad of ["xoxb-", "xapp-", "AKIA", "sb_secret_", "BEGIN PRIVATE KEY"]) expect(SRC).not.toContain(bad);
    expect(SRC).not.toMatch(/postgres(ql)?:\/\/[^:@/]+:[^@/]{6,}@/);
  });
});
