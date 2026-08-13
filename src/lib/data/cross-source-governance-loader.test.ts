// Phase 17 — the tenant loader.
//
// The property this suite exists to protect: **a failed read must never look like an empty estate.** Once those two are
// the same `[]`, the engine cannot tell "no orphaned accounts" from "we could not look", and 0083 closes findings on
// the strength of a query that never ran. Most cases below are one restatement of that; the rest pin pagination (where
// "page one is enough" is the quiet way a loader lies) and the loader/engine/0083 boundary.

import { describe, expect, it, vi, beforeEach } from "vitest";

const gate = vi.hoisted(() => ({ value: { ok: true, tenantId: "t-a" } as { ok: boolean; tenantId?: string } }));
vi.mock("./access-repository", () => ({ accessGate: async () => gate.value }));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => { throw new Error("must not build a real client"); } }));

import {
  loadCrossSourceGovernanceInput, evaluateTenantCrossSourceGovernance, type LoaderIo,
} from "./cross-source-governance-loader";

const OKTA = "conn-okta";
const SLACK = "conn-slack";

type Rows = Record<string, unknown[]>;
const ok = (data: unknown) => ({ data, error: null });

// A fake I/O that serves fixed row sets and pages them the way the real RPCs do.
function makeIo(rows: Rows, opts: { fail?: string[]; connectorsError?: boolean; connectors?: unknown[] } = {}): LoaderIo & { calls: string[] } {
  const calls: string[] = [];
  const paged = (all: unknown[], args: Record<string, unknown>): unknown[] => {
    const limit = Number(args.p_limit ?? 500);
    if (args.p_offset !== undefined) {
      // 0078 returns `count(*) over ()` on every row: the size of the whole matching set, not of the page.
      const slice = all.slice(Number(args.p_offset), Number(args.p_offset) + limit);
      return slice.map(r => ({ ...(r as object), total_count: all.length }));
    }
    const after = args.p_after_id as string | null;
    const start = after ? all.findIndex(r => (r as { id: string }).id === after) + 1 : 0;
    return all.slice(start, start + limit);
  };
  return {
    calls,
    rpc: async (name, args) => {
      calls.push(name);
      if (opts.fail?.includes(name)) return { data: null, error: { message: "relation \"x\" does not exist at 1:2" } };
      if (name === "product_application_matcher_state") return ok(rows.matcher ?? [{ has_ever_run: false, status: null, last_completed_at: null }]);
      if (name === "product_connector_capabilities") return ok(rows.capabilities ?? []);
      if (name === "product_sync_governance_findings") {
        return ok({ reported: (args.p_findings as unknown[]).length, opened: (args.p_findings as unknown[]).length, reopened: 0, refreshed: 0, closed: 0, withheld_from_closure: 0 });
      }
      const key = { product_app_accounts: "accounts", product_list_directory_identities: "identities", product_list_directory_applications: "applications", product_person_account_links: "links", product_application_matches: "matches" }[name];
      return ok(paged(rows[key as string] ?? [], args));
    },
    connectors: async () =>
      opts.connectorsError
        ? { data: null, error: { message: "connection refused to db.internal:5432" } }
        : ok(opts.connectors ?? [{ id: OKTA, provider: "okta" }, { id: SLACK, provider: "slack" }]),
  };
}

const account = (id: string, o: Record<string, unknown> = {}) => ({
  id, connection_id: SLACK, provider: "slack", sync_status: "current",
  account_kind: "human", account_status: "active", is_admin: null, ...o,
});
const identity = (id: string, o: Record<string, unknown> = {}) => ({
  id, connection_id: OKTA, provider: "okta", sync_status: "current", is_active: true, ...o,
});
const linkRow = (id: string, o: Record<string, unknown> = {}) => ({
  id, person_id: "p1", identity_account_id: null, app_account_id: null, status: "proposed", ...o,
});
const cap = (connection_id: string, capability: string, state = "available") => ({ connection_id, capability, state });
const BOTH_AVAILABLE = [cap(OKTA, "identity"), cap(SLACK, "app_accounts")];
const id = (p: string, i: number) => `${p}${String(i).padStart(6, "0")}`;

beforeEach(() => { gate.value = { ok: true, tenantId: "t-a" }; });

