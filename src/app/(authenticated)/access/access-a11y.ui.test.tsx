// @vitest-environment jsdom
// Accessibility regression suite for the /access surface (Phase 15 Part 2 PR E). No axe dependency exists in this repo, so a11y is asserted
// structurally via @testing-library role/name/label queries (project convention). Locks in: one <h1> per page/state, labelled filter
// controls, aria-current pagination, live-region banners, native <details> drill-down, accessible export-link name, text-not-color meaning.
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, cleanup, within } from "@testing-library/react";

vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: unknown; children: React.ReactNode }) => (
    <a href={typeof href === "string" ? href : "#"} {...rest}>{children}</a>
  ),
}));
vi.mock("@/lib/data/access-loaders", () => ({ loadAccessOverview: vi.fn(), loadIdentityAccessDetail: vi.fn(), loadApplicationAccessDetail: vi.fn() }));

import * as loaderModule from "@/lib/data/access-loaders";
import type { GovernanceFindingView } from "@/lib/data/access-view-models";
import AccessOverviewPage from "./page";
import AccessFindingsPage from "./findings/page";
import IdentityAccessPage from "./identities/[id]/page";
import ApplicationAccessPage from "./applications/[id]/page";

const loaders = {
  overview: vi.mocked(loaderModule.loadAccessOverview),
  identity: vi.mocked(loaderModule.loadIdentityAccessDetail),
  application: vi.mocked(loaderModule.loadApplicationAccessDetail),
};
const UUID = "11111111-2222-4333-8444-555555555555";
afterEach(cleanup);
beforeEach(() => vi.clearAllMocks());

const finding = (over: Partial<GovernanceFindingView> = {}): GovernanceFindingView => ({ id: "fid", ruleId: "redundant_direct_access", subjectType: "identity", severity: "medium", severityLabel: "Medium", severityTone: "attention", confidence: "high", confidenceLabel: "High confidence", title: "Overlap", summary: "s", guidance: "g", subject: { kind: "identity", label: "Ada", href: `/access/identities/${UUID}` }, evidenceRows: [{ label: "Direct assignments", value: "1" }], staleEvidence: false, ...over });
const overview = (findings: GovernanceFindingView[]) => ({ ok: true as const, data: { status: "complete" as const, counts: { identities: 1, groups: 2, applications: 2, memberships: 1, directAssignments: 1, groupAssignments: 0 }, breakdown: { directOnly: 1, groupOnly: 0, both: 0 }, effectiveRelationships: 1, governanceFindingsTotal: findings.length, summary: { total: findings.length, bySeverity: { info: 0, low: 0, medium: findings.length, high: 0 } }, findings } });

const oneH1 = (c: HTMLElement) => expect(c.querySelectorAll("h1")).toHaveLength(1);

describe("a11y — exactly one h1 per page and state", () => {
  it("overview: complete + forbidden", async () => {
    loaders.overview.mockResolvedValue(overview([finding()]));
    oneH1(render(await AccessOverviewPage({ searchParams: Promise.resolve({}) })).container);
    cleanup();
    loaders.overview.mockResolvedValue({ ok: false, error: "forbidden" });
    oneH1(render(await AccessOverviewPage({ searchParams: Promise.resolve({}) })).container);
  });
  it("findings: complete + forbidden + error", async () => {
    loaders.overview.mockResolvedValue(overview([finding()]));
    oneH1(render(await AccessFindingsPage({ searchParams: Promise.resolve({}) })).container);
    cleanup();
    loaders.overview.mockResolvedValue({ ok: false, error: "forbidden" });
    oneH1(render(await AccessFindingsPage({ searchParams: Promise.resolve({}) })).container);
    cleanup();
    loaders.overview.mockResolvedValue({ ok: false, error: "query_failed" }); // the load-error (role=alert) branch
    oneH1(render(await AccessFindingsPage({ searchParams: Promise.resolve({}) })).container);
  });
  it("identity + application detail: ok + bounded + not-found + error each expose exactly one h1", async () => {
    const idOk = { ok: true as const, data: { id: UUID, displayName: "Ada", providerLabel: "okta", syncState: "current" as const, staleSince: null, bounded: false, effectiveApplicationCount: 0, applications: [], findings: [] } };
    for (const state of [idOk, { ...idOk, data: { ...idOk.data, bounded: true } }, { ok: false as const, error: "not_found" as const }, { ok: false as const, error: "query_failed" as const }]) {
      loaders.identity.mockResolvedValue(state);
      oneH1(render(await IdentityAccessPage({ params: Promise.resolve({ id: UUID }), searchParams: Promise.resolve({}) })).container);
      cleanup();
    }
    const appOk = { ok: true as const, data: { id: UUID, displayName: "SF", providerLabel: "okta", syncState: "current" as const, staleSince: null, catalogMatchStatus: "matched", bounded: false, effectiveIdentityCount: 0, directOnlyCount: 0, groupOnlyCount: 0, bothCount: 0, identities: [], assignedGroups: [], findings: [] } };
    for (const state of [appOk, { ...appOk, data: { ...appOk.data, bounded: true } }, { ok: false as const, error: "not_found" as const }, { ok: false as const, error: "query_failed" as const }]) {
      loaders.application.mockResolvedValue(state);
      oneH1(render(await ApplicationAccessPage({ params: Promise.resolve({ id: UUID }), searchParams: Promise.resolve({}) })).container);
      cleanup();
    }
  });
});

