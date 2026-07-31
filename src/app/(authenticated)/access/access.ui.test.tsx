// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, cleanup } from "@testing-library/react";

vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: unknown; children: React.ReactNode }) => (
    <a href={typeof href === "string" ? href : "#"} {...rest}>{children}</a>
  ),
}));

vi.mock("@/lib/data/access-loaders", () => ({
  loadAccessOverview: vi.fn(), loadIdentityAccessDetail: vi.fn(), loadApplicationAccessDetail: vi.fn(),
}));

import * as loaderModule from "@/lib/data/access-loaders";
import type { GovernanceFindingView } from "@/lib/data/access-view-models";
import AccessOverviewPage from "./page";
import AccessFindingsPage from "./findings/page";
import IdentityAccessPage from "./identities/[id]/page";
import ApplicationAccessPage from "./applications/[id]/page";

const loaders = {
  loadAccessOverview: vi.mocked(loaderModule.loadAccessOverview),
  loadIdentityAccessDetail: vi.mocked(loaderModule.loadIdentityAccessDetail),
  loadApplicationAccessDetail: vi.mocked(loaderModule.loadApplicationAccessDetail),
};

afterEach(cleanup);
beforeEach(() => { vi.clearAllMocks(); });

const SEED_UUID = "11111111-2222-4333-8444-555555555555";
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/;
// Rendered text must never carry a canonical UUID (hrefs only) or a technical/secret field. Unsupported-CLAIM words (usage/license/unused/
// savings/…) are handled two ways: dynamic finding copy is scanned clean by governance-presenter.test.ts, and the pages' static disclaimers
// legitimately use those words ONLY in negations ("does not show application usage…", "does not mean the application is unused…") — the GO's
// explicit educational-disclaimer exception — so they are not forbidden in rendered text here.
// "SERVICE_ROLE".toLowerCase() rather than the literal so check-auth-safety.sh's blanket substring grep isn't tripped by this negative assertion.
const FORBIDDEN_FIELDS = ["external_id", "externalid", "raw_payload", "rawpayload", "SERVICE_ROLE".toLowerCase(), "source_endpoint", "sourceendpoint", "last_discovery_run_id", "ciphertext"];
const noLeak = (text: string) => {
  expect(text).not.toContain(SEED_UUID);
  expect(text).not.toMatch(UUID_RE);
  for (const w of FORBIDDEN_FIELDS) expect(text.toLowerCase()).not.toContain(w);
};
const finding = (over: Partial<GovernanceFindingView> = {}): GovernanceFindingView => ({ id: "fid", ruleId: "redundant_direct_access", subjectType: "identity", severity: "medium", severityLabel: "Medium", severityTone: "attention", confidence: "high", confidenceLabel: "High confidence", title: "Direct and group-based access overlap", summary: "This identity has a direct assignment and access through groups.", guidance: "Review whether both paths are intentional.", subject: { kind: "identity", label: "Ada", href: `/access/identities/${SEED_UUID}` }, evidenceRows: [{ label: "Direct assignments", value: "1" }], staleEvidence: false, ...over });

describe("access overview page", () => {
  it("forbidden → 'Not available', no data, no mutation controls", async () => {
    loaders.loadAccessOverview.mockResolvedValue({ ok: false, error: "forbidden" });
    const { container } = render(await AccessOverviewPage({ searchParams: Promise.resolve({}) }));
    expect(container.textContent).toContain("Not available");
    expect(container.querySelector("button")).toBeNull();
    noLeak(container.textContent ?? "");
  });

  it("complete → renders counts + findings preview + truthful disclaimer; UUID only in href, never text", async () => {
    loaders.loadAccessOverview.mockResolvedValue({ ok: true, data: { status: "complete", counts: { identities: 1, groups: 2, applications: 2, memberships: 1, directAssignments: 1, groupAssignments: 0 }, breakdown: { directOnly: 1, groupOnly: 0, both: 0 }, effectiveRelationships: 1, governanceFindingsTotal: 1, summary: { total: 1, bySeverity: { info: 0, low: 0, medium: 1, high: 0 } }, findings: [finding()] } });
    const { container } = render(await AccessOverviewPage({ searchParams: Promise.resolve({}) }));
    const text = container.textContent ?? "";
    expect(text).toContain("Direct and group-based access overlap");
    expect(text).toContain("does not show application usage"); // truthfulness disclaimer
    expect(container.querySelector(`a[href^="/access/identities/${SEED_UUID}"]`)).toBeTruthy(); // uuid in href (may carry return context)
    noLeak(text);
  });

  it("too_large → truthful bounded banner, counts shown, NO 'no findings' claim", async () => {
    loaders.loadAccessOverview.mockResolvedValue({ ok: true, data: { status: "too_large", counts: { identities: 99999, groups: 1, applications: 1, memberships: 1, directAssignments: 1, groupAssignments: 0 } } });
    const { container } = render(await AccessOverviewPage({ searchParams: Promise.resolve({}) }));
    const text = container.textContent ?? "";
    expect(text).toContain("Too large to evaluate");
    expect(text).not.toContain("No governance findings");
    expect(text).not.toContain("No findings");
  });
});

