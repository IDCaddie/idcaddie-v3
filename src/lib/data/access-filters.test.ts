import { describe, it, expect } from "vitest";
import {
  parseAccessFilters, accessQueryString, accessHref, paginate, filterFindings, filterIdentityApplications,
  filterApplicationIdentities, findingsActiveFilters, detailActiveFilters, backLink, returnParams, DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE, RULE_OPTIONS,
  type AccessFilters,
} from "./access-filters";
import type { GovernanceFindingView, IdentityApplicationAccessView } from "./access-view-models";
import type { ApplicationIdentityAccessView } from "./access-loaders";

const EMPTY: AccessFilters = { query: null, provider: null, connectionId: null, includeStale: false, classification: null, severity: null, confidence: null, ruleId: null, subjectType: null, catalogMatch: null, staleEvidence: null, page: 1, pageSize: DEFAULT_PAGE_SIZE };
const UUID = "11111111-2222-4333-8444-555555555555";

describe("parseAccessFilters — strict allowlist parsing", () => {
  it("accepts only allowlisted enum values; rejects invalid ones to null (never widens scope)", () => {
    const f = parseAccessFilters({ severity: "high", confidence: "low", classification: "BOTH", subjectType: "identity", catalogMatch: "unmatched" });
    expect(f).toMatchObject({ severity: "high", confidence: "low", classification: "BOTH", subjectType: "identity", catalogMatch: "unmatched" });
    const bad = parseAccessFilters({ severity: "critical", confidence: "certain", classification: "SOMETHING", subjectType: "root", catalogMatch: "maybe" });
    expect(bad).toMatchObject({ severity: null, confidence: null, classification: null, subjectType: null, catalogMatch: null });
  });
  it("validates rule id against the allowlist and connection/provider by shape", () => {
    expect(parseAccessFilters({ rule: "redundant_direct_access" }).ruleId).toBe("redundant_direct_access");
    expect(parseAccessFilters({ rule: "made_up_rule" }).ruleId).toBeNull();
    expect(parseAccessFilters({ connection: UUID }).connectionId).toBe(UUID);
    expect(parseAccessFilters({ connection: "not-a-uuid" }).connectionId).toBeNull();
    expect(parseAccessFilters({ provider: "okta" }).provider).toBe("okta");
    expect(parseAccessFilters({ provider: "DROP TABLE" }).provider).toBeNull();
  });
  it("normalizes the query (NFKC, lowercase, collapsed whitespace, bounded) and treats blank as null", () => {
    expect(parseAccessFilters({ q: "  Foo   Bar  " }).query).toBe("foo bar");
    expect(parseAccessFilters({ q: "   " }).query).toBeNull();
    expect(parseAccessFilters({ q: "A".repeat(500) }).query?.length).toBe(200);
    expect(parseAccessFilters({ q: "ＡＢＣ" }).query).toBe("abc"); // fullwidth -> NFKC ascii
  });
  it("parses stale mode + tri-state staleEvidence + clamps page/pageSize", () => {
    expect(parseAccessFilters({ stale: "1" }).includeStale).toBe(true);
    expect(parseAccessFilters({ staleEvidence: "1" }).staleEvidence).toBe(true);
    expect(parseAccessFilters({ staleEvidence: "0" }).staleEvidence).toBe(false);
    expect(parseAccessFilters({ staleEvidence: "yes" }).staleEvidence).toBeNull();
    expect(parseAccessFilters({ pageSize: "9999" }).pageSize).toBe(MAX_PAGE_SIZE);
    expect(parseAccessFilters({ pageSize: "0" }).pageSize).toBe(1);
    expect(parseAccessFilters({ pageSize: "abc" }).pageSize).toBe(DEFAULT_PAGE_SIZE);
    expect(parseAccessFilters({ page: "-5" }).page).toBe(1);
  });
  it("takes the first value for a repeated param and ignores unknown params (no scope widening)", () => {
    expect(parseAccessFilters({ severity: ["high", "low"] }).severity).toBe("high");
    expect(parseAccessFilters({ evil: "1", "'; DROP": "x" })).toEqual(EMPTY);
  });
});

describe("accessQueryString / accessHref — canonical, default-omitting", () => {
  it("omits defaults + nulls; identical filters produce identical URLs", () => {
    expect(accessQueryString(EMPTY)).toBe("");
    const f = parseAccessFilters({ q: "ada", severity: "high", page: "2", pageSize: "50" });
    expect(accessQueryString(f)).toBe("q=ada&severity=high&page=2"); // pageSize=50 (default) omitted
  });
  it("changing a filter resets the page to 1; changing only page preserves filters", () => {
    const f = { ...EMPTY, severity: "high" as const, page: 4 };
    expect(accessHref("/access/findings", f, { confidence: "low" })).toBe("/access/findings?severity=high&confidence=low");
    expect(accessHref("/access/findings", f, { page: 5 })).toBe("/access/findings?severity=high&page=5");
  });
});

