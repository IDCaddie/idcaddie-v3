import { describe, it, expect } from "vitest";
import { resolveEffectiveAccess, resolveAllEffectiveAccess, buildAccessIndex, MAX_GROUP_DEPTH } from "./resolve";
import type { AccessGraph, Scope, IdentityNode, MembershipEdge, UserAssignmentEdge, GroupAssignmentEdge } from "./types";

// scopes: A is the primary; B/A2/AP differ by tenant / connection / provider respectively (isolation targets).
const A: Scope = { tenantId: "tA", connectionId: "cA", provider: "okta" };
const B: Scope = { tenantId: "tB", connectionId: "cA", provider: "okta" };   // different tenant
const A2: Scope = { tenantId: "tA", connectionId: "cB", provider: "okta" };  // different connection
const AP: Scope = { tenantId: "tA", connectionId: "cA", provider: "entra" }; // different provider
const cur = { syncStatus: "current" as const };

const idn = (id: string, s: Scope = A): IdentityNode => ({ id, ...s });
const mem = (identityAccountId: string, directoryGroupId: string, s: Scope = A, extra: Partial<MembershipEdge> = {}): MembershipEdge => ({ ...s, ...cur, identityAccountId, directoryGroupId, ...extra });
const ua = (identityAccountId: string, directoryApplicationId: string, s: Scope = A, extra: Partial<UserAssignmentEdge> = {}): UserAssignmentEdge => ({ ...s, ...cur, identityAccountId, directoryApplicationId, ...extra });
const ga = (directoryGroupId: string, directoryApplicationId: string, s: Scope = A, extra: Partial<GroupAssignmentEdge> = {}): GroupAssignmentEdge => ({ ...s, ...cur, directoryGroupId, directoryApplicationId, ...extra });
const graph = (o: Partial<AccessGraph>): AccessGraph => ({ identities: o.identities ?? [], memberships: o.memberships ?? [], userAssignments: o.userAssignments ?? [], groupAssignments: o.groupAssignments ?? [] });
const appIds = (list: { applicationId: string }[]) => list.map((a) => a.applicationId).sort();

