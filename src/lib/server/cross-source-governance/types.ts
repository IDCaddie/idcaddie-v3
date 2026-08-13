// Phase 16 — the typed contract for the TENANT-WIDE cross-source governance engine.
//
// SIBLING, NOT AN EXTENSION. Phase 14 (`../governance-analytics/`) is PROVIDER-LOCAL: its scope is
// (tenant, connection, provider) and it answers questions inside one connector's directory graph. This engine's scope
// is the TENANT, because every question it asks — "does this SaaS account belong to anyone?", "is this person gone from
// the IdP but still in Slack?" — spans connectors by definition. Phase 14's scope contract is NOT widened; the two
// engines share vocabulary and the 0083 persistence layer, and nothing else.
//
// PROVIDER-NEUTRAL BY CONSTRUCTION. Every input below is a canonical persisted row. There is no provider enum, no
// per-provider branch, and no import from any connector module. `provider` is carried as an opaque string for
// provenance and grouping only — the engine never compares it to a literal. Google plugs in by landing rows in
// `app_accounts` and a capability row; this file does not change.
//
// COMPUTE-ONLY. No DB call, no network, no clock, no env, no randomness. The caller loads the rows and persists the
// output through `product_sync_governance_findings` (0083).

import type { GovernanceSeverity, GovernanceConfidence } from "../governance-analytics/types";

// Deliberately re-exported rather than redefined: severity and confidence mean exactly what they mean in Phase 14, and
// two vocabularies for one concept is how a "medium" comes to mean two things.
export type { GovernanceSeverity, GovernanceConfidence } from "../governance-analytics/types";
export type { SyncStatus } from "../access-graph/types";

import type { SyncStatus } from "../access-graph/types";

// Bumped when a rule's DEFINITION changes, so an administrator comparing two months knows which of the two moved.
export const CROSS_SOURCE_RULE_VERSION = "1";

// ── Capability completeness ───────────────────────────────────────────────────────────────────────────────────────
// The canonical vocabulary the engine reasons about. The loader maps `connector_capability_state` rows (0076) onto
// these; the engine never asks a provider anything.
export const CAPABILITY = {
  /** The IdP/directory identity set — `identity_accounts` for one connection. */
  identity: "identity",
  /** The SaaS account set — `app_accounts` for one connection. */
  appAccounts: "app_accounts",
  /** The directory application set — `directory_applications` for one connection. */
  applications: "directory_applications",
} as const;
export type CapabilityName = (typeof CAPABILITY)[keyof typeof CAPABILITY];

// A capability is usable as PROOF only when `available`. Every other state — incomplete, failed, plan_dependent,
// permission_dependent, unavailable — means we could not see, which is never the same as seeing nothing (docs/79).
export type CapabilityState =
  | "available" | "incomplete" | "failed" | "plan_dependent" | "permission_dependent" | "unavailable";

export type SourceCapability = {
  readonly connectionId: string;
  readonly provider: string;
  readonly capability: CapabilityName;
  readonly state: CapabilityState;
};

// ── Canonical rows ────────────────────────────────────────────────────────────────────────────────────────────────
type CanonicalRow = {
  readonly id: string;
  readonly connectionId: string;
  readonly provider: string;
  readonly syncStatus: SyncStatus;
};

/** `identity_accounts` (0053). `isActive` is NULLABLE: null means the provider did not say, never "inactive". */
export type IdentityAccountRow = CanonicalRow & { readonly isActive: boolean | null };

/** `app_accounts` (0076). Both bucketed enums; `isAdmin` nullable for the same reason as `isActive`. */
export type AppAccountRow = CanonicalRow & {
  readonly accountKind: "human" | "bot" | "service" | "unknown";
  readonly accountStatus: "active" | "inactive" | "deleted" | "unknown";
  readonly isAdmin: boolean | null;
};

/** `directory_applications` (0057). */
export type DirectoryApplicationRow = CanonicalRow;

/** `person_account_links` (0082) — exactly one endpoint, as the CHECK guarantees. */
export type PersonAccountLinkRow = {
  readonly personId: string;
  readonly identityAccountId: string | null;
  readonly appAccountId: string | null;
  readonly status: "proposed" | "accepted" | "rejected";
};

/** `application_matches` (0075). Empty today — no matcher exists — which rule 5 treats as "unknown", never "unmanaged". */
export type ApplicationMatchRow = {
  readonly directoryApplicationId: string;
  readonly status: "proposed" | "accepted" | "rejected";
};

export type CrossSourceGraph = {
  readonly tenantId: string;
  readonly capabilities: readonly SourceCapability[];
  readonly identityAccounts: readonly IdentityAccountRow[];
  readonly appAccounts: readonly AppAccountRow[];
  readonly personAccountLinks: readonly PersonAccountLinkRow[];
  readonly directoryApplications: readonly DirectoryApplicationRow[];
  readonly applicationMatches: readonly ApplicationMatchRow[];
};

// ── Output ────────────────────────────────────────────────────────────────────────────────────────────────────────
export type CrossSourceRuleId =
  | "active_saas_account_without_accepted_identity"
  | "inactive_identity_with_active_saas_account"
  | "privileged_saas_account_without_accepted_identity"
  | "duplicate_active_accounts_for_one_person"
  | "discovered_application_unmanaged_by_idp";

export type CrossSourceSubjectType = "app_account" | "person" | "directory_application";

/** Exactly the payload `product_sync_governance_findings` (0083) consumes — no adapter layer between them. */
export type CrossSourceFinding = {
  readonly finding_key: string;
  readonly rule_id: CrossSourceRuleId;
  readonly subject_type: CrossSourceSubjectType;
  readonly subject_id: string;
  readonly severity: GovernanceSeverity;
  readonly confidence: GovernanceConfidence;
  readonly title_key: string;
  readonly summary_key: string;
  readonly remediation_key: string | null;
  readonly evidence: { readonly counts: Readonly<Record<string, number>>; readonly supportingIds?: readonly string[] };
  readonly source_providers: readonly string[];
  /** NON-EMPTY, always: 0083 refuses a sourceless finding because it could never be proven absent. */
  readonly evidence_connection_ids: readonly string[];
};

/**
 * Which rules were EVALUATED, and which were withheld because the evidence needed to reach a conclusion was not
 * complete. A withheld rule is not a zero — the caller must be able to tell "we looked and found none" from "we could
 * not look", and rendering those the same is the failure docs/79 exists to prevent.
 */
export type CrossSourceEvaluation = {
  readonly findings: readonly CrossSourceFinding[];
  readonly ruleVersion: string;
  readonly evaluatedRules: readonly CrossSourceRuleId[];
  readonly withheldRules: readonly { readonly ruleId: CrossSourceRuleId; readonly reason: string }[];
  /** The connections whose capabilities were `available` this evaluation — passed to 0083 as the closure gate. */
  readonly completeConnectionIds: readonly string[];
};
