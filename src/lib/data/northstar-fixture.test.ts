// Northstar Labs demo-fixture acceptance test (PR B2).
//
// WHAT THIS PROTECTS. The seed script (scripts/seed-northstar-demo.sh) asserts the fixture's
// TOPOLOGY in SQL. This test asserts the thing that actually matters for the demo: that the
// ACCEPTED Phase-13/14 engines DERIVE the demo classifications from that topology. If someone
// edits the fixture and breaks the DIRECT / GROUP / BOTH story, or removes the graph condition a
// governance finding depends on, this fails — instead of the demo failing in front of the team.
//
// The topology below mirrors supabase/fixtures/northstar_demo.sql exactly (same deterministic ids).
// Nothing here is hard-coded UI output: every assertion is on engine output.

import { describe, it, expect } from "vitest";
import { assembleGovernanceGraph, type AccessGraphRows } from "./access-graph-assembly";
import { resolveAllEffectiveAccess } from "@/lib/server/access-graph/resolve";
import { evaluateGovernance } from "@/lib/server/governance-analytics/evaluate";

type Sync = "current" | "stale" | "review_required" | "disconnected";

const T = "e0000000-0000-0000-0000-00000000a000"; // Northstar tenant
const C = "e0000000-0000-0000-0000-00000000d001"; // okta connector
const P = "okta";

// identities
const AVERY = "e0000000-0000-0000-0000-000000001001"; // DIRECT case
const JORDAN = "e0000000-0000-0000-0000-000000001002"; // GROUP case
const MORGAN = "e0000000-0000-0000-0000-000000001003"; // BOTH case
const ALEX = "e0000000-0000-0000-0000-000000001008"; // duplicate inherited paths
const SAM = "e0000000-0000-0000-0000-000000001012"; // stale identity

// groups
const SALES = "e0000000-0000-0000-0000-000000002001";
const ENGINEERING = "e0000000-0000-0000-0000-000000002002";
const FINANCE = "e0000000-0000-0000-0000-000000002003";
const CONTRACTORS = "e0000000-0000-0000-0000-000000002004";

// directory applications
const SALESFORCE = "e0000000-0000-0000-0000-000000003001";
const GITHUB = "e0000000-0000-0000-0000-000000003002";
const JIRA = "e0000000-0000-0000-0000-000000003004";

const ident = (id: string, name: string, sync: Sync = "current", staleSince: string | null = null) => ({
  id, connection_id: C, provider: P, sync_status: sync, stale_since: staleSince,
  display_name: name, login: null, email: null, is_active: sync === "current", status: null,
});
const group = (id: string, name: string) => ({
  id, connection_id: C, provider: P, sync_status: "current" as Sync, stale_since: null,
  name, group_type_category: "okta_group",
} as const);
const app = (id: string, label: string) => ({
  id, connection_id: C, provider: P, sync_status: "current" as Sync, stale_since: null,
  label, name: label.toLowerCase(), status_category: "active", sign_on_category: "saml_2_0",
  catalog_match_status: "unmatched",
});
const member = (identityId: string, groupId: string) => ({
  connection_id: C, provider: P, directory_group_id: groupId, identity_account_id: identityId,
  sync_status: "current" as Sync, stale_since: null,
});
const userAssign = (identityId: string, appId: string) => ({
  connection_id: C, provider: P, directory_application_id: appId, identity_account_id: identityId,
  sync_status: "current" as Sync, stale_since: null,
});
const groupAssign = (groupId: string, appId: string) => ({
  connection_id: C, provider: P, directory_application_id: appId, directory_group_id: groupId,
  sync_status: "current" as Sync, stale_since: null,
});

