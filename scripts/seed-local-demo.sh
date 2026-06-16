#!/usr/bin/env bash
#
# seed-local-demo.sh — load the local/demo fixture into a THROWAWAY local Postgres.
#
# Hosted-proof by construction: like test-rls.sh, it spins up its OWN local
# postgres:16 Docker container, installs the Supabase-style auth shim, applies
# supabase/migrations/*.sql, then applies supabase/fixtures/local_demo.sql.
# It NEVER connects to a remote/hosted database, never calls the supabase CLI,
# never `supabase db push`/`--linked`, never reads a project ref, and reads no
# secrets. There is simply no code path to a hosted target.
#
# The fixture is applied TWICE to prove it is idempotent (safe to rerun).
#
# Usage:
#   bash scripts/seed-local-demo.sh          # seed + verify, then tear down
#   bash scripts/seed-local-demo.sh --keep   # leave the DB up on localhost:55432 for poking
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
IMAGE="${POSTGRES_IMAGE:-postgres:16-alpine}"
PORT=55432
KEEP=0

for arg in "$@"; do
  case "$arg" in
    --keep) KEEP=1 ;;
    # Refuse anything that looks like an attempt to point this at a real database.
    --linked|*://*|*supabase.co*|*supabase.in*|*.supabase.*)
      echo "REFUSED: this script is local-only and cannot target a hosted/remote database." >&2
      echo "         It always uses its own throwaway Docker container." >&2
      exit 2 ;;
    *) echo "unknown arg: $arg (use --keep)"; exit 2 ;;
  esac
done

command -v docker >/dev/null 2>&1 || { echo "ERROR: docker is required but not found"; exit 1; }

C="idc_seed_demo_$$"
[ "$KEEP" -eq 1 ] && C="idc_seed_demo_keep"

cleanup() { [ "$KEEP" -eq 1 ] || docker rm -f "$C" >/dev/null 2>&1 || true; }
trap cleanup EXIT

# Fresh container (remove any prior --keep one so reruns start clean).
docker rm -f "$C" >/dev/null 2>&1 || true

echo "==> starting $IMAGE ($C)"
if [ "$KEEP" -eq 1 ]; then
  docker run -d --name "$C" -e POSTGRES_PASSWORD=postgres -p "127.0.0.1:${PORT}:5432" "$IMAGE" >/dev/null
else
  docker run -d --name "$C" -e POSTGRES_PASSWORD=postgres "$IMAGE" >/dev/null
fi

ok=0
for _ in $(seq 1 60); do
  if docker exec "$C" psql -U postgres -tAc 'select 1' >/dev/null 2>&1; then
    ok=$((ok + 1)); [ "$ok" -ge 3 ] && break
  else ok=0; fi
  sleep 1
done
[ "$ok" -ge 3 ] || { echo "ERROR: postgres did not become ready"; exit 1; }

psql_q() { docker exec -i "$C" psql -U postgres -d postgres -v ON_ERROR_STOP=1 -q; }

echo "==> installing Supabase-style auth shim + roles"
psql_q <<'SQL'
create schema if not exists auth;
create table if not exists auth.users (id uuid primary key, email text);
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

shopt -s nullglob
for m in "$REPO"/supabase/migrations/*.sql; do
  echo "==> migration $(basename "$m")"
  psql_q < "$m"
done

FIXTURE="$REPO/supabase/fixtures/local_demo.sql"
[ -f "$FIXTURE" ] || { echo "ERROR: missing $FIXTURE"; exit 1; }

echo "==> applying fixture (pass 1)"
psql_q < "$FIXTURE"
echo "==> applying fixture (pass 2 — proves idempotency)"
psql_q < "$FIXTURE"

echo "==> demo data summary"
docker exec -i "$C" psql -U postgres -d postgres -v ON_ERROR_STOP=1 -At <<'SQL'
select 'tenants               : '||count(*) from public.tenants;
select 'organizations         : '||count(*) from public.organizations;
select 'tenant_memberships    : '||count(*) from public.tenant_memberships;
select 'organization_members  : '||count(*) from public.organization_memberships;
select 'apps                  : '||count(*) from public.apps;
select 'contracts             : '||count(*) from public.contracts;
select 'app_contracts         : '||count(*) from public.app_contracts;
SQL

echo "==> local demo fixture loaded"
if [ "$KEEP" -eq 1 ]; then
  echo "    DB kept up: psql 'postgresql://postgres:postgres@127.0.0.1:${PORT}/postgres'"
  echo "    Stop it with: docker rm -f ${C}"
fi
