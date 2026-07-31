// Phase 15 Part 1 PR B — browser-safe, immutable view models + pure mappers for the /access surface. React never sees a raw RPC row or a
// raw engine object: the loaders resolve Phase-13/14 outputs server-side and map them here into DTOs that carry ONLY safe display labels,
// integer counts, bounded enums, and canonical row-id UUIDs used solely as href params (never visible text). NEVER external_id /
// raw_payload / normalized_* / sourceEndpoint / lastDiscoveryRunId / credentials / settings / profiles / secret / foreign tenant id.
// A safe human label for an identity is display_name, else login, else email (docs/72 §"Safe display metadata" — login/email ARE permitted
// display fallbacks for an owner/admin so a user is identifiable when display_name is absent); a UUID/external_id is NEVER a human label.
// Truthful copy only (docs/71). Pure module; window sentinel.

import type { IdentityAccess, AppAccess } from "@/lib/server/access-graph/types";
import type { GovernanceFinding, GovernanceSummary, GovernanceSeverity, GovernanceConfidence, GovernanceSubjectType, GovernanceRuleId } from "@/lib/server/governance-analytics/types";
import type { StatusTone } from "@/components/status-tokens";
import { ruleProse, severityTone, severityLabel, confidenceLabel } from "./governance-presenter";

if (typeof (globalThis as { window?: unknown }).window !== "undefined") {
  throw new Error("access-view-models is server-only and must not be imported in client code");
}

export type EvaluationCompleteness =
  | { readonly status: "complete" }
  | { readonly status: "bounded"; readonly reasonKey: string }
  | { readonly status: "unavailable"; readonly reasonKey: string };

// A label map: canonical ROW id -> safe display label (already fallback-resolved). Loaders build these from the RPC display columns.
export type LabelMap = ReadonlyMap<string, string>;

export type SafeSubjectLink = { readonly kind: "identity" | "group" | "application"; readonly label: string; readonly href: string };
// Phase 4: the group's canonical id travels with its label so the path can become a LINK. Routing on the label would be wrong in
// two ways — two groups may share a name, and a name is not a route.
export type GroupPathView = { readonly groupId: string; readonly groupLabel: string; readonly staleEvidence: boolean };

export type GovernanceFindingView = {
  readonly id: string;
  readonly ruleId: GovernanceRuleId;          // bounded enum — safe for a rule filter (never a foreign id / PII)
  readonly subjectType: GovernanceSubjectType; // bounded enum — safe for a subject-type filter
  readonly severity: GovernanceSeverity;
  readonly severityLabel: string;
  readonly severityTone: StatusTone;
  readonly confidence: GovernanceConfidence;
  readonly confidenceLabel: string;
  readonly title: string;
  readonly summary: string;
  readonly guidance: string | null;
  readonly subject: SafeSubjectLink | null;
  readonly evidenceRows: readonly { readonly label: string; readonly value: string }[];
  readonly staleEvidence: boolean;
};

export type GovernanceSummaryView = {
  readonly total: number;
  readonly bySeverity: Readonly<Record<GovernanceSeverity, number>>;
};

export type ClassificationView = "DIRECT" | "GROUP" | "BOTH";
export type IdentityApplicationAccessView = {
  readonly applicationId: string;
  readonly applicationLabel: string;
  readonly classification: ClassificationView;
  readonly classificationLabel: string;
  readonly explanation: string;
  readonly groupPaths: readonly GroupPathView[];
  readonly staleEvidence: boolean;
};

// ── safe display fallbacks (display_name → login → email → "Unnamed…"; NEVER a UUID / external_id as a human label) ───────────────────
const clean = (s: string | null | undefined): string | null => { const t = (s ?? "").trim(); return t.length > 0 ? t : null; };
export const identityLabel = (r: { display_name?: string | null; login?: string | null; email?: string | null }): string =>
  clean(r.display_name) ?? clean(r.login) ?? clean(r.email) ?? "Unnamed identity";
export const groupLabel = (r: { name?: string | null }): string => clean(r.name) ?? "Unnamed group";
export const applicationLabel = (r: { label?: string | null; name?: string | null }): string => clean(r.label) ?? clean(r.name) ?? "Unnamed application";

const HUMAN_COUNT: Record<string, string> = {
  directAssignmentCount: "Direct assignments", inheritedPathCount: "Group paths", effectiveCount: "Effective applications",
  currentMembershipCount: "Current group memberships", staleMembershipCount: "Stale group memberships",
  memberCount: "Members", applicationAssignmentCount: "Application assignments",
  effectiveIdentityCount: "Effective identities", currentDirectAssignmentCount: "Current direct assignments", currentGroupAssignmentCount: "Current group assignments",
  distinctGroupPathCount: "Distinct group paths", effectiveApplicationCount: "Effective applications", groupDerivedCount: "Group-derived applications", directCount: "Direct applications",
  staleDirectPathCount: "Stale direct paths", staleGroupPathCount: "Stale group paths", currentPathCount: "Current paths",
  edgeCount: "Affected relationships",
};
const humanizeCount = (k: string): string => HUMAN_COUNT[k] ?? k;

