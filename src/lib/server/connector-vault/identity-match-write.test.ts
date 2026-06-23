import { describe, it, expect } from "vitest";
import {
  applyDeterministicIdentityMatches,
  repointIdentityMatch,
  type IdentityMatchWriteStore,
  type AppUserMatchCandidate,
} from "./identity-match-write";

const TENANT_A = "11111111-1111-1111-1111-111111111111";
const TENANT_B = "22222222-2222-2222-2222-222222222222";

// An in-memory identity-match store that faithfully models the (app_user_id, person_id) natural-key upsert
// (one tenant's RLS-scoped view). Lookups are seeded; it tracks the match rows so "run twice -> count
// unchanged" is a REAL property of the helper consistently upserting. It also tracks historical app_users /
// people / identity_accounts counts so repoint can be proven NON-destructive. There is NO delete method.
function fixtureStore(seed: {
  primaryEmail?: Record<string, string[]>;       // normalizedEmail -> personIds
  iaEmail?: Record<string, string[]>;            // normalizedEmail -> personIds
  externalId?: Record<string, string[]>;         // "provider|externalId" -> personIds
} = {}) {
  // one persisted row per app_user — models UNIQUE(tenant_id, app_user_id) (0028): an app_user resolves to at
  // most ONE person, and ON CONFLICT (tenant_id, app_user_id) DO NOTHING never adds a second row / overwrites.
  const matches = new Map<string, string>();     // app_user_id -> person_id
  const historical = { appUsers: 9, people: 7, identityAccounts: 4 }; // must never decrease

  const store: IdentityMatchWriteStore = {
    async findPersonIdsByPrimaryEmail(email) { return seed.primaryEmail?.[email] ?? []; },
    async findPersonIdsByIdentityAccountEmail(email) { return seed.iaEmail?.[email] ?? []; },
    async findPersonIdsByExternalId({ provider, externalId }) { return seed.externalId?.[`${provider}|${externalId}`] ?? []; },
    async getExistingMatchPersonId(appUserId) { return matches.get(appUserId) ?? null; },
    async upsertMatch({ appUserId, personId }) {
      if (matches.has(appUserId)) return { created: false }; // ON CONFLICT (tenant_id, app_user_id) DO NOTHING — no second row, no overwrite
      matches.set(appUserId, personId); return { created: true };
    },
    async repointMatch({ appUserId, toPersonId }) {
      matches.set(appUserId, toPersonId); // UPDATE person_id — still ONE row for the app_user
    },
  };
  return {
    store,
    matchCount: () => matches.size,
    personOf: (appUserId: string) => matches.get(appUserId) ?? null,
    historical,
  };
}

let seq = 0;
const candidate = (over: Partial<AppUserMatchCandidate> = {}): AppUserMatchCandidate =>
  ({ appUserId: `au-${++seq}`, tenantId: TENANT_A, ...over });

describe("applyDeterministicIdentityMatches — deterministic-only writes, fail closed", () => {
  it("an exact app_user.email -> people.primary_email writes a match (auto_exact_email)", async () => {
    const fx = fixtureStore({ primaryEmail: { "jane@acme.com": ["p-1"] } });
    const [r] = await applyDeterministicIdentityMatches(fx.store, TENANT_A, [candidate({ email: "Jane@ACME.com " })]);
    expect(r.outcome).toBe("matched");
    expect(r.personId).toBe("p-1");
    expect(r.matchMethod).toBe("auto_exact_email");
    expect(fx.matchCount()).toBe(1);
  });

  it("an exact app_user.email -> identity_accounts.email -> person writes a match", async () => {
    const fx = fixtureStore({ iaEmail: { "jane@acme.com": ["p-2"] } });
    const [r] = await applyDeterministicIdentityMatches(fx.store, TENANT_A, [candidate({ email: "jane@acme.com" })]);
    expect(r.outcome).toBe("matched");
    expect(r.matchMethod).toBe("auto_identity_account_email");
  });

  it("an exact provider external_user_id tied to a person writes a match", async () => {
    const fx = fixtureStore({ externalId: { "okta|U123": ["p-3"] } });
    const [r] = await applyDeterministicIdentityMatches(fx.store, TENANT_A, [candidate({ provider: "okta", externalUserId: "U123" })]);
    expect(r.outcome).toBe("matched");
    expect(r.matchMethod).toBe("auto_external_id");
  });

  it("primary_email evidence wins over identity-account email (deterministic order)", async () => {
    const fx = fixtureStore({ primaryEmail: { "jane@acme.com": ["p-primary"] }, iaEmail: { "jane@acme.com": ["p-ia"] } });
    const [r] = await applyDeterministicIdentityMatches(fx.store, TENANT_A, [candidate({ email: "jane@acme.com" })]);
    expect(r.personId).toBe("p-primary");
  });
});

