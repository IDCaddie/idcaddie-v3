import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { evaluateGovernance, evaluateIdentityGovernance } from "./evaluate";
import { governanceFindingId } from "./finding-id";
import type { GovernanceGraph, CanonicalNode, GovernanceFinding, GovernancePolicy, SyncStatus, Scope } from "./types";
import type { MembershipEdge, UserAssignmentEdge, GroupAssignmentEdge } from "../access-graph/types";

const A: Scope = { tenantId: "tA", connectionId: "cA", provider: "okta" };
const B: Scope = { tenantId: "tB", connectionId: "cA", provider: "okta" };
const A2: Scope = { tenantId: "tA", connectionId: "cB", provider: "okta" };
const AP: Scope = { tenantId: "tA", connectionId: "cA", provider: "entra" };

const node = (id: string, syncStatus: SyncStatus = "current", s: Scope = A): CanonicalNode => ({ id, ...s, syncStatus });
const mem = (identityAccountId: string, directoryGroupId: string, syncStatus: SyncStatus = "current", s: Scope = A): MembershipEdge => ({ ...s, syncStatus, identityAccountId, directoryGroupId });
const ua = (identityAccountId: string, directoryApplicationId: string, syncStatus: SyncStatus = "current", s: Scope = A): UserAssignmentEdge => ({ ...s, syncStatus, identityAccountId, directoryApplicationId });
const ga = (directoryGroupId: string, directoryApplicationId: string, syncStatus: SyncStatus = "current", s: Scope = A): GroupAssignmentEdge => ({ ...s, syncStatus, directoryGroupId, directoryApplicationId });
const graph = (o: Partial<GovernanceGraph>): GovernanceGraph => ({ identities: o.identities ?? [], groups: o.groups ?? [], applications: o.applications ?? [], memberships: o.memberships ?? [], userAssignments: o.userAssignments ?? [], groupAssignments: o.groupAssignments ?? [] });
const byRule = (fs: readonly GovernanceFinding[], ruleId: string) => fs.filter((f) => f.ruleId === ruleId);

