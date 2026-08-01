import { describe, it, expect } from "vitest";
import { connectorActions } from "./connector-health";
import { providerCard, matchesProviderFilter, availabilityLabel, PROVIDER_FILTER_LABEL, type ProviderInstance } from "@/lib/customer-connectors/provider-instances";
import type { CustomerConnector } from "@/lib/customer-connectors/catalog-types";

// Phase 5B — what a connector may DO, and what a provider card may CLAIM.
//
// One rule underpins both: a statement about the workspace must come from persisted state, and a statement about the product must
// come from the catalogue. Mixing them is what produced "Connection coming soon" on a configured connector.

const c = (o: Partial<Parameters<typeof connectorActions>[0]> = {}) => connectorActions({
  lifecycle: "discovered", active: true, supersededBy: null,
  counts: { people: 1, groups: 6, applications: 2 }, ...o,
});

describe("actions follow the persisted lifecycle", () => {
  it("offers access only when discovery produced records", () => {
    expect(c().kinds).toContain("access");
    // Discovery completed but found nothing: Access would be an empty page that reads as a broken product.
    expect(c({ counts: { people: 0, groups: 0, applications: 0 } }).kinds).not.toContain("access");
    expect(c({ lifecycle: "verified", counts: { people: 0, groups: 0, applications: 0 } }).kinds).not.toContain("access");
    expect(c({ lifecycle: "configured", counts: { people: 0, groups: 0, applications: 0 } }).kinds).not.toContain("access");
  });

  it("never offers directory browsing before there is a directory", () => {
    expect(c().kinds).toContain("directory");
    expect(c({ lifecycle: "configured", counts: { people: 0, groups: 0, applications: 0 } }).kinds).not.toContain("directory");
  });

  it("offers setup only while the connection is unverified", () => {
    expect(c({ lifecycle: "configured", counts: { people: 0, groups: 0, applications: 0 } }).kinds).toContain("setup");
    expect(c({ lifecycle: "verified", counts: { people: 0, groups: 0, applications: 0 } }).kinds).not.toContain("setup");
  });

  it("offers reconnect to a disconnected connector and disconnect to an active one — never both", () => {
    const active = c(), off = c({ active: false, lifecycle: "disconnected" });
    expect(active.kinds).toContain("disconnect");
    expect(active.kinds).not.toContain("reconnect");
    expect(off.kinds).toContain("reconnect");
    expect(off.kinds).not.toContain("disconnect");
  });

  it("never offers reconnect on a SUPERSEDED connector", () => {
    // Undoing a supersession would put two connectors for one organization back into active views — the double-count the P0 fix
    // closed. It points at the replacement instead.
    const s = c({ active: false, lifecycle: "superseded", supersededBy: "x" });
    expect(s.kinds).not.toContain("reconnect");
    expect(s.kinds).toContain("replacement");
  });

  it("always says what happens next, in words", () => {
    for (const o of [{}, { lifecycle: "verified" }, { lifecycle: "configured" }, { lifecycle: "failed" },
                     { active: false, lifecycle: "disconnected" }, { active: false, lifecycle: "superseded", supersededBy: "x" }]) {
      expect(c(o as never).nextStep.length, JSON.stringify(o)).toBeGreaterThan(20);
    }
    // The operator-assisted reality, stated rather than implied by a button that would do nothing.
    expect(c({ lifecycle: "verified", counts: { people: 0, groups: 0, applications: 0 } }).nextStep).toMatch(/operator-assisted/i);
  });

  it("history is always available, including for retired connectors", () => {
    for (const o of [{}, { active: false, lifecycle: "disconnected" }, { active: false, lifecycle: "superseded", supersededBy: "x" }]) {
      expect(c(o as never).kinds, JSON.stringify(o)).toContain("history");
    }
  });
});

// ── provider cards ───────────────────────────────────────────────────────────────────────────────────────────────────────────
const provider = (o: Partial<CustomerConnector> = {}): CustomerConnector => ({
  provider: "okta", displayName: "Okta", category: "Identity", description: "d",
  availability: "preview", connectionStatus: "not_connected", onboardingMode: "service_application",
  capabilities: [], setupTime: "2m", isPreview: true, canConnect: true, canSync: false, canSchedule: false,
  icon: { initial: "O", tint: "sky" }, ...o,
} as CustomerConnector);

