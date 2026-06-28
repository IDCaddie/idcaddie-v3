import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

// Static analysis of the operator-run KMS round-trip script. The allow/deny lists live HERE (in the test), so scanning
// the script for forbidden strings can never self-match.
const SRC = fs.readFileSync(path.resolve(__dirname, "check-runner-kms-roundtrip.sh"), "utf8");
const CODE_LINES = SRC.split("\n").filter((l) => !/^\s*#/.test(l)); // drop full-line comments
const code = CODE_LINES.join("\n");

// the ONLY aws actions allowed, bound to the identity that is permitted to call them. The runner is least-privilege —
// GenerateDataKey + Decrypt only, NO DescribeKey/Encrypt (doc 42 §91.4) — so the canonical-key check derives from the
// GenerateDataKey KeyId, not a runner describe-key (which would be AccessDenied at runtime).
const RUNNER_ALLOWED = new Set(["sts get-caller-identity", "kms generate-data-key", "kms decrypt"]);
const WEB_ALLOWED = new Set(["kms decrypt"]); // web only attempts the (denied) decrypt — the negative test
// shell vars that hold key material or an account-bearing ARN — must never reach an output statement
const SECRET_VARS = ["pt_b64", "ct_b64", "recovered", "gdk", "web_err", "keyid"];

describe("runner KMS round-trip — operator-only, synthetic, fail-closed (static analysis)", () => {
  it("invokes only the policy-allowed actions, bound to the correct identity (no runner DescribeKey/Encrypt)", () => {
    const runnerPairs = [...code.matchAll(/_runner\s+([a-z][a-z0-9-]*)\s+([a-z][a-z0-9-]*)/g)].map((m) => `${m[1]} ${m[2]}`);
    const webPairs = [...code.matchAll(/_web\s+([a-z][a-z0-9-]*)\s+([a-z][a-z0-9-]*)/g)].map((m) => `${m[1]} ${m[2]}`);
    expect(runnerPairs.length).toBeGreaterThan(0);
    expect(runnerPairs.filter((p) => !RUNNER_ALLOWED.has(p)), "runner must invoke only sts/generate-data-key/decrypt (no DescribeKey/Encrypt)").toEqual([]);
    expect(webPairs.filter((p) => !WEB_ALLOWED.has(p)), "web must invoke only the (denied) kms decrypt").toEqual([]);
    // the round-trip exists (GenerateDataKey + Decrypt) and Encrypt is never invoked
    const all = [...runnerPairs, ...webPairs];
    expect(all).toContain("kms generate-data-key");
    expect(all).toContain("kms decrypt");
    expect(all).not.toContain("kms encrypt");
    expect(all).not.toContain("kms describe-key"); // runner can't DescribeKey — canonical check uses the GenerateDataKey KeyId
  });

  it("invokes none of the forbidden crypto / secret-read / deploy / IAM-KMS-mutation / Postgres commands", () => {
    const forbidden = [
      "kms encrypt", "re-encrypt", "create-key", "put-key-policy", "create-grant", "schedule-key-deletion",
      "get-secret-value", "put-secret-value", "create-secret", "update-secret", "delete-secret",
      "ecs run-task", "ecs start-task", "execute-command", "register-task-definition",
      "create-user", "create-policy", "put-user-policy", "attach-user-policy", "create-access-key", "simulate-principal-policy",
      "cloudformation deploy", "create-stack", "update-stack", "terraform apply", "cdk deploy", "docker push", "kubectl apply",
      "psql ", "supabase db", "DATABASE_URL", "PGPASSWORD",
    ];
    for (const f of forbidden) expect(code.includes(f), `forbidden command/string present: ${f}`).toBe(false);
  });

  it("uses AES_256 key-spec and never dumps raw JSON / whole responses", () => {
    expect(code).toContain("AES_256");
    expect(code).not.toContain("--output json");
    // every output-producing aws call scopes its output with --query
    const calls = code.split(/_(?:runner|web) /).slice(1);
    for (const c of calls) {
      const head = c.split("\n").slice(0, 2).join("\n");
      if (/--output/.test(head)) expect(head, `aws call must use --query: ${head.split("\n")[0].trim()}`).toMatch(/--query/);
    }
  });

  it("never prints key material — secret vars never reach a stdout printer (_row / echo / bare printf)", () => {
    // split into command segments; a key-material var in a guard `[ -n "$pt_b64" ]` or piped feed `printf … | base64`
    // is safe — only flag a var inside a segment that STARTS with a stdout printer (_row/echo, or a printf not piped).
    const segments = code.split(/\n|&&|\|\||;/).map((s) => s.trim());
    for (const seg of segments) {
      const printsToStdout = /^\{?\s*(_row|echo|cat|tee|logger)\b/.test(seg) || (/^\{?\s*printf\b/.test(seg) && !seg.includes("|"));
      if (printsToStdout)
        for (const v of SECRET_VARS)
          expect(seg.includes(`$${v}`) || seg.includes(`\${${v}`), `key-material var ${v} may reach stdout: ${seg}`).toBe(false);
    }
  });

  it("is fail-closed + opt-in + production-guarded, and embeds no real account / token / secret", () => {
    expect(code).toContain("ID_CADDIE_RUNNER_KMS_ROUNDTRIP"); // distinct opt-in
    expect(code).toContain("check_guards");
    expect(code).toContain("dzbfxulvxchdemcettrx"); // production ref hard-abort
    expect(code).toContain("ID_CADDIE_RUNNER_KMS_ROUNDTRIP_EXPECTED_ACCOUNT"); // account passed via env
    expect(code.replace(/\b0{12}\b/g, "PLACEHOLDER")).not.toMatch(/\b\d{12}\b/); // no real 12-digit account (zeros = selftest placeholder)
    for (const bad of ["xoxb-", "xapp-", "AKIA", "sb_secret_", "BEGIN PRIVATE KEY"]) expect(SRC).not.toContain(bad);
    expect(SRC).not.toMatch(/postgres(ql)?:\/\/[^:@/]+:[^@/]{6,}@/);
  });
});
