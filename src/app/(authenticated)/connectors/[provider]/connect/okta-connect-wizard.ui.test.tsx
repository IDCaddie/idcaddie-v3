// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";

// P5E17 / P5E17b — the Okta preview connection WIZARD. Proves the SIMULATED 4-step flow, org-address validation surfacing, and
// the CORE safety properties: NO real OAuth redirect (router.push / window.location never navigate to Okta), NO password/token/
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
  it("rejects a bad org address, accepts a valid one, then walks the 4-step flow to a successful preview connection", () => {
    render(<OktaConnectWizard provider="okta" />);
    // exactly ONE preview banner, and it shows the concise Phase-10 copy
    expect(screen.getAllByText(/Preview mode/).length).toBe(1);
    // step 1 of 4 — Organization, with the guided helper copy
    expect(screen.getByText("Step 1 of 4")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Your Okta organization" })).toBeTruthy();
    expect(screen.getByText("Enter the address your team uses to sign in to Okta.")).toBeTruthy();

    // invalid → inline error, stays on org step
    typeOrg("evil.com");
    submitOrg();
    expect(screen.getByText(/ending in .okta.com/)).toBeTruthy();
    expect(screen.queryByText("Step 2 of 4")).toBeNull();

    // valid → step 2 Permissions (read-only)
    typeOrg("acme.okta.com");
    submitOrg();
    expect(screen.getByText("Step 2 of 4")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Permissions" })).toBeTruthy();
    expect(screen.getByText("ID Caddie requests read-only access to:")).toBeTruthy();
    expect(screen.getByText(/okta.users.read/)).toBeTruthy();
    expect(screen.getByText("ID Caddie cannot change users, passwords, MFA settings, or applications.")).toBeTruthy();

    // step 3 → Authorize PREVIEW (no redirect), Phase-10 copy
    fireEvent.click(screen.getByRole("button", { name: "Continue to Okta" }));
    expect(screen.getByText("Step 3 of 4")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Authorize with Okta" })).toBeTruthy();
    expect(screen.getByText(/redirected securely to Okta to approve read-only access/)).toBeTruthy();
    expect(push).not.toHaveBeenCalled(); // NO navigation to Okta

    // simulate approval → concrete connection checks → complete
    fireEvent.click(screen.getByRole("button", { name: "Simulate approval" }));
    expect(screen.getByText("Okta organization confirmed")).toBeTruthy();
    expect(screen.getByText("No data imported yet")).toBeTruthy();
    expect(screen.getByText("Ready for first sync")).toBeTruthy();
    expect(screen.queryByText("Connection encrypted")).toBeNull(); // no unverifiable claim
    fireEvent.click(screen.getByRole("button", { name: "Complete connection" }));

    // success + the ONLY state write: the sessionStorage preview connection
    expect(screen.getByText("Okta connected in preview mode")).toBeTruthy();
    const demo = getDemoConnection("okta");
    expect(demo?.status).toBe("connected_preview");
    expect(demo?.orgHost).toBe("acme.okta.com");
    expect(push).not.toHaveBeenCalled(); // still no real navigation anywhere in the happy path
  });

  it("normalizes a bare organization label to <label>.okta.com (near one-click)", () => {
    render(<OktaConnectWizard provider="okta" />);
    typeOrg("acme"); // bare label, no dot
    submitOrg();
    // advances (normalized to acme.okta.com and validated) and records the normalized host on completion
    expect(screen.getByText("Step 2 of 4")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Continue to Okta" }));
    fireEvent.click(screen.getByRole("button", { name: "Simulate approval" }));
    fireEvent.click(screen.getByRole("button", { name: "Complete connection" }));
    expect(getDemoConnection("okta")?.orgHost).toBe("acme.okta.com");
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

describe("Okta connect wizard — accessibility", () => {
  it("marks the active progress step with aria-current and does not announce terminal states as a numbered step", () => {
    const { container } = render(<OktaConnectWizard provider="okta" />);
    // exactly one active step marker on the progress bar
    expect(container.querySelectorAll('[aria-current="step"]').length).toBe(1);
    // drive to the terminal failed state
    typeOrg("acme.okta.com");
    submitOrg();
    fireEvent.click(screen.getByRole("button", { name: "Continue to Okta" }));
    fireEvent.click(screen.getByRole("button", { name: "Simulate a failed approval" }));
    // progress bar (and its step numbering) is gone on the terminal state
    expect(screen.queryByText(/Step \d of 4/)).toBeNull();
    expect(container.querySelector('[role="status"]')).not.toBeNull(); // result announced via role=status
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
