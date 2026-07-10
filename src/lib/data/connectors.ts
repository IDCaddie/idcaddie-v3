import { createClient } from "@/lib/supabase/server";

// Server-only, READ-ONLY data access for the connector metadata page (gated vault PR E, docs/42 §30).
// Same discipline as files.ts: imports the user-scoped server client (NEVER service-role / admin), takes
// NO tenant_id from the caller, and relies entirely on RLS to scope what the signed-in user may read
// (`connectors`/`connector_runs` SELECT RLS = `is_tenant_member(tenant_id)`; authenticated holds SELECT
// only — `0017`/`0018`/T40). No writes, no sync, no provider call, no credential of any kind.
//
// It reads ONLY the two Tier-1 metadata tables. It NEVER touches `connector_secrets` (the Tier-2 secret
// store is deny-all / no grant and stays that way). The DTO is a SAFE projection by construction: we
// select + expose only provider / display label / status / safe scopes / timestamps, and for the latest
// run its status / timestamps / safe failure code+label / safe counters. We DELIBERATELY never select or
// expose `tenant_id`, `organization_id`, `connected_by`, `health`, `last_sync_at`, or anything from
// `connector_secrets` (ciphertext, wrapped keys, key ids, tokens, …). `health`/`last_sync_at` are real
// sync state that does not exist yet (no runner) — shown as "Not built yet" on the page, not as data.

export type ConnectorRunSummary = {
  status: string;
  startedAt: string | null;
  completedAt: string | null;
  failureCode: string | null; // a stable machine code (e.g. auth_expired) — never a provider message/token
  failureLabel: string | null; // a short safe human label — never a secret/payload
  recordsSeen: number | null;
  recordsImported: number | null;
  recordsFailed: number | null;
};

export type ConnectorSummary = {
  id: string; // a lookup key only — never a tenant/org/user id
  provider: string;
  displayName: string | null;
  status: string;
  safeScopes: string[]; // granted_scopes_safe — already the non-sensitive scope list
  createdAt: string;
  updatedAt: string;
  lastRun: ConnectorRunSummary | null;
};

export type ConnectorListResult =
  | { ok: true; data: ConnectorSummary[] }
  | { ok: false; error: "query_failed" };

// Human-readable connector status. Unknown values pass through capitalized; never throws.
export function connectorStatusLabel(status: string): string {
  const known: Record<string, string> = {
    pending: "Pending",
    active: "Active",
    error: "Error",
    revoked: "Revoked",
    disabled: "Disabled",
  };
  return known[status] ?? status;
}

// Human-readable last-run status, or "—" when there is no run yet. Never throws.
export function runStatusLabel(status: string | null | undefined): string {
  if (!status) return "—";
  const known: Record<string, string> = {
    queued: "Queued",
    running: "Running",
    succeeded: "Succeeded",
    failed: "Failed",
    canceled: "Canceled",
    timed_out: "Timed out",
  };
  return known[status] ?? status;
}

// Safe, human-readable summary of a run's record counters — e.g. "3 seen · 3 imported" or "3 seen · 1 imported · 2
// failed". Counts only (never a row body / PII / token). Returns "" when no counter is present. Pure; never throws.
export function runCountsLabel(
  run: Pick<ConnectorRunSummary, "recordsSeen" | "recordsImported" | "recordsFailed">,
): string {
  const parts: string[] = [];
  if (run.recordsSeen != null) parts.push(`${run.recordsSeen} seen`);
  if (run.recordsImported != null) parts.push(`${run.recordsImported} imported`);
  if (run.recordsFailed != null && run.recordsFailed > 0) parts.push(`${run.recordsFailed} failed`);
  return parts.join(" · ");
}

// List the connectors the current user may read (RLS-scoped) + each connector's most recent run. Two
// RLS-filtered reads of Tier-1 tables only. Fails closed on the connectors read; a failed runs read is
// non-fatal (lastRun null) — a missing run must never erase a readable connector row.
export async function listConnectorsForCurrentUser(): Promise<ConnectorListResult> {
  const supabase = await createClient();

  const { data: connectors, error: connErr } = await supabase
    .from("connectors")
    // Explicit SAFE subset — NEVER tenant_id / organization_id / connected_by / health / last_sync_at.
    .select("id, provider, display_name, status, granted_scopes_safe, created_at, updated_at")
    .order("created_at", { ascending: false });
  if (connErr) {
    console.error("[data/connectors] listConnectorsForCurrentUser connectors query failed");
    return { ok: false, error: "query_failed" };
  }

  // Most-recent run per connector (RLS-scoped). Safe run columns only — NEVER tenant_id. Non-fatal: on
  // failure, connectors still list with lastRun = null. Ordered newest-first; first seen per id wins.
  const { data: runs, error: runsErr } = await supabase
    .from("connector_runs")
    .select("connector_id, status, started_at, completed_at, failure_code, failure_label, records_seen, records_imported, records_failed, created_at")
    .order("created_at", { ascending: false });
  if (runsErr) {
    console.error("[data/connectors] listConnectorsForCurrentUser connector_runs query failed (non-fatal)");
  }
  const latestRun = new Map<string, ConnectorRunSummary>();
  for (const r of runs ?? []) {
    if (latestRun.has(r.connector_id)) continue; // newest-first ordering → first seen is latest
    latestRun.set(r.connector_id, {
      status: r.status,
      startedAt: r.started_at,
      completedAt: r.completed_at,
      failureCode: r.failure_code,
      failureLabel: r.failure_label,
      recordsSeen: r.records_seen,
      recordsImported: r.records_imported,
      recordsFailed: r.records_failed,
    });
  }

  return {
    ok: true,
    data: (connectors ?? []).map((c) => ({
      id: c.id,
      provider: c.provider,
      displayName: c.display_name,
      status: c.status,
      safeScopes: c.granted_scopes_safe ?? [],
      createdAt: c.created_at,
      updatedAt: c.updated_at,
      lastRun: latestRun.get(c.id) ?? null,
    })),
  };
}
