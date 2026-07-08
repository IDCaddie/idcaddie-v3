// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";

vi.mock("next/link", () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a>,
}));

import { SpendBars, RenewalSegmentBar, UpcomingRenewalRows } from "./simple-bars";

afterEach(cleanup);

describe("SpendBars", () => {
  it("renders the amount label + contract count", () => {
    render(<SpendBars segments={[{ currency: "USD", total: 1500, contractCount: 2, label: "$1,500.00", widthPct: 100 }]} />);
    expect(screen.getByText("$1,500.00")).toBeTruthy();
    expect(screen.getByText(/2 contracts/)).toBeTruthy();
  });
  it("renders an empty state", () => {
    render(<SpendBars segments={[]} />);
    expect(screen.getByText("No tracked contract spend yet.")).toBeTruthy();
  });
});

describe("RenewalSegmentBar", () => {
  it("renders text labels + counts (not color alone) and an accessible summary", () => {
    const { container } = render(
      <RenewalSegmentBar
        summary={{
          total: 4,
          segments: [
            { key: "due30", label: "Due ≤30 days", count: 2, tone: "danger", pct: 50 },
            { key: "due90", label: "Due 31–90 days", count: 1, tone: "attention", pct: 25 },
            { key: "missing", label: "No renewal/end date", count: 1, tone: "neutral", pct: 25 },
          ],
        }}
      />,
    );
    expect(screen.getByText(/Due ≤30 days/)).toBeTruthy();
    expect(screen.getByText(/No renewal\/end date/)).toBeTruthy();
    // the bar exposes the same info to assistive tech, not color alone
    expect(container.querySelector('[role="img"]')?.getAttribute("aria-label")).toMatch(/Due ≤30 days: 2/);
  });
  it("renders an empty state when nothing is dated", () => {
    render(<RenewalSegmentBar summary={{ total: 0, segments: [] }} />);
    expect(screen.getByText("No dated renewals to summarize.")).toBeTruthy();
  });
});

describe("UpcomingRenewalRows", () => {
  it("renders an urgency badge + a contract link", () => {
    const { container } = render(
      <UpcomingRenewalRows
        rows={[{ id: "c1", contractName: "AWS EDP", date: "2026-07-20", daysUntil: 5, basis: "renewal", tone: "danger", urgencyLabel: "in 5d" }]}
      />,
    );
    expect(screen.getByText("in 5d")).toBeTruthy();
    expect(screen.getByText("AWS EDP")).toBeTruthy();
    expect(container.querySelector('a[href="/contracts/c1"]')).toBeTruthy();
  });
  it("renders an empty state", () => {
    render(<UpcomingRenewalRows rows={[]} />);
    expect(screen.getByText("No upcoming renewals.")).toBeTruthy();
  });
});