// classification LABEL + EXPLANATION copy (truthful; counts only). The DIRECT/GROUP/BOTH decision itself is Phase-13's
// (AppAccess.classification) — this only renders it, never re-derives it (single source of truth = the engine).
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
export function classificationView(classification: ClassificationView, groupCount: number): { label: string; explanation: string } {
  if (classification === "BOTH") return { label: "Direct and through group", explanation: `Access is represented through a direct assignment and ${plural(groupCount, "group", "groups")}.` };
  if (classification === "DIRECT") return { label: "Direct", explanation: "Access is represented through a direct assignment." };
  return { label: "Through group", explanation: `Access is represented through ${plural(groupCount, "group", "groups")}.` };
}

// ── mappers ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
// A finding subject becomes a link ONLY when it resolves to a known identity/application safe label; otherwise no id/link is emitted
// (structural "graph" findings and unresolved subjects render subject:null — never a bare UUID or a foreign id).
// Phase 4 additions: GROUP subjects now link (they rendered as no link at all), and ASSIGNMENT subjects are disambiguated.
//
// `assignment` is the awkward one. Both assignment rules use subjectType "assignment", but `direct_assignment_with_stale_endpoint`
// carries an IDENTITY id and `group_assignment_with_stale_endpoint` carries a GROUP id. Guessing from the id itself is impossible —
// they are both uuids. The discriminator is the RULE, which is a bounded enum, so it is read explicitly rather than inferred. Any
// future assignment rule is unmapped and therefore unlinked, which is the safe direction to fail.
//
// `graph` findings never link: their subjectId is a sha256 scope token (finding-id.ts), not a canonical row id.
const ASSIGNMENT_SUBJECT_KIND: Partial<Record<GovernanceRuleId, "identity" | "group">> = {
  direct_assignment_with_stale_endpoint: "identity",
  group_assignment_with_stale_endpoint: "group",
};

function subjectLink(
  subjectType: GovernanceSubjectType, subjectId: string, ruleId: GovernanceRuleId,
  identities: LabelMap, groups: LabelMap, applications: LabelMap,
): SafeSubjectLink | null {
  // A link is only emitted when the id RESOLVES to a known safe label in the evaluated graph. An unresolved id means the subject is
  // outside this scope — including a superseded connector's row, which the RPCs never return — so it must not become a route.
  const identity = (id: string) => identities.has(id) ? { kind: "identity" as const, label: identities.get(id)!, href: `/access/identities/${id}` } : null;
  const group = (id: string) => groups.has(id) ? { kind: "group" as const, label: groups.get(id)!, href: `/directory/groups/${id}` } : null;
  const application = (id: string) => applications.has(id) ? { kind: "application" as const, label: applications.get(id)!, href: `/access/applications/${id}` } : null;

  switch (subjectType) {
    case "identity":
    case "effective_access": return identity(subjectId);
    case "group":            return group(subjectId);
    case "application":      return application(subjectId);
    case "assignment": {
      const kind = ASSIGNMENT_SUBJECT_KIND[ruleId];
      return kind === "identity" ? identity(subjectId) : kind === "group" ? group(subjectId) : null;
    }
    case "graph":            return null;   // a hashed scope token, not a row id
  }
}

export function mapFindingToView(f: GovernanceFinding, identities: LabelMap, applications: LabelMap, groups: LabelMap = new Map()): GovernanceFindingView {
  const prose = ruleProse(f.ruleId);
  const evidenceRows = Object.entries(f.evidence.counts).map(([k, v]) => ({ label: humanizeCount(k), value: String(v) }));
  return {
    id: f.id, ruleId: f.ruleId, subjectType: f.subjectType,
    severity: f.severity, severityLabel: severityLabel(f.severity), severityTone: severityTone(f.severity),
    confidence: f.confidence, confidenceLabel: confidenceLabel(f.confidence),
    title: prose.title, summary: prose.summary, guidance: prose.guidance,
    subject: subjectLink(f.subjectType, f.subjectId, f.ruleId, identities, groups, applications),
    evidenceRows, staleEvidence: f.category === "freshness",
  };
}

export function mapSummaryToView(s: GovernanceSummary): GovernanceSummaryView {
  return { total: s.findingsTotal, bySeverity: s.findingsBySeverity };
}

// Map one identity's effective access to per-application rows (for the identity detail page). `groupLabelOf` resolves a group row id -> safe label.
export function mapIdentityApplications(access: IdentityAccess, applications: LabelMap, groupLabelOf: LabelMap): IdentityApplicationAccessView[] {
  return access.effective.map((app: AppAccess) => {
    const c = classificationView(app.classification, app.groupPaths.length);
    return {
      applicationId: app.applicationId,
      applicationLabel: applications.get(app.applicationId) ?? "Unnamed application",
      classification: app.classification, classificationLabel: c.label, explanation: c.explanation,
      groupPaths: app.groupPaths.map((p) => ({ groupId: p.groupId, groupLabel: groupLabelOf.get(p.groupId) ?? "Unnamed group", staleEvidence: p.assignment.syncStatus !== "current" || p.membership.syncStatus !== "current" })),
      staleEvidence: (app.directProvenance?.syncStatus ?? "current") !== "current" || app.groupPaths.some((p) => p.assignment.syncStatus !== "current" || p.membership.syncStatus !== "current"),
    };
  });
}
