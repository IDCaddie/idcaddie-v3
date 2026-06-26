import { describe, it, expect, vi, beforeEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  createSlackClient,
  normalizeSlackUser,
  SlackApiError,
  type SlackHttpClient,
  type SlackHttpResponse,
} from "./slack-client";

// Slack P0 PR 2 — server-only Slack client, verified in ISOLATION with MOCKED responses (no real network). Token is a
// marked synthetic sentinel (the marker is IN the token so the scanner excuses it).
const SENTINEL_TOKEN = "xoxb-000000-MUSTNOTLEAKp0apiclientsentinel";
const tokenSource = { async getProviderToken() { return { provider: "slack" as const, token: SENTINEL_TOKEN }; } };
const identity = { tenantId: "t1", connectorId: "c1" };

type Route = (url: string) => SlackHttpResponse | Promise<SlackHttpResponse>;
const jsonRes = (obj: unknown, status = 200, headers?: Record<string, string>): SlackHttpResponse => ({
  ok: status < 400, status, headers: headers ? { get: (n) => headers[n.toLowerCase()] ?? null } : undefined, json: async () => obj,
});
function mockHttp(route: Route): { client: SlackHttpClient; calls: { url: string; headers: Record<string, string> }[] } {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  const client: SlackHttpClient = async (url, init) => { calls.push({ url, headers: init.headers }); return route(url); };
  return { client, calls };
}
const member = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: "U001", team_id: "T1", deleted: false, is_admin: false, is_owner: false, is_primary_owner: false,
  is_restricted: false, is_ultra_restricted: false, is_bot: false, has_2fa: true, has_sso: false, tz: "America/Toronto",
  tz_offset: -14400, color: "9f69e7", updated: 1700000000,
  profile: { email: "a@x.test", display_name: "Ada", real_name: "Ada L", title: "Eng", status_text: "coding" }, ...over,
});

let consoleDump: string[];
beforeEach(() => {
  consoleDump = [];
  for (const m of ["log", "info", "warn", "error", "debug"] as const)
    vi.spyOn(console, m).mockImplementation((...a: unknown[]) => { consoleDump.push(a.map(String).join(" ")); });
});

