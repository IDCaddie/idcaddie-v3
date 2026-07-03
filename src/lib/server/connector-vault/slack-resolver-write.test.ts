import { describe, it, expect } from "vitest";
import { emitSlackDiscoveryFacts } from "./slack-discovery-emitter";
import { applySlackDiscoveryResolution, type SlackResolverStore } from "./slack-resolver-write";

// Slack P0 PR 4 — resolver write path. UNIT layer: an in-memory store that models the DB natural-key upsert semantics
// (apps(tenant,external_instance), app_users(tenant,app,external_user), people(tenant,lower(email)),
// matches(tenant,app_user)) — so idempotency + tenant isolation behavior is provable. The DB-level enforcement (real
// RLS + real unique constraints + cross-tenant denial) is proven separately in supabase/tests/org_rls_test.sql.
const CTX = { observedAt: "2026-06-26T00:00:00.000Z" };
const WS = (teamId = "T1") => ({ ok: true as const, teamId, userId: "U_AUTH", teamName: "Acme", url: "https://acme.slack.com" });
const user = (over: Record<string, unknown> = {}) => ({
  slackUserId: "U1", teamId: "T1", email: "Ada@X.test", displayName: "Ada", title: "Eng", status: "active",
  roleHint: "member", isAdmin: false, isOwner: false, isPrimaryOwner: false, isRestricted: false,
  isUltraRestricted: false, isBot: false, isDeleted: false, lastActivityAt: 1700000000, timezone: "UTC",
  rawProvenance: { updated: 1700000000 }, ...over,
}) as unknown as Parameters<typeof emitSlackDiscoveryFacts>[0]["users"][number];

const factsFor = (tenant: string, users: unknown[], teamId = "T1") =>
  emitSlackDiscoveryFacts({ workspace: WS(teamId), users: users as Parameters<typeof emitSlackDiscoveryFacts>[0]["users"] }, tenant, CTX).facts;

function memStore() {
  const apps = new Map<string, Record<string, unknown>>(), appUsers = new Map<string, Record<string, unknown>>();
  const people = new Map<string, Record<string, unknown>>(), matches = new Map<string, string>();
  let a = 0, u = 0, p = 0;
  const store: SlackResolverStore = {
    async upsertApp(i) { const k = `${i.tenantId}:${i.externalInstanceId}`; if (!apps.has(k)) apps.set(k, { appId: `app-${++a}`, ...i }); else Object.assign(apps.get(k)!, i); return { appId: apps.get(k)!.appId as string }; },
    async upsertAppUser(i) { const k = `${i.tenantId}:${i.appId}:${i.externalUserId}`; if (!appUsers.has(k)) appUsers.set(k, { appUserId: `au-${++u}`, ...i }); else Object.assign(appUsers.get(k)!, i); if (i.lastSeenAt) appUsers.get(k)!.syncStatus = "active"; return { appUserId: appUsers.get(k)!.appUserId as string }; },
    async upsertPerson(i) { const k = `${i.tenantId}:${i.primaryEmail.toLowerCase()}`; if (!people.has(k)) people.set(k, { personId: `p-${++p}`, ...i }); else Object.assign(people.get(k)!, i); return { personId: people.get(k)!.personId as string }; },
    async getExistingMatchPersonId(i) { return matches.get(`${i.tenantId}:${i.appUserId}`) ?? null; },
    async insertMatch(i) { const k = `${i.tenantId}:${i.appUserId}`; if (matches.has(k)) return { created: false }; matches.set(k, i.personId); return { created: true }; }, // DO NOTHING — never overwrites
    // faithful UPDATE-only absence marking over the appUsers records: active rows of this tenant+app whose lastSeenAt
    // predates observedAt (or is unset) flip to stale. NEVER deletes a row.
    async markAbsentAppUsersStale(i) {
      let n = 0;
      for (const [k, rec] of appUsers) {
        if (!k.startsWith(`${i.tenantId}:${i.appId}:`)) continue;
        const seen = rec.lastSeenAt as string | undefined;
        const status = (rec.syncStatus as string | undefined) ?? "active";
        if (status === "active" && (!seen || seen < i.observedAt)) { rec.syncStatus = "stale"; n++; }
      }
      return { staleMarked: n };
    },
  };
  return { store, apps, appUsers, people, matches };
}

