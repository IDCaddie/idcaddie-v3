// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";

vi.mock("next/link", () => ({
  default: ({ href, children }: { href: unknown; children: React.ReactNode }) => (
    <a href={typeof href === "string" ? href : "#"}>{children}</a>
  ),
}));
vi.mock("@/lib/data/catalog", () => ({ listCatalogForCurrentUser: vi.fn() }));

import CatalogPage from "./page";
import { listCatalogForCurrentUser } from "@/lib/data/catalog";

const asMock = <T,>(fn: T) => fn as unknown as { mockResolvedValue: (v: unknown) => void };
const VENDOR_UUID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
afterEach(cleanup);

describe("/catalog render", () => {
  it("renders header, stats, and the grouped vendor→product→alias graph (no raw ids/provenance)", async () => {
    asMock(listCatalogForCurrentUser).mockResolvedValue({
      ok: true,
      data: {
        vendors: [{ id: VENDOR_UUID, name: "Atlassian", websiteDomain: "atlassian.com" }],
        products: [{ id: "p1", vendorId: VENDOR_UUID, name: "Jira", category: "PM" }],
        aliases: [{ id: "a1", productId: "p1", aliasType: "domain", aliasValue: "jira.example.com", reviewStatus: "pending", confidence: 90 }],
      },
    });
    const { container } = render(await CatalogPage({ searchParams: Promise.resolve({}) }));
    expect(screen.getByText("App Catalog")).toBeTruthy();
    expect(screen.getByText("Vendors")).toBeTruthy();
    expect(screen.getByText("Atlassian")).toBeTruthy();
    expect(screen.getByText("Jira")).toBeTruthy();
    expect(screen.getByText("jira.example.com")).toBeTruthy();
    expect(screen.getByPlaceholderText("Search vendor, product, or alias")).toBeTruthy();
    // regression: no raw vendor UUID or provenance leaks into the rendered UI
    expect(container.textContent).not.toContain(VENDOR_UUID);
    expect(container.textContent).not.toContain("provenance");
  });

  it("renders the empty state when there is no graph yet", async () => {
    asMock(listCatalogForCurrentUser).mockResolvedValue({ ok: true, data: { vendors: [], products: [], aliases: [] } });
    render(await CatalogPage({ searchParams: Promise.resolve({}) }));
    expect(screen.getByText("No catalog entries yet.")).toBeTruthy();
  });

  it("renders the safe unavailable state on a DAL error", async () => {
    asMock(listCatalogForCurrentUser).mockResolvedValue({ ok: false, error: "query_failed" });
    render(await CatalogPage({ searchParams: Promise.resolve({}) }));
    expect(screen.getByText(/Could not load the catalog/)).toBeTruthy();
  });
});
