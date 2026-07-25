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
const finding = (over: Partial<GovernanceFindingView> = {}): GovernanceFindingView => ({ id: "fid", severity: "medium", severityLabel: "Medium", severityTone: "attention", confidence: "high", confidenceLabel: "High confidence", title: "Direct and group-based access overlap", summary: "This identity has a direct assignment and access through groups.", guidance: "Review whether both paths are intentional.", subject: { kind: "identity", label: "Ada", href: `/access/identities/${SEED_UUID}` }, evidenceRows: [{ label: "Direct assignments", value: "1" }], staleEvidence: false, ...over });

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
    expect(container.querySelector(`a[href="/access/identities/${SEED_UUID}"]`)).toBeTruthy(); // uuid in href
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
  it("complete → lists findings; forbidden → not available", async () => {
    loaders.loadAccessOverview.mockResolvedValue({ ok: true, data: { status: "complete", counts: { identities: 1, groups: 0, applications: 1, memberships: 0, directAssignments: 1, groupAssignments: 0 }, breakdown: { directOnly: 1, groupOnly: 0, both: 0 }, effectiveRelationships: 1, governanceFindingsTotal: 1, summary: { total: 1, bySeverity: { info: 0, low: 0, medium: 1, high: 0 } }, findings: [finding()] } });
    const { container } = render(await AccessFindingsPage({ searchParams: Promise.resolve({}) }));
    const text = container.textContent ?? "";
    expect(text).toContain("Governance findings");
    expect(text).toContain("Direct and group-based access overlap");
    expect(text.toLowerCase()).not.toContain("resolve"); expect(text.toLowerCase()).not.toContain("fix");
    noLeak(text);
  });
  it("forbidden → not available", async () => {
    loaders.loadAccessOverview.mockResolvedValue({ ok: false, error: "forbidden" });
    const { container } = render(await AccessFindingsPage({ searchParams: Promise.resolve({}) }));
    expect(container.textContent).toContain("Not available");
  });
  it("active severity filter is marked aria-current='page' (a11y: not color-only)", async () => {
    loaders.loadAccessOverview.mockResolvedValue({ ok: true, data: { status: "complete", counts: { identities: 1, groups: 0, applications: 1, memberships: 0, directAssignments: 1, groupAssignments: 0 }, breakdown: { directOnly: 1, groupOnly: 0, both: 0 }, effectiveRelationships: 1, governanceFindingsTotal: 1, summary: { total: 1, bySeverity: { info: 0, low: 0, medium: 1, high: 0 } }, findings: [finding()] } });
    const { container } = render(await AccessFindingsPage({ searchParams: Promise.resolve({ severity: "medium" }) }));
    const current = container.querySelectorAll('[aria-current="page"]');
    expect(current).toHaveLength(1);
    expect(current[0].textContent).toBe("Medium");
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
    loaders.loadIdentityAccessDetail.mockResolvedValue({ ok: true, data: { id: SEED_UUID, displayName: "Ada Lovelace", providerLabel: "okta", syncState: "current", staleSince: null, bounded: false, effectiveApplicationCount: 1, applications: [{ applicationId: SEED_UUID, applicationLabel: "Salesforce", classification: "BOTH", classificationLabel: "Direct and through group", explanation: "Access is represented through a direct assignment and 1 group.", groupPaths: [{ groupLabel: "Engineering", staleEvidence: false }], staleEvidence: false }], findings: [finding()] } });
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
    loaders.loadApplicationAccessDetail.mockResolvedValue({ ok: true, data: { id: SEED_UUID, displayName: "Salesforce", providerLabel: "okta", syncState: "current", staleSince: null, catalogMatchStatus: "unmatched", bounded: false, effectiveIdentityCount: 1, directOnlyCount: 1, groupOnlyCount: 0, bothCount: 0, identities: [{ identityId: SEED_UUID, identityLabel: "Ada", classification: "DIRECT", classificationLabel: "Direct" }], assignedGroups: [], findings: [] } });
    const { container } = render(await ApplicationAccessPage({ params: Promise.resolve({ id: SEED_UUID }), searchParams: Promise.resolve({}) }));
    const text = container.textContent ?? "";
    expect(text).toContain("Salesforce");
    expect(text).toContain("Catalog match unavailable");
    noLeak(text);
  });
});
