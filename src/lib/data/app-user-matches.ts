import { createClient } from "@/lib/supabase/server";
import type { DataResult } from "@/lib/data/apps";

// Server-only, read-only access to app-user identity MATCH status (`app_user_identity_matches`),
// scoped by RLS. Migration 0008 (PR #23) makes this table org-scoped read: a match row is visible iff
// the caller can read the linked `app_user` (itself org-scoped by 0007). This returns the readable
// match rows for a set of app_users so the roster can show a minimal matched / unmatched status.
//
// Boundary: user-scoped server client; NO service-role; NO tenant_id from the caller. Queries ONLY
// `app_user_identity_matches` — never `people`, `identity_accounts`, `license_*`, `files`, `invoices`.
// Exposes NO PII: no `person_id`, no identity-account id, no person name, no IdP provider/status/email,
// no `raw_payload`. "Unmatched" is derived in server code (the page) by comparing the visible app_users
// against these visible match rows — never by reading `people`/`identity_accounts`.

// Minimal match DTO — match metadata only, keyed by the app_user it belongs to. No person/identity fields.
export type AppUserMatch = {
  appUserId: string;
  matchMethod: string;
  confidence: number | null;
  reviewedAt: string | null;
};

// List the readable identity matches for a set of app_users (typically one app's roster). RLS (`0008`)
// returns only matches whose `app_user` the caller may read; we additionally pass the app_user ids so
// the query is scoped to the roster in view. No service-role, no writes.
export async function listMatchesForAppUsers(
  appUserIds: string[],
): Promise<DataResult<AppUserMatch[]>> {
  if (appUserIds.length === 0) return { ok: true, data: [] };

  const supabase = await createClient();

  const { data, error } = await supabase
    .from("app_user_identity_matches")
    .select("app_user_id, match_method, confidence, reviewed_at")
    .in("app_user_id", appUserIds);

  if (error) {
    console.error("[data/app-user-matches] listMatchesForAppUsers query failed");
    return { ok: false, error: "query_failed" };
  }

  return {
    ok: true,
    data: (data ?? []).map((m) => ({
      appUserId: m.app_user_id,
      matchMethod: m.match_method,
      confidence: m.confidence,
      reviewedAt: m.reviewed_at,
    })),
  };
}