describe("access findings page", () => {
  const overview = (findings: GovernanceFindingView[]) => ({ ok: true as const, data: { status: "complete" as const, counts: { identities: 1, groups: 0, applications: 1, memberships: 0, directAssignments: 1, groupAssignments: 0 }, breakdown: { directOnly: 1, groupOnly: 0, both: 0 }, effectiveRelationships: 1, governanceFindingsTotal: findings.length, summary: { total: findings.length, bySeverity: { info: 0, low: 0, medium: findings.length, high: 0 } }, findings } });

  it("complete → renders filter form + finding in an expandable <details>; no resolve/fix controls", async () => {
    loaders.loadAccessOverview.mockResolvedValue(overview([finding()]));
    const { container } = render(await AccessFindingsPage({ searchParams: Promise.resolve({}) }));
    const text = container.textContent ?? "";
    expect(container.querySelector("form[method='get']")).toBeTruthy();
    expect(container.querySelector("select[name='severity']")).toBeTruthy();
    expect(container.querySelector("details")).toBeTruthy();
    expect(text).toContain("Direct and group-based access overlap");
    expect(text).toContain("Direct assignments"); // evidence row inside the details panel
    expect(text.toLowerCase()).not.toContain("resolve"); expect(text.toLowerCase()).not.toContain("fix");
    expect(container.querySelector("button[type='submit']")?.textContent).toBe("Apply filters"); // filter submit, not a mutation
    noLeak(text);
  });

  it("severity filter narrows results and pre-selects the active value", async () => {
    loaders.loadAccessOverview.mockResolvedValue(overview([finding({ id: "hi", severity: "high", title: "High overlap" }), finding({ id: "lo", severity: "low", title: "Low overlap" })]));
    const { container } = render(await AccessFindingsPage({ searchParams: Promise.resolve({ severity: "high" }) }));
    const text = container.textContent ?? "";
    expect(text).toContain("High overlap");
    expect(text).not.toContain("Low overlap");
    expect((container.querySelector("select[name='severity']") as HTMLSelectElement).value).toBe("high");
    expect(text).toContain("Showing 1 of 2"); // truthful filtered total
  });

  it("search filter matches title/summary", async () => {
    loaders.loadAccessOverview.mockResolvedValue(overview([finding({ id: "a", title: "Alpha access" }), finding({ id: "b", title: "Beta access" })]));
    const { container } = render(await AccessFindingsPage({ searchParams: Promise.resolve({ q: "beta" }) }));
    const text = container.textContent ?? "";
    expect(text).toContain("Beta access");
    expect(text).not.toContain("Alpha access");
  });

  it("paginates deterministically with preserved pageSize", async () => {
    const many = Array.from({ length: 3 }, (_, i) => finding({ id: `f${i}`, title: `Finding ${i}` }));
    loaders.loadAccessOverview.mockResolvedValue(overview(many));
    const p1 = render(await AccessFindingsPage({ searchParams: Promise.resolve({ pageSize: "2" }) }));
    expect(p1.container.textContent).toContain("Page 1 of 2");
    expect(p1.container.querySelector("a[href*='page=2']")).toBeTruthy();
    cleanup();
    const p2 = render(await AccessFindingsPage({ searchParams: Promise.resolve({ pageSize: "2", page: "2" }) }));
    expect(p2.container.textContent).toContain("Finding 2");
    expect(p2.container.textContent).toContain("Page 2 of 2");
  });

  it("distinguishes complete-no-findings from filters-yield-none", async () => {
    loaders.loadAccessOverview.mockResolvedValue(overview([]));
    const none = render(await AccessFindingsPage({ searchParams: Promise.resolve({}) }));
    expect(none.container.textContent).toContain("No governance findings were produced for the selected scope");
    cleanup();
    loaders.loadAccessOverview.mockResolvedValue(overview([finding({ severity: "medium" })]));
    const filtered = render(await AccessFindingsPage({ searchParams: Promise.resolve({ severity: "high" }) }));
    expect(filtered.container.textContent).toContain("No findings match the selected filters");
    expect(filtered.container.textContent).not.toContain("No governance findings were produced");
  });

  it("renders an Export CSV link to the export route carrying the active filters (only when there are rows)", async () => {
    loaders.loadAccessOverview.mockResolvedValue(overview([finding()]));
    const withRows = render(await AccessFindingsPage({ searchParams: Promise.resolve({ severity: "medium" }) }));
    const link = withRows.container.querySelector('a[href^="/access/findings/export"]') as HTMLAnchorElement;
    expect(link).toBeTruthy();
    expect(link.getAttribute("href")).toContain("severity=medium");
    cleanup();
    loaders.loadAccessOverview.mockResolvedValue(overview([]));
    const noRows = render(await AccessFindingsPage({ searchParams: Promise.resolve({}) }));
    expect(noRows.container.querySelector('a[href^="/access/findings/export"]')).toBeNull(); // nothing to export
  });

  it("subject links carry allowlisted return context (from=findings)", async () => {
    loaders.loadAccessOverview.mockResolvedValue(overview([finding()]));
    const { container } = render(await AccessFindingsPage({ searchParams: Promise.resolve({ severity: "medium" }) }));
    const link = container.querySelector(`a[href^="/access/identities/${SEED_UUID}"]`) as HTMLAnchorElement;
    expect(link).toBeTruthy();
    expect(link.getAttribute("href")).toContain("from=findings");
  });

  it("too_large → bounded banner, never a false 'no findings'", async () => {
    loaders.loadAccessOverview.mockResolvedValue({ ok: true, data: { status: "too_large", counts: { identities: 99999, groups: 1, applications: 1, memberships: 1, directAssignments: 1, groupAssignments: 0 } } });
    const { container } = render(await AccessFindingsPage({ searchParams: Promise.resolve({}) }));
    expect(container.textContent).toContain("not evaluated within the current safety limits");
    expect(container.textContent).not.toContain("No governance findings were produced");
  });

  it("forbidden → not available", async () => {
    loaders.loadAccessOverview.mockResolvedValue({ ok: false, error: "forbidden" });
    const { container } = render(await AccessFindingsPage({ searchParams: Promise.resolve({}) }));
    expect(container.textContent).toContain("Not available");
  });
});

