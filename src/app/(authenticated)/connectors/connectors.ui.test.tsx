// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, within } from "@testing-library/react";

// Phase 5B — the marketplace, reconciled with persisted connector instances.
//
// The bug this replaces: the page asked `getOktaConnectorStatus()`, which reads a table only Okta has. Slack and Entra had real
// connector rows and no config row, so their cards said "Connection coming soon" while the workspace was looking at those very
// instances on another page. And the override was keyed one-per-provider, so a second Okta organization could not be shown.
//
// Two facts must now coexist on one card: provider availability (about the product) and instance lifecycle (about this workspace).
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: unknown; children: React.ReactNode }) => (
    <a href={typeof href === "string" ? href : "#"} {...rest}>{children}</a>
  ),
}));
vi.mock("@/lib/server/connector-vault/provider-registry", () => ({
  getConnectorProvider: () => null,
  isConnectorProviderReady: () => false, // every provider inert today — reproduces production
}));
vi.mock("@/lib/data/connector-management", () => ({ loadConnectorManagement: vi.fn() }));

import ConnectorsPage from "./page";
import { loadConnectorManagement } from "@/lib/data/connector-management";

const asMock = <T,>(fn: T) => fn as unknown as { mockResolvedValue: (v: unknown) => void };

const inst = (o: Record<string, unknown>) => ({
  id: "i-1", provider: "okta", name: "Corporate Okta", organization: "corp.okta.com",
  lifecycle: "discovered", lifecycleLabel: "Discovered", active: true, supersededBy: null, disconnectedAt: null,
  disconnectedReason: null, health: { state: "healthy", label: "Healthy", reason: "ok" },
  lastVerifiedAt: null, lastDiscoveryAt: null, createdAt: null,
  counts: { people: 1, groups: 6, applications: 2, memberships: 0, userAssignments: 0, groupAssignments: 0 }, ...o,
});
const withInstances = (connectors: unknown[]) => asMock(loadConnectorManagement).mockResolvedValue({
  ok: true, data: { connectors, activeCount: connectors.filter((c) => (c as { active: boolean }).active).length,
                    inactiveCount: connectors.filter((c) => !(c as { active: boolean }).active).length },
});

// The card for one provider, located by its heading rather than by index.
const cardFor = (container: HTMLElement, name: string) =>
  [...container.querySelectorAll("li")].find((li) => li.textContent?.includes(name))!;

beforeEach(() => { vi.clearAllMocks(); withInstances([]); });
afterEach(cleanup);

describe("provider availability and instance lifecycle are separate facts", () => {
  it("with NO instances, a provider shows availability and a connect action", async () => {
    const { container } = render(await ConnectorsPage());
    const okta = cardFor(container, "Okta");
    expect(within(okta).getByText("No connector instances")).toBeTruthy();
    expect(within(okta).getByRole("link", { name: /Connect Okta/ })).toBeTruthy();
  });

  it("a coming-soon provider with no instances offers no action", async () => {
    const { container } = render(await ConnectorsPage());
    const sf = cardFor(container, "Salesforce");
    expect(within(sf).getByText("Not available yet", { selector: "span[aria-disabled='true']" })).toBeTruthy();
    expect(within(sf).queryByRole("link", { name: /Connect/ })).toBeNull();
  });

  it("shows a DISCOVERED Okta instance with its counts and an Open action", async () => {
    withInstances([inst({})]);
    const { container } = render(await ConnectorsPage());
    const okta = cardFor(container, "Okta");
    expect(within(okta).getByText("1 connector instance")).toBeTruthy();
    expect(within(okta).getByText("Discovered")).toBeTruthy();
    expect(within(okta).getByText(/1 people · 6 groups · 2 apps/)).toBeTruthy();
    expect(within(okta).getByRole("link", { name: "Open connector" }).getAttribute("href")).toBe("/connectors/manage/i-1");
    expect(within(okta).getByRole("link", { name: /Connect another Okta organization/ })).toBeTruthy();
  });

  it("lists MULTIPLE Okta instances separately, never collapsed into one badge", async () => {
    // Two organizations at different lifecycles are two facts; a single summary badge would have to be wrong about one.
    withInstances([
      inst({ id: "i-1", name: "Corporate Okta" }),
      inst({ id: "i-2", name: "Sandbox Okta", organization: "sbx.okta.com", lifecycle: "configured", lifecycleLabel: "Configuration saved" }),
    ]);
    const { container } = render(await ConnectorsPage());
    const okta = cardFor(container, "Okta");
    expect(within(okta).getByText("2 connector instances")).toBeTruthy();
    expect(within(okta).getByText("Corporate Okta")).toBeTruthy();
    expect(within(okta).getByText("Sandbox Okta")).toBeTruthy();
    expect(within(okta).getByText("Discovered")).toBeTruthy();
    expect(within(okta).getByText("Configuration saved")).toBeTruthy();
    expect(within(okta).getByRole("link", { name: /Manage Okta directories/ }).getAttribute("href")).toBe("/connectors/manage?provider=okta");
  });

  it("shows a configured SLACK instance even though the provider is Preview", async () => {
    // The exact contradiction Phase 5B removes: the card used to say "Connection coming soon" about a configured connector.
    withInstances([inst({ id: "s-1", provider: "slack", name: "Development Workspace", organization: null, lifecycle: "configured", lifecycleLabel: "Configuration saved" })]);
    const { container } = render(await ConnectorsPage());
    const slack = cardFor(container, "Slack");
    expect(within(slack).getByText("Preview")).toBeTruthy();                 // the product
    expect(within(slack).getByText("1 connector instance")).toBeTruthy();     // this workspace
    expect(within(slack).getByText("Configuration saved")).toBeTruthy();
    expect(slack.textContent).not.toMatch(/Connection coming soon/i);
    // …but the limitation is still stated, because it is still true.
    expect(slack.textContent).toMatch(/Live discovery for this provider is not available yet/i);
  });

  it("shows a synthetic ENTRA instance as configured while the provider stays Preview", async () => {
    withInstances([inst({ id: "e-1", provider: "microsoft_entra", name: "Synthetic Entra Connector", organization: null, lifecycle: "configured", lifecycleLabel: "Configuration saved" })]);
    const { container } = render(await ConnectorsPage());
    const entra = cardFor(container, "Entra");
    expect(within(entra).getByText("Preview")).toBeTruthy();
    expect(within(entra).getByText("Configuration saved")).toBeTruthy();
    // Never implies ingestion works.
    expect(entra.textContent).not.toMatch(/Discovered/);
  });

  it("shows a DISCONNECTED instance as retired, with history preserved, and does not offer connect alone", async () => {
    withInstances([inst({ id: "s-1", provider: "slack", name: "Development Workspace", active: false, lifecycle: "disconnected", lifecycleLabel: "Disconnected" })]);
    const { container } = render(await ConnectorsPage());
    const slack = cardFor(container, "Slack");
    expect(within(slack).getByText("Disconnected")).toBeTruthy();
    expect(within(slack).getByText("history preserved")).toBeTruthy();
    // "Connect" as the ONLY option would read as though nothing had ever been configured and would hide the reconnect path.
    expect(within(slack).getByRole("link", { name: "View disconnected connectors" })).toBeTruthy();
  });

  it("never claims counts for an instance that has not discovered", async () => {
    withInstances([inst({ lifecycle: "verified", lifecycleLabel: "Verified" })]);
    const { container } = render(await ConnectorsPage());
    expect(cardFor(container, "Okta").textContent).not.toMatch(/people ·/);
  });
});

