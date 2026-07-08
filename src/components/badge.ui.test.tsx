// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { Badge, StatusBadge } from "./badge";

afterEach(cleanup);

describe("Badge", () => {
  it("renders each tone with its label", () => {
    for (const tone of ["success", "attention", "danger", "neutral"] as const) {
      const { unmount } = render(<Badge tone={tone}>{tone}-label</Badge>);
      expect(screen.getByText(`${tone}-label`)).toBeTruthy();
      unmount();
    }
  });
  it("renders the solid variant", () => {
    render(<Badge tone="success" variant="solid">solid-label</Badge>);
    expect(screen.getByText("solid-label")).toBeTruthy();
  });
});

describe("StatusBadge", () => {
  it("renders the status string verbatim (active/expired/pending/unknown)", () => {
    for (const v of ["active", "expired", "pending", "unknown"]) {
      const { unmount } = render(<StatusBadge value={v} />);
      expect(screen.getByText(v)).toBeTruthy();
      unmount();
    }
  });
  it("null / undefined / blank → '—' without crashing", () => {
    for (const v of [null, undefined, "   "] as const) {
      const { unmount } = render(<StatusBadge value={v} />);
      expect(screen.getByText("—")).toBeTruthy();
      unmount();
    }
  });
});