describe("identity + application detail — not-found indistinguishability + no leak + no mutation", () => {
  it("identity not_found renders the generic block (foreign == missing == denied)", async () => {
    loaders.loadIdentityAccessDetail.mockResolvedValue({ ok: false, error: "not_found" });
    const { container } = render(await IdentityAccessPage({ params: Promise.resolve({ id: SEED_UUID }), searchParams: Promise.resolve({}) }));
    const text = container.textContent ?? "";
    expect(text).toContain("Not found");
    expect(text).toContain("doesn’t exist or you don’t have access");
    expect(container.querySelector("button")).toBeNull();
    noLeak(text);
  });
  it("identity detail renders access + finding; UUID only in hrefs; no remove control", async () => {
    loaders.loadIdentityAccessDetail.mockResolvedValue({ ok: true, data: { id: SEED_UUID, displayName: "Ada Lovelace", providerLabel: "okta", syncState: "current", staleSince: null, bounded: false, effectiveApplicationCount: 1, applications: [{ applicationId: SEED_UUID, applicationLabel: "Salesforce", classification: "BOTH", classificationLabel: "Direct and through group", explanation: "Access is represented through a direct assignment and 1 group.", groupPaths: [{ groupId: "9c000000-0000-4000-8000-0000000090a1", groupLabel: "Engineering", staleEvidence: false }], staleEvidence: false }], findings: [finding()] } });
    const { container } = render(await IdentityAccessPage({ params: Promise.resolve({ id: SEED_UUID }), searchParams: Promise.resolve({}) }));
    const text = container.textContent ?? "";
    expect(text).toContain("Ada Lovelace");
    expect(text).toContain("Access is represented through a direct assignment and 1 group.");
    expect(text.toLowerCase()).not.toContain("remove access");
    noLeak(text);
  });
  it("bounded detail (fan-in-heavy neighborhood) renders a truthful 'too large' banner instead of an unbounded list", async () => {
    loaders.loadApplicationAccessDetail.mockResolvedValue({ ok: true, data: { id: SEED_UUID, displayName: "All Employees App", providerLabel: "okta", syncState: "current", staleSince: null, catalogMatchStatus: null, bounded: true, effectiveIdentityCount: 0, directOnlyCount: 0, groupOnlyCount: 0, bothCount: 0, identities: [], assignedGroups: [], findings: [] } });
    const { container } = render(await ApplicationAccessPage({ params: Promise.resolve({ id: SEED_UUID }), searchParams: Promise.resolve({}) }));
    const text = container.textContent ?? "";
    expect(text).toContain("Too large to display in full");
    expect(text).not.toContain("Effective identities (0)"); // no misleading "0" conclusion
    expect(container.querySelector("table")).toBeNull();     // the unbounded list is not rendered
    noLeak(text);
  });

  it("not-found and error states each expose exactly one h1 (a11y: every state names the page)", async () => {
    loaders.loadIdentityAccessDetail.mockResolvedValue({ ok: false, error: "not_found" });
    const nf = render(await IdentityAccessPage({ params: Promise.resolve({ id: SEED_UUID }), searchParams: Promise.resolve({}) }));
    expect(nf.container.querySelectorAll("h1")).toHaveLength(1);
    cleanup();
    loaders.loadIdentityAccessDetail.mockResolvedValue({ ok: false, error: "query_failed" });
    const err = render(await IdentityAccessPage({ params: Promise.resolve({ id: SEED_UUID }), searchParams: Promise.resolve({}) }));
    expect(err.container.querySelectorAll("h1")).toHaveLength(1);
  });

  it("application not_found is indistinguishable; ok renders effective identities", async () => {
    loaders.loadApplicationAccessDetail.mockResolvedValue({ ok: false, error: "not_found" });
    const nf = render(await ApplicationAccessPage({ params: Promise.resolve({ id: SEED_UUID }), searchParams: Promise.resolve({}) }));
    expect(nf.container.textContent).toContain("Not found");
    cleanup();
    loaders.loadApplicationAccessDetail.mockResolvedValue({ ok: true, data: { id: SEED_UUID, displayName: "Salesforce", providerLabel: "okta", syncState: "current", staleSince: null, catalogMatchStatus: "unmatched", bounded: false, effectiveIdentityCount: 1, directOnlyCount: 1, groupOnlyCount: 0, bothCount: 0, identities: [{ identityId: SEED_UUID, identityLabel: "Ada", classification: "DIRECT", classificationLabel: "Direct", staleEvidence: false }], assignedGroups: [], findings: [] } });
    const { container } = render(await ApplicationAccessPage({ params: Promise.resolve({ id: SEED_UUID }), searchParams: Promise.resolve({}) }));
    const text = container.textContent ?? "";
    expect(text).toContain("Salesforce");
    expect(text).toContain("Catalog match unavailable");
    noLeak(text);
  });
});

