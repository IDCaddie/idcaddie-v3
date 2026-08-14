// Phase 18C — matcher orchestration.
//
// The property this suite protects: **the run may only record `completed` over evidence it actually read in full.**
// `completed` is what licenses Rule 5 to call an unmatched application unmanaged, so a half-read estate that completes
// is not a glitch — it is a governance finding asserted from a query that never finished. Every failure path below is
// one restatement of that, plus the two that keep human decisions authoritative.

import { describe, expect, it, vi, beforeEach } from "vitest";

const gate = vi.hoisted(() => ({ value: { ok: true, tenantId: "t-a" } as { ok: boolean; tenantId?: string } }));
vi.mock("./access-repository", () => ({ accessGate: async () => gate.value }));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => { throw new Error("must not build a real client"); } }));

import { runApplicationMatcher, type MatcherIo } from "./application-matcher";

const ok = (data: unknown) => ({ data, error: null });
const ERR = { data: null, error: { message: 'relation "x" does not exist at 1:2 on db.internal:5432' } };

type Opts = {
  census?: string[];
  candidates?: { d: string; p: string; a: string | null }[];
  fail?: string[];
  startUpdated?: number;
  completeUpdated?: number;
  failUpdated?: number;
  proposalStatus?: string | ((i: number) => string);
  throwOn?: string;
};

function makeIo(o: Opts = {}) {
  const calls: string[] = [];
  const proposals: Record<string, unknown>[] = [];
  let proposalIndex = 0;
  const io: MatcherIo = {
    rpc: async (name, args) => {
      calls.push(name);
      if (o.throwOn === name) throw new Error("ECONNREFUSED db.internal:5432");
      if (o.fail?.includes(name)) return ERR;
      if (name === "product_start_application_matcher_run") return ok({ updated: o.startUpdated ?? 1 });
      if (name === "product_complete_application_matcher_run") return ok({ updated: o.completeUpdated ?? 1 });
      if (name === "product_fail_application_matcher_run") return ok({ updated: o.failUpdated ?? 1 });
      if (name === "product_propose_application_match") {
        proposals.push(args);
        const s = typeof o.proposalStatus === "function" ? o.proposalStatus(proposalIndex++) : (o.proposalStatus ?? "proposed");
        return ok({ status: s });
      }
      if (name === "product_list_directory_applications") {
        const all = (o.census ?? []).map(id => ({ id })).sort((x, y) => (x.id < y.id ? -1 : 1));
        const after = args.p_after_id as string | null;
        const start = after ? all.findIndex(r => r.id === after) + 1 : 0;
        return ok(all.slice(start, start + Number(args.p_limit)));
      }
      if (name === "product_application_match_candidates") {
        // Emulate 0090: page PARENTS, then expand each parent's complete instance set.
        const rows = (o.candidates ?? []).map(c => ({ directory_application_id: c.d, app_product_id: c.p, app_id: c.a }));
        const parents = [...new Set(rows.map(r => r.directory_application_id))].sort();
        const after = args.p_after_directory_application_id as string | null;
        const start = after ? parents.indexOf(after) + 1 : 0;
        const page = parents.slice(start, start + Number(args.p_limit));
        return ok(rows.filter(r => page.includes(r.directory_application_id))
          .sort((x, y) => (x.directory_application_id === y.directory_application_id
            ? String(x.app_id ?? "").localeCompare(String(y.app_id ?? ""))
            : x.directory_application_id < y.directory_application_id ? -1 : 1)));
      }
      return ok([]);
    },
  };
  return { io, calls, proposals };
}

beforeEach(() => { gate.value = { ok: true, tenantId: "t-a" }; });

