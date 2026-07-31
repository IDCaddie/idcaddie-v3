// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, within } from "@testing-library/react";

// Phase 3 — the Group detail page. The loader is mocked (its RPC is covered by the SQL suite); these assert the rendering
// decisions: what links where, which numbers are claimed, and what each failure state actually says.
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: unknown; children: React.ReactNode }) => (
    <a href={typeof href === "string" ? href : "#"} {...rest}>{children}</a>
  ),
}));
vi.mock("@/lib/data/access-loaders", () => ({ loadGroupAccessDetail: vi.fn() }));

import GroupDetailPage from "./[id]/page";
import { loadGroupAccessDetail } from "@/lib/data/access-loaders";

const asMock = <T,>(fn: T) => fn as unknown as { mockResolvedValue: (v: unknown) => void; mock: { calls: unknown[][] } };
const GID = "9c000000-0000-4000-8000-000000009001";
const params = Promise.resolve({ id: GID });
const sp = (o: Record<string, string> = {}) => Promise.resolve(o);

const member = (o: Record<string, unknown> = {}) => ({
  identityId: "aaaa0000-0000-4000-8000-00000000000a", displayName: "Ada Lovelace", identifier: "ada@example.test",
  isActive: true, accountState: "current", membershipState: "current", staleEvidence: false, ...o,
});
const app = (o: Record<string, unknown> = {}) => ({
  applicationId: "bbbb0000-0000-4000-8000-00000000000b", label: "Salesforce", statusCategory: "active",
  signOnCategory: "saml_2_0", applicationState: "current", assignmentState: "current", staleEvidence: false, alsoDirectFor: 0, ...o,
});
const detail = (o: Record<string, unknown> = {}) => ({
  ok: true,
  data: {
    id: GID, displayName: "Everyone", description: "All employees", providerLabel: "okta",
    connectionId: "cccc0000-0000-4000-8000-00000000000c", typeCategory: "built_in", isBuiltIn: true,
    syncState: "current", staleSince: null, lastSeenAt: "2026-07-31T10:00:00Z", bounded: false,
    memberCount: 1, applicationCount: 1, members: [member()], applications: [app()], findings: [], staleEvidenceCount: 0, ...o,
  },
});

beforeEach(() => { vi.clearAllMocks(); asMock(loadGroupAccessDetail).mockResolvedValue(detail()); });
afterEach(cleanup);

describe("group detail — header and summary", () => {
  it("names the group, its type and its evidence state, and links back to the list", async () => {
    const { container } = render(await GroupDetailPage({ params, searchParams: sp() }));
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Everyone");
    expect(screen.getByText("All employees")).toBeTruthy();
    expect(container.querySelector('a[href^="/directory/groups"]')).toBeTruthy();
  });

  it("marks a built-in group ONCE", async () => {
    // "Everyone" granting an application is a different fact from a deliberately-created group, so it is marked — but the type
    // is rendered in exactly one place. It was duplicated in the Phase 2 list before being consolidated.
    render(await GroupDetailPage({ params, searchParams: sp() }));
    expect(screen.getAllByText("Built-in")).toHaveLength(1);
  });

  it("summarises only what it actually knows", async () => {
    const { container } = render(await GroupDetailPage({ params, searchParams: sp() }));
    // "Members" is deliberately both a summary card and a section heading, so scope to the card grid.
    const cards = container.querySelector(".grid")!;
    for (const label of ["Members", "Applications granted", "Findings"]) {
      expect(within(cards as HTMLElement).getByText(label), `${label} card`).toBeTruthy();
    }
    // No invented effective-access figure: the page reports members and grants, not a derived reach number it cannot support.
    expect(screen.queryByText(/Effective access/i)).toBeNull();
  });

  it("explains a stale group instead of just badging it", async () => {
    asMock(loadGroupAccessDetail).mockResolvedValue(detail({ syncState: "stale", staleSince: "2026-06-11T00:00:00Z" }));
    const { container } = render(await GroupDetailPage({ params, searchParams: sp() }));
    expect(container.textContent).toMatch(/not seen in the latest complete discovery/i);
    expect(container.textContent).toMatch(/last seen 2026-06-11/);
    expect(container.textContent).toMatch(/kept, not deleted/i);
  });
});