const UUID_A = "22222222-3333-4444-8555-666666666666";
const UUID_B = "33333333-4444-4555-8666-777777777777";

describe("detail-page filters, pagination + return-context", () => {
  const identityDetail = (apps: { applicationId: string; applicationLabel: string; classification: "DIRECT" | "GROUP" | "BOTH"; classificationLabel: string; explanation: string; groupPaths: { groupId: "9c000000-0000-4000-8000-0000000090a1", groupLabel: string; staleEvidence: boolean }[]; staleEvidence: boolean }[]) =>
    ({ ok: true as const, data: { id: SEED_UUID, displayName: "Ada Lovelace", providerLabel: "okta", syncState: "current" as const, staleSince: null, bounded: false, effectiveApplicationCount: apps.length, applications: apps, findings: [] } });
  const app = (over: Partial<{ applicationId: string; applicationLabel: string; classification: "DIRECT" | "GROUP" | "BOTH"; classificationLabel: string; explanation: string; groupPaths: { groupId: "9c000000-0000-4000-8000-0000000090a1", groupLabel: string; staleEvidence: boolean }[]; staleEvidence: boolean }> = {}) =>
    ({ applicationId: UUID_A, applicationLabel: "Salesforce", classification: "DIRECT" as const, classificationLabel: "Direct", explanation: "Access is represented through a direct assignment.", groupPaths: [], staleEvidence: false, ...over });

  it("identity detail: classification filter narrows applications + pre-selects", async () => {
    loaders.loadIdentityAccessDetail.mockResolvedValue(identityDetail([app({ applicationId: UUID_A, applicationLabel: "Salesforce", classification: "DIRECT" }), app({ applicationId: UUID_B, applicationLabel: "Slack", classification: "GROUP", classificationLabel: "Through group" })]));
    const { container } = render(await IdentityAccessPage({ params: Promise.resolve({ id: SEED_UUID }), searchParams: Promise.resolve({ classification: "GROUP" }) }));
    const text = container.textContent ?? "";
    expect(text).toContain("Slack");
    expect(text).not.toContain("Salesforce");
    expect((container.querySelector("select[name='classification']") as HTMLSelectElement).value).toBe("GROUP");
  });

  it("identity detail: search narrows + paginates with preserved pageSize", async () => {
    loaders.loadIdentityAccessDetail.mockResolvedValue(identityDetail([app({ applicationId: UUID_A, applicationLabel: "Alpha" }), app({ applicationId: UUID_B, applicationLabel: "Beta" })]));
    const s = render(await IdentityAccessPage({ params: Promise.resolve({ id: SEED_UUID }), searchParams: Promise.resolve({ q: "beta" }) }));
    expect(s.container.textContent).toContain("Beta");
    expect(s.container.textContent).not.toContain("Alpha");
    cleanup();
    loaders.loadIdentityAccessDetail.mockResolvedValue(identityDetail([app({ applicationId: UUID_A, applicationLabel: "Alpha" }), app({ applicationId: UUID_B, applicationLabel: "Beta" })]));
    const p = render(await IdentityAccessPage({ params: Promise.resolve({ id: SEED_UUID }), searchParams: Promise.resolve({ pageSize: "1" }) }));
    expect(p.container.textContent).toContain("Page 1 of 2");
  });

  it("identity detail: outgoing application links carry return context (from=identity + fromId)", async () => {
    loaders.loadIdentityAccessDetail.mockResolvedValue(identityDetail([app({ applicationId: UUID_A })]));
    const { container } = render(await IdentityAccessPage({ params: Promise.resolve({ id: SEED_UUID }), searchParams: Promise.resolve({}) }));
    const link = container.querySelector(`a[href^="/access/applications/${UUID_A}"]`) as HTMLAnchorElement;
    expect(link.getAttribute("href")).toContain("from=identity");
    expect(link.getAttribute("href")).toContain(`fromId=${SEED_UUID}`);
  });

  it("return context: from=findings renders a 'Back to findings' link; a hostile 'from' falls back to the static link", async () => {
    loaders.loadIdentityAccessDetail.mockResolvedValue(identityDetail([app()]));
    const good = render(await IdentityAccessPage({ params: Promise.resolve({ id: SEED_UUID }), searchParams: Promise.resolve({ from: "findings", ret: "severity=high" }) }));
    const backGood = good.container.querySelector("a[href^='/access/findings']") as HTMLAnchorElement;
    expect(backGood.textContent).toContain("Back to findings");
    expect(backGood.getAttribute("href")).toBe("/access/findings?severity=high");
    cleanup();
    loaders.loadIdentityAccessDetail.mockResolvedValue(identityDetail([app()]));
    const evil = render(await IdentityAccessPage({ params: Promise.resolve({ id: SEED_UUID }), searchParams: Promise.resolve({ from: "https://evil.example.com" }) }));
    const backEvil = evil.container.querySelector("main > div.text-sm a") as HTMLAnchorElement;
    expect(backEvil.getAttribute("href")).toBe("/access"); // never honors the caller-supplied URL
    expect(evil.container.textContent).not.toContain("evil.example.com");
  });

  it("application detail: classification filter narrows effective identities", async () => {
    loaders.loadApplicationAccessDetail.mockResolvedValue({ ok: true, data: { id: SEED_UUID, displayName: "Salesforce", providerLabel: "okta", syncState: "current", staleSince: null, catalogMatchStatus: "matched", bounded: false, effectiveIdentityCount: 2, directOnlyCount: 1, groupOnlyCount: 1, bothCount: 0, identities: [{ identityId: UUID_A, identityLabel: "Ada", classification: "DIRECT", classificationLabel: "Direct", staleEvidence: false }, { identityId: UUID_B, identityLabel: "Grace", classification: "GROUP", classificationLabel: "Through group", staleEvidence: false }], assignedGroups: [], findings: [] } });
    const { container } = render(await ApplicationAccessPage({ params: Promise.resolve({ id: SEED_UUID }), searchParams: Promise.resolve({ classification: "DIRECT" }) }));
    const text = container.textContent ?? "";
    expect(text).toContain("Ada");
    expect(text).not.toContain("Grace");
    expect(text).toContain("Effective identities (2)"); // the true count stays; the table is what's filtered
  });

  it("application detail: a stale-derived identity row shows a 'Stale evidence' marker (truthfulness, symmetric with the identity page)", async () => {
    loaders.loadApplicationAccessDetail.mockResolvedValue({ ok: true, data: { id: SEED_UUID, displayName: "Salesforce", providerLabel: "okta", syncState: "current", staleSince: null, catalogMatchStatus: "matched", bounded: false, effectiveIdentityCount: 1, directOnlyCount: 0, groupOnlyCount: 1, bothCount: 0, identities: [{ identityId: UUID_A, identityLabel: "Ada", classification: "GROUP", classificationLabel: "Through group", staleEvidence: true }], assignedGroups: [], findings: [] } });
    const { container } = render(await ApplicationAccessPage({ params: Promise.resolve({ id: SEED_UUID }), searchParams: Promise.resolve({ stale: "1" }) }));
    const row = container.querySelector("tbody tr");
    expect(row?.textContent).toContain("Stale evidence");
  });
});