describe("O1/O2 the run starts before anything is read, and a refused start reads nothing", () => {
  it("start is the FIRST call", async () => {
    const { io, calls } = makeIo({ census: ["d1"] });
    await runApplicationMatcher(io);
    expect(calls[0]).toBe("product_start_application_matcher_run");
  });

  it("O2 a start that does not transition performs no read, no proposal and no completion", async () => {
    const { io, calls } = makeIo({ census: ["d1"], candidates: [{ d: "d1", p: "p1", a: "a1" }], startUpdated: 0 });
    const r = await runApplicationMatcher(io);
    expect(r).toEqual({ status: "failed", reason: "run_not_started", failureRecorded: false });
    expect(calls).toEqual(["product_start_application_matcher_run"]);
  });

  it("an unauthorized caller never even starts a run", async () => {
    gate.value = { ok: false };
    const { io, calls } = makeIo();
    const r = await runApplicationMatcher(io);
    expect(r).toMatchObject({ status: "failed", reason: "not_authorized" });
    expect(calls).toEqual([]);
  });
});

describe("O3-O6 every failure records the failure and never completes", () => {
  const cases: [string, Opts, string][] = [
    ["O3 census read fails", { fail: ["product_list_directory_applications"] }, "query_failed"],
    ["O4 candidate read fails", { census: ["d1"], fail: ["product_application_match_candidates"] }, "query_failed"],
    ["O5 feed disagrees with census", { census: ["d1"], candidates: [{ d: "dX", p: "p1", a: "a1" }] }, "evidence_contract_violated"],
    ["O6 a proposal fails", { census: ["d1"], candidates: [{ d: "d1", p: "p1", a: "a1" }], fail: ["product_propose_application_match"] }, "query_failed"],
    ["an unexpected proposal status fails", { census: ["d1"], candidates: [{ d: "d1", p: "p1", a: "a1" }], proposalStatus: "not_allowed" }, "proposal_failed"],
  ];

  it.each(cases)("%s", async (_label, opts, reason) => {
    const { io, calls } = makeIo(opts);
    const r = await runApplicationMatcher(io);
    expect(r).toEqual({ status: "failed", reason, failureRecorded: true });
    expect(calls).toContain("product_fail_application_matcher_run");
    // The load-bearing half: a failed run must never be recorded as complete, because completion is what licenses Rule 5.
    expect(calls).not.toContain("product_complete_application_matcher_run");
  });

  it("a thrown transport error is sanitized and still records the failure", async () => {
    const { io } = makeIo({ census: ["d1"], throwOn: "product_list_directory_applications" });
    const r = await runApplicationMatcher(io);
    expect(r).toEqual({ status: "failed", reason: "query_failed", failureRecorded: true });
    expect(JSON.stringify(r)).not.toMatch(/ECONNREFUSED|5432|relation|db\.internal/);
  });

  it("no failure result leaks SQL, a host or a payload", async () => {
    const { io } = makeIo({ fail: ["product_list_directory_applications"] });
    const r = await runApplicationMatcher(io);
    expect(JSON.stringify(r)).not.toMatch(/relation|does not exist|5432|db\.internal|select /i);
  });

  it("reports when the failure transition itself did not take, without losing the original reason", async () => {
    const { io } = makeIo({ fail: ["product_list_directory_applications"], failUpdated: 0 });
    const r = await runApplicationMatcher(io);
    expect(r).toEqual({ status: "failed", reason: "query_failed", failureRecorded: false });
  });
});

describe("O7/O8 completion happens once, and only after the last write", () => {
  it("completes after every proposal, never before", async () => {
    const { io, calls } = makeIo({
      census: ["d1", "d2"],
      candidates: [{ d: "d1", p: "p1", a: "a1" }, { d: "d2", p: "p2", a: "b1" }, { d: "d2", p: "p2", a: "b2" }],
    });
    const r = await runApplicationMatcher(io);
    expect(r.status).toBe("completed");
    const complete = calls.indexOf("product_complete_application_matcher_run");
    const lastPropose = calls.lastIndexOf("product_propose_application_match");
    expect(complete).toBeGreaterThan(lastPropose);
    expect(calls.filter(c => c === "product_complete_application_matcher_run")).toHaveLength(1);
  });

  it("O9 a completion that does not transition is a FAILURE, not a success", async () => {
    const { io, calls } = makeIo({ census: ["d1"], candidates: [{ d: "d1", p: "p1", a: "a1" }], completeUpdated: 0 });
    const r = await runApplicationMatcher(io);
    expect(r).toEqual({ status: "failed", reason: "matcher_state_failed", failureRecorded: true });
    expect(calls).toContain("product_fail_application_matcher_run");
  });
});

