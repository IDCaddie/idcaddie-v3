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
  it("Okta detail shows the value/reads/never-access content + Connect Okta CTA", async () => {
    const { container } = render(await DetailPage({ params: Promise.resolve({ provider: "okta" }) }));
    expect(screen.getByRole("heading", { name: "Connect Okta" })).toBeTruthy();
    expect(screen.getByText("What ID Caddie reads")).toBeTruthy();
    expect(screen.getByText("What ID Caddie never accesses")).toBeTruthy();
    expect(screen.getByText("Passwords")).toBeTruthy(); // a never-accessed item
    expect(screen.getByText(/About 2 minutes/)).toBeTruthy();
    expect(screen.getByRole("link", { name: "Connect Okta" }).getAttribute("href")).toBe("/connectors/okta/connect");
    expect(screen.getByRole("link", { name: "Learn how it works" }).getAttribute("href")).toBe("#how-it-works");
    // detail copy (incl. the initial-scope pills) must not leak internal governance wording (Phase 11)
    const text = (container.textContent ?? "").toLowerCase();
    for (const forbidden of ["promotion", "canonical", "certificationonly", "risk-007", "credential", "kill switch", "connector runner", "task definition", "ecs"]) {
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
  it("connectable → Connect + Learn how it works", () => {
    render(<ConnectorDetailCta connector={oktaConnector} />);
    expect(screen.getByRole("link", { name: "Connect Okta" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Learn how it works" })).toBeTruthy();
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
