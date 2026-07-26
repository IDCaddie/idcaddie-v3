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
const USERS_JSON = JSON.stringify({ expectedTenantId: "11111111-2222-4333-8444-555555555555", owner: { email: "o@x.test", password: "p" } });
const LIVE_ENV = () => ({
  STAGING_SUPABASE_URL: `https://${STAGING_REF}.supabase.co`,
  STAGING_SUPABASE_ANON_KEY: jwt("anon"),
  STAGING_APP_URL: "https://staging.example.com",
  STAGING_AUTH_TEST_USERS: USERS_JSON,
});
const V3_HOST = "idcaddie-v3.vercel.app";
// Full isolated-v3 live env (no STAGING_APP_URL — that would conflict). Anon key is a valid anon JWT so guards 1–5 pass to the app-target guard.
const V3_ENV = () => ({
  ACCESS_VERIFY_MODE: "isolated-v3",
  ACCESS_VERIFY_APP_URL: `https://${V3_HOST}`,
  ACCESS_VERIFY_ALLOWED_HOST: V3_HOST,
  STAGING_SUPABASE_URL: `https://${STAGING_REF}.supabase.co`,
  STAGING_SUPABASE_ANON_KEY: jwt("anon"),
  STAGING_AUTH_TEST_USERS: USERS_JSON,
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

describe("verify-staging-access-surface — mode selection", () => {
  it("default (no ACCESS_VERIFY_MODE) is staging", () => {
    const { status, out } = run(["--preflight"], writeRef(STAGING_REF));
    expect(status).toBe(0);
    expect(out).toContain("mode=staging");
  });
  it("empty ACCESS_VERIFY_MODE falls back to staging", () => {
    const { status, out } = run(["--preflight"], { ...writeRef(STAGING_REF), ACCESS_VERIFY_MODE: "" });
    expect(status).toBe(0);
    expect(out).toContain("mode=staging");
  });
  it("explicit isolated-v3 is selected", () => {
    const { status, out } = run(["--preflight"], { ...writeRef(STAGING_REF), ACCESS_VERIFY_MODE: "isolated-v3" });
    expect(status).toBe(0);
    expect(out).toContain("mode=isolated-v3");
    expect(out).toContain("isolated V3 web deployment");
  });
  it("an unknown mode is rejected", () => {
    const { status, out } = run(["--preflight"], { ...writeRef(STAGING_REF), ACCESS_VERIFY_MODE: "production" });
    expect(status).toBe(2);
    expect(out).toContain("not recognized");
  });
  it("mode is NEVER inferred from the host — isolated-v3 env vars alone stay in staging mode", () => {
    const { status, out } = run(["--preflight"], { ...writeRef(STAGING_REF), ACCESS_VERIFY_APP_URL: `https://${V3_HOST}`, ACCESS_VERIFY_ALLOWED_HOST: V3_HOST });
    expect(status).toBe(0);
    expect(out).toContain("mode=staging");
    expect(out).not.toContain("Normalized allowed host"); // isolated-v3 host validation did NOT run
  });
});

describe("verify-staging-access-surface — isolated-v3 host allowlist (preflight, no network)", () => {
  const pf = (env: Record<string, string>) => run(["--preflight"], { ...writeRef(STAGING_REF), ACCESS_VERIFY_MODE: "isolated-v3", ...env });
  it("the exact reviewed V3 host is accepted", () => {
    const { status, out } = pf({ ACCESS_VERIFY_APP_URL: `https://${V3_HOST}`, ACCESS_VERIFY_ALLOWED_HOST: V3_HOST });
    expect(status).toBe(0);
    expect(out).toContain(`Normalized allowed host: ${V3_HOST} (reviewed)`);
  });
  it("a lookalike/suffix-spoof host is rejected (exact match, no substring)", () => {
    const { status, out } = pf({ ACCESS_VERIFY_APP_URL: `https://${V3_HOST}.attacker.example`, ACCESS_VERIFY_ALLOWED_HOST: `${V3_HOST}.attacker.example` });
    expect(status).toBe(2);
    expect(out).toContain("not a reviewed isolated-v3 host");
  });
  it("allowed-host that disagrees with the app-url host is rejected", () => {
    const { status, out } = pf({ ACCESS_VERIFY_APP_URL: `https://${V3_HOST}`, ACCESS_VERIFY_ALLOWED_HOST: "something-else.vercel.app" });
    expect(status).toBe(2);
    expect(out).toContain("does not match");
  });
  it("http, URL credentials, path/query/fragment, and an explicit port are rejected", () => {
    expect(pf({ ACCESS_VERIFY_APP_URL: `http://${V3_HOST}`, ACCESS_VERIFY_ALLOWED_HOST: V3_HOST }).out).toContain("https://");
    expect(pf({ ACCESS_VERIFY_APP_URL: `https://u:p@${V3_HOST}`, ACCESS_VERIFY_ALLOWED_HOST: V3_HOST }).out).toContain("credentials");
    expect(pf({ ACCESS_VERIFY_APP_URL: `https://${V3_HOST}/x`, ACCESS_VERIFY_ALLOWED_HOST: V3_HOST }).out).toContain("bare origin");
    expect(pf({ ACCESS_VERIFY_APP_URL: `https://${V3_HOST}:8443`, ACCESS_VERIFY_ALLOWED_HOST: V3_HOST }).out).toContain("must not specify a port");
  });
  it("a legacy production host is rejected even in isolated-v3 mode", () => {
    const { status, out } = pf({ ACCESS_VERIFY_APP_URL: "https://app.idcaddie.com", ACCESS_VERIFY_ALLOWED_HOST: "app.idcaddie.com" });
    expect(status).toBe(2);
    expect(out).toContain("not a reviewed isolated-v3 host"); // allowlist gate fires first
  });
});

describe("verify-staging-access-surface — isolated-v3 live guards (no network; die before any request)", () => {
  it("requires ACCESS_VERIFY_APP_URL", () => {
    const env = { ...writeRef(STAGING_REF), ...V3_ENV() }; delete (env as Record<string, string>).ACCESS_VERIFY_APP_URL;
    const { status, out } = run([], env);
    expect(status).toBe(2);
    expect(out).toContain("requires ACCESS_VERIFY_APP_URL");
  });
  it("requires ACCESS_VERIFY_ALLOWED_HOST", () => {
    const env = { ...writeRef(STAGING_REF), ...V3_ENV() }; delete (env as Record<string, string>).ACCESS_VERIFY_ALLOWED_HOST;
    const { status, out } = run([], env);
    expect(status).toBe(2);
    expect(out).toContain("requires ACCESS_VERIFY_ALLOWED_HOST");
  });
  it("rejects an ambiguous STAGING_APP_URL that conflicts with ACCESS_VERIFY_APP_URL", () => {
    const { status, out } = run([], { ...writeRef(STAGING_REF), ...V3_ENV(), STAGING_APP_URL: "https://staging.example.com" });
    expect(status).toBe(2);
    expect(out).toContain("ambiguous");
  });
  it("still rejects a production Supabase URL in isolated-v3 mode", () => {
    const { status, out } = run([], { ...writeRef(STAGING_REF), ...V3_ENV(), STAGING_SUPABASE_URL: `https://${PRODUCTION_REF}.supabase.co` });
    expect(status).toBe(2);
    expect(out).toContain("host must be exactly");
  });
  it("still rejects a service-role/secret key in isolated-v3 mode", () => {
    const { status, out } = run([], { ...writeRef(STAGING_REF), ...V3_ENV(), STAGING_SUPABASE_ANON_KEY: "sb_secret_ABC" });
    expect(status).toBe(2);
    expect(out).toContain("SERVICE-ROLE");
  });
});

describe("verify-staging-access-surface — staging mode ambiguity", () => {
  it("rejects ACCESS_VERIFY_APP_URL set while mode is staging (conflict)", () => {
    const { status, out } = run([], { ...writeRef(STAGING_REF), ...LIVE_ENV(), ACCESS_VERIFY_APP_URL: "https://other.example.com" });
    expect(status).toBe(2);
    expect(out).toContain("ambiguous");
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
  it("no dynamic import / require (only the two static top-level imports are the egress surface)", () => {
    const s = src();
    for (const bad of ["import(", "require(", "createRequire"]) expect(s).not.toContain(bad);
  });
  it("the RPC allowlist is EXACTLY the 9 migration-0061 READ RPCs — no mutation RPC can slip in", () => {
    const s = src();
    const block = s.match(/const RPC_ALLOWLIST = \[([\s\S]*?)\];/);
    expect(block).toBeTruthy();
    const names = [...block![1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
    expect(names.slice().sort()).toEqual([
      "product_application_access_subgraph", "product_directory_access_counts", "product_identity_access_subgraph",
      "product_list_directory_applications", "product_list_directory_groups", "product_list_directory_identities",
      "product_list_group_assignments", "product_list_group_memberships", "product_list_user_assignments",
    ]);
    for (const n of names) {
      expect(n.startsWith("product_")).toBe(true);
      for (const verb of ["insert", "update", "delete", "upsert", "write", "set_", "create", "grant", "revoke"]) expect(n).not.toContain(verb);
    }
  });
  it("the ONLY DB egress is client.rpc(...) inside the read-only wrapper — no other .rpc( and no direct .from( table access", () => {
    const s = src();
    // Every method-call `<ident>.rpc(` must be `client.rpc(` inside the wrapper (a comment's " .rpc()" has a space, so it won't match).
    const rpcCallers = [...s.matchAll(/(\w+)\.rpc\(/g)].map((m) => m[1]);
    expect(rpcCallers).toEqual(["client"]);
    expect(s).toContain("return client.rpc(name, args)");  // ...and it is the guarded wrapper
    for (const tableEgress of ['.from("', ".from('"]) expect(s).not.toContain(tableEgress); // no direct canonical-table query (Buffer.from is fine)
  });
  it("node --check parses the script", () => {
    expect(() => execFileSync("node", ["--check", SCRIPT], { stdio: "pipe" })).not.toThrow();
  });
});
