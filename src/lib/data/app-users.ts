import { createClient } from "@/lib/supabase/server";
import type { DataResult } from "@/lib/data/apps";

// Server-only, read-only access to an app's user roster (`app_users`), scoped by RLS. `app_users`
// gained an org-scoped SELECT policy in migration 0007 (PR #21): a user may read an app_user row iff
// they can already read the linked app. This lists the roster rows the current user may read for one app.
//
// Boundary: imports the user-scoped server client (server-only). NEVER uses a service-role/admin
// client, takes NO tenant_id from the caller as authorization, and relies entirely on RLS. `appId`
// is ONLY a lookup key. Reads **only direct `app_users` columns** — no `people`, `identity_accounts`,
// `app_user_identity_matches`, `license_rules`, `license_evaluations`, `files`, or `invoices` (those
// remain default-deny / tenant-only). No identity matching, no license utilization, no provisioning.

// Safe DTO for one roster row — an explicit subset of direct `app_users` columns. `raw_payload` and
// internal provenance (`source`) are deliberately excluded.
export type AppUserSummary = {
  id: string;
  displayName: string | null;
  email: string | null;
  externalUserId: string | null;
  status: string | null;
  licenseType: string | null;
  lastActiveAt: string | null;
};

// List the app_users for one app that the current user may read. RLS (`0007` org-scoped read +
// existing tenant-member read) decides visibility — we pass no tenant filter; the database is the
// authorization boundary. No service-role, no writes.
export async function listAppUsersForApp(
  appId: string,
): Promise<DataResult<AppUserSummary[]>> {
  const supabase = await createClient();

  const { data, error } = await supabase
    .from("app_users")
    .select("id, display_name, email, external_user_id, status, license_type, last_active_at")
    .eq("app_id", appId)
    .order("display_name", { ascending: true });

  if (error) {
    console.error("[data/app-users] listAppUsersForApp query failed");
    return { ok: false, error: "query_failed" };
  }

  return {
    ok: true,
    data: (data ?? []).map((u) => ({
      id: u.id,
      displayName: u.display_name,
      email: u.email,
      externalUserId: u.external_user_id,
      status: u.status,
      licenseType: u.license_type,
      lastActiveAt: u.last_active_at,
    })),
  };
}
