import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Behavioral test: run the real check-runner-secret-metadata.sh with a stubbed `aws` on PATH that returns synthetic
// describe-secret METADATA (never a value), and assert run_checks' rollup + exit code. The stub also records every
// aws subcommand it received so we can prove get-secret-value is NEVER invoked at runtime. No real AWS, no network.
const REPO = path.resolve(__dirname, "..");
const SCRIPT = path.join(REPO, "scripts", "check-runner-secret-metadata.sh");
let binDir: string;
let callLog: string;

const FAKE_AWS = `#!/usr/bin/env bash
echo "$*" >> "$KR_CALLLOG"
# the _aws wrapper prepends '--profile <p> --region <r>' — skip leading flag pairs to reach <service> <action>
while [ "\${1:-}" = "--profile" ] || [ "\${1:-}" = "--region" ]; do shift 2; done
if [ "$1" = sts ]; then echo 000000000000; exit 0; fi
# secretsmanager describe-secret  (metadata only — this stub NEVER returns a value; get-secret-value must never reach here)
if [ "$1" = secretsmanager ] && [ "$2" = get-secret-value ]; then echo "FORBIDDEN get-secret-value called" >&2; exit 99; fi
if [ "$1" = secretsmanager ] && [ "$2" = describe-secret ]; then
  case "\${KR_SCENARIO:-}" in
    missing) echo "An error occurred (ResourceNotFoundException)" >&2; exit 254 ;;
  esac
  # dispatch on the --query field
  case "$*" in
    *Name*)   printf '/idcaddie/staging/slack/oauth-client-secret\\n' ;;
    *ARN*)    case "\${KR_SCENARIO:-}" in
                wrong_arn) printf 'arn:aws:secretsmanager:us-east-1:000000000000:secret:/x-Ab\\n' ;;
                *)         printf 'arn:aws:secretsmanager:ca-central-1:000000000000:secret:/idcaddie/staging/slack/oauth-client-secret-AbCdEf\\n' ;;
              esac ;;
    *KmsKeyId*) case "\${KR_SCENARIO:-}" in
                  cmk)      printf 'arn:aws:kms:ca-central-1:000000000000:key/aaaaaaaa-1111\\n' ;;
                  *)        printf 'None\\n' ;;
                esac ;;
    *length*) printf '1\\n' ;;
    *Tags*)   printf 'None\\n' ;;
    *)        printf '\\n' ;;
  esac
  exit 0
fi
echo "unexpected aws call: $*" >&2; exit 42
`;

function run(scenario: string, extraEnv: Record<string, string> = {}): { out: string; code: number } {
  const env = {
    ...process.env,
    PATH: `${binDir}:${process.env.PATH}`,
    KR_SCENARIO: scenario,
    KR_CALLLOG: callLog,
    ID_CADDIE_RUNNER_SECRET_METADATA: "1",
    AWS_PROFILE: "p",
    AWS_REGION: "ca-central-1",
    ID_CADDIE_RUNNER_SECRET_METADATA_EXPECTED_ACCOUNT: "000000000000",
    ID_CADDIE_RUNNER_SECRET_METADATA_ENV: "staging",
    RUNNER_SECRET_METADATA_PROJECT_REF: "ycdpzduxugdsffjqyoai",
    ...extraEnv,
  };
  try {
    return { out: execFileSync("bash", [SCRIPT], { env, encoding: "utf8", cwd: REPO }), code: 0 };
  } catch (e: unknown) {
    const err = e as { status?: number; stdout?: string; stderr?: string };
    return { out: `${err.stdout ?? ""}${err.stderr ?? ""}`, code: err.status ?? 1 };
  }
}

describe("check-runner-secret-metadata.sh — behavioral (stubbed aws, metadata only, no network)", () => {
  beforeAll(() => {
    binDir = fs.mkdtempSync(path.join(os.tmpdir(), "sm-aws-"));
    callLog = path.join(binDir, "calls.log");
    const p = path.join(binDir, "aws");
    fs.writeFileSync(p, FAKE_AWS); fs.chmodSync(p, 0o755);
  });
  afterAll(() => fs.rmSync(binDir, { recursive: true, force: true }));

  it("secret exists with expected name/region/account, default KMS → PASS, value never read", () => {
    fs.writeFileSync(callLog, "");
    const { out, code } = run("exists");
    expect(code).toBe(0);
    expect(out).toContain("secret exists with the expected name");
    expect(out).toContain("secret ARN is in the expected region + account");
    expect(out).toContain("value NEVER read");
    // proof at runtime: get-secret-value was never called; describe-secret was
    const calls = fs.readFileSync(callLog, "utf8");
    expect(calls).toMatch(/secretsmanager describe-secret/);
    expect(calls).not.toContain("get-secret-value");
  });

  it("secret missing → FAIL (NOT-YET-CREATED), tells the operator to provision it", () => {
    const { out, code } = run("missing");
    expect(code).toBe(1);
    expect(out).toContain("secret NOT FOUND");
    expect(out).toContain("NOT-YET-CREATED");
  });

  it("wrong ARN region/account → FAIL", () => {
    const { out, code } = run("wrong_arn");
    expect(code).toBe(1);
    expect(out).toContain("region/account does not match");
  });

  it("expected KMS ref mismatch → FAIL; matching customer-managed key → PASS", () => {
    const bad = run("cmk", { ID_CADDIE_RUNNER_SECRET_METADATA_EXPECTED_KMS: "alias/idcaddie-staging-connector-vault" });
    expect(bad.code).toBe(1);
    expect(bad.out).toContain("KMS key does not match");
    const ok = run("cmk", { ID_CADDIE_RUNNER_SECRET_METADATA_EXPECTED_KMS: "aaaaaaaa-1111" });
    expect(ok.code).toBe(0);
    expect(ok.out).toContain("expected KMS key");
  });

  it("never prints a secret value or a raw ARN/KMS id", () => {
    const { out } = run("cmk");
    expect(out).not.toMatch(/arn:aws:secretsmanager/); // raw ARN never printed
    expect(out).not.toMatch(/arn:aws:kms/);            // raw KMS id never printed
    expect(out).not.toMatch(/AbCdEf/);                 // ARN suffix never printed
  });
});
