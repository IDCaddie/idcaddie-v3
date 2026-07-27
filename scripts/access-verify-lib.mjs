// Pure decision helpers for verify-staging-access-surface.mjs — NO I/O, NO network, unit-tested directly. Kept separate so the classification
// + anon-deny logic is importable/testable without executing the script's live guards.

// Structural DIRECT/GROUP/BOTH from the migration-0061 identity subgraph. The RPC scopes `groupAssignments` to the identity's OWN groups
// (`directory_group_id = any(v_group_ids)`), so `groupAssignments.length` IS the inherited-application-path count — a bare group membership
// with NO group→app assignment adds no path. This mirrors Phase-13 semantics (a direct edge and/or an inherited membership→assignment path)
// at the RPC level; it never treats an unrelated membership row as an inherited application path.
export function classifyIdentitySubgraph(sub) {
  const directCount = Array.isArray(sub?.userAssignments) ? sub.userAssignments.length : 0;
  const inheritedPathCount = Array.isArray(sub?.groupAssignments) ? sub.groupAssignments.length : 0;
  const classification = directCount > 0
    ? (inheritedPathCount > 0 ? "BOTH" : "DIRECT")
    : (inheritedPathCount > 0 ? "GROUP" : "NONE");
  return { classification, directCount, inheritedPathCount };
}

// Anonymous is denied EXECUTE on the 0061 RPCs (migration 0061: `revoke execute … from public, anon, authenticated`), so its LEGITIMATE
// denial is a permission-denied — SQLSTATE 42501 (Postgres insufficient_privilege / "permission denied for function") — NOT a clean null.
// Accept ONLY: (a) null data with no error, or (b) null data with the exact allowlisted code. Anything else — returned data, function-not-
// found (42883), schema-cache miss (PGRST202), malformed request, server failure, timeout, or any other code — is NOT a recognized deny.
// The reason carries ONLY the short SQLSTATE/PostgREST code (never the error message/details/hint, which may contain sensitive text).
export const ANON_DENY_CODES = ["42501"];
export function recognizedAnonDeny(data, error) {
  if (data != null) return { ok: false, reason: "ALLOWED (LEAK)" };
  if (error == null) return { ok: true, reason: "denied (null, no error)" };
  const code = typeof error?.code === "string" ? error.code : "";
  if (ANON_DENY_CODES.includes(code)) return { ok: true, reason: `denied (permission-denied ${code})` };
  return { ok: false, reason: `unexpected RPC error (code ${code || "unknown"}) — not a recognized anon denial` };
}
