// P5E18a — the DORMANT Okta connect-initiation GATE (Phase 5). PURE, server-only, NO network/DB/secret. It is the multi-gate guard
// a real "start Okta connection" server action would run BEFORE minting any OAuth transaction or redirecting to Okta. Every gate is
// INDEPENDENT and evaluated in order; the FIRST failure returns a customer-safe result. It must NOT become reachable merely because
// the customer UI says "Preview" — the UI label is not consulted here; the provider LIFECYCLE + governance are.
//
// CURRENT STATE FAILS CLOSED: Okta lifecycle is `certificationOnly` and governance (Phase C blocked / RISK-007 open / hosted OAuth
// disabled) denies — so even a fully-authorized admin with a valid org + exact scope is blocked. No redirect to Okta is ever built.
//
// SERVER-ONLY: under src/lib/server/, the runtime browser sentinel below, and no-client-import.test.ts.

import { OKTA_PROVIDER_ID, OKTA_APPROVED_SCOPES, scopesExactlyApproved, oktaLifecyclePermitsPilotConnection, OKTA_LIFECYCLE, type OktaProviderLifecycle } from "./okta-provider-contract";
import { validateOktaOrganization } from "./okta-org-validator";
import { isSafeReturnRoute } from "./okta-oauth-transaction";
import { governancePermitsHostedOkta, OKTA_GOVERNANCE, type OktaGovernanceState } from "./okta-governance-gate";

// Runtime server-only sentinel — throw if evaluated in a browser.
if (typeof (globalThis as { window?: unknown }).window !== "undefined") {
  throw new Error("connector-vault/okta-live/okta-connect-gate is server-only and must not be imported in client code");
}

const FIXED_CALLBACK_PATH = "/connectors/oauth/callback";
const DEFAULT_ADMIN_ROLES = ["owner", "admin"] as const;

// Internal block reasons — for logs/tests only, NEVER shown to a customer. Ordered to match the gate sequence.
export type OktaConnectBlockedReason =
  | "not_authenticated"
  | "no_membership"
  | "insufficient_role"
  | "provider_not_okta"
  | "lifecycle_not_pilot_ready"
  | "org_feature_flag_disabled"
  | "environment_disallows_hosted_oauth"
  | "governance_blocked"
  | "invalid_organization"
  | "scope_not_exact"
  | "invalid_callback_route"
  | "unsafe_return_route";

export type OktaConnectGateInput = {
  authenticated: boolean;
  hasOrgMembership: boolean;
  role: string | null;
  provider: string;
  organizationId: string;
  rawOrganization: unknown; // customer-entered Okta org value
  requestedScopes: readonly string[];
  callbackPath: string;
  returnRoute: string;
};

export type OktaConnectGateDeps = {
  lifecycle?: OktaProviderLifecycle; // default: the pinned certificationOnly
  governance?: OktaGovernanceState; // default: the pinned dormant (blocked) state
  orgFeatureFlagEnabled?: boolean; // org-level Okta flag (default false)
  environmentPermitsHostedOAuth?: boolean; // default false
  adminRoles?: readonly string[]; // default ["owner","admin"]
  allowedCustomDomains?: readonly string[];
};

// A customer-safe result: on failure it carries the INTERNAL reason (for logs) + a plain-language customerMessage that leaks NO
// internal governance term (no certificationOnly / Phase C / RISK-007 / ECS / credential-reference / promotion). On success it
// would carry the validated org + exact scopes — but in P5E18a success is unreachable (the gate fails closed).
export type OktaConnectGateResult =
  | { ok: true; provider: typeof OKTA_PROVIDER_ID; organizationId: string; hostname: string; issuerUrl: string; scopes: readonly string[]; callbackPath: string; returnRoute: string }
  | { ok: false; blockedReason: OktaConnectBlockedReason; customerMessage: string };

// Map an internal reason to a customer-safe message (no governance wording).
function customerMessage(reason: OktaConnectBlockedReason): string {
  switch (reason) {
    case "not_authenticated":
      return "Please sign in to connect an app.";
    case "no_membership":
    case "insufficient_role":
      return "You don’t have permission to connect this app.";
    case "invalid_organization":
      return "That doesn’t look like a valid Okta organization address.";
    case "scope_not_exact":
    case "invalid_callback_route":
    case "unsafe_return_route":
      return "We couldn’t start this connection. Please try again.";
    default:
      // lifecycle / feature-flag / environment / governance → the real connection simply isn’t available yet.
      return "Connecting Okta isn’t available yet.";
  }
}
const fail = (blockedReason: OktaConnectBlockedReason): OktaConnectGateResult => ({ ok: false, blockedReason, customerMessage: customerMessage(blockedReason) });

// Evaluate every gate in order; return the first failure. Fails closed by construction: with the default deps (certificationOnly +
// blocked governance + disabled flag/env) it can NEVER return ok:true.
export function evaluateOktaConnectGate(input: OktaConnectGateInput, deps: OktaConnectGateDeps = {}): OktaConnectGateResult {
  const lifecycle = deps.lifecycle ?? OKTA_LIFECYCLE;
  const governance = deps.governance ?? OKTA_GOVERNANCE;
  const adminRoles = deps.adminRoles ?? DEFAULT_ADMIN_ROLES;

  if (input.authenticated !== true) return fail("not_authenticated");
  if (input.hasOrgMembership !== true) return fail("no_membership");
  if (typeof input.role !== "string" || !adminRoles.includes(input.role)) return fail("insufficient_role");
  if (input.provider !== OKTA_PROVIDER_ID) return fail("provider_not_okta");
  if (!oktaLifecyclePermitsPilotConnection(lifecycle)) return fail("lifecycle_not_pilot_ready");
  if (deps.orgFeatureFlagEnabled !== true) return fail("org_feature_flag_disabled");
  if (deps.environmentPermitsHostedOAuth !== true) return fail("environment_disallows_hosted_oauth");
  if (!governancePermitsHostedOkta(governance)) return fail("governance_blocked");

  const org = validateOktaOrganization(input.rawOrganization, { allowedCustomDomains: deps.allowedCustomDomains });
  if (!org.ok) return fail("invalid_organization");
  if (scopesExactlyApproved(input.requestedScopes).ok !== true) return fail("scope_not_exact");
  if (input.callbackPath !== FIXED_CALLBACK_PATH) return fail("invalid_callback_route");
  if (!isSafeReturnRoute(input.returnRoute)) return fail("unsafe_return_route");

  // Unreachable in P5E18a — retained so the shape is complete and the "all gates pass" test can only be reached by explicitly
  // overriding lifecycle + governance + flags in a test (proving the gate is the sole thing standing between here and a redirect).
  return {
    ok: true,
    provider: OKTA_PROVIDER_ID,
    organizationId: input.organizationId,
    hostname: org.hostname,
    issuerUrl: org.issuerUrl,
    scopes: [...OKTA_APPROVED_SCOPES],
    callbackPath: FIXED_CALLBACK_PATH,
    returnRoute: input.returnRoute,
  };
}
