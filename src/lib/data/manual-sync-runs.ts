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
  appUsersMarkedStale: number; // 0040 — NOT NULL; how many app_users this run flipped active→stale (absence marking)
};

// Active/stale app_user presence counts for the tenant's Slack-synced app(s) — count-only, no PII/rows.
export type SlackPresenceCounts = { active: number; stale: number };

// The current tenant's most recent Slack run (RLS-scoped; null if none). `.eq('source','slack')` + RLS — never a
// cross-tenant query by source alone (RLS limits rows to the signed-in user's tenant). No service-role, no writes.
export async function getLatestSlackSyncRunForCurrentTenant(): Promise<DataResult<SlackSyncRunStatus | null>> {
  const supabase = await createClient();

  const { data, error } = await supabase
    .from("manual_sync_runs")
    .select(
      "status, started_at, finished_at, error_code, failed_stage, users_fetched, facts_emitted, facts_rejected, app_users_written, people_written, matches_written, match_conflicts, skipped, app_users_marked_stale",
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
      appUsersMarkedStale: data.app_users_marked_stale,
    },
  };
}

// Count the current tenant's Slack-synced app_users by presence (0040 sync_status). Scoped to the tenant's Slack app(s)
// — apps that carry a connector instance id (external_instance_id, migration 0024) AND vendor "Slack" — then a
// COUNT-ONLY read of app_users by sync_status (never a row/PII/token — `head: true` transfers no rows). RLS decides which
// tenant's apps/app_users are visible; no tenant_id from the caller; no service-role. Returns {active:0, stale:0} when
// the tenant has no Slack app yet (safe empty state).
export async function getSlackAppUserPresenceCountsForCurrentTenant(): Promise<DataResult<SlackPresenceCounts>> {
  const supabase = await createClient();

  const appsRes = await supabase
    .from("apps")
    .select("id")
    .not("external_instance_id", "is", null)
    .ilike("vendor_name", "slack");
  if (appsRes.error) {
    console.error("[data/manual-sync-runs] getSlackAppUserPresenceCounts apps query failed");
    return { ok: false, error: "query_failed" };
  }
  const appIds = (appsRes.data ?? []).map((r) => r.id);
  if (appIds.length === 0) return { ok: true, data: { active: 0, stale: 0 } };

  const countByStatus = (status: "active" | "stale") =>
    supabase.from("app_users").select("id", { count: "exact", head: true }).in("app_id", appIds).eq("sync_status", status);
  const [active, stale] = await Promise.all([countByStatus("active"), countByStatus("stale")]);
  if (active.error || stale.error) {
    console.error("[data/manual-sync-runs] getSlackAppUserPresenceCounts app_users count failed");
    return { ok: false, error: "query_failed" };
  }
  return { ok: true, data: { active: active.count ?? 0, stale: stale.count ?? 0 } };
}
