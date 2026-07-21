// P5E — the Okta API Services CONFIGURATION-ONLY gate. PURE, server-only, NO network/secret/token. Okta is a SERVICE application
// (Client Credentials + private_key_jwt) — there is NO browser OAuth, NO /authorize, NO PKCE, NO callback. This gate authorizes
// ONLY the persistence of NON-SECRET configuration (issuer binding, credential REFERENCE pointer, connection state up to
// verification_pending) for the ONE approved staging organization + approved issuer + exact scope. It NEVER authorizes execution:
// no token mint, no private_key_jwt signing, no Okta API call, no sync, no scheduling, no first-sync authorization. Those stay
// blocked by the execution gates (oktaExecutionEligibility / evaluateOktaFirstSync) + certificationOnly + governance (all false).
//
// SERVER-ONLY: under src/lib/server/, the runtime browser sentinel below, and no-client-import.test.ts.

import { OKTA_PROVIDER_ID, OKTA_APPROVED_SCOPES, scopesExactlyApproved } from "./okta-provider-contract";
import { validateOktaOrganization } from "./okta-org-validator";

if (typeof (globalThis as { window?: unknown }).window !== "undefined") {
  throw new Error("connector-vault/okta-live/okta-config-gate is server-only and must not be imported in client code");
}

// Ordered, fail-closed reasons (most fundamental first).
export type OktaConfigBlockedReason =
  | "not_authenticated"
  | "not_admin"
  | "provider_not_okta"
  | "environment_not_staging"
  | "organization_not_approved"
  | "organization_invalid"
  | "issuer_not_approved"
  | "scope_not_exact";

export type OktaConfigGateInput = {
  authenticated: boolean;
  role: string | null;
  provider: string;
  organizationId: string;
  rawOrganization: unknown;   // the org host/issuer to validate (server-derived, never request-chosen)
  requestedScopes: readonly string[];
  environment: string;
};

export type OktaConfigGateDeps = {
  // org → its EXACTLY-approved issuer (e.g. { "<A1 org id>": "https://trial-5294016.okta.com" }). A per-org map (not two
  // independent lists) so an approved org can never be paired with a different approved org's issuer.
  approvedIssuerByOrganizationId: Readonly<Record<string, string>>;
  adminRoles?: readonly string[];              // default owner/admin
  allowedCustomDomains?: readonly string[];
};

export type OktaConfigGateResult =
  | { ok: true; organizationId: string; hostname: string; issuerUrl: string; scopes: readonly string[] }
  | { ok: false; blockedReason: OktaConfigBlockedReason; customerMessage: string };

const DEFAULT_ADMIN_ROLES = ["owner", "admin"] as const;

// Customer-safe message (NO internal governance wording — no certificationOnly / Phase C / RISK-007 / ARN / credential terms).
function customerMessageFor(reason: OktaConfigBlockedReason): string {
  switch (reason) {
    case "not_authenticated": return "Please sign in to configure this connection.";
    case "not_admin": return "You need to be an organization administrator to configure this connection.";
    case "scope_not_exact": return "Only read-only user access can be configured for this connection.";
    default: return "This connection isn’t available to configure yet.";
  }
}

function fail(reason: OktaConfigBlockedReason): OktaConfigGateResult {
  return { ok: false, blockedReason: reason, customerMessage: customerMessageFor(reason) };
}

// Evaluate the config-persistence gate. Fails closed. On success it returns the validated NON-SECRET config to persist; it does
// NOT decide execution (see oktaConfigGatePermitsExecution, which is always false).
export function evaluateOktaConfigGate(input: OktaConfigGateInput, deps: OktaConfigGateDeps): OktaConfigGateResult {
  const adminRoles = deps.adminRoles ?? DEFAULT_ADMIN_ROLES;
  if (!input.authenticated) return fail("not_authenticated");
  if (input.role == null || !adminRoles.includes(input.role)) return fail("not_admin");
  if (input.provider !== OKTA_PROVIDER_ID) return fail("provider_not_okta");
  if (input.environment !== "staging") return fail("environment_not_staging");
  if (typeof input.organizationId !== "string" || input.organizationId.length === 0) return fail("organization_not_approved");
  const approvedIssuer = Object.prototype.hasOwnProperty.call(deps.approvedIssuerByOrganizationId, input.organizationId)
    ? deps.approvedIssuerByOrganizationId[input.organizationId]
    : undefined;
  if (approvedIssuer == null) return fail("organization_not_approved");

  const org = validateOktaOrganization(input.rawOrganization, { allowedCustomDomains: deps.allowedCustomDomains });
  if (!org.ok) return fail("organization_invalid");
  // The resolved issuer must be the one approved FOR THIS organization (not merely some approved issuer).
  if (org.issuerUrl !== approvedIssuer) return fail("issuer_not_approved");

  if (scopesExactlyApproved(input.requestedScopes).ok !== true) return fail("scope_not_exact");

  return { ok: true, organizationId: input.organizationId, hostname: org.hostname, issuerUrl: org.issuerUrl, scopes: [...OKTA_APPROVED_SCOPES] };
}

// The config gate NEVER authorizes execution. Token minting, private_key_jwt signing, Okta API calls, sync, scheduling, and
// first-sync remain governed by the execution gates + certificationOnly + governance — this always returns false.
export function oktaConfigGatePermitsExecution(): false {
  return false;
}