describe("slack-resolver-write — graph writes + idempotency", () => {
  it("writes app + app_user + person + match for a user with email", async () => {
    const { store, apps, appUsers, people, matches } = memStore();
    const sum = await applySlackDiscoveryResolution(store, "tenant-A", factsFor("tenant-A", [user()]));
    expect(sum).toMatchObject({ appsUpserted: 1, appUsersUpserted: 1, peopleUpserted: 1, matchesUpserted: 1 });
    expect(apps.size).toBe(1); expect(appUsers.size).toBe(1); expect(people.size).toBe(1); expect(matches.size).toBe(1);
    expect([...people.values()][0].primaryEmail).toBe("ada@x.test"); // normalized
  });

  it("is idempotent — running the SAME facts twice creates no duplicate rows", async () => {
    const { store, apps, appUsers, people, matches } = memStore();
    const facts = factsFor("tenant-A", [user(), user({ slackUserId: "U2", email: "bob@x.test" })]);
    await applySlackDiscoveryResolution(store, "tenant-A", facts);
    const second = await applySlackDiscoveryResolution(store, "tenant-A", facts);
    expect(apps.size).toBe(1); expect(appUsers.size).toBe(2); expect(people.size).toBe(2); expect(matches.size).toBe(2);
    expect(second.matchesUpserted).toBe(0); // re-run: match already exists (created=false), not re-counted
  });

  it("NEVER silently repoints an existing match to a different person (0028 deterministic-identity invariant)", async () => {
    const { store, matches, people } = memStore();
    await applySlackDiscoveryResolution(store, "tenant-A", factsFor("tenant-A", [user({ slackUserId: "U1", email: "first@x.test" })]));
    const personFirst = [...matches.values()][0];
    // re-sync: the SAME app_user (U1) now reports a DIFFERENT email → a different person
    const second = await applySlackDiscoveryResolution(store, "tenant-A", factsFor("tenant-A", [user({ slackUserId: "U1", email: "second@x.test" })]));
    expect(people.size).toBe(2); // both people exist
    expect([...matches.values()][0]).toBe(personFirst); // match UNCHANGED — not repointed to the new person
    expect(second.matchesUpserted).toBe(0);
    expect(second.matchConflicts).toBe(1); // surfaced for review, not overwritten
  });

  it("same Slack user id in TWO tenants creates SEPARATE rows (tenant is part of the key)", async () => {
    const { store, apps, appUsers, people } = memStore();
    await applySlackDiscoveryResolution(store, "tenant-A", factsFor("tenant-A", [user()]));
    await applySlackDiscoveryResolution(store, "tenant-B", factsFor("tenant-B", [user()]));
    expect(apps.size).toBe(2); expect(appUsers.size).toBe(2); expect(people.size).toBe(2); // no cross-tenant collision
    expect([...appUsers.keys()].some((k) => k.startsWith("tenant-A:"))).toBe(true);
    expect([...appUsers.keys()].some((k) => k.startsWith("tenant-B:"))).toBe(true);
  });
});

