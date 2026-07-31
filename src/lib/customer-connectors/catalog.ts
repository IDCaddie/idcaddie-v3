// P5E17 — the CENTRALIZED customer-facing connector presentation model (the ONE place internal connector state maps to safe
// customer wording). PURE + server-safe: no secret/token/OAuth/DB/network. It never exposes internal governance (certificationOnly,
// RISK-007, pilot state, ECS, credential/secret references, task definitions, provider-registry lifecycle labels) — those map to
// plain-language customer states. `canConnect` is preview-only (a simulated flow); `canSync`/`canSchedule` are ALWAYS false this
// phase (nothing is live). Cross-checked against the internal registry so a genuinely runnable provider can never be surfaced.

import { getConnectorProvider, isConnectorProviderReady } from "../server/connector-vault/provider-registry";
import type { CustomerCategory, CustomerAvailability, CustomerConnector, IconTint, OnboardingMode } from "./catalog-types";

// Re-export the client-safe types + category constant so server consumers can keep importing them from `catalog`. The definitions
// live in ./catalog-types (pure, no registry) so client code can use them WITHOUT bundling this server-only module.
export type { CustomerCategory, CustomerAvailability, CustomerConnectionStatus, CustomerConnector, IconTint } from "./catalog-types";
export { CUSTOMER_CATEGORIES } from "./catalog-types";

// The one provider with a working PREVIEW connect flow this phase.
const DEMO_CONNECTABLE = new Set(["okta"]);
// Providers we present as "Preview" (in the connector preview program) — a foundation exists; connecting is Okta-first.
// Okta is live-verified end to end (KMS-signed auth, five discovered resource types, persisted under
// connector-scoped ownership) but stays in the preview PROGRAM — the availability enum is only
// "preview" | "coming_soon", and demoting Okta to coming_soon to escape a badge would be a lie in the
// other direction. What was actually false was the blanket "preview connectors do not import data".
const PREVIEW = new Set(["okta", "microsoft_entra", "slack"]);

type CatalogSeed = { provider: string; displayName: string; category: CustomerCategory; description: string; capabilities: readonly string[]; setupTime: string; icon: { initial: string; tint: IconTint } };

// The customer catalog — a curated marketing list (superset of the internal registry; the 8 not-yet-built providers are shown as
// "Coming soon"). Internal-only providers (e.g. the scim_fixture certification fixture) are deliberately NOT listed.
const CATALOG: readonly CatalogSeed[] = [
  { provider: "okta", displayName: "Okta", category: "Identity", description: "Discover users, groups, applications and who can reach what — including access granted through group membership.", capabilities: ["Users & groups", "App assignments"], setupTime: "About 2 minutes", icon: { initial: "O", tint: "sky" } },
  { provider: "microsoft_entra", displayName: "Microsoft Entra ID", category: "Identity", description: "Discover directory users and account status from Microsoft Entra ID.", capabilities: ["Users", "Account status"], setupTime: "About 2 minutes", icon: { initial: "E", tint: "indigo" } },
  { provider: "slack", displayName: "Slack", category: "Collaboration", description: "Discover members and workspace access from Slack.", capabilities: ["Members", "Workspace access"], setupTime: "About 2 minutes", icon: { initial: "S", tint: "violet" } },
  { provider: "google_workspace", displayName: "Google Workspace", category: "Productivity", description: "Discover users and groups from your Google Workspace directory.", capabilities: ["Users", "Groups"], setupTime: "About 2 minutes", icon: { initial: "G", tint: "emerald" } },
  { provider: "asana", displayName: "Asana", category: "Project management", description: "Discover members and workspace access from Asana.", capabilities: ["Members", "Workspaces"], setupTime: "About 2 minutes", icon: { initial: "A", tint: "rose" } },
  { provider: "jira", displayName: "Jira", category: "Project management", description: "Discover users and project access from Jira.", capabilities: ["Users", "Project access"], setupTime: "About 2 minutes", icon: { initial: "J", tint: "sky" } },
  { provider: "salesforce", displayName: "Salesforce", category: "CRM", description: "Discover users and license assignments from Salesforce.", capabilities: ["Users", "License assignments"], setupTime: "About 2 minutes", icon: { initial: "S", tint: "cyan" } },
  { provider: "zoom", displayName: "Zoom", category: "Collaboration", description: "Discover users and account status from Zoom.", capabilities: ["Users", "Account status"], setupTime: "About 2 minutes", icon: { initial: "Z", tint: "sky" } },
  { provider: "github", displayName: "GitHub", category: "Developer tools", description: "Discover members and organization access from GitHub.", capabilities: ["Members", "Org access"], setupTime: "About 2 minutes", icon: { initial: "G", tint: "slate" } },
  { provider: "dropbox", displayName: "Dropbox", category: "Storage", description: "Discover members and team access from Dropbox.", capabilities: ["Members", "Team access"], setupTime: "About 2 minutes", icon: { initial: "D", tint: "sky" } },
  { provider: "adobe", displayName: "Adobe", category: "Productivity", description: "Discover users and product access from Adobe.", capabilities: ["Users", "Product access"], setupTime: "About 2 minutes", icon: { initial: "A", tint: "rose" } },
  { provider: "hubspot", displayName: "HubSpot", category: "CRM", description: "Discover users and seat assignments from HubSpot.", capabilities: ["Users", "Seat assignments"], setupTime: "About 2 minutes", icon: { initial: "H", tint: "orange" } },
];

// Map ONE catalog seed to the customer model. This is the sole internal→customer mapping. `canConnect` is preview-only AND is
// guarded by the internal readiness gate: a provider that is genuinely ready (never true today) is NOT offered a preview connect.
// How each provider is connected. Okta is a service application (API Services + signing key — NO browser OAuth). Providers not
// listed default to oauth_installation. Kept minimal on purpose (no generic wizard engine).
const ONBOARDING_MODE: Record<string, OnboardingMode> = { okta: "service_application" };

function toCustomerConnector(seed: CatalogSeed): CustomerConnector {
  const availability: CustomerAvailability = PREVIEW.has(seed.provider) ? "preview" : "coming_soon";
  // Defense in depth: the customer preview connect is offered ONLY for a demo-enabled provider that is NOT internally runnable.
  const internallyReady = isConnectorProviderReady(seed.provider); // false for every provider today (fail-closed gate)
  const canConnect = DEMO_CONNECTABLE.has(seed.provider) && !internallyReady;
  return {
    provider: seed.provider,
    displayName: seed.displayName,
    category: seed.category,
    description: seed.description,
    availability,
    connectionStatus: "not_connected", // server default; the client overlays the sessionStorage demo state
    onboardingMode: ONBOARDING_MODE[seed.provider] ?? "oauth_installation",
    capabilities: seed.capabilities,
    setupTime: seed.setupTime,
    isPreview: availability === "preview",
    canConnect,
    canSync: false, // no live sync this phase
    canSchedule: false, // no scheduling this phase
    icon: seed.icon,
  };
}

export function listCustomerConnectors(): CustomerConnector[] {
  return CATALOG.map(toCustomerConnector);
}

export function getCustomerConnector(provider: string): CustomerConnector | null {
  const seed = CATALOG.find((c) => c.provider === provider);
  return seed ? toCustomerConnector(seed) : null;
}

// A provider is "known internally" if the registry defines it — used only to keep the catalog honest, never surfaced to customers.
export function isKnownInternalProvider(provider: string): boolean {
  return getConnectorProvider(provider) != null;
}
