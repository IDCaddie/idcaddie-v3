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

export interface ManualSyncRunRecorder {
  // Open a run as 'running' (before the chain) → returns the run id. A process crash before finish() leaves the record
  // 'running' (never a misleading 'succeeded').
  start(input: { tenantId: string; source: "slack"; connectorId: string }): Promise<{ runId: string }>;
  // Close the run from the SAFE summary → 'succeeded' (+counts) or 'failed' (+safe error_code/failed_stage).
  finish(input: { runId: string; summary: RunSlackSyncSummary }): Promise<void>;
}

export class RunRecordError extends Error {
  constructor() {
    super("run_record_failed"); // SAFE static message — never row data / a raw DB message
    this.name = "RunRecordError";
  }
}

export function createSupabaseManualSyncRunRecorder(supabase: SupabaseClient<Database>): ManualSyncRunRecorder {
  return {
    async start({ tenantId, source, connectorId }) {
      const { data, error } = await supabase
        .from("manual_sync_runs")
        .insert({ tenant_id: tenantId, source, connector_id: connectorId, status: "running" }) // started_at + created_by via DB default
        .select("id")
        .single();
      if (error || !data) throw new RunRecordError();
      return { runId: data.id };
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
      const { error } = await supabase.from("manual_sync_runs").update(fields).eq("id", runId);
      if (error) throw new RunRecordError();
    },
  };
}
