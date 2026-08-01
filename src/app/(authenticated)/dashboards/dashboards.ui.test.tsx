// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, within } from "@testing-library/react";

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
// Phase 7A: Home now also reads the connector inventory and the URL scope. Both are server-only; mocked here so the page renders
// in jsdom. `executive-home` is PURE and loads for real, so the derivations under test are the ones the product actually runs.
vi.mock("@/lib/data/connector-management", () => ({ loadConnectorManagement: vi.fn() }));
vi.mock("@/lib/data/connector-scope", () => ({ resolveConnectorScope: vi.fn() }));
// Phase 9: Home folds SaaS account evidence into the capability facts, so a Slack connector holding real accounts no
// longer reports "not discovered yet". Server-only for the same access-rpc-types reason as access-loaders above. The
// default here is the DENIED gate — the viewer path — so the existing expectations still describe a directory-only Home.
vi.mock("@/lib/data/saas-accounts", () => ({ accessGate: vi.fn(async () => ({ ok: false })), getSaasCounts: vi.fn() }));

import DashboardsPage from "./page";
import { getDashboardSummaryForCurrentUser } from "@/lib/data/dashboard";
import { getDashboardOverviewForCurrentUser } from "@/lib/data/dashboard-overview-loader";
import { loadAccessOverview } from "@/lib/data/access-loaders";
import { loadConnectorManagement } from "@/lib/data/connector-management";
import { resolveConnectorScope } from "@/lib/data/connector-scope";
import { accessGate, getSaasCounts } from "@/lib/data/saas-accounts";

const asMock = <T,>(fn: T) => fn as unknown as { mockResolvedValue: (v: unknown) => void; mock: { calls: unknown[][] } };

const CONN = "cdf19b61-6f22-4e61-8784-99a453396805";
const connector = (o: Record<string, unknown> = {}) => ({
  id: CONN, provider: "okta", name: "Okta Staging", organization: "trial-5294016.okta.com",
  lifecycle: "discovered", lifecycleLabel: "Discovered",
  health: { state: "healthy", label: "Healthy", reason: "Verified and discovery has completed." },
  active: true, supersededBy: null, disconnectedAt: null, disconnectedReason: null,
  lastVerifiedAt: "2026-07-30T23:01:30Z", lastDiscoveryAt: "2026-07-31T17:19:51Z", createdAt: null,
  counts: { people: 1, groups: 6, applications: 2, memberships: 1, userAssignments: 1, groupAssignments: 0 }, ...o,
});
const withConnectors = (cs: unknown[] = [connector()]) => {
  asMock(loadConnectorManagement).mockResolvedValue({ ok: true, data: { connectors: cs, activeCount: cs.length, inactiveCount: 0 } });
  asMock(resolveConnectorScope).mockResolvedValue({ ok: true, scope: { tenantId: "t", active: cs, selected: null, connectionId: null, multiple: cs.length > 1 } });
};

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
    withConnectors();
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
    withConnectors();
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