describe("the marketplace does not fabricate state", () => {
  it("says instance visibility needs an admin, rather than 'no instances'", async () => {
    asMock(loadConnectorManagement).mockResolvedValue({ ok: false, error: "forbidden" });
    const { container } = render(await ConnectorsPage());
    expect(container.textContent).toMatch(/requires an owner or admin/i);
    expect(container.textContent).not.toMatch(/1 connector instance/);
  });

  it("says a read FAILED rather than showing an empty estate", async () => {
    asMock(loadConnectorManagement).mockResolvedValue({ ok: false, error: "query_failed" });
    const { container } = render(await ConnectorsPage());
    expect(container.textContent).toMatch(/could not be loaded/i);
    expect(container.textContent).toMatch(/not a statement that none exist/i);
  });

  it("consults no browser-local demo state", async () => {
    // A sessionStorage key must not be able to make a card claim a connector exists.
    window.sessionStorage.setItem("idcaddie:demo-connectors:v1", JSON.stringify({ okta: { status: "connected_preview" } }));
    withInstances([]);
    const { container } = render(await ConnectorsPage());
    const okta = cardFor(container, "Okta");
    expect(within(okta).getByText("No connector instances")).toBeTruthy();
    expect(okta.textContent).not.toMatch(/Simulated|Connected/);
    window.sessionStorage.clear();
  });
});

describe("filters", () => {
  it("uses 'Configured', never 'Connected', for configuration-only state", async () => {
    const { container } = render(await ConnectorsPage());
    const labels = [...container.querySelectorAll("button[aria-pressed]")].map((b) => b.textContent);
    expect(labels).toContain("Configured");
    expect(labels, "a saved configuration is not a live connection").not.toContain("Connected");
  });

  it("Configured includes a provider with any instance, at any lifecycle", async () => {
    withInstances([inst({ id: "s-1", provider: "slack", name: "Dev", lifecycle: "configured", lifecycleLabel: "Configuration saved" })]);
    const { container } = render(await ConnectorsPage());
    fireEvent.click(screen.getByRole("button", { name: "Configured" }));
    expect(container.textContent).toContain("Slack");
    expect(container.textContent).not.toContain("Salesforce");
  });

  it("Available covers only providers whose onboarding actually works", async () => {
    const { container } = render(await ConnectorsPage());
    fireEvent.click(screen.getByRole("button", { name: "Available" }));
    // With the registry inert, nothing is Available — and the page says so rather than listing everything.
    expect(container.textContent).toMatch(/No providers match|Okta/);
  });

  it("Coming soon lists providers with no usable onboarding", async () => {
    const { container } = render(await ConnectorsPage());
    fireEvent.click(screen.getByRole("button", { name: "Coming soon" }));
    expect(container.textContent).toContain("Salesforce");
  });
});
