import { describe, it, expect, vi, beforeEach } from "vitest";

// Phase 2 — the Directory list loaders, exercised against a MOCKED repository so every assertion is about the loader's own decisions:
// which RPC it calls, how many times, what it does with stale rows, and what it refuses to display.
vi.mock("@/lib/data/access-repository", () => ({
  accessGate: vi.fn(), getAccessCounts: vi.fn(),
  listDirectoryIdentities: vi.fn(), listDirectoryGroups: vi.fn(), listDirectoryApplications: vi.fn(),
  listGroupMemberships: vi.fn(), listUserAssignments: vi.fn(), listGroupAssignments: vi.fn(),
  getIdentityAccessSubgraph: vi.fn(), getApplicationAccessSubgraph: vi.fn(),
}));
import * as repoModule from "@/lib/data/access-repository";
import { parseAccessFilters } from "./access-filters";
import {
  loadDirectoryPeople, loadDirectoryGroups, loadDirectoryApplications,
  groupTypeLabel, appStatusLabel, signOnLabel, formatStaleSince, MAX_LIST_NODES,
} from "./directory-loaders";

const repo = {
  accessGate: vi.mocked(repoModule.accessGate),
  getAccessCounts: vi.mocked(repoModule.getAccessCounts),
  listDirectoryIdentities: vi.mocked(repoModule.listDirectoryIdentities),
  listDirectoryGroups: vi.mocked(repoModule.listDirectoryGroups),
  listDirectoryApplications: vi.mocked(repoModule.listDirectoryApplications),
  listGroupMemberships: vi.mocked(repoModule.listGroupMemberships),
  listUserAssignments: vi.mocked(repoModule.listUserAssignments),
  listGroupAssignments: vi.mocked(repoModule.listGroupAssignments),
};

const ok = <T>(data: T) => ({ ok: true as const, data });
const counts = (o: Partial<Record<"identities" | "groups" | "applications" | "memberships" | "userAssignments" | "groupAssignments", number>> = {}) =>
  ok({ identities: 0, groups: 0, applications: 0, memberships: 0, userAssignments: 0, groupAssignments: 0, ...o });

const person = (o: Record<string, unknown> = {}) => ({
  id: "i1", connection_id: "c1", provider: "okta", sync_status: "current" as const, stale_since: null,
  display_name: "Ada Lovelace", login: "ada@example.com", email: "ada@example.com", is_active: true, status: "ACTIVE", ...o,
});
const group = (o: Record<string, unknown> = {}) => ({
  id: "g1", connection_id: "c1", provider: "okta", sync_status: "current" as const, stale_since: null,
  name: "Engineering", group_type_category: "okta_group", ...o,
});
const app = (o: Record<string, unknown> = {}) => ({
  id: "a1", connection_id: "c1", provider: "okta", sync_status: "current" as const, stale_since: null,
  label: "Salesforce", name: "salesforce", status_category: "active", sign_on_category: "saml_2_0", catalog_match_status: "unmatched", ...o,
});

const F = (sp: Record<string, string> = {}) => parseAccessFilters(sp);

beforeEach(() => {
  vi.clearAllMocks();
  repo.accessGate.mockResolvedValue({ ok: true, tenantId: "t1" });
  repo.getAccessCounts.mockResolvedValue(counts({ identities: 1, groups: 1, applications: 1 }));
  repo.listDirectoryIdentities.mockResolvedValue(ok([person()]));
  repo.listDirectoryGroups.mockResolvedValue(ok([group()]));
  repo.listDirectoryApplications.mockResolvedValue(ok([app()]));
});

const complete = <T>(r: Awaited<ReturnType<typeof loadDirectoryPeople>> | { ok: boolean }) => {
  if (!("ok" in r) || !r.ok) throw new Error("expected ok");
  const d = (r as { data: { status: string } }).data;
  if (d.status !== "complete") throw new Error(`expected complete, got ${d.status}`);
  return d as unknown as { paged: { rows: T[]; total: number; page: number; totalPages: number }; totalBeforeFilter: number };
};

