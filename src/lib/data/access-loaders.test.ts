import { describe, it, expect, vi, beforeEach } from "vitest";

// Exercises loadAccessOverview with a MOCKED repository but the REAL assembly + Phase-13/14 engines. Guards that the complete-view StatCard
// counts come from the PAGED (includeStale-scoped) rows — not the stale-agnostic counts-RPC total — so the header matches the evaluated body.
vi.mock("@/lib/data/access-repository", () => ({
  accessGate: vi.fn(), getAccessCounts: vi.fn(),
  listDirectoryIdentities: vi.fn(), listDirectoryGroups: vi.fn(), listDirectoryApplications: vi.fn(),
  listGroupMemberships: vi.fn(), listUserAssignments: vi.fn(), listGroupAssignments: vi.fn(),
  getIdentityAccessSubgraph: vi.fn(), getApplicationAccessSubgraph: vi.fn(),
}));
import * as repoModule from "@/lib/data/access-repository";
import { loadAccessOverview } from "./access-loaders";

const repo = {
  accessGate: vi.mocked(repoModule.accessGate), getAccessCounts: vi.mocked(repoModule.getAccessCounts),
  listDirectoryIdentities: vi.mocked(repoModule.listDirectoryIdentities), listDirectoryGroups: vi.mocked(repoModule.listDirectoryGroups),
  listDirectoryApplications: vi.mocked(repoModule.listDirectoryApplications), listGroupMemberships: vi.mocked(repoModule.listGroupMemberships),
  listUserAssignments: vi.mocked(repoModule.listUserAssignments), listGroupAssignments: vi.mocked(repoModule.listGroupAssignments),
};

const ok = <T>(data: T) => ({ ok: true as const, data });
const identityRow = { id: "i1", connection_id: "c1", provider: "okta", sync_status: "current" as const, stale_since: null, display_name: "Ada", login: null, email: null, is_active: true, status: "active" };

beforeEach(() => {
  vi.clearAllMocks();
  repo.accessGate.mockResolvedValue({ ok: true, tenantId: "t1" });
  repo.listDirectoryIdentities.mockResolvedValue(ok([identityRow]));
  for (const fn of ["listDirectoryGroups", "listDirectoryApplications", "listGroupMemberships", "listUserAssignments", "listGroupAssignments"] as const) repo[fn].mockResolvedValue(ok([]));
});

describe("loadAccessOverview — displayed counts", () => {
  it("complete view: StatCard counts come from the paged rows, NOT the stale-inflated counts-RPC total", async () => {
    // counts RPC returns a stale-agnostic TOTAL far above the current-only paged rows (but under the caps → not too_large).
    repo.getAccessCounts.mockResolvedValue(ok({ identities: 500, groups: 500, applications: 500, memberships: 500, userAssignments: 500, groupAssignments: 500, current: { identities: 500, groups: 500, applications: 500, memberships: 500, userAssignments: 500, groupAssignments: 500 }, stale: { identities: 0, groups: 0, applications: 0, memberships: 0, userAssignments: 0, groupAssignments: 0 }, other: { identities: 0, groups: 0, applications: 0, memberships: 0, userAssignments: 0, groupAssignments: 0 }, totalEvidence: { identities: 500, groups: 500, applications: 500, memberships: 500, userAssignments: 500, groupAssignments: 500 } }));
    const r = await loadAccessOverview(false);
    expect(r.ok).toBe(true);
    if (!r.ok || r.data.status !== "complete") throw new Error("expected complete");
    expect(r.data.counts).toEqual({ identities: 1, groups: 0, applications: 0, memberships: 0, directAssignments: 0, groupAssignments: 0 }); // paged, not 500
  });

  it("too_large gate still uses the RPC total (conservative), showing the total-directory counts", async () => {
    repo.getAccessCounts.mockResolvedValue(ok({ identities: 99999, groups: 1, applications: 1, memberships: 1, userAssignments: 1, groupAssignments: 0, current: { identities: 99999, groups: 1, applications: 1, memberships: 1, userAssignments: 1, groupAssignments: 0 }, stale: { identities: 0, groups: 0, applications: 0, memberships: 0, userAssignments: 0, groupAssignments: 0 }, other: { identities: 0, groups: 0, applications: 0, memberships: 0, userAssignments: 0, groupAssignments: 0 }, totalEvidence: { identities: 99999, groups: 1, applications: 1, memberships: 1, userAssignments: 1, groupAssignments: 0 } }));
    const r = await loadAccessOverview(false);
    if (!r.ok || r.data.status !== "too_large") throw new Error("expected too_large");
    expect(r.data.counts.identities).toBe(99999);
    expect(repo.listDirectoryIdentities).not.toHaveBeenCalled(); // gated before paging
  });

  it("forbidden gate + query_failed propagate", async () => {
    repo.accessGate.mockResolvedValue({ ok: false });
    expect(await loadAccessOverview(false)).toEqual({ ok: false, error: "forbidden" });
    repo.accessGate.mockResolvedValue({ ok: true, tenantId: "t1" });
    repo.getAccessCounts.mockResolvedValue({ ok: false, error: "query_failed" });
    expect(await loadAccessOverview(false)).toEqual({ ok: false, error: "query_failed" });
  });
});

// ── Phase 6: the same split on the Access overview ────────────────────────────────────────────────────────────────────────────
describe("loadAccessOverview — current counts, conservative bound", () => {
  const counts = (cur: Record<string, number>, stale: Record<string, number> = {}) => {
    const z = { identities: 0, groups: 0, applications: 0, memberships: 0, userAssignments: 0, groupAssignments: 0 };
    const c = { ...z, ...cur }, s = { ...z, ...stale }, o = { ...z };
    const total = Object.fromEntries(Object.keys(z).map((k) => [k, (c as never)[k] + (s as never)[k]])) as typeof z;
    return ok({ ...total, current: c, stale: s, other: o, totalEvidence: total });
  };

  it("gates on TOTAL EVIDENCE — a bound that ignored retained rows would under-count the worst case", async () => {
    repo.getAccessCounts.mockResolvedValue(counts({ identities: 2000 }, { identities: 1 }));
    const r = await loadAccessOverview(false);
    if (!r.ok || r.data.status !== "too_large") throw new Error("expected too_large");
  });

  it("DISPLAYS current counts in the too-large fallback — this is the 7-vs-6 fix", async () => {
    // The only place these counts ever reach a screen. Showing the stale-inclusive total here is what made Home report 7 groups.
    repo.getAccessCounts.mockResolvedValue(counts({ identities: 99999, groups: 6 }, { groups: 1 }));
    const r = await loadAccessOverview(false);
    if (!r.ok || r.data.status !== "too_large") throw new Error("expected too_large");
    expect(r.data.counts.groups, "6 current groups, not 7 retained rows").toBe(6);
  });

  it("no surface labels total evidence as the current count", async () => {
    repo.getAccessCounts.mockResolvedValue(counts({ identities: 99999, groups: 6, applications: 2 }, { groups: 1, applications: 3 }));
    const r = await loadAccessOverview(false);
    if (!r.ok || r.data.status !== "too_large") throw new Error("expected too_large");
    expect(r.data.counts.groups).toBe(6);
    expect(r.data.counts.applications).toBe(2);
  });
});
