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
    async upsertAppUser(i) { const k = `${i.tenantId}:${i.appId}:${i.externalUserId}`; if (!appUsers.has(k)) appUsers.set(k, { appUserId: `au-${++u}`, ...i }); else Object.assign(appUsers.get(k)!, i); return { appUserId: appUsers.get(k)!.appUserId as string }; },
    async upsertPerson(i) { const k = `${i.tenantId}:${i.primaryEmail.toLowerCase()}`; if (!people.has(k)) people.set(k, { personId: `p-${++p}`, ...i }); else Object.assign(people.get(k)!, i); return { personId: people.get(k)!.personId as string }; },
    async getExistingMatchPersonId(i) { return matches.get(`${i.tenantId}:${i.appUserId}`) ?? null; },
    async insertMatch(i) { const k = `${i.tenantId}:${i.appUserId}`; if (matches.has(k)) return { created: false }; matches.set(k, i.personId); return { created: true }; }, // DO NOTHING — never overwrites
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
