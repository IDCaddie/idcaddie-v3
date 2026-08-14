import { describe, expect, it, vi } from "vitest";
import { runApplicationMatcher, type MatcherIo } from "./application-matcher";

const ok = (data: unknown) => ({ data, error: null });
const bad = () => ({ data: null, error: { message: "boom" } });

const census = (...ids: string[]) => ids.map(id => ({ id }));
const cand = (d: string, p: string, a: string | null) =>
  ({ directory_application_id: d, app_product_id: p, app_id: a });

type Overrides = {
  censusPages?: unknown[];
  candidatePages?: unknown[];
  propose?: (args: Record<string, unknown>, n: number) => { data: unknown; error: unknown };
  start?: () => { data: unknown; error: unknown };
  complete?: () => { data: unknown; error: unknown };
  fail?: () => { data: unknown; error: unknown };
};

/** Records every call so ORDER — the thing that makes completion honest — is assertable, not assumed. */
const harness = (o: Overrides = {}) => {
  const calls: { name: string; args: Record<string, unknown> }[] = [];
  let censusPage = 0;
  let candidatePage = 0;
  let proposeN = 0;
  const io: MatcherIo = {
    rpc: async (name, args) => {
      calls.push({ name, args });
      switch (name) {
        case "product_start_application_matcher_run":
          return o.start ? o.start() : ok({ status: "running" });
        case "product_complete_application_matcher_run":
          return o.complete ? o.complete() : ok({ updated: 1 });
        case "product_fail_application_matcher_run":
          return o.fail ? o.fail() : ok({ updated: 1 });
        case "product_list_directory_applications": {
          const pages = o.censusPages ?? [census()];
          return ok(pages[Math.min(censusPage++, pages.length - 1)]);
        }
        case "product_application_match_candidates": {
          const pages = o.candidatePages ?? [[]];
          return ok(pages[Math.min(candidatePage++, pages.length - 1)]);
        }
        case "product_propose_application_match":
          return o.propose ? o.propose(args, proposeN++) : ok({ status: "proposed" });
        default:
          throw new Error(`unexpected rpc: ${name}`);
      }
    },
  };
  return { io, calls, names: () => calls.map(c => c.name) };
};

describe("application matcher — the proposal contract", () => {
  it("proposes one candidate at medium with method canonical_product", async () => {
    const h = harness({ censusPages: [census("d1")], candidatePages: [[cand("d1", "p1", "a1")]] });
    const r = await runApplicationMatcher("t1", h.io);
    expect(r.status).toBe("completed");
    const p = h.calls.find(c => c.name === "product_propose_application_match");
    expect(p?.args).toEqual({
      p_tenant_id: "t1", p_directory_application_id: "d1", p_app_id: "a1",
      p_method: "canonical_product", p_confidence: "medium",
    });
  });

  it("proposes every candidate of an ambiguous group at low, and stops after none of them", async () => {
    const h = harness({
      censusPages: [census("d1")],
      candidatePages: [[cand("d1", "p1", "a1"), cand("d1", "p1", "a2"), cand("d1", "p1", "a3")]],
    });
    const r = await runApplicationMatcher("t1", h.io);
    expect(r.status).toBe("completed");
    const proposals = h.calls.filter(c => c.name === "product_propose_application_match");
    expect(proposals).toHaveLength(3);
    expect(proposals.every(c => c.args.p_confidence === "low")).toBe(true);
  });

  it("proposes NOTHING for an unresolved product or a zero-instance one", async () => {
    const h = harness({ censusPages: [census("d1", "d2")], candidatePages: [[cand("d2", "p2", null)]] });
    const r = await runApplicationMatcher("t1", h.io);
    expect(r.status).toBe("completed");
    if (r.status !== "completed") return;
    expect(h.calls.some(c => c.name === "product_propose_application_match")).toBe(false);
    expect(r.counts.unresolvedProductCount).toBe(1);
    expect(r.counts.zeroInstanceCount).toBe(1);
  });

  // THE BOUNDARY THIS PHASE MUST NOT CROSS. A matcher that decided its own proposals would make 0088's review
  // boundary decorative, and a single unambiguous candidate is the tempting case.
  it("NEVER decides — not even the unambiguous one-candidate case", async () => {
    const h = harness({ censusPages: [census("d1")], candidatePages: [[cand("d1", "p1", "a1")]] });
    await runApplicationMatcher("t1", h.io);
    expect(h.names()).not.toContain("product_decide_application_match");
  });
});

