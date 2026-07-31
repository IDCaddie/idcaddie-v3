import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/data/access-loaders", () => ({
  loadAccessOverview: vi.fn(), loadIdentityAccessDetail: vi.fn(), loadApplicationAccessDetail: vi.fn(),
}));

import * as loaderMod from "@/lib/data/access-loaders";
import type { GovernanceFindingView } from "@/lib/data/access-view-models";
import { GET as findingsExport } from "./findings/export/route";
import { GET as identityExport } from "./identities/[id]/export/route";
import { GET as applicationExport } from "./applications/[id]/export/route";

const loaders = {
  overview: vi.mocked(loaderMod.loadAccessOverview),
  identity: vi.mocked(loaderMod.loadIdentityAccessDetail),
  application: vi.mocked(loaderMod.loadApplicationAccessDetail),
};
const UUID = "11111111-2222-4333-8444-555555555555";
beforeEach(() => vi.clearAllMocks());

const finding = (over: Partial<GovernanceFindingView> = {}): GovernanceFindingView => ({ id: "governance:redundant_direct_access:h", ruleId: "redundant_direct_access", subjectType: "identity", severity: "medium", severityLabel: "Medium", severityTone: "attention", confidence: "high", confidenceLabel: "High confidence", title: "Overlap", summary: "s", guidance: null, subject: { kind: "identity", label: "Ada", href: `/access/identities/${UUID}` }, evidenceRows: [], staleEvidence: false, ...over });
const completeOverview = (findings: GovernanceFindingView[]) => ({ ok: true as const, data: { status: "complete" as const, counts: { identities: 1, groups: 0, applications: 1, memberships: 0, directAssignments: 1, groupAssignments: 0 }, breakdown: { directOnly: 1, groupOnly: 0, both: 0 }, effectiveRelationships: 1, governanceFindingsTotal: findings.length, summary: { total: findings.length, bySeverity: { info: 0, low: 0, medium: findings.length, high: 0 } }, findings } });
const req = (url: string) => new Request(`http://localhost${url}`);

describe("findings export route — auth parity, complete-only, cap, headers", () => {
  it("forbidden (owner/admin gate) → 403, no CSV", async () => {
    loaders.overview.mockResolvedValue({ ok: false, error: "forbidden" });
    const res = await findingsExport(req("/access/findings/export"));
    expect(res.status).toBe(403);
    expect(res.headers.get("content-type")).not.toContain("text/csv");
  });
  it("query_failed → 503", async () => {
    loaders.overview.mockResolvedValue({ ok: false, error: "query_failed" });
    expect((await findingsExport(req("/access/findings/export"))).status).toBe(503);
  });
  it("incomplete evaluation (too_large) → 409, never a partial export", async () => {
    loaders.overview.mockResolvedValue({ ok: true, data: { status: "too_large", counts: { identities: 99999, groups: 1, applications: 1, memberships: 1, directAssignments: 1, groupAssignments: 0 } } });
    const res = await findingsExport(req("/access/findings/export"));
    expect(res.status).toBe(409);
    expect((await res.text()).toLowerCase()).toContain("cannot be evaluated");
  });
  it("complete → 200 CSV attachment with private/no-store/nosniff headers, filtered rows", async () => {
    loaders.overview.mockResolvedValue(completeOverview([finding({ id: "a", severity: "high", title: "High one" }), finding({ id: "b", severity: "low", title: "Low one" })]));
    const res = await findingsExport(req("/access/findings/export?severity=high"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/csv; charset=utf-8");
    expect(res.headers.get("content-disposition")).toMatch(/^attachment; filename="access-findings-\d{4}-\d{2}-\d{2}\.csv"$/);
    expect(res.headers.get("cache-control")).toBe("no-store, private");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    const body = await res.text();
    expect(body).toContain("High one");
    expect(body).not.toContain("Low one"); // severity=high filter applied
  });
  it("above the 10,000-row cap → 413, refuses (no truncation)", async () => {
    const many = Array.from({ length: 10_001 }, (_, i) => finding({ id: `f${i}` }));
    loaders.overview.mockResolvedValue(completeOverview(many));
    const res = await findingsExport(req("/access/findings/export"));
    expect(res.status).toBe(413);
    expect((await res.text()).toLowerCase()).toContain("row");
  });
});

describe("identity export route — not-found indistinguishable, bounded, ok", () => {
  const p = (id: string) => ({ params: Promise.resolve({ id }) });
  it("not_found (foreign == missing == denied) → 404", async () => {
    loaders.identity.mockResolvedValue({ ok: false, error: "not_found" });
    expect((await identityExport(req(`/access/identities/${UUID}/export`), p(UUID))).status).toBe(404);
  });
  it("bounded subgraph → 409", async () => {
    loaders.identity.mockResolvedValue({ ok: true, data: { id: UUID, displayName: "Ada", providerLabel: "okta", syncState: "current", staleSince: null, bounded: true, effectiveApplicationCount: 0, applications: [], findings: [] } });
    expect((await identityExport(req(`/access/identities/${UUID}/export`), p(UUID))).status).toBe(409);
  });
  it("ok → 200 CSV with the identity's applications, filters applied", async () => {
    loaders.identity.mockResolvedValue({ ok: true, data: { id: UUID, displayName: "Ada Lovelace", providerLabel: "okta", syncState: "current", staleSince: null, bounded: false, effectiveApplicationCount: 2, applications: [
      { applicationId: "a", applicationLabel: "Salesforce", classification: "DIRECT", classificationLabel: "Direct", explanation: "", groupPaths: [], staleEvidence: false },
      { applicationId: "b", applicationLabel: "Slack", classification: "GROUP", classificationLabel: "Through group", explanation: "", groupPaths: [{ groupId: "9c000000-0000-4000-8000-0000000090a1", groupLabel: "All", staleEvidence: false }], staleEvidence: false },
    ], findings: [] } });
    const res = await identityExport(req(`/access/identities/${UUID}/export?classification=DIRECT`), p(UUID));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toContain("identity-access-");
    const body = await res.text();
    expect(body).toContain("Salesforce");
    expect(body).not.toContain("Slack"); // classification=DIRECT applied
    expect(body).not.toContain(UUID);    // no canonical id in output
  });
});

describe("application export route — not-found indistinguishable, ok", () => {
  const p = (id: string) => ({ params: Promise.resolve({ id }) });
  it("not_found → 404", async () => {
    loaders.application.mockResolvedValue({ ok: false, error: "not_found" });
    expect((await applicationExport(req(`/access/applications/${UUID}/export`), p(UUID))).status).toBe(404);
  });
  it("ok → 200 CSV with the application's identities", async () => {
    loaders.application.mockResolvedValue({ ok: true, data: { id: UUID, displayName: "Salesforce", providerLabel: "okta", syncState: "current", staleSince: null, catalogMatchStatus: "matched", bounded: false, effectiveIdentityCount: 1, directOnlyCount: 1, groupOnlyCount: 0, bothCount: 0, identities: [{ identityId: "x", identityLabel: "Ada", classification: "DIRECT", classificationLabel: "Direct", staleEvidence: false }], assignedGroups: [], findings: [] } });
    const res = await applicationExport(req(`/access/applications/${UUID}/export`), p(UUID));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toContain("application-access-");
    expect(await res.text()).toContain("Ada");
  });
});