describe("resolveEffectiveAccess — classification + provenance", () => {
  it("DIRECT only: identity->app, classified DIRECT, no group paths", () => {
    const r = resolveEffectiveAccess(graph({ identities: [idn("i1")], userAssignments: [ua("i1", "a1")] }), "i1");
    expect(appIds(r.effective)).toEqual(["a1"]);
    expect(r.effective[0]).toMatchObject({ applicationId: "a1", classification: "DIRECT", direct: true, groupPaths: [] });
    expect(appIds(r.direct)).toEqual(["a1"]);
    expect(r.group).toEqual([]);
    expect(r).toMatchObject({ directCount: 1, groupCount: 0, effectiveCount: 1, bothCount: 0, duplicatePathsEliminated: 0 });
  });

  it("GROUP only: identity->group->app, classified GROUP with the full reasoning path", () => {
    const r = resolveEffectiveAccess(graph({ identities: [idn("i1")], memberships: [mem("i1", "g1")], groupAssignments: [ga("g1", "a1")] }), "i1");
    expect(r.effective[0]).toMatchObject({ applicationId: "a1", classification: "GROUP", direct: false, directProvenance: null });
    expect(r.effective[0].groupPaths).toHaveLength(1);
    expect(r.effective[0].groupPaths[0]).toMatchObject({ groupId: "g1", membership: { syncStatus: "current" }, assignment: { syncStatus: "current" } });
    expect(r.group.map((a) => a.applicationId)).toEqual(["a1"]);
    expect(r.direct).toEqual([]);
    expect(r).toMatchObject({ directCount: 0, groupCount: 1, bothCount: 0, duplicatePathsEliminated: 0 });
  });

  it("BOTH: an app reachable by direct AND group appears ONCE, classified BOTH, keeps both paths", () => {
    const r = resolveEffectiveAccess(graph({ identities: [idn("i1")], userAssignments: [ua("i1", "a1")], memberships: [mem("i1", "g1")], groupAssignments: [ga("g1", "a1")] }), "i1");
    expect(r.effective).toHaveLength(1); // deduped to ONE
    expect(r.effective[0]).toMatchObject({ applicationId: "a1", classification: "BOTH", direct: true });
    expect(r.effective[0].directProvenance).toMatchObject({ syncStatus: "current" });
    expect(r.effective[0].groupPaths.map((p) => p.groupId)).toEqual(["g1"]);
    expect(appIds(r.direct)).toEqual(["a1"]); expect(appIds(r.group)).toEqual(["a1"]); // in BOTH lists
    expect(r).toMatchObject({ effectiveCount: 1, bothCount: 1, duplicatePathsEliminated: 1 });
  });

  it("multiple groups granting the SAME app: one app entry, all group paths, sorted, deduped", () => {
    const r = resolveEffectiveAccess(graph({ identities: [idn("i1")], memberships: [mem("i1", "g2"), mem("i1", "g1")], groupAssignments: [ga("g1", "a1"), ga("g2", "a1")] }), "i1");
    expect(r.effective).toHaveLength(1);
    expect(r.effective[0].classification).toBe("GROUP");
    expect(r.effective[0].groupPaths.map((p) => p.groupId)).toEqual(["g1", "g2"]); // sorted by groupId
    expect(r).toMatchObject({ effectiveCount: 1, bothCount: 0, duplicatePathsEliminated: 1 }); // 2 paths -> 1 app
  });

  it("duplicate paths: direct + two groups to the same app -> BOTH, 3 paths collapsed to 1", () => {
    const r = resolveEffectiveAccess(graph({ identities: [idn("i1")], userAssignments: [ua("i1", "a1")], memberships: [mem("i1", "g1"), mem("i1", "g2")], groupAssignments: [ga("g1", "a1"), ga("g2", "a1")] }), "i1");
    expect(r.effective).toHaveLength(1);
    expect(r.effective[0]).toMatchObject({ classification: "BOTH", direct: true });
    expect(r.effective[0].groupPaths).toHaveLength(2);
    expect(r).toMatchObject({ effectiveCount: 1, bothCount: 1, duplicatePathsEliminated: 2 }); // 1 direct + 2 group = 3 -> 1
  });

  it("missing group: a membership to a group with ZERO assignments contributes nothing (not an error)", () => {
    const r = resolveEffectiveAccess(graph({ identities: [idn("i1")], memberships: [mem("i1", "gEmpty")], groupAssignments: [ga("gOther", "a9")] }), "i1");
    expect(r.effective).toEqual([]);
    expect(r).toMatchObject({ effectiveCount: 0, groupCount: 0, directCount: 0 });
  });

  it("never infers absent edges: only apps that appear on an actual edge are reported", () => {
    const r = resolveEffectiveAccess(graph({ identities: [idn("i1")], memberships: [mem("i1", "g1")], groupAssignments: [ga("g1", "a1")], userAssignments: [ua("i1", "a2")] }), "i1");
    expect(appIds(r.effective)).toEqual(["a1", "a2"]); // exactly the two reached; a3.. never invented
  });
});

describe("resolveEffectiveAccess — isolation (tenant / connection / provider)", () => {
  it("cross-TENANT edges never contribute to an identity's access", () => {
    const r = resolveEffectiveAccess(graph({
      identities: [idn("i1", A)],
      userAssignments: [ua("i1", "a1", B)],                              // same identity id, WRONG tenant
      memberships: [mem("i1", "g1", B)], groupAssignments: [ga("g1", "a2", B)],
    }), "i1");
    expect(r.effective).toEqual([]); // scope A identity gets nothing from scope B edges
  });

  it("cross-CONNECTION edges never contribute", () => {
    const r = resolveEffectiveAccess(graph({
      identities: [idn("i1", A)],
      userAssignments: [ua("i1", "a1", A2)],
      memberships: [mem("i1", "g1", A2)], groupAssignments: [ga("g1", "a2", A2)],
    }), "i1");
    expect(r.effective).toEqual([]);
  });

  it("wrong-PROVIDER edges never contribute", () => {
    const r = resolveEffectiveAccess(graph({
      identities: [idn("i1", A)],
      userAssignments: [ua("i1", "a1", AP)],
      memberships: [mem("i1", "g1", AP)], groupAssignments: [ga("g1", "a2", AP)],
    }), "i1");
    expect(r.effective).toEqual([]);
  });

  it("a group-assignment in a DIFFERENT scope than the membership's group does not leak the app", () => {
    // i1 (A) is in g1 (A); but g1's ONLY app-assignment is recorded under scope B -> not reachable within A.
    const r = resolveEffectiveAccess(graph({ identities: [idn("i1", A)], memberships: [mem("i1", "g1", A)], groupAssignments: [ga("g1", "a1", B)] }), "i1");
    expect(r.effective).toEqual([]);
  });

  it("same identity/app row ids in TWO scopes resolve independently (no bleed)", () => {
    const g = graph({
      identities: [idn("i1", A), idn("i1", B)], // NOTE: distinct rows would have distinct ids in reality; this stresses the scope guard
      userAssignments: [ua("i1", "aA", A), ua("i1", "aB", B)],
    });
    // first identity node (scope A) wins the id->scope mapping; only scope-A edges resolve.
    const r = resolveEffectiveAccess(g, "i1");
    expect(appIds(r.effective)).toEqual(["aA"]);
    expect(r.scope).toEqual(A);
  });
});