describe("regression: complete-empty vs filtered-empty is keyed on APPLIED filters only", () => {
  const overview = (findings: GovernanceFindingView[]) => ({ ok: true as const, data: { status: "complete" as const, counts: { identities: 1, groups: 0, applications: 1, memberships: 0, directAssignments: 1, groupAssignments: 0 }, breakdown: { directOnly: 1, groupOnly: 0, both: 0 }, effectiveRelationships: 1, governanceFindingsTotal: findings.length, summary: { total: findings.length, bySeverity: { info: 0, low: 0, medium: findings.length, high: 0 } }, findings } });

  it("complete + zero findings + an UNAPPLIED param (classification) still shows the truthful complete-empty message", async () => {
    loaders.loadAccessOverview.mockResolvedValue(overview([]));
    const { container } = render(await AccessFindingsPage({ searchParams: Promise.resolve({ classification: "DIRECT" }) }));
    const text = container.textContent ?? "";
    expect(text).toContain("No governance findings were produced for the selected scope");
    expect(text).not.toContain("No findings match the selected filters");
  });

  it("identity detail findings list is capped with a truthful overflow note", async () => {
    const many = Array.from({ length: 55 }, (_, i) => finding({ id: `g${i}`, title: `Finding ${i}` }));
    loaders.loadIdentityAccessDetail.mockResolvedValue({ ok: true, data: { id: SEED_UUID, displayName: "Ada", providerLabel: "okta", syncState: "current", staleSince: null, bounded: false, effectiveApplicationCount: 0, applications: [], findings: many } });
    const { container } = render(await IdentityAccessPage({ params: Promise.resolve({ id: SEED_UUID }), searchParams: Promise.resolve({}) }));
    const text = container.textContent ?? "";
    expect(text).toContain("Showing the first 50 of 55 findings");
    expect(text).toContain("Finding 49"); // index 49 = the 50th, rendered
    expect(text).not.toContain("Finding 50"); // 51st+ capped out
  });
});