// ── the source of truth is the product RPC, never the SaaS-management tables ─────────────────────────────────────────────────────────
describe("data source", () => {
  it("People reads identity_accounts through product_list_directory_identities and nothing else", async () => {
    await loadDirectoryPeople(F());
    expect(repo.listDirectoryIdentities).toHaveBeenCalledTimes(1);
    // The other five list RPCs are the edge/other-node tables. Touching them here would be the N+1 this page must not do.
    for (const fn of ["listDirectoryGroups", "listDirectoryApplications", "listGroupMemberships", "listUserAssignments", "listGroupAssignments"] as const) {
      expect(repo[fn], `${fn} must not be called by the People list`).not.toHaveBeenCalled();
    }
  });

  it("Groups reads directory_groups only; Applications reads directory_applications only", async () => {
    await loadDirectoryGroups(F());
    expect(repo.listDirectoryGroups).toHaveBeenCalledTimes(1);
    expect(repo.listDirectoryIdentities).not.toHaveBeenCalled();
    expect(repo.listGroupMemberships).not.toHaveBeenCalled();

    vi.clearAllMocks();
    repo.accessGate.mockResolvedValue({ ok: true, tenantId: "t1" });
    repo.getAccessCounts.mockResolvedValue(counts({ applications: 1 }));
    repo.listDirectoryApplications.mockResolvedValue(ok([app()]));
    await loadDirectoryApplications(F());
    expect(repo.listDirectoryApplications).toHaveBeenCalledTimes(1);
    expect(repo.listUserAssignments).not.toHaveBeenCalled();
    expect(repo.listGroupAssignments).not.toHaveBeenCalled();
  });

  it("passes the accessGate tenant id to the RPC and never a caller-supplied one", async () => {
    repo.accessGate.mockResolvedValue({ ok: true, tenantId: "tenant-from-gate" });
    await loadDirectoryPeople(F());
    expect(repo.listDirectoryIdentities.mock.calls[0][0]).toBe("tenant-from-gate");
  });
});

// ── authorization + failure ──────────────────────────────────────────────────────────────────────────────────────────────────────────
describe("authorization and failure", () => {
  it("returns forbidden WITHOUT reading any row when the gate denies", async () => {
    repo.accessGate.mockResolvedValue({ ok: false });
    const r = await loadDirectoryPeople(F());
    expect(r).toEqual({ ok: false, error: "forbidden" });
    expect(repo.getAccessCounts).not.toHaveBeenCalled();
    expect(repo.listDirectoryIdentities).not.toHaveBeenCalled();
  });

  it("maps a failed count read and a failed row read to query_failed, never to an empty list", async () => {
    // An empty list would tell the customer their directory is empty. A read failure is a different fact.
    repo.getAccessCounts.mockResolvedValue({ ok: false, error: "query_failed" });
    expect(await loadDirectoryPeople(F())).toEqual({ ok: false, error: "query_failed" });

    repo.getAccessCounts.mockResolvedValue(counts({ identities: 1 }));
    repo.listDirectoryIdentities.mockResolvedValue({ ok: false, error: "query_failed" });
    expect(await loadDirectoryPeople(F())).toEqual({ ok: false, error: "query_failed" });
  });
});

// ── bounded reads: the too-large gate and the absence of N+1 ─────────────────────────────────────────────────────────────────────────
describe("bounded reads", () => {
  it("refuses to page a table above the node ceiling, and reads ZERO rows when it refuses", async () => {
    repo.getAccessCounts.mockResolvedValue(counts({ identities: MAX_LIST_NODES + 1 }));
    const r = await loadDirectoryPeople(F());
    if (!r.ok || r.data.status !== "too_large") throw new Error("expected too_large");
    expect(r.data.total).toBe(MAX_LIST_NODES + 1);
    expect(repo.listDirectoryIdentities, "no row may be read once the ceiling is exceeded").not.toHaveBeenCalled();
  });

  it("gates on the ONE table being listed, not on the whole graph", async () => {
    // A tenant with a huge membership edge count can still list its 3 groups. Gating globally would hide a page that is perfectly safe.
    repo.getAccessCounts.mockResolvedValue(counts({ groups: 3, memberships: 999_999, identities: MAX_LIST_NODES + 1 }));
    const r = await loadDirectoryGroups(F());
    if (!r.ok || r.data.status !== "complete") throw new Error("expected complete");
  });

  it("makes exactly one RPC round trip per 100 rows — no per-row call", async () => {
    const rows = Array.from({ length: 100 }, (_, i) => person({ id: `i${String(i).padStart(3, "0")}` }));
    repo.getAccessCounts.mockResolvedValue(counts({ identities: 150 }));
    repo.listDirectoryIdentities.mockResolvedValueOnce(ok(rows)).mockResolvedValueOnce(ok([person({ id: "i999" })]));
    const d = complete<{ id: string }>(await loadDirectoryPeople(F()));
    expect(d.totalBeforeFilter).toBe(101);
    // 101 rows, page size 100 → exactly 2 calls. A per-row lookup would be 101+.
    expect(repo.listDirectoryIdentities).toHaveBeenCalledTimes(2);
    expect(repo.listDirectoryIdentities.mock.calls[1][1]).toMatchObject({ afterId: "i099", limit: 100 });
  });
});