describe("paginate — deterministic offset over bounded lists", () => {
  const all = Array.from({ length: 23 }, (_, i) => i);
  it("slices correctly, clamps page into range, reports range + nav flags", () => {
    const p1 = paginate(all, 1, 10);
    expect(p1.rows).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(p1).toMatchObject({ page: 1, totalPages: 3, hasPrev: false, hasNext: true, startIndex: 1, endIndex: 10, total: 23 });
    const p3 = paginate(all, 3, 10);
    expect(p3.rows).toEqual([20, 21, 22]);
    expect(p3).toMatchObject({ page: 3, hasNext: false, startIndex: 21, endIndex: 23 });
    expect(paginate(all, 99, 10).page).toBe(3); // clamped
    const empty = paginate([], 1, 10);
    expect(empty).toMatchObject({ total: 0, totalPages: 1, startIndex: 0, endIndex: 0, hasNext: false });
  });
  it("never drops or duplicates a row across pages", () => {
    const size = 7; const seen: number[] = [];
    for (let pg = 1; pg <= paginate(all, 1, size).totalPages; pg++) seen.push(...paginate(all, pg, size).rows);
    expect(seen).toEqual(all);
  });
});

describe("filterFindings", () => {
  const f = (over: Partial<GovernanceFindingView>): GovernanceFindingView => ({ id: "x", ruleId: "redundant_direct_access", subjectType: "identity", severity: "medium", severityLabel: "Medium", severityTone: "attention", confidence: "high", confidenceLabel: "High confidence", title: "Overlap", summary: "direct and group", guidance: null, subject: { kind: "identity", label: "Ada Lovelace", href: "/x" }, evidenceRows: [], staleEvidence: false, ...over });
  const list = [f({ id: "a", severity: "high", subjectType: "identity" }), f({ id: "b", severity: "low", subjectType: "application", title: "Zeta" }), f({ id: "c", staleEvidence: true, ruleId: "stale_only_effective_access" })];
  it("filters by each dimension and by search over title/summary/subject label", () => {
    expect(filterFindings(list, { ...EMPTY, severity: "high" }).map((x) => x.id)).toEqual(["a"]);
    expect(filterFindings(list, { ...EMPTY, subjectType: "application" }).map((x) => x.id)).toEqual(["b"]);
    expect(filterFindings(list, { ...EMPTY, staleEvidence: true }).map((x) => x.id)).toEqual(["c"]);
    expect(filterFindings(list, { ...EMPTY, ruleId: "stale_only_effective_access" }).map((x) => x.id)).toEqual(["c"]);
    expect(filterFindings(list, { ...EMPTY, query: "ada" }).length).toBe(3);   // subject label match
    expect(filterFindings(list, { ...EMPTY, query: "zeta" }).map((x) => x.id)).toEqual(["b"]); // title match
  });
});

describe("filter + sort detail lists (deterministic label,id tiebreak)", () => {
  const app = (over: Partial<IdentityApplicationAccessView>): IdentityApplicationAccessView => ({ applicationId: "a", applicationLabel: "App", classification: "DIRECT", classificationLabel: "Direct", explanation: "", groupPaths: [], staleEvidence: false, ...over });
  it("filters identity applications by classification/query and sorts by label then id", () => {
    const apps = [app({ applicationId: "z", applicationLabel: "Beta", classification: "GROUP" }), app({ applicationId: "a", applicationLabel: "Alpha" }), app({ applicationId: "b", applicationLabel: "Alpha" })];
    expect(filterIdentityApplications(apps, EMPTY).map((a) => a.applicationId)).toEqual(["a", "b", "z"]); // Alpha(a),Alpha(b),Beta
    expect(filterIdentityApplications(apps, { ...EMPTY, classification: "GROUP" }).map((a) => a.applicationId)).toEqual(["z"]);
    expect(filterIdentityApplications(apps, { ...EMPTY, query: "beta" }).map((a) => a.applicationId)).toEqual(["z"]);
  });
  it("filters application identities by classification/query/staleEvidence and sorts by label then id", () => {
    const ids: ApplicationIdentityAccessView[] = [
      { identityId: "z", identityLabel: "Zoe", classification: "DIRECT", classificationLabel: "Direct", staleEvidence: false },
      { identityId: "a", identityLabel: "Ada", classification: "GROUP", classificationLabel: "Through group", staleEvidence: true },
    ];
    expect(filterApplicationIdentities(ids, EMPTY).map((i) => i.identityId)).toEqual(["a", "z"]);
    expect(filterApplicationIdentities(ids, { ...EMPTY, classification: "DIRECT" }).map((i) => i.identityId)).toEqual(["z"]);
    expect(filterApplicationIdentities(ids, { ...EMPTY, query: "ada" }).map((i) => i.identityId)).toEqual(["a"]);
    expect(filterApplicationIdentities(ids, { ...EMPTY, staleEvidence: true }).map((i) => i.identityId)).toEqual(["a"]);
    expect(filterApplicationIdentities(ids, { ...EMPTY, staleEvidence: false }).map((i) => i.identityId)).toEqual(["z"]);
  });
});