describe("happy path and shape", () => {
  it("assembles every input the engine declares", async () => {
    const io = makeIo({
      accounts: [account("a1")], identities: [identity("i1")],
      applications: [{ id: "d1", connection_id: OKTA, provider: "okta", sync_status: "current" }],
      links: [linkRow("l1", { app_account_id: "a1", status: "accepted" })],
      matches: [{ id: "m1", directory_application_id: "d1", status: "accepted" }],
      capabilities: BOTH_AVAILABLE,
      matcher: [{ has_ever_run: true, status: "completed", last_completed_at: "2026-01-01T00:00:00Z" }],
    });
    const r = await loadCrossSourceGovernanceInput("t-a", io);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.input.tenantId).toBe("t-a");
    expect(r.input.appAccounts).toEqual([{ id: "a1", connectionId: SLACK, provider: "slack", syncStatus: "current", accountKind: "human", accountStatus: "active", isAdmin: null }]);
    expect(r.input.identityAccounts[0].isActive).toBe(true);
    expect(r.input.personAccountLinks[0]).toEqual({ personId: "p1", identityAccountId: null, appAccountId: "a1", status: "accepted" });
    expect(r.input.applicationMatches[0]).toEqual({ directoryApplicationId: "d1", status: "accepted" });
    expect(r.input.matcherState).toEqual({ hasEverRun: true, status: "completed", lastCompletedAt: "2026-01-01T00:00:00Z" });
    // Provider is joined from `connectors` — the capability RPC does not return one.
    expect(r.input.capabilities).toContainEqual({ connectionId: OKTA, provider: "okta", capability: "identity", state: "available" });
  });

  it("loads STALE rows deliberately, leaving the meaning of staleness to the engine", async () => {
    const io = makeIo({ accounts: [account("a1", { sync_status: "stale" })], capabilities: BOTH_AVAILABLE });
    const r = await loadCrossSourceGovernanceInput("t-a", io);
    expect(r.ok && r.input.appAccounts[0].syncStatus).toBe("stale");
  });

  it("a COMPLETE source with zero rows is an empty array — the honest empty", async () => {
    const io = makeIo({ accounts: [], capabilities: BOTH_AVAILABLE });
    const r = await loadCrossSourceGovernanceInput("t-a", io);
    expect(r.ok).toBe(true);
    expect(r.ok && r.input.appAccounts).toEqual([]);
    expect(r.ok && r.input.capabilities.length).toBe(2);
  });
});

describe("read failure is not an empty result", () => {
  it.each([
    "product_app_accounts", "product_list_directory_identities", "product_list_directory_applications",
    "product_person_account_links", "product_application_matches", "product_connector_capabilities",
    "product_application_matcher_state",
  ])("a failed %s fails the whole load rather than returning []", async name => {
    const io = makeIo({ capabilities: BOTH_AVAILABLE }, { fail: [name] });
    const r = await loadCrossSourceGovernanceInput("t-a", io);
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.error).toBe("query_failed");
  });

  it("a failed connectors read fails the load", async () => {
    const io = makeIo({ capabilities: BOTH_AVAILABLE }, { connectorsError: true });
    const r = await loadCrossSourceGovernanceInput("t-a", io);
    expect(r.ok === false && r.error).toBe("query_failed");
  });

  it("never leaks SQL, a connection string or a raw error into the result", async () => {
    const io = makeIo({}, { fail: ["product_app_accounts"] });
    const r = await loadCrossSourceGovernanceInput("t-a", io);
    const serialized = JSON.stringify(r);
    expect(serialized).not.toMatch(/relation|does not exist|5432|db\.internal|select |at 1:2/i);
    expect(r.ok === false && r.error).toBe("query_failed");
  });

  it("a thrown transport error is sanitized into the same bounded value", async () => {
    const io: LoaderIo = {
      rpc: async () => { throw new Error("ECONNREFUSED db.internal:5432"); },
      connectors: async () => ok([]),
    };
    const r = await loadCrossSourceGovernanceInput("t-a", io);
    expect(r.ok === false && r.error).toBe("query_failed");
    expect(JSON.stringify(r)).not.toMatch(/ECONNREFUSED|5432/);
  });

  it("an unreadable matcher state is not reported as 'never ran'", async () => {
    // Zero rows from that RPC means the tenant-role gate refused. Calling it "never ran" would be a claim about the
    // customer's estate made from a fact about our own access.
    const io = makeIo({ matcher: [] });
    const r = await loadCrossSourceGovernanceInput("t-a", io);
    expect(r.ok === false && r.error).toBe("not_authorized");
  });
});

