// P5E17 — the CLIENT-SAFE customer-connector types + category constants. PURE data: no server import, no registry, no
// secret/token/OAuth/DB/network. Split out of catalog.ts (which is server-only because it reads the provider registry) so client
// components — the marketplace category filter, cards, detail/status views — can use these without pulling the server-only
// provider-registry (and its browser sentinel) into the client bundle. catalog.ts re-exports these for server consumers.

// Customer-facing categories (the marketplace filters). Deliberately customer-shaped, not the internal registry categories.
export type CustomerCategory = "Identity" | "Collaboration" | "Project management" | "CRM" | "Storage" | "Productivity" | "Developer tools";
export const CUSTOMER_CATEGORIES: readonly CustomerCategory[] = ["Identity", "Collaboration", "Project management", "CRM", "Storage", "Productivity", "Developer tools"];

// Customer availability (marketplace label). NO internal lifecycle label ever reaches the customer.
export type CustomerAvailability = "preview" | "coming_soon";
// Live connection status. In this preview phase the only "connected" value is the simulated preview one.
// `verification_pending`: configuration was saved but ID Caddie has NOT verified the connection or imported any data — used by
// the Okta API Services onboarding (no browser OAuth; the durable credential is a signing key, verified later out of band).
export type CustomerConnectionStatus = "not_connected" | "verification_pending" | "connected_preview" | "paused_preview";

// Provider-neutral onboarding classification (small, not a wizard engine). How a customer connects a provider:
//   oauth_installation    — a browser OAuth install/consent (e.g. Slack, Zoom, Dropbox)
//   service_application    — a signing-credential service app configured in the provider admin (e.g. Okta API Services, GitHub App)
//   delegated_oauth        — delegated recurring OAuth requiring a durable refresh token
//   static_credential      — a static API credential
//   manual_enterprise_setup— guided manual enterprise setup
export type OnboardingMode = "oauth_installation" | "service_application" | "delegated_oauth" | "static_credential" | "manual_enterprise_setup";

export type IconTint = "sky" | "indigo" | "violet" | "emerald" | "rose" | "amber" | "orange" | "slate" | "cyan" | "teal";

export type CustomerConnector = {
  provider: string;
  displayName: string;
  category: CustomerCategory;
  description: string; // short value statement
  availability: CustomerAvailability;
  connectionStatus: CustomerConnectionStatus; // server default is not_connected; the client overlays the demo (session) state
  onboardingMode: OnboardingMode; // how this provider is connected (Okta = service_application — no browser OAuth)
  capabilities: readonly string[]; // customer-facing "what it reads" summary
  setupTime: string;
  isPreview: boolean;
  canConnect: boolean; // preview-only simulated connect flow
  canSync: boolean; // ALWAYS false this phase
  canSchedule: boolean; // ALWAYS false this phase
  icon: { initial: string; tint: IconTint };
};
