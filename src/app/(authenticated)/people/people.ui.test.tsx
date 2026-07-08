// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";

vi.mock("next/link", () => ({
  default: ({ href, children }: { href: unknown; children: React.ReactNode }) => (
    <a href={typeof href === "string" ? href : "#"}>{children}</a>
  ),
}));
vi.mock("@/lib/data/people", () => ({ listIdentityAccountsForCurrentUser: vi.fn() }));

import PeoplePage from "./page";
import { listIdentityAccountsForCurrentUser } from "@/lib/data/people";

const asMock = <T,>(fn: T) => fn as unknown as { mockResolvedValue: (v: unknown) => void };
afterEach(cleanup);

const account = (o: Record<string, unknown>) => ({
  id: "acct-uuid-1",
  appId: "app-uuid-1",
  appName: "Figma",
  displayName: "Alice",
  email: "alice@x.com",
  status: "active",
  licenseType: null,
  lastActiveAt: null,
  matched: true,
  ...o,
});

describe("/people render", () => {
  it("shows the match-coverage meter and the not-UAR copy, with no raw ids", async () => {
    asMock(listIdentityAccountsForCurrentUser).mockResolvedValue({
      ok: true,
      data: {
        totalAccounts: 3,
        distinctApps: 1,
        matchStatusAvailable: true,
        matchedAccounts: 2,
        unmatchedAccounts: 1,
        accounts: [account({ id: "acct-uuid-1", matched: true }), account({ id: "acct-uuid-2", matched: false })],
      },
    });
    const { container } = render(await PeoplePage());
    // match coverage meter: 2/3 → 66%
    expect(screen.getByText("Match coverage")).toBeTruthy();
    expect(screen.getByText("66%")).toBeTruthy();
    // explicit coverage-not-UAR copy
    expect(screen.getByText(/not a full user-access-review/)).toBeTruthy();
    // no raw account/app UUID leaks into the rendered UI
    expect(container.textContent).not.toContain("acct-uuid-1");
    expect(container.textContent).not.toContain("app-uuid-1");
  });

  it("shows an unavailable meter (no misleading 0%) when match status is unavailable", async () => {
    asMock(listIdentityAccountsForCurrentUser).mockResolvedValue({
      ok: true,
      data: {
        totalAccounts: 2,
        distinctApps: 1,
        matchStatusAvailable: false,
        matchedAccounts: 0,
        unmatchedAccounts: 0,
        accounts: [account({ matched: false })],
      },
    });
    render(await PeoplePage());
    expect(screen.getByText("Match status unavailable for these accounts.")).toBeTruthy();
  });
});