describe("a11y — labelled controls, live regions, disclosure, accessible names", () => {
  it("findings filter form: aria-labelled form, a searchbox, ≥5 labelled selects, a named submit button", async () => {
    loaders.overview.mockResolvedValue(overview([finding()]));
    const { container } = render(await AccessFindingsPage({ searchParams: Promise.resolve({}) }));
    const form = container.querySelector("form[method='get']") as HTMLElement;
    expect(form.getAttribute("aria-label")).toBe("Filter findings");
    expect(within(form).getByRole("searchbox")).toBeTruthy();
    expect(within(form).getAllByRole("combobox").length).toBeGreaterThanOrEqual(5);
    // every VISIBLE control has a NON-EMPTY accessible name (wrapping <label> text, label[for], or aria-label). Hidden inputs are exempt.
    form.querySelectorAll("input:not([type=hidden]), select").forEach((el) => {
      const wrap = el.closest("label");
      const forLabel = el.id ? form.querySelector(`label[for="${el.id}"]`) : null;
      const name = (wrap?.textContent ?? forLabel?.textContent ?? el.getAttribute("aria-label") ?? "").trim();
      expect(name.length).toBeGreaterThan(0);
    });
    expect(within(form).getByRole("button", { name: "Apply filters" })).toBeTruthy();
    expect(container.querySelector("details > summary")).toBeTruthy(); // native disclosure drill-down
  });
  it("findings: pagination announces the current page (aria-current, text not color)", async () => {
    loaders.overview.mockResolvedValue(overview(Array.from({ length: 3 }, (_, i) => finding({ id: `f${i}` }))));
    const { container } = render(await AccessFindingsPage({ searchParams: Promise.resolve({ pageSize: "2" }) }));
    const current = container.querySelectorAll('[aria-current="page"]');
    expect(current).toHaveLength(1);
    expect(current[0].textContent).toMatch(/Page 1 of 2/);
  });
  it("findings: bounded banner is a live region; load error is an alert", async () => {
    loaders.overview.mockResolvedValue({ ok: true, data: { status: "too_large", counts: { identities: 99999, groups: 1, applications: 1, memberships: 1, directAssignments: 1, groupAssignments: 0 } } });
    expect(render(await AccessFindingsPage({ searchParams: Promise.resolve({}) })).container.querySelector('[role="status"]')).toBeTruthy();
    cleanup();
    loaders.overview.mockResolvedValue({ ok: false, error: "query_failed" });
    expect(render(await AccessFindingsPage({ searchParams: Promise.resolve({}) })).container.querySelector('[role="alert"]')).toBeTruthy();
  });
  it("export link has an accessible text name", async () => {
    loaders.overview.mockResolvedValue(overview([finding()]));
    const { container } = render(await AccessFindingsPage({ searchParams: Promise.resolve({}) }));
    const link = container.querySelector('a[href^="/access/findings/export"]');
    expect(link?.textContent?.trim()).toBe("Export CSV");
  });
});
