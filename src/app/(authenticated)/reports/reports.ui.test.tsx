// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";

vi.mock("next/link", () => ({
  default: ({ href, children }: { href: unknown; children: React.ReactNode }) => (
    <a href={typeof href === "string" ? href : "#"}>{children}</a>
  ),
}));
vi.mock("@/lib/data/reports", () => ({ getReportsSummaryForCurrentUser: vi.fn() }));

import ReportsPage from "./page";
import { getReportsSummaryForCurrentUser } from "@/lib/data/reports";

const asMock = <T,>(fn: T) => fn as unknown as { mockResolvedValue: (v: unknown) => void };
afterEach(cleanup);

describe("/reports render", () => {
  it("renders the six summary cards deep-linking to their owning pages, with no raw ids", async () => {
    asMock(getReportsSummaryForCurrentUser).mockResolvedValue({
      appsVisible: 8,
      contractsVisible: 5,
      accountsVisible: 40,
      accountsMatched: 30,
      accountsUnmatched: 10,
      filesVisible: 3,
    });

    const { container } = render(await ReportsPage());
    for (const label of [
      "Apps visible",
      "Contracts visible",
      "App-user accounts visible",
      "Accounts matched",
      "Accounts unmatched",
      "Files visible",
    ]) {
      expect(screen.getByText(label)).toBeTruthy();
    }
    // deep-links point at the implemented owning pages
    expect(container.querySelector('a[href="/apps"]')).toBeTruthy();
    expect(container.querySelector('a[href="/contracts"]')).toBeTruthy();
    expect(container.querySelector('a[href="/people"]')).toBeTruthy(); // accounts/matched/unmatched → /people
    expect(container.querySelector('a[href="/files"]')).toBeTruthy();
    // honest counts render; no UUID-shaped strings leak
    expect(screen.getByText("30")).toBeTruthy();
    expect(container.textContent).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}/);
  });

  it("renders — for a null/unavailable count", async () => {
    asMock(getReportsSummaryForCurrentUser).mockResolvedValue({
      appsVisible: null,
      contractsVisible: 5,
      accountsVisible: 40,
      accountsMatched: 30,
      accountsUnmatched: 10,
      filesVisible: 3,
    });
    render(await ReportsPage());
    expect(screen.getByText("—")).toBeTruthy();
  });
});
