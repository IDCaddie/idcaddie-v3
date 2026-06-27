import { describe, it, expect, vi, beforeEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { runSlackSyncDev, isDevSlackSyncRunEnabled, type RunSlackSyncDeps } from "./run-slack-sync-dev";
import type { SlackHttpClient, SlackHttpResponse } from "./slack/slack-client";
import type { SlackResolverStore } from "../connector-vault/slack-resolver-write";

// Slack P0 PR 6 — manual run orchestrator. Synthetic only: injected token source + http client + in-memory store; NO
// live Slack/DB. The token is a marked sentinel (the marker is IN the token so the scanner excuses it).
const SENTINEL = "xoxb-000000-MUSTNOTLEAKp0runsentinel";
const tokenSource = { async getProviderToken() { return { provider: "slack" as const, token: SENTINEL }; } };
const DEV = { NODE_ENV: "development", ID_CADDIE_DEV_SLACK_SYNC_ENABLED: "1" } as Record<string, string | undefined>;
const IDENTITY = { tenantId: "tenant-A", connectorId: "c1" };
const OBSERVED = "2026-06-27T00:00:00.000Z";

const jsonRes = (obj: unknown, status = 200, headers?: Record<string, string>): SlackHttpResponse => ({
  ok: status < 400, status, headers: headers ? { get: (n) => headers[n.toLowerCase()] ?? null } : undefined, json: async () => obj,
});
const member = (over: Record<string, unknown> = {}) => ({
  id: "U1", team_id: "T1", deleted: false, is_bot: false, is_admin: false, is_owner: false, is_primary_owner: false,
  is_restricted: false, is_ultra_restricted: false, tz: "UTC", updated: 1700000000,
  profile: { email: "a@x.test", display_name: "Ada", real_name: "Ada L", title: "Eng", status_text: "" }, ...over,
});
function httpOk(membersList: unknown[] = [member()]): { client: SlackHttpClient; calls: { url: string; auth?: string }[] } {
  const calls: { url: string; auth?: string }[] = [];
  const client: SlackHttpClient = async (url, init) => {
    calls.push({ url, auth: init.headers.Authorization });
    if (url.includes("auth.test")) return jsonRes({ ok: true, team_id: "T1", user_id: "U_AUTH", team: "Acme", url: "https://acme.slack.com" });
    if (url.includes("users.list")) return jsonRes({ ok: true, members: membersList, response_metadata: { next_cursor: "" } });
    return jsonRes({ ok: false, error: "unknown_method" });
  };
  return { client, calls };
}
function memStore() {
  const apps = new Map<string, string>(), appUsers = new Map<string, string>(), people = new Map<string, string>(), matches = new Map<string, string>();
  let a = 0, u = 0, p = 0;
  const store: SlackResolverStore = {
    async upsertApp(i) { const k = `${i.tenantId}:${i.externalInstanceId}`; if (!apps.has(k)) apps.set(k, `app-${++a}`); return { appId: apps.get(k)! }; },
    async upsertAppUser(i) { const k = `${i.tenantId}:${i.appId}:${i.externalUserId}`; if (!appUsers.has(k)) appUsers.set(k, `au-${++u}`); return { appUserId: appUsers.get(k)! }; },
    async upsertPerson(i) { const k = `${i.tenantId}:${i.primaryEmail.toLowerCase()}`; if (!people.has(k)) people.set(k, `p-${++p}`); return { personId: people.get(k)! }; },
    async getExistingMatchPersonId(i) { return matches.get(`${i.tenantId}:${i.appUserId}`) ?? null; },
    async insertMatch(i) { const k = `${i.tenantId}:${i.appUserId}`; if (matches.has(k)) return { created: false }; matches.set(k, i.personId); return { created: true }; },
  };
  return { store, apps, appUsers, people, matches };
}
const deps = (over: Partial<RunSlackSyncDeps> = {}): RunSlackSyncDeps => ({
  env: DEV, tokenSource, httpClient: httpOk().client, store: memStore().store, identity: IDENTITY, observedAt: OBSERVED, ...over,
});

let consoleDump: string[];
beforeEach(() => {
  consoleDump = [];
  for (const m of ["log", "info", "warn", "error", "debug"] as const)
    vi.spyOn(console, m).mockImplementation((...x: unknown[]) => { consoleDump.push(x.map(String).join(" ")); });
});

describe("isDevSlackSyncRunEnabled — allowlist-shaped, fail-closed", () => {
  it("enables ONLY in local dev + explicit run opt-in", () => {
    expect(isDevSlackSyncRunEnabled(DEV)).toBe(true);
    for (const env of [
      {}, { NODE_ENV: "production", ID_CADDIE_DEV_SLACK_SYNC_ENABLED: "1" },
      { NODE_ENV: "development", VERCEL_ENV: "preview", ID_CADDIE_DEV_SLACK_SYNC_ENABLED: "1" },
      { NODE_ENV: "development", VERCEL_ENV: "production", ID_CADDIE_DEV_SLACK_SYNC_ENABLED: "1" },
      { NODE_ENV: "test", ID_CADDIE_DEV_SLACK_SYNC_ENABLED: "1" }, { NODE_ENV: "development" },
      { NODE_ENV: "development", ID_CADDIE_DEV_SLACK_SYNC_ENABLED: "true" },
    ]) expect(isDevSlackSyncRunEnabled(env)).toBe(false);
  });
  it("request-supplied opt-in (header/query/body) cannot enable it — the guard reads only env", async () => {
    const envNoOptIn = { NODE_ENV: "development" };
    void { headers: { ID_CADDIE_DEV_SLACK_SYNC_ENABLED: "1" }, query: { ID_CADDIE_DEV_SLACK_SYNC_ENABLED: "1" } };
    expect(isDevSlackSyncRunEnabled(envNoOptIn)).toBe(false);
    expect((await runSlackSyncDev(deps({ env: envNoOptIn }))).ok).toBe(false);
  });
});

describe("runSlackSyncDev — chain wiring + safe summary", () => {
  it("runs token→client→emitter→resolver and returns a SAFE aggregate summary", async () => {
    const { client, calls } = httpOk([member({ id: "U1" }), member({ id: "U2", profile: { email: "b@x.test", display_name: "Bo" } })]);
    const st = memStore();
    const res = await runSlackSyncDev(deps({ httpClient: client, store: st.store }));
    expect(res).toMatchObject({ ok: true, teamPresent: true, usersFetched: 2, appUsersWritten: 2, peopleWritten: 2, matchesWritten: 2 });
    // chain ORDER: auth.test before users.list; the token rode the Authorization header (not the URL); then writes happened
    expect(calls[0].url).toContain("auth.test");
    expect(calls[1].url).toContain("users.list");
    expect(calls[0].auth).toBe(`Bearer ${SENTINEL}`);
    expect(st.appUsers.size).toBe(2);
  });

  it("is idempotent — running twice does not duplicate graph rows", async () => {
    const st = memStore();
    await runSlackSyncDev(deps({ store: st.store }));
    const second = await runSlackSyncDev(deps({ store: st.store }));
    expect(st.appUsers.size).toBe(1); expect(st.people.size).toBe(1); expect(st.matches.size).toBe(1);
    expect(second.ok && second.matchesWritten).toBe(0); // re-run: match already exists
  });

  it("the token NEVER appears in the summary, errors, or console", async () => {
    const res = await runSlackSyncDev(deps());
    expect(JSON.stringify(res)).not.toContain(SENTINEL);
    expect(consoleDump.join("\n")).not.toContain(SENTINEL);
  });

  it("the summary carries no email/name/raw — only counts/booleans", async () => {
    const res = await runSlackSyncDev(deps());
    const blob = JSON.stringify(res);
    for (const bad of ["a@x.test", "Ada", "profile", "members", "xoxb"]) expect(blob).not.toContain(bad);
  });
});

describe("runSlackSyncDev — fail-closed + safe failures", () => {
  it("refuses outside local dev / without opt-in (run_disabled)", async () => {
    expect(await runSlackSyncDev(deps({ env: { NODE_ENV: "production" } }))).toEqual({ ok: false, errorCode: "run_disabled" });
  });
  it("missing tenant / observed_at fail safely", async () => {
    expect((await runSlackSyncDev(deps({ identity: { tenantId: "", connectorId: "c" } }))).ok).toBe(false);
    expect((await runSlackSyncDev(deps({ observedAt: "" }))).ok).toBe(false);
  });
  it("a token-source failure is safe (no token/raw in the error)", async () => {
    const bad = { async getProviderToken() { throw new Error(`boom ${SENTINEL}`); } };
    const res = await runSlackSyncDev(deps({ tokenSource: bad }));
    expect(res.ok).toBe(false);
    expect(JSON.stringify(res)).not.toContain(SENTINEL);
  });
  it.each([
    ["invalid_auth", jsonRes({ ok: false, error: "invalid_auth" })],
    ["missing_scope", jsonRes({ ok: false, error: "missing_scope" })],
    ["ratelimited", jsonRes({ ok: false }, 429, { "retry-after": "5" })],
    ["malformed", { ok: true, status: 200, json: async () => "nope" } as SlackHttpResponse],
  ] as [string, SlackHttpResponse][])("Slack failure surfaces ONLY the safe code: %s", async (_l, authRes) => {
    const client: SlackHttpClient = async (url) => (url.includes("auth.test") ? authRes : jsonRes({ ok: true, members: [] }));
    const res = await runSlackSyncDev(deps({ httpClient: client }));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(typeof res.errorCode).toBe("string");
  });
  it("a resolver/store write failure returns a safe resolve_failed (no row data / raw error)", async () => {
    const failStore = { ...memStore().store, async upsertApp() { throw new Error(`db blew up ${SENTINEL}`); } };
    const res = await runSlackSyncDev(deps({ store: failStore }));
    expect(res).toEqual({ ok: false, errorCode: "resolve_failed" });
    expect(JSON.stringify(res)).not.toContain(SENTINEL);
  });
});

describe("manual run is server-only, with no public route / server action / UI trigger added", () => {
  const SYNC = path.resolve(__dirname);
  const SRC = path.resolve(__dirname, "..", "..", "..");
  const modules = ["run-slack-sync-dev.ts", "dev-user-scoped-client.ts", "supabase-slack-resolver-store.ts"];
  const walk = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) return e.name === "node_modules" || e.name === ".next" ? [] : walk(full);
    return /\.(ts|tsx)$/.test(e.name) ? [full] : [];
  });

  it("each new module declares the server-only runtime sentinel (no-service-role is enforced repo-wide by check-auth-safety)", () => {
    for (const m of modules) {
      const src = fs.readFileSync(path.join(SYNC, m), "utf8");
      expect(src).toMatch(/server-only/);
      expect(src).toMatch(/globalThis[^\n]*window/);
    }
  });

  it("NO file under src/app imports the manual run / dev client / store (no route, no server action, no UI trigger)", () => {
    const hints = ["sync/run-slack-sync-dev", "sync/dev-user-scoped-client", "sync/supabase-slack-resolver-store"];
    const appDir = path.join(SRC, "app");
    const offenders = walk(appDir).filter((f) => { const s = fs.readFileSync(f, "utf8"); return hints.some((h) => s.includes(h)); });
    expect(offenders).toEqual([]);
  });
});
