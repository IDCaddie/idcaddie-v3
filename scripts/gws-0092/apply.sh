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
# All privileged reads go through the ALREADY-AUTHORIZED Supabase CLI connection to the linked staging project
# (`supabase db query --linked`, which runs via the Management API using the CLI's existing auth). The package requires
# NO database URL, NO database password, and introduces NO new credential or environment variable. No secret is ever
# placed in argv: every statement is passed by file.
#
# Usage:
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

# Every privileged read runs through the CLI's own authenticated connection to the LINKED project. `--workdir` pins
# which link is used: the CLI resolves `--linked` from that directory's supabase/.temp/linked-project.json, which G3
# below writes and then proves. The SQL is passed by FILE, never in argv.
#
# `supabase db query` exits non-zero on any SQL error, which is the ON_ERROR_STOP-equivalent this package relies on.
SQLTMP="$(mktemp -t gws0092sql)"
OUTTMP="$(mktemp -t gws0092out)"
ERRTMP="$(mktemp -t gws0092err)"
trap 'rm -f "$SQLTMP" "$OUTTMP" "$ERRTMP"' EXIT

# Run a one-row, one-column ("v") read and echo the scalar. Fails closed on any CLI or SQL error.
sbq() {
  printf '%s\n' "$1" > "$SQLTMP"
  # `--agent no` PINS THE OUTPUT SHAPE. The CLI auto-detects an AI-agent caller and, when it thinks it has one, wraps
  # results in a safety envelope: {"boundary": ..., "rows": [...], "warning": ...}. A human operator's shell gets a bare
  # array instead. Same CLI, same version, same query, two different JSON shapes decided by who is watching — which is
  # exactly how a parser validated in one environment refused in the other. Pinning the mode makes the shape a property
  # of this script rather than of its caller.
  #
  # STDOUT and STDERR are captured SEPARATELY and only STDOUT is parsed: the CLI writes "Using workdir",
  # "Initialising login role..." and its update nag to stderr, which must never be able to manufacture a success.
  if ! supabase db query --linked --workdir "$REPO" --agent no -o json -f "$SQLTMP" >"$OUTTMP" 2>"$ERRTMP"; then
    sed 's/^/    cli: /' "$ERRTMP" >&2
    die "privileged read failed through the Supabase CLI connection"
  fi
  # STRICT parse of STDOUT ONLY, against the shape the real CLI 2.102.0 emits with `--agent no`, read rather than
  # assumed:  [ { "v": <value> } ]  — a top-level ARRAY of exactly one single-key object. Anything else is a refusal
  # naming what was actually seen. No wrapper fallback, no brace slicing, no grep, no guessing among schemas.
  python3 - "$OUTTMP" <<'PARSE' || die "the Supabase CLI returned an unexpected result shape for a privileged read"
import json, sys

raw = open(sys.argv[1], encoding="utf-8").read()
try:
    doc = json.loads(raw)
except Exception:
    sys.exit("    parse: query output is not valid JSON")
if not isinstance(doc, list):
    sys.exit(f"    parse: expected a JSON array at the top level, got {type(doc).__name__}")
if len(doc) != 1:
    sys.exit(f"    parse: expected exactly 1 row, got {len(doc)}")
row = doc[0]
if not isinstance(row, dict):
    sys.exit(f"    parse: row is {type(row).__name__}, expected an object")
if set(row) != {"v"}:
    sys.exit(f"    parse: row keys are {sorted(row)}, expected exactly ['v']")
value = row["v"]
if value is None:
    sys.exit("    parse: field 'v' is null")
print(value)
PARSE
}

# ── G1. explicit operator confirm ────────────────────────────────────────────────────────────────────────────────────
[ "${IDCADDIE_APPLY_0092_CONFIRM:-}" = "$EXPECT_CONFIRM" ] || die "confirm phrase not set (IDCADDIE_APPLY_0092_CONFIRM)"

