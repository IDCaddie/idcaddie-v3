// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, within } from "@testing-library/react";

// Phase 2 — the three Directory list pages as the customer sees them. The loaders are mocked (they have their own suite); these assert the
// rendering decisions: what links where, what the six states say, and which numbers are NOT claimed.
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: unknown; children: React.ReactNode }) => (
    <a href={typeof href === "string" ? href : "#"} {...rest}>{children}</a>
  ),
}));
// Only the three loaders are mocked. The pure display helpers live in ./directory-display and load for real, so the label maps and the
// stale-date formatter are exercised end-to-end rather than restated here.
vi.mock("@/lib/data/directory-loaders", () => ({
  loadDirectoryPeople: vi.fn(), loadDirectoryGroups: vi.fn(), loadDirectoryApplications: vi.fn(),
}));
vi.mock("@/lib/data/okta-connector-status", () => ({ getOktaConnectorStatus: vi.fn() }));

import PeoplePage from "./people/page";
import GroupsPage from "./groups/page";
import ApplicationsPage from "./applications/page";
import { loadDirectoryPeople, loadDirectoryGroups, loadDirectoryApplications } from "@/lib/data/directory-loaders";
import { getOktaConnectorStatus } from "@/lib/data/okta-connector-status";

const asMock = <T,>(fn: T) => fn as unknown as { mockResolvedValue: (v: unknown) => void };
const sp = (o: Record<string, string> = {}) => Promise.resolve(o);

const paged = <T,>(rows: T[], over: Record<string, unknown> = {}) => ({
  ok: true,
  data: {
    status: "complete",
    paged: { rows, page: 1, pageSize: 50, total: rows.length, totalPages: 1, hasPrev: false, hasNext: false, startIndex: rows.length ? 1 : 0, endIndex: rows.length },
    totalBeforeFilter: rows.length,
    staleShown: false,
    ...over,
  },
});

const person = (o: Record<string, unknown> = {}) => ({ id: "11111111-1111-4111-8111-111111111111", name: "Ada Lovelace", secondaryId: "ada@example.com", isActive: true, provider: "okta", syncState: "current", staleSince: null, ...o });
const grp = (o: Record<string, unknown> = {}) => ({ id: "22222222-2222-4222-8222-222222222222", name: "Engineering", typeCategory: "okta_group", isBuiltIn: false, provider: "okta", syncState: "current", staleSince: null, ...o });
const application = (o: Record<string, unknown> = {}) => ({ id: "33333333-3333-4333-8333-333333333333", name: "Salesforce", statusCategory: "active", signOnCategory: "saml_2_0", catalogMatch: null, provider: "okta", syncState: "current", staleSince: null, ...o });

beforeEach(() => {
  vi.clearAllMocks();
  asMock(getOktaConnectorStatus).mockResolvedValue({ lifecycle: "discovered" });
  asMock(loadDirectoryPeople).mockResolvedValue(paged([person()]));
  asMock(loadDirectoryGroups).mockResolvedValue(paged([grp()]));
  asMock(loadDirectoryApplications).mockResolvedValue(paged([application()]));
});
afterEach(cleanup);

// ── People ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
describe("/directory/people", () => {
  it("renders a person and links them to their access detail", async () => {
    render(await PeoplePage({ searchParams: sp() }));
    const link = screen.getByRole("link", { name: "Ada Lovelace" });
    expect(link.getAttribute("href")).toContain("/access/identities/11111111-1111-4111-8111-111111111111");
    expect(screen.getByText("ada@example.com")).toBeTruthy();
    expect(screen.getByText("Active")).toBeTruthy();
    expect(screen.getByText("Current")).toBeTruthy();
  });

  it("carries the current search back through the detail link, so 'back' returns to the same list", async () => {
    render(await PeoplePage({ searchParams: sp({ q: "ada" }) }));
    const href = screen.getByRole("link", { name: "Ada Lovelace" }).getAttribute("href") ?? "";
    expect(href).toContain("from=people");
    expect(decodeURIComponent(href)).toContain("q=ada");
  });

  it("calls itself People, never app users", async () => {
    const { container } = render(await PeoplePage({ searchParams: sp() }));
    expect(container.textContent).toMatch(/discovered from your identity provider/i);
    expect(container.textContent).not.toMatch(/app.user/i);
  });

  it("says a stale person is stale and dates it", async () => {
    asMock(loadDirectoryPeople).mockResolvedValue(paged([person({ syncState: "stale", staleSince: "2026-01-05T09:00:00Z" })]));
    render(await PeoplePage({ searchParams: sp({ stale: "1" }) }));
    expect(screen.getByText("Stale")).toBeTruthy();
    expect(screen.getByText(/last seen 2026-01-05/)).toBeTruthy();
  });

  it("claims no group or effective-access counts, and says why", async () => {
    // The GO allows these only if free. They are not, so the page must not imply it knows them.
    const { container } = render(await PeoplePage({ searchParams: sp() }));
    const head = container.querySelector("thead")!;
    expect(within(head).queryByText(/group/i), "no group-count column may exist").toBeNull();
    expect(container.textContent).toMatch(/not summarized in this list/i);
  });
});

