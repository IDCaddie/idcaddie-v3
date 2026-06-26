import { describe, it, expect, vi, beforeEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  createDevProviderTokenSource,
  isDevProviderTokenSourceEnabled,
  ProviderTokenError,
  type ProviderTokenRequest,
} from "./provider-token-source";

// Slack P0 PR 1 — the dev/test provider-token source is a build scaffold that must be ALLOWLIST-shaped fail-closed:
// enabled ONLY in positively-confirmed local dev + explicit opt-in. Synthetic token only (the marker is IN the token so
// the secret scanner excuses it).
const SENTINEL = "xoxb-000000-MUSTNOTLEAKp0devtokensourcesentinel";
const DEV = { NODE_ENV: "development", ID_CADDIE_DEV_PROVIDER_TOKEN_SOURCE_ENABLED: "1", ID_CADDIE_DEV_SLACK_TOKEN: SENTINEL } as Record<string, string | undefined>;
const REQ: ProviderTokenRequest = { provider: "slack", tenantId: "t1", connectorId: "c1", purpose: "sync" };

// capture every console channel so we can assert the token is NEVER logged.
let consoleDump: string[];
beforeEach(() => {
  consoleDump = [];
  for (const m of ["log", "info", "warn", "error", "debug"] as const)
    vi.spyOn(console, m).mockImplementation((...a: unknown[]) => { consoleDump.push(a.map(String).join(" ")); });
});

describe("dev provider-token source — allowlist-shaped fail-closed guard", () => {
  it("returns the synthetic token in local dev WITH opt-in (the only enabling case)", async () => {
    const tok = await createDevProviderTokenSource(DEV).getProviderToken(REQ);
    expect(tok).toEqual({ provider: "slack", token: SENTINEL });
  });

  // The allowlist matrix — every non-(local-dev + opt-in) case fails closed. (Mutation standard: flipping the guard to
  // a denylist "deny only staging/prod" makes the unknown/unset/preview rows pass → these fail.)
  it.each([
    ["staging-like (VERCEL_ENV=production)", { ...DEV, NODE_ENV: "production", VERCEL_ENV: "production" }],
    ["production-like (NODE_ENV=production)", { ...DEV, NODE_ENV: "production" }],
    ["vercel preview", { ...DEV, NODE_ENV: "production", VERCEL_ENV: "preview" }],
    ["unknown env (garbage NODE_ENV)", { ...DEV, NODE_ENV: "staging-ish-unknown" }],
    ["unset env (no NODE_ENV)", { ID_CADDIE_DEV_PROVIDER_TOKEN_SOURCE_ENABLED: "1", ID_CADDIE_DEV_SLACK_TOKEN: SENTINEL }],
    ["test runtime (NODE_ENV=test)", { ...DEV, NODE_ENV: "test" }],
    ["dev but a non-dev VERCEL_ENV present", { ...DEV, VERCEL_ENV: "production" }],
    ["missing opt-in", { NODE_ENV: "development", ID_CADDIE_DEV_SLACK_TOKEN: SENTINEL }],
    ["opt-in not exactly '1'", { ...DEV, ID_CADDIE_DEV_PROVIDER_TOKEN_SOURCE_ENABLED: "true" }],
  ] as [string, Record<string, string | undefined>][])("fails closed: %s", async (_label, env) => {
    expect(isDevProviderTokenSourceEnabled(env)).toBe(false);
    await expect(createDevProviderTokenSource(env).getProviderToken(REQ)).rejects.toBeInstanceOf(ProviderTokenError);
  });

  it("fails closed when the dev token is missing (even in local dev + opt-in)", async () => {
    const env = { NODE_ENV: "development", ID_CADDIE_DEV_PROVIDER_TOKEN_SOURCE_ENABLED: "1" };
    await expect(createDevProviderTokenSource(env).getProviderToken(REQ)).rejects.toBeInstanceOf(ProviderTokenError);
  });

  it("fails closed for an unsupported provider", async () => {
    const bad = { ...REQ, provider: "github" as unknown as "slack" };
    await expect(createDevProviderTokenSource(DEV).getProviderToken(bad)).rejects.toBeInstanceOf(ProviderTokenError);
  });
});

