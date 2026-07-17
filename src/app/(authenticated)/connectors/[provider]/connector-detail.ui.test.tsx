// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import type { CustomerConnector } from "@/lib/customer-connectors/catalog-types";

// P5E17 — connector DETAIL page (server) + its demo-aware CTA (client). Proves: Okta shows the full "what we read / never
// access" experience + "Connect Okta" CTA; a coming-soon provider shows the coming-soon state and no connect flow; the CTA
// reflects the sessionStorage preview state. Registry mocked (nothing live).
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: unknown; children: React.ReactNode }) => (
    <a href={typeof href === "string" ? href : "#"} {...rest}>{children}</a>
  ),
}));
vi.mock("@/lib/server/connector-vault/provider-registry", () => ({
  getConnectorProvider: () => null,
  isConnectorProviderReady: () => false,
}));

import DetailPage from "./page";
import { ConnectorDetailCta } from "./connector-detail-cta";
import { setDemoConnection } from "@/lib/customer-connectors/demo-store";

const oktaConnector: CustomerConnector = {
  provider: "okta", displayName: "Okta", category: "Identity", description: "d", availability: "preview",
  connectionStatus: "not_connected", capabilities: ["Users"], setupTime: "About 2 minutes", isPreview: true,
  canConnect: true, canSync: false, canSchedule: false, icon: { initial: "O", tint: "sky" },
};

beforeEach(() => window.sessionStorage.clear());
afterEach(cleanup);

describe("connector detail page", () => {
  it("Okta detail: hero name, access/exclusion cards, setup time, and demoted access link", async () => {
    const { container } = render(await DetailPage({ params: Promise.resolve({ provider: "okta" }) }));
    // Hero heading is the provider name (not "Connect Okta" — that is now the CTA)
    expect(screen.getByRole("heading", { name: "Okta" })).toBeTruthy();
    // access-explanation cards use the new precise wording
    expect(screen.getByText("What ID Caddie can access")).toBeTruthy();
    expect(screen.getByText("What ID Caddie cannot access")).toBeTruthy();
    expect(screen.getByText(/Basic profile information, such as name, username, and email address/)).toBeTruthy();
    expect(screen.getByText("Passwords")).toBeTruthy(); // a cannot-access item
    expect(screen.getByText("MFA information")).toBeTruthy();
    // setup-time text lives in the hero CTA column
    expect(screen.getByText(/Setup takes about 2 minutes/)).toBeTruthy();
    // primary CTA + demoted secondary (a subtle text link to #access, NOT a competing "Learn how it works" button)
    expect(screen.getByRole("link", { name: "Connect Okta" }).getAttribute("href")).toBe("/connectors/okta/connect");
    expect(screen.getByRole("link", { name: "See what ID Caddie can access" }).getAttribute("href")).toBe("#access");
    expect(screen.queryByRole("link", { name: "Learn how it works" })).toBeNull();
    // initial-scope pills use the concise wording (Phase 5)
    expect(screen.getByText("No automatic sync")).toBeTruthy();
    // detail copy must not leak internal governance wording (Phase 16)
    const text = (container.textContent ?? "").toLowerCase();
    for (const forbidden of ["promotion", "canonical", "certificationonly", "risk-007", "credential", "kill switch", "connector runner", "pagination metadata", "task definition"]) {
      expect(text.includes(forbidden), `detail must not surface "${forbidden}"`).toBe(false);
    }
  });

  it("a coming-soon provider shows the coming-soon state and no connect CTA", async () => {
    render(await DetailPage({ params: Promise.resolve({ provider: "salesforce" }) }));
    expect(screen.getAllByText("Coming soon").length).toBeGreaterThan(0);
    expect(screen.queryByRole("link", { name: /^Connect / })).toBeNull();
  });
});

describe("ConnectorDetailCta (demo-aware)", () => {
  it("connectable → strong Connect CTA + setup time + subtle access link (no competing secondary button)", () => {
    render(<ConnectorDetailCta connector={oktaConnector} />);
    expect(screen.getByRole("link", { name: "Connect Okta" })).toBeTruthy();
    expect(screen.getByText(/Setup takes about 2 minutes/)).toBeTruthy();
    expect(screen.getByRole("link", { name: "See what ID Caddie can access" }).getAttribute("href")).toBe("#access");
    expect(screen.queryByRole("link", { name: "Learn how it works" })).toBeNull();
  });

  it("connected in preview → View connection + connected note (no Connect)", () => {
    setDemoConnection("okta", { status: "connected_preview", orgHost: "acme.okta.com", connectedAt: "2026-07-17T00:00:00Z" });
    render(<ConnectorDetailCta connector={oktaConnector} />);
    expect(screen.getByRole("link", { name: "View connection" }).getAttribute("href")).toBe("/connectors/okta/status");
    expect(screen.getByText("Connected in preview mode")).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Connect Okta" })).toBeNull();
  });

  it("preview but not connectable → connection coming soon (disabled)", () => {
    render(<ConnectorDetailCta connector={{ ...oktaConnector, canConnect: false }} />);
    const el = screen.getByText("Connection coming soon");
    expect(el.getAttribute("aria-disabled")).toBe("true");
  });
});
