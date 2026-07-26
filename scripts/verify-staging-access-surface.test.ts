import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// The verify-staging-access-surface.mjs guards are exercised as a SUBPROCESS with a temp project-ref file (ACCESS_SURFACE_REF_FILE) and a
// controlled env — no network, no real staging, no linked project. This mirrors the dry-run scripts' testability seam.
const SCRIPT = fileURLToPath(new URL("./verify-staging-access-surface.mjs", import.meta.url));
const STAGING_REF = "ycdpzduxugdsffjqyoai";
const PRODUCTION_REF = "dzbfxulvxchdemcettrx";
const b64url = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
const jwt = (role: string) => `h.${b64url({ role })}.s`;

let dir: string;
const refFile = () => join(dir, "project-ref");
beforeAll(() => { dir = mkdtempSync(join(tmpdir(), "access-verify-")); });
afterAll(() => rmSync(dir, { recursive: true, force: true }));

// Run the script with a clean env (PATH only) + overrides. Returns { status, out } (out = stdout+stderr). execFileSync throws on non-zero.
function run(args: string[], env: Record<string, string> = {}): { status: number; out: string } {
  try {
    // Minimal env (PATH + NODE_ENV only) + overrides — deliberately excludes any real STAGING_* vars so the guard tests are deterministic.
    const out = execFileSync("node", [SCRIPT, ...args], { encoding: "utf8", env: { PATH: process.env.PATH ?? "", NODE_ENV: process.env.NODE_ENV ?? "test", ...env } });
    return { status: 0, out };
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string };
    return { status: err.status ?? 1, out: `${err.stdout ?? ""}${err.stderr ?? ""}` };
  }
}
const writeRef = (ref: string) => { writeFileSync(refFile(), ref); return { ACCESS_SURFACE_REF_FILE: refFile() }; };
const LIVE_ENV = () => ({
  STAGING_SUPABASE_URL: `https://${STAGING_REF}.supabase.co`,
  STAGING_SUPABASE_ANON_KEY: jwt("anon"),
  STAGING_APP_URL: "https://staging.example.com",
  STAGING_AUTH_TEST_USERS: JSON.stringify({ expectedTenantId: "11111111-2222-4333-8444-555555555555", owner: { email: "o@x.test", password: "p" } }),
});

describe("verify-staging-access-surface — guards (subprocess, no network)", () => {
  it("--help exits 0 and documents read-only + staging-only", () => {
    const { status, out } = run(["--help"]);
    expect(status).toBe(0);
    expect(out).toContain("READ-ONLY");
    expect(out).toContain(STAGING_REF);
  });

  it("missing ref file → fail closed (exit 2)", () => {
    const { status, out } = run([], { ACCESS_SURFACE_REF_FILE: join(dir, "does-not-exist") });
    expect(status).toBe(2);
    expect(out).toContain("FATAL");
  });

  it("PRODUCTION ref → refused", () => {
    const { status, out } = run([], writeRef(PRODUCTION_REF));
    expect(status).toBe(2);
    expect(out).toContain("PRODUCTION");
  });

  it("unknown/wrong ref → refused", () => {
    const { status, out } = run([], writeRef("someotherref"));
    expect(status).toBe(2);
    expect(out.toLowerCase()).toContain("refus");
  });

  it("--preflight on staging ref → exit 0, prints the plan + RPC allowlist, requires NO creds, performs no network", () => {
    const { status, out } = run(["--preflight"], writeRef(STAGING_REF));
    expect(status).toBe(0);
    expect(out).toContain("PREFLIGHT");
    expect(out).toContain("product_directory_access_counts");   // RPC allowlist shown
    expect(out).toContain("No network performed");
    // env reported as UNSET (none supplied) — never their values
    expect(out).toContain("STAGING_SUPABASE_ANON_KEY: UNSET");
  });

  it("live mode with missing env → fail closed (exit 2)", () => {
    const { status, out } = run([], writeRef(STAGING_REF)); // staging ref but no STAGING_* env
    expect(status).toBe(2);
    expect(out).toContain("missing env");
  });

  it("production APP_URL → refused (staging DB but production app url)", () => {
    const env = { ...writeRef(STAGING_REF), ...LIVE_ENV(), STAGING_APP_URL: `https://${PRODUCTION_REF}.vercel.app` };
    const { status, out } = run([], env);
    expect(status).toBe(2);
    expect(out).toContain("PRODUCTION");
  });

  it("a SERVICE-ROLE anon key → refused (never accepts a service-role key)", () => {
    const env = { ...writeRef(STAGING_REF), ...LIVE_ENV(), STAGING_SUPABASE_ANON_KEY: jwt("service_role") };
    const { status, out } = run([], env);
    expect(status).toBe(2);
    expect(out).toContain("SERVICE-ROLE");
  });

  it("a current-gen sb_secret_ key → refused (opaque service-role-equivalent, not just legacy JWTs)", () => {
    const env = { ...writeRef(STAGING_REF), ...LIVE_ENV(), STAGING_SUPABASE_ANON_KEY: "sb_secret_ABCDEF123456" };
    const { status, out } = run([], env);
    expect(status).toBe(2);
    expect(out).toContain("SERVICE-ROLE");
  });

  it("a spoofed Supabase URL that merely embeds the ref → refused (exact-host match, no substring trust)", () => {
    const env = { ...writeRef(STAGING_REF), ...LIVE_ENV(), STAGING_SUPABASE_URL: `https://${STAGING_REF}.supabase.co.attacker.example` };
    const { status, out } = run([], env);
    expect(status).toBe(2);
    expect(out).toContain("host must be exactly");
  });

  it("a production frontend host in STAGING_APP_URL → refused (never GET production)", () => {
    const env = { ...writeRef(STAGING_REF), ...LIVE_ENV(), STAGING_APP_URL: "https://app.idcaddie.com" };
    const { status, out } = run([], env);
    expect(status).toBe(2);
    expect(out).toContain("PRODUCTION host");
  });

  it("never prints the supplied key/password values (redaction)", () => {
    const env = { ...writeRef(STAGING_REF), ...LIVE_ENV(), STAGING_SUPABASE_ANON_KEY: jwt("service_role") };
    const { out } = run([], env);
    expect(out).not.toContain(env.STAGING_SUPABASE_ANON_KEY); // the raw key value never appears
    expect(out).not.toContain("p@ssword"); // sanity (no password echo)
  });
});

describe("verify-staging-access-surface — source safety (static)", () => {
  const src = () => readFileSync(SCRIPT, "utf8");
  it("imports only node:fs + @supabase/supabase-js (no pg / aws-sdk / service-role client)", () => {
    const imports = [...src().matchAll(/^import\s.+from\s+["']([^"']+)["']/gm)].map((m) => m[1]).sort();
    expect(imports).toEqual(["@supabase/supabase-js", "node:fs"]);
  });
  it("performs no mutation and reads no service-role env", () => {
    const s = src();
    for (const bad of [".insert(", ".update(", ".delete(", ".upsert(", "SERVICE_ROLE_KEY", "createAdminClient", "aws-sdk", "kms"]) {
      expect(s).not.toContain(bad);
    }
  });
  it("node --check parses the script", () => {
    expect(() => execFileSync("node", ["--check", SCRIPT], { stdio: "pipe" })).not.toThrow();
  });
});
