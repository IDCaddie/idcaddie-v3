import { describe, it, expect, vi, beforeEach } from "vitest";

// App-layer test for getDashboardSummaryForCurrentUser: it COMPOSES the two already-tested helpers into
// an integers/nulls-only DTO (no ids, no tenant_id, no sensitive internals); a failed underlying read
// degrades that field to null without erasing the rest.

const getReportsSummaryForCurrentUser = vi.fn();
const listRecentAuditEntriesForCurrentUser = vi.fn();
vi.mock("./reports", () => ({ getReportsSummaryForCurrentUser: () => getReportsSummaryForCurrentUser() }));
vi.mock("./audit", () => ({ listRecentAuditEntriesForCurrentUser: () => listRecentAuditEntriesForCurrentUser() }));

import { getDashboardSummaryForCurrentUser } from "./dashboard";

const REPORTS = {
  appsVisible: 1,
  contractsVisible: 2,
  accountsVisible: 2,
  accountsMatched: 1,
  accountsUnmatched: 1,
  filesVisible: 5,
};

beforeEach(() => {
  getReportsSummaryForCurrentUser.mockReset();
  listRecentAuditEntriesForCurrentUser.mockReset();
});

describe("getDashboardSummaryForCurrentUser", () => {
  it("composes the reports counts + a recent-activity count into a numbers-only DTO", async () => {
    getReportsSummaryForCurrentUser.mockResolvedValue(REPORTS);
    listRecentAuditEntriesForCurrentUser.mockResolvedValue({ ok: true, data: [{ id: "a" }, { id: "b" }] });

    const d = await getDashboardSummaryForCurrentUser();
    expect(d).toEqual({ ...REPORTS, recentActivityCount: 2 });
    // Integers/nulls only — no ids, no tenant_id, nothing sensitive.
    for (const v of Object.values(d)) expect(v === null || typeof v === "number").toBe(true);
    expect(Object.keys(d).sort()).toEqual(
      ["accountsMatched", "accountsUnmatched", "accountsVisible", "appsVisible", "contractsVisible", "filesVisible", "recentActivityCount"].sort(),
    );
  });

  it("a failed audit read degrades recentActivityCount to null, keeps the report counts", async () => {
    getReportsSummaryForCurrentUser.mockResolvedValue(REPORTS);
    listRecentAuditEntriesForCurrentUser.mockResolvedValue({ ok: false, error: "query_failed" });

    const d = await getDashboardSummaryForCurrentUser();
    expect(d.recentActivityCount).toBeNull();
    expect(d.appsVisible).toBe(1);
    expect(d.filesVisible).toBe(5);
  });

  it("a degraded reports summary (nulls) is passed through; empty audit → 0", async () => {
    getReportsSummaryForCurrentUser.mockResolvedValue({
      appsVisible: null,
      contractsVisible: null,
      accountsVisible: null,
      accountsMatched: null,
      accountsUnmatched: null,
      filesVisible: null,
    });
    listRecentAuditEntriesForCurrentUser.mockResolvedValue({ ok: true, data: [] });

    const d = await getDashboardSummaryForCurrentUser();
    expect(d.appsVisible).toBeNull();
    expect(d.recentActivityCount).toBe(0);
  });
});