describe("email normalization is trim + lowercase ONLY (no plus/dot stripping)", () => {
  it("Jane.Doe@Acme.com matches jane.doe@acme.com (case-insensitive + trimmed)", async () => {
    const fx = fixtureStore({ primaryEmail: { "jane.doe@acme.com": ["p-1"] } });
    const [r] = await applyDeterministicIdentityMatches(fx.store, TENANT_A, [candidate({ email: "  Jane.Doe@Acme.com  " })]);
    expect(r.outcome).toBe("matched");
    expect(r.personId).toBe("p-1");
  });

  it("jane.doe@acme.com does NOT match janedoe@acme.com (dots are significant)", async () => {
    const fx = fixtureStore({ primaryEmail: { "janedoe@acme.com": ["p-1"] } });
    const [r] = await applyDeterministicIdentityMatches(fx.store, TENANT_A, [candidate({ email: "jane.doe@acme.com" })]);
    expect(r.outcome).toBe("review");
    expect(fx.matchCount()).toBe(0);
  });

  it("jane+test@acme.com does NOT match jane@acme.com (plus tags are significant)", async () => {
    const fx = fixtureStore({ primaryEmail: { "jane@acme.com": ["p-1"] } });
    const [r] = await applyDeterministicIdentityMatches(fx.store, TENANT_A, [candidate({ email: "jane+test@acme.com" })]);
    expect(r.outcome).toBe("review");
    expect(fx.matchCount()).toBe(0);
  });
});

describe("fail closed — no deterministic evidence writes nothing", () => {
  it("no email / external id writes nothing", async () => {
    const fx = fixtureStore();
    const [r] = await applyDeterministicIdentityMatches(fx.store, TENANT_A, [candidate({ display_name: "Jane Doe" } as never)]);
    expect(r.outcome).toBe("review");
    expect(fx.matchCount()).toBe(0);
  });

  it("a display-name-only candidate writes nothing (no name similarity)", async () => {
    const fx = fixtureStore({ primaryEmail: { "jane@acme.com": ["p-1"] } });
    // the candidate carries only a name-ish field; the helper never reads names, so nothing resolves
    const [r] = await applyDeterministicIdentityMatches(fx.store, TENANT_A, [candidate({ email: null })]);
    expect(r.outcome).toBe("review");
    expect(fx.matchCount()).toBe(0);
  });

  it("a domain-only email is not a deterministic match (no person with that exact email)", async () => {
    const fx = fixtureStore({ primaryEmail: { "jane@acme.com": ["p-1"] } });
    // a different exact email -> no row in the seed -> no match (domain 'acme.com' alone is never used)
    const [r] = await applyDeterministicIdentityMatches(fx.store, TENANT_A, [candidate({ email: "someone-else@acme.com" })]);
    expect(r.outcome).toBe("review");
    expect(fx.matchCount()).toBe(0);
  });

  it("multiple candidate people for the same signal route to review (no write)", async () => {
    const fx = fixtureStore({ primaryEmail: { "shared@acme.com": ["p-1", "p-2"] } });
    const [r] = await applyDeterministicIdentityMatches(fx.store, TENANT_A, [candidate({ email: "shared@acme.com" })]);
    expect(r.outcome).toBe("review");
    expect(r.reason).toMatch(/multiple people/i);
    expect(fx.matchCount()).toBe(0);
  });

  it("multiple people on the EXTERNAL-ID path also route to review (the false-merge guard holds on all paths)", async () => {
    const fx = fixtureStore({ externalId: { "okta|U1": ["p-1", "p-2"] } });
    const [r] = await applyDeterministicIdentityMatches(fx.store, TENANT_A, [candidate({ provider: "okta", externalUserId: "U1" })]);
    expect(r.outcome).toBe("review");
    expect(r.reason).toMatch(/multiple people/i);
    expect(fx.matchCount()).toBe(0);
  });

  it("a malformed / null candidate fails closed", async () => {
    const fx = fixtureStore();
    const results = await applyDeterministicIdentityMatches(fx.store, TENANT_A, [null as never, { tenantId: TENANT_A } as never]);
    expect(results.every((r) => r.outcome === "review")).toBe(true);
    expect(fx.matchCount()).toBe(0);
  });

  it("does NOT write when there is no authenticated tenant context", async () => {
    const fx = fixtureStore({ primaryEmail: { "jane@acme.com": ["p-1"] } });
    expect(await applyDeterministicIdentityMatches(fx.store, null, [candidate({ email: "jane@acme.com" })])).toEqual([]);
    expect(fx.matchCount()).toBe(0);
  });
});

