// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";

vi.mock("next/link", () => ({
  default: ({ href, children }: { href: unknown; children: React.ReactNode }) => (
    <a href={typeof href === "string" ? href : "#"}>{children}</a>
  ),
}));

import AppDetailError from "./apps/[id]/error";
import ContractDetailError from "./contracts/[id]/error";

afterEach(cleanup);
const err = Object.assign(new Error("secret internal stack detail"), { digest: "abc123" });

describe("route error boundaries", () => {
  it("app-detail error: safe copy + digest reference + back link, no error.message leak", () => {
    const { container } = render(<AppDetailError error={err} reset={() => {}} />);
    expect(screen.getByText("Something went wrong")).toBeTruthy();
    expect(screen.getByText(/Reference: abc123/)).toBeTruthy();
    expect(screen.getByText("Back to apps")).toBeTruthy();
    expect(container.textContent).not.toContain("secret internal stack detail");
  });

  it("contract-detail error: safe copy + back link, no error.message leak", () => {
    const { container } = render(<ContractDetailError error={err} reset={() => {}} />);
    expect(screen.getByText("Something went wrong")).toBeTruthy();
    expect(screen.getByText("Back to contracts")).toBeTruthy();
    expect(container.textContent).not.toContain("secret internal stack detail");
  });
});
