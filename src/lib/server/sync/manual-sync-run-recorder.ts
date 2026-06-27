// Server-only run-lifecycle recorder for the manual Slack sync (docs/47 PR 6+). Persists a SAFE, tenant-scoped run
// record to public.manual_sync_runs over an INJECTED user-scoped Supabase client (RLS; NEVER service-role). It writes
// ONLY safe aggregates — status, counts, timestamps, a SAFE error_code/failed_stage — and NEVER a token / JWT / auth
// header / email / name / raw Slack response / raw user record / raw DB payload. `created_by` is filled by the DB
// (`default auth.uid()`), so the actor comes from the JWT, not the caller.
//
// SERVER-ONLY: under `src/lib/server/`, the runtime browser sentinel below, and `no-client-import.test.ts`.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/database.types";
import type { RunSlackSyncSummary } from "./run-slack-sync-dev";

if (typeof (globalThis as { window?: unknown }).window !== "undefined") {
  throw new Error("server/sync/manual-sync-run-recorder is server-only and must not be imported in client code");
}

// start() outcome: the run was opened, OR the (tenant, source, connector) lock is already held by an active run.
export type StartRunResult = { ok: true; runId: string } | { ok: false; reason: "run_already_active" };

export interface ManualSyncRunRecorder {
  // Acquire the per-(tenant, source, connector) lock by inserting a 'running' row (DB partial unique index, migration
  // 0038). If another active run already holds the lock → { ok:false, reason:'run_already_active' } (no record created).
  // A process crash before finish() leaves the record 'running' (never a misleading 'succeeded').
  start(input: { tenantId: string; source: "slack"; connectorId: string }): Promise<StartRunResult>;
  // Close the run from the SAFE summary → 'succeeded' (+counts) or 'failed' (+safe error_code/failed_stage).
  finish(input: { runId: string; summary: RunSlackSyncSummary }): Promise<void>;
  // Mark any run stuck in 'running' past the cutoff as failed (error_code='stale_run_reconciled'), releasing the lock so
  // a new run can start. NEVER invents success counts; the 0037 trigger permits running→failed (the run isn't terminal
  // yet). Tenant-scoped via RLS. Returns how many were reconciled.
  reconcileStaleRuns(input: { tenantId: string; source: "slack"; connectorId: string; staleBeforeIso: string }): Promise<{ reconciled: number }>;
}

export class RunRecordError extends Error {
  constructor() {
    super("run_record_failed"); // SAFE static message — never row data / a raw DB message
    this.name = "RunRecordError";
  }
}
const PG_UNIQUE_VIOLATION = "23505"; // the 0038 active-run partial unique index → another run holds the lock

export function createSupabaseManualSyncRunRecorder(supabase: SupabaseClient<Database>): ManualSyncRunRecorder {
  return {
    async start({ tenantId, source, connectorId }) {
      const { data, error } = await supabase
        .from("manual_sync_runs")
        .insert({ tenant_id: tenantId, source, connector_id: connectorId, status: "running" }) // started_at + created_by via DB default
        .select("id")
        .single();
      if (error?.code === PG_UNIQUE_VIOLATION) return { ok: false, reason: "run_already_active" }; // lock held — no record created
      if (error || !data) throw new RunRecordError();
      return { ok: true, runId: data.id };
    },

    async reconcileStaleRuns({ tenantId, source, connectorId, staleBeforeIso }) {
      const { data, error } = await supabase
        .from("manual_sync_runs")
        .update({ status: "failed", finished_at: new Date().toISOString(), error_code: "stale_run_reconciled" }) // no counts invented
        .eq("tenant_id", tenantId)
        .eq("source", source)
        .eq("connector_id", connectorId)
        .eq("status", "running")
        .lt("started_at", staleBeforeIso)
        .select("id");
      if (error) throw new RunRecordError();
      return { reconciled: data?.length ?? 0 };
    },

    async finish({ runId, summary }) {
      const finished_at = new Date().toISOString();
      const fields = summary.ok
        ? {
            status: "succeeded" as const,
            finished_at,
            users_fetched: summary.usersFetched,
            facts_emitted: summary.factsEmitted,
            facts_rejected: summary.factsRejected,
            app_users_written: summary.appUsersWritten,
            people_written: summary.peopleWritten,
            matches_written: summary.matchesWritten,
            match_conflicts: summary.matchConflicts,
            skipped: summary.skipped,
          }
        : {
            status: "failed" as const,
            finished_at,
            error_code: summary.errorCode, // SAFE code only
            failed_stage: summary.failedStage ?? null, // SAFE enum only
            users_fetched: summary.usersFetched ?? null,
            facts_emitted: summary.factsEmitted ?? null,
            facts_rejected: summary.factsRejected ?? null,
          };
      // Close ONLY a still-'running' row. If an abnormally long (>STALE_RUN_MS) chain raced a concurrent stale
      // reconcile that already marked this run failed, this matches 0 rows → a safe no-op that never trips the 0037
      // completed-run immutability trigger.
      const { error } = await supabase.from("manual_sync_runs").update(fields).eq("id", runId).eq("status", "running");
      if (error) throw new RunRecordError();
    },
  };
}