describe("governance rules", () => {
  it("Rule 1 redundant_direct_access: fires only when an app is reached by BOTH direct + a group path", () => {
    const bothG = graph({ identities: [node("i1")], groups: [node("g1")], applications: [node("a1")], userAssignments: [ua("i1", "a1")], memberships: [mem("i1", "g1")], groupAssignments: [ga("g1", "a1")] });
    const f = byRule(evaluateGovernance(bothG).findings, "redundant_direct_access");
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({ severity: "medium", confidence: "high", subjectType: "identity", subjectId: "i1", category: "redundancy" });
    expect(f[0].relatedIds).toEqual(["a1", "g1"]);
    expect(f[0].evidence.counts).toMatchObject({ directAssignmentCount: 1, inheritedPathCount: 1 });
    // direct-only and group-only never fire it
    expect(byRule(evaluateGovernance(graph({ identities: [node("i1")], applications: [node("a1")], userAssignments: [ua("i1", "a1")] })).findings, "redundant_direct_access")).toHaveLength(0);
    expect(byRule(evaluateGovernance(graph({ identities: [node("i1")], groups: [node("g1")], applications: [node("a1")], memberships: [mem("i1", "g1")], groupAssignments: [ga("g1", "a1")] })).findings, "redundant_direct_access")).toHaveLength(0);
  });

  it("Rule 2 identity_without_effective_access: current identity with zero effective apps (not stale unless policy)", () => {
    const g = graph({ identities: [node("i1"), node("iStale", "stale")], groups: [node("g1")], memberships: [mem("i1", "g1")] }); // g1 grants no app
    const f = byRule(evaluateGovernance(g).findings, "identity_without_effective_access");
    expect(f.map((x) => x.subjectId)).toEqual(["i1"]); // iStale excluded (current-only default)
    expect(f[0]).toMatchObject({ severity: "info", confidence: "high" });
    expect(f[0].evidence.counts).toMatchObject({ effectiveCount: 0, currentMembershipCount: 1, staleMembershipCount: 0 });
    // includeStale surfaces the stale identity too
    expect(byRule(evaluateGovernance(g, { includeStale: true }).findings, "identity_without_effective_access").map((x) => x.subjectId).sort()).toEqual(["i1", "iStale"]);
  });

  it("Rule 3 group_without_application_reach: a current group granting zero apps", () => {
    const g = graph({ identities: [node("i1")], groups: [node("gEmpty"), node("gReach")], applications: [node("a1")], memberships: [mem("i1", "gEmpty")], groupAssignments: [ga("gReach", "a1")] });
    const f = byRule(evaluateGovernance(g).findings, "group_without_application_reach");
    expect(f.map((x) => x.subjectId)).toEqual(["gEmpty"]);
    expect(f[0].evidence.counts).toMatchObject({ memberCount: 1, applicationAssignmentCount: 0 });
  });

  it("Rule 4 application_without_effective_identities: a current app with zero reaching identities", () => {
    const g = graph({ identities: [node("i1")], applications: [node("aLonely"), node("aUsed")], userAssignments: [ua("i1", "aUsed")] });
    const f = byRule(evaluateGovernance(g).findings, "application_without_effective_identities");
    expect(f.map((x) => x.subjectId)).toEqual(["aLonely"]);
    expect(f[0]).toMatchObject({ severity: "low", confidence: "high" });
    expect(f[0].evidence.counts).toMatchObject({ effectiveIdentityCount: 0 });
  });

  it("Rule 5 stale-endpoint: a CURRENT assignment to a STALE endpoint (direct + group variants)", () => {
    const g = graph({
      identities: [node("i1"), node("iStale", "stale")], groups: [node("g1"), node("gStale", "stale")], applications: [node("a1"), node("aStale", "stale")],
      userAssignments: [ua("iStale", "a1"), ua("i1", "aStale")],  // current edges -> stale identity / stale app
      groupAssignments: [ga("gStale", "a1"), ga("g1", "aStale")], // current edges -> stale group / stale app
    });
    const d = byRule(evaluateGovernance(g, { includeStale: true }).findings, "direct_assignment_with_stale_endpoint");
    const gr = byRule(evaluateGovernance(g, { includeStale: true }).findings, "group_assignment_with_stale_endpoint");
    expect(d).toHaveLength(2); expect(gr).toHaveLength(2);
    expect(d[0]).toMatchObject({ severity: "medium", confidence: "high", subjectType: "assignment" });
    expect(d.find((x) => x.relatedIds.includes("a1"))!.evidence.endpointStates).toMatchObject({ identity: "stale", assignment: "current" });
  });

  it("Rule 6 stale_only_effective_access: reachable with stale edges but NOT current-only", () => {
    // i1 reaches a1 ONLY via a stale direct edge; nothing current.
    const g = graph({ identities: [node("i1")], applications: [node("a1")], userAssignments: [ua("i1", "a1", "stale")] });
    const f = byRule(evaluateGovernance(g).findings, "stale_only_effective_access");
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({ severity: "medium", confidence: "medium", subjectType: "effective_access", subjectId: "i1" });
    expect(f[0].evidence.counts).toMatchObject({ staleDirectPathCount: 1, staleGroupPathCount: 0, currentPathCount: 0 });
    // a CURRENT path suppresses the stale-only finding
    const g2 = graph({ identities: [node("i1")], applications: [node("a1")], userAssignments: [ua("i1", "a1", "stale"), ua("i1", "a1", "current")] });
    expect(byRule(evaluateGovernance(g2).findings, "stale_only_effective_access")).toHaveLength(0);
  });

  it("Rule 7 identity_broad_access: threshold-gated (disabled by default)", () => {
    const g = graph({ identities: [node("i1")], applications: [node("a1"), node("a2"), node("a3")], userAssignments: [ua("i1", "a1"), ua("i1", "a2"), ua("i1", "a3")] });
    expect(byRule(evaluateGovernance(g).findings, "identity_broad_access")).toHaveLength(0); // disabled
    const f = byRule(evaluateGovernance(g, { identityBroadAccessThreshold: 2 }).findings, "identity_broad_access");
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({ severity: "medium", confidence: "medium" });
    expect(f[0].evidence).toMatchObject({ threshold: 2, counts: { effectiveApplicationCount: 3 } });
    expect(byRule(evaluateGovernance(g, { identityBroadAccessThreshold: 3 }).findings, "identity_broad_access")).toHaveLength(0); // equal, not above
  });

  it("Rule 8 group_broad_application_reach: threshold-gated", () => {
    const g = graph({ identities: [node("i1")], groups: [node("g1")], applications: [node("a1"), node("a2"), node("a3")], memberships: [mem("i1", "g1")], groupAssignments: [ga("g1", "a1"), ga("g1", "a2"), ga("g1", "a3")] });
    expect(byRule(evaluateGovernance(g).findings, "group_broad_application_reach")).toHaveLength(0);
    const f = byRule(evaluateGovernance(g, { groupBroadReachThreshold: 2 }).findings, "group_broad_application_reach");
    expect(f).toHaveLength(1); expect(f[0]).toMatchObject({ severity: "low", confidence: "medium" });
    expect(f[0].evidence.counts).toMatchObject({ applicationCount: 3, memberCount: 1 });
  });

  it("Rule 9 duplicate_inherited_access_paths: same app via >1 distinct group", () => {
    const g = graph({ identities: [node("i1")], groups: [node("g1"), node("g2")], applications: [node("a1")], memberships: [mem("i1", "g1"), mem("i1", "g2")], groupAssignments: [ga("g1", "a1"), ga("g2", "a1")] });
    const f = byRule(evaluateGovernance(g).findings, "duplicate_inherited_access_paths");
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({ severity: "low", confidence: "high", subjectType: "effective_access" });
    expect(f[0].evidence.counts).toMatchObject({ distinctGroupPathCount: 2 });
    expect(f[0].evidence.supportingIds).toEqual(["g1", "g2"]);
    // one group -> no finding (threshold default 1)
    expect(byRule(evaluateGovernance(graph({ identities: [node("i1")], groups: [node("g1")], applications: [node("a1")], memberships: [mem("i1", "g1")], groupAssignments: [ga("g1", "a1")] })).findings, "duplicate_inherited_access_paths")).toHaveLength(0);
  });

  it("Rule 10 structural: missing endpoints + cross-scope reported as AGGREGATE COUNTS with NO foreign id", () => {
    const g = graph({
      identities: [node("i1", "current", A)], groups: [node("g1", "current", A)], applications: [node("a1", "current", A)],
      userAssignments: [ua("i1", "aMISSING"), ua("iMISSING", "a1")],      // dangling app + dangling identity
      groupAssignments: [ga("g1", "a1", "current", B)],                    // cross-scope (references B's ids from A's app... actually scope B edge)
    });
    const fs = evaluateGovernance(g, { includeStale: true }).findings;
    const missApp = byRule(fs, "assignment_missing_application"); const missId = byRule(fs, "assignment_missing_identity");
    expect(missApp).toHaveLength(1); expect(missApp[0]).toMatchObject({ severity: "high", confidence: "high", subjectType: "graph" });
    expect(missApp[0].evidence.counts.edgeCount).toBe(1);
    expect(missApp[0].relatedIds).toEqual([]); // NO foreign id leaked
    expect(missId[0].evidence.counts.edgeCount).toBe(1);
    // the whole finding set never contains the dangling foreign ids
    expect(JSON.stringify(fs)).not.toContain("aMISSING");
    expect(JSON.stringify(fs)).not.toContain("iMISSING");
  });
});

