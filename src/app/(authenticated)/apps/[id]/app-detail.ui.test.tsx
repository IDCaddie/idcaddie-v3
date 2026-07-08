// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";

vi.mock("next/link", () => ({
  default: ({ href, children }: { href: unknown; children: React.ReactNode }) => (
    <a href={typeof href === "string" ? href : "#"}>{children}</a>
  ),
}));
vi.mock("@/lib/data/apps", () => ({ getAppDetailForCurrentUser: vi.fn() }));
vi.mock("@/lib/data/links", () => ({ listContractsLinkedToApp: vi.fn() }));
vi.mock("@/lib/data/app-users", () => ({ listAppUsersForApp: vi.fn() }));
vi.mock("@/lib/data/app-user-matches", () => ({ listMatchesForAppUsers: vi.fn() }));
vi.mock("@/lib/data/manual-sync-runs", () => ({ getLatestSlackSyncRunForCurrentTenant: vi.fn() }));
vi.mock("@/lib/data/catalog", () => ({ getCatalogMappingForApp: vi.fn() }));
vi.mock("@/lib/data/organizations", () => ({ listOrganizationsForCurrentUser: vi.fn() }));

import AppDetailPage from "./page";
import { getAppDetailForCurrentUser } from "@/lib/data/apps";
import { listContractsLinkedToApp } from "@/lib/data/links";
import { listAppUsersForApp } from "@/lib/data/app-users";
import { listMatchesForAppUsers } from "@/lib/data/app-user-matches";
import { getCatalogMappingForApp } from "@/lib/data/catalog";
import { listOrganizationsForCurrentUser } from "@/lib/data/organizations";

const asMock = <T,>(fn: T) => fn as unknown as { mockResolvedValue: (v: unknown) => void };
const OWNER_UUID = "11111111-2222-3333-4444-555555555555";
afterEach(cleanup);

// An app with no owners, no linked contracts, no discovered accounts → all three attention flags fire.
const detail = {
  ok: true,
  data: {
    id: "app-uuid-abc", name: "Figma", vendorName: "Figma Inc", category: "Design", status: "active",
    externalInstanceId: null, instanceUrl: null,
    responsibleOrgId: null, payingOrgId: null, procurementOrgId: null,
    hasBusinessOwner: false, hasTechnicalOwner: false,
    createdAt: "2026-06-01T00:00:00Z", updatedAt: "2026-06-02T00:00:00Z",
  },
};

describe("/apps/[id] render", () => {
  it("shows Needs Attention flags + ownership presence as Yes/No, with no raw ids", async () => {
    asMock(getAppDetailForCurrentUser).mockResolvedValue(detail);
    asMock(listContractsLinkedToApp).mockResolvedValue({ ok: true, data: [] });
    asMock(listAppUsersForApp).mockResolvedValue({ ok: true, data: [] });
    asMock(listMatchesForAppUsers).mockResolvedValue({ ok: true, data: [] });
    asMock(getCatalogMappingForApp).mockResolvedValue({ ok: true, data: { mapped: false } });
    asMock(listOrganizationsForCurrentUser).mockResolvedValue({ ok: true, data: [] });

    const { container } = render(await AppDetailPage({ params: Promise.resolve({ id: "app-uuid-abc" }) }));
    expect(screen.getByText("Needs attention")).toBeTruthy();
    expect(screen.getByText("No owner assigned")).toBeTruthy();
    expect(screen.getByText("No linked contract")).toBeTruthy();
    expect(screen.getByText("No discovered accounts")).toBeTruthy();
    expect(screen.getByText("Business owner assigned")).toBeTruthy();
    // unmapped catalog state
    expect(screen.getByText("Catalog mapping")).toBeTruthy();
    expect(screen.getByText(/not mapped to the canonical catalog yet/)).toBeTruthy();
    // regression: no raw owner/app UUID leaks into the rendered UI
    expect(container.textContent).not.toContain(OWNER_UUID);
    expect(container.textContent).not.toContain("app-uuid-abc");
  });

  it("renders a mapped catalog product (name/vendor/category/alias count) with no raw ids", async () => {
    const PRODUCT_UUID = "99999999-8888-7777-6666-555555555555";
    asMock(getAppDetailForCurrentUser).mockResolvedValue(detail);
    asMock(listContractsLinkedToApp).mockResolvedValue({ ok: true, data: [] });
    asMock(listAppUsersForApp).mockResolvedValue({ ok: true, data: [] });
    asMock(listMatchesForAppUsers).mockResolvedValue({ ok: true, data: [] });
    asMock(getCatalogMappingForApp).mockResolvedValue({
      ok: true,
      data: { mapped: true, productName: "Confluence", vendorName: "Atlassian", category: "Docs", aliasCount: 3 },
    });
    asMock(listOrganizationsForCurrentUser).mockResolvedValue({ ok: true, data: [] });

    const { container } = render(await AppDetailPage({ params: Promise.resolve({ id: "app-uuid-abc" }) }));
    expect(screen.getByText("Catalog mapping")).toBeTruthy();
    expect(screen.getByText("Canonical product")).toBeTruthy();
    expect(screen.getByText("Confluence")).toBeTruthy();
    expect(screen.getByText("Atlassian")).toBeTruthy();
    expect(screen.getByText("Docs")).toBeTruthy();
    // no raw canonical/product UUID leaks
    expect(container.textContent).not.toContain(PRODUCT_UUID);
    expect(container.textContent).not.toContain("app-uuid-abc");
  });

  it("resolves org ids to NAMES when visible, 'Assigned' when not, '—' when null — never a raw UUID", async () => {
    const VISIBLE = "aaaa1111-2222-3333-4444-555555555555";
    const HIDDEN = "bbbb9999-8888-7777-6666-555555555555";
    asMock(getAppDetailForCurrentUser).mockResolvedValue({
      ok: true,
      data: { ...detail.data, responsibleOrgId: VISIBLE, payingOrgId: HIDDEN, procurementOrgId: null },
    });
    asMock(listContractsLinkedToApp).mockResolvedValue({ ok: true, data: [] });
    asMock(listAppUsersForApp).mockResolvedValue({ ok: true, data: [] });
    asMock(listMatchesForAppUsers).mockResolvedValue({ ok: true, data: [] });
    asMock(getCatalogMappingForApp).mockResolvedValue({ ok: true, data: { mapped: false } });
    asMock(listOrganizationsForCurrentUser).mockResolvedValue({ ok: true, data: [{ id: VISIBLE, name: "Flywheel" }] });

    const { container } = render(await AppDetailPage({ params: Promise.resolve({ id: "app-uuid-abc" }) }));
    expect(screen.getByText("Flywheel")).toBeTruthy(); // responsible org = visible → name
    expect(screen.getByText("Assigned")).toBeTruthy(); // paying org = present but not visible → "Assigned"
    // no raw org UUID (visible or hidden) leaks
    expect(container.textContent).not.toContain(VISIBLE);
    expect(container.textContent).not.toContain(HIDDEN);
  });
});