describe("group detail — members", () => {
  it("lists members and links each to their access detail", async () => {
    render(await GroupDetailPage({ params, searchParams: sp() }));
    const link = screen.getByRole("link", { name: "Ada Lovelace" });
    expect(link.getAttribute("href")).toContain("/access/identities/aaaa0000-0000-4000-8000-00000000000a");
    expect(link.getAttribute("href")).toContain("from=groups");
    expect(screen.getByText("ada@example.test")).toBeTruthy();
  });

  it("shows the membership edge's evidence separately from the person's account state", async () => {
    // A person can be current while the evidence that they belong to this group is not. Merging the two would hide that.
    asMock(loadGroupAccessDetail).mockResolvedValue(detail({
      members: [member({ isActive: true, accountState: "current", membershipState: "stale", staleEvidence: true })],
      staleEvidenceCount: 1,
    }));
    const { container } = render(await GroupDetailPage({ params, searchParams: sp() }));
    const row = container.querySelector("tbody tr")!;
    expect(within(row as HTMLElement).getByText("Active")).toBeTruthy();
    expect(within(row as HTMLElement).getByText("Stale")).toBeTruthy();
  });

  it("says no members are represented, and offers the stale scope", async () => {
    asMock(loadGroupAccessDetail).mockResolvedValue(detail({ members: [], memberCount: 0 }));
    const { container } = render(await GroupDetailPage({ params, searchParams: sp() }));
    expect(screen.getByText("No members represented")).toBeTruthy();
    expect(container.textContent).toMatch(/include stale evidence/i);
  });
});

describe("group detail — applications", () => {
  it("lists granted applications and links each to its access detail", async () => {
    render(await GroupDetailPage({ params, searchParams: sp() }));
    const link = screen.getByRole("link", { name: "Salesforce" });
    expect(link.getAttribute("href")).toContain("/access/applications/bbbb0000-0000-4000-8000-00000000000b");
    expect(screen.getByText("SAML 2.0")).toBeTruthy();
  });

  it("answers whether removing the group would actually remove the access", async () => {
    // The question the page exists for. A member who also holds the application directly keeps it either way.
    asMock(loadGroupAccessDetail).mockResolvedValue(detail({ memberCount: 3, applications: [app({ alsoDirectFor: 2 })] }));
    render(await GroupDetailPage({ params, searchParams: sp() }));
    expect(screen.getByText("2 of 3")).toBeTruthy();
  });

  it("says 'none' rather than 0 when no member holds it directly", async () => {
    render(await GroupDetailPage({ params, searchParams: sp() }));
    expect(screen.getByText("none")).toBeTruthy();
  });

  it("does not treat 'grants nothing' as an error", async () => {
    asMock(loadGroupAccessDetail).mockResolvedValue(detail({ applications: [], applicationCount: 0 }));
    const { container } = render(await GroupDetailPage({ params, searchParams: sp() }));
    expect(screen.getByText("No application assignments represented")).toBeTruthy();
    expect(container.textContent).toMatch(/may still reach applications through a direct assignment or another group/i);
  });
});

describe("group detail — findings and evidence", () => {
  it("renders findings with severity and reviewed prose, and links to the filtered view", async () => {
    asMock(loadGroupAccessDetail).mockResolvedValue(detail({
      findings: [{ id: "f1", severityLabel: "Info", severityTone: "neutral", title: "No application assignments represented",
                   summary: "This group has no current application assignment represented.", guidance: "Confirm this is expected.", staleEvidence: false }],
    }));
    const { container } = render(await GroupDetailPage({ params, searchParams: sp() }));
    expect(screen.getByText("No application assignments represented")).toBeTruthy();
    expect(screen.getByText("Info")).toBeTruthy();
    const link = [...container.querySelectorAll("a")].find((a) => (a.getAttribute("href") ?? "").includes("/access/findings"));
    expect(decodeURIComponent(link!.getAttribute("href")!)).toContain("subject=groups");
  });

  it("says there are none rather than hiding the section", async () => {
    const { container } = render(await GroupDetailPage({ params, searchParams: sp() }));
    expect(container.textContent).toMatch(/No governance findings relate to this group/i);
  });

  it("names the source and explains that stale records are preserved", async () => {
    const { container } = render(await GroupDetailPage({ params, searchParams: sp() }));
    expect(screen.getByText("okta")).toBeTruthy();
    expect(container.textContent).toMatch(/marked stale and kept, never deleted/i);
    // The P0 rule, stated where the customer can see it.
    expect(container.textContent).toMatch(/superseded by another reading the same organization contributes nothing/i);
  });
});

