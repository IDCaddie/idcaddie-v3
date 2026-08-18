// Phase 18F-C — the matcher-state read.
//
// The property under test throughout: a failure to READ never becomes a claim about the ESTATE. 0085 returns zero rows
// both for an unauthorized caller and for a tenant that does not exist, so "no row" can only ever mean "we were not
// allowed to look" — reporting it as `hasEverRun: false` would tell an operator to run a matcher that may have run fine.

import { describe, expect, it, vi } from "vitest";
import { readMatcherState, type MatcherStateIo } from "./governance-ops";

const io = (impl: () => Promise<{ data: unknown; error: unknown }>): MatcherStateIo => ({ rpc: impl });
const row = (over: Record<string, unknown> = {}) => [{
  has_ever_run: true, status: "completed", started_at: "2026-08-15T09:00:00Z",
  last_completed_at: "2026-08-15T09:14:00Z", has_completed: true, ...over,
}];

describe("readMatcherState", () => {
  it("passes 0085's projection through unchanged", async () => {
    const r = await readMatcherState("t1", io(async () => ({ data: row(), error: null })));
    expect(r).toEqual({
      ok: true,
      state: {
        hasEverRun: true, status: "completed",
        startedAt: "2026-08-15T09:00:00Z", lastCompletedAt: "2026-08-15T09:14:00Z",
      },
    });
  });

  it("reads a never-run tenant as never-run, with nulls rather than invented values", async () => {
    const r = await readMatcherState("t1", io(async () => ({
      data: row({ has_ever_run: false, status: null, started_at: null, last_completed_at: null }), error: null,
    })));
    expect(r).toEqual({
      ok: true,
      state: { hasEverRun: false, status: null, startedAt: null, lastCompletedAt: null },
    });
  });

  it("keeps last_completed_at when the current run failed — the timestamp survives by design", async () => {
    const r = await readMatcherState("t1", io(async () => ({ data: row({ status: "failed" }), error: null })));
    expect(r.ok && r.state.status).toBe("failed");
    expect(r.ok && r.state.lastCompletedAt).toBe("2026-08-15T09:14:00Z");
  });

  it("sends the tenant id as 0085's parameter and calls exactly one RPC", async () => {
    const rpc = vi.fn(async () => ({ data: row(), error: null }));
    await readMatcherState("tenant-abc", { rpc });
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith("product_application_matcher_state", { p_tenant_id: "tenant-abc" });
  });

  describe("a read we could not complete is never an estate we looked at", () => {
    it("zero rows is not_authorized, NOT never-run", async () => {
      const r = await readMatcherState("t1", io(async () => ({ data: [], error: null })));
      expect(r).toEqual({ ok: false, error: "not_authorized" });
    });

    it("more than one row is refused rather than reconciled", async () => {
      const r = await readMatcherState("t1", io(async () => ({ data: [...row(), ...row()], error: null })));
      expect(r).toEqual({ ok: false, error: "not_authorized" });
    });

    it("a returned error is query_failed", async () => {
      const r = await readMatcherState("t1", io(async () => ({ data: null, error: { message: "boom" } })));
      expect(r).toEqual({ ok: false, error: "query_failed" });
    });

    it("a thrown transport error is query_failed, and no stack escapes", async () => {
      const r = await readMatcherState("t1", io(async () => { throw new Error("select * from x where token='xoxb-1'"); }));
      expect(r).toEqual({ ok: false, error: "query_failed" });
      expect(JSON.stringify(r)).not.toContain("xoxb");
    });

    it("an unknown status is query_failed rather than passed through", async () => {
      // A status this code does not understand, rendered as-is, is an operator reading a word as though it meant
      // something. 0085's CHECK admits three values; anything else means the contract drifted.
      const r = await readMatcherState("t1", io(async () => ({ data: row({ status: "cancelled" }), error: null })));
      expect(r).toEqual({ ok: false, error: "query_failed" });
    });

    it("a missing has_ever_run is query_failed rather than defaulted to false", async () => {
      const r = await readMatcherState("t1", io(async () => ({ data: [{ status: "completed" }], error: null })));
      expect(r).toEqual({ ok: false, error: "query_failed" });
    });

    it("a non-array payload is refused", async () => {
      const r = await readMatcherState("t1", io(async () => ({ data: { has_ever_run: true }, error: null })));
      expect(r).toEqual({ ok: false, error: "not_authorized" });
    });
  });

  it("returns only safe scalars — no id, email, name or payload can travel", async () => {
    const r = await readMatcherState("t1", io(async () => ({
      data: row({ tenant_id: "11111111-1111-1111-1111-111111111111", operator_email: "a@b.com" }), error: null,
    })));
    const serialized = JSON.stringify(r);
    expect(serialized).not.toContain("11111111");
    expect(serialized).not.toContain("a@b.com");
    expect(Object.keys((r as { state: object }).state).sort())
      .toEqual(["hasEverRun", "lastCompletedAt", "startedAt", "status"]);
  });
});
