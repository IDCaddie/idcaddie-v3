// Phase 15 Part 1 PR B — the typed presenter that resolves Phase-14 governance findings into truthful customer-facing copy. The engine
// stamps message KEYS (governance.{ruleId}.title|.summary|.remediation) + severity + confidence; this module is the SINGLE resolver for
// those keys. The RULE_PROSE record is EXHAUSTIVE over GovernanceRuleId (a new rule is a compile error), so no finding can render without
// reviewed copy. Prose stays strictly inside the docs/71 truthfulness boundary: it describes ACCESS TOPOLOGY only — it NEVER claims usage,
// license, cost, savings, inactivity, last-login, orphaned subscriptions, shadow IT, compliance, over-provisioning, or safe removal, and
// never uses the severity word "critical". Pure module; a window sentinel keeps it server-lean (it is import-safe in client code too, but
// the loaders resolve findings server-side and pass finished view models to the client).

import type { GovernanceRuleId, GovernanceSeverity, GovernanceConfidence } from "@/lib/server/governance-analytics/types";
import type { StatusTone } from "@/components/status-tokens";

export type RuleProse = { title: string; summary: string; guidance: string | null };

// Exhaustive: every GovernanceRuleId must have reviewed prose. Directional guidance only — never "remove", "delete", "safe to remove".
export const RULE_PROSE: Record<GovernanceRuleId, RuleProse> = {
  redundant_direct_access: {
    title: "Direct and group-based access overlap",
    summary: "This identity has a direct assignment and access represented through one or more groups.",
    guidance: "Review whether both access paths are intentional before making changes.",
  },
  identity_without_effective_access: {
    title: "No application access represented",
    summary: "No effective application access is represented for this identity in the selected directory scope.",
    guidance: "Confirm whether this identity is expected to receive access through another connection.",
  },
  group_without_application_reach: {
    title: "No application assignments represented",
    summary: "This group has no current application assignment represented in the selected directory scope.",
    guidance: null,
  },
  application_without_effective_identities: {
    title: "No effective identity access represented",
    summary: "No effective identity access is represented for this application in the selected directory scope.",
    guidance: null,
  },
  direct_assignment_with_stale_endpoint: {
    title: "Direct assignment depends on stale evidence",
    summary: "A current direct assignment references an identity or application the connector has not re-confirmed.",
    guidance: "Review the current provider state before making changes.",
  },
  group_assignment_with_stale_endpoint: {
    title: "Group assignment depends on stale evidence",
    summary: "A current group assignment references a group or application the connector has not re-confirmed.",
    guidance: "Review the current provider state before making changes.",
  },
  stale_only_effective_access: {
    title: "Access depends on stale evidence",
    summary: "This access relationship appears only when stale directory evidence is included.",
    guidance: "Review the current provider state before making changes.",
  },
  identity_broad_access: {
    title: "Broad application access for review",
    summary: "This identity has effective access to more applications than the configured review threshold.",
    guidance: "Review whether this breadth of access is expected.",
  },
  group_broad_application_reach: {
    title: "Broad group application reach for review",
    summary: "This group grants access to more applications than the configured review threshold.",
    guidance: "Review whether this breadth of reach is expected.",
  },
  duplicate_inherited_access_paths: {
    title: "Multiple group paths provide access",
    summary: "This identity has access to an application represented through more than one group.",
    guidance: "Review whether the overlapping group paths are intentional.",
  },
  // structural diagnostics — aggregate counts only; NEVER a foreign entity id in the copy.
  assignment_missing_identity: {
    title: "Assignment references a missing identity",
    summary: "One or more assignments reference an identity that is not present in the directory graph.",
    guidance: "This is an internal data-consistency signal for review.",
  },
  assignment_missing_group: {
    title: "Assignment references a missing group",
    summary: "One or more assignments reference a group that is not present in the directory graph.",
    guidance: "This is an internal data-consistency signal for review.",
  },
  assignment_missing_application: {
    title: "Assignment references a missing application",
    summary: "One or more assignments reference an application that is not present in the directory graph.",
    guidance: "This is an internal data-consistency signal for review.",
  },
  membership_missing_identity: {
    title: "Membership references a missing identity",
    summary: "One or more group memberships reference an identity that is not present in the directory graph.",
    guidance: "This is an internal data-consistency signal for review.",
  },
  membership_missing_group: {
    title: "Membership references a missing group",
    summary: "One or more group memberships reference a group that is not present in the directory graph.",
    guidance: "This is an internal data-consistency signal for review.",
  },
  cross_scope_edge_ignored: {
    title: "Cross-scope relationship excluded",
    summary: "One or more relationships spanning a different connection or tenant were excluded from evaluation.",
    guidance: "This is an internal data-consistency signal for review.",
  },
  wrong_provider_edge_ignored: {
    title: "Mismatched-provider relationship excluded",
    summary: "One or more relationships with a mismatched provider were excluded from evaluation.",
    guidance: "This is an internal data-consistency signal for review.",
  },
};

const SEVERITY_TONE: Record<GovernanceSeverity, StatusTone> = { high: "danger", medium: "attention", low: "neutral", info: "neutral" };
const SEVERITY_LABEL: Record<GovernanceSeverity, string> = { high: "High", medium: "Medium", low: "Low", info: "Info" };
const CONFIDENCE_LABEL: Record<GovernanceConfidence, string> = { high: "High confidence", medium: "Medium confidence", low: "Low confidence" };

export const severityTone = (s: GovernanceSeverity): StatusTone => SEVERITY_TONE[s];
export const severityLabel = (s: GovernanceSeverity): string => SEVERITY_LABEL[s];
export const confidenceLabel = (c: GovernanceConfidence): string => CONFIDENCE_LABEL[c];
export const ruleProse = (ruleId: GovernanceRuleId): RuleProse => RULE_PROSE[ruleId];