// ── Executive Home (Phase 7A) ─────────────────────────────────────────────────────────────────────────────────
describe("/dashboards — executive identity posture", () => {
  const baseSaas = async () => {
    asMock(getDashboardSummaryForCurrentUser).mockResolvedValue(summary);
    asMock(getDashboardOverviewForCurrentUser).mockResolvedValue({
      spend: { byCurrency: [], contractsWithCost: 0 },
      renewals: { due30: [], due90: [], missing: 0, topUpcoming: [] },
    });
  };
  // The heading sits inside a flex wrapper, so climb to the section that actually contains the cards.
  const cardsIn = (c: HTMLElement) => c.querySelector("#summary-heading")!.closest("section") as HTMLElement;

  it("leads with identity posture; the SaaS section comes AFTER it", async () => {
    withConnectors(); asMock(loadAccessOverview).mockResolvedValue(accessOk); await baseSaas();
    const { container } = render(await DashboardsPage());
    const identity = container.querySelector("#summary-heading");
    const saas = container.querySelector("#saas-heading");
    expect(identity, "identity summary must render").toBeTruthy();
    expect(saas, "the SaaS section moved, it did not go away").toBeTruthy();
    expect(identity!.compareDocumentPosition(saas!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("shows CURRENT counts, never total evidence", async () => {
    withConnectors(); asMock(loadAccessOverview).mockResolvedValue(accessOk); await baseSaas();
    const { container } = render(await DashboardsPage());
    for (const [label, value] of [["People", "42"], ["Groups", "9"], ["Directory applications", "6"],
                                  ["Effective access", "45"], ["High findings", "2"]] as const) {
      expect(within(cardsIn(container)).getByText(label).parentElement?.textContent, `${label} -> ${value}`).toContain(value);
    }
  });

  it("one stale group does not inflate the Groups card", async () => {
    // The Phase 6 contract: the loader hands Home CURRENT counts, and Home must not add retained evidence back in.
    withConnectors();
    asMock(loadAccessOverview).mockResolvedValue({ ...accessOk, data: { ...accessOk.data, counts: { ...accessOk.data.counts, groups: 6 } } });
    await baseSaas();
    const { container } = render(await DashboardsPage());
    const g = within(cardsIn(container)).getByText("Groups").parentElement?.textContent ?? "";
    expect(g).toContain("6");
    expect(g).not.toContain("7");
  });

  it("with NO active directory shows onboarding, not a wall of zeros", async () => {
    // Zeros read as "the product found nothing" — a different and much worse claim than "nothing is connected".
    asMock(loadConnectorManagement).mockResolvedValue({ ok: true, data: { connectors: [], activeCount: 0, inactiveCount: 0 } });
    asMock(resolveConnectorScope).mockResolvedValue({ ok: true, scope: { tenantId: "t", active: [], selected: null, connectionId: null, multiple: false } });
    asMock(loadAccessOverview).mockResolvedValue({ ok: false, error: "forbidden" });
    await baseSaas();
    const { container } = render(await DashboardsPage());
    expect(screen.getByText("No directory connected")).toBeTruthy();
    expect(container.querySelector("#summary-heading"), "no posture metrics without a directory").toBeNull();
  });

  it("withholds the access distribution when the graph was too large, with no zero all-clear", async () => {
    withConnectors();
    asMock(loadAccessOverview).mockResolvedValue({
      ok: true,
      data: { status: "too_large", counts: { identities: 90000, groups: 400, applications: 50, memberships: 1, directAssignments: 2, groupAssignments: 3 } },
    });
    await baseSaas();
    const { container } = render(await DashboardsPage());
    expect(screen.getByText("90000")).toBeTruthy();
    expect(screen.getByText("Access distribution not evaluated")).toBeTruthy();
    expect(container.textContent).toMatch(/above the current safety limit/i);
    expect(within(cardsIn(container)).queryByText("High findings"), "0 findings over an unevaluated graph is a false all-clear").toBeNull();
    expect(within(cardsIn(container)).getByText("Findings").parentElement?.textContent).toContain("—");
  });

  it("excludes disconnected and superseded connectors from the health panel", async () => {
    // A retired directory in the health list would count toward "all directories healthy" and misstate the estate.
    const active = connector({ id: "a", name: "Okta Staging" });
    const off = connector({ id: "b", name: "Slack DEV", active: false, lifecycle: "disconnected", lifecycleLabel: "Disconnected",
                            health: { state: "inactive", label: "Disconnected", reason: "Retired." } });
    const sup = connector({ id: "c", name: "Legacy Okta", active: false, lifecycle: "superseded", lifecycleLabel: "Replaced",
                            supersededBy: "a", health: { state: "inactive", label: "Replaced", reason: "Replaced." } });
    asMock(loadConnectorManagement).mockResolvedValue({ ok: true, data: { connectors: [active, off, sup], activeCount: 1, inactiveCount: 2 } });
    asMock(resolveConnectorScope).mockResolvedValue({ ok: true, scope: { tenantId: "t", active: [active], selected: null, connectionId: null, multiple: false } });
    asMock(loadAccessOverview).mockResolvedValue(accessOk); await baseSaas();
    const { container } = render(await DashboardsPage());
    const health = container.querySelector("#health-heading")!.closest("section") as HTMLElement;
    expect(within(health).queryByText("Slack DEV"), "a disconnected directory is not part of the estate's health").toBeNull();
    expect(within(health).queryByText("Legacy Okta"), "nor is a superseded one").toBeNull();
  });

  it("does NOT render unavailable connector health as green", async () => {
    // Absence of evidence is not evidence of health — the single most damaging thing an executive dashboard can get wrong.
    asMock(loadConnectorManagement).mockResolvedValue({ ok: false, error: "query_failed" });
    asMock(resolveConnectorScope).mockResolvedValue({ ok: true, scope: { tenantId: "t", active: [{ id: "a", label: "Okta", provider: "okta", organization: null }], selected: null, connectionId: null, multiple: false } });
    asMock(loadAccessOverview).mockResolvedValue(accessOk); await baseSaas();
    const { container } = render(await DashboardsPage());
    const health = container.querySelector("#health-heading")!.closest("section") as HTMLElement;
    expect(health.textContent).toMatch(/could not be loaded/i);
    expect(health.textContent).toMatch(/not a statement that everything is healthy/i);
    expect(health.textContent).not.toMatch(/All directories healthy/);
  });

  it("keeps SaaS inventory reachable and labelled as SaaS", async () => {
    withConnectors(); asMock(loadAccessOverview).mockResolvedValue(accessOk); await baseSaas();
    render(await DashboardsPage());
    expect(screen.getByText("SaaS inventory")).toBeTruthy();
    expect(screen.queryByText("Apps visible")).toBeNull();
  });
});

// ── Phase 2 cross-links ───────────────────────────────────────────────────────────────────────────────────────
// A count that opens the list which produced it is the difference between a dashboard and a report. These assert each
// Home card lands where the GO says, and that the graph-derived numbers still go to Access, where they are explained.
describe("Home identity cards link into the Directory", () => {
  it("sends each count to the surface that owns it", async () => {
    withConnectors();
    asMock(loadAccessOverview).mockResolvedValue(accessOk);
    asMock(getDashboardSummaryForCurrentUser).mockResolvedValue(summary);
    asMock(getDashboardOverviewForCurrentUser).mockResolvedValue({
      spend: { byCurrency: [], contractsWithCost: 0 },
      renewals: { due30: [], due90: [], missing: 0, topUpcoming: [] },
    });
    const { container } = render(await DashboardsPage());
    const hrefFor = (label: string) => screen.getByText(label).closest("a")?.getAttribute("href");
    expect(hrefFor("People")).toBe("/directory/people");
    expect(hrefFor("Groups")).toBe("/directory/groups");
    expect(hrefFor("Directory applications")).toBe("/directory/applications");
    // Effective access and findings are DERIVED — they are computed and explained on Access, so that is where they open.
    expect(hrefFor("Effective access")).toBe("/access");
    expect(hrefFor("High findings")).toBe("/access/findings?severity=high");
    expect(container).toBeTruthy();
  });

  // Phase 9 — the defect this fold-in exists to fix. Before it, `hasCurrentData` was computed from the DIRECTORY counts
  // alone, so a Slack connector that had just discovered 40 accounts scored zero and Home told the customer application
  // accounts had "not been discovered yet" for the connector that had discovered them.
  it("a Slack connector holding application accounts does not report them as undiscovered", async () => {
    const slack = connector({ id: "5b3b3a1e-1111-4c11-8c11-000000000001", provider: "slack", name: "Slack",
      organization: null, counts: { people: 0, groups: 0, applications: 0, memberships: 0, userAssignments: 0, groupAssignments: 0 } });
    withConnectors([slack]);
    asMock(loadAccessOverview).mockResolvedValue(accessOk);
    asMock(getDashboardSummaryForCurrentUser).mockResolvedValue(summary);
    asMock(getDashboardOverviewForCurrentUser).mockResolvedValue({
      spend: { byCurrency: [], contractsWithCost: 0 },
      renewals: { due30: [], due90: [], missing: 0, topUpcoming: [] },
    });
    asMock(accessGate).mockResolvedValue({ ok: true, tenantId: "t" });
    asMock(getSaasCounts).mockResolvedValue({ ok: true, data: {
      accounts: { current: 40, stale: 0, totalEvidence: 40, humans: 35, bots: 5, unknownKind: 0, admins: 2, active: 40, inactive: 0, deleted: 0, lastSeenAt: null },
      groups: { current: 4, stale: 0, totalEvidence: 4, lastSeenAt: null },
      matching: { humans: 35, matched: 30, proposed: 3, unmatched: 2, withoutEmail: 0 },
    } });

    const { container } = render(await DashboardsPage());
    expect(container.textContent).not.toMatch(/has not been discovered yet/i);
  });
});