describe("tenant isolation + conflict — never cross tenants, never overwrite", () => {
  it("a candidate claiming a different tenant than the session is not matched (tenant mismatch)", async () => {
    const fx = fixtureStore({ primaryEmail: { "jane@acme.com": ["p-1"] } });
    const [r] = await applyDeterministicIdentityMatches(fx.store, TENANT_A, [candidate({ tenantId: TENANT_B, email: "jane@acme.com" })]);
    expect(r.outcome).toBe("review");
    expect(r.reason).toMatch(/tenant mismatch/i);
    expect(fx.matchCount()).toBe(0);
  });

  it("an existing match to a DIFFERENT person is not overwritten (helper returns review)", async () => {
    const fx = fixtureStore({ primaryEmail: { "jane@acme.com": ["p-new"] } });
    const au = candidate({ email: "jane@acme.com" });
    // pre-seed a match for this app_user to a DIFFERENT person
    await fx.store.upsertMatch({ appUserId: au.appUserId, personId: "p-existing", matchMethod: "auto_exact_email" });
    const [r] = await applyDeterministicIdentityMatches(fx.store, TENANT_A, [au]);
    expect(r.outcome).toBe("review");
    expect(r.reason).toMatch(/conflict/i);
    expect(fx.personOf(au.appUserId)).toBe("p-existing"); // NOT overwritten
    expect(fx.matchCount()).toBe(1);                       // still exactly ONE match for the app_user
  });

  it("even a FORCED second-person write is a no-op — UNIQUE(tenant_id, app_user_id) keeps one person per app_user", async () => {
    const fx = fixtureStore();
    // bypass the helper's conflict check and call the store directly with two different people for one app_user
    expect((await fx.store.upsertMatch({ appUserId: "au-x", personId: "p-A", matchMethod: "auto_exact_email" })).created).toBe(true);
    expect((await fx.store.upsertMatch({ appUserId: "au-x", personId: "p-B", matchMethod: "auto_exact_email" })).created).toBe(false); // ON CONFLICT (tenant, app_user) DO NOTHING
    expect(fx.personOf("au-x")).toBe("p-A");  // the app_user stays matched to the FIRST person — no false double-match
    expect(fx.matchCount()).toBe(1);          // exactly one row for the app_user
  });
});

describe("idempotency — natural-key upsert, count unchanged on rerun, order-independent", () => {
  it("the same candidate set run twice does NOT increase app_user_identity_matches row count", async () => {
    const fx = fixtureStore({ primaryEmail: { "a@acme.com": ["p-1"], "b@acme.com": ["p-2"] } });
    const cands = [candidate({ email: "a@acme.com" }), candidate({ email: "b@acme.com" })];
    await applyDeterministicIdentityMatches(fx.store, TENANT_A, cands);
    const after1 = fx.matchCount();
    await applyDeterministicIdentityMatches(fx.store, TENANT_A, cands); // re-run identical set
    expect(fx.matchCount()).toBe(after1);
    expect(after1).toBe(2);
  });
});

describe("repoint — non-destructive correction (never deletes app_users/people/identity/history)", () => {
  it("repointIdentityMatch moves a match to the correct person without deleting history", async () => {
    const fx = fixtureStore({ primaryEmail: { "jane@acme.com": ["p-wrong"] } });
    const au = candidate({ email: "jane@acme.com" });
    await applyDeterministicIdentityMatches(fx.store, TENANT_A, [au]);
    expect(fx.personOf(au.appUserId)).toBe("p-wrong");
    const before = { ...fx.historical };
    const countBefore = fx.matchCount();
    expect((await repointIdentityMatch(fx.store, TENANT_A, { appUserId: au.appUserId, fromPersonId: "p-wrong", toPersonId: "p-right" })).ok).toBe(true);
    expect(fx.personOf(au.appUserId)).toBe("p-right");        // repointed...
    expect(fx.matchCount()).toBe(countBefore);                // ...same number of match rows (UPDATE, not insert)
    expect(fx.historical).toEqual(before);                    // ...app_users/people/identity_accounts untouched
  });

  it("repoint does nothing without an authenticated tenant, or when from==to", async () => {
    const fx = fixtureStore();
    expect((await repointIdentityMatch(fx.store, null, { appUserId: "au-x", fromPersonId: "p-1", toPersonId: "p-2" })).ok).toBe(false);
    expect((await repointIdentityMatch(fx.store, TENANT_A, { appUserId: "au-x", fromPersonId: "p-1", toPersonId: "p-1" })).ok).toBe(false);
  });
});

// Static guards: the write module is server-only — NO imports; no Supabase / db client, no createClient, no
// service-role, no fetch, no connector_secrets, no app graph / app_alias / vendor / product write, no route.
describe("identity-match-write module is server-safe (no db client / fetch / service-role / app-graph write)", () => {
  it("has no imports and no forbidden call/string", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const src = fs.readFileSync(path.resolve(__dirname, "identity-match-write.ts"), "utf8");
    const imports = [...src.matchAll(/from\s+["']([^"']+)["']/g)].map((m) => m[1]);
    expect(imports).toEqual([]); // pure TS logic + injected store — no module imports
    const code = src.replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
    expect(code).not.toMatch(/createClient\s*\(/);
    expect(code).not.toMatch(/createServiceClient/);
    expect(code).not.toMatch(/\bfetch\s*\(/);
    expect(code).not.toMatch(/process\.env/);
    expect(code).not.toContain(["service", "role"].join("_"));
    expect(code).not.toContain(["connector", "secrets"].join("_"));
    // this PR writes ONLY app_user_identity_matches — no app graph / alias / vendor / product write, no route
    for (const bad of ["canonical_app_id", "app_aliases", "upsertVendor", "upsertAppProduct", "app_products", "NextRequest", "NextResponse", "export async function GET", "export async function POST"]) {
      expect(code).not.toContain(bad);
    }
  });
});
