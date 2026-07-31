import { describe, it, expect } from "vitest";
import { mapFindingToView } from "./access-view-models";
import { groupFindingsBySubject, subjectBucket, parseAccessFilters, filterFindings, accessHref, SUBJECT_BUCKETS } from "./access-filters";
import type { GovernanceFinding, GovernanceRuleId, GovernanceSubjectType, GovernanceSeverity } from "@/lib/server/governance-analytics/types";

// Phase 4 — the finding → object contract.
//
// Two properties matter more than anything else here:
//   1. A link is built from a CANONICAL ID that resolved in the evaluated scope. Never from a name, never from a bare id.
//   2. A subject that did not resolve produces NO link. That is what keeps a superseded connector's row — which the RPCs never
//      return, so it is never in the label maps — from becoming a reachable route.

const IDENTITY = "11111111-1111-4111-8111-111111111111";
const GROUP = "22222222-2222-4222-8222-222222222222";
const APP = "33333333-3333-4333-8333-333333333333";
const FOREIGN = "99999999-9999-4999-8999-999999999999";

const identities = new Map([[IDENTITY, "Ada Lovelace"]]);
const groups = new Map([[GROUP, "Engineering"]]);
const applications = new Map([[APP, "Salesforce"]]);

const finding = (o: Partial<GovernanceFinding> & { subjectType: GovernanceSubjectType; subjectId: string; ruleId: GovernanceRuleId }): GovernanceFinding =>
  ({
    id: `f-${o.ruleId}`, severity: "medium" as GovernanceSeverity, confidence: "high",
    category: "topology", relatedIds: [], detectedAt: null,
    evidence: { counts: {}, endpointStates: {} },
    scope: { tenantId: "t", connectionId: "c", provider: "okta" },
    ...o,
  }) as unknown as GovernanceFinding;

const view = (f: GovernanceFinding) => mapFindingToView(f, identities, applications, groups);