describe("slack-client — auth.test + users.list (mocked)", () => {
  it("auth.test success returns safe ids; sends the token in the Authorization header (not the URL)", async () => {
    const { client, calls } = mockHttp(() => jsonRes({ ok: true, team_id: "T1", user_id: "U1", team: "Acme", url: "https://acme.slack.com" }));
    const res = await createSlackClient({ tokenSource, httpClient: client, identity }).authTest();
    expect(res).toEqual({ ok: true, teamId: "T1", userId: "U1", teamName: "Acme", url: "https://acme.slack.com" });
    expect(calls[0].headers.Authorization).toBe(`Bearer ${SENTINEL_TOKEN}`); // token in header...
    expect(calls[0].url).not.toContain(SENTINEL_TOKEN); // ...never in the URL
  });

  it("auth.test failure (ok:false) throws a SlackApiError carrying ONLY the safe code", async () => {
    const { client } = mockHttp(() => jsonRes({ ok: false, error: "invalid_auth" }));
    await expect(createSlackClient({ tokenSource, httpClient: client, identity }).authTest())
      .rejects.toMatchObject({ name: "SlackApiError", code: "invalid_auth" });
  });

  it("users.list success normalizes the allowlisted fields", async () => {
    const { client } = mockHttp(() => jsonRes({ ok: true, members: [member()] }));
    const users = await createSlackClient({ tokenSource, httpClient: client, identity }).listUsers();
    expect(users).toHaveLength(1);
    expect(users[0]).toMatchObject({ slackUserId: "U001", teamId: "T1", email: "a@x.test", displayName: "Ada", title: "Eng", status: "coding", roleHint: "member", has2fa: true, timezone: "America/Toronto", isDeleted: false });
  });

  it("paginates via response_metadata.next_cursor", async () => {
    let page = 0;
    const { client } = mockHttp((url) => {
      if (url.includes("users.list")) {
        page++;
        return page === 1
          ? jsonRes({ ok: true, members: [member({ id: "U001" })], response_metadata: { next_cursor: "CUR2" } })
          : jsonRes({ ok: true, members: [member({ id: "U002" })], response_metadata: { next_cursor: "" } });
      }
      return jsonRes({ ok: false, error: "unknown_method" });
    });
    const users = await createSlackClient({ tokenSource, httpClient: client, identity }).listUsers();
    expect(users.map((u) => u.slackUserId)).toEqual(["U001", "U002"]);
    expect(page).toBe(2);
  });

  it.each([
    ["invalid_auth", jsonRes({ ok: false, error: "invalid_auth" })],
    ["missing_scope", jsonRes({ ok: false, error: "missing_scope" })],
    ["unknown_error (ok:false, no error field)", jsonRes({ ok: false })],
  ] as [string, SlackHttpResponse][])("ok:false surfaces the safe code: %s", async (_l, res) => {
    const { client } = mockHttp(() => res);
    await expect(createSlackClient({ tokenSource, httpClient: client, identity }).listUsers()).rejects.toBeInstanceOf(SlackApiError);
  });

  it("rate limit: 429 throws ratelimited with Retry-After seconds", async () => {
    const { client } = mockHttp(() => jsonRes({ ok: false }, 429, { "retry-after": "30" }));
    await expect(createSlackClient({ tokenSource, httpClient: client, identity }).listUsers())
      .rejects.toMatchObject({ code: "ratelimited", retryAfterSeconds: 30 });
  });

  it.each([["-5"], ["abc"], ["0"], ["Wed, 21 Oct 2026 07:28:00 GMT"]])(
    "Retry-After %s is sanitized to undefined (positive int only)", async (ra) => {
    const { client } = mockHttp(() => jsonRes({ ok: false }, 429, { "retry-after": ra }));
    await expect(createSlackClient({ tokenSource, httpClient: client, identity }).listUsers())
      .rejects.toMatchObject({ code: "ratelimited", retryAfterSeconds: undefined });
  });

  it("a REPEATING next_cursor breaks the loop (no duplicate-record loop)", async () => {
    const { client } = mockHttp(() => jsonRes({ ok: true, members: [member({ id: "U001" })], response_metadata: { next_cursor: "SAME" } }));
    const users = await createSlackClient({ tokenSource, httpClient: client, identity }).listUsers();
    expect(users.map((u) => u.slackUserId)).toEqual(["U001", "U001"]); // page 1 (cursor SAME) + page 2 (cursor SAME → break), not 100×
  });

  it.each([
    ["non-object body", { ok: true, status: 200, json: async () => "not-json" } as SlackHttpResponse],
    ["json() throws", { ok: true, status: 200, json: async () => { throw new Error("boom"); } } as SlackHttpResponse],
    ["no json fn", { ok: true, status: 200 } as unknown as SlackHttpResponse],
    ["auth.test missing team_id", jsonRes({ ok: true, user_id: "U1" })],
  ] as [string, SlackHttpResponse][])("malformed response fails closed: %s", async (_l, res) => {
    const { client } = mockHttp(() => res);
    await expect(createSlackClient({ tokenSource, httpClient: client, identity }).authTest()).rejects.toBeInstanceOf(SlackApiError);
  });

  it("http client throwing → safe http_error (no caught error surfaced)", async () => {
    const client: SlackHttpClient = async () => { throw new Error(`network fail ${SENTINEL_TOKEN}`); };
    await expect(createSlackClient({ tokenSource, httpClient: client, identity }).authTest())
      .rejects.toMatchObject({ code: "http_error" });
  });
});

