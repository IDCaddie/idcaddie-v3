import { describe, it, expect } from "vitest";
import { createSupabaseManualSyncRunRecorder } from "./manual-sync-run-recorder";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/database.types";
import type { RunSlackSyncSummary } from "./run-slack-sync-dev";

// Unit shape/safety test for the run recorder (mocked Supabase client — real DB/RLS is org_rls_test Test 59 + the IT).
type Ctx = { table?: string; op?: string; payload?: Record<string, unknown>; filters?: string[] };
function mk(resolve: (ctx: Ctx) => { data: unknown; error: unknown }) {
  const calls: Ctx[] = [];
  const q = (ctx: Ctx): Record<string, unknown> => ({
    insert: (p: Record<string, unknown>) => q({ ...ctx, op: "insert", payload: p }),
    update: (p: Record<string, unknown>) => q({ ...ctx, op: "update", payload: p }),
    select: () => q(ctx),
    eq: (c: string, v: unknown) => q({ ...ctx, filters: [...(ctx.filters ?? []), `eq:${c}=${v}`] }),
    lt: (c: string, v: unknown) => q({ ...ctx, filters: [...(ctx.filters ?? []), `lt:${c}=${v}`] }),
    single: () => { calls.push(ctx); return Promise.resolve(resolve(ctx)); },
    then: (r: (v: unknown) => unknown, j?: (e: unknown) => unknown) => { calls.push(ctx); return Promise.resolve(resolve(ctx)).then(r, j); },
  });
  return { client: { from: (table: string) => q({ table }) } as unknown as SupabaseClient<Database>, calls };
}
const okSummary: RunSlackSyncSummary = { ok: true, teamPresent: true, usersFetched: 2, factsEmitted: 6, factsRejected: 0, appUsersWritten: 2, peopleWritten: 1, matchesWritten: 1, matchConflicts: 0, skipped: 3 };

describe("createSupabaseManualSyncRunRecorder", () => {
  it("start() inserts a 'running' row and returns ok+id (started_at/created_by via DB default)", async () => {
    const m = mk(() => ({ data: { id: "run1" }, error: null }));
    const rec = createSupabaseManualSyncRunRecorder(m.client);
    expect(await rec.start({ tenantId: "t1", source: "slack", connectorId: "slack-dev" })).toEqual({ ok: true, runId: "run1" });
    expect(m.calls[0]).toMatchObject({ table: "manual_sync_runs", op: "insert", payload: { tenant_id: "t1", source: "slack", connector_id: "slack-dev", status: "running" } });
    expect(Object.keys(m.calls[0].payload!).sort()).toEqual(["connector_id", "source", "status", "tenant_id"]);
  });

  it("start() returns run_already_active (NOT a throw) when the 0038 active-run unique index is violated", async () => {
    const m = mk(() => ({ data: null, error: { code: "23505", message: "duplicate key" } }));
    expect(await createSupabaseManualSyncRunRecorder(m.client).start({ tenantId: "t1", source: "slack", connectorId: "c" }))
      .toEqual({ ok: false, reason: "run_already_active" });
  });

  it("reconcileStaleRuns marks stale 'running' rows failed/stale_run_reconciled — scoped to the lock key, no counts invented", async () => {
    const m = mk(() => ({ data: [{ id: "r1" }], error: null }));
    const res = await createSupabaseManualSyncRunRecorder(m.client).reconcileStaleRuns({ tenantId: "t1", source: "slack", connectorId: "c", staleBeforeIso: "2026-06-27T00:00:00Z" });
    expect(res).toEqual({ reconciled: 1 });
    const p = m.calls[0].payload!;
    expect(p).toMatchObject({ status: "failed", error_code: "stale_run_reconciled" });
    expect(p.finished_at).toBeTypeOf("string");
    // ONLY status/finished_at/error_code — never invented success counts
    for (const k of Object.keys(p)) expect(["status", "finished_at", "error_code"]).toContain(k);
    // tenant-scoped + only-running + only-stale filters
    for (const f of ["eq:tenant_id=t1", "eq:source=slack", "eq:connector_id=c", "eq:status=running", "lt:started_at=2026-06-27T00:00:00Z"])
      expect(m.calls[0].filters).toContain(f);
  });

  it("finish() on success writes succeeded + the safe counts (and only those)", async () => {
    const m = mk(() => ({ data: null, error: null }));
    await createSupabaseManualSyncRunRecorder(m.client).finish({ runId: "run1", summary: okSummary });
    const p = m.calls[0].payload!;
    expect(p).toMatchObject({ status: "succeeded", users_fetched: 2, facts_emitted: 6, facts_rejected: 0, app_users_written: 2, people_written: 1, matches_written: 1, match_conflicts: 0, skipped: 3 });
    expect(p.finished_at).toBeTypeOf("string");
    // ONLY safe aggregate columns — no token/JWT/email/name/raw/actor-PII key
    for (const k of Object.keys(p)) expect(["status", "finished_at", "users_fetched", "facts_emitted", "facts_rejected", "app_users_written", "people_written", "matches_written", "match_conflicts", "skipped"]).toContain(k);
    // finish only closes a STILL-running row → never trips the completed-run immutability if it was concurrently reconciled
    expect(m.calls[0].filters).toEqual(expect.arrayContaining(["eq:id=run1", "eq:status=running"]));
  });

  it("finish() on failure writes failed + the safe error_code/failed_stage (no raw)", async () => {
    const m = mk(() => ({ data: null, error: null }));
    const fail: RunSlackSyncSummary = { ok: false, errorCode: "resolve_failed", failedStage: "upsert_app", safeReason: "rls_denied", usersFetched: 1, factsEmitted: 6, factsRejected: 0 };
    await createSupabaseManualSyncRunRecorder(m.client).finish({ runId: "run1", summary: fail });
    expect(m.calls[0].payload).toMatchObject({ status: "failed", error_code: "resolve_failed", failed_stage: "upsert_app", users_fetched: 1, facts_emitted: 6 });
    const blob = JSON.stringify(m.calls[0].payload);
    for (const bad of ["xoxb", "Bearer", "@", "rls_denied"]) expect(blob).not.toContain(bad); // safeReason is NOT persisted; only error_code/failed_stage
  });

  it("a DB error surfaces a SAFE static reason (no row data / raw error)", async () => {
    const m = mk(() => ({ data: null, error: { code: "42501", message: "raw rls detail (ada@x.test)" } }));
    await expect(createSupabaseManualSyncRunRecorder(m.client).start({ tenantId: "t", source: "slack", connectorId: "c" })).rejects.toThrow("run_record_failed");
  });
});
