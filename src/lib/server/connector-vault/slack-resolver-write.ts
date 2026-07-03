// Server-only SLACK RESOLVER WRITE PATH (Slack P0 PR 4 / docs/47). Turns ALREADY-VALIDATED Slack discovery facts (the
// PR #189 emitter output) into tenant-scoped graph rows: apps → app_users → people → app_user_identity_matches.
//
// SAFETY (this is the deep-gate boundary):
//   * tenant_id ALWAYS comes from the authenticated `authTenantId` argument — never a fact payload. A fact whose
//     `tenant_id` differs from `authTenantId` is a SPOOF and is SKIPPED (never writes another tenant's rows). With no
//     authenticated tenant, NOTHING is written.
//   * idempotent via DB-level tenant-scoped natural keys (migration 0036: apps(tenant_id, external_instance_id),
//     app_users(tenant_id, app_id, external_user_id), people(tenant_id, lower(primary_email))) + the existing
//     app_user_identity_matches(tenant_id, app_user_id) key (0028). The store upserts ON CONFLICT on those keys, so a
//     re-run updates in place — no duplicate rows. RLS (real, proven in org_rls_test.sql) is the authoritative tenant
//     boundary; this module is the user-scoped caller (no service-role).
//   * identity matching is EXACT-EMAIL ONLY (a person fact carries a normalized email) — no fuzzy/name-based merge.
//   * never persists a token / auth header / raw Slack user object. role/admin has NO dedicated column (schema gap) —
//     the safe role label rides app_users.raw_payload as sanitized provenance only. usage_activity has no table — the
//     last-active timestamp lands on app_users.last_active_at.
//   * one bad fact is skipped (counted) — it never blocks the rest (per-fact best-effort; every write is tenant-scoped).
//
// SERVER-ONLY: under `src/lib/server/`, the runtime browser sentinel below, and `no-client-import.test.ts`.

import type { DiscoveryFact } from "./discovery-facts";

// Runtime server-only sentinel — throw if evaluated in a browser.
if (typeof (globalThis as { window?: unknown }).window !== "undefined") {
  throw new Error("connector-vault/slack-resolver-write is server-only and must not be imported in client code");
}

// The injected USER-SCOPED store (the real Supabase/RLS impl is wired in a later PR; tests inject a mock — same pattern
// as resolver-write.ts / identity-match-write.ts). Every method is tenant-scoped via the natural keys in migration 0036.
export interface SlackResolverStore {
  // apps ON CONFLICT (tenant_id, external_instance_id) DO UPDATE (name/vendor/category/instance_url).
  upsertApp(input: { tenantId: string; externalInstanceId: string; name: string; vendorName?: string; category?: string; instanceUrl?: string }): Promise<{ appId: string }>;
  // app_users ON CONFLICT (tenant_id, app_id, external_user_id) DO UPDATE (email/display_name/status/last_active_at/raw_payload).
  // `lastSeenAt` (0040 presence): when set, the store ALSO writes last_seen_at + sync_status='active' — a present user
  // is (re)activated on every sync, including a previously-stale user that reappears.
  upsertAppUser(input: { tenantId: string; appId: string; externalUserId: string; email?: string; displayName?: string; status?: string; lastActiveAt?: string; lastSeenAt?: string; rawProvenance?: Record<string, string | number | boolean> }): Promise<{ appUserId: string }>;
  // 0040 ABSENCE MARKING — flip sync_status to 'stale' for THIS tenant+app's currently-'active' rows NOT seen at
  // observedAt (last_seen_at older than observedAt, or NULL from before tracking). UPDATE only — NEVER a delete;
  // last_seen_at keeps its prior value (the honest "last time we saw them"). RLS (the existing 0004 update policy)
  // enforces the tenant. Returns the count marked (0 on an idempotent re-run: absent rows are already 'stale').
  markAbsentAppUsersStale(input: { tenantId: string; appId: string; observedAt: string }): Promise<{ staleMarked: number }>;
  // people ON CONFLICT (tenant_id, lower(primary_email)) DO UPDATE (full_name).
  upsertPerson(input: { tenantId: string; primaryEmail: string; fullName?: string }): Promise<{ personId: string }>;
  // The EXISTING match person for (tenant_id, app_user_id), or null — used to PROTECT a prior identity decision
  // (the 0028 invariant: a deterministic re-run must NEVER silently overwrite a different/human-confirmed person).
  getExistingMatchPersonId(input: { tenantId: string; appUserId: string }): Promise<string | null>;
  // INSERT a deterministic match ON CONFLICT (tenant_id, app_user_id) DO NOTHING — NEVER overwrites an existing match.
  // Same contract as identity-match-write.ts (0028 key; DO NOTHING + caller-side conflict guard). Returns {created}.
  insertMatch(input: { tenantId: string; appUserId: string; personId: string; matchMethod: "auto_exact_email" }): Promise<{ created: boolean }>;
}

