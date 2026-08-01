#!/usr/bin/env bash
#
# test-rls.sh — apply all Supabase migrations to a throwaway Postgres and run the
# RLS assertion suite. Same script runs locally and in CI (see .github/workflows/rls-tests.yml).
#
# It NEVER touches hosted Supabase and uses no service-role keys: it spins up a
# local postgres:16 container, installs a minimal Supabase-style `auth` shim
# (auth.uid() + the authenticated/service_role roles that hosted Supabase provides),
# applies supabase/migrations/*.sql in order, then runs supabase/tests/*_test.sql
# with ON_ERROR_STOP=1 so any failed assertion fails the script (and CI).
#
# Usage: bash scripts/test-rls.sh
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
IMAGE="${POSTGRES_IMAGE:-postgres:16-alpine}"
C="idc_rls_test_$$"

command -v docker >/dev/null 2>&1 || { echo "ERROR: docker is required but not found"; exit 1; }

cleanup() { docker rm -f "$C" >/dev/null 2>&1 || true; }
trap cleanup EXIT  # remove the container even if a test fails

shopt -s nullglob
migrations=("$REPO"/supabase/migrations/*.sql)
tests=("$REPO"/supabase/tests/*_test.sql)
[ ${#migrations[@]} -gt 0 ] || { echo "ERROR: no migrations in supabase/migrations/"; exit 1; }
[ ${#tests[@]} -gt 0 ]      || { echo "ERROR: no *_test.sql in supabase/tests/"; exit 1; }

echo "==> starting $IMAGE ($C)"
docker run -d --name "$C" -e POSTGRES_PASSWORD=postgres "$IMAGE" >/dev/null

# The official image starts a temp server for init then restarts; require 3
# consecutive successful queries before proceeding to dodge that race.
ok=0
for _ in $(seq 1 60); do
  if docker exec "$C" psql -U postgres -tAc 'select 1' >/dev/null 2>&1; then
    ok=$((ok + 1)); [ "$ok" -ge 3 ] && break
  else ok=0; fi
  sleep 1
done
[ "$ok" -ge 3 ] || { echo "ERROR: postgres did not become ready"; exit 1; }

psql_q()  { docker exec -i "$C" psql -U postgres -d postgres -v ON_ERROR_STOP=1 -q; }
psql_run(){ docker exec -i "$C" psql -U postgres -d postgres -v ON_ERROR_STOP=1; }

echo "==> installing Supabase-style auth shim + roles"
psql_q <<'SQL'
create schema if not exists auth;
create table if not exists auth.users (id uuid primary key, email text);

-- Mirror Supabase's auth.uid(): read the JWT sub from the request GUC.
create or replace function auth.uid() returns uuid language sql stable as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim.sub', true), ''),
    nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'
  )::uuid;
$$;

do $$ begin
  if not exists (select from pg_roles where rolname='anon')          then create role anon nologin; end if;
  if not exists (select from pg_roles where rolname='authenticated') then create role authenticated nologin; end if;
  if not exists (select from pg_roles where rolname='service_role')  then create role service_role nologin bypassrls; end if;
end $$;

grant usage on schema auth, public to anon, authenticated, service_role;
SQL

for m in "${migrations[@]}"; do
  echo "==> migration $(basename "$m")"
  psql_q < "$m"
done

echo "==> applying test-role grants (RLS still does the filtering)"
psql_q <<'SQL'
grant select, insert, update, delete on all tables in schema public to authenticated, service_role;
grant usage, select on all sequences in schema public to authenticated, service_role;
grant execute on all functions in schema public to authenticated, service_role;
grant select on auth.users to authenticated, service_role;

-- `public.files` privileges are MIGRATION-OWNED (0013/0015/0016) and are the security boundary of the
-- contract-file surface. The blanket grant above re-broadens EVERY table for `authenticated` (it grants
-- update + delete on all tables), which would MASK the 0016 revoke and let a broad/incorrect grant slip
-- through unnoticed (exactly the bug staging caught — broad DELETE/TRUNCATE/UPDATE on files). Re-assert
-- the migration-intended `files` grants for `authenticated` so the suite (T37) reflects the REAL hosted
-- privilege surface: SELECT + INSERT, UPDATE only on upload_status, NO DELETE, NO TRUNCATE. `service_role`
-- is untouched. KEEP IN LOCKSTEP with migration 0016's revoke/grant — if 0016's files grant ever changes,
-- update these two lines too, or the blanket grant above would mask the difference (T37's exact-column
-- invariant assertion is the backstop that fails loudly if they drift).
revoke update, delete, truncate on public.files from authenticated;

-- Same reasoning for the Phase-8 app-account evidence tables (0076): the migration revokes ALL from every browser role and
-- from connector_runner, because reads go through product RPCs and writes go through definer promote RPCs. The blanket grant
-- above would mask that, so the suite could not detect a table accidentally becoming browser-readable. KEEP IN LOCKSTEP with
-- 0076's revoke block.
revoke all on public.app_accounts from anon, authenticated, connector_runner;
revoke all on public.app_account_groups from anon, authenticated, connector_runner;
revoke all on public.app_account_group_memberships from anon, authenticated, connector_runner;
revoke all on public.app_account_identity_matches from anon, authenticated, connector_runner;
revoke all on public.connector_capability_state from anon, authenticated, connector_runner;
-- 0077 adds one more (per-resource run completeness). Same posture, same lockstep rule.
revoke all on public.connector_run_resource_discovery from anon, authenticated, connector_runner;
grant update (upload_status) on public.files to authenticated;

-- The `runner_*` functions are TRUSTED-PRODUCER ONLY: their migrations grant EXECUTE to `connector_runner` and to nobody else,
-- because they record facts about the outside world that only the runner observes. The blanket `grant execute on all functions`
-- above hands every one of them to `authenticated`, which MASKS that boundary completely — under this harness a browser role
-- appears able to call them, so a missing or wrong grant could never be detected. Same masking class as the files/0016 and
-- connector-vault/0018 re-asserts above. Re-revoke them so the suite reflects the REAL hosted surface.
--
-- ONLY the browser roles are revoked here. `connector_runner`'s own access is left exactly as the migrations set it — some
-- runner_* helpers are internal fencing functions that the runner must NOT hold (CP9c asserts precisely that), so re-granting
-- across the board would break a real boundary while pretending to restore one.
--
-- 0064's V0 is the backstop that fails loudly if this drifts.
do $$
declare f record;
begin
  for f in
    select p.oid::regprocedure as sig
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and (p.proname like 'runner\_%'
           -- TRIGGER functions are invoked BY a trigger and never called directly; a browser role holding EXECUTE on one is
           -- meaningless at best and, for the SECURITY DEFINER audit writers, a forgery surface. The blanket grant above hands
           -- them out, masking the migration-intended posture exactly as it did for runner_* (0068 caught this).
           or p.prorettype = 'pg_catalog.trigger'::regtype)
  loop
    execute format('revoke all on function %s from authenticated, anon, service_role, public', f.sig);
  end loop;
end $$;

-- The connector-vault tables (migrations 0017 + 0018) have a least-privilege grant surface that the
-- blanket grant above re-broadens (it grants select/insert/update/delete on ALL tables to authenticated),
-- which would MASK the intended posture — exactly the 0015/0016/0018 masking gap (staging verification of
-- 0017 caught broad INSERT/UPDATE/DELETE/TRUNCATE/REFERENCES/TRIGGER on connectors/connector_runs that the
-- prior partial re-assert here had let slip). MIRROR migration 0018 exactly so the suite reflects the REAL
-- hosted surface: `revoke all` from authenticated/anon on all three, then `grant select` back to
-- authenticated on the two Tier-1 metadata tables only. After this: authenticated = SELECT on
-- connectors/connector_runs and NOTHING on connector_secrets; anon = NOTHING on all three. KEEP IN
-- LOCKSTEP with migration 0018 (T39/T40's exact-privilege arrays are the backstop that fails loudly on drift).
-- oauth_pending (migration 0020) is a near-Tier-2 deny-all store (RLS-enabled, ZERO policies, no grant —
-- like connector_secrets); the blanket grant above re-broadens it too, so revoke it back here (NOTHING is
-- granted to authenticated/anon on it). T42's exact-zero-privilege array is the backstop.
-- connector_app_secrets (migration 0035) is the APP-SCOPED OAuth client-secret store — another Tier-2 deny-all
-- table (RLS-enabled, ZERO policies, no grant); revoke it back here too. T56's deny-all assertions are the backstop.
-- connector_credential_references (migration 0043) is the credential-reference Tier-2 deny-all table (RLS-enabled, ZERO
-- policies, revoke-all from anon/authenticated; connector_runner column-SELECT only); revoke it back here too so the suite
-- mirrors the real deny-all posture. connector_credential_reference_test's C3 exact-zero-privilege array is the backstop.
-- The connector-run CONTROL PLANE (migration 0044) — connector_run_authorizations/attempts/locks/alerts, connector_schedule_policies,
-- connector_kill_switches — are all Tier-2 deny-all tables (RLS-enabled, ZERO policies, revoke-all from anon/authenticated; all
-- mutation via SECURITY DEFINER functions only). Revoke them back here so the suite mirrors the real deny-all posture; the
-- connector_run_control_plane_test exact-zero-privilege arrays are the backstop.
-- The canonical directory graph tables (migrations 0053/0054/0056/0057/0059) are Tier-2 deny-all: RLS-enabled, ZERO SELECT policies,
-- revoke-all from anon/authenticated/connector_runner; the ONLY customer read path is the 0061 authenticated SECURITY DEFINER RPCs
-- (no direct table grant). The blanket `grant select on all tables` above re-broadens them here (the exact masking gap this line closes),
-- so re-revoke so the suite mirrors the real deny-all posture. access_product_read_rpcs_test's AR0 exact-zero-privilege check is the backstop.
revoke all on public.connector_secrets, public.connectors, public.connector_runs, public.oauth_pending, public.connector_app_secrets, public.connector_credential_references, public.connector_run_authorizations, public.connector_run_attempts, public.connector_run_locks, public.connector_run_alerts, public.connector_schedule_policies, public.connector_schedule_slots, public.connector_kill_switches, public.connector_pilot_enrollments, public.connector_pilot_consents, public.connector_pilot_incidents, public.connector_pilot_exit_reviews, public.connector_pilot_deletion_jobs, public.connector_okta_issuer_bindings, public.directory_groups, public.directory_group_memberships, public.directory_applications, public.directory_application_user_assignments, public.directory_application_group_assignments from authenticated, anon;
-- NOTE: identity_accounts is a SHARED legacy table other suites read as authenticated (RLS returns 0 rows via its no-policy deny-all);
-- leave the harness grant so those RLS-filtered reads stay 0-rows rather than permission-denied. Its real protection (RLS + zero SELECT
-- policy) is migration-controlled and asserted directly by access_product_read_rpcs_test AR0; the customer access-graph read path is the
-- 0061 SECURITY DEFINER RPCs regardless of any direct grant.
grant select on public.connectors, public.connector_runs to authenticated;
-- connector_okta_issuer_bindings (0048): hosted posture is SELECT-only for authenticated (org-manager RLS scopes rows), NO write.
grant select on public.connector_okta_issuer_bindings to authenticated;
-- The 0044 control-plane FUNCTIONS are the security boundary (all mutation is via them). On hosted Supabase, migration 0045
-- revokes EXECUTE from public/anon/authenticated (0044 alone only revoked from public, and Supabase's ALTER DEFAULT PRIVILEGES
-- grants anon/authenticated EXECUTE on function creation — the real gap 0045 closes). But the blanket `grant execute on all
-- functions ... to authenticated` above RE-broadens them here, so re-revoke them from authenticated/anon in lockstep so the suite
-- reflects the REAL hosted (post-0045) deny posture (connector_run_control_plane_test's CP9/CP9b asserts are the backstop).
-- connector_runner keeps its explicit grants; the 0041 runner_open/finish/insert functions are intentionally NOT in this list.
do $$ declare f record; begin
  for f in select p.oid::regprocedure as sig from pg_proc p where p.pronamespace='public'::regnamespace and p.proname in (
    'admin_create_run_authorization','admin_approve_run_authorization','admin_cancel_run_authorization','admin_expire_stale_authorizations',
    'admin_reconcile_stuck_run','admin_upsert_schedule_policy','admin_upsert_kill_switch','connector_execution_permitted','runner_read_authorization',
    'runner_assert_no_active_run','runner_claim_authorization','runner_acquire_lock','runner_assert_fencing','runner_renew_lock','runner_release_lock',
    'runner_mark_launch_attempted','runner_record_task_identity','runner_record_start','runner_record_success','runner_record_failure',
    'runner_record_timeout','runner_record_ambiguous','runner_reconcile_result','runner_record_alert','runner_latest_run_state',
    'admin_create_schedule_policy','admin_approve_schedule_policy','admin_enable_schedule_policy','admin_disable_schedule_policy',
    'admin_reconcile_stuck_slot','scheduler_materialize_slot','scheduler_begin_slot','scheduler_finalize_slot','scheduler_policy_state',
    'admin_create_pilot_enrollment','admin_record_pilot_consent','admin_approve_pilot_enrollment','admin_enable_pilot_enrollment',
    'admin_set_pilot_status','admin_expire_stale_pilots','admin_withdraw_pilot_consent','admin_pilot_incident_hold',
    'admin_record_pilot_exit_review','admin_create_pilot_deletion_job','admin_approve_pilot_deletion_job',
    'runner_read_pilot','runner_assert_pilot_authorized','runner_record_pilot_run',
    'runner_assert_not_pilot_governed','connector_pilot_ref_is_sensitive')
  loop execute format('revoke execute on function %s from authenticated, anon', f.sig); end loop;
end $$;
SQL

for t in "${tests[@]}"; do
  echo "==> running $(basename "$t")"
  psql_run < "$t"
done

echo "==> RLS migration tests passed"