describe("O10-O12 an estate with nothing to propose still completes", () => {
  it.each([
    ["O10 empty estate", {}],
    ["O11 everything unresolved", { census: ["d1", "d2"] }],
    ["O12 everything resolved with zero instances", { census: ["d1"], candidates: [{ d: "d1", p: "p1", a: null }] }],
  ] as [string, Opts][])("%s", async (_l, opts) => {
    const { io, calls } = makeIo(opts);
    const r = await runApplicationMatcher(io);
    expect(r.status).toBe("completed");
    expect(calls).not.toContain("product_propose_application_match");
    expect(calls).toContain("product_complete_application_matcher_run");
  });
});

describe("A1-A9 proposal contract", () => {
  it("A7/A9 one candidate is proposed as canonical_product / medium", async () => {
    const { io, proposals } = makeIo({ census: ["d1"], candidates: [{ d: "d1", p: "p1", a: "a1" }] });
    await runApplicationMatcher(io);
    expect(proposals).toEqual([{
      p_tenant_id: "t-a", p_directory_application_id: "d1", p_app_id: "a1",
      p_method: "canonical_product", p_confidence: "medium",
    }]);
  });

  it("A8 every candidate in an ambiguous group is proposed at low", async () => {
    const { io, proposals } = makeIo({
      census: ["d1"], candidates: [{ d: "d1", p: "p1", a: "a1" }, { d: "d1", p: "p1", a: "a2" }, { d: "d1", p: "p1", a: "a3" }],
    });
    const r = await runApplicationMatcher(io);
    expect(r.status).toBe("completed");
    expect(proposals).toHaveLength(3);
    expect(proposals.every(p => p.p_confidence === "low")).toBe(true);
    expect(proposals.every(p => p.p_method === "canonical_product")).toBe(true);
  });

  it.each([
    ["A2 already_proposed", "already_proposed", "proposalsExisting"],
    ["A3 already_accepted", "already_accepted", "proposalsAlreadyAccepted"],
    ["A4 already_rejected", "already_rejected", "proposalsAlreadyRejected"],
  ])("%s is SUCCESS and is counted, never a failure", async (_l, status, field) => {
    const { io } = makeIo({ census: ["d1"], candidates: [{ d: "d1", p: "p1", a: "a1" }], proposalStatus: status });
    const r = await runApplicationMatcher(io);
    expect(r.status).toBe("completed");
    expect(r.status === "completed" && (r as unknown as Record<string, number>)[field]).toBe(1);
  });

  it("a human rejection does not break the run, and is not re-proposed over", async () => {
    // The matcher regenerated a legitimate candidate and found a decision already recorded. Failing here would let one
    // reviewer's "no" break every future run; overwriting would resurrect a relationship a person deliberately refused.
    const { io, proposals } = makeIo({
      census: ["d1"], candidates: [{ d: "d1", p: "p1", a: "a1" }], proposalStatus: "already_rejected",
    });
    const r = await runApplicationMatcher(io);
    expect(r.status).toBe("completed");
    expect(proposals).toHaveLength(1); // proposed once, not retried into a decision
  });
});

describe("A10 the matcher never decides", () => {
  it("never calls the decide RPC, even for a single deterministic candidate", async () => {
    const { io, calls } = makeIo({ census: ["d1"], candidates: [{ d: "d1", p: "p1", a: "a1" }] });
    await runApplicationMatcher(io);
    expect(calls).not.toContain("product_decide_application_match");
    expect(calls.some(c => c.includes("decide"))).toBe(false);
  });
});

