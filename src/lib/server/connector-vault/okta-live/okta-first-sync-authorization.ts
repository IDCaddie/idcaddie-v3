// P5E18a — the DORMANT Okta FIRST-SYNC AUTHORIZATION model (Phase 11). PURE, server-only. A supervised first sync requires an
// explicit, bounded, named-operator authorization — which is ABSENT by default. Scheduling is off, retries are off, the max user
// count defaults to 0 (non-runnable), and execution is denied. NO authorization is created in this phase.
//
// SERVER-ONLY: under src/lib/server/, the runtime browser sentinel below, and no-client-import.test.ts.

import { OKTA_PROVIDER_ID, OKTA_APPROVED_SCOPES, scopesExactlyApproved, oktaLifecyclePermitsExecution, OKTA_LIFECYCLE, type OktaProviderLifecycle } from "./okta-provider-contract";
import { governancePermitsHostedOkta, OKTA_GOVERNANCE, type OktaGovernanceState } from "./okta-governance-gate";

// Runtime server-only sentinel — throw if evaluated in a browser.
if (typeof (globalThis as { window?: unknown }).window !== "undefined") {
  throw new Error("connector-vault/okta-live/okta-first-sync-authorization is server-only and must not be imported in client code");
}

// A first-sync authorization record. Every field is required for a valid authorization; missing/zero fields fail closed.
export type OktaFirstSyncAuthorization = {
  provider: typeof OKTA_PROVIDER_ID;
  operator: string; // NAMED operator who approved (not a role) — for audit
  organizationId: string; // authorized customer organization
  connectorId: string; // the EXACT connection
  approvedIssuerUrl: string; // approved Okta issuer
  approvedScopes: readonly string[]; // must equal the approved set exactly
  maxUserCount: number; // bounded; must be > 0 to be runnable (default 0 elsewhere)
  approvedAt: number; // epoch ms
  expiresAt: number; // epoch ms
  maxRuns: number; // one-time or small bounded count; must be >= 1
  runsUsed: number;
  rollbackOwner: string; // named rollback owner
  evidenceRef: string; // correlation/evidence reference (non-secret)
  environment: "staging"; // staging only — production is never authorized here
  manualTriggerRequired: true; // scheduling/automation may never trigger it
};

export type OktaFirstSyncDenyReason =
  | "no_authorization"
  | "wrong_provider"
  | "connection_mismatch"
  | "organization_mismatch"
  | "issuer_mismatch"
  | "scope_not_exact"
  | "expired"
  | "run_budget_exhausted"
  | "max_user_count_not_positive"
  | "not_staging"
  | "manual_trigger_not_asserted"
  | "not_manual_trigger"
  | "lifecycle_not_enabled"
  | "governance_blocked"
  | "missing_field";

export type OktaFirstSyncDecision = { allowed: true } | { allowed: false; reason: OktaFirstSyncDenyReason };

// The default: NO authorization exists. Every real run must present a valid authorization AND pass the lifecycle/governance gates.
export const NO_OKTA_FIRST_SYNC_AUTHORIZATION: OktaFirstSyncAuthorization | null = null;

export type OktaFirstSyncContext = {
  connectorId: string;
  organizationId: string;
  issuerUrl: string;
  manuallyTriggered: boolean; // an explicit human trigger — never a scheduler
  now: number;
  lifecycle?: OktaProviderLifecycle;
  governance?: OktaGovernanceState;
};

const nonEmpty = (v: unknown): v is string => typeof v === "string" && v.length > 0;

// Decide whether a supervised first sync may run. Fails closed on: absent authorization, any mismatch, expiry, exhausted budget,
// non-positive user cap, non-staging, non-manual trigger, or blocked lifecycle/governance. Returns a typed reason; never throws.
export function evaluateOktaFirstSync(auth: OktaFirstSyncAuthorization | null, ctx: OktaFirstSyncContext): OktaFirstSyncDecision {
  const lifecycle = ctx.lifecycle ?? OKTA_LIFECYCLE;
  const governance = ctx.governance ?? OKTA_GOVERNANCE;

  if (auth == null) return { allowed: false, reason: "no_authorization" };
  if (auth.provider !== OKTA_PROVIDER_ID) return { allowed: false, reason: "wrong_provider" };
  if (!nonEmpty(auth.operator) || !nonEmpty(auth.rollbackOwner) || !nonEmpty(auth.evidenceRef) || !nonEmpty(auth.approvedIssuerUrl)) {
    return { allowed: false, reason: "missing_field" };
  }
  if (auth.connectorId !== ctx.connectorId) return { allowed: false, reason: "connection_mismatch" };
  if (auth.organizationId !== ctx.organizationId) return { allowed: false, reason: "organization_mismatch" };
  if (auth.approvedIssuerUrl !== ctx.issuerUrl) return { allowed: false, reason: "issuer_mismatch" };
  if (scopesExactlyApproved(auth.approvedScopes).ok !== true) return { allowed: false, reason: "scope_not_exact" };
  if (auth.environment !== "staging") return { allowed: false, reason: "not_staging" };
  if (auth.manualTriggerRequired !== true) return { allowed: false, reason: "manual_trigger_not_asserted" };
  if (ctx.manuallyTriggered !== true) return { allowed: false, reason: "not_manual_trigger" };
  if (!(auth.expiresAt > ctx.now)) return { allowed: false, reason: "expired" };
  if (!(auth.maxRuns >= 1) || auth.runsUsed >= auth.maxRuns) return { allowed: false, reason: "run_budget_exhausted" };
  if (!(auth.maxUserCount > 0)) return { allowed: false, reason: "max_user_count_not_positive" };
  // Even a perfectly-valid authorization cannot run unless the provider is fully enabled AND governance permits.
  if (!oktaLifecyclePermitsExecution(lifecycle)) return { allowed: false, reason: "lifecycle_not_enabled" };
  if (!governancePermitsHostedOkta(governance)) return { allowed: false, reason: "governance_blocked" };
  return { allowed: true };
}

// The dormant defaults an operator UI/store would start from — proving the safe baseline: no auth, no schedule, no retries, zero
// cap, denied. (Not a valid authorization — maxRuns 0 / maxUserCount 0 / no operator.)
export const OKTA_FIRST_SYNC_DEFAULTS = Object.freeze({
  authorizationPresent: false,
  schedulingEnabled: false,
  automaticRetriesEnabled: false,
  maxUserCount: 0,
  approvedScopes: OKTA_APPROVED_SCOPES,
  executionDenied: true,
});