describe("capability truthfulness", () => {
  it("preserves a non-available state rather than dropping the source to zero", async () => {
    const io = makeIo({ capabilities: [cap(OKTA, "identity", "plan_dependent"), cap(SLACK, "app_accounts", "failed")] });
    const r = await loadCrossSourceGovernanceInput("t-a", io);
    expect(r.ok && r.input.capabilities.map(c => c.state).sort()).toEqual(["failed", "plan_dependent"]);
  });

  it("drops a capability naming a connection this tenant does not own", async () => {
    const io = makeIo({ capabilities: [cap("conn-foreign", "identity"), cap(OKTA, "identity")] });
    const r = await loadCrossSourceGovernanceInput("t-a", io);
    expect(r.ok && r.input.capabilities.map(c => c.connectionId)).toEqual([OKTA]);
  });

  it("drops a capability outside the engine's vocabulary rather than passing an unknown through", async () => {
    const io = makeIo({ capabilities: [cap(OKTA, "telepathy"), cap(OKTA, "identity")] });
    const r = await loadCrossSourceGovernanceInput("t-a", io);
    expect(r.ok && r.input.capabilities.map(c => c.capability)).toEqual(["identity"]);
  });

  it("a tenant with no declared capability yields none — not a fabricated available one", async () => {
    const io = makeIo({ accounts: [account("a1")], capabilities: [] });
    const r = await loadCrossSourceGovernanceInput("t-a", io);
    expect(r.ok && r.input.capabilities).toEqual([]);
  });
});

describe("pagination loads everything, exactly once", () => {
  const many = (n: number, f: (i: number) => unknown) => Array.from({ length: n }, (_, i) => f(i));

  it("loads >500 person links completely, with no duplicate and no skip", async () => {
    const links = many(1201, i => linkRow(`l${String(i).padStart(5, "0")}`, { app_account_id: `a${i}` }));
    const r = await loadCrossSourceGovernanceInput("t-a", makeIo({ links, capabilities: BOTH_AVAILABLE }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.input.personAccountLinks).toHaveLength(1201);
    expect(new Set(r.input.personAccountLinks.map(l => l.appAccountId)).size).toBe(1201);
  });

  it("loads >500 application matches completely", async () => {
    const matches = many(1000, i => ({ id: `m${String(i).padStart(5, "0")}`, directory_application_id: `d${i}`, status: "accepted" }));
    const r = await loadCrossSourceGovernanceInput("t-a", makeIo({ matches, capabilities: BOTH_AVAILABLE }));
    expect(r.ok && r.input.applicationMatches).toHaveLength(1000);
    expect(r.ok && new Set(r.input.applicationMatches.map(m => m.directoryApplicationId)).size).toBe(1000);
  });

  it("pages the offset-based account read to exhaustion", async () => {
    const accounts = many(1300, i => account(`a${String(i).padStart(5, "0")}`));
    const r = await loadCrossSourceGovernanceInput("t-a", makeIo({ accounts, capabilities: BOTH_AVAILABLE }));
    expect(r.ok && r.input.appAccounts).toHaveLength(1300);
    expect(r.ok && new Set(r.input.appAccounts.map(a => a.id)).size).toBe(1300);
  });

  it("pages the 100-row directory reads to exhaustion", async () => {
    const identities = many(250, i => identity(`i${String(i).padStart(5, "0")}`));
    const r = await loadCrossSourceGovernanceInput("t-a", makeIo({ identities, capabilities: BOTH_AVAILABLE }));
    expect(r.ok && r.input.identityAccounts).toHaveLength(250);
  });

  it("never asks for a page wider than the RPC's own cap", async () => {
    const io = makeIo({ accounts: [account("a1")], capabilities: BOTH_AVAILABLE });
    const seen: number[] = [];
    const wrapped: LoaderIo = { ...io, rpc: async (n, a) => { if (a.p_limit) seen.push(Number(a.p_limit)); return io.rpc(n, a); } };
    await loadCrossSourceGovernanceInput("t-a", wrapped);
    expect(Math.max(...seen)).toBeLessThanOrEqual(500);
  });

  it("FAILS rather than silently truncating if a cursor stops advancing", async () => {
    // A page that is always full and always the same row would loop forever; the backstop must fail, because a partial
    // load understates the estate and could close findings that are still true.
    const stuck: LoaderIo = {
      rpc: async name => {
        if (name === "product_person_account_links") return ok(Array.from({ length: 500 }, () => linkRow("same")));
        if (name === "product_application_matcher_state") return ok([{ has_ever_run: false, status: null, last_completed_at: null }]);
        return ok([]);
      },
      connectors: async () => ok([]),
    };
    const r = await loadCrossSourceGovernanceInput("t-a", stuck);
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.error).toBe("pagination_contract_violated");
  });
});

