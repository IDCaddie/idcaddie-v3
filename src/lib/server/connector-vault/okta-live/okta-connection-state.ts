// P5E18a — the Okta CONNECTION STATE model + EXECUTION ELIGIBILITY (Phase 10). PURE, server-only. The customer-facing/display state
// is SEPARATE from execution eligibility: a connection can display "connected" (unsynced) yet still be non-runnable. Runnability is
// decided ONLY by the full independent gate set below — never by a display label. In P5E18a no reachable state satisfies all gates.
//
// SERVER-ONLY: under src/lib/server/, the runtime browser sentinel below, and no-client-import.test.ts.

import { OKTA_PROVIDER_ID, oktaLifecyclePermitsExecution, OKTA_LIFECYCLE, type OktaProviderLifecycle } from "./okta-provider-contract";
import { governancePermitsHostedOkta, OKTA_GOVERNANCE, type OktaGovernanceState } from "./okta-governance-gate";

// Runtime server-only sentinel — throw if evaluated in a browser.
if (typeof (globalThis as { window?: unknown }).window !== "undefined") {
  throw new Error("connector-vault/okta-live/okta-connection-state is server-only and must not be imported in client code");
}

// DISPLAY state — what the customer sees. NOT an execution authority.
export type OktaConnectionDisplayState =
  | "preview"
  | "authorizationPending"
  | "callbackPending"
  | "connectedUnsynced"
  | "readyForSupervisedSync"
  | "paused"
  | "needsReauthorization"
  | "disconnected"
  | "failed";

export const OKTA_CONNECTION_DISPLAY_STATES: readonly OktaConnectionDisplayState[] = Object.freeze([
  "preview", "authorizationPending", "callbackPending", "connectedUnsynced", "readyForSupervisedSync", "paused",
  "needsReauthorization", "disconnected", "failed",
]);

// The full, independent EXECUTION gate set. Every one must hold for a run — display state is not among them.
export type OktaExecutionGates = {
  provider: string;
  lifecycle: OktaProviderLifecycle;
  governance: OktaGovernanceState;
  orgFeatureFlagEnabled: boolean;
  credentialReferenceExists: boolean;
  credentialVersionApproved: boolean;
  scopeExact: boolean;
  issuerBindingMatches: boolean;
  executionAuthorizationExists: boolean;
  firstSyncApprovalExists: boolean;
};

export type OktaEligibilityGateName =
  | "provider" | "lifecycle_enabled" | "governance" | "org_feature_flag" | "credential_reference" | "credential_version_approved"
  | "scope_exact" | "issuer_binding" | "execution_authorization" | "first_sync_approval";

// Decide runnability. Returns runnable + the list of FAILING gates (for logs/tests). Runnable requires ALL gates; the lifecycle
// gate requires the FULLY-enabled lifecycle (pilotReady is NOT enough to run).
export function oktaExecutionEligibility(gates: OktaExecutionGates): { runnable: boolean; failing: OktaEligibilityGateName[] } {
  const failing: OktaEligibilityGateName[] = [];
  if (gates.provider !== OKTA_PROVIDER_ID) failing.push("provider");
  if (!oktaLifecyclePermitsExecution(gates.lifecycle)) failing.push("lifecycle_enabled");
  if (!governancePermitsHostedOkta(gates.governance)) failing.push("governance");
  if (gates.orgFeatureFlagEnabled !== true) failing.push("org_feature_flag");
  if (gates.credentialReferenceExists !== true) failing.push("credential_reference");
  if (gates.credentialVersionApproved !== true) failing.push("credential_version_approved");
  if (gates.scopeExact !== true) failing.push("scope_exact");
  if (gates.issuerBindingMatches !== true) failing.push("issuer_binding");
  if (gates.executionAuthorizationExists !== true) failing.push("execution_authorization");
  if (gates.firstSyncApprovalExists !== true) failing.push("first_sync_approval");
  return { runnable: failing.length === 0, failing };
}

// The gate set as it actually stands in P5E18a for ANY Okta connection: certificationOnly lifecycle + blocked governance + no
// approved credential/authorization. Runnability is false. Used by tests to prove no reachable connection is runnable.
export function dormantOktaExecutionGates(overrides: Partial<OktaExecutionGates> = {}): OktaExecutionGates {
  return {
    provider: OKTA_PROVIDER_ID,
    lifecycle: OKTA_LIFECYCLE, // certificationOnly
    governance: OKTA_GOVERNANCE, // blocked
    orgFeatureFlagEnabled: false,
    credentialReferenceExists: false,
    credentialVersionApproved: false,
    scopeExact: false,
    issuerBindingMatches: false,
    executionAuthorizationExists: false,
    firstSyncApprovalExists: false,
    ...overrides,
  };
}