describe("resolveEffectiveAccess — cycle / bounded-depth safety", () => {
  it("MAX_GROUP_DEPTH documents the 2-level DAG (no group->group edge exists)", () => {
    expect(MAX_GROUP_DEPTH).toBe(1);
  });

  it("densely cross-linked groups terminate with correct dedup (no cycle possible)", () => {
    // i1 in g1,g2,g3; g1,g2 -> a1 ; g2,g3 -> a2 ; plus DIRECT a1. Must terminate; a1 BOTH, a2 GROUP.
    const r = resolveEffectiveAccess(graph({
      identities: [idn("i1")], userAssignments: [ua("i1", "a1")],
      memberships: [mem("i1", "g1"), mem("i1", "g2"), mem("i1", "g3")],
      groupAssignments: [ga("g1", "a1"), ga("g2", "a1"), ga("g2", "a2"), ga("g3", "a2")],
    }), "i1");
    expect(appIds(r.effective)).toEqual(["a1", "a2"]);
    const a1 = r.effective.find((a) => a.applicationId === "a1")!;
    const a2 = r.effective.find((a) => a.applicationId === "a2")!;
    expect(a1).toMatchObject({ classification: "BOTH", direct: true });
    expect(a1.groupPaths.map((p) => p.groupId)).toEqual(["g1", "g2"]);
    expect(a2).toMatchObject({ classification: "GROUP", direct: false });
    expect(a2.groupPaths.map((p) => p.groupId)).toEqual(["g2", "g3"]);
  });

  it("a repeated membership row is deduped (the group is expanded once)", () => {
    const r = resolveEffectiveAccess(graph({ identities: [idn("i1")], memberships: [mem("i1", "g1"), mem("i1", "g1")], groupAssignments: [ga("g1", "a1")] }), "i1");
    expect(r.effective[0].groupPaths.map((p) => p.groupId)).toEqual(["g1"]); // once, not twice
    expect(r.duplicatePathsEliminated).toBe(0);
  });
});

describe("resolveEffectiveAccess — sync policy + provenance", () => {
  it("stale edges are INCLUDED by default (a stale edge still asserts a relationship)", () => {
    const r = resolveEffectiveAccess(graph({ identities: [idn("i1")], userAssignments: [ua("i1", "a1", A, { syncStatus: "stale" })] }), "i1");
    expect(appIds(r.effective)).toEqual(["a1"]);
    expect(r.effective[0].directProvenance).toMatchObject({ syncStatus: "stale" });
  });

  it("includeStale:false excludes non-current edges (direct + group + assignment)", () => {
    const g = graph({
      identities: [idn("i1")],
      userAssignments: [ua("i1", "aDirectStale", A, { syncStatus: "stale" }), ua("i1", "aDirectCur")],
      memberships: [mem("i1", "gStale", A, { syncStatus: "disconnected" }), mem("i1", "gCur")],
      groupAssignments: [ga("gStale", "aX"), ga("gCur", "aGroupCur"), ga("gCur", "aGroupStale", A, { syncStatus: "stale" })],
    });
    const r = resolveEffectiveAccess(g, "i1", { includeStale: false });
    expect(appIds(r.effective)).toEqual(["aDirectCur", "aGroupCur"]); // stale direct, disconnected membership, stale assignment all dropped
  });

  it("provenance carries lastDiscoveryRunId + freshness on both edges of a group path", () => {
    const r = resolveEffectiveAccess(graph({
      identities: [idn("i1")],
      memberships: [mem("i1", "g1", A, { lastDiscoveryRunId: "run-m", firstSeenAt: "2026-01-01T00:00:00Z" })],
      groupAssignments: [ga("g1", "a1", A, { lastDiscoveryRunId: "run-a", sourceEndpoint: "app_groups" })],
    }), "i1");
    const p = r.effective[0].groupPaths[0];
    expect(p.membership).toMatchObject({ lastDiscoveryRunId: "run-m", firstSeenAt: "2026-01-01T00:00:00Z" });
    expect(p.assignment).toMatchObject({ lastDiscoveryRunId: "run-a", sourceEndpoint: "app_groups" });
  });
});