describe("P6-P10 pagination is walked to exhaustion and fails closed", () => {
  it("P6 walks a multi-page census", async () => {
    const census = Array.from({ length: 250 }, (_, i) => `d${String(i).padStart(4, "0")}`);
    const { io } = makeIo({ census });
    const r = await runApplicationMatcher(io);
    expect(r.status === "completed" && r.counts.directoryApplications).toBe(250);
  });

  it("P7 walks a multi-page candidate feed, and a many-instance group is never split", async () => {
    const census = Array.from({ length: 450 }, (_, i) => `d${String(i).padStart(4, "0")}`);
    // Every parent carries three instances, so pages return far more rows than the parent limit.
    const candidates = census.flatMap(d => ["a1", "a2", "a3"].map(a => ({ d, p: `p-${d}`, a })));
    const { io } = makeIo({ census, candidates });
    const r = await runApplicationMatcher(io);
    expect(r.status).toBe("completed");
    expect(r.status === "completed" && r.counts.ambiguousApplications).toBe(450);
    expect(r.status === "completed" && r.counts.candidateCount).toBe(1350);
  });

  it.each([
    ["P8 census cursor stalls", "product_list_directory_applications"],
    ["P9 candidate cursor stalls", "product_application_match_candidates"],
  ])("%s -> fails closed and records the failure", async (_l, target) => {
    const stalled: MatcherIo = {
      rpc: async (name) => {
        if (name === "product_start_application_matcher_run") return ok({ updated: 1 });
        if (name === "product_fail_application_matcher_run") return ok({ updated: 1 });
        if (name === target && target === "product_list_directory_applications") {
          return ok(Array.from({ length: 100 }, () => ({ id: "same" })));
        }
        if (name === target && target === "product_application_match_candidates") {
          return ok(Array.from({ length: 200 }, (_, i) => ({
            directory_application_id: `p${String(i).padStart(4, "0")}`, app_product_id: "x", app_id: null,
          })));
        }
        if (name === "product_list_directory_applications") {
          return ok(Array.from({ length: 200 }, (_, i) => ({ id: `p${String(i).padStart(4, "0")}` })).slice(0, 100));
        }
        return ok([]);
      },
    };
    const r = await runApplicationMatcher(stalled);
    expect(r.status).toBe("failed");
    expect(r.status === "failed" && r.reason).toBe("pagination_contract_violated");
  });

  it("a malformed row fails the read rather than being dropped", async () => {
    const bad: MatcherIo = {
      rpc: async (name) => {
        if (name === "product_start_application_matcher_run") return ok({ updated: 1 });
        if (name === "product_fail_application_matcher_run") return ok({ updated: 1 });
        if (name === "product_list_directory_applications") return ok([{ id: "d1" }, { notAnId: true }]);
        return ok([]);
      },
    };
    const r = await runApplicationMatcher(bad);
    expect(r.status === "failed" && r.reason).toBe("pagination_contract_violated");
  });
});

describe("idempotency and estate drift", () => {
  it("P15 a replay proposes the same set and completes again", async () => {
    const opts: Opts = { census: ["d1", "d2"], candidates: [{ d: "d1", p: "p1", a: "a1" }, { d: "d2", p: "p2", a: "b1" }] };
    const first = makeIo(opts);
    await runApplicationMatcher(first.io);
    const second = makeIo({ ...opts, proposalStatus: "already_proposed" });
    const r = await runApplicationMatcher(second.io);
    expect(r.status).toBe("completed");
    expect(r.status === "completed" && r.proposalsCreated).toBe(0);
    expect(r.status === "completed" && r.proposalsExisting).toBe(2);
    expect(second.proposals.map(p => p.p_app_id)).toEqual(first.proposals.map(p => p.p_app_id));
  });

  it("a new instance appearing between runs is proposed once, and the existing one is untouched", async () => {
    const { io, proposals } = makeIo({
      census: ["d1"],
      candidates: [{ d: "d1", p: "p1", a: "a1" }, { d: "d1", p: "p1", a: "a2" }],
      proposalStatus: i => (i === 0 ? "already_proposed" : "proposed"),
    });
    const r = await runApplicationMatcher(io);
    expect(r.status === "completed" && r.proposalsExisting).toBe(1);
    expect(r.status === "completed" && r.proposalsCreated).toBe(1);
    // Adding a second instance made the group ambiguous, so BOTH are now low — including the pre-existing one.
    expect(proposals.every(p => p.p_confidence === "low")).toBe(true);
  });
});
