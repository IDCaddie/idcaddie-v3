import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { createSupabaseSlackResolverStore } from "./supabase-slack-resolver-store";

// REAL DB + RLS integration test for the concrete store — proves the supabase-js/PostgREST query SHAPES the unit tests
// can only mock: the 0036 onConflict upserts actually dedupe, the get-or-create + LIKE-escape behave against real
// PostgREST, and RLS denies a cross-tenant write. Runs against a LOCAL Supabase stack (`npm run test:store-it`, which
// sets the SUPABASE_IT_* env from `supabase status`); SKIPPED in normal `npm test` / CI-without-Docker (no env). The
// service-role key is used for FIXTURE SETUP ONLY — the store under test writes exclusively as a tenant-member JWT.

const URL = process.env.SUPABASE_IT_URL;
const ANON = process.env.SUPABASE_IT_ANON_KEY ?? "";
const SERVICE = process.env.SUPABASE_IT_SERVICE_ROLE_KEY ?? "";
const RUN = !!URL && !!ANON && !!SERVICE;

describe.runIf(RUN)("createSupabaseSlackResolverStore — real DB/RLS", () => {
  const sfx = (process.env.SUPABASE_IT_SUFFIX ?? String(Date.now())).slice(-9);
  const tenantA = crypto.randomUUID();
  const tenantB = crypto.randomUUID();
  const pw = `it-pw-${sfx}-xyz`;
  const emailA = `it_owner_a_${sfx}@example.test`;
  const emailB = `it_owner_b_${sfx}@example.test`;
  let admin: SupabaseClient;
  let storeA: ReturnType<typeof createSupabaseSlackResolverStore>;
  let storeB: ReturnType<typeof createSupabaseSlackResolverStore>;
  const ids: { users: string[] } = { users: [] };

  async function memberStore(email: string) {
    const auth = createClient(URL!, ANON, { auth: { persistSession: false } });
    const { data, error } = await auth.auth.signInWithPassword({ email, password: pw });
    if (error || !data.session) throw new Error("IT signin failed");
    const client = createClient(URL!, ANON, {
      global: { headers: { Authorization: `Bearer ${data.session.access_token}` } },
      auth: { persistSession: false },
    });
    return createSupabaseSlackResolverStore(client);
  }

  beforeAll(async () => {
    admin = createClient(URL!, SERVICE, { auth: { persistSession: false } });
    for (const [email, tenant, name, slug] of [
      [emailA, tenantA, "IT Tenant A", `it-a-${sfx}`],
      [emailB, tenantB, "IT Tenant B", `it-b-${sfx}`],
    ] as const) {
      const { data: u, error } = await admin.auth.admin.createUser({ email, password: pw, email_confirm: true });
      if (error || !u.user) throw new Error("IT createUser failed");
      ids.users.push(u.user.id);
      await admin.from("profiles").insert({ id: u.user.id, email });
      await admin.from("tenants").insert({ id: tenant, name, slug });
      await admin.from("tenant_memberships").insert({ tenant_id: tenant, user_id: u.user.id, role: "owner", status: "active" }); // explicit, not relying on the column default
    }
    storeA = await memberStore(emailA);
    storeB = await memberStore(emailB);
  }, 30_000);

  afterAll(async () => {
    if (!admin) return;
    await admin.from("tenants").delete().in("id", [tenantA, tenantB]); // cascades apps/app_users/people/matches
    for (const uid of ids.users) await admin.auth.admin.deleteUser(uid).catch(() => {});
  });

  it("upsertApp is idempotent on the 0036 key (re-run returns the SAME row, no duplicate)", async () => {
    const a1 = await storeA.upsertApp({ tenantId: tenantA, externalInstanceId: "TWS1", name: "Slack", vendorName: "Slack" });
    const a2 = await storeA.upsertApp({ tenantId: tenantA, externalInstanceId: "TWS1", name: "Slack", vendorName: "Slack" });
    expect(a2.appId).toBe(a1.appId);
    const { count } = await admin.from("apps").select("*", { count: "exact", head: true }).eq("tenant_id", tenantA).eq("external_instance_id", "TWS1");
    expect(count).toBe(1);
  });

  it("writes the full graph (app_user + person + match) as the tenant member", async () => {
    const { appId } = await storeA.upsertApp({ tenantId: tenantA, externalInstanceId: "TWS2", name: "Slack" });
    const { appUserId } = await storeA.upsertAppUser({ tenantId: tenantA, appId, externalUserId: "U100", email: "ada@x.test", displayName: "Ada" });
    const { personId } = await storeA.upsertPerson({ tenantId: tenantA, primaryEmail: "ada@x.test" });
    expect(await storeA.getExistingMatchPersonId({ tenantId: tenantA, appUserId })).toBeNull();
    expect((await storeA.insertMatch({ tenantId: tenantA, appUserId, personId, matchMethod: "auto_exact_email" })).created).toBe(true);
    // DO NOTHING: a re-insert does not create a second match
    expect((await storeA.insertMatch({ tenantId: tenantA, appUserId, personId, matchMethod: "auto_exact_email" })).created).toBe(false);
  });

  it("upsertPerson get-or-create: `_` in an email is matched LITERALLY (not a wildcard)", async () => {
    const p1 = await storeA.upsertPerson({ tenantId: tenantA, primaryEmail: "john_doe@x.test" });
    const p1again = await storeA.upsertPerson({ tenantId: tenantA, primaryEmail: "john_doe@x.test" });
    const pOther = await storeA.upsertPerson({ tenantId: tenantA, primaryEmail: "johnxdoe@x.test" });
    expect(p1again.personId).toBe(p1.personId); // same email → dedup
    expect(pOther.personId).not.toBe(p1.personId); // `_` must NOT have matched `x` → distinct person
  });

  it("RLS denies a cross-tenant write: member B cannot write into tenant A (store_write_failed)", async () => {
    await expect(storeB.upsertApp({ tenantId: tenantA, externalInstanceId: "TWS_X", name: "Slack" })).rejects.toThrow("store_write_failed");
    const { count } = await admin.from("apps").select("*", { count: "exact", head: true }).eq("tenant_id", tenantA).eq("external_instance_id", "TWS_X");
    expect(count).toBe(0); // nothing was written
  });
});