describe("determinism + finding identity", () => {
  const g = graph({ identities: [node("i1"), node("i2")], groups: [node("g1"), node("g2")], applications: [node("a1"), node("a2")],
    userAssignments: [ua("i1", "a1")], memberships: [mem("i1", "g1"), mem("i1", "g2"), mem("i2", "g1")], groupAssignments: [ga("g1", "a1"), ga("g2", "a1"), ga("g1", "a2")] });

  it("same input -> byte-identical output; shuffled input -> identical output", () => {
    const r1 = evaluateGovernance(g);
    const shuffled = graph({ identities: [node("i2"), node("i1")], groups: [node("g2"), node("g1")], applications: [node("a2"), node("a1")],
      userAssignments: [ua("i1", "a1")], memberships: [mem("i2", "g1"), mem("i1", "g2"), mem("i1", "g1")], groupAssignments: [ga("g1", "a2"), ga("g2", "a1"), ga("g1", "a1")] });
    const r2 = evaluateGovernance(shuffled);
    expect(JSON.stringify(r2)).toBe(JSON.stringify(r1)); // shuffle-invariant
  });

  it("finding id is stable + injective; depends on subject/related but NOT on order", () => {
    const base = { ruleId: "redundant_direct_access" as const, scope: A, subjectType: "identity" as const, subjectId: "i1", relatedIds: ["a1", "g2", "g1"] };
    expect(governanceFindingId(base)).toBe(governanceFindingId({ ...base, relatedIds: ["g1", "a1", "g2"] })); // order-independent
    expect(governanceFindingId(base)).not.toBe(governanceFindingId({ ...base, subjectId: "i2" }));            // subject change -> new id
    expect(governanceFindingId(base)).not.toBe(governanceFindingId({ ...base, relatedIds: ["a1", "g1"] }));   // related set change -> new id
    expect(governanceFindingId(base)).not.toBe(governanceFindingId({ ...base, scope: B }));                    // scope change -> new id (isolation)
    // injective delimiter: ("a:b","c") vs ("a","b:c") must not collide
    expect(governanceFindingId({ ...base, relatedIds: ["a:b", "c"] })).not.toBe(governanceFindingId({ ...base, relatedIds: ["a", "b:c"] }));
  });

  it("higher severity sorts first; duplicate edge input does not duplicate findings", () => {
    const r = evaluateGovernance(g);
    for (let i = 1; i < r.findings.length; i++) {
      const rank = { info: 0, low: 1, medium: 2, high: 3 } as const;
      expect(rank[r.findings[i - 1].severity]).toBeGreaterThanOrEqual(rank[r.findings[i].severity]);
    }
    // duplicate the whole edge set -> same finding count (ids dedupe conceptually; the graph is the same relationships)
    const dup = graph({ ...g, memberships: [...g.memberships, ...g.memberships], userAssignments: [...g.userAssignments, ...g.userAssignments], groupAssignments: [...g.groupAssignments, ...g.groupAssignments] });
    const ids = new Set(evaluateGovernance(dup).findings.map((f) => f.id));
    expect(ids.size).toBe(evaluateGovernance(dup).findings.length); // no duplicate ids
  });
});