describe("slack-client — P0 filtering + normalization edges", () => {
  it("filters bots by default (incl. USLACKBOT); includeBots opts back in", async () => {
    const route: Route = () => jsonRes({ ok: true, members: [member({ id: "U001" }), member({ id: "B1", is_bot: true }), member({ id: "USLACKBOT", is_bot: false })] });
    const filtered = await createSlackClient({ tokenSource, httpClient: mockHttp(route).client, identity }).listUsers();
    expect(filtered.map((u) => u.slackUserId)).toEqual(["U001"]); // both bots removed (USLACKBOT by id)
    const all = await createSlackClient({ tokenSource, httpClient: mockHttp(route).client, identity }, { includeBots: true }).listUsers();
    expect(all.map((u) => u.slackUserId).sort()).toEqual(["B1", "U001", "USLACKBOT"]);
  });

  it("user missing email normalizes with email undefined (not empty string)", () => {
    const rec = normalizeSlackUser(member({ profile: { real_name: "NoMail" } }));
    expect(rec?.email).toBeUndefined();
    expect(rec?.displayName).toBe("NoMail"); // falls back to real_name
  });

  it("deleted + restricted + ultra-restricted flags are explicit", () => {
    expect(normalizeSlackUser(member({ deleted: true }))?.isDeleted).toBe(true);
    expect(normalizeSlackUser(member({ is_restricted: true }))).toMatchObject({ isRestricted: true, roleHint: "restricted" });
    expect(normalizeSlackUser(member({ is_ultra_restricted: true }))).toMatchObject({ isUltraRestricted: true, roleHint: "ultra_restricted" });
    expect(normalizeSlackUser(member({ is_primary_owner: true, is_owner: true, is_admin: true }))?.roleHint).toBe("primary_owner");
  });

  it("a member with no id is dropped; malformed members are skipped", async () => {
    const { client } = mockHttp(() => jsonRes({ ok: true, members: [{ no_id: true }, null, "str", member({ id: "U9" })] }));
    const users = await createSlackClient({ tokenSource, httpClient: client, identity }).listUsers();
    expect(users.map((u) => u.slackUserId)).toEqual(["U9"]);
  });

  it("NO raw spread: hostile extra fields (token/secret/raw object) never reach the normalized record", () => {
    const rec = normalizeSlackUser(member({ token: "xoxb-evil", secret_field: "s", arbitrary: { a: 1 }, profile: { email: "a@x.test", api_token: "xoxp-evil" } })) as Record<string, unknown>;
    const allowed = ["slackUserId", "teamId", "email", "displayName", "title", "status", "roleHint", "isAdmin", "isOwner", "isPrimaryOwner", "isRestricted", "isUltraRestricted", "isBot", "isDeleted", "has2fa", "hasSso", "lastActivityAt", "timezone", "rawProvenance"];
    expect(Object.keys(rec).sort()).toEqual([...allowed].sort());
    expect(JSON.stringify(rec)).not.toContain("xoxb-evil");
    expect(JSON.stringify(rec)).not.toContain("xoxp-evil");
    expect(JSON.stringify(rec)).not.toContain("secret_field");
    // rawProvenance is ONLY the allowlisted scalars:
    expect(Object.keys((rec.rawProvenance as object) ?? {}).sort()).toEqual(["color", "tzOffset", "updated"]);
  });
});

describe("slack-client — token secrecy + no real network", () => {
  it("the token never appears in normalized records, errors, or console", async () => {
    const { client } = mockHttp(() => jsonRes({ ok: true, members: [member()] }));
    const users = await createSlackClient({ tokenSource, httpClient: client, identity }).listUsers();
    expect(JSON.stringify(users)).not.toContain(SENTINEL_TOKEN);
    // every error path: code only, never the token
    for (const res of [jsonRes({ ok: false, error: "invalid_auth" }), jsonRes("x"), jsonRes({ ok: false }, 429, { "retry-after": "1" })]) {
      try { await createSlackClient({ tokenSource, httpClient: mockHttp(() => res).client, identity }).authTest(); }
      catch (e) { expect((e as Error).message).not.toContain(SENTINEL_TOKEN); expect(JSON.stringify(e)).not.toContain(SENTINEL_TOKEN); }
    }
    expect(consoleDump.join("\n")).not.toContain(SENTINEL_TOKEN);
  });

  it("makes NO real network call — global fetch is never invoked (only the injected client)", async () => {
    const fetchSpy = vi.fn(() => { throw new Error("real network forbidden in tests"); });
    const orig = globalThis.fetch;
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    try {
      const { client } = mockHttp(() => jsonRes({ ok: true, members: [member()] }));
      await createSlackClient({ tokenSource, httpClient: client, identity }).listUsers();
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      globalThis.fetch = orig;
    }
  });
});

describe("slack-client — server-only boundary", () => {
  const SRC = path.resolve(__dirname, "..", "..", "..", "..", "..", "src");
  const HINTS = ["server/sync/slack/slack-client", "lib/server/sync/slack/slack-client"];
  const walk = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) return e.name === "node_modules" || e.name === ".next" ? [] : walk(full);
    return /\.(ts|tsx)$/.test(e.name) ? [full] : [];
  });
  const imports = (s: string) => HINTS.some((h) => s.includes(h));

  it('no "use client" file and no src/app file imports the slack client', () => {
    const files = walk(SRC).filter((f) => !f.includes(path.join("sync", "slack", "slack-client")));
    const offenders = files.filter((f) => {
      const s = fs.readFileSync(f, "utf8");
      return (/^\s*["']use client["']/m.test(s) || f.startsWith(path.join(SRC, "app"))) && imports(s);
    });
    expect(offenders).toEqual([]);
  });

  it("the module declares its server-only runtime sentinel", () => {
    const src = fs.readFileSync(path.join(SRC, "lib", "server", "sync", "slack", "slack-client.ts"), "utf8");
    expect(src).toMatch(/server-only/);
    expect(src).toMatch(/globalThis[^\n]*window/);
  });
});
