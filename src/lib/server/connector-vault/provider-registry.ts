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
  | "github"
  | "scim_fixture"; // SYNTHETIC SCIM 2.0 proof provider (fixture-only, non-routable) — NOT a real vendor. See SCIM_FIXTURE below.

export type ConnectorProviderAuthKind = "oauth2" | "api_key"; // metadata only — no secret handling here
export type ConnectorProviderCategory = "collaboration" | "identity" | "productivity" | "developer" | "finance";
// Inert lifecycle labels. NONE of these is a "connected/credentialed" state — that lives behind a later PR.
export type ConnectorProviderStatus = "skeleton" | "not_connected" | "disabled" | "future";
// The connector TAXONOMY (docs/42 §55): DISCOVERY connectors find many SaaS apps fast from identity/core
// systems; DEEP-SYNC runners enrich selected apps later (provider-specific, added one at a time). These are
// classification LABELS only — no provider is functional.
export type ConnectorKind =
  | "identity_provider_discovery"
  | "deep_provider_sync"
  | "spend_invoice_discovery"
  | "import_source"
  | "browser_extension_discovery"
  | "manual_source";
// Deep-sync read capabilities (what a provider sync runner would enrich) — display metadata only.
export type ConnectorProviderCapability =
  | "read_users"
  | "read_apps"
  | "read_groups"
  | "read_audit"
  | "read_usage";
// Discovery capabilities (what a discovery connector would surface to the app graph) — display metadata only.
export type DiscoveryCapability =
  | "discover_apps"
  | "discover_assigned_users"
  | "discover_groups"
  | "discover_login_activity"
  | "discover_domains"
  | "discover_owners"
  | "discover_sso_metadata"
  | "discover_usage_signals"
  | "discover_spend_signals"
  | "import_app_inventory";

// A provider definition — SAFE display/metadata only. No field holds or references a secret, token, or
// authorize URL; `requiredScopes`/`capabilities` are display strings for "what this would request".
export type ConnectorProviderDefinition = {
  id: ConnectorProviderId;
  displayName: string;
  category: ConnectorProviderCategory;
  authKind: ConnectorProviderAuthKind;
  kind: ConnectorKind; // discovery connector vs deep-sync runner vs import/source — classification only
  capabilities: readonly ConnectorProviderCapability[]; // deep-sync read capabilities (display metadata only)
  discoveryCapabilities: readonly DiscoveryCapability[]; // discovery capabilities ([] for a pure deep-sync runner)
  status: ConnectorProviderStatus;
  reviewGate: string; // the gate that must clear before this provider can do anything real
  riskLevel: "low" | "medium" | "high";
  requiredScopes: readonly string[]; // DISPLAY-ONLY — never used to build an OAuth request here
  helpCopy: string;
  enabled: boolean; // default false — an inert skeleton is never enabled
};

// Slack — the first DEEP-SYNC runner (skeleton, the §49/§54 authorize/callback/pending/consume seams exist
// but nothing is functional). Disabled, no URL, no token, no API.
const SLACK: ConnectorProviderDefinition = {
  id: "slack",
  displayName: "Slack",
  category: "collaboration",
  authKind: "oauth2",
  kind: "deep_provider_sync",
  capabilities: ["read_users", "read_groups", "read_audit", "read_usage"],
  discoveryCapabilities: [], // Slack is modeled as a deep-sync runner, not a discovery connector
  status: "skeleton",
  reviewGate: "provider-specific-reviewed-pr", // real token storage stays gated behind this
  riskLevel: "low",
  requiredScopes: ["users:read", "usergroups:read"], // display-only metadata
  helpCopy:
    "Coming soon — not connected. Slack is a skeleton provider entry only: no credentials are stored and " +
    "connecting/sync are not built. A later reviewed PR adds the real OAuth + token storage behind the vault.",
  enabled: false,
};

// Inert FUTURE identity-provider DISCOVERY connectors (docs/42 §55) — they would discover many SaaS apps +
// assigned users fast from the identity/core system. Pure metadata: status `future`, disabled, NO code, no
// OAuth URL, no token, no API, no sync. discoveryCapabilities are DISPLAY labels for "what this would find".
const OKTA: ConnectorProviderDefinition = {
  id: "okta",
  displayName: "Okta",
  category: "identity",
  authKind: "oauth2",
  kind: "identity_provider_discovery",
  capabilities: [],
  discoveryCapabilities: [
    "discover_apps", "discover_assigned_users", "discover_groups", "discover_sso_metadata",
    "discover_login_activity", "discover_owners",
  ],
  status: "future",
  reviewGate: "provider-specific-reviewed-pr",
  riskLevel: "medium",
  requiredScopes: ["okta.apps.read", "okta.users.read", "okta.groups.read"], // display-only metadata
  helpCopy:
    "Future identity-provider discovery connector — not connected. Okta would discover many SaaS apps and " +
    "assigned users quickly; no credentials are stored, and discovery/sync are not built.",
  enabled: false,
};
const GOOGLE_WORKSPACE: ConnectorProviderDefinition = {
  id: "google_workspace",
  displayName: "Google Workspace",
  category: "identity",
  authKind: "oauth2",
  kind: "identity_provider_discovery",
  capabilities: [],
  discoveryCapabilities: [
    "discover_apps", "discover_assigned_users", "discover_groups", "discover_sso_metadata",
    "discover_login_activity", "discover_domains",
  ],
  status: "future",
  reviewGate: "provider-specific-reviewed-pr",
  riskLevel: "medium",
  requiredScopes: ["admin.directory.user.readonly", "admin.directory.group.readonly"], // display-only labels
  helpCopy:
    "Future identity-provider discovery connector — not connected. Google Workspace would discover many SaaS " +
    "apps and assigned users quickly; no credentials are stored, and discovery/sync are not built.",
  enabled: false,
};
const MICROSOFT_ENTRA: ConnectorProviderDefinition = {
  id: "microsoft_entra",
  displayName: "Microsoft Entra ID",
  category: "identity",
  authKind: "oauth2",
  kind: "identity_provider_discovery",
  capabilities: [],
  discoveryCapabilities: [
    "discover_apps", "discover_assigned_users", "discover_groups", "discover_sso_metadata",
    "discover_login_activity", "discover_owners",
  ],
  status: "future",
  reviewGate: "provider-specific-reviewed-pr",
  riskLevel: "medium",
  requiredScopes: ["Application.Read.All", "User.Read.All", "Group.Read.All"], // display-only metadata
  helpCopy:
    "Future identity-provider discovery connector — not connected. Microsoft Entra ID would discover many SaaS " +
    "apps and assigned users quickly; no credentials are stored, and discovery/sync are not built.",
  enabled: false,
};

