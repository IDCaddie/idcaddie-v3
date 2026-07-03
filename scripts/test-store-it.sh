#!/usr/bin/env bash
# Real DB/RLS integration test for the Slack resolver store. Brings up a LOCAL Supabase stack (Docker), applies all
# migrations, and runs the supabase-js/PostgREST + RLS integration test as a tenant-member JWT. LOCAL/CI ONLY — never
# staging/production. The local stack's keys are well-known local-only defaults; they are passed via env to the test
# and never committed. Run: bash scripts/test-store-it.sh   (or: npm run test:store-it)
set -euo pipefail
cd "$(dirname "$0")/.."

echo "==> ensuring local Supabase stack is up (alternate ports, applies supabase/migrations)"
# Bring up ONLY the services this integration test uses — db (postgres), kong (api gateway), rest (PostgREST), meta, and
# auth (gotrue; always on). EXCLUDE the heavy/flaky services the test never touches (analytics/vector/edge-runtime/
# functions/imgproxy/inbucket/realtime/storage/studio) — a full-stack `supabase start` aborting on one of those (with its
# error previously swallowed by `>/dev/null 2>&1 || true`) is what left the db container missing and made
# `supabase status` fail with "No such container". Smaller stack = faster + far more reliable in CI.
SB_EXCLUDE="analytics,vector,edge-runtime,functions,imgproxy,inbucket,realtime,storage,studio"
sb_start() { supabase start -x "$SB_EXCLUDE"; }              # NO output-swallow: a failure now surfaces loudly
sb_diagnose() {                                              # safe, local-only diagnostics (no app secrets)
  echo "::group::store-it startup diagnostics"
  docker ps -a || true
  supabase status || true                                   # errors if the stack is down — that IS the signal
  for c in $(docker ps -a --filter 'name=supabase_db_' --format '{{.Names}}' 2>/dev/null); do
    echo "--- last 40 log lines: $c ---"; docker logs "$c" 2>&1 | tail -40 || true   # discovered, not hardcoded
  done
  echo "::endgroup::"
}

supabase stop --no-backup >/dev/null 2>&1 || true           # clear any partial/leftover local state (fresh CI: a no-op)
if ! sb_start; then
  echo "==> first 'supabase start' failed; stopping + retrying once"
  supabase stop --no-backup >/dev/null 2>&1 || true
  if ! sb_start; then
    echo "::error::supabase start failed twice — the local Supabase stack could not come up"
    sb_diagnose
    exit 1
  fi
fi

# Extract local-only connection values (URL + anon + service-role keys) from the running stack. If the stack is somehow
# not queryable, print diagnostics and fail loudly (the `:?` guards already fail closed on a missing value).
if ! supabase status -o env >/dev/null 2>&1; then sb_diagnose; fi
eval "$(supabase status -o env | sed 's/^/SB_/')"
export SUPABASE_IT_URL="${SB_API_URL:?supabase not running}"
export SUPABASE_IT_ANON_KEY="${SB_ANON_KEY:?}"
export SUPABASE_IT_SERVICE_ROLE_KEY="${SB_SERVICE_ROLE_KEY:?}"

echo "==> running store + run-recorder integration tests against ${SUPABASE_IT_URL}"
npx vitest run src/lib/server/sync/supabase-slack-resolver-store.it.test.ts src/lib/server/sync/manual-sync-run-recorder.it.test.ts