describe("determinism and provider neutrality", () => {
  const rows = {
    accounts: [account("a2"), account("a1")], identities: [identity("i1")],
    links: [linkRow("l1", { app_account_id: "a9", status: "accepted" })], capabilities: BOTH_AVAILABLE,
  };

  it("the same canonical state produces the same input twice", async () => {
    const a = await loadCrossSourceGovernanceInput("t-a", makeIo(rows));
    const b = await loadCrossSourceGovernanceInput("t-a", makeIo(rows));
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
  });

  it("an unknown provider loads with identical semantics", async () => {
    const io = makeIo(
      { accounts: [account("a1", { connection_id: "conn-x", provider: "some_future_saas" })], capabilities: [cap("conn-x", "app_accounts")] },
      { connectors: [{ id: "conn-x", provider: "some_future_saas" }] },
    );
    const r = await loadCrossSourceGovernanceInput("t-a", io);
    expect(r.ok && r.input.appAccounts[0].provider).toBe("some_future_saas");
    expect(r.ok && r.input.capabilities[0].state).toBe("available");
  });
});

describe("orchestration: authorize -> load -> evaluate -> 0083", () => {
  const orphanRows = {
    accounts: [account("a1")], identities: [identity("i1")],
    links: [linkRow("l1", { identity_account_id: "i1", status: "accepted" })],
    capabilities: BOTH_AVAILABLE,
  };

  it("refuses an unauthorized caller before touching anything", async () => {
    gate.value = { ok: false };
    const io = makeIo({});
    const r = await evaluateTenantCrossSourceGovernance(io);
    expect(r.ok === false && r.error).toBe("not_authorized");
    expect(io.calls).toEqual([]);
  });

  it("syncs ONLY the cross_source engine, and passes the engine's complete set", async () => {
    let synced: Record<string, unknown> | null = null;
    const io = makeIo(orphanRows);
    const spy: LoaderIo = { ...io, rpc: async (n, a) => { if (n === "product_sync_governance_findings") synced = a; return io.rpc(n, a); } };
    const r = await evaluateTenantCrossSourceGovernance(spy);
    expect(r.ok).toBe(true);
    expect(synced).not.toBeNull();
    expect(synced!.p_engine).toBe("cross_source");
    // Provider-local findings are Phase 14's; this path must never name that engine.
    expect(JSON.stringify(synced)).not.toContain("provider_local");
    expect(synced!.p_complete_connection_ids).toEqual([OKTA, SLACK].sort());
    expect(synced!.p_tenant_id).toBe("t-a");
  });

  it("a load failure syncs NOTHING, so a failed read can never close a finding", async () => {
    const io = makeIo(orphanRows, { fail: ["product_app_accounts"] });
    const r = await evaluateTenantCrossSourceGovernance(io);
    expect(r.ok === false && r.error).toBe("query_failed");
    expect(io.calls).not.toContain("product_sync_governance_findings");
  });

  it("an INCOMPLETE source is excluded from the closure set", async () => {
    const io = makeIo({ ...orphanRows, capabilities: [cap(OKTA, "identity"), cap(SLACK, "app_accounts", "incomplete")] });
    let synced: Record<string, unknown> | null = null;
    const spy: LoaderIo = { ...io, rpc: async (n, a) => { if (n === "product_sync_governance_findings") synced = a; return io.rpc(n, a); } };
    await evaluateTenantCrossSourceGovernance(spy);
    expect(synced!.p_complete_connection_ids).toEqual([OKTA]);
  });

  it("reports the engine's withheld rules rather than presenting them as zero findings", async () => {
    const io = makeIo({ ...orphanRows, capabilities: [cap(OKTA, "identity")] });
    const r = await evaluateTenantCrossSourceGovernance(io);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.summary.withheldRules.length).toBeGreaterThan(0);
    expect(r.summary.withheldRules.map(w => w.ruleId)).toContain("active_saas_account_without_accepted_identity");
  });

  it("rule 5 follows the matcher STATE, not the match row count", async () => {
    const base = {
      applications: [{ id: "d1", connection_id: OKTA, provider: "okta", sync_status: "current" }],
      capabilities: [cap(OKTA, "directory_applications")], matches: [],
    };
    const withheld = await evaluateTenantCrossSourceGovernance(
      makeIo({ ...base, matcher: [{ has_ever_run: true, status: "failed", last_completed_at: "2026-01-01T00:00:00Z" }] }),
    );
    expect(withheld.ok && withheld.summary.withheldRules.map(w => w.ruleId))
      .toContain("discovered_application_unmanaged_by_idp");

    const evaluated = await evaluateTenantCrossSourceGovernance(
      makeIo({ ...base, matcher: [{ has_ever_run: true, status: "completed", last_completed_at: "2026-01-02T00:00:00Z" }] }),
    );
    expect(evaluated.ok && evaluated.summary.evaluatedRules).toContain("discovered_application_unmanaged_by_idp");
    // Completed with ZERO matches: the absence is now meaningful, so the application is reported.
    expect(evaluated.ok && evaluated.summary.reported).toBe(1);
  });

  it("builds no elevated client — the injected io is the only database access", async () => {
    // `createClient` is mocked to throw; reaching it at all would fail this test.
    const io = makeIo(orphanRows);
    await expect(evaluateTenantCrossSourceGovernance(io)).resolves.toMatchObject({ ok: true });
  });

  it("sanitizes a sync failure", async () => {
    const io = makeIo(orphanRows, { fail: ["product_sync_governance_findings"] });
    const r = await evaluateTenantCrossSourceGovernance(io);
    expect(r.ok === false && r.error).toBe("query_failed");
    expect(JSON.stringify(r)).not.toMatch(/relation|5432|does not exist/i);
  });
});