# ── G2. the artifact is byte-for-byte the reviewed one ───────────────────────────────────────────────────────────────
step "pinning the migration artifact"
[ -f "$REPO/$MIGRATION" ] || die "$MIGRATION not found"
ACTUAL_SHA256="$(shasum -a 256 "$REPO/$MIGRATION" | cut -d' ' -f1)"
[ "$ACTUAL_SHA256" = "$EXPECT_SHA256" ] || die "0092 sha256 mismatch: expected $EXPECT_SHA256, got $ACTUAL_SHA256"
echo "    sha256 $ACTUAL_SHA256 OK"

# ── G3. the target is STAGING, established by LINKING here and then re-proven ────────────────────────────────────────
#
# The package used to assume the operator had already linked, and refused otherwise. It now performs the link itself, so
# the target is pinned by this script rather than inherited from whatever local state happened to exist. Linking touches
# LOCAL CLI STATE ONLY: it writes supabase/.temp/, runs no migration, changes no connector state, and makes no AWS or
# Google call.
#
# The ref is never taken from an argument or the environment. It is the constant below, self-checked against the
# production ref before use, so this script cannot be pointed at production by any input it is given.
read_linked_ref() {
  python3 -c "import json;print(json.load(open('$REPO/supabase/.temp/linked-project.json'))['ref'])" 2>/dev/null || true
}

step "pinning the target project"
[ "$STAGING_REF" != "$PRODUCTION_REF" ] || die "the staging and production refs are equal — refusing to guess"
case "$STAGING_REF" in "$PRODUCTION_REF") die "the pinned ref IS the production ref" ;; esac

LINKED="$(read_linked_ref)"
if [ "$LINKED" = "$STAGING_REF" ]; then
  echo "    already linked to $STAGING_REF"
else
  [ "$LINKED" = "$PRODUCTION_REF" ] && die "currently linked to the PRODUCTION project — refusing to re-link from here"
  step "linking to staging (local CLI state only; no migration, no connector state, no AWS, no Google)"
  echo "    was: ${LINKED:-<not linked>}  ->  linking: $STAGING_REF"
  # The ref is the pinned constant, never an argument. `supabase link` may prompt for the database password; that is an
  # operator-interactive step and no credential is read, written or echoed by this script.
  supabase link --project-ref "$STAGING_REF" --workdir "$REPO" || die "supabase link failed"
fi

# Re-read from disk AFTER linking and prove the result. Trusting the exit code of `link` would be trusting the thing
# this gate exists to check.
LINKED="$(read_linked_ref)"
[ -n "$LINKED" ] || die "no linked project after linking"
[ "$LINKED" != "$PRODUCTION_REF" ] || die "linked project is the PRODUCTION ref"
[ "$LINKED" = "$STAGING_REF" ] || die "linked project is '$LINKED', expected staging $STAGING_REF"
echo "    linked project verified: $LINKED"

# The link file is proved; now prove the CONNECTION works and is the one that file names. A read that cannot execute is
# a target that cannot be trusted, so this fails closed before any further gate.
PROBE="$(sbq "select 'reachable'::text as v")"
[ "$PROBE" = "reachable" ] || die "the linked staging connection did not answer a trivial read"
echo "    privileged read path verified through the Supabase CLI (no DB URL, no password)"

# ── G4. the database is in exactly the expected pre-state ────────────────────────────────────────────────────────────
step "checking the hosted chain"
HAS_0086="$(sbq "select count(*)::text as v from supabase_migrations.schema_migrations where version = '0086'")"
[ "$HAS_0086" = "1" ] || die "0086 is NOT applied to this database (GWS-E4 precondition)"
HAS_0092="$(sbq "select count(*)::text as v from supabase_migrations.schema_migrations where version = '0092'")"
[ "$HAS_0092" = "0" ] || die "0092 is ALREADY applied — nothing to do"
MAX_REMOTE="$(sbq "select coalesce(max(version), '<none>')::text as v from supabase_migrations.schema_migrations")"
[ "$MAX_REMOTE" = "0091" ] || die "remote chain head is '$MAX_REMOTE', expected 0091 (out-of-order state)"
echo "    0086 applied, 0092 absent, remote head 0091"

