// Phase 5B — PURE reconciliation of a PROVIDER DEFINITION with the CONNECTOR INSTANCES a workspace actually has.
//
// These are two different facts and the marketplace was conflating them:
//
//   Provider availability  — "does ID Caddie support this integration yet?"   Static, same for every customer.
//   Instance lifecycle     — "what has THIS workspace configured, and how far did it get?"   Per row, per tenant.
//
// The old card answered only the first, then overlaid Okta's persisted state through an Okta-shaped hole
// (`getOktaConnectorStatus` reads `okta_connector_configs`, a table only Okta has). Slack and Entra had real connector rows and
// no config row, so their cards said "Connection coming soon" while the workspace was looking at the instance on another page.
// And the override was keyed one-per-provider, so a second Okta organization could not be represented at all.
//
// Both truths must be shown at once. A synthetic Entra connector can exist while Entra ingestion does not: the card says
// "Preview" for the provider AND "Configuration saved" for the instance, and neither statement contradicts the other.
//
// Pure: no I/O, no server import. The instance rows arrive already loaded.

import type { CustomerConnector } from "./catalog-types";

// The instance shape this module needs — a structural subset of ConnectorSummary, so the loader can pass its rows straight in
// without a second mapping layer.
export type ProviderInstance = {
  readonly id: string;
  readonly provider: string;
  readonly name: string;
  readonly organization: string | null;
  readonly lifecycle: string;
  readonly lifecycleLabel: string;
  readonly active: boolean;
  readonly supersededBy: string | null;
  readonly counts: { readonly people: number; readonly groups: number; readonly applications: number };
};

// What the customer may do next with this provider, decided by what actually exists rather than by the catalogue.
export type ProviderAction = { readonly label: string; readonly href: string } | null;

export type ProviderCardModel = {
  readonly provider: string;
  readonly availabilityLabel: string;      // "Available" | "Preview" | "Coming soon" — about the PRODUCT
  readonly availabilityNote: string | null;
  readonly instances: readonly ProviderInstance[];
  readonly instanceSummary: string;        // "No connector instances" | "1 connector instance" | "N connector instances"
  readonly activeCount: number;
  readonly primary: ProviderAction;
  readonly secondary: ProviderAction;
  readonly canConnect: boolean;
};

// Availability describes the PRODUCT, never the workspace. `available` is reserved for a provider whose onboarding, verification
// and discovery are all proven; today only Okta qualifies, and the catalogue's `canConnect` is what records that.
export function availabilityLabel(c: CustomerConnector): string {
  if (c.availability === "coming_soon") return "Coming soon";
  return c.canConnect ? "Available" : "Preview";
}

// A provider can be usable for onboarding while its ONGOING capability is still limited. Saying so on the card is the difference
// between "you cannot connect this" and "you can connect it, but discovery is not live yet" — which are very different answers
// for a customer looking at a connector they already configured.
export function availabilityNote(c: CustomerConnector): string | null {
  if (c.availability === "coming_soon") return "Not available to connect yet.";
  if (!c.canConnect) return "Live discovery for this provider is not available yet. Existing connectors are shown, but nothing is imported from them.";
  return null;
}

const summary = (n: number) => (n === 0 ? "No connector instances" : n === 1 ? "1 connector instance" : `${n} connector instances`);

// The action is decided by the instances, in this order: nothing configured -> connect; something active -> open or manage;
// only retired instances -> show them, because "connect" alone would hide the fact that a connector already exists.
export function providerCard(c: CustomerConnector, all: readonly ProviderInstance[]): ProviderCardModel {
  const instances = all.filter((i) => i.provider === c.provider);
  const active = instances.filter((i) => i.active);
  const manageHref = `/connectors/manage?provider=${c.provider}`;
  const connect: ProviderAction = c.canConnect ? { label: instances.length === 0 ? `Connect ${c.displayName}` : `Connect another ${c.displayName} organization`, href: `/connectors/${c.provider}` } : null;

  let primary: ProviderAction;
  let secondary: ProviderAction = null;

  if (instances.length === 0) {
    // Nothing configured. A coming-soon provider gets no action at all rather than a button that cannot work.
    primary = c.availability === "coming_soon" ? null : c.canConnect ? connect : { label: "View details", href: `/connectors/${c.provider}` };
  } else if (active.length === 1) {
    primary = { label: "Open connector", href: `/connectors/manage/${active[0].id}` };
    secondary = connect;
  } else if (active.length > 1) {
    primary = { label: `Manage ${c.displayName} directories`, href: manageHref };
    secondary = connect;
  } else {
    // Instances exist but every one is retired. Never "Connect" as the only option — that would read as though nothing had ever
    // been configured, and the customer would lose the reconnect path.
    primary = { label: "View disconnected connectors", href: manageHref };
    secondary = connect;
  }

  return {
    provider: c.provider,
    availabilityLabel: availabilityLabel(c),
    availabilityNote: availabilityNote(c),
    instances, instanceSummary: summary(instances.length), activeCount: active.length,
    primary, secondary, canConnect: c.canConnect,
  };
}

// ── marketplace filters ───────────────────────────────────────────────────────────────────────────────────────────────────────
// "Connected" was the wrong word: it counted a saved configuration as a live connection. `configured` says exactly what it means —
// this workspace has at least one connector instance for the provider, at any lifecycle — and leaves "connected" unclaimed.
export const PROVIDER_FILTERS = ["all", "configured", "available", "preview", "coming_soon"] as const;
export type ProviderFilter = (typeof PROVIDER_FILTERS)[number];
export const PROVIDER_FILTER_LABEL: Record<ProviderFilter, string> = {
  all: "All", configured: "Configured", available: "Available", preview: "Preview", coming_soon: "Coming soon",
};

export function matchesProviderFilter(card: ProviderCardModel, filter: ProviderFilter): boolean {
  switch (filter) {
    case "configured": return card.instances.length > 0;
    case "available": return card.availabilityLabel === "Available";
    case "preview": return card.availabilityLabel === "Preview";
    case "coming_soon": return card.availabilityLabel === "Coming soon";
    default: return true;
  }
}