describe("slack-resolver-write — tenant safety + field rules", () => {
  it("a SPOOFED payload tenant_id is ignored — facts for another tenant write nothing", async () => {
    const { store, apps, appUsers } = memStore();
    const foreign = factsFor("tenant-EVIL", [user()]); // facts stamped with tenant-EVIL
    const sum = await applySlackDiscoveryResolution(store, "tenant-A", foreign); // authenticated as tenant-A
    expect(apps.size).toBe(0); expect(appUsers.size).toBe(0);
    expect(sum.appsUpserted).toBe(0); expect(sum.skipped).toBe(foreign.length);
  });

  it("every write uses the authenticated tenant — never a payload value", async () => {
    const { store, appUsers } = memStore();
    await applySlackDiscoveryResolution(store, "tenant-A", factsFor("tenant-A", [user()]));
    for (const row of appUsers.values()) expect(row.tenantId).toBe("tenant-A");
  });

  it("empty/missing authTenantId writes NOTHING (fail closed)", async () => {
    const { store, apps } = memStore();
    const sum = await applySlackDiscoveryResolution(store, "", factsFor("tenant-A", [user()]));
    expect(apps.size).toBe(0); expect(sum).toMatchObject({ appsUpserted: 0, appUsersUpserted: 0 });
  });

  it("app_user WITHOUT email still writes; no person/match created", async () => {
    const { store, appUsers, people, matches } = memStore();
    const sum = await applySlackDiscoveryResolution(store, "tenant-A", factsFor("tenant-A", [user({ email: undefined })]));
    expect(appUsers.size).toBe(1); // written
    expect(people.size).toBe(0); expect(matches.size).toBe(0); // no email → no person/match
    expect(sum).toMatchObject({ appUsersUpserted: 1, peopleUpserted: 0, matchesUpserted: 0 });
  });

  it("identity match is EXACT-EMAIL only — links the person to the SAME app_user, no name/fuzzy merge", async () => {
    const { store, matches, appUsers, people } = memStore();
    await applySlackDiscoveryResolution(store, "tenant-A", factsFor("tenant-A", [user({ slackUserId: "U1", email: "same@x.test" }), user({ slackUserId: "U2", email: "same@x.test", displayName: "Different Name" })]));
    // two app_users, but the same email → ONE person; each app_user matched to that person by exact email (one-per-app_user key)
    expect(appUsers.size).toBe(2); expect(people.size).toBe(1); expect(matches.size).toBe(2);
    expect(new Set(matches.values()).size).toBe(1); // both matches point at the single person
  });

  it("admin role rides app_user.raw_payload provenance (no role table) — gap recorded; plain member gets no admin row", async () => {
    const { store, appUsers } = memStore();
    const sum = await applySlackDiscoveryResolution(store, "tenant-A", factsFor("tenant-A", [user({ slackUserId: "U_ADMIN", isAdmin: true, roleHint: "admin" }), user({ slackUserId: "U_PLAIN" })]));
    const admin = [...appUsers.values()].find((r) => r.externalUserId === "U_ADMIN")!;
    expect((admin.rawProvenance as Record<string, unknown>).role_hint).toBe("admin");
    const plain = [...appUsers.values()].find((r) => r.externalUserId === "U_PLAIN")!;
    expect((plain.rawProvenance as Record<string, unknown>).role_hint).toBe("member");
    expect(sum.gaps.some((g) => g.includes("role_admin"))).toBe(true); // documented gap (no role column)
  });

  it("usage last-active lands on app_user.last_active_at (no usage table)", async () => {
    const { store, appUsers } = memStore();
    await applySlackDiscoveryResolution(store, "tenant-A", factsFor("tenant-A", [user()]));
    expect([...appUsers.values()][0].lastActiveAt).toBe("2023-11-14T22:13:20.000Z");
  });

  it("never persists a token / raw Slack object — raw_payload is only sanitized scalars", async () => {
    const { store, appUsers } = memStore();
    await applySlackDiscoveryResolution(store, "tenant-A", factsFor("tenant-A", [user({ token: "xoxb-evil", access_token: "s" })]));
    const blob = JSON.stringify([...appUsers.values()]);
    for (const bad of ["xoxb-evil", "access_token", "Bearer "]) expect(blob).not.toContain(bad);
    expect(Object.keys([...appUsers.values()][0].rawProvenance as object).sort()).toEqual(["provider", "role_hint"]);
  });

  it("unsupported/empty fact set is safe; bots never reach the graph", async () => {
    const { store, apps } = memStore();
    await applySlackDiscoveryResolution(store, "tenant-A", []); // no facts
    expect(apps.size).toBe(0);
    const onlyBots = await applySlackDiscoveryResolution(store, "tenant-A", factsFor("tenant-A", [user({ isBot: true })]));
    expect(apps.size).toBe(1); expect(onlyBots.appUsersUpserted).toBe(0); // app exists, no bot app_users
  });
});

