// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";

vi.mock("next/link", () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a>,
}));

import { StatCard, StatGrid } from "./stat-card";

afterEach(cleanup);

describe("StatCard", () => {
  it("renders label, value, and helper", () => {
    render(<StatCard label="Apps visible" value={12} sub="latest window" />);
    expect(screen.getByText("Apps visible")).toBeTruthy();
    expect(screen.getByText("12")).toBeTruthy();
    expect(screen.getByText("latest window")).toBeTruthy();
  });
  it("renders a link (with Open →) when href is provided", () => {
    const { container } = render(<StatCard label="Apps" value={3} href="/apps" />);
    expect(container.querySelector('a[href="/apps"]')).toBeTruthy();
    expect(screen.getByText("Open →")).toBeTruthy();
  });
  it("renders a non-link card (no Open →) when href is absent", () => {
    const { container } = render(<StatCard label="Apps" value={3} />);
    expect(container.querySelector("a")).toBeNull();
    expect(screen.queryByText("Open →")).toBeNull();
  });
  it("handles string and number values, and null/undefined → —", () => {
    const { rerender } = render(<StatCard label="Spend" value="$1,500" />);
    expect(screen.getByText("$1,500")).toBeTruthy();
    rerender(<StatCard label="N" value={null} />);
    expect(screen.getByText("—")).toBeTruthy();
    rerender(<StatCard label="N" value={undefined} />);
    expect(screen.getByText("—")).toBeTruthy();
  });
  it("supports all tones without crashing", () => {
    for (const tone of ["success", "attention", "danger", "neutral"] as const) {
      const { unmount } = render(<StatCard label="T" value={1} tone={tone} />);
      expect(screen.getByText("1")).toBeTruthy();
      unmount();
    }
  });
});

describe("StatGrid", () => {
  it("renders its children", () => {
    render(
      <StatGrid>
        <StatCard label="A" value={1} />
        <StatCard label="B" value={2} />
      </StatGrid>,
    );
    expect(screen.getByText("A")).toBeTruthy();
    expect(screen.getByText("B")).toBeTruthy();
  });
});
