import { describe, it, expect, vi, beforeEach } from "vitest";

// App-layer test for listAppsWithCountsForCurrentUser: the counts are RLS-scoped tallies (only the rows
// the user may read), the DTO carries no sensitive internals, the APPS read is the only fatal read, and
// a COUNT-relation failure is NON-FATAL (the readable app is still listed, that count → null). The
// DB-level cross-tenant denial for apps/app_contracts/app_users is proven by org_rls_test.sql
// (T25/T28/T29); this covers the aggregation wiring + the count-fail-safe this module adds.

const createClient = vi.fn();
vi.mock("@/lib/supabase/server", () => ({ createClient: () => createClient() }));

import { listAppsWithCountsForCurrentUser } from "./apps";

type TableData = { data: unknown[] | null; error: unknown };

// `.select()` returns a value that is BOTH awaitable (app_contracts/app_users are awaited directly) AND
// chainable with `.order()` (apps uses `.order()`). Both resolve to the same configured table result.
function makeSupabase(byTable: Record<string, TableData>) {
  const query = (table: string) => {
    const result = byTable[table] ?? { data: [], error: null };
    const p = Promise.resolve(result);
    return {
      order: () => p,
      then: (...a: Parameters<Promise<TableData>["then"]>) => p.then(...a),
    };
  };
  return { from: (table: string) => ({ select: () => query(table) }) };
}

beforeEach(() => createClient.mockReset());

describe("listAppsWithCountsForCurrentUser", () => {
  it("tallies RLS-scoped linked-contract + app-user counts per app", async () => {
    createClient.mockResolvedValue(
      makeSupabase({
        apps: {
          data: [
            { id: "app1", name: "Asana", vendor_name: "Asana", category: "PM", status: "active" },
            { id: "app2", name: "Zoom", vendor_name: null, category: null, status: "inactive" },
          ],
          error: null,
        },
        // Visible link rows: app1 has 2, app2 has 1.
        app_contracts: { data: [{ app_id: "app1" }, { app_id: "app1" }, { app_id: "app2" }], error: null },
        // Visible app_users: app1 has 3, app2 has 0.
        app_users: { data: [{ app_id: "app1" }, { app_id: "app1" }, { app_id: "app1" }], error: null },
      }),
    );

    const res = await listAppsWithCountsForCurrentUser();
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data).toEqual([
      {
        id: "app1",
        name: "Asana",
        vendorName: "Asana",
        category: "PM",
        status: "active",
        linkedContractCount: 2,
        appUserCount: 3,
      },
      {
        id: "app2",
        name: "Zoom",
        vendorName: null,
        category: null,
        status: "inactive",
        linkedContractCount: 1,
        appUserCount: 0,
      },
    ]);
    // DTO carries ONLY the safe inventory columns — no tenant_id, no raw row, no sensitive internals.
    expect(Object.keys(res.data[0]).sort()).toEqual(
      ["appUserCount", "category", "id", "linkedContractCount", "name", "status", "vendorName"].sort(),
    );
  });

  it("apps with no links/users get zero counts", async () => {
    createClient.mockResolvedValue(
      makeSupabase({
        apps: { data: [{ id: "x", name: "Solo", vendor_name: null, category: null, status: "active" }], error: null },
        app_contracts: { data: [], error: null },
        app_users: { data: [], error: null },
      }),
    );
    const res = await listAppsWithCountsForCurrentUser();
    expect(res.ok && res.data[0].linkedContractCount).toBe(0);
    expect(res.ok && res.data[0].appUserCount).toBe(0);
  });

  it("the APPS read is the only fatal read — an apps failure returns the safe query_failed label", async () => {
    createClient.mockResolvedValue(
      makeSupabase({ apps: { data: null, error: { message: "boom" } } }),
    );
    const res = await listAppsWithCountsForCurrentUser();
    expect(res).toEqual({ ok: false, error: "query_failed" });
  });

  // Defensive hardening (NOT a fix for an observed bug — the §86 `/apps` empty state was the fixture not
  // yet applied, resolved by PR #89): a COUNT-relation read failure must NOT fail-close the whole helper
  // and erase readable app rows; it degrades that count to null while every readable app still lists.
  it("a links count-read failure is NON-FATAL: the readable app is still listed, contract count → null", async () => {
    createClient.mockResolvedValue(
      makeSupabase({
        apps: { data: [{ id: "a", name: "A", vendor_name: null, category: null, status: "active" }], error: null },
        app_contracts: { data: null, error: { message: "boom" } },
        app_users: { data: [{ app_id: "a" }, { app_id: "a" }], error: null },
      }),
    );
    const res = await listAppsWithCountsForCurrentUser();
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data).toHaveLength(1);
    expect(res.data[0].id).toBe("a");
    expect(res.data[0].linkedContractCount).toBeNull(); // unavailable, not 0, not erased
    expect(res.data[0].appUserCount).toBe(2);
  });

  it("a users count-read failure is non-fatal too: app listed, app-user count → null", async () => {
    createClient.mockResolvedValue(
      makeSupabase({
        apps: { data: [{ id: "a", name: "A", vendor_name: null, category: null, status: "active" }], error: null },
        app_contracts: { data: [{ app_id: "a" }], error: null },
        app_users: { data: null, error: { message: "boom" } },
      }),
    );
    const res = await listAppsWithCountsForCurrentUser();
    expect(res.ok && res.data[0].linkedContractCount).toBe(1);
    expect(res.ok && res.data[0].appUserCount).toBeNull();
  });

  it("BOTH count reads failing still lists every readable app with null counts + a safe DTO (no partial/cross-tenant data)", async () => {
    createClient.mockResolvedValue(
      makeSupabase({
        apps: {
          data: [
            { id: "a", name: "A", vendor_name: null, category: null, status: "active" },
            { id: "b", name: "B", vendor_name: "V", category: "C", status: "active" },
          ],
          error: null,
        },
        app_contracts: { data: null, error: { message: "boom" } },
        app_users: { data: null, error: { message: "boom" } },
      }),
    );
    const res = await listAppsWithCountsForCurrentUser();
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.map((r) => r.id)).toEqual(["a", "b"]); // readable apps NOT erased
    for (const row of res.data) {
      expect(row.linkedContractCount).toBeNull();
      expect(row.appUserCount).toBeNull();
      // DTO key set stays safe even on the degraded path — no tenant_id/org id/raw row leaks in.
      expect(Object.keys(row).sort()).toEqual(
        ["appUserCount", "category", "id", "linkedContractCount", "name", "status", "vendorName"].sort(),
      );
    }
  });
});
