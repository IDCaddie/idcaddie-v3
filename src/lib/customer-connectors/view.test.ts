import { describe, it, expect } from "vitest";
import { resolveConnectorView } from "./view";
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