describe("application matcher — proposal result vocabulary", () => {
  const one = { censusPages: [census("d1")], candidatePages: [[cand("d1", "p1", "a1")]] };

  it.each([
    ["proposed", "createdProposalCount"],
    ["already_proposed", "existingProposalCount"],
    ["already_accepted", "acceptedExistingCount"],
    ["already_rejected", "rejectedExistingCount"],
  ] as const)("treats %s as a successful run", async (status, counter) => {
    const h = harness({ ...one, propose: () => ok({ status }) });
    const r = await runApplicationMatcher("t1", h.io);
    expect(r.status).toBe("completed");
    if (r.status !== "completed") return;
    expect(r[counter]).toBe(1);
    expect(h.names()).toContain("product_complete_application_matcher_run");
  });

  // A rejection is a settled human decision about a legitimately-generated candidate. Reporting it as a broken run
  // would make a healthy estate look failed and would pressure someone into re-proposing around the rejection.
  it("does not treat a prior human rejection as a matcher failure", async () => {
    const h = harness({ ...one, propose: () => ok({ status: "already_rejected" }) });
    expect((await runApplicationMatcher("t1", h.io)).status).toBe("completed");
  });

  it.each(["not_allowed", "invalid_method", "invalid_confidence", "something_new"])(
    "FAILS the run on %s — the boundary refused what this matcher asked for", async status => {
      const h = harness({ ...one, propose: () => ok({ status }) });
      const r = await runApplicationMatcher("t1", h.io);
      expect(r).toEqual({ status: "failed", reason: "proposal_rejected" });
      expect(h.names()).toContain("product_fail_application_matcher_run");
      expect(h.names()).not.toContain("product_complete_application_matcher_run");
    });

  it("fails the run when a proposal query fails midway, and marks it failed", async () => {
    const h = harness({
      censusPages: [census("d1")],
      candidatePages: [[cand("d1", "p1", "a1"), cand("d1", "p1", "a2")]],
      propose: (_a, n) => (n === 0 ? ok({ status: "proposed" }) : bad()),
    });
    const r = await runApplicationMatcher("t1", h.io);
    expect(r).toEqual({ status: "failed", reason: "query_failed" });
    expect(h.names()).not.toContain("product_complete_application_matcher_run");
  });
});

describe("application matcher — fail-closed reads", () => {
  // ONLY the census fails; every other call succeeds, and the candidate feed returns a real candidate. Written this way
  // deliberately: an earlier version made every subsequent call throw, so a mutant that swallowed the census error into
  // an empty list still failed the run — on the NEXT call — and the test passed for the wrong reason.
  it("fails the whole run when the census read fails, and writes nothing", async () => {
    const seen: string[] = [];
    const io: MatcherIo = {
      rpc: async name => {
        seen.push(name);
        if (name === "product_list_directory_applications") return bad();
        if (name === "product_start_application_matcher_run") return ok({ status: "running" });
        if (name === "product_application_match_candidates") return ok([cand("d1", "p1", "a1")]);
        if (name === "product_propose_application_match") return ok({ status: "proposed" });
        if (name === "product_complete_application_matcher_run") return ok({ updated: 1 });
        if (name === "product_fail_application_matcher_run") return ok({ updated: 1 });
        throw new Error(`unexpected ${name}`);
      },
    };
    expect(await runApplicationMatcher("t1", io)).toEqual({ status: "failed", reason: "query_failed" });
    // An unread census is not an empty one: nothing may be proposed and the run may not complete.
    expect(seen).not.toContain("product_propose_application_match");
    expect(seen).not.toContain("product_complete_application_matcher_run");
    expect(seen).toContain("product_fail_application_matcher_run");
  });

  it("fails the whole run when the candidate read fails — an unread feed is not an empty one", async () => {
    const seen: string[] = [];
    const io: MatcherIo = {
      rpc: async name => {
        seen.push(name);
        if (name === "product_start_application_matcher_run") return ok({ status: "running" });
        if (name === "product_list_directory_applications") return ok(census("d1"));
        if (name === "product_application_match_candidates") return bad();
        if (name === "product_fail_application_matcher_run") return ok({ updated: 1 });
        throw new Error(`unexpected ${name}`);
      },
    };
    expect(await runApplicationMatcher("t1", io)).toEqual({ status: "failed", reason: "query_failed" });
    expect(seen).not.toContain("product_complete_application_matcher_run");
  });

  it("fails on a thrown transport error without leaking it", async () => {
    const io: MatcherIo = {
      rpc: async name => {
        if (name === "product_start_application_matcher_run") return ok({ status: "running" });
        if (name === "product_fail_application_matcher_run") return ok({ updated: 1 });
        throw new Error("postgres://user:pw@host:5432 exploded");
      },
    };
    const r = await runApplicationMatcher("t1", io);
    expect(r).toEqual({ status: "failed", reason: "query_failed" });
    expect(JSON.stringify(r)).not.toContain("postgres");
  });

  it("fails when a feed returns a shape that is not a page", async () => {
    const h = harness({ censusPages: [{ not: "an array" }] });
    expect(await runApplicationMatcher("t1", h.io))
      .toEqual({ status: "failed", reason: "pagination_contract_violated" });
  });

  it("fails when a census row does not meet its contract", async () => {
    const h = harness({ censusPages: [[{ id: 1 }]] });
    expect(await runApplicationMatcher("t1", h.io))
      .toEqual({ status: "failed", reason: "pagination_contract_violated" });
  });
});

