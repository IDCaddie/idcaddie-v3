// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { MatchRateMeter, StatusDistributionBar } from "./match-rate-meter";

afterEach(cleanup);

describe("MatchRateMeter", () => {
  it("renders the floored % and exposes the counts via an accessible label (not color alone)", () => {
    const { container } = render(<MatchRateMeter summary={{ matched: 2, unmatched: 1, total: 3, ratePct: 66 }} />);
    expect(screen.getByText("66%")).toBeTruthy();
    expect(container.querySelector('[role="img"]')?.getAttribute("aria-label")).toMatch(/Matched 2 of 3 accounts \(66%\)/);
    // counts also present as text
    expect(container.textContent).toMatch(/2/);
    expect(container.textContent).toMatch(/unmatched of 3/);
  });
  it("renders a safe empty state at 0 total", () => {
    render(<MatchRateMeter summary={{ matched: 0, unmatched: 0, total: 0, ratePct: 0 }} />);
    expect(screen.getByText("No accounts to summarize.")).toBeTruthy();
  });
  it("renders an unavailable state", () => {
    render(<MatchRateMeter summary={{ matched: 0, unmatched: 0, total: 0, ratePct: 0 }} available={false} />);
    expect(screen.getByText("Match status unavailable for these accounts.")).toBeTruthy();
  });
});

describe("StatusDistributionBar", () => {
  it("renders text labels + counts (not color-only)", () => {
    render(
      <StatusDistributionBar
        total={4}
        segments={[
          { key: "active", label: "Active", count: 3, tone: "success", pct: 75 },
          { key: "inactive", label: "Inactive", count: 1, tone: "attention", pct: 25 },
        ]}
      />,
    );
    expect(screen.getByText(/Active/)).toBeTruthy();
    expect(screen.getByText(/Inactive/)).toBeTruthy();
  });
  it("renders a safe empty state at 0 total", () => {
    render(<StatusDistributionBar total={0} segments={[]} />);
    expect(screen.getByText("No account status to summarize.")).toBeTruthy();
  });
});
