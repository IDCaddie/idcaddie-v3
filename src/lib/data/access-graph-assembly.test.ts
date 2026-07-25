import { describe, it, expect } from "vitest";
import { assembleGovernanceGraph, type AccessGraphRows } from "./access-graph-assembly";
import { parseRows, identityRowSchema, membershipRowSchema } from "./access-rpc-types";
import { resolveEffectiveAccess } from "@/lib/server/access-graph/resolve";
import { evaluateGovernance } from "@/lib/server/governance-analytics/evaluate";

const T = "7a000000-0000-4000-8000-000000000001";
const CONN = "ca000000-0000-4000-8000-000000000001";
const idn = (id: string, sync: "current" | "stale" = "current") => ({ id, connection_id: CONN, provider: "okta", sync_status: sync, stale_since: null, display_name: null, login: null, email: null, is_active: null, status: null });
const grp = (id: string) => ({ id, connection_id: CONN, provider: "okta", sync_status: "current" as const, stale_since: null, name: null, group_type_category: null });
const app = (id: string) => ({ id, connection_id: CONN, provider: "okta", sync_status: "current" as const, stale_since: null, label: null, name: null, status_category: null, sign_on_category: null, catalog_match_status: null });
const mem = (i: string, g: string) => ({ id: `m-${i}-${g}`, connection_id: CONN, provider: "okta", directory_group_id: g, identity_account_id: i, sync_status: "current" as const, stale_since: null });
const ua = (i: string, a: string) => ({ id: `ua-${i}-${a}`, connection_id: CONN, provider: "okta", directory_application_id: a, identity_account_id: i, sync_status: "current" as const, stale_since: null });
const ga = (g: string, a: string) => ({ id: `ga-${g}-${a}`, connection_id: CONN, provider: "okta", directory_application_id: a, directory_group_id: g, sync_status: "current" as const, stale_since: null });

describe("access-graph-assembly — injects the verified tenant + produces valid Phase-13/14 input", () => {
  it("injects the verified tenantId into EVERY node + edge scope (RPCs omit tenant_id)", () => {
    const rows: AccessGraphRows = { identities: [idn("i1")], groups: [grp("g1")], applications: [app("a1")], memberships: [mem("i1", "g1")], userAssignments: [ua("i1", "a1")], groupAssignments: [ga("g1", "a1")] };
    const graph = assembleGovernanceGraph(T, rows);
    for (const n of [...graph.identities, ...graph.groups, ...graph.applications]) expect(n.tenantId).toBe(T);
    for (const e of [...graph.memberships, ...graph.userAssignments, ...graph.groupAssignments]) expect(e.tenantId).toBe(T);
    expect(graph.memberships[0]).toMatchObject({ identityAccountId: "i1", directoryGroupId: "g1", connectionId: CONN, provider: "okta" });
    expect(graph.userAssignments[0]).toMatchObject({ identityAccountId: "i1", directoryApplicationId: "a1" });
    expect(graph.groupAssignments[0]).toMatchObject({ directoryGroupId: "g1", directoryApplicationId: "a1" });
  });

  it("the assembled graph resolves the same effective access as a hand-built graph (BOTH via direct + group)", () => {
    const rows: AccessGraphRows = { identities: [idn("i1")], groups: [grp("g1")], applications: [app("a1")], memberships: [mem("i1", "g1")], userAssignments: [ua("i1", "a1")], groupAssignments: [ga("g1", "a1")] };
    const graph = assembleGovernanceGraph(T, rows);
    const r = resolveEffectiveAccess(graph, "i1");
    expect(r.effective).toHaveLength(1);
    expect(r.effective[0]).toMatchObject({ applicationId: "a1", classification: "BOTH", direct: true });
    // and governance produces the redundant_direct_access finding
    const ev = evaluateGovernance(graph, {}, { detectedAt: "2026-07-25T00:00:00Z" });
    expect(ev.findings.some((f) => f.ruleId === "redundant_direct_access" && f.subjectId === "i1")).toBe(true);
  });

  it("stale edges are carried (with staleSince) so the includeStale policy works downstream", () => {
    const rows: AccessGraphRows = { identities: [idn("i1", "stale")], groups: [], applications: [app("a1")], memberships: [], userAssignments: [{ ...ua("i1", "a1"), sync_status: "stale", stale_since: "2026-01-01T00:00:00Z" }], groupAssignments: [] };
    const graph = assembleGovernanceGraph(T, rows);
    expect(graph.userAssignments[0].syncStatus).toBe("stale");
    expect(graph.userAssignments[0].staleSince).toBe("2026-01-01T00:00:00Z");
    expect(resolveEffectiveAccess(graph, "i1", { includeStale: false }).effective).toHaveLength(0); // excluded current-only
    expect(resolveEffectiveAccess(graph, "i1", { includeStale: true }).effective).toHaveLength(1);
  });
});

describe("access-rpc-types — runtime validation drops malformed + strips prohibited keys", () => {
  it("drops a row with a malformed sync_status and keeps valid rows", () => {
    const rows = [idn("i1"), { ...idn("i2"), sync_status: "bogus" }, idn("i3")];
    expect(parseRows(identityRowSchema, rows).map((r) => r.id)).toEqual(["i1", "i3"]);
  });

  it("strips a prohibited key (external_id / raw_payload) — it can never reach the graph or UI", () => {
    const parsed = parseRows(identityRowSchema, [{ ...idn("i1"), external_id: "00uSECRET", raw_payload: { token: "x" } }]);
    expect(parsed).toHaveLength(1);
    expect(JSON.stringify(parsed[0])).not.toContain("00uSECRET");
    expect(parsed[0] as Record<string, unknown>).not.toHaveProperty("external_id");
    expect(parsed[0] as Record<string, unknown>).not.toHaveProperty("raw_payload");
  });

  it("drops an edge row missing a required ref id", () => {
    const rows = [mem("i1", "g1"), { id: "x", connection_id: CONN, provider: "okta", sync_status: "current", stale_since: null }];
    expect(parseRows(membershipRowSchema, rows)).toHaveLength(1);
  });
});