describe("application matcher — pagination", () => {
  it("walks the census to exhaustion across three pages", async () => {
    const page = (from: number) => census(...Array.from({ length: 100 }, (_, i) => `d${String(from + i).padStart(4, "0")}`));
    const h = harness({ censusPages: [page(0), page(100), census("d0200")], candidatePages: [[]] });
    const r = await runApplicationMatcher("t1", h.io);
    expect(r.status).toBe("completed");
    if (r.status !== "completed") return;
    expect(r.counts.directoryApplicationCount).toBe(201);
  });

  it("walks the candidate feed by PARENT, not by row — a page may exceed p_limit and still be full", async () => {
    // Two parents, one of which expands to three rows. A row-count test would end the walk here; a parent-count test
    // must continue, because the parent page (2) is short only relative to the parent limit (200).
    const h = harness({
      censusPages: [census("d1", "d2", "d3")],
      candidatePages: [[cand("d1", "p1", "a1"), cand("d1", "p1", "a2"), cand("d1", "p1", "a3"), cand("d2", "p2", "b1")]],
    });
    const r = await runApplicationMatcher("t1", h.io);
    expect(r.status).toBe("completed");
    if (r.status !== "completed") return;
    expect(r.counts.candidateCount).toBe(4);
    expect(r.counts.ambiguousApplicationCount).toBe(1);
    expect(r.counts.oneCandidateCount).toBe(1);
  });

  it("carries the cursor as the last PARENT, and only a FULL parent page continues the walk", async () => {
    // A full page is 200 PARENTS, whatever it expands to in rows — so the fixture has to be full for a second call to
    // happen at all. Its last parent carries two instances, which is exactly the group a row-cursor would have split.
    const ids = Array.from({ length: 200 }, (_, i) => `d${String(i).padStart(4, "0")}`);
    const page1 = ids.flatMap(d => d === "d0199"
      ? [cand(d, "p", `${d}-a1`), cand(d, "p", `${d}-a2`)]
      : [cand(d, "p", `${d}-a1`)]);
    const h = harness({
      censusPages: [census(...ids, "d0200"), []],
      candidatePages: [page1, [cand("d0200", "p", "z1")], []],
    });
    const r = await runApplicationMatcher("t1", h.io);
    expect(r.status).toBe("completed");
    if (r.status !== "completed") return;
    const cursors = h.calls
      .filter(c => c.name === "product_application_match_candidates")
      .map(c => c.args.p_after_directory_application_id);
    expect(cursors[0]).toBeNull();
    expect(cursors[1]).toBe("d0199");            // the last PARENT, not the last row
    expect(r.counts.candidateCount).toBe(202);   // 199 + 2 + 1 — the split group arrived whole
  });

  it("fails on a census cursor that goes backwards", async () => {
    const h = harness({ censusPages: [census(...Array.from({ length: 100 }, (_, i) => `d${i}`)), census("d0")] });
    expect(await runApplicationMatcher("t1", h.io))
      .toEqual({ status: "failed", reason: "pagination_contract_violated" });
  });

  it("fails on a candidate page whose parent repeats one already consumed", async () => {
    const ids = Array.from({ length: 200 }, (_, i) => `d${String(i).padStart(4, "0")}`);
    const h = harness({
      censusPages: [census(...ids), []],
      // Page 2 re-serves a parent page 1 already consumed: its rows would be counted twice.
      candidatePages: [ids.map(d => cand(d, "p", `${d}-a`)), [cand("d0100", "p", "again")]],
    });
    expect(await runApplicationMatcher("t1", h.io))
      .toEqual({ status: "failed", reason: "pagination_contract_violated" });
  });

  it("fails on a non-contiguous candidate group inside one page", async () => {
    const h = harness({
      censusPages: [census("d1", "d2")],
      candidatePages: [[cand("d1", "p1", "a1"), cand("d2", "p2", "b1"), cand("d1", "p1", "a2")]],
    });
    expect(await runApplicationMatcher("t1", h.io))
      .toEqual({ status: "failed", reason: "pagination_contract_violated" });
  });

  it("fails rather than truncating when the page limit is exhausted", async () => {
    const full = census(...Array.from({ length: 100 }, (_, i) => `d${String(i).padStart(6, "0")}`));
    let n = 0;
    const io: MatcherIo = {
      rpc: async name => {
        if (name === "product_start_application_matcher_run") return ok({ status: "running" });
        if (name === "product_fail_application_matcher_run") return ok({ updated: 1 });
        // A cursor that keeps returning full, strictly-increasing pages forever.
        if (name === "product_list_directory_applications") {
          const base = n++ * 100;
          return ok(full.map((_, i) => ({ id: `d${String(base + i).padStart(6, "0")}` })));
        }
        throw new Error(`unexpected ${name}`);
      },
    };
    expect(await runApplicationMatcher("t1", io)).toEqual({ status: "failed", reason: "page_limit_exceeded" });
  });
});