describe("per-surface active-filter counts (only fields the surface applies; deferred provider/connection/catalogMatch never counted)", () => {
  it("findingsActiveFilters counts findings filters only", () => {
    expect(findingsActiveFilters(EMPTY)).toBe(0);
    expect(findingsActiveFilters({ ...EMPTY, includeStale: true, page: 3 })).toBe(0);
    expect(findingsActiveFilters({ ...EMPTY, severity: "high", query: "x", staleEvidence: false })).toBe(3);
    // classification is NOT a findings filter → not counted (else a complete-empty scope would be mislabeled "no matches")
    expect(findingsActiveFilters({ ...EMPTY, classification: "DIRECT" })).toBe(0);
    // deferred, never-applied params are never counted
    expect(findingsActiveFilters({ ...EMPTY, provider: "okta", connectionId: "11111111-2222-4333-8444-555555555555", catalogMatch: "matched" })).toBe(0);
  });
  it("detailActiveFilters counts detail-list filters only", () => {
    expect(detailActiveFilters(EMPTY)).toBe(0);
    expect(detailActiveFilters({ ...EMPTY, query: "x", classification: "GROUP", staleEvidence: true })).toBe(3);
    // severity/rule/subjectType are findings-only → not counted on detail pages
    expect(detailActiveFilters({ ...EMPTY, severity: "high", ruleId: "redundant_direct_access", subjectType: "identity" })).toBe(0);
    expect(detailActiveFilters({ ...EMPTY, provider: "okta" })).toBe(0);
  });
});

describe("backLink — allowlisted internal reconstruction only (open-redirect proof)", () => {
  it("reconstructs known sources; re-applies re-validated ret filters", () => {
    expect(backLink({ from: "overview" })).toEqual({ href: "/access", label: "Back to access overview" });
    expect(backLink({ from: "findings", ret: "severity=high&page=2" })).toEqual({ href: "/access/findings?severity=high&page=2", label: "Back to findings" });
    expect(backLink({ from: "identity", fromId: UUID })).toEqual({ href: `/access/identities/${UUID}`, label: "Back to identity access" });
  });
  it("REFUSES to honor any caller-supplied URL / traversal / injection", () => {
    expect(backLink({ from: "https://evil.example.com" })).toBeNull();
    expect(backLink({ from: "//evil.example.com" })).toBeNull();
    expect(backLink({ from: "javascript:alert(1)" })).toBeNull();
    expect(backLink({ from: "identity", fromId: "../../secret" })).toBeNull();       // bad uuid -> no link
    expect(backLink({ from: "identity", fromId: "https://evil.com" })).toBeNull();
    // a malicious ret cannot inject anything: only allowlisted keys survive re-parse, target stays /access/findings
    const injected = backLink({ from: "findings", ret: "severity=high&next=https://evil.com&x=%2F%2Fevil" });
    expect(injected).toEqual({ href: "/access/findings?severity=high", label: "Back to findings" });
    // oversized ret is dropped (bounded), base link still safe
    expect(backLink({ from: "findings", ret: "q=" + "a".repeat(5000) })).toEqual({ href: "/access/findings", label: "Back to findings" });
  });
  it("returnParams round-trips through backLink to a canonical, safe href", () => {
    const cur = parseAccessFilters({ severity: "high", q: "ada", page: "2" });
    const rp = returnParams("findings", cur);
    const link = backLink(Object.fromEntries(rp));
    expect(link).toEqual({ href: "/access/findings?q=ada&severity=high&page=2", label: "Back to findings" });
  });
});

describe("RULE_OPTIONS", () => {
  it("exposes all 17 rules with reviewed titles, sorted by label", () => {
    expect(RULE_OPTIONS.length).toBe(17);
    const labels = RULE_OPTIONS.map((r) => r.label);
    expect(labels).toEqual([...labels].sort((a, b) => a.localeCompare(b)));
    expect(labels.every((l) => l.length > 0)).toBe(true);
  });
});
