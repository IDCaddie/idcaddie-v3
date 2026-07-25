import { describe, it, expect } from "vitest";
import { identityLabel, groupLabel, applicationLabel, classificationView, mapIdentityApplications, mapFindingToView, mapSummaryToView } from "./access-view-models";
import type { GovernanceFinding, GovernanceSummary } from "@/lib/server/governance-analytics/types";
import type { IdentityAccess, AppAccess } from "@/lib/server/access-graph/types";

const scope = { tenantId: "t1", connectionId: "c1", provider: "okta" };
const finding = (over: Partial<GovernanceFinding>): GovernanceFinding => ({
  id: "fid", ruleId: "redundant_direct_access", category: "redundancy", severity: "medium", confidence: "high", scope,
  subjectType: "identity", subjectId: "i1", relatedIds: ["a1"], titleKey: "k.t", summaryKey: "k.s", remediationKey: "k.r",
  evidence: { counts: { directAssignmentCount: 1, inheritedPathCount: 2 } }, detectedAt: null, ...over,
});

describe("access view models — safe labels + truthful copy", () => {
  it("identity label falls back display_name → login → email → 'Unnamed identity' (never a uuid/external_id)", () => {
    expect(identityLabel({ display_name: "Ada", login: "ada", email: "ada@x.test" })).toBe("Ada");
    expect(identityLabel({ display_name: null, login: "ada", email: "ada@x.test" })).toBe("ada");
    expect(identityLabel({ display_name: " ", login: null, email: "ada@x.test" })).toBe("ada@x.test");
    expect(identityLabel({ display_name: null, login: null, email: null })).toBe("Unnamed identity");
    expect(groupLabel({ name: null })).toBe("Unnamed group");
    expect(applicationLabel({ label: null, name: null })).toBe("Unnamed application");
    expect(applicationLabel({ label: null, name: "salesforce" })).toBe("salesforce");
  });

  it("classification view renders the engine's DIRECT/GROUP/BOTH truthfully; count-accurate, singular/plural correct", () => {
    // classificationView RENDERS the Phase-13 classification (single source of truth) — it never re-derives it from booleans.
    expect(classificationView("DIRECT", 0)).toEqual({ label: "Direct", explanation: "Access is represented through a direct assignment." });
    expect(classificationView("GROUP", 1)).toEqual({ label: "Through group", explanation: "Access is represented through 1 group." });
    expect(classificationView("GROUP", 3)).toEqual({ label: "Through group", explanation: "Access is represented through 3 groups." });
    expect(classificationView("BOTH", 2)).toEqual({ label: "Direct and through group", explanation: "Access is represented through a direct assignment and 2 groups." });
  });

  it("mapIdentityApplications carries the engine's classification VERBATIM (never re-derives from direct/groupPaths)", () => {
    const cur = { syncStatus: "current" as const };
    // Contradictory-looking rows: the booleans/paths would confuse a naive re-derivation, but the view must trust app.classification.
    const app = (over: Partial<AppAccess>): AppAccess => ({ applicationId: "a1", classification: "GROUP", direct: false, directProvenance: null, groupPaths: [], ...over });
    const access = (effective: AppAccess[]): IdentityAccess => ({ identityId: "i1", scope: { tenantId: "t1", connectionId: "c1", provider: "okta" }, direct: [], group: [], effective, directCount: 0, groupCount: 0, effectiveCount: effective.length, bothCount: 0, duplicatePathsEliminated: 0 });
    const apps = new Map([["a1", "Salesforce"]]);
    const groups = new Map([["g1", "Sales"]]);

    // Engine says BOTH even though only a group path is present → view still says BOTH (not "Through group").
    const both = mapIdentityApplications(access([app({ classification: "BOTH", groupPaths: [{ groupId: "g1", membership: cur, assignment: cur }] })]), apps, groups)[0];
    expect(both.classification).toBe("BOTH");
    expect(both.classificationLabel).toBe("Direct and through group");

    // Engine says DIRECT with zero group paths → "Direct".
    const direct = mapIdentityApplications(access([app({ classification: "DIRECT", direct: true, directProvenance: cur })]), apps, groups)[0];
    expect(direct.classification).toBe("DIRECT");
    expect(direct.classificationLabel).toBe("Direct");
  });
});

describe("mapFindingToView — presenter copy + safe subjects + evidence", () => {
  const identities = new Map([["i1", "Ada"]]);
  const applications = new Map([["a1", "Salesforce"]]);

  it("resolves presenter copy + severity/confidence + evidence rows; links the subject only when it resolves to a known label", () => {
    const v = mapFindingToView(finding({}), identities, applications);
    expect(v.title).toBe("Direct and group-based access overlap");
    expect(v.severity).toBe("medium"); expect(v.severityTone).toBe("attention"); expect(v.confidenceLabel).toBe("High confidence");
    expect(v.subject).toEqual({ kind: "identity", label: "Ada", href: "/access/identities/i1" });
    expect(v.evidenceRows).toEqual([{ label: "Direct assignments", value: "1" }, { label: "Group paths", value: "2" }]);
  });

  it("emits NO subject link (and no id) for a structural 'graph' finding — aggregate only, no foreign id", () => {
    const v = mapFindingToView(finding({ ruleId: "cross_scope_edge_ignored", category: "structural", subjectType: "graph", subjectId: "scopehash", relatedIds: [], evidence: { counts: { edgeCount: 3 } } }), identities, applications);
    expect(v.subject).toBeNull();
    expect(v.evidenceRows).toEqual([{ label: "Affected relationships", value: "3" }]);
    expect(JSON.stringify(v)).not.toContain("scopehash");
  });

  it("emits NO subject link when the subject id is not in the resolvable label maps (never a bare UUID)", () => {
    const v = mapFindingToView(finding({ subjectId: "unknown-id" }), identities, applications);
    expect(v.subject).toBeNull();
    expect(JSON.stringify(v)).not.toContain("unknown-id");
  });

  it("staleEvidence flag reflects the finding category (freshness)", () => {
    expect(mapFindingToView(finding({ ruleId: "stale_only_effective_access", category: "freshness" }), identities, applications).staleEvidence).toBe(true);
    expect(mapFindingToView(finding({}), identities, applications).staleEvidence).toBe(false);
  });

  it("summary view carries counts only", () => {
    const s = { findingsTotal: 5, findingsBySeverity: { info: 1, low: 1, medium: 2, high: 1 } } as unknown as GovernanceSummary;
    expect(mapSummaryToView(s)).toEqual({ total: 5, bySeverity: { info: 1, low: 1, medium: 2, high: 1 } });
  });
});
