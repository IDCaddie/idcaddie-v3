import { describe, it, expect } from "vitest";
import { attentionQueue, healthRollup, posture, riskBreakdown } from "./executive-home";
import type { ConnectorSummary } from "./connector-management";
import type { GovernanceFindingView, GovernanceSummaryView } from "./access-view-models";

// Phase 7A — the executive Home derivations.
//
// Every one of these guards the same principle: an executive dashboard is where an untrue number does the most damage, because
// it is the number people quote without opening anything. So nothing here may be invented, and absence of evidence may never
// render as evidence of health.

const sum = (o: Partial<GovernanceSummaryView["bySeverity"]> = {}): GovernanceSummaryView => {
  const bySeverity = { high: 0, medium: 0, low: 0, info: 0, ...o };
  return { total: Object.values(bySeverity).reduce((a, b) => a + b, 0), bySeverity };
};
const f = (o: Partial<GovernanceFindingView> = {}): GovernanceFindingView => ({
  id: "f1", ruleId: "redundant_direct_access", subjectType: "identity", severity: "high", severityLabel: "High",
  severityTone: "danger", confidence: "high", confidenceLabel: "High", title: "T", summary: "S", guidance: null,
  subject: { kind: "identity", label: "Ada", href: "/access/identities/x" }, evidenceRows: [], staleEvidence: false, ...o,
} as GovernanceFindingView);
const conn = (o: Partial<ConnectorSummary> = {}): ConnectorSummary => ({
  id: "c1", provider: "okta", name: "Corp", organization: "corp.okta.com", lifecycle: "discovered", lifecycleLabel: "Discovered",
  health: { state: "healthy", label: "Healthy", reason: "ok" }, active: true, supersededBy: null, disconnectedAt: null,
  disconnectedReason: null, lastVerifiedAt: null, lastDiscoveryAt: null, createdAt: null,
  counts: { people: 1, groups: 6, applications: 2, memberships: 1, userAssignments: 1, groupAssignments: 0 }, ...o,
} as ConnectorSummary);

const counts = { identities: 1, groups: 6, applications: 2, memberships: 1, directAssignments: 1, groupAssignments: 0 };

describe("posture never turns absence into an all-clear", () => {
  it("reports a complete graph with its breakdown", () => {
    const p = posture({ ok: true, data: { status: "complete", counts, breakdown: { directOnly: 1, groupOnly: 4, both: 2 }, effectiveRelationships: 7, governanceFindingsTotal: 0, summary: sum(), findings: [] } });
    expect(p.status).toBe("complete");
    if (p.status !== "complete") throw new Error();
    expect(p.effective).toBe(7);
    expect(p.groupOnly).toBe(4);
  });

  it("keeps counts but withholds the distribution when the graph was too large", () => {
    // Zeros here would claim the graph has no group-mediated access. It was never evaluated — an opposite claim.
    const p = posture({ ok: true, data: { status: "too_large", counts } });
    expect(p.status).toBe("too_large");
    expect(JSON.stringify(p)).not.toContain("directOnly");
    if (p.status !== "too_large") throw new Error();
    expect(p.counts.groups, "the counts are still true").toBe(6);
  });

  it("distinguishes forbidden from failed, and neither is 'healthy'", () => {
    for (const e of ["forbidden", "query_failed"] as const) {
      const p = posture({ ok: false, error: e });
      expect(p.status).toBe("unavailable");
      if (p.status !== "unavailable") throw new Error();
      expect(p.reason).toBe(e);
    }
  });
});

describe("risk comes from the engine, not from a score", () => {
  it("takes severity counts from the engine's own summary rather than re-counting", () => {
    // Recomputing what the engine already summarised creates a second place for the two to disagree.
    const r = riskBreakdown(sum({ high: 3, medium: 2 }), []);
    expect(r.high).toBe(3);
    expect(r.medium).toBe(2);
    expect(r.total).toBe(5);
  });

  it("invents no composite score", () => {
    const r = riskBreakdown(sum({ high: 3 }), [f()]);
    expect(Object.keys(r)).toEqual(["high", "medium", "low", "info", "staleEvidence", "total", "topSubjects"]);
    expect(JSON.stringify(r)).not.toMatch(/score|rating|percent|trend/i);
  });

  it("lists only subjects that can actually be opened", () => {
    // A row the customer cannot follow is a dead end, not a priority.
    const r = riskBreakdown(sum({ high: 2 }), [f({ id: "a" }), f({ id: "b", subject: null })]);
    expect(r.topSubjects.map((x) => x.id)).toEqual(["a"]);
  });

  it("counts stale-evidence findings separately", () => {
    const r = riskBreakdown(sum({ high: 2 }), [f({ id: "a", staleEvidence: true }), f({ id: "b" })]);
    expect(r.staleEvidence).toBe(1);
  });
});

describe("the attention queue is bounded, ordered and actionable", () => {
  it("puts a failing connector above a medium finding", () => {
    // While a connector is failing, every finding derived from it is suspect.
    const q = attentionQueue([f({ severity: "medium", severityLabel: "Medium" })], [conn({ health: { state: "failed", label: "Needs attention", reason: "auth rejected" } })]);
    expect(q[0].kind).toBe("connector");
    expect(q[0].severity).toBe("high");
  });

  it("excludes info findings — padding the queue trains people to ignore it", () => {
    const q = attentionQueue([f({ severity: "info", severityLabel: "Info" })], []);
    expect(q).toHaveLength(0);
  });

  it("gives every row a link that works, even without a subject", () => {
    const q = attentionQueue([f({ subject: null })], [conn({ health: { state: "failed", label: "x", reason: "y" } })]);
    for (const r of q) expect(r.href.startsWith("/")).toBe(true);
    expect(q.find((r) => r.kind === "finding")!.href).toContain("/access/findings");
  });

  it("is bounded", () => {
    const many = Array.from({ length: 50 }, (_, i) => f({ id: `f${i}` }));
    expect(attentionQueue(many, []).length).toBeLessThanOrEqual(8);
  });

  it("says nothing when nothing is wrong, rather than inventing filler", () => {
    expect(attentionQueue([], [conn()])).toHaveLength(0);
  });
});

describe("health rollup never flattens a failure into one green tick", () => {
  it("passes a single connector's health straight through", () => {
    expect(healthRollup([conn()])!.state).toBe("healthy");
  });

  it("reports the WORST across several, and names which", () => {
    const r = healthRollup([conn({ id: "a", name: "Corp" }), conn({ id: "b", name: "Sandbox", health: { state: "failed", label: "Needs attention", reason: "x" } })])!;
    expect(r.state).toBe("failed");
    expect(r.reason).toContain("Sandbox");
    expect(r.reason).toContain("1 of 2");
  });

  it("only says all-healthy when they all are", () => {
    const r = healthRollup([conn({ id: "a" }), conn({ id: "b" })])!;
    expect(r.state).toBe("healthy");
    expect(r.label).toBe("All directories healthy");
  });

  it("returns null with no active directory, so the caller must handle it", () => {
    expect(healthRollup([])).toBeNull();
  });
});
