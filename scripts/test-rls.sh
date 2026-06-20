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
grant update (upload_status) on public.files to authenticated;

-- `public.connector_secrets` (migration 0017) is the connector-vault SECRET tier: DENY-ALL for the
-- request-path role (RLS-enabled, ZERO policies, no migration grant). The blanket grant above re-broadens
-- it (select/insert/update/delete on ALL tables to authenticated), which would MASK the deny-all and let
-- a secret-table grant slip through — exactly the 0015/0016 masking gap. Re-assert the migration-intended
-- deny-all so the suite (T39) reflects the REAL hosted privilege surface: `authenticated`/`anon` hold NO
-- privilege on connector_secrets. The Tier-1 metadata tables keep SELECT-only (migration 0017 grants
-- SELECT to authenticated; the blanket crutch adds INSERT/UPDATE/DELETE which 0017 never granted, so
-- re-assert those away too). KEEP IN LOCKSTEP with migration 0017 (T39/T38's exact-privilege invariants
-- are the backstop that fails loudly if they drift).
revoke all on public.connector_secrets from authenticated, anon;
revoke insert, update, delete, truncate on public.connectors, public.connector_runs from authenticated, anon;
SQL

for t in "${tests[@]}"; do
  echo "==> running $(basename "$t")"
  psql_run < "$t"
done

echo "==> RLS migration tests passed"
