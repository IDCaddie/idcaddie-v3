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
// access-loaders reaches access-rpc-types, which THROWS if imported with a `window` present. That guard is a real
// server-only boundary and is not something to weaken for a test — mock the loader instead.
vi.mock("@/lib/data/access-loaders", () => ({ loadAccessOverview: vi.fn() }));

import DashboardsPage from "./page";
import { getDashboardSummaryForCurrentUser } from "@/lib/data/dashboard";
import { getDashboardOverviewForCurrentUser } from "@/lib/data/dashboard-overview-loader";
import { loadAccessOverview } from "@/lib/data/access-loaders";

const asMock = <T,>(fn: T) => fn as unknown as { mockResolvedValue: (v: unknown) => void };

// A complete access graph. Numbers are deliberately distinct so an assertion can only pass by reading the right field.
const accessOk = {
  ok: true as const,
  data: {
    status: "complete" as const,
    counts: { identities: 42, groups: 9, applications: 6, memberships: 71, directAssignments: 13, groupAssignments: 24 },
    breakdown: { groupOnly: 30, directOnly: 11, both: 4 },
    effectiveRelationships: 45,
    governanceFindingsTotal: 3,
    summary: { total: 3, bySeverity: { high: 2, medium: 1, low: 0 } },
    findings: [],
  },
};
const summary = { appsVisible: 3, contractsVisible: 5, filesVisible: 0, accountsVisible: 10, accountsMatched: 7, accountsUnmatched: 3, recentActivityCount: 4 };

afterEach(cleanup);

describe("/dashboards render", () => {
  it("renders populated spend + renewals cards", async () => {
    asMock(loadAccessOverview).mockResolvedValue(accessOk);
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
    // dependency-free renewal segment bar renders its text legend (not color alone)
    expect(screen.getByText(/Due ≤30 days/)).toBeTruthy();
  });

  it("renders empty/unavailable states without crashing", async () => {
    asMock(loadAccessOverview).mockResolvedValue(accessOk);
    asMock(getDashboardSummaryForCurrentUser).mockResolvedValue({ ...summary, appsVisible: null });
    asMock(getDashboardOverviewForCurrentUser).mockResolvedValue({
      spend: { byCurrency: [], contractsWithCost: 0 },
      renewals: { due30: [], due90: [], missing: 0, topUpcoming: [] },
    });
    render(await DashboardsPage());
    expect(screen.getByText("No tracked contract spend yet.")).toBeTruthy();
    expect(screen.getByText("No upcoming renewals.")).toBeTruthy();
    expect(screen.getByText("No dated renewals to summarize.")).toBeTruthy();
  });
});

// ── Identity-first Home (Phase 1) ─────────────────────────────────────────────────────────────────────────────
// Home used to open with "App-user accounts visible", which is legitimately 0 for a directory-only tenant and made a
// working product look empty. These assert the identity block leads and that it never fabricates numbers.
describe("/dashboards is identity-first", () => {
  const baseSaas = async () => {
    asMock(getDashboardSummaryForCurrentUser).mockResolvedValue(summary);
    asMock(getDashboardOverviewForCurrentUser).mockResolvedValue({
      spend: { byCurrency: [], contractsWithCost: 0 },
      renewals: { due30: [], due90: [], missing: 0, topUpcoming: [] },
    });
  };

  it("leads with identity, and the SaaS summary comes AFTER it in document order", async () => {
    asMock(loadAccessOverview).mockResolvedValue(accessOk);
    await baseSaas();
    const { container } = render(await DashboardsPage());
    const identity = container.querySelector("#identity-heading");
    const saas = container.querySelector("#saas-heading");
    expect(identity, "identity block must render").toBeTruthy();
    expect(saas, "SaaS block must still render — it moved, it did not go away").toBeTruthy();
    // DOCUMENT_POSITION_FOLLOWING === 4: saas follows identity.
    expect(identity!.compareDocumentPosition(saas!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("renders real graph numbers, not recomputed ones", async () => {
    asMock(loadAccessOverview).mockResolvedValue(accessOk);
    await baseSaas();
    render(await DashboardsPage());
    for (const [label, value] of [["People", "42"], ["Groups", "9"], ["Directory applications", "6"], ["Effective access", "45"], ["Through group only", "30"], ["High findings", "2"]] as const) {
      const el = screen.getByText(label);
      expect(el.parentElement?.textContent, `${label} should show ${value}`).toContain(value);
    }
  });

  it("explains group-granted access in words, not just a number", async () => {
    asMock(loadAccessOverview).mockResolvedValue(accessOk);
    await baseSaas();
    render(await DashboardsPage());
    expect(screen.getByText(/30 of 45 effective relationships exist only through group membership/)).toBeTruthy();
  });

  it("says a directory is missing instead of rendering six zeros", async () => {
    // Zeros read as "the product found nothing"; absence reads as "you have not connected anything yet". Different fact.
    asMock(loadAccessOverview).mockResolvedValue({ ok: false, error: "no_directory" });
    await baseSaas();
    render(await DashboardsPage());
    expect(screen.getByText(/No directory has been discovered yet/)).toBeTruthy();
    expect(screen.queryByText("Effective access")).toBeNull();
  });

  it("does not claim effective access or findings when the graph was too large to evaluate", async () => {
    // The honesty case: counts are known, the derived graph is not. Showing 0 findings here would be a false all-clear.
    asMock(loadAccessOverview).mockResolvedValue({
      ok: true,
      data: { status: "too_large", counts: { identities: 90000, groups: 400, applications: 50, memberships: 1, directAssignments: 2, groupAssignments: 3 } },
    });
    await baseSaas();
    render(await DashboardsPage());
    expect(screen.getByText("90000")).toBeTruthy();
    expect(screen.queryByText("High findings"), "no finding count may be shown").toBeNull();
    expect(screen.queryByText("Effective access")).toBeNull();
    expect(screen.getByText(/not evaluated within current safety limits/)).toBeTruthy();
  });

  it("keeps SaaS inventory reachable and labelled as SaaS, not as the headline", async () => {
    asMock(loadAccessOverview).mockResolvedValue(accessOk);
    await baseSaas();
    render(await DashboardsPage());
    expect(screen.getByText("SaaS inventory")).toBeTruthy();
    expect(screen.queryByText("Apps visible"), "old SaaS-first framing must be gone").toBeNull();
  });
});
