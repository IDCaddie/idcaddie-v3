import { createClient } from "@/lib/supabase/server";

// Server-only, read-only access to recent `audit_logs` entries the current user may read. RLS is the
// authorization boundary: `audit_logs` has a tenant-member SELECT policy (`is_tenant_member(tenant_id)`,
// `0001`) and is append-only (`reject_audit_mutation`, `0002` — no UPDATE/DELETE). We pass no tenant
// filter; the database scopes the rows. No service-role, no writes.
//
// SAFE DTO by construction: we select + expose ONLY action / resource_type (the entity/table) /
// created_at + a boolean "actor recorded" label. We DELIBERATELY do NOT select or expose `tenant_id`,
// `actor_user_id` (raw id), `resource_id`, `ip_address`, `user_agent`, or the `before_json`/`after_json`
// diff blobs (which can carry sensitive internals). before/after diff rendering stays deferred.

export type AuditEntry = {
  id: string; // the audit row's own id — used only as a list key, never a tenant/actor/resource id
  action: string;
  resourceType: string;
  createdAt: string;
  actorRecorded: boolean; // whether an actor was recorded — NOT the raw actor id
};

export type AuditResult =
  | { ok: true; data: AuditEntry[] }
  | { ok: false; error: "query_failed" };

// Most recent N audit entries the user may read (RLS-scoped, capped — never a broad export).
const AUDIT_PAGE_LIMIT = 50;

export async function listRecentAuditEntriesForCurrentUser(): Promise<AuditResult> {
  const supabase = await createClient();

  const { data, error } = await supabase
    .from("audit_logs")
    // Explicit safe column subset — never `tenant_id`/`before_json`/`after_json`/`ip_address`/`user_agent`.
    .select("id, action, resource_type, actor_user_id, created_at")
    .order("created_at", { ascending: false })
    .limit(AUDIT_PAGE_LIMIT);

  if (error) {
    console.error("[data/audit] listRecentAuditEntriesForCurrentUser query failed");
    return { ok: false, error: "query_failed" };
  }

  return {
    ok: true,
    data: (data ?? []).map((r) => ({
      id: r.id,
      action: r.action,
      resourceType: r.resource_type,
      createdAt: r.created_at,
      actorRecorded: r.actor_user_id !== null, // boolean label only — the raw id never leaves the DAL
    })),
  };
}