// ── Independent review of #415 ────────────────────────────────────────────────────────────────────────────────────
describe("review: page-boundary arithmetic", () => {
  const many = (n: number, f: (i: number) => unknown) => Array.from({ length: n }, (_, i) => f(i));

  // The classic off-by-one: a source holding EXACTLY one page must not stop one page early, and must not loop.
  it.each([
    ["cursor, exactly one page", 500],
    ["cursor, one more than a page", 501],
    ["cursor, exactly two pages", 1000],
  ])("%s loads every row once", async (_label, n) => {
    const links = many(n, i => linkRow(id("l", i), { app_account_id: id("a", i) }));
    const r = await loadCrossSourceGovernanceInput("t-a", makeIo({ links, capabilities: BOTH_AVAILABLE }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.input.personAccountLinks).toHaveLength(n);
    expect(new Set(r.input.personAccountLinks.map(l => l.appAccountId)).size).toBe(n);
  });

  it.each([
    ["offset, exactly one page", 500],
    ["offset, one more than a page", 501],
  ])("%s loads every account once", async (_label, n) => {
    const accounts = many(n, i => account(id("a", i)));
    const r = await loadCrossSourceGovernanceInput("t-a", makeIo({ accounts, capabilities: BOTH_AVAILABLE }));
    expect(r.ok && r.input.appAccounts).toHaveLength(n);
    expect(r.ok && new Set(r.input.appAccounts.map(a => a.id)).size).toBe(n);
  });

  it.each([["directory, exactly one page", 100], ["directory, one more", 101]])(
    "%s loads every identity once", async (_label, n) => {
      const identities = many(n, i => identity(id("i", i)));
      const r = await loadCrossSourceGovernanceInput("t-a", makeIo({ identities, capabilities: BOTH_AVAILABLE }));
      expect(r.ok && r.input.identityAccounts).toHaveLength(n);
    },
  );

  it("a source with zero rows loads as an empty array, not a failure", async () => {
    const r = await loadCrossSourceGovernanceInput("t-a", makeIo({ links: [], capabilities: BOTH_AVAILABLE }));
    expect(r.ok && r.input.personAccountLinks).toEqual([]);
  });

  // MAX_PAGES is a runaway backstop, not a product limit. Reaching it must FAIL, because a truncated estate returned
  // as success would understate the graph and could close findings that are still true.
  it("FAILS rather than truncating when the page backstop is reached", async () => {
    let served = 0;
    const runaway: LoaderIo = {
      rpc: async (name, args) => {
        if (name === "product_application_matcher_state") return ok([{ has_ever_run: false, status: null, last_completed_at: null }]);
        if (name !== "product_person_account_links") return ok([]);
        // Always a FULL page with a strictly advancing cursor — the shape of a source larger than the backstop.
        const page = served++;
        void args;
        return ok(Array.from({ length: 500 }, (_, i) => linkRow(id("l", page * 500 + i))));
      },
      connectors: async () => ok([]),
    };
    const r = await loadCrossSourceGovernanceInput("t-a", runaway);
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.error).toBe("page_limit_exceeded");
    expect(served).toBeGreaterThan(100); // it really did try, rather than giving up early
  });

  // The recovered probe from the paused review. Its ORIGINAL expectation was silent deduplication; review rejected
  // that. A duplicate id means the canonical read is MALFORMED, and deduplicating would hide the broken RPC while
  // presenting incomplete evidence as complete — the loader would then hand the engine a graph it has no right to
  // trust, and 0083 could close findings against it. Fail closed instead: no graph, no evaluation, no sync.
  it("FAILS CLOSED when an offset page repeats a row, rather than deduplicating it away", async () => {
    let call = 0;
    const overlapping: LoaderIo = {
      rpc: async name => {
        if (name === "product_application_matcher_state") return ok([{ has_ever_run: false, status: null, last_completed_at: null }]);
        if (name !== "product_app_accounts") return ok([]);
        call++;
        if (call === 1) return ok(Array.from({ length: 500 }, (_, i) => account(id("a", i))));
        if (call === 2) return ok([account(id("a", 499)), account(id("a", 500))]);
        return ok([]);
      },
      connectors: async () => ok([]),
    };
    const r = await loadCrossSourceGovernanceInput("t-a", overlapping);
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.error).toBe("pagination_contract_violated");
  });

  it.each([
    ["a repeated id inside one cursor page", [linkRow("l001"), linkRow("l001")]],
    ["a backward id inside one cursor page", [linkRow("l002"), linkRow("l001")]],
  ])("FAILS CLOSED on %s", async (_label, page) => {
    const bad: LoaderIo = {
      rpc: async name => {
        if (name === "product_application_matcher_state") return ok([{ has_ever_run: false, status: null, last_completed_at: null }]);
        if (name !== "product_person_account_links") return ok([]);
        return ok(page);
      },
      connectors: async () => ok([]),
    };
    const r = await loadCrossSourceGovernanceInput("t-a", bad);
    expect(r.ok === false && r.error).toBe("pagination_contract_violated");
  });

  // M5's regression target, stated as the harm rather than the mechanism: a duplicated account is exactly what rule 4
  // reads as one person holding two active accounts in one connection.
  it("a duplicated account can never reach the engine as a false duplicate-account finding", async () => {
    let call = 0;
    const dup = account("a-dup");
    const io: LoaderIo = {
      rpc: async (name, args) => {
        if (name === "product_application_matcher_state") return ok([{ has_ever_run: false, status: null, last_completed_at: null }]);
        if (name === "product_person_account_links") {
          return Number(args.p_after_id ?? 0) ? ok([]) : ok([linkRow("l1", { app_account_id: "a-dup", status: "accepted" })]);
        }
        if (name !== "product_app_accounts") return ok([]);
        call++;
        // The same real account served on two consecutive offset pages.
        return call <= 2 ? ok(Array.from({ length: 500 }, (_, i) => (i === 0 ? dup : account(id(`p${call}`, i))))) : ok([]);
      },
      connectors: async () => ok([{ id: SLACK, provider: "slack" }]),
    };
    const r = await loadCrossSourceGovernanceInput("t-a", io);
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.error).toBe("pagination_contract_violated");
  });
});

