import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Behavioral test: run the real check-runner-keys-revoked.sh with a stubbed `aws` on PATH that emits synthetic
// `configure list-profiles` + `sts get-caller-identity` outcomes, and assert run_checks' rollup + exit code per state.
// No real AWS, no network, no secrets — the stub is the only `aws`.
const REPO = path.resolve(__dirname, "..");
const SCRIPT = path.join(REPO, "scripts", "check-runner-keys-revoked.sh");
let binDir: string;

// a fake `aws` driven by $KR_SCENARIO: controls whether the old profiles are listed + how sts responds.
const FAKE_AWS = `#!/usr/bin/env bash
if [ "$1" = configure ] && [ "$2" = list-profiles ]; then
  case "\${KR_SCENARIO:-}" in
    list_error) echo "list-profiles boom" >&2; exit 1 ;;
    *_present|revoked|access_denied|still_works) printf 'default\\nidcaddie-staging-runner\\nidcaddie-staging-web\\n' ;;
    *) printf 'default\\n' ;;  # removed / explicit_absent → old profiles absent
  esac
  exit 0
fi
# otherwise: sts get-caller-identity
case "\${KR_SCENARIO:-}" in
  revoked)       echo "An error occurred (InvalidClientTokenId) when calling the GetCallerIdentity operation: invalid" >&2; exit 255 ;;
  access_denied) echo "An error occurred (AccessDenied) when calling the GetCallerIdentity operation: denied" >&2; exit 255 ;;
  still_works)   echo "arn:aws:iam::000000000000:user/idcaddie-staging-runner"; exit 0 ;;
  explicit_absent) echo "The config profile (idcaddie-staging-runner) could not be found." >&2; exit 255 ;;
  *) echo "unexpected sts call in scenario \${KR_SCENARIO:-none}" >&2; exit 42 ;;
esac
`;

function run(scenario: string, extraEnv: Record<string, string> = {}): { out: string; code: number } {
  const env = {
    ...process.env,
    PATH: `${binDir}:${process.env.PATH}`,
    KR_SCENARIO: scenario,
    ID_CADDIE_RUNNER_KEYS_REVOKED: "1",
    ID_CADDIE_RUNNER_KEYS_REVOKED_ENV: "staging",
    RUNNER_KEYS_REVOKED_PROJECT_REF: "ycdpzduxugdsffjqyoai",
    AWS_REGION: "ca-central-1",
    ...extraEnv,
  };
  // ensure the default (unset) profile path unless a scenario sets them explicitly
  delete (env as Record<string, string>).AWS_PROFILE;
  delete (env as Record<string, string>).ID_CADDIE_RUNNER_KEYS_REVOKED_WEB_PROFILE;
  Object.assign(env, extraEnv);
  try {
    const out = execFileSync("bash", [SCRIPT], { env, encoding: "utf8", cwd: REPO });
    return { out, code: 0 };
  } catch (e: unknown) {
    const err = e as { status?: number; stdout?: string; stderr?: string };
    return { out: `${err.stdout ?? ""}${err.stderr ?? ""}`, code: err.status ?? 1 };
  }
}

describe("check-runner-keys-revoked.sh — behavioral (stubbed aws, no network)", () => {
  beforeAll(() => {
    binDir = fs.mkdtempSync(path.join(os.tmpdir(), "kr-aws-"));
    const p = path.join(binDir, "aws");
    fs.writeFileSync(p, FAKE_AWS); fs.chmodSync(p, 0o755);
  });
  afterAll(() => fs.rmSync(binDir, { recursive: true, force: true }));

  it("STATE 2 — old profiles removed locally → PASS local cleanup, does NOT claim a live dead-key check", () => {
    const { out, code } = run("removed");
    expect(code).toBe(0);
    expect(out).toContain("local_profiles_removed");
    expect(out).toContain("did NOT perform a live AWS dead-key check");
    expect(out).not.toContain("AWS-side dead-key verification satisfied");
    expect(out).not.toMatch(/arn:aws:iam/); // no identity leaked
  });

  it("STATE 1 — profiles present + revoked (InvalidClientTokenId) → PASS AWS-side dead-key verification", () => {
    const { out, code } = run("revoked");
    expect(code).toBe(0);
    expect(out).toContain("REVOKED / not usable");
    expect(out).toContain("AWS-side dead-key verification satisfied");
  });

  it("STATE 1 — profiles present + AccessDenied (still-live-but-denied) → FAIL closed, NOT reported revoked", () => {
    const { out, code } = run("access_denied");
    expect(code).toBe(1);
    expect(out).toContain("cannot confirm revoked (fail-closed)");
    expect(out).not.toContain("REVOKED / not usable");
  });

  it("STATE 1 — profiles present + key STILL WORKS (sts success) → FAIL, no ARN printed", () => {
    const { out, code } = run("still_works");
    expect(code).toBe(1);
    expect(out).toContain("STILL WORKS");
    expect(out).not.toMatch(/arn:aws:iam/);
  });

  it("enumeration failure (aws configure list-profiles errors) → FAIL closed, not masked as removed", () => {
    const { out, code } = run("list_error");
    expect(code).toBe(1);
    expect(out).toContain("could not enumerate local AWS profiles");
    expect(out).not.toContain("local_profiles_removed");
  });

  it("explicitly-named profile absent from the list → live-probed (fail-closed), never silently local_removed", () => {
    const { out, code } = run("explicit_absent", {
      AWS_PROFILE: "idcaddie-staging-runner",
      ID_CADDIE_RUNNER_KEYS_REVOKED_WEB_PROFILE: "idcaddie-staging-web",
    });
    expect(code).toBe(1);
    expect(out).not.toContain("local_profiles_removed"); // must not mask a still-usable explicit profile
    expect(out).toContain("cannot confirm revoked (fail-closed)");
  });
});
