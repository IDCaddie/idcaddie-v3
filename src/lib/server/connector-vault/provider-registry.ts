// Server-safe connector PROVIDER REGISTRY — generic provider metadata for the gated connector vault
// (docs/42 §48). This is the provider abstraction that can eventually back many SaaS connectors, proven now
// with ONE inert skeleton entry (Slack). It is PURE, SAFE METADATA only — it does NOT exchange OAuth codes,
// generate an authorize URL, store or read any token/credential, touch `connector_secrets`, call a provider
// API, or run a sync. **No provider connector is functional yet.** Real token storage stays gated behind a
// later provider-specific reviewed PR.
//
// FAIL CLOSED: an unknown provider id returns null / a safe empty result; nothing here can be "used" to
// connect, exchange, sync, or store — those functions simply do not exist in this module. A provider is
// "ready" ONLY when it is explicitly enabled AND in a connectable status — every entry today is an inert
// `skeleton` with `enabled: false`, so `isConnectorProviderReady` returns false for all of them.
//
// SERVER-ONLY: under `src/lib/server/`, the runtime browser sentinel below, and `no-client-import.test.ts`.
// It has NO imports (pure TS data) — no DB, no Supabase, no service-role, no `process.env`, no provider SDK.

// Runtime server-only sentinel — throw if evaluated in a browser.
if (typeof (globalThis as { window?: unknown }).window !== "undefined") {
  throw new Error("connector-vault/provider-registry is server-only and must not be imported in client code");
}

// The generic provider id space the registry is built to support (only one is DEFINED today — see below).
export type ConnectorProviderId =
  | "slack"
  | "google_workspace"
  | "okta"
  | "microsoft_entra"
  | "zoom"
  | "atlassian"
  | "github";

export type ConnectorProviderAuthKind = "oauth2" | "api_key"; // metadata only — no secret handling here
export type ConnectorProviderCategory = "collaboration" | "identity" | "productivity" | "developer";
// Inert lifecycle labels. NONE of these is a "connected/credentialed" state — that lives behind a later PR.
export type ConnectorProviderStatus = "skeleton" | "not_connected" | "disabled" | "future";
export type ConnectorProviderCapability =
  | "read_users"
  | "read_apps"
  | "read_groups"
  | "read_audit"
  | "read_usage";

// A provider definition — SAFE display/metadata only. No field holds or references a secret, token, or
// authorize URL; `requiredScopes`/`capabilities` are display strings for "what this would request".
export type ConnectorProviderDefinition = {
  id: ConnectorProviderId;
  displayName: string;
  category: ConnectorProviderCategory;
  authKind: ConnectorProviderAuthKind;
  capabilities: readonly ConnectorProviderCapability[]; // metadata only
  status: ConnectorProviderStatus;
  reviewGate: string; // the gate that must clear before this provider can do anything real
  riskLevel: "low" | "medium" | "high";
  requiredScopes: readonly string[]; // DISPLAY-ONLY — never used to build an OAuth request here
  helpCopy: string;
  enabled: boolean; // default false — an inert skeleton is never enabled
};

// The ONE inert provider defined now: Slack. Skeleton, disabled, no URL, no token, no API.
const SLACK: ConnectorProviderDefinition = {
  id: "slack",
  displayName: "Slack",
  category: "collaboration",
  authKind: "oauth2",
  capabilities: ["read_users", "read_groups", "read_audit", "read_usage"],
  status: "skeleton",
  reviewGate: "provider-specific-reviewed-pr", // real token storage stays gated behind this
  riskLevel: "low",
  requiredScopes: ["users:read", "usergroups:read", "auditlogs:read"], // display-only metadata
  helpCopy:
    "Coming soon — not connected. Slack is a skeleton provider entry only: no credentials are stored and " +
    "connecting/sync are not built. A later reviewed PR adds the real OAuth + token storage behind the vault.",
  enabled: false,
};

// The registry, keyed by provider id. Only Slack today; future providers are added as definitions (the type
// space already lists them) once each clears its own reviewed PR.
const CONNECTOR_PROVIDERS: Readonly<Partial<Record<ConnectorProviderId, ConnectorProviderDefinition>>> = {
  slack: SLACK,
};

// List every defined provider's safe metadata (stable order by id).
export function listConnectorProviders(): readonly ConnectorProviderDefinition[] {
  return Object.values(CONNECTOR_PROVIDERS)
    .filter((d): d is ConnectorProviderDefinition => Boolean(d))
    .sort((a, b) => a.id.localeCompare(b.id));
}

// Look up one provider's safe metadata; returns null for an unknown/undefined id (fail closed).
export function getConnectorProvider(providerId: string): ConnectorProviderDefinition | null {
  if (!providerId || typeof providerId !== "string") return null;
  return CONNECTOR_PROVIDERS[providerId as ConnectorProviderId] ?? null;
}

// True only when a provider is a DEFINED entry in the registry (unknown ids fail closed).
export function isSupportedConnectorProvider(providerId: string): providerId is ConnectorProviderId {
  return getConnectorProvider(providerId) !== null;
}

// The provider's declared capabilities (display metadata); [] for an unknown provider (fail closed).
export function getProviderCapabilities(providerId: string): readonly ConnectorProviderCapability[] {
  return getConnectorProvider(providerId)?.capabilities ?? [];
}

// Fail-closed gate: a provider is "ready" to be connected ONLY when it is explicitly enabled AND in the
// `not_connected` status. Every inert skeleton (enabled:false / status:skeleton) is therefore NOT ready —
// it cannot be used to connect, exchange a code, sync, or store a credential (none of which exist here).
export function isConnectorProviderReady(providerId: string): boolean {
  const def = getConnectorProvider(providerId);
  return def != null && def.enabled === true && def.status === "not_connected";
}