// ── canonical-id routing ─────────────────────────────────────────────────────────────────────────────────────────────────────────
describe("a finding links to its subject by canonical id", () => {
  it("routes an identity finding to the person", () => {
    const v = view(finding({ subjectType: "identity", subjectId: IDENTITY, ruleId: "identity_without_effective_access" }));
    expect(v.subject).toEqual({ kind: "identity", label: "Ada Lovelace", href: `/access/identities/${IDENTITY}` });
  });

  it("routes a GROUP finding to the group — it produced no link at all before Phase 4", () => {
    const v = view(finding({ subjectType: "group", subjectId: GROUP, ruleId: "group_without_application_reach" }));
    expect(v.subject).toEqual({ kind: "group", label: "Engineering", href: `/directory/groups/${GROUP}` });
  });

  it("routes an application finding to the application", () => {
    const v = view(finding({ subjectType: "application", subjectId: APP, ruleId: "application_without_effective_identities" }));
    expect(v.subject).toEqual({ kind: "application", label: "Salesforce", href: `/access/applications/${APP}` });
  });

  it("routes effective_access to the PERSON, since that is what the finding is about", () => {
    const v = view(finding({ subjectType: "effective_access", subjectId: IDENTITY, ruleId: "stale_only_effective_access" }));
    expect(v.subject?.kind).toBe("identity");
  });

  it("never puts a label in the href", () => {
    // The whole failure mode this guards: two groups can share a name, and a name is not a route.
    for (const v of [
      view(finding({ subjectType: "group", subjectId: GROUP, ruleId: "group_without_application_reach" })),
      view(finding({ subjectType: "identity", subjectId: IDENTITY, ruleId: "identity_without_effective_access" })),
      view(finding({ subjectType: "application", subjectId: APP, ruleId: "application_without_effective_identities" })),
    ]) {
      expect(v.subject!.href).not.toContain(v.subject!.label);
      expect(v.subject!.href).toMatch(/\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    }
  });
});

// ── the ambiguous one ────────────────────────────────────────────────────────────────────────────────────────────────────────────
describe("assignment findings are disambiguated by RULE, not guessed", () => {
  it("sends a direct-assignment finding to the person", () => {
    const v = view(finding({ subjectType: "assignment", subjectId: IDENTITY, ruleId: "direct_assignment_with_stale_endpoint" }));
    expect(v.subject).toEqual({ kind: "identity", label: "Ada Lovelace", href: `/access/identities/${IDENTITY}` });
  });

  it("sends a group-assignment finding to the group", () => {
    // Same subjectType, same shape of id — only the rule says which kind it is. Both are uuids, so inferring from the value is
    // impossible and any guess would be wrong half the time.
    const v = view(finding({ subjectType: "assignment", subjectId: GROUP, ruleId: "group_assignment_with_stale_endpoint" }));
    expect(v.subject).toEqual({ kind: "group", label: "Engineering", href: `/directory/groups/${GROUP}` });
  });

  it("refuses to link an assignment rule it does not recognise", () => {
    // A future assignment rule is unmapped, so it links nowhere rather than to a plausible-looking wrong object.
    const v = view(finding({ subjectType: "assignment", subjectId: IDENTITY, ruleId: "redundant_direct_access" as GovernanceRuleId }));
    expect(v.subject).toBeNull();
  });
});

// ── the refusals ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────
describe("a subject that did not resolve produces NO link", () => {
  it("emits nothing for an id outside the evaluated scope", () => {
    // This is the supersession guarantee at the view layer: the RPCs never return a superseded connector's rows, so such an id is
    // never in the label maps, so it can never become a route.
    for (const t of ["identity", "group", "application", "effective_access"] as const) {
      expect(view(finding({ subjectType: t, subjectId: FOREIGN, ruleId: "identity_without_effective_access" })).subject, t).toBeNull();
    }
  });

  it("never links a structural graph finding", () => {
    // Its subjectId is a sha256 scope token, not a row id. Routing on it would 404 at best.
    const token = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
    const v = view(finding({ subjectType: "graph", subjectId: token, ruleId: "cross_scope_edge_ignored" }));
    expect(v.subject).toBeNull();
    expect(JSON.stringify(v)).not.toContain(token);
  });

  it("never emits a bare uuid as a label", () => {
    const v = view(finding({ subjectType: "group", subjectId: FOREIGN, ruleId: "group_without_application_reach" }));
    expect(JSON.stringify(v)).not.toContain(FOREIGN);
  });
});

// ── buckets ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
describe("subject buckets", () => {
  it("maps every engine subject type into exactly one bucket", () => {
    expect(subjectBucket("identity")).toBe("people");
    expect(subjectBucket("effective_access")).toBe("people");
    expect(subjectBucket("group")).toBe("groups");
    expect(subjectBucket("application")).toBe("applications");
    expect(subjectBucket("assignment")).toBe("assignments");
    expect(subjectBucket("graph")).toBe("directory");
  });

  const v = (subjectType: GovernanceSubjectType, severity: GovernanceSeverity, id: string) =>
    ({ id, subjectType, severity, severityLabel: severity, severityTone: "neutral", ruleId: "x", confidence: "high",
       confidenceLabel: "High", title: "t", summary: "s", guidance: null, subject: null, evidenceRows: [], staleEvidence: false }) as never;

  it("orders buckets by the worst severity each contains", () => {
    // The subject area needing attention first comes first — not a fixed alphabetical order that buries a High behind an Info.
    const grouped = groupFindingsBySubject([
      v("group", "info", "g1"), v("application", "high", "a1"), v("identity", "medium", "i1"),
    ]);
    expect(grouped.map((b) => b.bucket)).toEqual(["applications", "people", "groups"]);
  });

  it("keeps severity order within a bucket and hides nothing", () => {
    const rows = [v("identity", "high", "i1"), v("identity", "low", "i2"), v("group", "medium", "g1")];
    const grouped = groupFindingsBySubject(rows);
    expect(grouped.flatMap((b) => b.findings).length, "every finding survives grouping").toBe(rows.length);
    expect(grouped.find((b) => b.bucket === "people")!.findings.map((f) => f.severity)).toEqual(["high", "low"]);
  });

  it("omits empty buckets rather than rendering zeros", () => {
    const grouped = groupFindingsBySubject([v("identity", "high", "i1")]);
    expect(grouped).toHaveLength(1);
    expect(grouped[0].bucket).toBe("people");
  });
});

// ── URL state ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
describe("subject filter and URL state", () => {
  it("parses and round-trips the bucket", () => {
    for (const b of SUBJECT_BUCKETS) {
      expect(parseAccessFilters({ subject: b }).subject).toBe(b);
      expect(accessHref("/access/findings", parseAccessFilters({ subject: b }))).toContain(`subject=${b}`);
    }
    expect(parseAccessFilters({ subject: "nonsense" }).subject, "unknown values are ignored, not echoed").toBeNull();
  });

  it("filters to the bucket, keeping both of the people subject types", () => {
    const rows = [
      { id: "a", subjectType: "identity", severity: "high", title: "", summary: "", subject: null, staleEvidence: false },
      { id: "b", subjectType: "effective_access", severity: "low", title: "", summary: "", subject: null, staleEvidence: false },
      { id: "c", subjectType: "group", severity: "high", title: "", summary: "", subject: null, staleEvidence: false },
    ] as never[];
    expect(filterFindings(rows, parseAccessFilters({ subject: "people" })).map((f) => f.id)).toEqual(["a", "b"]);
    expect(filterFindings(rows, parseAccessFilters({ subject: "groups" })).map((f) => f.id)).toEqual(["c"]);
  });

  it("composes with severity and survives paging", () => {
    const f = parseAccessFilters({ subject: "groups", severity: "high", page: "3" });
    const href = accessHref("/access/findings", f, { page: 4 });
    // Paging must not silently drop the subject scope — that would show the customer a different set than they asked for.
    expect(href).toContain("subject=groups");
    expect(href).toContain("severity=high");
    expect(href).toContain("page=4");
  });

  it("resets to page 1 when the subject changes, so a deep page cannot outlive its filter", () => {
    const f = parseAccessFilters({ subject: "people", page: "5" });
    expect(accessHref("/access/findings", f, { subject: "groups" })).not.toContain("page=");
  });
});
