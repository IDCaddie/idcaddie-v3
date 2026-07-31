import { describe, it, expect } from "vitest";
import { matchesStatusFilter, resolveConnectorView } from "./view";
import { listCustomerConnectors } from "./catalog";
import type { CustomerConnector } from "./catalog-types";

// ── Simulated state must never masquerade as a real connector ───────────────────────────────────────────────
// `demo` comes from sessionStorage — a browser-local preview, not evidence that anything exists in the database.
// The real record is server-rendered on the connection page. If a simulated card could say "Connected", nobody
// looking at the screen could tell a preview from a live tenant integration.
describe("demo state cannot masquerade as a real connection", () => {
  const okta = {
    provider: "okta", displayName: "Okta", category: "Identity", description: "",
    availability: "preview", connectionStatus: "not_connected", onboardingMode: "service_application",
    capabilities: [], setupTime: "", isPreview: true, canConnect: true,
    icon: { initial: "O", tint: "sky" },
  } as unknown as CustomerConnector;

  it.each(["connected_preview", "paused_preview", "verification_pending"] as const)(
    "labels the %s demo state as simulated, never connected/verified/discovered",
    (status) => {
      const v = resolveConnectorView(okta, { provider: "okta", status } as never);
      expect(v.statusLabel.toLowerCase()).toMatch(/simulated/);
      for (const banned of ["connected", "verified", "discovered", "healthy"]) {
        expect(v.statusLabel.toLowerCase(), `label must not claim ${banned}`).not.toContain(banned);
      }
      expect(`${v.statusNote ?? ""}`.toLowerCase()).toMatch(/demo/);
    },
  );

  it("uses a non-success tone, so a simulated card cannot read as a healthy live one", () => {
    const v = resolveConnectorView(okta, { provider: "okta", status: "connected_preview" } as never);
    expect(v.statusTone).not.toBe("success");
  });

  it("with NO demo state, an unconnected connector offers Connect and claims nothing", () => {
    const v = resolveConnectorView(okta, null);
    expect(v.statusLabel.toLowerCase()).not.toContain("connected");
    expect(v.cta.label).toMatch(/^Connect /);
  });
});

// ── Real persisted connector state (Phase 1) ───────────────────────────────────────────────────────────────────
// Before this, the Okta marketplace card could ONLY describe sessionStorage demo state, so a tenant with a genuinely
// configured connector saw "Preview" or, worse, "Simulated". These assert the database wins and that the wording
// tracks the actual stage.
describe("resolveConnectorView with real persisted state", () => {
  const okta = listCustomerConnectors().find((c) => c.provider === "okta")!;

  it("beats browser-local demo state — the database is the authority", () => {
    const v = resolveConnectorView(okta, { status: "connected_preview" } as never, { lifecycle: "discovered" });
    expect(v.statusLabel).toBe("Discovered");
    expect(v.statusLabel).not.toMatch(/Simulated/);
    expect(v.statusNote ?? "").not.toMatch(/Demo/i);
  });

  it("still never says Connected, at any real lifecycle", () => {
    for (const l of ["configuration_saved", "verification_pending", "verifying", "verified", "initial_discovery_pending", "discovering", "discovered", "failed"] as const) {
      const v = resolveConnectorView(okta, null, { lifecycle: l });
      expect(v.statusLabel.toLowerCase(), l).not.toContain("connected");
      expect(v.cta.href, l).toBe("/connectors/okta/status");
      expect(v.cta.disabled, l).toBe(false);
    }
  });

  it("reserves the success tone for discovered, because that is the only state where data landed", () => {
    expect(resolveConnectorView(okta, null, { lifecycle: "discovered" }).statusTone).toBe("success");
    // Verified is real progress, but nothing has synced. A green badge here reads as "it's working".
    expect(resolveConnectorView(okta, null, { lifecycle: "verified" }).statusTone).toBe("attention");
    expect(resolveConnectorView(okta, null, { lifecycle: "verification_pending" }).statusTone).toBe("attention");
  });

  it("surfaces a failure as danger with an actionable note", () => {
    const v = resolveConnectorView(okta, null, { lifecycle: "failed" });
    expect(v.statusTone).toBe("danger");
    expect(v.statusLabel).toBe("Failed");
    expect(v.statusNote).toMatch(/Action may be required/);
  });

  it("says verification is in progress only while it actually is", () => {
    expect(resolveConnectorView(okta, null, { lifecycle: "verification_pending" }).statusNote).toMatch(/Verification in progress/);
    expect(resolveConnectorView(okta, null, { lifecycle: "verified" }).statusNote).toBeNull();
    expect(resolveConnectorView(okta, null, { lifecycle: "discovered" }).statusNote).toBeNull();
  });

  it("falls back to the catalog default when there is no real connector", () => {
    // Absence of a row must not be dressed up as a state. null and undefined both mean "nothing persisted".
    for (const none of [null, undefined]) {
      expect(resolveConnectorView(okta, null, none).statusLabel).toBe("Preview");
    }
  });

  it("puts a real connector in the Connected filter bucket", () => {
    expect(matchesStatusFilter(okta, null, "connected", { lifecycle: "verification_pending" })).toBe(true);
    expect(matchesStatusFilter(okta, null, "available", { lifecycle: "verification_pending" })).toBe(false);
    expect(matchesStatusFilter(okta, null, "connected", null)).toBe(false);
  });
});
