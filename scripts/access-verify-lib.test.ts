import { describe, it, expect } from "vitest";
import { classifyIdentitySubgraph, recognizedAnonDeny, ANON_DENY_CODES } from "./access-verify-lib.mjs";

// A subgraph row's contents are irrelevant to the count-based classification — only array lengths matter.
const sub = (direct: number, memberships: number, groupAssignments: number) => ({
  userAssignments: Array.from({ length: direct }, (_, i) => ({ directory_application_id: `a${i}` })),
  memberships: Array.from({ length: memberships }, (_, i) => ({ directory_group_id: `g${i}` })),
  groupAssignments: Array.from({ length: groupAssignments }, (_, i) => ({ directory_group_id: `g${i}`, directory_application_id: `a${i}` })),
});

describe("classifyIdentitySubgraph — inherited path = group→app assignment (scoped to the identity's groups), NOT bare membership", () => {
  it("direct assignment + UNRELATED group membership + 0 group→app assignments → DIRECT-only (the O5 fixture)", () => {
    expect(classifyIdentitySubgraph(sub(1, 1, 0))).toEqual({ classification: "DIRECT", directCount: 1, inheritedPathCount: 0 });
  });
  it("an actual group-derived path (0 direct, ≥1 group→app assignment) → GROUP", () => {
    expect(classifyIdentitySubgraph(sub(0, 1, 1))).toEqual({ classification: "GROUP", directCount: 0, inheritedPathCount: 1 });
  });
  it("a direct assignment + an actual inherited path → BOTH", () => {
    expect(classifyIdentitySubgraph(sub(1, 1, 1))).toEqual({ classification: "BOTH", directCount: 1, inheritedPathCount: 1 });
  });
  it("no access → NONE; many memberships but no group→app assignment stays DIRECT/NONE (membership is inert)", () => {
    expect(classifyIdentitySubgraph(sub(0, 5, 0))).toEqual({ classification: "NONE", directCount: 0, inheritedPathCount: 0 });
    expect(classifyIdentitySubgraph(sub(2, 5, 0)).classification).toBe("DIRECT");
  });
  it("null / malformed subgraph → NONE (0/0), never throws", () => {
    expect(classifyIdentitySubgraph(null)).toEqual({ classification: "NONE", directCount: 0, inheritedPathCount: 0 });
    expect(classifyIdentitySubgraph({})).toEqual({ classification: "NONE", directCount: 0, inheritedPathCount: 0 });
  });
});

describe("recognizedAnonDeny — anon lacks EXECUTE (0061), so permission-denied 42501 is an allowlisted denial; other errors/data are not", () => {
  it("allowlists exactly SQLSTATE 42501", () => {
    expect(ANON_DENY_CODES).toEqual(["42501"]);
  });
  it("a clean null (no error) is a deny", () => {
    expect(recognizedAnonDeny(null, null).ok).toBe(true);
  });
  it("null + permission-denied 42501 is a deny (the expected anon authorization boundary)", () => {
    const r = recognizedAnonDeny(null, { code: "42501", message: "permission denied for function product_directory_access_counts" });
    expect(r.ok).toBe(true);
    expect(r.reason).not.toContain("permission denied for function"); // reason carries the CODE only, never the message
    expect(r.reason).toContain("42501");
  });
  it("returned data is NEVER a deny (a leak), even alongside a 42501 error", () => {
    expect(recognizedAnonDeny({ identities: 1 }, null).ok).toBe(false);
    expect(recognizedAnonDeny({ identities: 1 }, { code: "42501" }).ok).toBe(false);
  });
  it("an arbitrary / unexpected RPC error is NOT a deny (function-not-found, schema-cache, malformed, server, timeout, no-code)", () => {
    for (const err of [{ code: "42883" }, { code: "PGRST202" }, { code: "PGRST301" }, { code: "500" }, { message: "permission denied" }, {}]) {
      expect(recognizedAnonDeny(null, err).ok).toBe(false);
    }
  });
});
