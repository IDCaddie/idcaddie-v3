import { describe, it, expect, vi, beforeEach } from "vitest";

// App-layer test for listIdentityAccountsForCurrentUser: assembly of accounts + match status + summary,
// the DTO carries no tenant/person id or sensitive internals, empty state, a non-fatal match-read
// failure (unknown status, not "unmatched"), and fail-closed on a core read. DB-level cross-tenant
// denial for app_users / matches is proven by org_rls_test.sql T29/T30; this covers the wiring.

const createClient = vi.fn();
vi.mock("@/lib/supabase/server", () => ({ createClient: () => createClient() }));

import { listIdentityAccountsForCurrentUser } from "./people";

type TableData = { data: unknown[] | null; error: unknown };

// `.select()` returns a value chainable with `.order()` and `.in()` AND awaitable (then) — all resolve
// to the same configured table result.
function makeSupabase(byTable: Record<string, TableData>) {
  const query = (table: string) => {
    const result = byTable[table] ?? { data: [], error: null };
    const p = Promise.resolve(result);
    return {
      order: () => p,
      in: () => p,
      then: (...a: Parameters<Promise<TableData>["then"]>) => p.then(...a),
    };
  };
  return { from: (table: string) => ({ select: () => query(table) }) };
}

beforeEach(() => createClient.mockReset());

describe("listIdentityAccountsForCurrentUser", () => {
  it("assembles accounts with app name + match status + summary", async () => {
    createClient.mockResolvedValue(
      makeSupabase({
        app_users: {
          data: [
            { id: "u1", app_id: "a1", display_name: "Acct 1", email: "u1@x.test", status: "active", license_type: "Pro", last_active_at: "2026-06-01T00:00:00Z" },
            { id: "u2", app_id: "a1", display_name: "Acct 2", email: null, status: "inactive", license_type: null, last_active_at: null },
            { id: "u3", app_id: "a2", display_name: "Acct 3", email: "u3@x.test", status: "active", license_type: "Free", last_active_at: null },
          ],
          error: null,
        },
        apps: { data: [{ id: "a1", name: "Asana" }, { id: "a2", name: "Zoom" }], error: null },
        app_user_identity_matches: { data: [{ app_user_id: "u1" }], error: null }, // only u1 matched
      }),
    );

    const res = await listIdentityAccountsForCurrentUser();
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const v = res.data;
    expect(v.totalAccounts).toBe(3);
    expect(v.distinctApps).toBe(2);
    expect(v.matchedAccounts).toBe(1);
    expect(v.unmatchedAccounts).toBe(2);
    expect(v.matchStatusAvailable).toBe(true);
    expect(v.accounts[0]).toEqual({
      id: "u1",
      appId: "a1",
      appName: "Asana",
      displayName: "Acct 1",
      email: "u1@x.test",
      status: "active",
      licenseType: "Pro",
      lastActiveAt: "2026-06-01T00:00:00Z",
      matched: true,
    });
    expect(v.accounts.find((a) => a.id === "u2")?.matched).toBe(false);
    // DTO carries ONLY safe fields — no tenant_id, no person_id, no raw row.
    expect(Object.keys(v.accounts[0]).sort()).toEqual(
      ["appId", "appName", "displayName", "email", "id", "lastActiveAt", "licenseType", "matched", "status"].sort(),
    );
    expect("tenant_id" in v.accounts[0]).toBe(false);
    expect("person_id" in v.accounts[0]).toBe(false);
  });

  it("empty roster → empty view", async () => {
    createClient.mockResolvedValue(makeSupabase({ app_users: { data: [], error: null } }));
    const res = await listIdentityAccountsForCurrentUser();
    expect(res).toEqual({
      ok: true,
      data: { accounts: [], totalAccounts: 0, distinctApps: 0, matchedAccounts: 0, unmatchedAccounts: 0, matchStatusAvailable: true },
    });
  });

  it("a failed MATCH read is non-fatal → accounts render with unknown status (not 'unmatched')", async () => {
    createClient.mockResolvedValue(
      makeSupabase({
        app_users: { data: [{ id: "u1", app_id: "a1", display_name: "A", email: null, status: null, license_type: null, last_active_at: null }], error: null },
        apps: { data: [{ id: "a1", name: "Asana" }], error: null },
        app_user_identity_matches: { data: null, error: { message: "boom" } },
      }),
    );
    const res = await listIdentityAccountsForCurrentUser();
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.matchStatusAvailable).toBe(false);
    expect(res.data.matchedAccounts).toBe(0);
    expect(res.data.unmatchedAccounts).toBe(0); // not asserted as unmatched when status unavailable
    expect(res.data.accounts[0].matched).toBe(false);
  });

  it("a failed app_users read fails closed", async () => {
    createClient.mockResolvedValue(makeSupabase({ app_users: { data: null, error: { message: "boom" } } }));
    const res = await listIdentityAccountsForCurrentUser();
    expect(res).toEqual({ ok: false, error: "query_failed" });
  });
});
