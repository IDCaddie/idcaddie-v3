import { createClient } from "@/lib/supabase/server";

// Server-only, read-only "People / Users" view = the IDENTITY ACCOUNTS the current user may read,
// aggregated across the apps they can see. It reuses ONLY surfaces already proven safe + surfaced on
// app detail: `app_users` (org-scoped read `0007`), `apps` (for the app name), and the match status
// from `app_user_identity_matches` (org-scoped read `0008`). RLS is the authorization boundary — no
// caller tenant_id, no service-role, no writes, no embedded joins.
//
// DELIBERATELY NOT the people directory: this exposes NO person PII (no `people` row, no `person_id`,
// no identity-provider id/email/status) — only the app account's OWN fields (which app detail already
// shows) + a matched/unmatched STATUS. The org-scoped `people`/`identity_accounts` read stays deferred
// (RISK-002). Accounts are NOT grouped/resolved (identity resolution is not built); this is a flat
// read-only list, so it never implies a match/merge the system has not actually made.

export type IdentityAccountRow = {
  id: string; // the app_user (account) id — only a lookup key, never a tenant/person id
  appId: string;
  appName: string;
  displayName: string | null;
  email: string | null;
  status: string | null;
  licenseType: string | null;
  lastActiveAt: string | null;
  matched: boolean; // a visible identity match exists for this account (trust only if matchStatusAvailable)
};

export type IdentityAccountsView = {
  accounts: IdentityAccountRow[];
  totalAccounts: number;
  distinctApps: number;
  matchedAccounts: number;
  unmatchedAccounts: number;
  // false ⇒ the match read failed; render the match status as unknown ("—"), never a misleading "unmatched".
  matchStatusAvailable: boolean;
};

export type IdentityAccountsResult =
  | { ok: true; data: IdentityAccountsView }
  | { ok: false; error: "query_failed" };

const EMPTY_VIEW: IdentityAccountsView = {
  accounts: [],
  totalAccounts: 0,
  distinctApps: 0,
  matchedAccounts: 0,
  unmatchedAccounts: 0,
  matchStatusAvailable: true,
};

// List the readable identity accounts (app_users) with their app name + matched/unmatched status, plus a
// summary. RLS scopes every read; a failed core read collapses to a safe label. A failed MATCH read is
// non-fatal — the accounts still render with an unknown match status (matchStatusAvailable=false).
export async function listIdentityAccountsForCurrentUser(): Promise<IdentityAccountsResult> {
  const supabase = await createClient();

  // 1) The app_users you may read (RLS `0007`).
  const { data: users, error: usersErr } = await supabase
    .from("app_users")
    .select("id, app_id, display_name, email, status, license_type, last_active_at")
    .order("display_name", { ascending: true });
  if (usersErr) {
    console.error("[data/people] listIdentityAccountsForCurrentUser app_users query failed");
    return { ok: false, error: "query_failed" };
  }
  const rows = users ?? [];
  if (rows.length === 0) return { ok: true, data: EMPTY_VIEW };

  // 2) App names (RLS) — id → name map. You can read these apps (you read their app_users).
  const { data: apps, error: appsErr } = await supabase.from("apps").select("id, name");
  if (appsErr) {
    console.error("[data/people] listIdentityAccountsForCurrentUser apps query failed");
    return { ok: false, error: "query_failed" };
  }
  const appName = new Map((apps ?? []).map((a) => [a.id, a.name]));

  // 3) Match status for these accounts (RLS `0008`) — non-fatal: a failure ⇒ unknown status, not "unmatched".
  const { data: matches, error: matchErr } = await supabase
    .from("app_user_identity_matches")
    .select("app_user_id")
    .in(
      "app_user_id",
      rows.map((r) => r.id),
    );
  const matchStatusAvailable = !matchErr;
  if (matchErr) {
    console.error("[data/people] listIdentityAccountsForCurrentUser matches query failed (non-fatal)");
  }
  const matchedSet = new Set(
    (matchStatusAvailable && matches ? matches : []).map((m) => m.app_user_id),
  );

  const accounts: IdentityAccountRow[] = rows.map((u) => ({
    id: u.id,
    appId: u.app_id,
    appName: appName.get(u.app_id) ?? "—",
    displayName: u.display_name,
    email: u.email,
    status: u.status,
    licenseType: u.license_type,
    lastActiveAt: u.last_active_at,
    matched: matchedSet.has(u.id),
  }));

  const distinctApps = new Set(rows.map((r) => r.app_id)).size;
  const matchedAccounts = accounts.filter((a) => a.matched).length;

  return {
    ok: true,
    data: {
      accounts,
      totalAccounts: accounts.length,
      distinctApps,
      matchedAccounts: matchStatusAvailable ? matchedAccounts : 0,
      unmatchedAccounts: matchStatusAvailable ? accounts.length - matchedAccounts : 0,
      matchStatusAvailable,
    },
  };
}