describe("review: a SKIPPED row is caught by the server's own set size", () => {
  // The dangerous half of offset instability. A duplicate is visible; a skip is not — and a missing account silently
  // withholds its finding while its connection stays closure-eligible, so 0083 resolves something still true.
  // `count(*) over ()` (0078) makes it observable without a migration.
  it("FAILS CLOSED when fewer rows are assembled than the server says exist", async () => {
    const io: LoaderIo = {
      rpc: async (name, args) => {
        if (name === "product_application_matcher_state") return ok([{ has_ever_run: false, status: null, last_completed_at: null }]);
        if (name !== "product_app_accounts") return ok([]);
        // The server reports 501 rows exist, but the pages only ever yield 500 — one row fell through the boundary.
        if (Number(args.p_offset) === 0) {
          return ok(Array.from({ length: 500 }, (_, i) => ({ ...(account(id("a", i)) as object), total_count: 501 })));
        }
        return ok([]);
      },
      connectors: async () => ok([]),
    };
    const r = await loadCrossSourceGovernanceInput("t-a", io);
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.error).toBe("pagination_contract_violated");
  });

  it("FAILS CLOSED when the set size changes between pages", async () => {
    const io: LoaderIo = {
      rpc: async (name, args) => {
        if (name === "product_application_matcher_state") return ok([{ has_ever_run: false, status: null, last_completed_at: null }]);
        if (name !== "product_app_accounts") return ok([]);
        const off = Number(args.p_offset);
        // A connector run inserted rows underneath the read: the second statement sees a bigger set.
        const total = off === 0 ? 1000 : 1001;
        const page = Array.from({ length: off === 0 ? 500 : 500 }, (_, i) => ({ ...(account(id("a", off + i)) as object), total_count: total }));
        return ok(off >= 1000 ? [] : page);
      },
      connectors: async () => ok([]),
    };
    const r = await loadCrossSourceGovernanceInput("t-a", io);
    expect(r.ok === false && r.error).toBe("pagination_contract_violated");
  });

  it("accepts a read whose assembled size matches the server's count", async () => {
    const accounts = Array.from({ length: 501 }, (_, i) => account(id("a", i)));
    const r = await loadCrossSourceGovernanceInput("t-a", makeIo({ accounts, capabilities: BOTH_AVAILABLE }));
    expect(r.ok).toBe(true);
    expect(r.ok && r.input.appAccounts).toHaveLength(501);
  });
});