describe("isolation", () => {
  it("a cross-tenant / cross-connection / wrong-provider edge never grants an identity access (no redundancy/broad finding)", () => {
    for (const other of [B, A2, AP]) {
      const g = graph({ identities: [node("i1", "current", A)], groups: [node("g1", "current", other)], applications: [node("a1", "current", A)],
        userAssignments: [ua("i1", "a1", "current", other)], memberships: [mem("i1", "g1", "current", other)], groupAssignments: [ga("g1", "a1", "current", other)] });
      // i1 (scope A) has NO effective access -> identity_without_effective_access, and NO redundant/duplicate finding
      const fs = evaluateGovernance(g).findings;
      expect(byRule(fs, "redundant_direct_access")).toHaveLength(0);
      const noacc = byRule(fs, "identity_without_effective_access");
      expect(noacc.map((f) => f.subjectId)).toContain("i1");
    }
  });

  it("findings for scope A carry scope A and never reference scope B subjects", () => {
    const g = graph({ identities: [node("iA", "current", A), node("iB", "current", B)], applications: [node("aA", "current", A), node("aB", "current", B)],
      userAssignments: [ua("iA", "aA", "current", A), ua("iB", "aB", "current", B)] });
    const fs = evaluateGovernance(g).findings;
    for (const f of fs) {
      if (f.subjectId === "iA" || f.subjectId === "aA") expect(f.scope).toEqual(A);
      if (f.subjectId === "iB" || f.subjectId === "aB") expect(f.scope).toEqual(B);
    }
  });
});

