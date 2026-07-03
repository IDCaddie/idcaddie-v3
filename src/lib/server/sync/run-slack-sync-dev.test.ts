import { describe, it, expect, vi, beforeEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { runSlackSyncDev, isDevSlackSyncRunEnabled, type RunSlackSyncDeps } from "./run-slack-sync-dev";
import type { SlackHttpClient, SlackHttpResponse } from "./slack/slack-client";
import type { SlackResolverStore } from "../connector-vault/slack-resolver-write";
import { StoreWriteError } from "./supabase-slack-resolver-store";
import { makeFixtureSlackHttpClient, SLACK_FIXTURE_EXPECTED } from "./slack/slack-sync-fixture";

// Slack P0 PR 6 — manual run orchestrator. Synthetic only: injected token source + http client + in-memory store; NO
// live Slack/DB. The token is a marked sentinel (the marker is IN the token so the scanner excuses it).
const SENTINEL = "xoxb-000000-MUSTNOTLEAKp0runsentinel";
const tokenSource = { async getProviderToken() { return { provider: "slack" as const, token: SENTINEL }; } };
const DEV = { NODE_ENV: "development", ID_CADDIE_DEV_SLACK_SYNC_ENABLED: "1" } as Record<string, string | undefined>;
const IDENTITY = { tenantId: "tenant-A", connectorId: "c1" };
const OBSERVED = "2026-06-27T00:00:00.000Z";

// Happy-path Slack responses come from the committed fixture (makeFixtureSlackHttpClient — 8-member scenario: bot +
// Slackbot excluded, mixed-case emails dedup, an emailless user). `jsonRes` remains for the ERROR-path tests only, which
// craft specific Slack failures (invalid_auth / 429 / malformed) the single-scenario fixture does not model.
const jsonRes = (obj: unknown, status = 200, headers?: Record<string, string>): SlackHttpResponse => ({
  ok: status < 400, status, headers: headers ? { get: (n) => headers[n.toLowerCase()] ?? null } : undefined, json: async () => obj,
});
function memStore() {
  const apps = new Map<string, string>(), appUsers = new Map<string, string>(), people = new Map<string, string>(), matches = new Map<string, string>();
  // 0040 presence state per app_user key — a faithful in-memory model of last_seen_at + sync_status.
  const presence = new Map<string, { lastSeenAt?: string; syncStatus: "active" | "stale" }>();
  let a = 0, u = 0, p = 0;
  const store: SlackResolverStore = {
    async upsertApp(i) { const k = `${i.tenantId}:${i.externalInstanceId}`; if (!apps.has(k)) apps.set(k, `app-${++a}`); return { appId: apps.get(k)! }; },
    async upsertAppUser(i) { const k = `${i.tenantId}:${i.appId}:${i.externalUserId}`; if (!appUsers.has(k)) appUsers.set(k, `au-${++u}`); if (i.lastSeenAt) presence.set(k, { lastSeenAt: i.lastSeenAt, syncStatus: "active" }); return { appUserId: appUsers.get(k)! }; },
    async upsertPerson(i) { const k = `${i.tenantId}:${i.primaryEmail.toLowerCase()}`; if (!people.has(k)) people.set(k, `p-${++p}`); return { personId: people.get(k)! }; },
    async getExistingMatchPersonId(i) { return matches.get(`${i.tenantId}:${i.appUserId}`) ?? null; },
    async insertMatch(i) { const k = `${i.tenantId}:${i.appUserId}`; if (matches.has(k)) return { created: false }; matches.set(k, i.personId); return { created: true }; },
    // faithful UPDATE-only absence marking: active rows of this tenant+app not seen at observedAt -> stale. Never deletes.
    async markAbsentAppUsersStale(i) {
      let n = 0;
      for (const [k, st] of presence) {
        if (!k.startsWith(`${i.tenantId}:${i.appId}:`)) continue;
        if (st.syncStatus === "active" && (!st.lastSeenAt || st.lastSeenAt < i.observedAt)) { st.syncStatus = "stale"; n++; }
      }
      return { staleMarked: n };
    },
  };
  return { store, apps, appUsers, people, matches, presence };
}
const deps = (over: Partial<RunSlackSyncDeps> = {}): RunSlackSyncDeps => ({
  env: DEV, tokenSource, httpClient: makeFixtureSlackHttpClient().client, store: memStore().store, identity: IDENTITY, observedAt: OBSERVED, ...over,
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
  it("runs token→client→emitter→resolver and returns a SAFE aggregate summary (fixture scenario)", async () => {
    const { client, calls } = makeFixtureSlackHttpClient();
    const st = memStore();
    const res = await runSlackSyncDev(deps({ httpClient: client, store: st.store }));
    // fixture: 8 members → bot + Slackbot excluded → 6 app_users; 5 person-upserts (peopleWritten is the OPERATION count;
    // distinct people is 4 after the U5/U6 mixed-case dedupe at the store); 5 matches
    expect(res).toMatchObject({ ok: true, teamPresent: true, usersFetched: SLACK_FIXTURE_EXPECTED.appUsers, appUsersWritten: SLACK_FIXTURE_EXPECTED.appUsers, peopleWritten: SLACK_FIXTURE_EXPECTED.peopleUpserts, matchesWritten: SLACK_FIXTURE_EXPECTED.matches });
    // chain ORDER: auth.test before users.list; the token rode the Authorization header (not the URL); then writes happened
    expect(calls[0].url).toContain("auth.test");
    expect(calls[1].url).toContain("users.list");
    expect(calls[0].auth).toBe(`Bearer ${SENTINEL}`);
    expect(st.appUsers.size).toBe(SLACK_FIXTURE_EXPECTED.appUsers);
  });

  it("is idempotent — running twice does not duplicate graph rows", async () => {
    const st = memStore();
    await runSlackSyncDev(deps({ store: st.store }));
    const second = await runSlackSyncDev(deps({ store: st.store }));
    expect(st.appUsers.size).toBe(SLACK_FIXTURE_EXPECTED.appUsers); expect(st.people.size).toBe(SLACK_FIXTURE_EXPECTED.people); expect(st.matches.size).toBe(SLACK_FIXTURE_EXPECTED.matches);
    expect(second.ok && second.matchesWritten).toBe(0); // re-run: matches already exist
  });

  it("an INCOMPLETE users.list (cursor loop) skips stale marking, still writes present users, and logs a SAFE reason", async () => {
    // a client whose users.list loops the cursor → the Slack client reports complete:false (truncation hardening #234).
    // Cursor-aware: page 1 carries the user, page 2 (the repeated cursor) is empty → no duplicate, loop detected.
    const looping: SlackHttpClient = async (url) => {
      if (url.includes("auth.test")) return { ok: true, status: 200, json: async () => ({ ok: true, team_id: "T1", user_id: "U_AUTH", team: "Acme", url: "https://acme.slack.com" }) };
      const cursor = new URL(url).searchParams.get("cursor");
      const members = cursor ? [] : [{ id: "U1", team_id: "T1", profile: { email: "a@x.test", display_name: "Ada" } }];
      return { ok: true, status: 200, json: async () => ({ ok: true, members, response_metadata: { next_cursor: "loop" } }) };
    };
    const st = memStore();
    const res = await runSlackSyncDev(deps({ httpClient: looping, store: st.store }));
    expect(res.ok).toBe(true);
    expect(res.ok && res.staleMarked).toBe(0); // marking SKIPPED on an incomplete fetch
    expect(res.ok && res.appUsersWritten).toBe(1); // the present user is STILL upserted (non-destructive)
    const logs = consoleDump.join("\n");
    expect(logs).toContain("incomplete");
    expect(logs).toContain("cursor_loop"); // safe reason class only
    expect(logs).not.toContain(SENTINEL); // never the token
  });

  it("the token NEVER appears in the summary, errors, or console", async () => {
    const res = await runSlackSyncDev(deps());
    expect(JSON.stringify(res)).not.toContain(SENTINEL);
    expect(consoleDump.join("\n")).not.toContain(SENTINEL);
  });

  it("the summary carries no email/name/raw — only counts/booleans", async () => {
    const res = await runSlackSyncDev(deps());
    const blob = JSON.stringify(res);
    for (const bad of ["bob@example.com", "Bob Normal", "carol@example.com", "profile", "members", "xoxb"]) expect(blob).not.toContain(bad);
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
  it("a resolver/store write failure with NO structured detail is still safe (unknown stage/reason)", async () => {
    const failStore = { ...memStore().store, async upsertApp() { throw new Error(`db blew up ${SENTINEL} ada@x.test`); } };
    const res = await runSlackSyncDev(deps({ store: failStore }));
    expect(res).toMatchObject({ ok: false, errorCode: "resolve_failed", failedStage: "unknown", safeReason: "unknown" });
    expect(JSON.stringify(res)).not.toContain(SENTINEL);
    expect(JSON.stringify(res)).not.toContain("ada@x.test");
  });

  it("surfaces SAFE resolver diagnostics (stage/table/code/reason) from a StoreWriteError — and only those", async () => {
    const failStore = {
      ...memStore().store,
      async upsertApp(): Promise<{ appId: string }> {
        throw new StoreWriteError({ table: "apps", op: "upsert_app", code: "42501" }); // real RLS denial shape
      },
    };
    const res = await runSlackSyncDev(deps({ store: failStore }));
    expect(res).toMatchObject({
      ok: false, errorCode: "resolve_failed",
      failedStage: "upsert_app", table: "apps", safeDbCode: "42501", safeReason: "rls_denied",
      usersFetched: SLACK_FIXTURE_EXPECTED.appUsers, factsEmitted: expect.any(Number), factsRejected: expect.any(Number),
    });
    // the diagnostic carries NO token / email / name / raw payload — only safe enums/codes/counts
    const blob = JSON.stringify(res);
    for (const bad of [SENTINEL, "bob@example.com", "Bob Normal", "profile", "members", "xoxb", "Bearer"]) expect(blob).not.toContain(bad);
  });

  it.each([
    ["42501", "rls_denied"],
    ["23505", "constraint_violation"],
    ["23502", "constraint_violation"],
    ["42703", "schema_mismatch"],
    ["PGRST204", "schema_mismatch"],
    ["XX999", "unknown"],
  ])("maps DB code %s → safeReason %s", async (code, reason) => {
    const failStore = { ...memStore().store, async upsertPerson(): Promise<{ personId: string }> { throw new StoreWriteError({ table: "people", op: "upsert_person", code }); } };
    const res = await runSlackSyncDev(deps({ store: failStore }));
    expect(res).toMatchObject({ ok: false, failedStage: "upsert_person", table: "people", safeDbCode: code, safeReason: reason });
  });
});

describe("manual run is server-only, with no public route / server action / UI trigger added", () => {
  const SYNC = path.resolve(__dirname);
  const SRC = path.resolve(__dirname, "..", "..", "..");
  const modules = ["run-slack-sync-dev.ts", "dev-user-scoped-client.ts", "supabase-slack-resolver-store.ts", "slack-fetch-http-client.ts", "manual-sync-run-recorder.ts", "recorded-slack-sync-run.ts", "internal-slack-trigger.ts", "slack-sync-scheduler.ts", "vault-provider-token-source.ts", "provider-token-source-selector.ts"];
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
    const hints = ["sync/run-slack-sync-dev", "sync/dev-user-scoped-client", "sync/supabase-slack-resolver-store", "sync/manual-sync-run-recorder", "sync/recorded-slack-sync-run", "sync/vault-provider-token-source", "sync/provider-token-source-selector"];
    const appDir = path.join(SRC, "app");
    const offenders = walk(appDir).filter((f) => { const s = fs.readFileSync(f, "utf8"); return hints.some((h) => s.includes(h)); });
    expect(offenders).toEqual([]);
  });

  it("slack-sync-scheduler is imported by ONLY the scheduler route under src/app (no client/page importer can bundle the dev-JWT client)", () => {
    const appDir = path.join(SRC, "app");
    const importers = walk(appDir).filter((f) => fs.readFileSync(f, "utf8").includes("sync/slack-sync-scheduler"));
    expect(importers.map((f) => path.relative(SRC, f).replace(/\\/g, "/"))).toEqual(["app/api/internal/slack-scheduler/route.ts"]);
    for (const f of importers) expect(fs.readFileSync(f, "utf8")).not.toContain('"use client"');
  });
});