// ── Groups ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
describe("/directory/groups", () => {
  it("renders a group with its type", async () => {
    render(await GroupsPage({ searchParams: sp() }));
    expect(screen.getByText("Engineering")).toBeTruthy();
    expect(screen.getByText("Directory group")).toBeTruthy();
  });

  it("marks a built-in group", async () => {
    asMock(loadDirectoryGroups).mockResolvedValue(paged([grp({ name: "Everyone", typeCategory: "built_in", isBuiltIn: true })]));
    render(await GroupsPage({ searchParams: sp() }));
    expect(screen.getByText("Built-in")).toBeTruthy();
  });

  it("offers NO fake group-detail link — the one action goes to a query that really works", async () => {
    const { container } = render(await GroupsPage({ searchParams: sp() }));
    const hrefs = [...container.querySelectorAll("a")].map((a) => a.getAttribute("href") ?? "");
    // There is no group detail route and no group subgraph RPC. Nothing may pretend otherwise.
    expect(hrefs.some((h) => /\/directory\/groups\/[^?]/.test(h)), "no group detail route exists").toBe(false);
    expect(hrefs.some((h) => /\/access\/groups\//.test(h)), "no access group route exists").toBe(false);
    const findings = hrefs.find((h) => h.includes("/access/findings"));
    expect(findings, "the row action must point at findings filtered to this group").toBeTruthy();
    expect(decodeURIComponent(findings!)).toContain("subjectType=group");
  });

  it("admits that member and application counts are not shown, and points somewhere real", async () => {
    const { container } = render(await GroupsPage({ searchParams: sp() }));
    expect(container.textContent).toMatch(/Member counts and the applications a group grants are not shown here yet/i);
    expect(container.textContent).toMatch(/no detail page of its own/i);
  });
});

// ── Applications ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
describe("/directory/applications", () => {
  it("renders an application and links it to its access detail", async () => {
    render(await ApplicationsPage({ searchParams: sp() }));
    const link = screen.getByRole("link", { name: "Salesforce" });
    expect(link.getAttribute("href")).toContain("/access/applications/33333333-3333-4333-8333-333333333333");
    expect(screen.getByText("SAML 2.0")).toBeTruthy();
    expect(screen.getByText("Active")).toBeTruthy();
  });

  it("distinguishes itself from SaaS inventory, and links there", async () => {
    const { container } = render(await ApplicationsPage({ searchParams: sp() }));
    expect(container.textContent).toMatch(/SaaS inventory is a separate surface/i);
    expect(container.textContent).toMatch(/contracts, spend and utilization/i);
    expect([...container.querySelectorAll("a")].some((a) => a.getAttribute("href") === "/apps")).toBe(true);
  });

  it("does not imply an unmatched application is broken", async () => {
    const { container } = render(await ApplicationsPage({ searchParams: sp() }));
    expect(screen.queryByText(/catalog match/i), "no chip on an unmatched row").toBeNull();
    expect(container.textContent).toMatch(/absence of one is not a problem to fix/i);
  });

  it("shows a catalog match when one really exists", async () => {
    asMock(loadDirectoryApplications).mockResolvedValue(paged([application({ catalogMatch: "matched" })]));
    render(await ApplicationsPage({ searchParams: sp() }));
    expect(screen.getByText("Catalog match")).toBeTruthy();
  });
});

// ── the six states, asserted once through People (one shared shell renders all three) ────────────────────────────────────────────────
describe("state handling", () => {
  it("no connector: explains that a directory must be connected, and links to Connectors", async () => {
    asMock(getOktaConnectorStatus).mockResolvedValue(null);
    asMock(loadDirectoryPeople).mockResolvedValue(paged([]));
    const { container } = render(await PeoplePage({ searchParams: sp() }));
    expect(screen.getByText("No directory connected")).toBeTruthy();
    expect([...container.querySelectorAll("a")].some((a) => a.getAttribute("href") === "/connectors")).toBe(true);
  });

  it("connector configured but nothing discovered: a DIFFERENT message that does not say reconnect", async () => {
    asMock(getOktaConnectorStatus).mockResolvedValue({ lifecycle: "verified" });
    asMock(loadDirectoryPeople).mockResolvedValue(paged([]));
    const { container } = render(await PeoplePage({ searchParams: sp() }));
    expect(screen.getByText("No records discovered yet")).toBeTruthy();
    expect(container.textContent).not.toMatch(/No directory connected/);
    expect([...container.querySelectorAll("a")].some((a) => (a.getAttribute("href") ?? "").includes("/connectors/okta/status"))).toBe(true);
  });

  it("filtered to nothing: says how many exist and offers to clear — not 'no directory'", async () => {
    asMock(loadDirectoryPeople).mockResolvedValue(paged([], { paged: { rows: [], page: 1, pageSize: 50, total: 0, totalPages: 1, hasPrev: false, hasNext: false, startIndex: 0, endIndex: 0 }, totalBeforeFilter: 42 }));
    const { container } = render(await PeoplePage({ searchParams: sp({ q: "zzzz" }) }));
    expect(screen.getByText("No people match your search")).toBeTruthy();
    expect(container.textContent).toMatch(/42 people visible to you/);
    expect(container.textContent).not.toMatch(/No directory connected/);
  });

  it("too large: shows the bound and NO partial list", async () => {
    asMock(loadDirectoryPeople).mockResolvedValue({ ok: true, data: { status: "too_large", total: 5000 } });
    const { container } = render(await PeoplePage({ searchParams: sp() }));
    expect(screen.getByText("Too large to list in this view")).toBeTruthy();
    expect(container.textContent).toMatch(/5,000 people/);
    expect(container.querySelector("table"), "a partial table would read as the whole directory").toBeNull();
  });

  it("forbidden and query_failed are different messages, and neither leaks a database error", async () => {
    asMock(loadDirectoryPeople).mockResolvedValue({ ok: false, error: "forbidden" });
    const { container: a } = render(await PeoplePage({ searchParams: sp() }));
    expect(screen.getByText("Not available")).toBeTruthy();
    cleanup();

    asMock(loadDirectoryPeople).mockResolvedValue({ ok: false, error: "query_failed" });
    const { container: b } = render(await PeoplePage({ searchParams: sp() }));
    expect(screen.getByText("Could not load")).toBeTruthy();
    for (const c of [a, b]) {
      expect(c.textContent).not.toMatch(/query_failed|relation|SQLSTATE|permission denied|pg/i);
      expect(c.querySelector("table")).toBeNull();
    }
  });
});

// ── search and pagination controls ───────────────────────────────────────────────────────────────────────────────────────────────────
describe("controls", () => {
  it("keeps filter state in the URL via a plain GET form", async () => {
    const { container } = render(await PeoplePage({ searchParams: sp() }));
    const form = container.querySelector("form")!;
    expect(form.getAttribute("method")).toBe("get");
    expect(form.getAttribute("action")).toBe("/directory/people");
    expect(container.querySelector('input[name="q"]')).toBeTruthy();
    expect(container.querySelector('input[name="stale"]')).toBeTruthy();
  });

  it("renders pagination only when there is more than one page, and links carry the filters", async () => {
    asMock(loadDirectoryPeople).mockResolvedValue(paged([person()]));
    const { container: one } = render(await PeoplePage({ searchParams: sp() }));
    expect(one.querySelector('nav[aria-label="Pagination"]'), "one page needs no pager").toBeNull();
    cleanup();

    asMock(loadDirectoryPeople).mockResolvedValue({
      ok: true,
      data: { status: "complete", totalBeforeFilter: 120, staleShown: false, paged: { rows: [person()], page: 2, pageSize: 50, total: 120, totalPages: 3, hasPrev: true, hasNext: true, startIndex: 51, endIndex: 100 } },
    });
    const { container } = render(await PeoplePage({ searchParams: sp({ q: "a", page: "2" }) }));
    const nav = container.querySelector('nav[aria-label="Pagination"]')!;
    expect(nav.textContent).toMatch(/Page 2 of 3/);
    const next = within(nav as HTMLElement).getByRole("link", { name: /Next/ }).getAttribute("href") ?? "";
    expect(next).toContain("page=3");
    expect(decodeURIComponent(next), "paging must not drop the search").toContain("q=a");
  });

  it("states the scope of the numbers it is showing", async () => {
    const { container } = render(await PeoplePage({ searchParams: sp() }));
    expect(container.textContent).toMatch(/Showing 1–1 of 1 current/);
  });
});
