#!/usr/bin/env bash
#
# test-safeupdate.sh — run the migration chain and the SQL suites against Supabase's OWN Postgres image with the
# `safeupdate` extension preloaded, i.e. the hosted behaviour that `scripts/test-rls.sh` cannot reproduce.
#
# WHY THIS EXISTS. Managed Supabase preloads `safeupdate`, which rejects any UPDATE/DELETE whose parse tree has no
# WHERE clause. Stock `postgres:16-alpine` does not, so a WHERE-less statement inside a function passes every local
# suite and CI, and fails only in production-like environments. Migration 0083 shipped exactly that defect and it was
# found on hosted staging, not here. This harness closes that gap.
#
# It NEVER touches hosted Supabase and uses no service-role key: a throwaway container, migrations applied in order,
# then the *_test.sql suites. Read-only with respect to anything real.
#
# Usage: bash scripts/test-safeupdate.sh [test-file-glob]
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
IMAGE="${SUPABASE_PG_IMAGE:-supabase/postgres:17.6.1.162}"
C="idc_safeupdate_$$"
ONLY="${1:-}"

command -v docker >/dev/null 2>&1 || { echo "ERROR: docker is required"; exit 1; }
cleanup() { docker rm -f "$C" >/dev/null 2>&1 || true; }
trap cleanup EXIT

echo "==> starting $IMAGE with safeupdate preloaded ($C)"
docker run -d --name "$C" -e POSTGRES_PASSWORD=postgres "$IMAGE" \
  postgres -c session_preload_libraries=safeupdate >/dev/null

# The image starts a TEMPORARY server for initdb and then restarts it. Connecting to that temp server and applying 90
# migrations to it means the real server comes up empty — or, as observed, the run dies with "the database system is
# shutting down" partway through. Require several consecutive successes AND a healthy container to step over it.
ok=0
for _ in $(seq 1 180); do
  if [ "$(docker inspect -f '{{.State.Health.Status}}' "$C" 2>/dev/null || echo none)" = "healthy" ] \
     && docker exec "$C" psql -U supabase_admin -d postgres -tAc 'select 1' >/dev/null 2>&1; then
    ok=$((ok + 1)); [ "$ok" -ge 5 ] && break
  else ok=0; fi
  sleep 1
done
[ "$ok" -ge 5 ] || { echo "ERROR: postgres never became stably ready"; docker logs "$C" 2>&1 | tail -10; exit 1; }

q() { docker exec -i "$C" psql -U supabase_admin -d postgres -v ON_ERROR_STOP=1 -q; }

# Prove the guard is actually live before trusting a single result below. A harness that silently lost the extension
# would report a clean run against the very behaviour it exists to test.
echo "==> verifying safeupdate is enforcing"
# ON_ERROR_STOP is load-bearing: without it psql exits 0 even when a statement errored, and this probe would report
# "not enforcing" for a database that is enforcing perfectly well.
if docker exec -i "$C" psql -U supabase_admin -d postgres -v ON_ERROR_STOP=1 -q >/dev/null 2>&1 <<'SQL'
create table _sfu_probe(x int); insert into _sfu_probe values (1); delete from _sfu_probe;
SQL
then echo "ERROR: safeupdate is NOT enforcing — a bare DELETE succeeded. Refusing to report a false pass."; exit 1; fi
docker exec "$C" psql -U supabase_admin -d postgres -q -c 'drop table if exists _sfu_probe' >/dev/null 2>&1 || true
echo "    confirmed: a bare DELETE is rejected"

echo "==> auth shim + roles"
q <<'SQL'
create schema if not exists auth;
create table if not exists auth.users (id uuid primary key, email text);
create or replace function auth.uid() returns uuid language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claim.sub', true), ''),
                  nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')::uuid;
$$;
do $$ begin
  if not exists (select from pg_roles where rolname='anon')             then create role anon nologin; end if;
  if not exists (select from pg_roles where rolname='authenticated')    then create role authenticated nologin; end if;
  if not exists (select from pg_roles where rolname='service_role')     then create role service_role nologin bypassrls; end if;
  if not exists (select from pg_roles where rolname='connector_runner') then create role connector_runner nologin; end if;
  if not exists (select from pg_roles where rolname='oauth_completer')  then create role oauth_completer nologin; end if;
end $$;
grant usage on schema auth, public to anon, authenticated, service_role;
SQL

echo "==> applying migrations"
for m in "$REPO"/supabase/migrations/*.sql; do q < "$m"; done

> "$REPO"/.safeupdate-suites.tmp
if [ -n "$ONLY" ]; then
  ls "$REPO"/supabase/tests/${ONLY}_test.sql >> "$REPO"/.safeupdate-suites.tmp 2>/dev/null || true
else
  # SCOPED ON PURPOSE — two independent reasons, both about the TESTS rather than the product.
  #
  # 1. Several suites assert DENIAL by issuing a WHERE-less UPDATE/DELETE and expecting RLS to refuse it or affect
  #    zero rows (okta_connector_config_test, okta_connector_validation_result_test, org_rls_test, oauth_*). Under
  #    `safeupdate` those statements are rejected earlier with a different error, so the probe never reaches its
  #    assertion.
  # 2. Suites are ORDER-COUPLED: several replace `has_tenant_role` with `select true` for the rest of the session, so
  #    running an arbitrary subset makes a later suite's "unauthorized caller reads nothing" assertion fail for a
  #    reason that has nothing to do with safeupdate.
  #
  # The two suites below are self-contained (each installs its own gate) and are exactly the ones that exercise the
  # persistence function this harness exists to test. `scripts/test-rls.sh` remains the canonical full suite; no
  # runtime migration issues a WHERE-less statement, which is pinned statically by
  # `src/lib/data/governance-finding-sync-equivalence.test.ts`.
  for s in \
    governance_finding_persistence \
    zz_governance_finding_sync_safeupdate; do
    ls "$REPO"/supabase/tests/${s}_test.sql >> "$REPO"/.safeupdate-suites.tmp 2>/dev/null || true
  done
fi

echo "==> running SQL suites ($(wc -l < "$REPO"/.safeupdate-suites.tmp | tr -d ' ') file(s))"
shopt -s nullglob
fail=0
for t in $(cat "$REPO"/.safeupdate-suites.tmp); do
  if q < "$t" >/tmp/sfu.out 2>&1; then
    echo "    PASS  $(basename "$t")"
  else
    echo "    FAIL  $(basename "$t")"; tail -12 /tmp/sfu.out; fail=1
  fi
done
rm -f "$REPO"/.safeupdate-suites.tmp
[ $fail -eq 0 ] && echo "==> safeupdate suite passed" || { echo "==> safeupdate suite FAILED"; exit 1; }