// ── stale handling ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────
describe("current vs stale", () => {
  it("asks the RPC for current records only by default", async () => {
    await loadDirectoryPeople(F());
    expect(repo.listDirectoryIdentities.mock.calls[0][1]).toMatchObject({ includeStale: false });
  });

  it("includes stale only when the caller asked via ?stale=1", async () => {
    await loadDirectoryPeople(F({ stale: "1" }));
    expect(repo.listDirectoryIdentities.mock.calls[0][1]).toMatchObject({ includeStale: true });
  });

  it("never shows a stale-since date on a CURRENT row", async () => {
    // 0053/0054 set sync_status='current' on re-promotion but do NOT clear stale_since, so a returning person carries a leftover
    // timestamp. Printing it would put a false "last seen" date next to a Current badge.
    repo.listDirectoryIdentities.mockResolvedValue(ok([person({ sync_status: "current", stale_since: "2026-01-05T00:00:00Z" })]));
    const d = complete<{ syncState: string; staleSince: string | null }>(await loadDirectoryPeople(F()));
    expect(d.paged.rows[0].syncState).toBe("current");
    expect(d.paged.rows[0].staleSince, "a current row must carry no stale timestamp").toBeNull();
  });

  it("does show the stale-since date on a genuinely stale row", async () => {
    repo.listDirectoryIdentities.mockResolvedValue(ok([person({ sync_status: "stale", stale_since: "2026-01-05T09:30:00Z" })]));
    const d = complete<{ syncState: string; staleSince: string | null }>(await loadDirectoryPeople(F()));
    expect(d.paged.rows[0].syncState).toBe("stale");
    expect(d.paged.rows[0].staleSince).toBe("2026-01-05T09:30:00Z");
  });

  it("treats every non-current database state as stale rather than inventing a third badge", async () => {
    for (const s of ["stale", "review_required", "disconnected"] as const) {
      repo.listDirectoryIdentities.mockResolvedValue(ok([person({ sync_status: s, stale_since: "2026-01-05T00:00:00Z" })]));
      const d = complete<{ syncState: string }>(await loadDirectoryPeople(F()));
      expect(d.paged.rows[0].syncState, s).toBe("stale");
    }
  });
});

// ── search, ordering, pagination ─────────────────────────────────────────────────────────────────────────────────────────────────────
describe("search, ordering and pagination", () => {
  const people = [
    person({ id: "i3", display_name: "Charlie Brown", login: "charlie@example.com", email: "charlie@example.com" }),
    person({ id: "i1", display_name: "Ada Lovelace", login: "ada@example.com", email: "ada@example.com" }),
    person({ id: "i2", display_name: "Bob Stone", login: "bob@example.com", email: "bob@example.com" }),
  ];

  it("orders by name, not by the uuid the RPC returns", async () => {
    // The RPC's `order by x.id` is deterministic but alphabetically random. Rows arrive here in id order and must not be shown that way.
    repo.getAccessCounts.mockResolvedValue(counts({ identities: 3 }));
    repo.listDirectoryIdentities.mockResolvedValue(ok(people));
    const d = complete<{ name: string }>(await loadDirectoryPeople(F()));
    expect(d.paged.rows.map((r) => r.name)).toEqual(["Ada Lovelace", "Bob Stone", "Charlie Brown"]);
  });

  it("searches the whole directory, not just the visible page", async () => {
    repo.getAccessCounts.mockResolvedValue(counts({ identities: 3 }));
    repo.listDirectoryIdentities.mockResolvedValue(ok(people));
    const d = complete<{ name: string }>(await loadDirectoryPeople(F({ q: "bob", pageSize: "1" })));
    expect(d.paged.rows.map((r) => r.name)).toEqual(["Bob Stone"]);
    expect(d.paged.total).toBe(1);
    // The unfiltered size is preserved so the empty state can say how many records exist.
    expect(d.totalBeforeFilter).toBe(3);
  });

  it("matches the email/login identifier, not only the display name", async () => {
    repo.getAccessCounts.mockResolvedValue(counts({ identities: 3 }));
    repo.listDirectoryIdentities.mockResolvedValue(ok([person({ display_name: "Ada Lovelace", login: "grace@example.com", email: "grace@example.com" })]));
    const d = complete<{ name: string }>(await loadDirectoryPeople(F({ q: "grace" })));
    expect(d.paged.rows).toHaveLength(1);
  });

  it("paginates deterministically", async () => {
    repo.getAccessCounts.mockResolvedValue(counts({ identities: 3 }));
    repo.listDirectoryIdentities.mockResolvedValue(ok(people));
    const p1 = complete<{ name: string }>(await loadDirectoryPeople(F({ pageSize: "2" })));
    expect(p1.paged.rows.map((r) => r.name)).toEqual(["Ada Lovelace", "Bob Stone"]);
    expect(p1.paged.totalPages).toBe(2);
    const p2 = complete<{ name: string }>(await loadDirectoryPeople(F({ pageSize: "2", page: "2" })));
    expect(p2.paged.rows.map((r) => r.name)).toEqual(["Charlie Brown"]);
  });
});

