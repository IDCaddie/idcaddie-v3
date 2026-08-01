// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { OktaStatusPanel } from "./okta-status-panel";
import type { OktaConnectorStatus } from "@/lib/data/okta-connector-status";

afterEach(cleanup);

const base: OktaConnectorStatus = {
  connectorId: "11111111-2222-4333-8444-555555555555",
  orgHost: "trial-5294016.okta.com",
  clientIdMasked: "0oa15f…a698",
  approvedScopes: ["okta.users.read", "okta.groups.read", "okta.apps.read"],
  adminRole: "Read Only Administrator",
  lifecycle: "verification_pending",
  configurationSaved: true,
  verified: false,
  discovered: false,
  productionEnabled: false,
  certificationOnly: true,
  lastVerifiedAt: null,
  lastDiscoveryAt: null,
  failureCategory: null,
};

describe("Okta status panel — saved but not verified", () => {
  it("says Configuration saved is pending verification, and never says Connected", () => {
    render(<OktaStatusPanel status={base} />);
    expect(screen.getByText("Verification pending")).toBeTruthy();
    // The single most damaging word this page could contain.
    expect(screen.queryByText(/\bconnected\b/i)).toBeNull();
    expect(screen.queryByText(/\bhealthy\b/i)).toBeNull();
  });

  it("states the operator-assisted reality instead of offering an action it cannot perform", () => {
    render(<OktaStatusPanel status={base} />);
    expect(screen.getByText(/ID Caddie verifies the connection/i)).toBeTruthy();
    // No verify/discovery control at all — not even a disabled one. A disabled button still invites a click and a
    // support ticket; content that explains who does it next does not.
    for (const b of screen.queryAllByRole("button")) {
      expect(b.textContent ?? "").not.toMatch(/verify|discover/i);
    }
  });

  it("shows the configuration the customer needs to check against Okta", () => {
    render(<OktaStatusPanel status={base} />);
    expect(screen.getByText("trial-5294016.okta.com")).toBeTruthy();
    expect(screen.getByText("0oa15f…a698")).toBeTruthy();
    expect(screen.getByText("Read Only Administrator")).toBeTruthy();
    for (const s of base.approvedScopes) expect(screen.getByText(s)).toBeTruthy();
    expect(screen.getAllByText(/Disabled/).length).toBeGreaterThan(0);   // production synchronization
  });

  it("does NOT offer access data before discovery has happened", () => {
    render(<OktaStatusPanel status={base} />);
    expect(screen.queryByRole("link", { name: "View access data" })).toBeNull();
  });
});

describe("Okta status panel — discovered", () => {
  const discovered: OktaConnectorStatus = {
    ...base, lifecycle: "discovered", verified: true, discovered: true,
    lastVerifiedAt: "2026-07-31T17:16:31.000Z", lastDiscoveryAt: "2026-07-31T17:20:00.000Z",
  };

  it("offers View access data pointing at /access — not Dashboard or App Catalog", () => {
    render(<OktaStatusPanel status={discovered} />);
    const link = screen.getByRole("link", { name: "View access data" });
    expect(link.getAttribute("href")).toBe("/access");
    // Directing a customer to Dashboards or the catalog as evidence of Okta discovery is the exact wrong turn: both
    // read `public.apps`, which Okta discovery never populates, so they would legitimately show zero.
    for (const l of screen.getAllByRole("link")) {
      expect(l.getAttribute("href")).not.toBe("/dashboards");
      expect(l.getAttribute("href")).not.toBe("/catalog");
    }
  });

  it("explains why App Catalog may still look empty", () => {
    render(<OktaStatusPanel status={discovered} />);
    expect(screen.getByText(/App Catalog is a separate SaaS normalization surface/i)).toBeTruthy();
  });

  it("drops the operator-assisted callout once there is nothing left to wait for", () => {
    render(<OktaStatusPanel status={discovered} />);
    expect(screen.queryByText(/ID Caddie verifies the connection/i)).toBeNull();
  });
});

describe("Okta status panel — failed", () => {
  it("surfaces the bounded failure category and still avoids free text", () => {
    render(<OktaStatusPanel status={{ ...base, lifecycle: "failed", failureCategory: "permission_insufficient" }} />);
    expect(screen.getByRole("alert").textContent).toMatch(/permission insufficient/i);
    // "Failed" appears twice by design: the lifecycle badge and the stage it failed at.
    expect(screen.getAllByText("Failed").length).toBeGreaterThanOrEqual(1);
    // The failure is attributed to VERIFICATION, not smeared across configuration too.
    expect(screen.getByText("Configuration").closest("li")?.textContent).toMatch(/Complete/);
  });
});

// ── Phase 2: directory links appear only once there is data behind them ──────────────────────────────────────
describe("directory links on the connector status page", () => {
  const hrefs = () => [...document.querySelectorAll("a")].map((a) => a.getAttribute("href") ?? "");

  it("offers People, Groups and Applications once discovery has completed", () => {
    render(<OktaStatusPanel status={{ ...base, lifecycle: "discovered", verified: true, discovered: true }} />);
    expect(hrefs()).toEqual(expect.arrayContaining(["/access", "/directory/people", "/directory/groups", "/directory/applications"]));
  });

  it("offers NONE of them before discovery — three empty lists read as a broken connector", () => {
    for (const lifecycle of ["configuration_saved", "verification_pending", "verified", "discovering", "failed"] as const) {
      render(<OktaStatusPanel status={{ ...base, lifecycle, verified: lifecycle === "verified" || lifecycle === "discovering", discovered: false }} />);
      for (const h of hrefs()) expect(h, `${lifecycle} must not link to a directory list`).not.toMatch(/^\/directory\//);
      cleanup();
    }
  });
});