describe("resolveAllEffectiveAccess — whole tenant", () => {
  it("resolves every identity once, sorted, index built once", () => {
    const g = graph({
      identities: [idn("i2"), idn("i1"), idn("i1")], // duplicate id -> one result
      userAssignments: [ua("i1", "a1")],
      memberships: [mem("i2", "g1")], groupAssignments: [ga("g1", "a2")],
    });
    const all = resolveAllEffectiveAccess(g);
    expect(all.map((r) => r.identityId)).toEqual(["i1", "i2"]); // sorted + deduped
    expect(appIds(all[0].effective)).toEqual(["a1"]);
    expect(all[1].effective[0]).toMatchObject({ applicationId: "a2", classification: "GROUP" });
  });

  it("isolates identities in different scopes within the same call", () => {
    const g = graph({
      identities: [idn("iA", A), idn("iB", B)],
      userAssignments: [ua("iA", "aA", A), ua("iB", "aB", B), ua("iA", "aLeak", B)],
    });
    const all = resolveAllEffectiveAccess(g);
    const rA = all.find((r) => r.identityId === "iA")!; const rB = all.find((r) => r.identityId === "iB")!;
    expect(appIds(rA.effective)).toEqual(["aA"]); // NOT aLeak (scope B)
    expect(appIds(rB.effective)).toEqual(["aB"]);
  });
});

describe("resolveEffectiveAccess — errors + scale", () => {
  it("throws on an unknown identity (scope unknown)", () => {
    expect(() => resolveEffectiveAccess(graph({ identities: [idn("i1")] }), "ghost")).toThrow(/not present/);
  });

  it("1000 memberships x 1000 group-assignments: linear, correct, terminates (no exponential blowup)", () => {
    const N = 1000;
    const memberships: MembershipEdge[] = [];
    const groupAssignments: GroupAssignmentEdge[] = [];
    for (let i = 0; i < N; i++) { memberships.push(mem("i1", `g${i}`)); groupAssignments.push(ga(`g${i}`, `a${i}`)); } // 1:1 group:app
    const r = resolveEffectiveAccess(graph({ identities: [idn("i1")], memberships, groupAssignments }), "i1");
    expect(r.effectiveCount).toBe(N);
    expect(r.groupCount).toBe(N);
    expect(r.bothCount).toBe(0);
    expect(r.duplicatePathsEliminated).toBe(0); // 1:1, no collapse
  });

  it("dense fan-out (200 groups all granting the same 50 apps): output-sensitive, not exponential", () => {
    const G = 200, APPS = 50;
    const memberships: MembershipEdge[] = [];
    const groupAssignments: GroupAssignmentEdge[] = [];
    for (let g = 0; g < G; g++) { memberships.push(mem("i1", `g${g}`)); for (let a = 0; a < APPS; a++) groupAssignments.push(ga(`g${g}`, `a${a}`)); }
    const r = resolveEffectiveAccess(graph({ identities: [idn("i1")], memberships, groupAssignments }), "i1"); // 200*50 = 10k edges
    expect(r.effectiveCount).toBe(APPS);
    for (const app of r.effective) expect(app.groupPaths).toHaveLength(G); // each app reached via all 200 groups
    expect(r.duplicatePathsEliminated).toBe(APPS * (G - 1)); // 50 apps, 200 paths each -> 199 collapsed each
  });

  it("buildAccessIndex is reusable across identities (whole-tenant efficiency)", () => {
    const idx = buildAccessIndex(graph({ identities: [idn("i1"), idn("i2")], userAssignments: [ua("i1", "a1"), ua("i2", "a2")] }));
    expect(idx.scopeOf.get("i1")).toEqual(A);
    expect(idx.directByIdentity.size).toBe(2);
  });
});
