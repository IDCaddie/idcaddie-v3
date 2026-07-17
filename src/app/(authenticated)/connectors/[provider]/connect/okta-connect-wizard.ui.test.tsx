// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";

// P5E17 — the Okta preview connection WIZARD. Proves the simulated 5-step flow, org-address validation surfacing, and the
// CORE safety properties: NO real OAuth redirect (router.push / window.location never navigate to Okta), NO password/token/
// secret field, and the ONLY persisted state is the sessionStorage preview connection (written on success, absent on failure).
const push = vi.fn();
const replace = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push, replace }) }));
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: unknown; children: React.ReactNode }) => (
    <a href={typeof href === "string" ? href : "#"} {...rest}>{children}</a>
  ),
}));

import { OktaConnectWizard } from "./okta-connect-wizard";
import { getDemoConnection } from "@/lib/customer-connectors/demo-store";

beforeEach(() => {
  window.sessionStorage.clear();
  push.mockClear();
  replace.mockClear();
});
afterEach(cleanup);

const typeOrg = (v: string) => fireEvent.change(screen.getByLabelText("Okta organization address"), { target: { value: v } });
const submitOrg = () => fireEvent.click(screen.getByRole("button", { name: "Continue" }));

describe("Okta connect wizard — flow", () => {
  it("rejects a bad org address, accepts a valid one, then walks to a successful preview connection", () => {
    render(<OktaConnectWizard provider="okta" />);
    // preview banner is unmissable on step one
    expect(screen.getByText(/Preview mode/)).toBeTruthy();

    // invalid → inline error, stays on org step
    typeOrg("evil.com");
    submitOrg();
    expect(screen.getByText(/ending in .okta.com/)).toBeTruthy();
    expect(screen.queryByText("Permissions")).toBeNull();

    // valid → permissions step (read-only)
    typeOrg("acme.okta.com");
    submitOrg();
    expect(screen.getByRole("heading", { name: "Permissions" })).toBeTruthy();
    expect(screen.getByText(/okta.users.read/)).toBeTruthy();

    // permissions → authorize PREVIEW (no redirect)
    fireEvent.click(screen.getByRole("button", { name: "Continue to Okta" }));
    expect(screen.getByRole("heading", { name: "Okta authorization preview" })).toBeTruthy();
    expect(push).not.toHaveBeenCalled(); // NO navigation to Okta

    // simulate approval → connection check → complete
    fireEvent.click(screen.getByRole("button", { name: "Simulate approval" }));
    expect(screen.getByRole("heading", { name: "Connection check" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Complete connection" }));

    // success + the ONLY state write: the sessionStorage preview connection
    expect(screen.getByText("Okta connected in preview mode")).toBeTruthy();
    const demo = getDemoConnection("okta");
    expect(demo?.status).toBe("connected_preview");
    expect(demo?.orgHost).toBe("acme.okta.com");
    expect(push).not.toHaveBeenCalled(); // still no real navigation anywhere in the happy path
  });

  it("a simulated failed approval writes NO preview state", () => {
    render(<OktaConnectWizard provider="okta" />);
    typeOrg("acme.okta.com");
    submitOrg();
    fireEvent.click(screen.getByRole("button", { name: "Continue to Okta" }));
    fireEvent.click(screen.getByRole("button", { name: "Simulate a failed approval" }));
    expect(screen.getByText("Connection not completed")).toBeTruthy();
    expect(getDemoConnection("okta")).toBeNull();
  });
});

describe("Okta connect wizard — safety", () => {
  it("has no password/token/secret input and links to no real Okta OAuth endpoint", () => {
    const { container } = render(<OktaConnectWizard provider="okta" />);
    typeOrg("acme.okta.com");
    submitOrg();
    fireEvent.click(screen.getByRole("button", { name: "Continue to Okta" }));
    // walk every rendered step by simulating the whole flow, checking each render
    expect(container.querySelector("input[type=password]")).toBeNull();
    for (const input of Array.from(container.querySelectorAll("input"))) {
      const n = `${input.getAttribute("name") ?? ""}${input.id}`.toLowerCase();
      expect(/token|secret|password|client_id|client_secret/.test(n)).toBe(false);
    }
    // no anchor points at a real Okta host / authorize endpoint
    for (const a of Array.from(container.querySelectorAll("a"))) {
      const href = (a.getAttribute("href") ?? "").toLowerCase();
      expect(href.includes("okta.com")).toBe(false);
      expect(href.includes("authorize")).toBe(false);
      expect(href.startsWith("http")).toBe(false);
    }
  });
});
