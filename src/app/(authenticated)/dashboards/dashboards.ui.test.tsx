// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";

// next/link → a plain <a> so the router context isn't needed. The real data loaders are mocked (no DB/network);
// the pure formatMoney is kept real so currency formatting is exercised end-to-end.
vi.mock("next/link", () => ({
  default: ({ href, children }: { href: unknown; children: React.ReactNode }) => (
    <a href={typeof href === "string" ? href : "#"}>{children}</a>
  ),
}));
vi.mock("@/lib/data/dashboard", () => ({ getDashboardSummaryForCurrentUser: vi.fn() }));
vi.mock("@/lib/data/dashboard-overview-loader", async () => {
  const pure = await import("@/lib/data/dashboard-overview");
  return { getDashboardOverviewForCurrentUser: vi.fn(), formatMoney: pure.formatMoney };
});

import DashboardsPage from "./page";
import { getDashboardSummaryForCurrentUser } from "@/lib/data/dashboard";
import { getDashboardOverviewForCurrentUser } from "@/lib/data/dashboard-overview-loader";

const asMock = <T,>(fn: T) => fn as unknown as { mockResolvedValue: (v: unknown) => void };
const summary = { appsVisible: 3, contractsVisible: 5, filesVisible: 0, accountsVisible: 10, accountsMatched: 7, accountsUnmatched: 3, recentActivityCount: 4 };

afterEach(cleanup);

describe("/dashboards render", () => {
  it("renders populated spend + renewals cards", async () => {
    asMock(getDashboardSummaryForCurrentUser).mockResolvedValue(summary);
    asMock(getDashboardOverviewForCurrentUser).mockResolvedValue({
      spend: { byCurrency: [{ currency: "USD", total: 1500, contractCount: 2 }], contractsWithCost: 2 },
      renewals: {
        due30: [{ id: "c1" }],
        due90: [],
        missing: 1,
        topUpcoming: [{ id: "c1", contractName: "AWS", date: "2026-07-20", daysUntil: 5, basis: "renewal", noticeDeadline: null }],
      },
    });
    render(await DashboardsPage());
    expect(screen.getByText("Tracked contract spend")).toBeTruthy();
    expect(screen.getByText(/1,500/)).toBeTruthy();
    expect(screen.getByText(/1 due in 30 days/)).toBeTruthy();
    expect(screen.getByText("AWS")).toBeTruthy();
    expect(screen.getByText(/1 missing a renewal date/)).toBeTruthy();
  });

  it("renders empty/unavailable states without crashing", async () => {
    asMock(getDashboardSummaryForCurrentUser).mockResolvedValue({ ...summary, appsVisible: null });
    asMock(getDashboardOverviewForCurrentUser).mockResolvedValue({
      spend: { byCurrency: [], contractsWithCost: 0 },
      renewals: { due30: [], due90: [], missing: 0, topUpcoming: [] },
    });
    render(await DashboardsPage());
    expect(screen.getByText("No tracked contract spend yet.")).toBeTruthy();
    expect(screen.getByText("No upcoming renewals.")).toBeTruthy();
  });
});
