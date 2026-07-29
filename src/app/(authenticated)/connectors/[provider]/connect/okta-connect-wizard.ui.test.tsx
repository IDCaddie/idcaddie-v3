// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";

// The Okta API Services configuration guide. Okta is a SERVICE APPLICATION — NO browser OAuth, NO /authorize redirect, NO consent,
// NO callback, NO refresh token. This proves the config-guide flow, that the terminal state is verification_pending (never
// "connected"), and the safety properties: no browser-OAuth wording, no secret/token/password field, no anchor to a real Okta host.
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
// O1B: reference the copy constants, not literals — a hardcoded scope label is exactly what drifted before.
import { OKTA_SETUP } from "@/lib/customer-connectors/okta-content";

const CLIENT_ID = "0oaTEST12345678abcd"; // synthetic 0oa… shape, non-secret

beforeEach(() => {
  window.sessionStorage.clear();
  push.mockClear();
  replace.mockClear();
});
afterEach(cleanup);

const typeOrg = (v: string) => fireEvent.change(screen.getByLabelText("Okta organization address"), { target: { value: v } });
const click = (name: string) => fireEvent.click(screen.getByRole("button", { name }));
function toConfiguration(org = "acme.okta.com") {
  click("Start setup");
  typeOrg(org);
  click("Continue");
}
function fillConfiguration(clientId = CLIENT_ID) {
  fireEvent.change(screen.getByLabelText("API Services client ID"), { target: { value: clientId } });
  fireEvent.click(screen.getByLabelText(OKTA_SETUP.declareKey));
  fireEvent.click(screen.getByLabelText(OKTA_SETUP.declareScope));
  fireEvent.click(screen.getByLabelText(OKTA_SETUP.declareRole));
}

describe("Okta connect wizard — API Services configuration flow", () => {
  it("walks instructions → organization → configuration → review → verification pending", () => {
    render(<OktaConnectWizard provider="okta" />);
    expect(screen.getAllByText(/Preview mode/).length).toBe(1);
    // step 1 — instructions (service app, no browser sign-in)
    expect(screen.getByText("Step 1 of 4")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Set up Okta API Services" })).toBeTruthy();
    expect(screen.getByText(/There is no browser sign-in step\./)).toBeTruthy();
    click("Start setup");

    // step 2 — organization; invalid rejected, valid → issuer
    expect(screen.getByText("Step 2 of 4")).toBeTruthy();
    typeOrg("evil.com");
    click("Continue");
    expect(screen.getByText(/ending in .okta.com/)).toBeTruthy();
    expect(screen.queryByText("Step 3 of 4")).toBeNull();
    typeOrg("acme.okta.com");
    click("Continue");

    // step 3 — configuration; Review is gated on the 3 declarations + a valid client id
    expect(screen.getByText("Step 3 of 4")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Service application details" })).toBeTruthy();
    expect(screen.getByText("https://acme.okta.com")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Review" }) as HTMLButtonElement).disabled).toBe(true);
    fillConfiguration("not-a-client-id");
    click("Review");
    expect(screen.getByRole("alert").textContent).toMatch(/Enter the API Services client ID/); // invalid id rejected
    expect(screen.queryByText("Step 4 of 4")).toBeNull(); // stayed on configuration
    fireEvent.change(screen.getByLabelText("API Services client ID"), { target: { value: CLIENT_ID } });
    click("Review");

    // step 4 — review, then save
    expect(screen.getByText("Step 4 of 4")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Review configuration" })).toBeTruthy();
    expect(screen.getByText(CLIENT_ID)).toBeTruthy();
    click("Save configuration");

    // terminal — verification pending, NOT connected; the only state write is the sessionStorage preview
    expect(screen.getByRole("heading", { name: "Verification pending" })).toBeTruthy();
    expect(screen.getByText(/has not yet verified the connection or imported any data/)).toBeTruthy();
    expect(screen.queryByText(/connected/i)).toBeNull();
    const demo = getDemoConnection("okta");
    expect(demo?.status).toBe("verification_pending");
    expect(demo?.orgHost).toBe("acme.okta.com");
    expect(push).not.toHaveBeenCalled();
  });

  it("normalizes a bare organization label to <label>.okta.com", () => {
    render(<OktaConnectWizard provider="okta" />);
    click("Start setup");
    typeOrg("acme");
    click("Continue");
    expect(screen.getByText("https://acme.okta.com")).toBeTruthy();
    fillConfiguration();
    click("Review");
    click("Save configuration");
    expect(getDemoConnection("okta")?.orgHost).toBe("acme.okta.com");
  });

  it("does not advance to review until all three setup declarations are confirmed", () => {
    render(<OktaConnectWizard provider="okta" />);
    toConfiguration();
    fireEvent.change(screen.getByLabelText("API Services client ID"), { target: { value: CLIENT_ID } });
    fireEvent.click(screen.getByLabelText(OKTA_SETUP.declareScope)); // only one of three
    expect((screen.getByRole("button", { name: "Review" }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("Okta connect wizard — safety", () => {
  it("uses no browser-OAuth wording anywhere in the flow", () => {
    const { container } = render(<OktaConnectWizard provider="okta" />);
    const walk = () => (container.textContent ?? "").toLowerCase();
    let seen = walk();
    toConfiguration();
    seen += walk();
    fillConfiguration();
    click("Review");
    seen += walk();
    click("Save configuration");
    seen += walk();
    for (const banned of ["authorize", "redirect", "consent", "sign in to okta", "continue to okta", "refresh token"]) {
      expect(seen.includes(banned)).toBe(false);
    }
  });

  it("has no password/token/secret input and links to no real Okta OAuth endpoint", () => {
    const { container } = render(<OktaConnectWizard provider="okta" />);
    toConfiguration();
    fillConfiguration();
    click("Review");
    expect(container.querySelector("input[type=password]")).toBeNull();
    for (const input of Array.from(container.querySelectorAll("input"))) {
      const n = `${input.getAttribute("name") ?? ""}${input.id}`.toLowerCase();
      expect(/token|secret|password|client_secret/.test(n)).toBe(false);
    }
    for (const a of Array.from(container.querySelectorAll("a"))) {
      const href = (a.getAttribute("href") ?? "").toLowerCase();
      expect(href.includes("okta.com")).toBe(false);
      expect(href.includes("authorize")).toBe(false);
      expect(href.startsWith("http")).toBe(false);
    }
  });

  it("marks the active progress step with aria-current and drops step numbering on the terminal state", () => {
    const { container } = render(<OktaConnectWizard provider="okta" />);
    expect(container.querySelectorAll('[aria-current="step"]').length).toBe(1);
    toConfiguration();
    fillConfiguration();
    click("Review");
    click("Save configuration");
    expect(screen.queryByText(/Step \d of 4/)).toBeNull();
    expect(container.querySelector('[role="status"]')).not.toBeNull();
  });
});
