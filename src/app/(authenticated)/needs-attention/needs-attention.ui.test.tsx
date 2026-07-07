// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";

vi.mock("next/link", () => ({
  default: ({ href, children }: { href: unknown; children: React.ReactNode }) => (
    <a href={typeof href === "string" ? href : "#"}>{children}</a>
  ),
}));
vi.mock("@/lib/data/needs-attention-loader", () => ({ getNeedsAttentionForCurrentUser: vi.fn() }));

import NeedsAttentionPage from "./page";
import { getNeedsAttentionForCurrentUser } from "@/lib/data/needs-attention-loader";

const asMock = <T,>(fn: T) => fn as unknown as { mockResolvedValue: (v: unknown) => void };
afterEach(cleanup);

describe("/needs-attention render", () => {
  it("renders sections with items and an all-clear (empty) section", async () => {
    asMock(getNeedsAttentionForCurrentUser).mockResolvedValue({
      sections: [
        { key: "apps-missing-owner", title: "Apps missing an owner", explanation: "x", state: "ok", count: 1, items: [{ label: "Figma", sublabel: "active", href: "/apps/a1" }] },
        { key: "contracts-missing-renewal", title: "Contracts missing a renewal date", explanation: "x", state: "empty", count: 0, items: [] },
      ],
    });
    render(await NeedsAttentionPage());
    expect(screen.getByText("Apps missing an owner")).toBeTruthy();
    expect(screen.getByText("Figma")).toBeTruthy();
    expect(screen.getByText("Contracts missing a renewal date")).toBeTruthy();
    expect(screen.getByText("All clear")).toBeTruthy();
  });
});
