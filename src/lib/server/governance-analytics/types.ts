// Phase 14 — the typed contract for the governance-analytics ENGINE. Provider-neutral, COMPUTE-ONLY. It consumes the canonical
// directory_* graph (node sets + edges) + Phase-13 effective-access results + an explicit policy, and produces IMMUTABLE, deterministic
// governance FINDINGS + an aggregate summary. It writes NOTHING (no migration, table, fact, RPC, route, component, dashboard, hosted
// task, network, DB read, Date.now, env, flag, log). Findings prove ACCESS TOPOLOGY ONLY — never license use, cost, savings, actual usage,
// inactivity, last-login, orphaned subscriptions, shadow IT, compliance, or safe-removal (that evidence is not in this graph). Finding
// identity + evidence carry ONLY canonical directory ROW ids + integer counts + the bounded sync_status enum + staleSince + message keys +
// a caller-injected detectedAt — NEVER external_ids, labels, emails, logins, names, URLs, tokens, secrets, or profile data. RISK-007 OPEN.

import type { Scope, SyncStatus, MembershipEdge, UserAssignmentEdge, GroupAssignmentEdge } from "../access-graph/types";

export type { Scope, SyncStatus } from "../access-graph/types";

// Conservative severity. DELIBERATELY excludes 'critical' — topology alone never proves a critical finding. (Distinct from the
// connector-vault DiscoveryFact severity enum, which includes 'critical' for a different, fact-quality concern; do not import that.)
export type GovernanceSeverity = "info" | "low" | "medium" | "high";
export const SEVERITY_RANK: Readonly<Record<GovernanceSeverity, number>> = { info: 0, low: 1, medium: 2, high: 3 };

// Evidence quality — SEPARATE from severity, never folded in. high = pure canonical topology proves it; medium = a threshold/derived
// governance signal; low = a heuristic requiring review.
export type GovernanceConfidence = "high" | "medium" | "low";

export type GovernanceCategory = "redundancy" | "coverage" | "freshness" | "breadth" | "structural";

// The finite rule catalog (the GO's 10 rule families; rules 5 + 10 emit multiple rule ids).
export type GovernanceRuleId =
  | "redundant_direct_access"
  | "identity_without_effective_access"
  | "group_without_application_reach"
  | "application_without_effective_identities"
  | "direct_assignment_with_stale_endpoint"
  | "group_assignment_with_stale_endpoint"
  | "stale_only_effective_access"
  | "identity_broad_access"
  | "group_broad_application_reach"
  | "duplicate_inherited_access_paths"
  // structural / diagnostic (aggregate counts only; no foreign ids emitted)
  | "assignment_missing_identity"
  | "assignment_missing_group"
  | "assignment_missing_application"
  | "membership_missing_identity"
  | "membership_missing_group"
  | "cross_scope_edge_ignored"
  | "wrong_provider_edge_ignored";

export type GovernanceSubjectType = "identity" | "group" | "application" | "assignment" | "effective_access" | "graph";

// Bounded, PII-free evidence: named integer counts + canonical ROW ids (sorted) + bounded sync_status endpoint states + a threshold.
// NO free-text (never sourceEndpoint / lastDiscoveryRunId / labels / external_ids).
export type GovernanceEvidence = {
  readonly counts: Readonly<Record<string, number>>;
  readonly supportingIds?: readonly string[];                        // canonical directory ROW ids, sorted
  readonly endpointStates?: Readonly<Record<string, SyncStatus>>;    // e.g. { identity: "stale", application: "current" }
  readonly threshold?: number | null;
};

// The immutable governance finding. `id` is a deterministic injective digest (see finding-id.ts). subjectId + relatedIds are canonical
// directory ROW ids (a graph-diagnostic finding uses a per-scope token as subjectId and emits NO foreign ids). titleKey/summaryKey/
// remediationKey are stable message KEYS resolved by a future UI (Phase 15) — never embedded prose.
export type GovernanceFinding = {
  readonly id: string;
  readonly ruleId: GovernanceRuleId;
  readonly category: GovernanceCategory;
  readonly severity: GovernanceSeverity;
  readonly confidence: GovernanceConfidence;
  readonly scope: Scope;
  readonly subjectType: GovernanceSubjectType;
  readonly subjectId: string;
  readonly relatedIds: readonly string[];
  readonly titleKey: string;
  readonly summaryKey: string;
  readonly remediationKey: string | null;
  readonly evidence: GovernanceEvidence;
  readonly detectedAt: string | null;
};

// A canonical directory node carrying its scope + freshness (identity_accounts / directory_groups / directory_applications rows).
export type CanonicalNode = Scope & { readonly id: string; readonly syncStatus: SyncStatus; readonly staleSince?: string | null };

// The full governance input: the canonical node sets + the three edge kinds. May span multiple scopes; the engine resolves + reports
// STRICTLY within each subject's own (tenant, connection, provider) scope. The identities/memberships/userAssignments/groupAssignments
// subset is structurally compatible with the Phase-13 AccessGraph (passed to resolveAllEffectiveAccess).
export type GovernanceGraph = {
  readonly identities: readonly CanonicalNode[];
  readonly groups: readonly CanonicalNode[];
  readonly applications: readonly CanonicalNode[];
  readonly memberships: readonly MembershipEdge[];
  readonly userAssignments: readonly UserAssignmentEdge[];
  readonly groupAssignments: readonly GroupAssignmentEdge[];
};

// Explicit, injected policy. Thresholds default to null (rule DISABLED) — no hardcoded global product truth. includeStale selects the
// PRIMARY (actionable) access view: default false = current-only; true = include non-current edges in the primary rules. The stale-only
// rule always compares current-vs-all regardless. A provided threshold must be a finite non-negative integer (else the engine throws).
export type GovernancePolicy = {
  readonly includeStale?: boolean;
  readonly identityBroadAccessThreshold?: number | null;
  readonly groupBroadReachThreshold?: number | null;
  readonly duplicateInheritedPathThreshold?: number; // default 1 (>1 distinct group path to one app triggers)
};

// The caller-injected evaluation context (no implicit Date.now / env / clock). detectedAt is stamped verbatim onto every finding.
export type GovernanceContext = { readonly detectedAt?: string | null };

export type GovernanceSummary = {
  readonly identitiesEvaluated: number;
  readonly groupsEvaluated: number;
  readonly applicationsEvaluated: number;
  readonly effectiveAccessRelationships: number;
  readonly findingsTotal: number;
  readonly findingsByRule: Readonly<Record<string, number>>;
  readonly findingsBySeverity: Readonly<Record<GovernanceSeverity, number>>;
  readonly identitiesWithDirectAccess: number;
  readonly identitiesWithGroupAccess: number;
  readonly identitiesWithBoth: number;
  readonly identitiesWithoutAccess: number;
  readonly applicationsWithoutEffectiveIdentities: number;
  readonly redundantDirectAccessRelationships: number;
  readonly duplicateInheritedPaths: number;
  readonly staleOnlyRelationships: number;
};

export type GovernanceEvaluation = {
  readonly findings: readonly GovernanceFinding[];
  readonly summary: GovernanceSummary;
};