describe("request input CANNOT enable the dev token source (guard reads trusted env only)", () => {
  it("a request carrying the opt-in in header/query/body/cookie/url does NOT enable it", async () => {
    // A clean env that is local-dev but has NO opt-in. The "request" tries to inject the opt-in every way.
    const envNoOptIn = { NODE_ENV: "development", ID_CADDIE_DEV_SLACK_TOKEN: SENTINEL };
    const hostileRequest = {
      headers: { "x-id-caddie-dev-provider-token-source-enabled": "1", "id_caddie_dev_provider_token_source_enabled": "1" },
      query: { ID_CADDIE_DEV_PROVIDER_TOKEN_SOURCE_ENABLED: "1" },
      body: { ID_CADDIE_DEV_PROVIDER_TOKEN_SOURCE_ENABLED: "1" },
      cookies: { ID_CADDIE_DEV_PROVIDER_TOKEN_SOURCE_ENABLED: "1" },
      url: "/x?ID_CADDIE_DEV_PROVIDER_TOKEN_SOURCE_ENABLED=1",
    };
    void hostileRequest; // the guard signature takes only `env` — request values are structurally unreachable.
    expect(isDevProviderTokenSourceEnabled(envNoOptIn)).toBe(false);
    await expect(createDevProviderTokenSource(envNoOptIn).getProviderToken(REQ)).rejects.toBeInstanceOf(ProviderTokenError);
    // and the ONLY thing that enables it is the trusted env opt-in:
    expect(isDevProviderTokenSourceEnabled({ ...envNoOptIn, ID_CADDIE_DEV_PROVIDER_TOKEN_SOURCE_ENABLED: "1" })).toBe(true);
  });
});

describe("token discipline — the token never leaks", () => {
  it("the disabled/missing/unsupported error messages never contain the token", async () => {
    for (const env of [{ NODE_ENV: "production" } as Record<string, string | undefined>, DEV]) {
      const src = createDevProviderTokenSource(env);
      const reqs = [REQ, { ...REQ, provider: "x" as unknown as "slack" }];
      for (const r of reqs) {
        try { await src.getProviderToken(r); } catch (e) {
          expect((e as Error).message).not.toContain(SENTINEL);
        }
      }
    }
    expect(consoleDump.join("\n")).not.toContain(SENTINEL); // nothing was ever logged
  });

  it("a successful call logs nothing and returns the token ONLY in the in-memory object", async () => {
    const tok = await createDevProviderTokenSource(DEV).getProviderToken(REQ);
    expect(tok.token).toBe(SENTINEL);
    expect(consoleDump.join("\n")).not.toContain(SENTINEL);
  });
});

describe("server-only boundary", () => {
  const SRC = path.resolve(__dirname, "..", "..", "..", "..", "src");
  const HINTS = ["server/sync/provider-token-source", "lib/server/sync/provider-token-source"];
  const walk = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) return e.name === "node_modules" || e.name === ".next" ? [] : walk(full);
    return /\.(ts|tsx)$/.test(e.name) ? [full] : [];
  });
  const importsit = (s: string) => HINTS.some((h) => s.includes(h));

  it('no "use client" file imports the token source', () => {
    const offenders = walk(SRC).filter((f) => !f.endsWith("provider-token-source.ts") && !f.endsWith("provider-token-source.test.ts"))
      .filter((f) => { const s = fs.readFileSync(f, "utf8"); return /^\s*["']use client["']/m.test(s) && importsit(s); });
    expect(offenders).toEqual([]);
  });

  it("no file under src/app imports the token source (no route/action/public-API exposure)", () => {
    const appDir = path.join(SRC, "app");
    const offenders = walk(SRC).filter((f) => f.startsWith(appDir)).filter((f) => importsit(fs.readFileSync(f, "utf8")));
    expect(offenders).toEqual([]);
  });

  it("the module declares its server-only runtime sentinel", () => {
    const src = fs.readFileSync(path.join(SRC, "lib", "server", "sync", "provider-token-source.ts"), "utf8");
    expect(src).toMatch(/server-only/);
    expect(src).toMatch(/globalThis[^\n]*window/);
  });
});