// SYNTHETIC SCIM 2.0 FIXTURE provider — NOT a real vendor and never live. It exists ONLY so the Connector Framework can
// certify a fixture-only SCIM proof (see the connector-runner's docs/SCIM_PROOF_PROVIDER_DESIGN.md). Its host (allowlisted
// in manifest-schema.ts) is the reserved, NON-ROUTABLE `.invalid` TLD (RFC 6761) — it can never resolve to any real
// service. Inert: disabled, no credentials, no OAuth, no API, no sync; it carries no vendor or customer identity.
const SCIM_FIXTURE: ConnectorProviderDefinition = {
  id: "scim_fixture",
  displayName: "SCIM (synthetic fixture — certification only)",
  category: "identity",
  authKind: "api_key", // a STATIC bearer shape in fixtures only — no OAuth flow, no token refresh, no real credential
  kind: "identity_provider_discovery",
  capabilities: [],
  discoveryCapabilities: ["discover_assigned_users"], // SCIM /Users; /Groups is a later, separate phase
  status: "disabled",
  reviewGate: "connector-framework-fixture-certification",
  riskLevel: "low",
  requiredScopes: ["urn:ietf:params:scim:schemas:core:2.0:User.read"], // display-only SCIM read scope
  helpCopy:
    "Synthetic SCIM 2.0 fixture provider for Connector Framework certification only — NOT a real vendor and never " +
    "connected. Its host is the reserved non-routable .invalid domain; no credentials are stored, and discovery/sync " +
    "are not built. It exists purely so the framework can certify a fixture-only SCIM proof.",
  enabled: false,
};

// The registry, keyed by provider id. Slack (deep-sync skeleton) + the inert future identity-discovery connectors + the
// synthetic SCIM fixture. Each is added as a definition (the type space already lists them) and stays inert until its
// own reviewed PR.
const CONNECTOR_PROVIDERS: Readonly<Partial<Record<ConnectorProviderId, ConnectorProviderDefinition>>> = {
  slack: SLACK,
  okta: OKTA,
  google_workspace: GOOGLE_WORKSPACE,
  microsoft_entra: MICROSOFT_ENTRA,
  scim_fixture: SCIM_FIXTURE,
};

// Connector KINDS that are discovery sources (find apps fast) vs the single deep-sync runner kind.
const DISCOVERY_KINDS: ReadonlySet<ConnectorKind> = new Set<ConnectorKind>([
  "identity_provider_discovery", "spend_invoice_discovery", "import_source",
  "browser_extension_discovery", "manual_source",
]);

// List every defined provider's safe metadata (stable order by id).
export function listConnectorProviders(): readonly ConnectorProviderDefinition[] {
  return Object.values(CONNECTOR_PROVIDERS)
    .filter((d): d is ConnectorProviderDefinition => Boolean(d))
    .sort((a, b) => a.id.localeCompare(b.id));
}

// Look up one provider's safe metadata; returns null for an unknown/undefined id (fail closed). Uses an OWN-property
// check so an inherited object key (`constructor`, `toString`, `__proto__`, `hasOwnProperty`, …) can NEVER resolve to an
// Object.prototype internal and masquerade as a provider — the lookup does no prototype-chain traversal.
export function getConnectorProvider(providerId: string): ConnectorProviderDefinition | null {
  if (!providerId || typeof providerId !== "string") return null;
  if (!Object.prototype.hasOwnProperty.call(CONNECTOR_PROVIDERS, providerId)) return null;
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

// True when the provider is a DISCOVERY connector (identity/spend/import/extension/manual). Fail closed.
export function isDiscoveryProvider(providerId: string): boolean {
  const def = getConnectorProvider(providerId);
  return def != null && DISCOVERY_KINDS.has(def.kind);
}

// True when the provider is a DEEP-SYNC runner (provider-specific enrichment). Fail closed.
export function isDeepSyncProvider(providerId: string): boolean {
  return getConnectorProvider(providerId)?.kind === "deep_provider_sync";
}

// List the defined DISCOVERY connectors (safe metadata; stable order by id).
export function listDiscoveryProviders(): readonly ConnectorProviderDefinition[] {
  return listConnectorProviders().filter((d) => DISCOVERY_KINDS.has(d.kind));
}

// List the defined DEEP-SYNC runners (safe metadata; stable order by id).
export function listDeepSyncProviders(): readonly ConnectorProviderDefinition[] {
  return listConnectorProviders().filter((d) => d.kind === "deep_provider_sync");
}

// A provider's declared discovery capabilities (display metadata); [] for an unknown provider (fail closed).
export function getProviderDiscoveryCapabilities(providerId: string): readonly DiscoveryCapability[] {
  return getConnectorProvider(providerId)?.discoveryCapabilities ?? [];
}
