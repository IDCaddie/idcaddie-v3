#!/usr/bin/env bash
# Real DB/RLS integration test for the Slack resolver store. Brings up a LOCAL Supabase stack (Docker), applies all
# migrations, and runs the supabase-js/PostgREST + RLS integration test as a tenant-member JWT. LOCAL/CI ONLY — never
# staging/production. The local stack's keys are well-known local-only defaults; they are passed via env to the test
# and never committed. Run: bash scripts/test-store-it.sh   (or: npm run test:store-it)
set -euo pipefail
cd "$(dirname "$0")/.."

echo "==> ensuring local Supabase stack is up (alternate ports, applies supabase/migrations)"
supabase start >/dev/null 2>&1 || true

# Extract local-only connection values (URL + anon + service-role keys) from the running stack.
eval "$(supabase status -o env | sed 's/^/SB_/')"
export SUPABASE_IT_URL="${SB_API_URL:?supabase not running}"
export SUPABASE_IT_ANON_KEY="${SB_ANON_KEY:?}"
export SUPABASE_IT_SERVICE_ROLE_KEY="${SB_SERVICE_ROLE_KEY:?}"

echo "==> running store + run-recorder integration tests against ${SUPABASE_IT_URL}"
npx vitest run src/lib/server/sync/supabase-slack-resolver-store.it.test.ts src/lib/server/sync/manual-sync-run-recorder.it.test.ts