// ── field selection: what is shown and what is deliberately withheld ─────────────────────────────────────────────────────────────────
describe("field selection", () => {
  it("does not repeat the login in the identifier column when it is already the displayed name", async () => {
    repo.listDirectoryIdentities.mockResolvedValue(ok([person({ display_name: null, login: "ada@example.com", email: "ada@example.com" })]));
    const d = complete<{ name: string; secondaryId: string | null }>(await loadDirectoryPeople(F()));
    expect(d.paged.rows[0].name).toBe("ada@example.com");
    expect(d.paged.rows[0].secondaryId).toBeNull();
  });

  it("never surfaces the raw provider status token", async () => {
    // `identity_accounts.status` is written unbucketed by the runner (PROVISIONED, PASSWORD_EXPIRED, …) with no CHECK vocabulary and no
    // label map. `is_active` is the bounded equivalent and is the only account-state field that reaches the view.
    repo.listDirectoryIdentities.mockResolvedValue(ok([person({ status: "PASSWORD_EXPIRED", is_active: false })]));
    const d = complete<Record<string, unknown>>(await loadDirectoryPeople(F()));
    expect(JSON.stringify(d.paged.rows[0])).not.toContain("PASSWORD_EXPIRED");
    expect(d.paged.rows[0].isActive).toBe(false);
  });

  it("suppresses the catalog match when nothing has been matched", async () => {
    // Nothing writes catalog_match_status today, so every row reads 'unmatched'. Rendering that would report a failure that never happened.
    repo.listDirectoryApplications.mockResolvedValue(ok([app({ catalog_match_status: "unmatched" })]));
    const d = complete<{ catalogMatch: string | null }>(await loadDirectoryApplications(F()));
    expect(d.paged.rows[0].catalogMatch).toBeNull();
  });

  it("shows a catalog match when a real one exists", async () => {
    repo.listDirectoryApplications.mockResolvedValue(ok([app({ catalog_match_status: "matched" })]));
    const d = complete<{ catalogMatch: string | null }>(await loadDirectoryApplications(F()));
    expect(d.paged.rows[0].catalogMatch).toBe("matched");
  });

  it("marks built-in groups and only built-in groups", async () => {
    repo.getAccessCounts.mockResolvedValue(counts({ groups: 2 }));
    repo.listDirectoryGroups.mockResolvedValue(ok([group({ id: "g1", name: "Everyone", group_type_category: "built_in" }), group({ id: "g2", name: "Engineering", group_type_category: "okta_group" })]));
    const d = complete<{ name: string; isBuiltIn: boolean }>(await loadDirectoryGroups(F()));
    expect(d.paged.rows.find((r) => r.name === "Everyone")!.isBuiltIn).toBe(true);
    expect(d.paged.rows.find((r) => r.name === "Engineering")!.isBuiltIn).toBe(false);
  });
});

// ── label maps ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
describe("customer-facing labels", () => {
  it("maps the bounded tokens to human labels", () => {
    expect(groupTypeLabel("built_in")).toBe("Built-in");
    expect(appStatusLabel("active")).toBe("Active");
    expect(signOnLabel("saml_2_0")).toBe("SAML 2.0");
    expect(signOnLabel("openid_connect")).toBe("OpenID Connect");
  });

  it("shows an unknown token rather than hiding it behind 'Unknown'", () => {
    // The CHECK vocabularies genuinely drift — directory_groups' CHECK omits 'missing' even though the normalizer can emit it. A token we
    // have not mapped is still information; swallowing it would make a real value invisible.
    expect(groupTypeLabel("a_new_okta_type")).toBe("a_new_okta_type");
    expect(signOnLabel("some_new_mode")).toBe("some_new_mode");
    expect(groupTypeLabel(null)).toBeNull();
  });

  it("formats a stale date without a timezone shift, and refuses a malformed one", () => {
    expect(formatStaleSince("2026-01-05T23:30:00Z")).toBe("2026-01-05");
    expect(formatStaleSince("not a date")).toBeNull();
    expect(formatStaleSince(null)).toBeNull();
  });
});
