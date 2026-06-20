import { describe, it, expect, vi, beforeEach } from "vitest";

// App-layer test for getReportsSummaryForCurrentUser: RLS-scoped head-counts (apps/contracts/files) +
// the reused people helper (accounts/matched/unmatched); each count degrades to null ("—") on failure;
// the DTO is integers/nulls only (no ids, no row data, nothing sensitive).

const createClient = vi.fn();
vi.mock("@/lib/supabase/server", () => ({ createClient: () => createClient() }));

const listIdentityAccountsForCurrentUser = vi.fn();
vi.mock("./people", () => ({
  listIdentityAccountsForCurrentUser: () => listIdentityAccountsForCurrentUser(),
}));

import { getReportsSummaryForCurrentUser } from "./reports";

function makeSupabase(byTable: Record<string, { count: number | null; error: unknown }>) {
  return {
    from: (table: string) => ({
      select: () => Promise.resolve(byTable[table] ?? { count: 0, error: null }),
    }),
  };
}

beforeEach(() => {
  createClient.mockReset();
  listIdentityAccountsForCurrentUser.mockReset();
});

describe("getReportsSummaryForCurrentUser", () => {
  it("aggregates RLS-scoped visible counts into a numbers-only DTO", async () => {
    createClient.mockResolvedValue(
      makeSupabase({
        apps: { count: 3, error: null },
        contracts: { count: 5, error: null },
        files: { count: 2, error: null },
      }),
    );
    listIdentityAccountsForCurrentUser.mockResolvedValue({
      ok: true,
      data: { totalAccounts: 4, matchedAccounts: 1, unmatchedAccounts: 3, matchStatusAvailable: true },
    });

    const r = await getReportsSummaryForCurrentUser();
    expect(r).toEqual({
      appsVisible: 3,
      contractsVisible: 5,
      accountsVisible: 4,
      accountsMatched: 1,
      accountsUnmatched: 3,
      filesVisible: 2,
    });
    // Numbers/nulls only — no ids or sensitive internals.
    for (const v of Object.values(r)) expect(v === null || typeof v === "number").toBe(true);
  });

  it("a failed head-count degrades that count to null (non-fatal, never erases the summary)", async () => {
    createClient.mockResolvedValue(
      makeSupabase({
        apps: { count: null, error: { message: "boom" } },
        contracts: { count: 5, error: null },
        files: { count: null, error: { message: "boom" } },
      }),
    );
    listIdentityAccountsForCurrentUser.mockResolvedValue({
      ok: true,
      data: { totalAccounts: 0, matchedAccounts: 0, unmatchedAccounts: 0, matchStatusAvailable: true },
    });
    const r = await getReportsSummaryForCurrentUser();
    expect(r.appsVisible).toBeNull();
    expect(r.contractsVisible).toBe(5);
    expect(r.filesVisible).toBeNull();
    expect(r.accountsVisible).toBe(0);
  });

  it("accounts unavailable → account counts null; match-status unavailable → matched/unmatched null", async () => {
    createClient.mockResolvedValue(
      makeSupabase({ apps: { count: 1, error: null }, contracts: { count: 1, error: null }, files: { count: 0, error: null } }),
    );
    // people read failed entirely:
    listIdentityAccountsForCurrentUser.mockResolvedValue({ ok: false, error: "query_failed" });
    let r = await getReportsSummaryForCurrentUser();
    expect(r.accountsVisible).toBeNull();
    expect(r.accountsMatched).toBeNull();
    expect(r.accountsUnmatched).toBeNull();

    // accounts read OK but match status unavailable:
    listIdentityAccountsForCurrentUser.mockResolvedValue({
      ok: true,
      data: { totalAccounts: 2, matchedAccounts: 0, unmatchedAccounts: 0, matchStatusAvailable: false },
    });
    r = await getReportsSummaryForCurrentUser();
    expect(r.accountsVisible).toBe(2);
    expect(r.accountsMatched).toBeNull();
    expect(r.accountsUnmatched).toBeNull();
  });
});
