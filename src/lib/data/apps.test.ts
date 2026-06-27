import { describe, it, expect, vi, beforeEach } from "vitest";

// App-layer test for listAppsWithCountsForCurrentUser: the counts are RLS-scoped tallies (only the rows
// the user may read), the DTO carries no sensitive internals, and a failed read collapses to a safe
// label. The DB-level cross-tenant denial for apps/app_contracts/app_users is proven by org_rls_test.sql
// (T25/T28/T29); this covers the aggregation wiring this module adds.

const createClient = vi.fn();
vi.mock("@/lib/supabase/server", () => ({ createClient: () => createClient() }));

import { listAppsWithCountsForCurrentUser, getAppDetailForCurrentUser } from "./apps";

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

  it("a failed read returns the safe query_failed label", async () => {
    createClient.mockResolvedValue(
      makeSupabase({ apps: { data: null, error: { message: "boom" } } }),
    );
    const res = await listAppsWithCountsForCurrentUser();
    expect(res).toEqual({ ok: false, error: "query_failed" });
  });

  it("a links-read failure also fails closed (no partial counts rendered)", async () => {
    createClient.mockResolvedValue(
      makeSupabase({
        apps: { data: [{ id: "a", name: "A", vendor_name: null, category: null, status: "active" }], error: null },
        app_contracts: { data: null, error: { message: "boom" } },
      }),
    );
    const res = await listAppsWithCountsForCurrentUser();
    expect(res).toEqual({ ok: false, error: "query_failed" });
  });
});

describe("getAppDetailForCurrentUser — exposes the non-secret connector-instance markers (PR 5)", () => {
  const single = (row: Record<string, unknown> | null) => ({
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: row, error: null }) }) }) }),
  });
  const row = (over: Record<string, unknown>) => ({
    id: "app1", name: "Slack", vendor_name: "Slack", category: "Communication", status: "active",
    external_instance_id: null, instance_url: null, responsible_org_id: null, paying_org_id: null,
    procurement_owner_org_id: null, created_at: "2026-06-27T00:00:00Z", updated_at: "2026-06-27T00:00:00Z", ...over,
  });
  it("returns externalInstanceId + instanceUrl (used to identify a synced Slack app)", async () => {
    createClient.mockResolvedValue(single(row({ external_instance_id: "TWORKSPACE", instance_url: "https://acme.slack.com" })));
    const res = await getAppDetailForCurrentUser("app1");
    expect(res.ok && res.data.externalInstanceId).toBe("TWORKSPACE");
    expect(res.ok && res.data.instanceUrl).toBe("https://acme.slack.com");
    expect(res.ok && res.data.vendorName).toBe("Slack");
  });
  it("a manual app returns null markers (not Slack-synced)", async () => {
    createClient.mockResolvedValue(single(row({ vendor_name: null })));
    const res = await getAppDetailForCurrentUser("app2");
    expect(res.ok && res.data.externalInstanceId).toBeNull();
  });
});