describe("group detail — failure and bounded states", () => {
  it("collapses missing, foreign-tenant and superseded into one answer", async () => {
    asMock(loadGroupAccessDetail).mockResolvedValue({ ok: false, error: "not_found" });
    const { container } = render(await GroupDetailPage({ params, searchParams: sp() }));
    expect(screen.getByText("Not found")).toBeTruthy();
    expect(container.textContent).toMatch(/doesn’t exist or you don’t have access to it/);
    // Nothing may hint at which of the three causes applied.
    expect(container.textContent).not.toMatch(/supersed|another tenant|deleted/i);
    expect(container.querySelector("table")).toBeNull();
  });

  it("reports a read failure without leaking anything", async () => {
    asMock(loadGroupAccessDetail).mockResolvedValue({ ok: false, error: "query_failed" });
    const { container } = render(await GroupDetailPage({ params, searchParams: sp() }));
    expect(screen.getByText("Could not load")).toBeTruthy();
    expect(container.textContent).not.toMatch(/query_failed|relation|SQLSTATE|permission denied/i);
  });

  it("refuses a fan-in group instead of rendering zeros", async () => {
    // An "Everyone" too large to evaluate must not render "0 members" — that reads as an empty group, which is the opposite
    // of the truth.
    asMock(loadGroupAccessDetail).mockResolvedValue(detail({ bounded: true, memberCount: 0, applicationCount: 0, members: [], applications: [] }));
    const { container } = render(await GroupDetailPage({ params, searchParams: sp() }));
    expect(screen.getByText("Too large to evaluate in this view")).toBeTruthy();
    expect(container.querySelector("table"), "no partial table").toBeNull();
    expect(screen.queryByText("Members"), "no zero summary card").toBeNull();
    // The header still works — the group is real and its identity is known.
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Everyone");
  });
});

describe("group detail — call discipline", () => {
  it("makes exactly ONE loader call, and passes the stale scope through", async () => {
    await GroupDetailPage({ params, searchParams: sp() });
    expect(asMock(loadGroupAccessDetail).mock.calls).toHaveLength(1);
    expect(asMock(loadGroupAccessDetail).mock.calls[0]).toEqual([GID, false]);

    vi.clearAllMocks();
    asMock(loadGroupAccessDetail).mockResolvedValue(detail());
    await GroupDetailPage({ params, searchParams: sp({ stale: "1" }) });
    expect(asMock(loadGroupAccessDetail).mock.calls[0]).toEqual([GID, true]);
  });

  it("does not call the loader once per member or per application", async () => {
    // The N+1 guard. Ten members and five applications must still be one call.
    const many = Array.from({ length: 10 }, (_, i) => member({ identityId: `aaaa0000-0000-4000-8000-0000000000${String(i).padStart(2, "0")}`, displayName: `P${i}` }));
    const apps = Array.from({ length: 5 }, (_, i) => app({ applicationId: `bbbb0000-0000-4000-8000-0000000000${String(i).padStart(2, "0")}`, label: `App ${i}` }));
    asMock(loadGroupAccessDetail).mockResolvedValue(detail({ members: many, memberCount: 10, applications: apps, applicationCount: 5 }));
    render(await GroupDetailPage({ params, searchParams: sp() }));
    expect(asMock(loadGroupAccessDetail).mock.calls).toHaveLength(1);
    expect(screen.getAllByRole("row").length).toBeGreaterThan(10);
  });
});
