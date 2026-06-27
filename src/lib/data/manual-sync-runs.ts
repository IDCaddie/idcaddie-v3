import { createClient } from "@/lib/supabase/server";
import type { DataResult } from "@/lib/data/apps";

// Server-only, read-only access to manual Slack sync run status (`manual_sync_runs`), scoped by RLS (0037: tenant
// members read). Boundary: imports the user-scoped server client (server-only). NEVER a service-role/admin client,
// takes NO tenant_id from the caller — RLS decides which tenant's runs are visible. Reads ONLY safe aggregate columns
// (status/counts/timestamps/safe error) — never a token, JWT, email, name, raw payload, or actor PII.

export type SlackSyncRunStatus = {
  status: "running" | "succeeded" | "failed";
  startedAt: string;
  finishedAt: string | null;
  errorCode: string | null;
  failedStage: string | null;
  usersFetched: number | null;
  factsEmitted: number | null;
  factsRejected: number | null;
  appUsersWritten: number | null;
  peopleWritten: number | null;
  matchesWritten: number | null;
  matchConflicts: number | null;
  skipped: number | null;
};

// The current tenant's most recent Slack run (RLS-scoped; null if none). `.eq('source','slack')` + RLS — never a
// cross-tenant query by source alone (RLS limits rows to the signed-in user's tenant). No service-role, no writes.
export async function getLatestSlackSyncRunForCurrentTenant(): Promise<DataResult<SlackSyncRunStatus | null>> {
  const supabase = await createClient();

  const { data, error } = await supabase
    .from("manual_sync_runs")
    .select(
      "status, started_at, finished_at, error_code, failed_stage, users_fetched, facts_emitted, facts_rejected, app_users_written, people_written, matches_written, match_conflicts, skipped",
    )
    .eq("source", "slack")
    .order("started_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    console.error("[data/manual-sync-runs] getLatestSlackSyncRunForCurrentTenant query failed");
    return { ok: false, error: "query_failed" };
  }
  if (!data) return { ok: true, data: null };

  return {
    ok: true,
    data: {
      status: data.status as SlackSyncRunStatus["status"],
      startedAt: data.started_at,
      finishedAt: data.finished_at,
      errorCode: data.error_code,
      failedStage: data.failed_stage,
      usersFetched: data.users_fetched,
      factsEmitted: data.facts_emitted,
      factsRejected: data.facts_rejected,
      appUsersWritten: data.app_users_written,
      peopleWritten: data.people_written,
      matchesWritten: data.matches_written,
      matchConflicts: data.match_conflicts,
      skipped: data.skipped,
    },
  };
}