export type SlackResolutionSummary = {
  appsUpserted: number;
  appUsersUpserted: number;
  peopleUpserted: number;
  matchesUpserted: number;
  matchConflicts: number; // existing match points at a DIFFERENT person → left for review, NOT overwritten (0028 invariant)
  skipped: number; // facts ignored (wrong tenant, unsupported type, missing required field)
  staleMarked: number; // 0040 absence marking — app_users flipped active→stale this run (0 when guarded off / none absent)
  gaps: string[]; // schema-gap notes (e.g. role_admin has no column) — documentation, not an error
};

const isStr = (v: unknown): v is string => typeof v === "string" && v.length > 0;
const f = (fact: DiscoveryFact) => fact as unknown as Record<string, unknown>; // narrow to read optional fields safely

// Resolve validated Slack discovery facts into the tenant graph. Per-fact best-effort; every write uses authTenantId.
export async function applySlackDiscoveryResolution(
  store: SlackResolverStore,
  authTenantId: string,
  facts: readonly DiscoveryFact[],
  // `syncComplete` (#234 truncation hardening): absence/stale marking runs ONLY when the provider returned a COMPLETE
  // user list (no truncation/cursor loop). A partial fetch would make absent-looking users falsely stale, so it is
  // skipped (present users are still upserted — non-destructive). Defaults to `true` (a caller that fully controls the
  // fact set, e.g. a direct unit test); the real orchestrator threads the client's completeness signal.
  opts?: { syncComplete?: boolean },
): Promise<SlackResolutionSummary> {
  const syncComplete = opts?.syncComplete ?? true;
  const summary: SlackResolutionSummary = { appsUpserted: 0, appUsersUpserted: 0, peopleUpserted: 0, matchesUpserted: 0, matchConflicts: 0, skipped: 0, staleMarked: 0, gaps: [] };
  if (!isStr(authTenantId)) return summary; // fail closed — no authenticated tenant, nothing written
  if (!Array.isArray(facts)) return summary;

  // Only facts that belong to the authenticated tenant are eligible (a spoofed payload tenant_id is dropped here).
  const mine = facts.filter((x) => f(x).tenant_id === authTenantId);
  summary.skipped += facts.length - mine.length;
  const byType = (t: string) => mine.filter((x) => f(x).fact_type === t);

  // 1. App: the app_instance_identity fact carries external_instance_id (= Slack team_id); app_discovery carries name.
  const instance = byType("app_instance_identity")[0];
  if (!instance) {
    // no workspace anchor → cannot place app_users; skip the remaining graph (counted), document nothing to write.
    summary.skipped += mine.length - byType("app_instance_identity").length;
    return summary;
  }
  const externalInstanceId = isStr(f(instance).external_instance_id) ? (f(instance).external_instance_id as string) : null;
  if (!externalInstanceId) { summary.skipped += mine.length; return summary; }
  const appName = (() => {
    const disc = byType("app_discovery")[0];
    return disc && isStr(f(disc).discovered_app_name) ? (f(disc).discovered_app_name as string) : "Slack";
  })();
  const disc = byType("app_discovery")[0];
  const { appId } = await store.upsertApp({
    tenantId: authTenantId,
    externalInstanceId,
    name: appName,
    ...(disc && isStr(f(disc).discovered_vendor_name) ? { vendorName: f(disc).discovered_vendor_name as string } : {}),
    ...(disc && isStr(f(disc).category) ? { category: f(disc).category as string } : {}),
    ...(isStr(f(instance).instance_url) ? { instanceUrl: f(instance).instance_url as string } : {}),
  });
  summary.appsUpserted++;

  // 2. app_users — one per app_user_account fact. external_user_id is the deterministic anchor; role (no column) +
  //    safe scalars ride raw_payload as sanitized provenance. Build externalUserId → appUserId for matching.
  const appUserIdByExternal = new Map<string, string>();
  for (const acct of byType("app_user_account")) {
    const extId = isStr(f(acct).app_user_external_id) ? (f(acct).app_user_external_id as string) : isStr(f(acct).source_user_id) ? (f(acct).source_user_id as string) : null;
    if (!extId) { summary.skipped++; continue; }
    const prov = f(acct).provenance && typeof f(acct).provenance === "object" ? (f(acct).provenance as Record<string, string | number | boolean>) : undefined;
    const rawProvenance: Record<string, string | number | boolean> = { provider: "slack" }; // SANITIZED — never the raw Slack object
    if (prov && isStr(prov.slack_role_hint)) rawProvenance.role_hint = prov.slack_role_hint as string;
    // deleted-vs-absent (0040): a Slack-DELETED user is still RETURNED by users.list → PRESENT (stays sync_status
    // 'active'); the deletion is recorded as sanitized provenance so it stays distinguishable from an ABSENT ('stale') user.
    if (prov && prov.slack_is_deleted === true) rawProvenance.slack_is_deleted = true;
    const { appUserId } = await store.upsertAppUser({
      tenantId: authTenantId,
      appId,
      externalUserId: extId,
      ...(isStr(f(acct).email) ? { email: f(acct).email as string } : {}), // OPTIONAL — missing email still writes the app_user
      ...(isStr(f(acct).display_name) ? { displayName: f(acct).display_name as string } : {}),
      ...(isStr(f(acct).status) ? { status: f(acct).status as string } : {}),
      ...(isStr(f(acct).last_activity_at) ? { lastActiveAt: f(acct).last_activity_at as string } : {}), // usage_activity folds here
      ...(isStr(f(acct).observed_at) ? { lastSeenAt: f(acct).observed_at as string } : {}), // 0040 presence: seen this run → active
      rawProvenance,
    });
    appUserIdByExternal.set(extId, appUserId);
    summary.appUsersUpserted++;
  }

  // 3. people + identity matches — ONLY from person_identity_candidate facts (which exist ONLY when email exists).
  //    The person fact's identity_provider_id is the `{team_id}:{user_id}` anchor → recover the app_user via user_id.
  for (const person of byType("person_identity_candidate")) {
    const email = isStr(f(person).primary_email) ? (f(person).primary_email as string) : null;
    if (!email) { summary.skipped++; continue; } // schema requires primary_email; defensive
    const { personId } = await store.upsertPerson({
      tenantId: authTenantId,
      primaryEmail: email,
      ...(isStr(f(person).display_name) ? { fullName: f(person).display_name as string } : {}),
    });
    summary.peopleUpserted++;
    const anchor = isStr(f(person).identity_provider_id) ? (f(person).identity_provider_id as string) : "";
    const userId = anchor.includes(":") ? anchor.slice(anchor.indexOf(":") + 1) : anchor;
    const appUserId = appUserIdByExternal.get(userId);
    if (appUserId) {
      // PROTECT a prior identity decision (0028 invariant): if this app_user already matches a DIFFERENT person, leave
      // it for review — a deterministic re-run must NEVER silently overwrite it. Same person → idempotent no-op.
      const existing = await store.getExistingMatchPersonId({ tenantId: authTenantId, appUserId });
      if (existing && existing !== personId) { summary.matchConflicts++; continue; }
      const { created } = await store.insertMatch({ tenantId: authTenantId, appUserId, personId, matchMethod: "auto_exact_email" });
      if (created) summary.matchesUpserted++;
    }
  }

  // role_admin: no dedicated column on app_users / no role table (documented gap) — the safe role label is carried on
  // app_users.raw_payload (above). usage_activity: no table — folded into app_users.last_active_at (above).
  const roleAdminN = byType("role_admin").length;
  const usageN = byType("usage_activity").length;
  summary.skipped += roleAdminN + usageN;
  if (roleAdminN > 0) summary.gaps.push("role_admin: no role column on app_users — role carried as app_users.raw_payload provenance (schema gap; future PR)");
  if (usageN > 0) summary.gaps.push("usage_activity: no usage table — last-active folded into app_users.last_active_at");

  // 4. ABSENCE MARKING (0040) — reached ONLY here, i.e. only after EVERY write above succeeded (any store throw aborts
  //    the resolution before this line, so a failed/partial sync never marks stale). GUARDS: at least one app_user was
  //    actually seen this run (a 0-user "successful" sync is suspicious — scope/permission regression — never mass-mark),
  //    and a well-formed observed_at exists. UPDATE-only (never a delete); tenant+app-scoped; idempotent (re-running the
  //    same observedAt marks 0 — present rows have last_seen_at == observedAt, absent rows are already 'stale').
  // TRUNCATION GUARD (#234, now enforced by `syncComplete`): absence marking must only run on a COMPLETE user list.
  // slack-client.ts caps users.list at MAX_PAGES and stops on a repeating cursor — but it now REPORTS that via
  // `ListUsersResult.complete`, and the orchestrator threads it here as `syncComplete`. A truncated/looping fetch
  // (complete:false) skips marking below, so a >20k-member workspace or a cursor loop can no longer mark the unfetched
  // tail stale. (A hard mid-stream error already throws and fails the whole sync before this point.)
  const observedAt = isStr(f(instance).observed_at) ? (f(instance).observed_at as string) : null;
  // GATE: mark stale ONLY on a COMPLETE fetch (syncComplete) with ≥1 user seen and a valid observed_at. An incomplete
  // fetch (truncation/cursor loop) skips marking entirely — present users are already upserted (non-destructive).
  if (syncComplete && summary.appUsersUpserted > 0 && observedAt) {
    const { staleMarked } = await store.markAbsentAppUsersStale({ tenantId: authTenantId, appId, observedAt });
    summary.staleMarked = staleMarked;
  }

  return summary;
}