describe("application matcher — cross-feed consistency fails the run", () => {
  it("fails when the feed names an application the census did not return", async () => {
    const h = harness({ censusPages: [census("d1")], candidatePages: [[cand("d9", "p1", "a1")]] });
    const r = await runApplicationMatcher("t1", h.io);
    expect(r).toEqual({ status: "failed", reason: "candidate_absent_from_census" });
    expect(h.names()).toContain("product_fail_application_matcher_run");
  });

  it("fails on conflicting products rather than picking one", async () => {
    const h = harness({
      censusPages: [census("d1")],
      candidatePages: [[cand("d1", "p1", "a1"), cand("d1", "p2", "a2")]],
    });
    const r = await runApplicationMatcher("t1", h.io);
    expect(r).toEqual({ status: "failed", reason: "conflicting_products" });
    expect(h.names()).not.toContain("product_propose_application_match");
  });

  it("fails on a NULL instance mixed with a concrete one", async () => {
    const h = harness({
      censusPages: [census("d1")],
      candidatePages: [[cand("d1", "p1", null), cand("d1", "p1", "a1")]],
    });
    expect(await runApplicationMatcher("t1", h.io))
      .toEqual({ status: "failed", reason: "mixed_null_and_concrete" });
  });
});

describe("application matcher — run lifecycle", () => {
  it("starts BEFORE reading anything", async () => {
    const h = harness({ censusPages: [census("d1")], candidatePages: [[cand("d1", "p1", "a1")]] });
    await runApplicationMatcher("t1", h.io);
    expect(h.names()[0]).toBe("product_start_application_matcher_run");
  });

  // The ordering that makes `completed` honest: Rule 5 reads that flag, so a run completing before its proposals
  // exist would license findings against evidence not yet written.
  it("completes LAST — after the final proposal, never before", async () => {
    const h = harness({
      censusPages: [census("d1")],
      candidatePages: [[cand("d1", "p1", "a1"), cand("d1", "p1", "a2")]],
    });
    await runApplicationMatcher("t1", h.io);
    const names = h.names();
    expect(names.filter(n => n === "product_propose_application_match")).toHaveLength(2);
    // ONCE, and after EVERY proposal. Asserting only that it is the last call is too weak: completing early and again
    // at the end leaves the last call correct while a window existed in which Rule 5 could read a completed run whose
    // proposals did not yet exist.
    const completes = names.flatMap((n, i) => (n === "product_complete_application_matcher_run" ? [i] : []));
    expect(completes).toHaveLength(1);
    expect(completes[0]).toBeGreaterThan(names.lastIndexOf("product_propose_application_match"));
  });

  // PHASE 7's ordering, pinned directly rather than inferred. A read-page/write-page interleaving would let a failure
  // on page 3 leave proposals from pages 1-2 already written, and there is no way to describe that run honestly: it is
  // neither complete nor untouched. Every read finishes before the first write, so a read failure writes nothing.
  it("issues the FIRST proposal only after the LAST page of BOTH feeds", async () => {
    const ids = Array.from({ length: 100 }, (_, i) => `d${String(i).padStart(4, "0")}`);
    const parents = Array.from({ length: 200 }, (_, i) => `d${String(i).padStart(4, "0")}`);
    const h = harness({
      // Two full census pages then a short one; two candidate pages (one full by PARENT count, then short).
      censusPages: [census(...ids), census(...parents.slice(100)), census("d0200")],
      candidatePages: [parents.map(d => cand(d, "p", `${d}-a`)), [cand("d0200", "p", "z")], []],
    });
    const r = await runApplicationMatcher("t1", h.io);
    expect(r.status).toBe("completed");

    const names = h.names();
    const firstWrite = names.indexOf("product_propose_application_match");
    expect(firstWrite).toBeGreaterThan(-1);
    expect(firstWrite).toBeGreaterThan(names.lastIndexOf("product_list_directory_applications"));
    expect(firstWrite).toBeGreaterThan(names.lastIndexOf("product_application_match_candidates"));
    // And no read is interleaved among the writes.
    expect(names.slice(firstWrite).every(n =>
      n === "product_propose_application_match" || n === "product_complete_application_matcher_run")).toBe(true);
  });

  it("writes NOTHING when a read fails on a later page", async () => {
    const ids = Array.from({ length: 100 }, (_, i) => `d${String(i).padStart(4, "0")}`);
    let page = 0;
    const io: MatcherIo = {
      rpc: async name => {
        if (name === "product_start_application_matcher_run") return ok({ status: "running" });
        if (name === "product_fail_application_matcher_run") return ok({ updated: 1 });
        if (name === "product_list_directory_applications") return page++ === 0 ? ok(census(...ids)) : bad();
        throw new Error(`unexpected ${name}`);
      },
    };
    expect(await runApplicationMatcher("t1", io)).toEqual({ status: "failed", reason: "query_failed" });
  });

  it("does no work at all when the start cannot transition", async () => {
    const h = harness({ start: () => bad() });
    const r = await runApplicationMatcher("t1", h.io);
    expect(r).toEqual({ status: "failed", reason: "query_failed" });
    expect(h.names()).toEqual(["product_start_application_matcher_run"]);
  });

  it("refuses to proceed on an unrecognised start response, and does not stamp a run it does not own", async () => {
    const h = harness({ start: () => ok({ status: "queued" }) });
    const r = await runApplicationMatcher("t1", h.io);
    expect(r).toEqual({ status: "failed", reason: "state_transition_failed" });
    expect(h.names()).toEqual(["product_start_application_matcher_run"]);
  });

  // updated=0 means the row was no longer `running` — something else stamped it. This run cannot claim completeness.
  it("treats a completion that moved no row as a failure", async () => {
    const h = harness({
      censusPages: [census("d1")], candidatePages: [[cand("d1", "p1", "a1")]],
      complete: () => ok({ updated: 0 }),
    });
    expect(await runApplicationMatcher("t1", h.io))
      .toEqual({ status: "failed", reason: "state_transition_failed" });
  });

  it("still reports the ORIGINAL reason when the fail transition itself fails", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const h = harness({ censusPages: [{ nope: true }], fail: () => ok({ updated: 0 }) });
    const r = await runApplicationMatcher("t1", h.io);
    // Bookkeeping must not overwrite the diagnosis.
    expect(r).toEqual({ status: "failed", reason: "pagination_contract_violated" });
    err.mockRestore();
  });

  it.each([
    ["an empty estate", [] as unknown[], [] as unknown[]],
    ["a census where nothing resolves", census("d1", "d2"), []],
    ["a census where everything resolves to zero instances", census("d1"), [cand("d1", "p1", null)]],
  ])("COMPLETES over %s — examining it successfully is the achievement", async (_label, c, f) => {
    const h = harness({ censusPages: [c], candidatePages: [f] });
    expect((await runApplicationMatcher("t1", h.io)).status).toBe("completed");
  });
});

