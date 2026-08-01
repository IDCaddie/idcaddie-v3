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
// O2A — the wizard now persists through a SERVER ACTION, not sessionStorage. The action is mocked so the UI can be exercised
// without a database, and so the test can assert exactly what the browser sent.
const actionCalls: FormData[] = [];
let actionResult: unknown = { status: "saved", connectorId: "c-1", orgHost: "acme.okta.com", nextAction: "platform_signing_key_pending", replay: false };
vi.mock("./actions", () => ({
  saveOktaConfigurationAction: async (_prev: unknown, fd: FormData) => { actionCalls.push(fd); return actionResult; },
}));
// O1B: reference the copy constants, not literals — a hardcoded scope label is exactly what drifted before.
import { OKTA_SETUP } from "@/lib/customer-connectors/okta-content";

const CLIENT_ID = "0oaTEST12345678abcd"; // synthetic 0oa… shape, non-secret

beforeEach(() => {
  // Reset the mocked server action so one failing test cannot leak its result into the next.
  actionCalls.length = 0;
  actionResult = { status: "saved", connectorId: "c-1", orgHost: "acme.okta.com", nextAction: "platform_signing_key_pending", replay: false };
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
  it("walks instructions → organization → configuration → review → verification pending", async () => {
    render(<OktaConnectWizard provider="okta" />);
    // The banner used to read "Preview mode — this walkthrough does not contact Okta or create a real connection."
    // That became false once the connector was live-verified end to end. It now describes what the STEP does, and must
    // still not promise any Okta contact at this point in the flow.
    expect(screen.queryByText(/Preview mode/)).toBeNull();
    expect(screen.getAllByText(/Reviewing connector configuration/).length).toBe(1);
    expect(screen.getByText(/Nothing is sent to Okta until you start a verification/)).toBeTruthy();
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

    // terminal — verification pending, NOT connected. The save is now a SERVER ACTION, so the transition is async.
    expect(await screen.findByRole("heading", { name: "Configuration saved" })).toBeTruthy();
    // Saved is NOT connected, and the operator-assisted reality is stated rather than implied by a dead button.
    expect(screen.queryByText(/Connected/)).toBeNull();
    expect(screen.getByText(/ID Caddie verifies the connection/i)).toBeTruthy();
    expect(screen.queryByText(/finishing its signing-key setup/i), "the obsolete platform dead end must be gone").toBeNull();
    expect(screen.getByText(/has not verified the connection and no directory data has been imported yet/)).toBeTruthy();
    expect(screen.queryByText(/\bconnected\b/i)).toBeNull();
    expect(screen.queryByText(/\bhealthy\b/i)).toBeNull();
    // "verified" DOES appear — in the negation "has not yet verified the connection", which is the truthful copy. What must not
    // appear is an AFFIRMATIVE claim, so assert the negated form is present rather than banning the word.
    expect(screen.getByText(/has not verified the connection/i)).toBeTruthy();

    // The browser sent ONLY the three non-secret inputs — no tenant, role, state, scopes or fingerprint.
    const sent = actionCalls.at(-1)!;
    expect(sent.get("orgHost")).toBe("acme.okta.com");
    expect(sent.get("clientId")).toBe(CLIENT_ID);
    expect(sent.get("idempotencyKey")).toMatch(/^[0-9a-f-]{36}$/i);
    expect([...sent.keys()].sort()).toEqual(["clientId", "idempotencyKey", "orgHost"]);

    // The truthful next step is shown, derived from what the platform actually has.
    expect(screen.getByText(/ID Caddie verifies the connection/i)).toBeTruthy();
    expect(push).not.toHaveBeenCalled();
  });

  it("shows a safe error and stays on review when the server rejects the configuration", async () => {
    actionResult = { status: "error", message: "You need to be an owner or admin to add a connection." };
    render(<OktaConnectWizard provider="okta" />);
    click("Start setup");
    typeOrg("acme.okta.com");
    click("Continue");
    fillConfiguration();
    click("Review");
    click("Save configuration");

    expect((await screen.findByRole("alert")).textContent).toMatch(/owner or admin/i);
    // still on review — no false success
    expect(screen.getByRole("heading", { name: "Review configuration" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Configuration saved" })).toBeNull();
  });

  it("a double-click submits once, and the idempotency key is stable across attempts", async () => {
    render(<OktaConnectWizard provider="okta" />);
    click("Start setup");
    typeOrg("acme.okta.com");
    click("Continue");
    fillConfiguration();
    click("Review");

    const before = actionCalls.length;
    const btn = screen.getByRole("button", { name: "Save configuration" });
    fireEvent.click(btn);
    fireEvent.click(btn);   // immediate second click, before the first resolves
    await screen.findByRole("heading", { name: "Configuration saved" });

    // The in-flight guard prevents the second submit; and even if a retry DID reach the server, the key is per-mount and stable,
    // so the RPC would return the same connector rather than create a second one.
    const sentKeys = actionCalls.slice(before).map((fd) => fd.get("idempotencyKey"));
    expect(actionCalls.length - before).toBe(1);
    expect(new Set(sentKeys).size).toBe(1);
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
    expect(actionCalls.at(-1)?.get("orgHost")).toBe("acme.okta.com");
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

  it("marks the active progress step with aria-current and drops step numbering on the terminal state", async () => {
    const { container } = render(<OktaConnectWizard provider="okta" />);
    expect(container.querySelectorAll('[aria-current="step"]').length).toBe(1);
    toConfiguration();
    fillConfiguration();
    click("Review");
    click("Save configuration");
    // The save is a SERVER ACTION now, so the terminal state arrives asynchronously — assert after it lands, not before.
    await screen.findByRole("heading", { name: "Configuration saved" });
    expect(screen.queryByText(/Step \d of 4/)).toBeNull();
    expect(container.querySelector('[role="status"]')).not.toBeNull();
  });
});

// ── Permission state ────────────────────────────────────────────────────────────────────────────────────────
// The server RPC is the real boundary; these assert the UI stops OFFERING an action it knows will be refused,
// and says why before the user clicks rather than after.
describe("Okta connect wizard — save permission", () => {
  function toReview(props: { canSave?: boolean } = {}) {
    render(<OktaConnectWizard provider="okta" {...props} />);
    click("Start setup");
    typeOrg("acme.okta.com");
    click("Continue");
    fillConfiguration();
    click("Review");
    expect(screen.getByRole("heading", { name: "Review configuration" })).toBeTruthy();
  }

  it("disables Save and explains why when the viewer is not owner/admin", () => {
    toReview({ canSave: false });
    expect((screen.getByRole("button", { name: "Save configuration" }) as HTMLButtonElement).disabled,
      "an action that cannot succeed must not be offered").toBe(true);
    expect(screen.getByText("Owner or administrator permissions are required to create a connector.")).toBeTruthy();
  });

  it("enables Save for an owner/admin", () => {
    toReview({ canSave: true });
    expect((screen.getByRole("button", { name: "Save configuration" }) as HTMLButtonElement).disabled).toBe(false);
    expect(screen.queryByText(/Owner or administrator permissions are required/)).toBeNull();
  });

  it("defaults to enabled when the prop is omitted, so a caller cannot lock everyone out by accident", () => {
    toReview();
    expect((screen.getByRole("button", { name: "Save configuration" }) as HTMLButtonElement).disabled).toBe(false);
  });
});
