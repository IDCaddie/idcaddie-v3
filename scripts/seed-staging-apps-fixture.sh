#!/usr/bin/env bash
#
# seed-staging-apps-fixture.sh — guarded, HUMAN-RUN apply of the staging-only Apps/People
# verification fixture (supabase/fixtures/staging_apps_people_verification.sql).
#
# This script does NOT run automatically — it requires the linked project ref to be exactly the
# STAGING project AND an explicit confirmation phrase. It is NOT production-safe and must never be
# treated as such. It uses NO service-role key and reads NO secret from the repo: by default it
# only PRINTS the fixture + instructions for a human to paste into the staging Supabase SQL editor.
# It optionally applies via `psql` if (and only if) the human exports a STAGING_DB_URL that itself
# points at the staging ref. An agent must never run this.
#
# Usage:
#   bash scripts/seed-staging-apps-fixture.sh "SEED STAGING APPS FIXTURE"
#       → fails closed unless supabase/.temp/project-ref == ycdpzduxugdsffjqyoai;
#         prints the linked ref; prints the fixture + SQL-editor instructions (no DB connection).
#   STAGING_DB_URL='postgres://…ycdpzduxugdsffjqyoai…' \
#     bash scripts/seed-staging-apps-fixture.sh "SEED STAGING APPS FIXTURE"
#       → additionally applies the fixture via psql, ONLY after re-verifying the URL is staging.
#
set -euo pipefail

STAGING_REF="ycdpzduxugdsffjqyoai"
PROD_REF="dzbfxulvxchdemcettrx"
CONFIRM_PHRASE="SEED STAGING APPS FIXTURE"

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# Overridable ONLY so the local guard test can point at a temp ref file — never to widen targets.
PROJECT_REF_FILE="${PROJECT_REF_FILE:-$REPO/supabase/.temp/project-ref}"
FIXTURE="$REPO/supabase/fixtures/staging_apps_people_verification.sql"

# --- 1) Linked ref: print it, then fail closed unless it is exactly staging. ---
if [[ ! -f "$PROJECT_REF_FILE" ]]; then
  echo "FAIL-CLOSED: no linked project ref at $PROJECT_REF_FILE — refusing." >&2
  exit 2
fi
REF="$(tr -d '[:space:]' < "$PROJECT_REF_FILE")"
echo "Linked Supabase project ref: $REF"

if [[ "$REF" == "$PROD_REF" ]]; then
  echo "REFUSED: linked ref is the PRODUCTION project ($PROD_REF). This script never touches production." >&2
  exit 3
fi
if [[ "$REF" != "$STAGING_REF" ]]; then
  echo "FAIL-CLOSED: linked ref ($REF) is not the staging project ($STAGING_REF) — refusing." >&2
  exit 2
fi

# --- 2) Explicit confirmation phrase (no accidental / scripted runs). ---
if [[ "${1:-}" != "$CONFIRM_PHRASE" ]]; then
  echo "Confirmation required. Re-run with the exact phrase:" >&2
  echo "  bash scripts/seed-staging-apps-fixture.sh \"$CONFIRM_PHRASE\"" >&2
  exit 4
fi

if [[ ! -f "$FIXTURE" ]]; then
  echo "FAIL-CLOSED: fixture file not found at $FIXTURE — refusing." >&2
  exit 2
fi

echo "Confirmed. Target = staging ($STAGING_REF). Fixture = $FIXTURE"

# --- 3) Apply. Default = print-only (no connection, no secret). Optional psql if STAGING_DB_URL is staging. ---
if [[ -n "${STAGING_DB_URL:-}" ]]; then
  if [[ "$STAGING_DB_URL" == *"$PROD_REF"* ]]; then
    echo "REFUSED: STAGING_DB_URL points at the production ref ($PROD_REF) — refusing." >&2
    exit 3
  fi
  if [[ "$STAGING_DB_URL" != *"$STAGING_REF"* ]]; then
    echo "FAIL-CLOSED: STAGING_DB_URL does not reference the staging ref ($STAGING_REF) — refusing." >&2
    exit 2
  fi
  if ! command -v psql >/dev/null 2>&1; then
    echo "FAIL-CLOSED: psql not found; cannot apply. Paste the fixture into the staging SQL editor instead." >&2
    exit 2
  fi
  echo "Applying fixture via psql to the staging database (URL verified to reference $STAGING_REF)…"
  psql "$STAGING_DB_URL" -v ON_ERROR_STOP=1 -f "$FIXTURE"
  echo "Done. Now verify per docs/41 §21 (/apps, /apps/[id], /people)."
else
  cat <<EOF

No STAGING_DB_URL set — printing instructions (no database connection made).

To apply, paste the contents of this file into the STAGING Supabase SQL editor
(project $STAGING_REF) and run it:

  $FIXTURE

The fixture is idempotent (\`on conflict do nothing\`). After applying, verify per
docs/41 §21:  /apps  →  /apps/[id]  →  /people  (signed in as the Tenant A editor).

This printed nothing secret and connected to nothing. Fixture data is SYNTHETIC — not
customer data. Applying + verifying it does NOT close RISK-001 and does NOT approve cutover.
EOF
fi
