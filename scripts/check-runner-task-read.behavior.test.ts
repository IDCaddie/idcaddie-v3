import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Behavioral test: run the real check-runner-task-read.sh with a stubbed `aws` on PATH that returns synthetic
// describe-secret metadata + simulate-principal-policy decisions, and assert run_checks. The stub records every aws
// subcommand so we can prove get-secret-value is NEVER invoked. No real AWS, no network, no secret value.
const REPO = path.resolve(__dirname, "..");
const SCRIPT = path.join(REPO, "scripts", "check-runner-task-read.sh");
let binDir: string;
let callLog: string;

const FAKE_AWS = `#!/usr/bin/env bash
echo "$*" >> "$KR_CALLLOG"
while [ "\${1:-}" = "--profile" ] || [ "\${1:-}" = "--region" ]; do shift 2; done
if [ "$1" = sts ]; then echo 000000000000; exit 0; fi
if [ "$1" = secretsmanager ] && [ "$2" = get-secret-value ]; then echo "FORBIDDEN get-secret-value" >&2; exit 99; fi
if [ "$1" = secretsmanager ] && [ "$2" = describe-secret ]; then
  case "\${KR_SCENARIO:-}" in
    missing) echo "An error occurred (ResourceNotFoundException)" >&2; exit 254 ;;
    *) echo "arn:aws:secretsmanager:ca-central-1:000000000000:secret:/idcaddie/staging/slack/oauth-client-secret-AbCdEf" ;;
  esac
  exit 0
fi
if [ "$1" = iam ] && [ "$2" = simulate-principal-policy ]; then
  case "$*" in
    *decoy*) [ "\${KR_SCENARIO:-}" = leaky ] && echo allowed || echo implicitDeny ;;
    *) [ "\${KR_SCENARIO:-}" = notallowed ] && echo implicitDeny || echo allowed ;;
  esac
  exit 0
fi
echo "unexpected aws call: $*" >&2; exit 42
`;

function run(scenario: string): { out: string; code: number } {
  const env = {
    ...process.env, PATH: `${binDir}:${process.env.PATH}`, KR_SCENARIO: scenario, KR_CALLLOG: callLog,
    ID_CADDIE_RUNNER_TASK_READ: "1", AWS_PROFILE: "p", AWS_REGION: "ca-central-1",
    ID_CADDIE_RUNNER_TASK_READ_EXPECTED_ACCOUNT: "000000000000", ID_CADDIE_RUNNER_TASK_READ_ENV: "staging",
    RUNNER_TASK_READ_PROJECT_REF: "ycdpzduxugdsffjqyoai",
  };
  try {
    return { out: execFileSync("bash", [SCRIPT], { env, encoding: "utf8", cwd: REPO }), code: 0 };
  } catch (e: unknown) {
    const err = e as { status?: number; stdout?: string; stderr?: string };
    return { out: `${err.stdout ?? ""}${err.stderr ?? ""}`, code: err.status ?? 1 };
  }
}

describe("check-runner-task-read.sh — behavioral (stubbed aws, metadata+simulate only, no network)", () => {
  beforeAll(() => {
    binDir = fs.mkdtempSync(path.join(os.tmpdir(), "tr-aws-"));
    callLog = path.join(binDir, "calls.log");
    const p = path.join(binDir, "aws");
    fs.writeFileSync(p, FAKE_AWS); fs.chmodSync(p, 0o755);
  });
  afterAll(() => fs.rmSync(binDir, { recursive: true, force: true }));

  it("secret exists + task role allowed on pinned / denied on decoy → PASS, get-secret-value NEVER invoked", () => {
    fs.writeFileSync(callLog, "");
    const { out, code } = run("ready");
    expect(code).toBe(0);
    expect(out).toContain("ALLOWED secretsmanager:GetSecretValue on the pinned secret");
    expect(out).toContain("NOT allowed GetSecretValue on a decoy");
    expect(out).toContain("value NEVER read");
    const calls = fs.readFileSync(callLog, "utf8");
    expect(calls).toMatch(/iam simulate-principal-policy/);
    expect(calls).not.toContain("get-secret-value"); // never invoked at runtime
  });

  it("secret missing → FAIL (NOT-YET-CREATED)", () => {
    const { out, code } = run("missing");
    expect(code).toBe(1);
    expect(out).toContain("secret NOT FOUND");
  });

  it("task role NOT allowed on the pinned secret → FAIL", () => {
    const { out, code } = run("notallowed");
    expect(code).toBe(1);
    expect(out).toContain("expected allowed");
  });

  it("task role allowed on a decoy (least-privilege violated) → FAIL", () => {
    const { out, code } = run("leaky");
    expect(code).toBe(1);
    expect(out).toContain("least-privilege violated");
  });

  it("never prints a raw ARN / account / secret value", () => {
    const { out } = run("ready");
    expect(out).not.toMatch(/arn:aws:secretsmanager/);
    expect(out).not.toMatch(/arn:aws:iam/);
    expect(out).not.toMatch(/AbCdEf/);
  });
});
