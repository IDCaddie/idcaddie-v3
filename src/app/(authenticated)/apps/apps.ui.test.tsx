// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";

vi.mock("next/link", () => ({
  default: ({ href, children }: { href: unknown; children: React.ReactNode }) => (
    <a href={typeof href === "string" ? href : "#"}>{children}</a>
  ),
}));
vi.mock("@/lib/data/apps", () => ({ listAppsWithCountsForCurrentUser: vi.fn() }));

import AppsPage from "./page";
import { listAppsWithCountsForCurrentUser } from "@/lib/data/apps";

const asMock = <T,>(fn: T) => fn as unknown as { mockResolvedValue: (v: unknown) => void };
const rows = [
  { id: "a1", name: "Figma", vendorName: "Figma Inc", category: "Design", status: "active", linkedContractCount: 0, appUserCount: 5, hasOwner: false },
  { id: "a2", name: "Slack", vendorName: "Salesforce", category: "Comms", status: "active", linkedContractCount: 2, appUserCount: 9, hasOwner: true },
];
afterEach(cleanup);

describe("/apps render", () => {
  it("renders search box, filter/sort controls, and per-row attention chips", async () => {
    asMock(listAppsWithCountsForCurrentUser).mockResolvedValue({ ok: true, data: rows });
    render(await AppsPage({ searchParams: Promise.resolve({}) }));
    expect(screen.getByPlaceholderText("Search name or vendor")).toBeTruthy();
    expect(screen.getByText("Missing owner")).toBeTruthy();
    expect(screen.getByText("Missing contract")).toBeTruthy();
    expect(screen.getByText("Figma")).toBeTruthy();
    // Figma has no owner + no contract → both chips; Slack has neither chip.
    expect(screen.getByText("no owner")).toBeTruthy();
    expect(screen.getByText("no contract")).toBeTruthy();
  });

  it("shows the 'no match' empty state when a search excludes everything", async () => {
    asMock(listAppsWithCountsForCurrentUser).mockResolvedValue({ ok: true, data: rows });
    render(await AppsPage({ searchParams: Promise.resolve({ q: "zzzznomatch" }) }));
    expect(screen.getByText("No apps match your search/filters")).toBeTruthy();
  });

  it("applies the missing_contract filter (only apps with 0 contracts remain)", async () => {
    asMock(listAppsWithCountsForCurrentUser).mockResolvedValue({ ok: true, data: rows });
    render(await AppsPage({ searchParams: Promise.resolve({ filter: "missing_contract" }) }));
    expect(screen.getByText("Figma")).toBeTruthy();
    expect(screen.queryByText("Slack")).toBeNull();
  });
});