describe("review: the io seam cannot prove what the real RPCs could not satisfy", () => {
  it("sends each read exactly the arguments its migration declares", async () => {
    const seen: { name: string; args: Record<string, unknown> }[] = [];
    const io = makeIo({ accounts: [account("a1")], capabilities: BOTH_AVAILABLE });
    const spy: LoaderIo = { ...io, rpc: async (n, a) => { seen.push({ name: n, args: a }); return io.rpc(n, a); } };
    await loadCrossSourceGovernanceInput("t-a", spy);

    const argsFor = (n: string) => seen.find(s => s.name === n)!.args;
    // Every read is tenant-scoped, and the tenant is the verified one.
    for (const s of seen) expect(s.args.p_tenant_id).toBe("t-a");
    // 0078's account read pages by OFFSET; 0061/0085 page by CURSOR. A mock that got this wrong would prove nothing.
    expect(argsFor("product_app_accounts")).toMatchObject({ p_offset: 0, p_include_stale: true, p_connection_id: null });
    expect(argsFor("product_app_accounts").p_after_id).toBeUndefined();
    expect(argsFor("product_list_directory_identities")).toMatchObject({ p_after_id: null, p_include_stale: true });
    expect(argsFor("product_person_account_links")).toMatchObject({ p_after_id: null, p_limit: 500 });
    expect(argsFor("product_application_matches")).toMatchObject({ p_after_id: null, p_limit: 500 });
    // The directory reads cap at 100 server-side; asking for more would be silently clamped and waste a round trip.
    expect(argsFor("product_list_directory_identities").p_limit).toBe(100);
    expect(argsFor("product_connector_capabilities")).toMatchObject({ p_connection_id: null });
    expect(Object.keys(argsFor("product_application_matcher_state"))).toEqual(["p_tenant_id"]);
  });

  // BEHAVIOUR CHANGE, deliberate: a row that fails validation used to be dropped and the load continued. The server's
  // own `count(*) over ()` now shows that for what it is — the loader assembled fewer rows than exist, i.e. missing
  // evidence. Continuing would withhold that account's finding while leaving its connection closure-eligible, which is
  // the same false-closure harm as a skipped page. It never coerces the bad row; it refuses the whole read.
  it("FAILS CLOSED on a malformed row rather than quietly assembling a short set", async () => {
    const io = makeIo({
      accounts: [account("a1"), { id: "bad", connection_id: SLACK, provider: "slack", sync_status: "who_knows", account_kind: "human", account_status: "active" }],
      capabilities: BOTH_AVAILABLE,
    });
    const r = await loadCrossSourceGovernanceInput("t-a", io);
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.error).toBe("pagination_contract_violated");
  });

  // A cursor read has no server-side total, so a malformed row there is still dropped — stated so the difference
  // between the two families is a recorded decision rather than an accident.
  it("drops a malformed row on a CURSOR read, which carries no server-side set size", async () => {
    const io = makeIo({
      links: [linkRow("l1", { app_account_id: "a1" }), { id: "l2", person_id: "p1", status: "nonsense" }],
      capabilities: BOTH_AVAILABLE,
    });
    const r = await loadCrossSourceGovernanceInput("t-a", io);
    expect(r.ok && r.input.personAccountLinks).toHaveLength(1);
  });

  it("rejects a non-array payload where rows are expected", async () => {
    const io: LoaderIo = {
      rpc: async name => {
        if (name === "product_application_matcher_state") return ok([{ has_ever_run: false, status: null, last_completed_at: null }]);
        return ok({ unexpected: "object" });
      },
      connectors: async () => ok([]),
    };
    const r = await loadCrossSourceGovernanceInput("t-a", io);
    expect(r.ok && r.input.appAccounts).toEqual([]);
  });
});