describe("adversarial hardening (review fixes)", () => {
  it("a DUPLICATE current stale-endpoint edge does not inflate findings or the summary (INV-4)", () => {
    const g = graph({ identities: [node("i1")], applications: [node("a1", "stale")], userAssignments: [ua("i1", "a1"), ua("i1", "a1")] });
    const r = evaluateGovernance(g, { includeStale: true });
    const f = byRule(r.findings, "direct_assignment_with_stale_endpoint");
    expect(f).toHaveLength(1); // deduped, not 2
    expect(new Set(r.findings.map((x) => x.id)).size).toBe(r.findings.length); // no duplicate ids
    expect(r.summary.findingsByRule.direct_assignment_with_stale_endpoint).toBe(1);
  });

  it("a DUPLICATE input node does not inflate findings (Rules 2/3/4)", () => {
    const g = graph({ identities: [node("iNone"), node("iNone")], groups: [node("gNone"), node("gNone")], applications: [node("aNone"), node("aNone")] });
    const r = evaluateGovernance(g);
    expect(byRule(r.findings, "identity_without_effective_access")).toHaveLength(1);
    expect(byRule(r.findings, "group_without_application_reach")).toHaveLength(1);
    expect(byRule(r.findings, "application_without_effective_identities")).toHaveLength(1);
    expect(new Set(r.findings.map((x) => x.id)).size).toBe(r.findings.length);
  });

  it("Rule 5 never stamps a FOREIGN-scope row id as the finding subject (cross-scope edge is handled structurally, not as a stale-endpoint)", () => {
    // a CURRENT edge in scope B referencing a same-scope-B STALE app but a cross-scope-A identity: the subject (identity) is foreign -> skip.
    const g = graph({ identities: [node("iA", "current", A)], applications: [node("aB", "stale", B)], userAssignments: [ua("iA", "aB", "current", B)] });
    const r = evaluateGovernance(g, { includeStale: true });
    expect(byRule(r.findings, "direct_assignment_with_stale_endpoint")).toHaveLength(0); // no foreign subject emitted
    // iA may legitimately appear as its OWN scope-A identity finding, but NEVER as a subject stamped with the foreign scope B.
    for (const f of r.findings) if (f.subjectId === "iA") expect(f.scope).toEqual(A);
    expect(byRule(r.findings, "cross_scope_edge_ignored").length).toBeGreaterThan(0);    // the cross-scope edge is diagnosed structurally
  });

  it("cross_scope structural edgeCount counts each ignored edge ONCE (not once per endpoint)", () => {
    const g = graph({ groups: [node("g1", "current", A)], applications: [node("a1", "current", A)], groupAssignments: [ga("g1", "a1", "current", B)] });
    const f = byRule(evaluateGovernance(g, { includeStale: true }).findings, "cross_scope_edge_ignored");
    expect(f).toHaveLength(1);
    expect(f[0].evidence.counts.edgeCount).toBe(1); // one edge, not 2 (was double-counted per endpoint)
  });
});

describe("policy + summary + single-identity + errors", () => {
  it("invalid threshold is rejected", () => {
    expect(() => evaluateGovernance(graph({}), { identityBroadAccessThreshold: -1 })).toThrow(/non-negative integer/);
    expect(() => evaluateGovernance(graph({}), { duplicateInheritedPathThreshold: 1.5 })).toThrow(/non-negative integer/);
  });

  it("summary reports counts only and reflects the findings", () => {
    const g = graph({ identities: [node("i1"), node("iNone")], groups: [node("g1")], applications: [node("a1")],
      userAssignments: [ua("i1", "a1")], memberships: [mem("i1", "g1")], groupAssignments: [ga("g1", "a1")] });
    const { summary } = evaluateGovernance(g);
    expect(summary).toMatchObject({ identitiesEvaluated: 2, groupsEvaluated: 1, applicationsEvaluated: 1, identitiesWithBoth: 1, identitiesWithoutAccess: 1, redundantDirectAccessRelationships: 1 });
    expect(summary.findingsBySeverity).toHaveProperty("high");
    expect(JSON.stringify(summary)).not.toMatch(/@|label|email|name/i);
  });

  it("evaluateIdentityGovernance returns only that identity's findings", () => {
    const g = graph({ identities: [node("i1"), node("i2")], groups: [node("g1")], applications: [node("a1"), node("aLonely")],
      userAssignments: [ua("i1", "a1")], memberships: [mem("i1", "g1"), mem("i2", "g1")], groupAssignments: [ga("g1", "a1")] });
    const r = evaluateIdentityGovernance(g, "i1");
    for (const f of r.findings) expect(f.subjectId === "i1" || f.relatedIds.includes("i1")).toBe(true);
    expect(byRule(r.findings, "redundant_direct_access")).toHaveLength(1); // i1 has BOTH a1
    expect(byRule(r.findings, "application_without_effective_identities")).toHaveLength(0); // app-centric dropped
  });
});