describe("application matcher — idempotency, neutrality and the result surface", () => {
  it("adds no proposals on replay: the second run reports them as existing", async () => {
    const cfg = { censusPages: [census("d1")], candidatePages: [[cand("d1", "p1", "a1")]] };
    const first = await runApplicationMatcher("t1", harness(cfg).io);
    const second = await runApplicationMatcher("t1", harness({ ...cfg, propose: () => ok({ status: "already_proposed" }) }).io);
    expect(first.status === "completed" && first.createdProposalCount).toBe(1);
    expect(second.status === "completed" && second.existingProposalCount).toBe(1);
    expect(second.status === "completed" && second.createdProposalCount).toBe(0);
  });

  it("proposes a newly-appeared instance without rewriting the existing one", async () => {
    // Run 2's estate gained a2. a1 replays as already_proposed; only a2 is created. Nothing re-scores a1.
    const h = harness({
      censusPages: [census("d1")],
      candidatePages: [[cand("d1", "p1", "a1"), cand("d1", "p1", "a2")]],
      propose: args => ok({ status: args.p_app_id === "a1" ? "already_proposed" : "proposed" }),
    });
    const r = await runApplicationMatcher("t1", h.io);
    expect(r.status).toBe("completed");
    if (r.status !== "completed") return;
    expect(r.createdProposalCount).toBe(1);
    expect(r.existingProposalCount).toBe(1);
  });

  // This phase PROPOSES. A candidate that disappears from the estate leaves its proposal untouched: deleting or
  // staling it would discard review history the matcher has no authority over.
  it("issues no delete or stale call when a candidate disappears between runs", async () => {
    const h = harness({ censusPages: [census("d1")], candidatePages: [[cand("d1", "p1", "a1")]] });
    await runApplicationMatcher("t1", h.io);
    expect(h.names().every(n => !/delete|stale|resolve|decide/.test(n))).toBe(true);
  });

  it("behaves identically whatever provider the census carries", async () => {
    const run = async (provider: string) => {
      const io: MatcherIo = {
        rpc: async name => {
          if (name === "product_start_application_matcher_run") return ok({ status: "running" });
          if (name === "product_complete_application_matcher_run") return ok({ updated: 1 });
          if (name === "product_list_directory_applications") return ok([{ id: "d1", provider }]);
          if (name === "product_application_match_candidates") return ok([cand("d1", "p1", "a1")]);
          if (name === "product_propose_application_match") return ok({ status: "proposed" });
          throw new Error(`unexpected ${name}`);
        },
      };
      return await runApplicationMatcher("t1", io);
    };
    const [okta, unknown] = [await run("okta"), await run("a_provider_nobody_has_built_yet")];
    expect(okta).toEqual(unknown);
  });

  it("returns only bounded counters — no ids, names or payload", async () => {
    const h = harness({
      censusPages: [census("d1", "d2")],
      candidatePages: [[cand("d1", "p1", "a1"), cand("d2", "p2", null)]],
    });
    const r = await runApplicationMatcher("t1", h.io);
    expect(r.status).toBe("completed");
    const s = JSON.stringify(r);
    for (const leak of ["d1", "d2", "a1", "p1", "p2"]) expect(s).not.toContain(`"${leak}"`);
    expect(Object.values(r).every(v => typeof v === "string" || typeof v === "number" || typeof v === "object")).toBe(true);
  });

  it("returns a bounded reason string on failure", async () => {
    const h = harness({ censusPages: [census("d1")], candidatePages: [[cand("d9", "p1", "a1")]] });
    const r = await runApplicationMatcher("t1", h.io);
    expect(r.status).toBe("failed");
    if (r.status !== "failed") return;
    expect([
      "not_authorized", "query_failed", "pagination_contract_violated", "page_limit_exceeded",
      "proposal_rejected", "state_transition_failed",
      "candidate_absent_from_census", "conflicting_products", "mixed_null_and_concrete", "duplicate_candidate_row",
    ]).toContain(r.reason);
  });
});