describe("review: an older completion never licenses a current evaluation", () => {
  const base = {
    applications: [{ id: "d1", connection_id: OKTA, provider: "okta", sync_status: "current" }],
    capabilities: [cap(OKTA, "directory_applications")], matches: [],
  };
  const YESTERDAY = "2026-01-01T00:00:00Z";

  it.each([
    ["a run started today after completing yesterday", "running"],
    ["a run that failed today after completing yesterday", "failed"],
  ])("%s withholds rule 5", async (_label, status) => {
    const r = await evaluateTenantCrossSourceGovernance(
      makeIo({ ...base, matcher: [{ has_ever_run: true, status, last_completed_at: YESTERDAY }] }),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.summary.withheldRules.map(w => w.ruleId)).toContain("discovered_application_unmanaged_by_idp");
    expect(r.summary.evaluatedRules).not.toContain("discovered_application_unmanaged_by_idp");
  });
});

describe("review: person links reach the engine unfiltered", () => {
  // Phase 16 reviewed `resolutionHasRun = personAccountLinks.length > 0` and retained it. That reasoning holds only if
  // the loader passes links through untouched — filtering by status here would silently change a reviewed assumption.
  it("passes proposed, accepted and rejected links through without filtering", async () => {
    const io = makeIo({
      links: [
        linkRow("l1", { status: "proposed", app_account_id: "a1" }),
        linkRow("l2", { status: "accepted", app_account_id: "a2" }),
        linkRow("l3", { status: "rejected", app_account_id: "a3" }),
      ],
      capabilities: BOTH_AVAILABLE,
    });
    const r = await loadCrossSourceGovernanceInput("t-a", io);
    expect(r.ok && r.input.personAccountLinks.map(l => l.status).sort()).toEqual(["accepted", "proposed", "rejected"]);
  });
});
