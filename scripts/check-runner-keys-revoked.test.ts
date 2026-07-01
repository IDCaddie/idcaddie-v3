import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

// Static analysis of the operator-run dead-key verifier. The allow/deny lists live HERE (in the test), so scanning the
// script for forbidden strings can never self-match.
const SRC = fs.readFileSync(path.resolve(__dirname, "check-runner-keys-revoked.sh"), "utf8");
const CODE_LINES = SRC.split("\n").filter((l) => !/^\s*#/.test(l));
const code = CODE_LINES.join("\n");

// the ONLY aws actions allowed, both read-only: a live identity probe (expected to FAIL on a revoked key) and the
// LOCAL profile-name enumeration (reads ~/.aws only — no network, no secrets). No mutation, no crypto.
const ALLOWED = new Set(["sts get-caller-identity", "configure list-profiles"]);
// the captured sts output may contain an ARN on an (unexpected) success — must never reach an output statement
const SECRET_VARS = ["sts_out"];

describe("runner temp-key revocation — operator-only, read-only, fail-closed (static analysis)", () => {
  it("invokes only `sts get-caller-identity` (deny-by-default; no IAM/KMS/Secrets-Manager/key mutation)", () => {
    // skip any leading `--flag value` pairs, then capture <service> <action>
    const awsCalls = [...code.matchAll(/aws\s+(?:--\S+\s+(?:"[^"]*"|'[^']*'|\S+)\s+)*([a-z][a-z0-9-]*)\s+([a-z][a-z0-9-]*)/g)].map((m) => `${m[1]} ${m[2]}`);
    expect(awsCalls.length, "expected the script to invoke an aws action").toBeGreaterThan(0);
    expect(awsCalls.filter((p) => !ALLOWED.has(p)), `non-allowlisted aws actions: ${[...new Set(awsCalls)].join(", ")}`).toEqual([]);
  });

  it("does not create/delete/deactivate any key, nor call IAM/KMS/Secrets-Manager mutations, crypto, deploy, or Postgres", () => {
    const forbidden = [
      "create-access-key", "delete-access-key", "update-access-key", "create-user", "delete-user",
      "put-user-policy", "attach-user-policy", "detach-user-policy", "create-policy", "simulate-principal-policy", "iam get-user",
      "kms decrypt", "kms encrypt", "generate-data-key", "re-encrypt", "kms describe-key", "create-key", "put-key-policy", "create-grant", "schedule-key-deletion",
      "get-secret-value", "put-secret-value", "create-secret", "update-secret", "delete-secret", "describe-secret",
      "ecs run-task", "ecs start-task", "execute-command", "register-task-definition", "update-service",
      "cloudformation deploy", "create-stack", "terraform apply", "cdk deploy", "docker push", "kubectl apply",
      "psql ", "supabase db", "DATABASE_URL", "PGPASSWORD",
    ];
    for (const f of forbidden) expect(code.includes(f), `forbidden command/string present: ${f}`).toBe(false);
  });

  it("the revoked-key signal is ONLY a deleted/deactivated-key class (no AccessDenied/SignatureDoesNotMatch/ExpiredToken false-PASS)", () => {
    // a deleted/deactivated IAM-user key returns InvalidClientTokenId/UnrecognizedClientException on sts (no permission
    // needed). AccessDenied/SignatureDoesNotMatch/ExpiredToken come from a STILL-LIVE key → must not be treated as dead.
    const m = code.match(/grep -oE '([^']*ClientToken[^']*)'/);
    expect(m, "expected a dead-key error-class grep").not.toBeNull();
    const classes = (m![1]).split("|");
    expect(classes.sort()).toEqual(["InvalidClientTokenId", "UnrecognizedClientException"]);
    for (const live of ["AccessDenied", "SignatureDoesNotMatch", "ExpiredToken"]) expect(m![1]).not.toContain(live);
  });

  it("supports the two valid states — live dead-key probe AND local_profiles_removed (via `aws configure list-profiles`)", () => {
    expect(code, "must enumerate local profiles read-only").toContain("aws configure list-profiles");
    expect(code, "STATE 2 marker for the removed-profiles case").toContain("local_profiles_removed");
    // the local-removed state must NOT claim AWS-side deletion is proven by this run (honest framing)
    expect(code).toMatch(/local profile REMOVED[^\n]*NOT proven or confirmed by this run/);
    // still-live guard preserved: a present profile that succeeds sts is FAIL (STILL WORKS), never PASS
    expect(code).toMatch(/STILL WORKS/);
  });

  it("never dumps raw JSON and never prints the captured sts output (ARN/account/key material)", () => {
    expect(code).not.toContain("--output json");
    const calls = code.split(/aws /).slice(1);
    for (const c of calls) {
      const head = c.split("\n").slice(0, 2).join("\n");
      if (/--output/.test(head)) expect(head, `aws call must use --query: ${head.split("\n")[0].trim()}`).toMatch(/--query/);
    }
    // a stdout-printer segment must not reference the captured output. Covers `_row/echo/cat/tee/logger` (optionally
    // behind a leading `(` subshell or `{`), a non-piped `printf`, AND a sink reached through a pipe (`… | tee/cat/logger`).
    const segments = code.split(/\n|&&|\|\||;/).map((s) => s.trim());
    for (const seg of segments) {
      const printsToStdout =
        /^[({]*\s*(_row|echo|cat|tee|logger)\b/.test(seg) ||
        (/^[({]*\s*printf\b/.test(seg) && !seg.includes("|")) ||
        /\|\s*(tee|cat|logger)\b/.test(seg);
      if (printsToStdout) for (const v of SECRET_VARS) expect(seg.includes(`$${v}`) || seg.includes(`\${${v}`), `captured output ${v} may reach stdout: ${seg}`).toBe(false);
    }
  });

  it("is fail-closed + opt-in + production-guarded, and embeds no real account / token / secret", () => {
    expect(code).toContain("ID_CADDIE_RUNNER_KEYS_REVOKED");
    expect(code).toContain("check_guards");
    expect(code).toContain("dzbfxulvxchdemcettrx"); // production ref hard-abort
    expect(code.replace(/\b0{12}\b/g, "PLACEHOLDER")).not.toMatch(/\b\d{12}\b/); // no real 12-digit account
    for (const bad of ["xoxb-", "xapp-", "AKIA", "sb_secret_", "BEGIN PRIVATE KEY"]) expect(SRC).not.toContain(bad);
    expect(SRC).not.toMatch(/postgres(ql)?:\/\/[^:@/]+:[^@/]{6,}@/);
  });
});