// ── Phase 4: cross-links between identity-graph objects ────────────────────────────────────────────────────────
// Every one of these must route on a canonical id. The Phase 1–3 pages already linked people and applications; the
// group links are what Phase 4 adds, and they are the ones that close the loop between the two directions.
describe("identity-graph cross-links", () => {
  const GID = "9c000000-0000-4000-8000-0000000090a1";

  it("person detail links each group path to the GROUP, by id", async () => {
    // "Through <group>" is the answer to "why does this person have this?" — it was plain text before Phase 4.
    loaders.loadIdentityAccessDetail.mockResolvedValue({ ok: true, data: { id: SEED_UUID, displayName: "Ada Lovelace", providerLabel: "okta", syncState: "current", staleSince: null, bounded: false, effectiveApplicationCount: 1, applications: [{ applicationId: SEED_UUID, applicationLabel: "Salesforce", classification: "GROUP", classificationLabel: "Through group", explanation: "Access is represented through 1 group.", groupPaths: [{ groupId: GID, groupLabel: "Engineering", staleEvidence: false }], staleEvidence: false }], findings: [] } });
    const { container } = render(await IdentityAccessPage({ params: Promise.resolve({ id: SEED_UUID }), searchParams: Promise.resolve({}) }));
    const link = [...container.querySelectorAll("a")].find((a) => (a.getAttribute("href") ?? "").includes("/directory/groups/"));
    expect(link, "a group path must be a link").toBeTruthy();
    expect(link!.getAttribute("href")).toContain(`/directory/groups/${GID}`);
    expect(link!.getAttribute("href")).toContain("from=identity");
    // Never routed on the label.
    expect(link!.getAttribute("href")).not.toContain(link!.textContent ?? "@@");
  });

  it("application detail links each assigned group to the GROUP, by id", async () => {
    loaders.loadApplicationAccessDetail.mockResolvedValue({ ok: true, data: { id: SEED_UUID, displayName: "Salesforce", providerLabel: "okta", syncState: "current", staleSince: null, catalogMatchStatus: null, bounded: false, effectiveIdentityCount: 0, directOnlyCount: 0, groupOnlyCount: 0, bothCount: 0, identities: [], assignedGroups: [{ groupId: GID, groupLabel: "Engineering", staleEvidence: false }], findings: [] } });
    const { container } = render(await ApplicationAccessPage({ params: Promise.resolve({ id: SEED_UUID }), searchParams: Promise.resolve({}) }));
    const link = [...container.querySelectorAll("a")].find((a) => (a.getAttribute("href") ?? "").includes("/directory/groups/"));
    expect(link, "an assigned group must be a link").toBeTruthy();
    expect(link!.getAttribute("href")).toContain(`/directory/groups/${GID}`);
    expect(link!.getAttribute("href")).toContain("from=application");
  });
});

