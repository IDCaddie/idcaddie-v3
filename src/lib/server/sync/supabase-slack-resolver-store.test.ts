import { describe, it, expect } from "vitest";
import { createSupabaseSlackResolverStore, escapeLike } from "./supabase-slack-resolver-store";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/database.types";

// Unit shape/safety test for the concrete store (mocked Supabase client — NO real DB). The DB-level RLS + idempotency
// (constraints refuse direct duplicates, cross-tenant denial, no-repoint) are proven at the real-RLS SQL layer by
// org_rls_test.sql Test 58 (the EXACT upserts this store issues). Here we assert: the correct table + tenant-scoped
// onConflict targets are used, the store throws a SAFE static reason on error, and people is get-or-create.
type Ctx = { table?: string; op?: string; onConflict?: string; ignoreDuplicates?: boolean; ilike?: string };
function mkSupabase(resolve: (ctx: Ctx, n: number) => { data: unknown; error: unknown }) {
  const calls: Ctx[] = [];
  let n = 0;
  const q = (ctx: Ctx): Record<string, unknown> => ({
    upsert: (_p: unknown, o?: { onConflict?: string; ignoreDuplicates?: boolean }) => q({ ...ctx, op: "upsert", onConflict: o?.onConflict, ignoreDuplicates: o?.ignoreDuplicates }),
    insert: () => q({ ...ctx, op: "insert" }),
    select: () => q(ctx),
    eq: () => q(ctx), ilike: (_c: string, v: string) => q({ ...ctx, ilike: v }), limit: () => q(ctx),
    single: () => { calls.push(ctx); return Promise.resolve(resolve(ctx, n++)); },
    maybeSingle: () => { calls.push(ctx); return Promise.resolve(resolve(ctx, n++)); },
    then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => { calls.push(ctx); return Promise.resolve(resolve(ctx, n++)).then(res, rej); },
  });
  return { client: { from: (table: string) => q({ table }) } as unknown as SupabaseClient<Database>, calls };
}

describe("createSupabaseSlackResolverStore — tenant-scoped upserts via the user-scoped client", () => {
  it("upsertApp uses apps + onConflict (tenant_id, external_instance_id) and returns the id", async () => {
    const m = mkSupabase(() => ({ data: { id: "app1" }, error: null }));
    const store = createSupabaseSlackResolverStore(m.client);
    expect(await store.upsertApp({ tenantId: "t", externalInstanceId: "T1", name: "Slack" })).toEqual({ appId: "app1" });
    expect(m.calls[0]).toMatchObject({ table: "apps", op: "upsert", onConflict: "tenant_id,external_instance_id" });
  });

  it("upsertAppUser uses app_users + onConflict (tenant_id, app_id, external_user_id)", async () => {
    const m = mkSupabase(() => ({ data: { id: "au1" }, error: null }));
    const store = createSupabaseSlackResolverStore(m.client);
    expect(await store.upsertAppUser({ tenantId: "t", appId: "a", externalUserId: "U1", email: "x@y.test" })).toEqual({ appUserId: "au1" });
    expect(m.calls[0]).toMatchObject({ table: "app_users", op: "upsert", onConflict: "tenant_id,app_id,external_user_id" });
  });

  it("upsertPerson is GET-or-create: returns the existing row without inserting", async () => {
    const m = mkSupabase((ctx) => (ctx.op === undefined ? { data: { id: "p1" }, error: null } : { data: null, error: null }));
    const store = createSupabaseSlackResolverStore(m.client);
    expect(await store.upsertPerson({ tenantId: "t", primaryEmail: "ada@x.test" })).toEqual({ personId: "p1" });
    expect(m.calls.some((c) => c.op === "insert")).toBe(false); // no insert when it already exists
  });

  it("upsertPerson inserts when absent", async () => {
    const m = mkSupabase((ctx) => (ctx.op === "insert" ? { data: { id: "p2" }, error: null } : { data: null, error: null }));
    const store = createSupabaseSlackResolverStore(m.client);
    expect(await store.upsertPerson({ tenantId: "t", primaryEmail: "new@x.test" })).toEqual({ personId: "p2" });
  });

  it("insertMatch uses the DO-NOTHING onConflict and reports created from the returned rows", async () => {
    const created = mkSupabase(() => ({ data: [{ id: "m1" }], error: null }));
    expect(await createSupabaseSlackResolverStore(created.client).insertMatch({ tenantId: "t", appUserId: "au", personId: "p", matchMethod: "auto_exact_email" })).toEqual({ created: true });
    expect(created.calls[0]).toMatchObject({ op: "upsert", onConflict: "tenant_id,app_user_id", ignoreDuplicates: true });
    const conflict = mkSupabase(() => ({ data: [], error: null })); // DO NOTHING → no row returned
    expect(await createSupabaseSlackResolverStore(conflict.client).insertMatch({ tenantId: "t", appUserId: "au", personId: "p", matchMethod: "auto_exact_email" })).toEqual({ created: false });
  });

  it("upsertPerson ESCAPES LIKE wildcards so `_`/`%` in an email can't match the wrong person", async () => {
    const m = mkSupabase((ctx) => (ctx.op === undefined ? { data: { id: "p1" }, error: null } : { data: null, error: null }));
    await createSupabaseSlackResolverStore(m.client).upsertPerson({ tenantId: "t", primaryEmail: "a_b%c@x.test" });
    expect(m.calls[0].ilike).toBe("a\\_b\\%c@x.test"); // literal match, not a pattern
  });

  it("escapeLike escapes backslash, percent, underscore only", () => {
    expect(escapeLike("john_doe@x.test")).toBe("john\\_doe@x.test");
    expect(escapeLike("a%b@x.test")).toBe("a\\%b@x.test");
    expect(escapeLike("plain@x.test")).toBe("plain@x.test");
  });

  it("a DB error surfaces ONLY a safe static reason + the SAFE code — NEVER the message (which embeds emails)", async () => {
    // a real unique/RLS violation message embeds the row VALUE (e.g. an email); the store must keep only the code.
    const m = mkSupabase(() => ({ data: null, error: { code: "42501", message: "new row violates RLS; Key (primary_email)=(ada@x.test)" } }));
    const store = createSupabaseSlackResolverStore(m.client);
    await expect(store.upsertApp({ tenantId: "t", externalInstanceId: "T1", name: "Slack" })).rejects.toMatchObject({
      message: "store_write_failed",
      failure: { table: "apps", op: "upsert_app", code: "42501" },
    });
    // the thrown error must not carry the email-laden DB message anywhere
    try { await store.upsertApp({ tenantId: "t", externalInstanceId: "T1", name: "Slack" }); } catch (e) {
      expect(JSON.stringify((e as { failure: unknown }).failure)).not.toContain("ada@x.test");
    }
  });
});
