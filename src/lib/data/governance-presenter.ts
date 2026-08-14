// Phase 15 Part 1 PR B — the typed presenter that resolves Phase-14 governance findings into truthful customer-facing copy. The engine
// stamps message KEYS (governance.{ruleId}.title|.summary|.remediation) + severity + confidence; this module is the SINGLE resolver for
// those keys. The RULE_PROSE record is EXHAUSTIVE over GovernanceRuleId (a new rule is a compile error), so no finding can render without
// reviewed copy. Prose stays strictly inside the docs/71 truthfulness boundary: it describes ACCESS TOPOLOGY only — it NEVER claims usage,
// license, cost, savings, inactivity, last-login, orphaned subscriptions, shadow IT, compliance, over-provisioning, or safe removal, and
// never uses the severity word "critical". Pure module; a window sentinel keeps it server-lean (it is import-safe in client code too, but
// the loaders resolve findings server-side and pass finished view models to the client).
//
// Phase 18D adds the SIBLING engine's copy below the Phase-14 table. Same module on purpose: one resolver for governance
// copy, one place a reviewer checks that nothing claims usage, licence, spend, or safe removal. The two tables stay
// separate records because the two engines' rule vocabularies are separate — this is a shared presenter, not a merge.

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

// ══ CROSS-SOURCE COPY (Phase 18D) ══════════════════════════════════════════════════════════════════════════════════════
// The sibling engine (`src/lib/server/cross-source-governance/`) stamps `crossSource.{ruleId}[.{reason}].title|.summary|
// .remediation` and persists them through 0083. Those keys resolved to NO COPY ANYWHERE until now — docs/79 recorded it
// as debt — so this table exists to close it for rule 5, whose remediation genuinely differs by state.
//
// KEYED BY THE PERSISTED STEM, not by a rule enum, because a consumer reads `title_key` back out of
// `product_governance_findings` as a plain string and has no typed subtype to switch on.
//
// WHAT EACH VARIANT MAY NOT SAY. The rule proves ONE thing: no accepted operational application relationship exists for
// this directory application after a completed matcher run. So the unresolved variant must not claim a contract is
// absent — the rule never looked at contracts — and the operational variants must not call the software unidentified,
// because a confirmed alias has already identified it. Neither may claim usage, licence, spend or safe removal.
export const CROSS_SOURCE_PROSE: Record<string, RuleProse> = {
  // The BROAD entry. It is the truthful thing to say when the subtype is unknown — including for rows persisted before
  // 18D, whose keys carry no variant at all.
  "crossSource.discovered_application_unmanaged_by_idp": {
    title: "Application is not linked to an operational record",
    summary: "No accepted operational application relationship exists for this directory application.",
    guidance: "Review this application and link it to the appropriate operational application record.",
  },
  "crossSource.discovered_application_unmanaged_by_idp.product_unresolved": {
    title: "Application needs identification",
    summary: "This directory application has not been matched to a recognized software product.",
    guidance: "Confirm which software product this application is before linking it to an operational record.",
  },
  "crossSource.discovered_application_unmanaged_by_idp.operational_instance_absent": {
    title: "Application is not linked to an operational record",
    summary: "The software product is recognized, and no operational application record is available to link to it.",
    guidance: "Create the operational application record for this product, then link this application to it.",
  },
  // Deliberately does not say "proposed": candidates a reviewer has already rejected are still candidates, and the
  // rule cannot see which. "Available" is true in both cases.
  "crossSource.discovered_application_unmanaged_by_idp.operational_match_unaccepted": {
    title: "Application match needs review",
    summary: "The software product is recognized and operational application candidates are available, but none has been accepted.",
    guidance: "Review the available operational application candidates and accept the correct record.",
  },
};

/**
 * Resolve one persisted cross-source `title_key` to reviewed copy.
 *
 * An UNKNOWN VARIANT falls back to its rule's broad copy rather than failing or rendering a key: a subtype this build
 * has never heard of still describes a finding whose broad claim is true, and the broad sentence is the one that stays
 * true for all of them. An unknown RULE returns null — there is nothing truthful to say about a rule we do not have.
 * Nothing from the finding's evidence is ever interpolated, so no id, name or payload can reach the page this way.
 */
export function crossSourceProse(titleKey: string): RuleProse | null {
  const stem = titleKey.replace(/\.title$/, "");
  const exact = CROSS_SOURCE_PROSE[stem];
  if (exact) return exact;
  return CROSS_SOURCE_PROSE[stem.split(".").slice(0, 2).join(".")] ?? null;
}

const SEVERITY_TONE: Record<GovernanceSeverity, StatusTone> = { high: "danger", medium: "attention", low: "neutral", info: "neutral" };
const SEVERITY_LABEL: Record<GovernanceSeverity, string> = { high: "High", medium: "Medium", low: "Low", info: "Info" };
const CONFIDENCE_LABEL: Record<GovernanceConfidence, string> = { high: "High confidence", medium: "Medium confidence", low: "Low confidence" };

export const severityTone = (s: GovernanceSeverity): StatusTone => SEVERITY_TONE[s];
export const severityLabel = (s: GovernanceSeverity): string => SEVERITY_LABEL[s];
export const confidenceLabel = (c: GovernanceConfidence): string => CONFIDENCE_LABEL[c];
export const ruleProse = (ruleId: GovernanceRuleId): RuleProse => RULE_PROSE[ruleId];
