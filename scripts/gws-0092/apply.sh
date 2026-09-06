#!/usr/bin/env bash
#
# GWS-E4a — apply migration 0092 to HOSTED STAGING. One migration, one project, fail closed.
#
# This script APPLIES. Everything before the apply line is a refusal gate, and every gate is checked against the
# database it is about to change rather than against a local file. It applies NOTHING else: it asserts that 0092 is the
# only pending migration and aborts if it is not.
#
# It creates no connector row, advances no lifecycle state, and makes no AWS or Google call. 0092 itself is additive
# DDL + GRANT/REVOKE only.
#
# Usage:
#   export SUPABASE_DB_URL='postgresql://...'   # the operator's own staging credential; never stored, never echoed
#   IDCADDIE_APPLY_0092_CONFIRM='APPLY 0092 GOOGLE WORKSPACE VALIDATION STAGING' bash scripts/gws-0092/apply.sh
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
MIGRATION="supabase/migrations/0092_google_workspace_connector_validation.sql"

# The reviewed artifact, pinned by content. Recomputed from #445's merged blob; a byte that differs is a different
# migration and this script will not apply it.
EXPECT_SHA256="4780cf67598543a053058d90900bc169afff75f35ccdc3dd696c24a550c19eaa"
EXPECT_CONFIRM="APPLY 0092 GOOGLE WORKSPACE VALIDATION STAGING"
STAGING_REF="ycdpzduxugdsffjqyoai"
PRODUCTION_REF="dzbfxulvxchdemcettrx"

die() { echo "REFUSED: $*" >&2; exit 1; }
step() { echo "==> $*"; }

# ── G1. explicit operator confirm ────────────────────────────────────────────────────────────────────────────────────
[ "${IDCADDIE_APPLY_0092_CONFIRM:-}" = "$EXPECT_CONFIRM" ] || die "confirm phrase not set (IDCADDIE_APPLY_0092_CONFIRM)"

# ── G2. the artifact is byte-for-byte the reviewed one ───────────────────────────────────────────────────────────────
step "pinning the migration artifact"
[ -f "$REPO/$MIGRATION" ] || die "$MIGRATION not found"
ACTUAL_SHA256="$(shasum -a 256 "$REPO/$MIGRATION" | cut -d' ' -f1)"
[ "$ACTUAL_SHA256" = "$EXPECT_SHA256" ] || die "0092 sha256 mismatch: expected $EXPECT_SHA256, got $ACTUAL_SHA256"
echo "    sha256 $ACTUAL_SHA256 OK"

# ── G3. the target is STAGING, proven from the link and from the credential ──────────────────────────────────────────
step "pinning the target project"
LINKED="$(python3 -c "import json;print(json.load(open('$REPO/supabase/.temp/linked-project.json'))['ref'])" 2>/dev/null || true)"
[ "$LINKED" = "$STAGING_REF" ] || die "linked project is '${LINKED:-<none>}', expected staging $STAGING_REF"
[ -n "${SUPABASE_DB_URL:-}" ] || die "SUPABASE_DB_URL is not set"
# The credential must name staging and must NOT name production. Compared without ever printing the URL.
case "$SUPABASE_DB_URL" in
  *"$PRODUCTION_REF"*) die "SUPABASE_DB_URL names the PRODUCTION project ref" ;;
  *"$STAGING_REF"*) : ;;
  *) die "SUPABASE_DB_URL does not name the staging project ref" ;;
esac
echo "    linked=$STAGING_REF, credential names staging and not production"

PSQL=(psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -qtA)