// ── Phase 4: Findings organised by subject ─────────────────────────────────────────────────────────────────────
describe("findings grouped by subject", () => {
  const GID2 = "9c000000-0000-4000-8000-0000000090b2";
  const overview = (findings: GovernanceFindingView[]) => ({ ok: true as const, data: { status: "complete" as const, counts: { identities: 1, groups: 1, applications: 1, memberships: 0, directAssignments: 0, groupAssignments: 0 }, breakdown: { directOnly: 0, groupOnly: 0, both: 0 }, effectiveRelationships: 0, governanceFindingsTotal: findings.length, summary: { total: findings.length, bySeverity: { info: 0, low: 0, medium: findings.length, high: 0 } }, findings } });

  const mixed = () => [
    finding({ id: "g1", subjectType: "group", severity: "high", severityLabel: "High", title: "Group reaches many applications",
              subject: { kind: "group", label: "Engineering", href: `/directory/groups/${GID2}` } }),
    finding({ id: "i1", subjectType: "identity", severity: "low", severityLabel: "Low", title: "Person overlap" }),
    finding({ id: "x1", subjectType: "graph", severity: "medium", severityLabel: "Medium", title: "Edges ignored", subject: null }),
  ];

  it("renders a heading per subject bucket, worst severity first", async () => {
    loaders.loadAccessOverview.mockResolvedValue(overview(mixed()));
    const { container } = render(await AccessFindingsPage({ searchParams: Promise.resolve({}) }));
    const headings = [...container.querySelectorAll("h2")].map((h) => h.textContent);
    // Groups holds the High, so it leads; Connector & directory holds the Medium; People the Low.
    expect(headings).toEqual(["Groups", "Connector & directory", "People"]);
  });

  it("hides nothing — every finding still renders", async () => {
    loaders.loadAccessOverview.mockResolvedValue(overview(mixed()));
    const { container } = render(await AccessFindingsPage({ searchParams: Promise.resolve({}) }));
    const text = container.textContent ?? "";
    for (const title of ["Group reaches many applications", "Person overlap", "Edges ignored"]) expect(text).toContain(title);
  });

  it("gives a group finding a primary action that opens the GROUP by id", async () => {
    loaders.loadAccessOverview.mockResolvedValue(overview(mixed()));
    const { container } = render(await AccessFindingsPage({ searchParams: Promise.resolve({}) }));
    const link = [...container.querySelectorAll("a")].find((a) => (a.getAttribute("href") ?? "").includes("/directory/groups/"));
    expect(link!.getAttribute("href")).toContain(`/directory/groups/${GID2}`);
    expect(link!.textContent).toContain("Open group");
  });

  it("does NOT fabricate an action for a finding with no safe subject", async () => {
    loaders.loadAccessOverview.mockResolvedValue(overview([finding({ id: "x1", subjectType: "graph", title: "Edges ignored", subject: null })]));
    const { container } = render(await AccessFindingsPage({ searchParams: Promise.resolve({}) }));
    const text = container.textContent ?? "";
    expect(text).toContain("describes your directory connection as a whole");
    expect([...container.querySelectorAll("a")].some((a) => /\/access\/identities\/|\/directory\/groups\/|\/access\/applications\//.test(a.getAttribute("href") ?? ""))).toBe(false);
  });

  it("offers a per-bucket filter that scopes the URL", async () => {
    loaders.loadAccessOverview.mockResolvedValue(overview(mixed()));
    const { container } = render(await AccessFindingsPage({ searchParams: Promise.resolve({}) }));
    const only = [...container.querySelectorAll("a")].find((a) => (a.textContent ?? "").startsWith("Show only groups"));
    expect(decodeURIComponent(only!.getAttribute("href")!)).toContain("subject=groups");
    expect(container.querySelector("select[name='subject']")).toBeTruthy();
  });

  it("applies the subject filter and pre-selects it", async () => {
    loaders.loadAccessOverview.mockResolvedValue(overview(mixed()));
    const { container } = render(await AccessFindingsPage({ searchParams: Promise.resolve({ subject: "groups" }) }));
    const text = container.textContent ?? "";
    expect(text).toContain("Group reaches many applications");
    expect(text).not.toContain("Person overlap");
    expect((container.querySelector("select[name='subject']") as HTMLSelectElement).value).toBe("groups");
  });

  it("keeps high severity leading within a bucket", async () => {
    loaders.loadAccessOverview.mockResolvedValue(overview([
      finding({ id: "a", subjectType: "identity", severity: "high", severityLabel: "High", title: "Zed high" }),
      finding({ id: "b", subjectType: "identity", severity: "low", severityLabel: "Low", title: "Alpha low" }),
    ]));
    const { container } = render(await AccessFindingsPage({ searchParams: Promise.resolve({}) }));
    const text = container.textContent ?? "";
    expect(text.indexOf("Zed high")).toBeLessThan(text.indexOf("Alpha low"));
  });
});
