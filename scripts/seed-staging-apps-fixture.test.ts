import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Local guard test for scripts/seed-staging-apps-fixture.sh — exercises the production-refusal +
// staging-only + confirmation-phrase guards by running the script with a TEMP project-ref file.
// It NEVER sets STAGING_DB_URL, so the script never connects to any database (no hosted call).

const SCRIPT = fileURLToPath(new URL("./seed-staging-apps-fixture.sh", import.meta.url));
const STAGING = "ycdpzduxugdsffjqyoai";
const PROD = "dzbfxulvxchdemcettrx";
const PHRASE = "SEED STAGING APPS FIXTURE";

function run(ref: string | null, args: string[], extraEnv: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "seedfix-"));
  const env = { ...process.env };
  // Default: never connect. Only the explicit prod-URL test case re-sets STAGING_DB_URL via extraEnv.
  delete env.STAGING_DB_URL;
  if (ref === null) {
    env.PROJECT_REF_FILE = join(dir, "missing-ref");
  } else {
    const f = join(dir, "project-ref");
    writeFileSync(f, ref + "\n");
    env.PROJECT_REF_FILE = f;
  }
  Object.assign(env, extraEnv);
  try {
    const stdout = execFileSync("bash", [SCRIPT, ...args], { env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return { code: 0, out: stdout };
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string };
    return { code: err.status ?? -1, out: (err.stdout ?? "") + (err.stderr ?? "") };
  }
}

describe("seed-staging-apps-fixture.sh guards", () => {
  it("REFUSES the production ref explicitly", () => {
    const r = run(PROD, [PHRASE]);
    expect(r.code).not.toBe(0);
    expect(r.out).toMatch(/REFUSED/i);
    expect(r.out).toContain(PROD);
  });

  it("fails closed when the linked ref is not staging", () => {
    const r = run("some-other-ref", [PHRASE]);
    expect(r.code).not.toBe(0);
    expect(r.out).toMatch(/FAIL-CLOSED/i);
  });

  it("fails closed when there is no linked ref file", () => {
    const r = run(null, [PHRASE]);
    expect(r.code).not.toBe(0);
    expect(r.out).toMatch(/FAIL-CLOSED/i);
  });

  it("requires the exact confirmation phrase even on staging", () => {
    expect(run(STAGING, []).code).not.toBe(0);
    expect(run(STAGING, ["wrong phrase"]).out).toMatch(/Confirmation required/i);
  });

  it("on staging + confirmation + no STAGING_DB_URL → prints SQL-editor instructions, connects to nothing", () => {
    const r = run(STAGING, [PHRASE]);
    expect(r.code).toBe(0);
    expect(r.out).toContain(STAGING);
    expect(r.out).toMatch(/SQL editor/i);
    expect(r.out).toContain("staging_apps_people_verification.sql");
  });

  it("refuses even with confirmation if STAGING_DB_URL points at production", () => {
    const r = run(STAGING, [PHRASE], { STAGING_DB_URL: `postgres://x@db.${PROD}.supabase.co:5432/postgres` });
    expect(r.code).not.toBe(0);
    expect(r.out).toMatch(/REFUSED/i);
  });
});