// 0040 ABSENCE / STALE MARKING — non-destructive, post-success-only, tenant+app-scoped.
describe("applySlackDiscoveryResolution — absence/stale marking (0040)", () => {
  const T1 = "2026-06-26T00:00:00.000Z", T2 = "2026-06-27T00:00:00.000Z", T3 = "2026-06-28T00:00:00.000Z";
  const factsAt = (tenant: string, users: unknown[], observedAt: string) =>
    emitSlackDiscoveryFacts({ workspace: WS(), users: users as Parameters<typeof emitSlackDiscoveryFacts>[0]["users"] }, tenant, { observedAt }).facts;
  const rec = (appUsers: Map<string, Record<string, unknown>>, ext: string) => [...appUsers.values()].find((r) => r.externalUserId === ext);
  const u1 = (o = {}) => user({ slackUserId: "U1", email: "u1@x.test", ...o });
  const u2 = (o = {}) => user({ slackUserId: "U2", email: "u2@x.test", ...o });

  it("present users get last_seen_at + sync_status active; nothing marked stale on the first sync", async () => {
    const { store, appUsers } = memStore();
    const s = await applySlackDiscoveryResolution(store, "tenant-A", factsAt("tenant-A", [u1(), u2()], T1));
    expect(s.staleMarked).toBe(0);
    expect(rec(appUsers, "U1")).toMatchObject({ lastSeenAt: T1, syncStatus: "active" });
    expect(rec(appUsers, "U2")).toMatchObject({ lastSeenAt: T1, syncStatus: "active" });
  });

  it("a SECOND sync missing a prior user marks ONLY that user stale (row kept, last_seen_at preserved)", async () => {
    const { store, appUsers } = memStore();
    await applySlackDiscoveryResolution(store, "tenant-A", factsAt("tenant-A", [u1(), u2()], T1));
    const s2 = await applySlackDiscoveryResolution(store, "tenant-A", factsAt("tenant-A", [u2()], T2)); // U1 absent
    expect(s2.staleMarked).toBe(1);
    expect(rec(appUsers, "U1")).toMatchObject({ syncStatus: "stale", lastSeenAt: T1 }); // marked, NOT deleted, last-seen kept
    expect(rec(appUsers, "U2")).toMatchObject({ syncStatus: "active", lastSeenAt: T2 });
    expect(appUsers.size).toBe(2); // both rows still present — no hard delete
  });

  it("re-running the same second sync is idempotent — 0 newly marked", async () => {
    const { store } = memStore();
    await applySlackDiscoveryResolution(store, "tenant-A", factsAt("tenant-A", [u1(), u2()], T1));
    await applySlackDiscoveryResolution(store, "tenant-A", factsAt("tenant-A", [u2()], T2));
    const again = await applySlackDiscoveryResolution(store, "tenant-A", factsAt("tenant-A", [u2()], T2));
    expect(again.staleMarked).toBe(0); // U1 already stale; U2 seen
  });

  it("a returning stale user REACTIVATES (stale is reversible)", async () => {
    const { store, appUsers } = memStore();
    await applySlackDiscoveryResolution(store, "tenant-A", factsAt("tenant-A", [u1(), u2()], T1));
    await applySlackDiscoveryResolution(store, "tenant-A", factsAt("tenant-A", [u2()], T2)); // U1 → stale
    await applySlackDiscoveryResolution(store, "tenant-A", factsAt("tenant-A", [u1(), u2()], T3)); // U1 returns
    expect(rec(appUsers, "U1")).toMatchObject({ syncStatus: "active", lastSeenAt: T3 });
  });

  it("a 0-user (present-count 0) successful sync marks NOTHING stale (guard)", async () => {
    const { store, appUsers } = memStore();
    await applySlackDiscoveryResolution(store, "tenant-A", factsAt("tenant-A", [u1()], T1));
    const empty = await applySlackDiscoveryResolution(store, "tenant-A", factsAt("tenant-A", [], T2)); // workspace only, no users
    expect(empty.appUsersUpserted).toBe(0);
    expect(empty.staleMarked).toBe(0); // guard: never mass-mark on a 0-user sync
    expect(rec(appUsers, "U1")).toMatchObject({ syncStatus: "active" }); // U1 untouched
  });

  it("an INCOMPLETE fetch (syncComplete=false) skips stale marking — present users are still upserted (non-destructive)", async () => {
    const { store, appUsers } = memStore();
    await applySlackDiscoveryResolution(store, "tenant-A", factsAt("tenant-A", [u1(), u2()], T1)); // both active
    // second sync: U1 absent, but the provider fetch was truncated → syncComplete=false → do NOT mark U1 stale
    const s2 = await applySlackDiscoveryResolution(store, "tenant-A", factsAt("tenant-A", [u2()], T2), { syncComplete: false });
    expect(s2.staleMarked).toBe(0);
    expect(rec(appUsers, "U1")).toMatchObject({ syncStatus: "active" }); // absent-but-untruncated-unknown → left active
    expect(rec(appUsers, "U2")).toMatchObject({ syncStatus: "active", lastSeenAt: T2 }); // present user still written
    // a COMPLETE re-run of the same absence THEN marks it (proves the gate, not a permanent skip)
    const s3 = await applySlackDiscoveryResolution(store, "tenant-A", factsAt("tenant-A", [u2()], T2), { syncComplete: true });
    expect(s3.staleMarked).toBe(1);
    expect(rec(appUsers, "U1")).toMatchObject({ syncStatus: "stale" });
  });

  it("a mid-resolve store failure aborts BEFORE marking — nothing is marked stale (failed/partial sync)", async () => {
    const { store, appUsers } = memStore();
    await applySlackDiscoveryResolution(store, "tenant-A", factsAt("tenant-A", [u1(), u2()], T1)); // both active
    // second run: the person upsert throws partway — the resolver rejects before reaching markAbsentAppUsersStale
    const boom = { ...store, async upsertPerson(): Promise<{ personId: string }> { throw new Error("db down"); } };
    let threw = false;
    try { await applySlackDiscoveryResolution(boom, "tenant-A", factsAt("tenant-A", [u2()], T2)); } catch { threw = true; }
    expect(threw).toBe(true);
    expect(rec(appUsers, "U1")).toMatchObject({ syncStatus: "active" }); // NOT marked stale — the failed sync marked nothing
  });

  it("a Slack-DELETED user (still returned) stays ACTIVE with raw_payload.slack_is_deleted=true — distinct from absent", async () => {
    const { store, appUsers } = memStore();
    // U1 present-and-deleted-in-Slack; U2 present-normal. Then U2 leaves (absent) while U1 stays deleted-but-present.
    await applySlackDiscoveryResolution(store, "tenant-A", factsAt("tenant-A", [u1({ isDeleted: true }), u2()], T1));
    const s2 = await applySlackDiscoveryResolution(store, "tenant-A", factsAt("tenant-A", [u1({ isDeleted: true })], T2)); // U2 absent
    expect(rec(appUsers, "U1")).toMatchObject({ syncStatus: "active", lastSeenAt: T2 }); // deleted-but-present ⇒ ACTIVE
    expect((rec(appUsers, "U1")!.rawProvenance as Record<string, unknown>).slack_is_deleted).toBe(true);
    expect(rec(appUsers, "U2")).toMatchObject({ syncStatus: "stale" }); // ABSENT ⇒ stale (the distinct state)
    expect(s2.staleMarked).toBe(1);
  });
});