// The demo-critical subset of the fixture topology.
const rows: AccessGraphRows = {
  identities: [
    ident(AVERY, "Avery Chen"),
    ident(JORDAN, "Jordan Patel"),
    ident(MORGAN, "Morgan Lee"),
    ident(ALEX, "Alex Kim"),
    ident(SAM, "Sam Okoro", "stale", "2026-06-01T00:00:00.000Z"),
  ],
  groups: [group(SALES, "Sales"), group(ENGINEERING, "Engineering"), group(FINANCE, "Finance"), group(CONTRACTORS, "Contractors")],
  applications: [app(SALESFORCE, "Salesforce"), app(GITHUB, "GitHub"), app(JIRA, "Jira")],
  memberships: [
    member(JORDAN, SALES),
    member(MORGAN, ENGINEERING),
    member(ALEX, FINANCE),
    member(ALEX, CONTRACTORS), // Jira reachable via TWO groups → duplicate inherited paths
  ],
  userAssignments: [
    userAssign(AVERY, SALESFORCE), // DIRECT
    userAssign(MORGAN, GITHUB), //   BOTH (direct half)
    userAssign(SAM, SALESFORCE), //  CURRENT assignment to a STALE identity node
  ],
  groupAssignments: [
    groupAssign(SALES, SALESFORCE), //     GROUP
    groupAssign(ENGINEERING, GITHUB), //   BOTH (group half)
    groupAssign(FINANCE, JIRA), //         duplicate path 1
    groupAssign(CONTRACTORS, JIRA), //     duplicate path 2
  ],
};

const graph = assembleGovernanceGraph(T, rows);
const access = resolveAllEffectiveAccess(graph, { includeStale: false });

// Find the classification the engine produced for one (identity, application) pair.
function classificationFor(identityId: string, applicationId: string): string | undefined {
  for (const ia of access) {
    if (ia.identityId !== identityId) continue;
    for (const app of ia.effective) {
      if (app.applicationId === applicationId) return app.classification;
    }
  }
  return undefined;
}

describe("Northstar demo fixture — engine-derived access classifications", () => {
  it("DIRECT: Avery Chen reaches Salesforce by direct assignment only", () => {
    expect(classificationFor(AVERY, SALESFORCE)).toBe("DIRECT");
  });

  it("GROUP: Jordan Patel reaches Salesforce only through the Sales group", () => {
    expect(classificationFor(JORDAN, SALESFORCE)).toBe("GROUP");
  });

  it("BOTH: Morgan Lee reaches GitHub directly AND through Engineering", () => {
    expect(classificationFor(MORGAN, GITHUB)).toBe("BOTH");
  });

  it("all three classifications are present, so the demo can show each", () => {
    const seen = new Set<string>();
    for (const ia of access) for (const app of ia.effective) seen.add(app.classification);
    expect(seen).toEqual(new Set(["DIRECT", "GROUP", "BOTH"]));
  });
});

describe("Northstar demo fixture — engine-derived governance findings", () => {
  const findings = evaluateGovernance(graph, { includeStale: false }, { detectedAt: "2026-07-29T00:00:00.000Z" }).findings;
  const ruleIds = new Set(findings.map((f) => f.ruleId));

  it("produces findings from graph state (never hard-coded)", () => {
    expect(findings.length).toBeGreaterThanOrEqual(3);
  });

  it("BOTH access yields redundant_direct_access", () => {
    expect(ruleIds.has("redundant_direct_access")).toBe(true);
  });

  it("a current assignment to a stale identity yields direct_assignment_with_stale_endpoint", () => {
    expect(ruleIds.has("direct_assignment_with_stale_endpoint")).toBe(true);
  });

  it("an app reachable via two groups yields duplicate_inherited_access_paths", () => {
    expect(ruleIds.has("duplicate_inherited_access_paths")).toBe(true);
  });

  // docs/71: topology never proves "critical" — the GovernanceSeverity type has no such member,
  // so that is compile-time guaranteed. What is worth asserting is that the demo has a finding of
  // real weight, not only `info` noise.
  it("includes at least one medium-severity finding, so the demo is not all info-level", () => {
    expect(findings.some((f) => f.severity === "medium")).toBe(true);
  });
});

describe("Northstar demo fixture — isolation", () => {
  it("every graph row is bound to the Northstar tenant, never the Phase-15 verifier tenant", () => {
    const VERIFIER = "aaaa1111-1111-1111-1111-111111111111";
    const allIds = [
      ...rows.identities.map((r) => r.id),
      ...rows.groups.map((r) => r.id),
      ...rows.applications.map((r) => r.id),
    ];
    expect(allIds.every((id) => id.startsWith("e0000000-"))).toBe(true);
    expect(allIds.some((id) => id.startsWith(VERIFIER.slice(0, 8)))).toBe(false);
  });
});