# ── G5. 0092 is the ONLY thing that will be applied ──────────────────────────────────────────────────────────────────
step "confirming 0092 is the only pending migration"
# Computed from DATA, never from the CLI's human-rendered table: that table's column padding also varies with agent
# detection, and awk over it returned the right answer in one environment and NOTHING in the other. The pending set is
# the local migration versions absent from the remote ledger — both read directly.
REMOTE_VERSIONS="$(sbq "select coalesce(string_agg(version, ',' order by version), '')::text as v from supabase_migrations.schema_migrations")"
LOCAL_VERSIONS="$(find "$REPO/supabase/migrations" -name '*.sql' -maxdepth 1 | sed 's|.*/||' | grep -oE '^[0-9]{4}' | sort | paste -sd, -)"
PENDING="$(python3 - "$LOCAL_VERSIONS" "$REMOTE_VERSIONS" <<'PENDSET'
import sys
local = [v for v in sys.argv[1].split(",") if v]
remote = {v for v in sys.argv[2].split(",") if v}
print(",".join(v for v in local if v not in remote))
PENDSET
)"
[ "$PENDING" = "0092" ] || die "pending set is '${PENDING:-<none>}', expected exactly 0092"
echo "    pending = 0092 only"

# ── G6. record the pre-state the verifier will compare against ───────────────────────────────────────────────────────
step "recording pre-apply state"
BASELINE="$REPO/scripts/gws-0092/.preapply-baseline"
{
  echo "connectors_total=$(sbq "select count(*)::text as v from public.connectors")"
  echo "connectors_google=$(sbq "select count(*)::text as v from public.connectors where provider = 'google_workspace'")"
  echo "connectors_verified=$(sbq "select count(*)::text as v from public.connectors where connection_state = 'verified'")"
  echo "audit_total=$(sbq "select count(*)::text as v from public.audit_logs")"
  echo "captured_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
} > "$BASELINE"
echo "    baseline written to $BASELINE"
cat "$BASELINE" | sed 's/^/      /'

# ── APPLY ────────────────────────────────────────────────────────────────────────────────────────────────────────────
step "APPLYING 0092 to hosted staging"
supabase migration up --linked --workdir "$REPO"

step "confirming the ledger recorded exactly 0092"
NOW_0092="$(sbq "select count(*)::text as v from supabase_migrations.schema_migrations where version = '0092'")"
[ "$NOW_0092" = "1" ] || die "0092 is still not recorded after apply"
NEW_HEAD="$(sbq "select max(version)::text as v from supabase_migrations.schema_migrations")"
[ "$NEW_HEAD" = "0092" ] || die "chain head is '$NEW_HEAD' after apply, expected 0092"

step "comparing against the pre-apply baseline — a pure DDL apply creates no rows anywhere"
. "$BASELINE"
for pair in "connectors_total:public.connectors" "audit_total:public.audit_logs"; do
  key="${pair%%:*}"; tbl="${pair##*:}"
  now="$(sbq "select count(*)::text as v from $tbl")"
  before="$(eval echo \$$key)"
  [ "$now" = "$before" ] || die "$tbl row count changed across the apply: $before -> $now"
  echo "    $tbl unchanged at $now"
done
NOW_GOOGLE="$(sbq "select count(*)::text as v from public.connectors where provider = 'google_workspace'")"
[ "$NOW_GOOGLE" = "$connectors_google" ] || die "google_workspace connector count changed: $connectors_google -> $NOW_GOOGLE"
NOW_VERIFIED="$(sbq "select count(*)::text as v from public.connectors where connection_state = 'verified'")"
[ "$NOW_VERIFIED" = "$connectors_verified" ] || die "verified connector count changed: $connectors_verified -> $NOW_VERIFIED"
echo "    google_workspace connectors unchanged at $NOW_GOOGLE; verified connectors unchanged at $NOW_VERIFIED"

echo
echo "0092 APPLIED. Now run the post-apply proof — the apply is not complete until it passes:"
echo "  supabase db query --linked --workdir \"$REPO\" -f scripts/gws-0092/verify.sql"