# ── G4. the database is in exactly the expected pre-state ────────────────────────────────────────────────────────────
step "checking the hosted chain"
HAS_0086="$("${PSQL[@]}" -c "select count(*) from supabase_migrations.schema_migrations where version = '0086'")"
[ "$HAS_0086" = "1" ] || die "0086 is NOT applied to this database (GWS-E4 precondition)"
HAS_0092="$("${PSQL[@]}" -c "select count(*) from supabase_migrations.schema_migrations where version = '0092'")"
[ "$HAS_0092" = "0" ] || die "0092 is ALREADY applied — nothing to do"
MAX_REMOTE="$("${PSQL[@]}" -c "select coalesce(max(version), '<none>') from supabase_migrations.schema_migrations")"
[ "$MAX_REMOTE" = "0091" ] || die "remote chain head is '$MAX_REMOTE', expected 0091 (out-of-order state)"
echo "    0086 applied, 0092 absent, remote head 0091"

# ── G5. 0092 is the ONLY thing that will be applied ──────────────────────────────────────────────────────────────────
step "confirming 0092 is the only pending migration"
PENDING="$(cd "$REPO" && supabase migration list --linked 2>/dev/null | awk -F'|' '$2 ~ /^[[:space:]]*$/ && $1 ~ /[0-9]{4}/ {gsub(/ /,"",$1); print $1}')"
[ "$PENDING" = "0092" ] || die "pending set is '${PENDING:-<none>}', expected exactly 0092"
echo "    pending = 0092 only"

# ── G6. record the pre-state the verifier will compare against ───────────────────────────────────────────────────────
step "recording pre-apply state"
BASELINE="$REPO/scripts/gws-0092/.preapply-baseline"
{
  echo "connectors_total=$("${PSQL[@]}" -c "select count(*) from public.connectors")"
  echo "connectors_google=$("${PSQL[@]}" -c "select count(*) from public.connectors where provider = 'google_workspace'")"
  echo "connectors_verified=$("${PSQL[@]}" -c "select count(*) from public.connectors where connection_state = 'verified'")"
  echo "audit_total=$("${PSQL[@]}" -c "select count(*) from public.audit_logs")"
  echo "captured_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
} > "$BASELINE"
echo "    baseline written to $BASELINE"
cat "$BASELINE" | sed 's/^/      /'

# ── APPLY ────────────────────────────────────────────────────────────────────────────────────────────────────────────
step "APPLYING 0092 to hosted staging"
cd "$REPO"
supabase migration up --linked

step "confirming the ledger recorded exactly 0092"
NOW_0092="$("${PSQL[@]}" -c "select count(*) from supabase_migrations.schema_migrations where version = '0092'")"
[ "$NOW_0092" = "1" ] || die "0092 is still not recorded after apply"
NEW_HEAD="$("${PSQL[@]}" -c "select max(version) from supabase_migrations.schema_migrations")"
[ "$NEW_HEAD" = "0092" ] || die "chain head is '$NEW_HEAD' after apply, expected 0092"

step "comparing against the pre-apply baseline — a pure DDL apply creates no rows anywhere"
. "$BASELINE"
for pair in "connectors_total:public.connectors" "audit_total:public.audit_logs"; do
  key="${pair%%:*}"; tbl="${pair##*:}"
  now="$("${PSQL[@]}" -c "select count(*) from $tbl")"
  before="$(eval echo \$$key)"
  [ "$now" = "$before" ] || die "$tbl row count changed across the apply: $before -> $now"
  echo "    $tbl unchanged at $now"
done
NOW_GOOGLE="$("${PSQL[@]}" -c "select count(*) from public.connectors where provider = 'google_workspace'")"
[ "$NOW_GOOGLE" = "$connectors_google" ] || die "google_workspace connector count changed: $connectors_google -> $NOW_GOOGLE"
NOW_VERIFIED="$("${PSQL[@]}" -c "select count(*) from public.connectors where connection_state = 'verified'")"
[ "$NOW_VERIFIED" = "$connectors_verified" ] || die "verified connector count changed: $connectors_verified -> $NOW_VERIFIED"
echo "    google_workspace connectors unchanged at $NOW_GOOGLE; verified connectors unchanged at $NOW_VERIFIED"

echo
echo "0092 APPLIED. Now run the post-apply proof — the apply is not complete until it passes:"
echo "  psql \"\$SUPABASE_DB_URL\" -v ON_ERROR_STOP=1 -f scripts/gws-0092/verify.sql"
