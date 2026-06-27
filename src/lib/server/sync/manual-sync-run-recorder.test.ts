import { describe, it, expect } from "vitest";
import { createSupabaseManualSyncRunRecorder } from "./manual-sync-run-recorder";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/database.types";
import type { RunSlackSyncSummary } from "./run-slack-sync-dev";

// Unit shape/safety test for the run recorder (mocked Supabase client — real DB/RLS is org_rls_test Test 59 + the IT).
type Ctx = { table?: string; op?: string; payload?: Record<string, unknown> };
function mk(resolve: (ctx: Ctx) => { data: unknown; error: unknown }) {
  const calls: Ctx[] = [];
  const q = (ctx: Ctx): Record<string, unknown> => ({
    insert: (p: Record<string, unknown>) => q({ ...ctx, op: "insert", payload: p }),
    update: (p: Record<string, unknown>) => q({ ...ctx, op: "update", payload: p }),
    select: () => q(ctx),
    eq: () => q(ctx),
    single: () => { calls.push(ctx); return Promise.resolve(resolve(ctx)); },
    then: (r: (v: unknown) => unknown, j?: (e: unknown) => unknown) => { calls.push(ctx); return Promise.resolve(resolve(ctx)).then(r, j); },
  });
  return { client: { from: (table: string) => q({ table }) } as unknown as SupabaseClient<Database>, calls };
}
const okSummary: RunSlackSyncSummary = { ok: true, teamPresent: true, usersFetched: 2, factsEmitted: 6, factsRejected: 0, appUsersWritten: 2, peopleWritten: 1, matchesWritten: 1, matchConflicts: 0, skipped: 3 };

describe("createSupabaseManualSyncRunRecorder", () => {
  it("start() inserts a 'running' row into manual_sync_runs and returns the id (started_at/created_by via DB default)", async () => {
    const m = mk(() => ({ data: { id: "run1" }, error: null }));
    const rec = createSupabaseManualSyncRunRecorder(m.client);
    expect(await rec.start({ tenantId: "t1", source: "slack", connectorId: "slack-dev" })).toEqual({ runId: "run1" });
    expect(m.calls[0]).toMatchObject({ table: "manual_sync_runs", op: "insert", payload: { tenant_id: "t1", source: "slack", connector_id: "slack-dev", status: "running" } });
    // start must NOT set created_by/started_at itself (DB defaults) and must carry no extra fields
    expect(Object.keys(m.calls[0].payload!).sort()).toEqual(["connector_id", "source", "status", "tenant_id"]);
  });

  it("finish() on success writes succeeded + the safe counts (and only those)", async () => {
    const m = mk(() => ({ data: null, error: null }));
    await createSupabaseManualSyncRunRecorder(m.client).finish({ runId: "run1", summary: okSummary });
    const p = m.calls[0].payload!;
    expect(p).toMatchObject({ status: "succeeded", users_fetched: 2, facts_emitted: 6, facts_rejected: 0, app_users_written: 2, people_written: 1, matches_written: 1, match_conflicts: 0, skipped: 3 });
    expect(p.finished_at).toBeTypeOf("string");
    // ONLY safe aggregate columns — no token/JWT/email/name/raw/actor-PII key
    for (const k of Object.keys(p)) expect(["status", "finished_at", "users_fetched", "facts_emitted", "facts_rejected", "app_users_written", "people_written", "matches_written", "match_conflicts", "skipped"]).toContain(k);
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