describe("privacy + no-writes + performance", () => {
  it("the input graph is never mutated", () => {
    const idents = [node("i1")]; const ms = [mem("i1", "g1")]; const g = graph({ identities: idents, groups: [node("g1")], applications: [node("a1")], memberships: ms, groupAssignments: [ga("g1", "a1")] });
    const snapshot = JSON.stringify(g);
    evaluateGovernance(g, { includeStale: true, identityBroadAccessThreshold: 0 });
    expect(JSON.stringify(g)).toBe(snapshot);
  });

  it("no finding carries free-text provenance (sourceEndpoint / lastDiscoveryRunId) or PII", () => {
    const g = graph({ identities: [node("i1")], groups: [node("g1")], applications: [node("a1")],
      userAssignments: [{ ...ua("i1", "a1"), sourceEndpoint: "https://secret-host/app_users", lastDiscoveryRunId: "run-SECRET" } as UserAssignmentEdge],
      memberships: [mem("i1", "g1")], groupAssignments: [ga("g1", "a1")] });
    const blob = JSON.stringify(evaluateGovernance(g).findings);
    expect(blob).not.toContain("secret-host");
    expect(blob).not.toContain("run-SECRET");
    expect(blob).not.toContain("sourceEndpoint");
  });

  it("the source modules import no DB/network and use no Date.now/console/env", () => {
    const dir = join(__dirname);
    // strip comments first — the module doc-comments legitimately MENTION "Date.now"/"log" as things the code avoids.
    const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
    for (const file of ["types.ts", "finding-id.ts", "evaluate.ts"]) {
      const src = strip(readFileSync(join(dir, file), "utf8"));
      expect(src, `${file} must import no DB/network`).not.toMatch(/from ["'](pg|@supabase\/|node:fs|fs|node:net|node:http|node:https|undici)/);
      expect(src, `${file} must use no Date.now/console/env/fetch`).not.toMatch(/\bDate\.now\b|\bconsole\.|\bprocess\.env\b|\bfetch\(/);
    }
  });

  it("scales: 1000 identities, 1000 groups, 10000 memberships, 10000 assignments (linear, terminates)", () => {
    const identities: CanonicalNode[] = [], groups: CanonicalNode[] = [], applications: CanonicalNode[] = [];
    const memberships: MembershipEdge[] = [], userAssignments: UserAssignmentEdge[] = [], groupAssignments: GroupAssignmentEdge[] = [];
    for (let i = 0; i < 1000; i++) { identities.push(node(`i${i}`)); groups.push(node(`g${i}`)); applications.push(node(`a${i}`)); }
    for (let i = 0; i < 10000; i++) { memberships.push(mem(`i${i % 1000}`, `g${i % 1000}`)); groupAssignments.push(ga(`g${i % 1000}`, `a${i % 1000}`)); userAssignments.push(ua(`i${i % 1000}`, `a${(i + 1) % 1000}`)); }
    const { summary } = evaluateGovernance(graph({ identities, groups, applications, memberships, userAssignments, groupAssignments }));
    expect(summary.identitiesEvaluated).toBe(1000);
    expect(summary.effectiveAccessRelationships).toBeGreaterThan(0);
  });
});
