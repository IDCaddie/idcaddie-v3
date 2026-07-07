// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";

vi.mock("next/link", () => ({
  default: ({ href, children }: { href: unknown; children: React.ReactNode }) => (
    <a href={typeof href === "string" ? href : "#"}>{children}</a>
  ),
}));
vi.mock("@/lib/data/contracts", () => ({ listContractsForCurrentUser: vi.fn() }));

import ContractsPage from "./page";
import { listContractsForCurrentUser } from "@/lib/data/contracts";

const asMock = <T,>(fn: T) => fn as unknown as { mockResolvedValue: (v: unknown) => void };
// A renewal ~10 days out (relative to render time) so the ≤30d badge fires; no owner → chip; a value to format.
const soon = new Date();
soon.setDate(soon.getDate() + 10);
const soonStr = soon.toISOString().slice(0, 10);
afterEach(cleanup);

describe("/contracts render", () => {
  it("renders formatted value, a renewal badge, and a no-owner chip", async () => {
    asMock(listContractsForCurrentUser).mockResolvedValue({
      ok: true,
      data: [
        { id: "c1", contractName: "AWS EDP", vendorName: "AWS", status: "active", category: "Cloud", renewalDate: soonStr, endDate: null, totalCost: 25000, currency: "USD", hasOwner: false, renewalResponsibility: null },
      ],
    });
    render(await ContractsPage());
    expect(screen.getByText("AWS EDP")).toBeTruthy();
    expect(screen.getByText(/25,000/)).toBeTruthy(); // formatted value
    expect(screen.getByText("≤30d")).toBeTruthy(); // renewal attention badge
    expect(screen.getByText("no owner")).toBeTruthy(); // ownership chip
  });

  it("renders the empty state", async () => {
    asMock(listContractsForCurrentUser).mockResolvedValue({ ok: true, data: [] });
    render(await ContractsPage());
    expect(screen.getByText("No contracts to show")).toBeTruthy();
  });
});