const instance = (o: Partial<ProviderInstance> = {}): ProviderInstance => ({
  id: "i1", provider: "okta", name: "Corporate", organization: "corp.okta.com",
  lifecycle: "discovered", lifecycleLabel: "Discovered", active: true, supersededBy: null,
  counts: { people: 1, groups: 6, applications: 2 }, ...o,
});

describe("provider availability describes the PRODUCT, not the workspace", () => {
  it("is Available only when onboarding actually works", () => {
    expect(availabilityLabel(provider({ canConnect: true }))).toBe("Available");
    expect(availabilityLabel(provider({ canConnect: false }))).toBe("Preview");
    expect(availabilityLabel(provider({ availability: "coming_soon", canConnect: false }))).toBe("Coming soon");
  });

  it("stays Preview even when the workspace has instances", () => {
    // The Slack/Entra case: a configured connector is not evidence the provider is production-ready.
    const card = providerCard(provider({ provider: "slack", canConnect: false }), [instance({ provider: "slack", lifecycle: "configured", lifecycleLabel: "Configuration saved" })]);
    expect(card.availabilityLabel).toBe("Preview");
    expect(card.instances).toHaveLength(1);
    expect(card.availabilityNote).toMatch(/Live discovery for this provider is not available yet/i);
  });
});

describe("the card's action comes from what exists", () => {
  it("connect when nothing is configured", () => {
    expect(providerCard(provider(), []).primary?.label).toMatch(/^Connect Okta$/);
  });

  it("open when there is exactly one active instance, with connect-another beside it", () => {
    const card = providerCard(provider(), [instance()]);
    expect(card.primary).toEqual({ label: "Open connector", href: "/connectors/manage/i1" });
    expect(card.secondary?.label).toMatch(/Connect another Okta organization/);
  });

  it("manage when there are several, and never one collapsed badge", () => {
    const card = providerCard(provider(), [instance({ id: "a" }), instance({ id: "b", lifecycle: "configured", lifecycleLabel: "Configuration saved" })]);
    expect(card.primary?.href).toBe("/connectors/manage?provider=okta");
    expect(card.instanceSummary).toBe("2 connector instances");
    expect(card.instances.map((i) => i.lifecycleLabel)).toEqual(["Discovered", "Configuration saved"]);
  });

  it("surfaces retired instances rather than pretending nothing was configured", () => {
    const card = providerCard(provider(), [instance({ active: false, lifecycle: "disconnected", lifecycleLabel: "Disconnected" })]);
    expect(card.primary?.label).toBe("View disconnected connectors");
    expect(card.activeCount).toBe(0);
    expect(card.instanceSummary).toBe("1 connector instance");
  });

  it("gives a coming-soon provider with nothing configured no action at all", () => {
    expect(providerCard(provider({ availability: "coming_soon", canConnect: false }), []).primary).toBeNull();
  });

  it("keeps one provider's instances out of another's card", () => {
    const card = providerCard(provider({ provider: "slack", canConnect: false }), [instance({ provider: "okta" })]);
    expect(card.instances).toHaveLength(0);
    expect(card.instanceSummary).toBe("No connector instances");
  });
});

describe("filters", () => {
  it("labels the instance filter Configured, never Connected", () => {
    expect(PROVIDER_FILTER_LABEL.configured).toBe("Configured");
    expect(Object.values(PROVIDER_FILTER_LABEL)).not.toContain("Connected");
  });

  it("Configured means at least one instance at ANY lifecycle", () => {
    const withConfigured = providerCard(provider(), [instance({ lifecycle: "configured", lifecycleLabel: "Configuration saved" })]);
    const withRetired = providerCard(provider(), [instance({ active: false, lifecycle: "disconnected", lifecycleLabel: "Disconnected" })]);
    const none = providerCard(provider(), []);
    expect(matchesProviderFilter(withConfigured, "configured")).toBe(true);
    expect(matchesProviderFilter(withRetired, "configured")).toBe(true);
    expect(matchesProviderFilter(none, "configured")).toBe(false);
  });

  it("availability filters read the product, not the workspace", () => {
    const previewWithInstance = providerCard(provider({ canConnect: false }), [instance()]);
    expect(matchesProviderFilter(previewWithInstance, "preview")).toBe(true);
    expect(matchesProviderFilter(previewWithInstance, "available")).toBe(false);
  });
});
