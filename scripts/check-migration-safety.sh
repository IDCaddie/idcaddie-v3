#!/usr/bin/env bash
#
# check-migration-safety.sh — static checks over supabase/migrations/*.sql:
#   * filenames are NNNN_description.sql
#   * migration numbers are sequential from 0001 with no gaps
#   * no duplicate migration numbers
#   * no unsafe keywords (DROP TABLE / TRUNCATE / DISABLE ROW LEVEL SECURITY)
#     unless the file carries an explicit "-- safety-ack: <reason>" note
#
# Fast, no Docker, no database. Runs locally and in CI (.github/workflows/migration-safety.yml).
# Bash 3.2 compatible (macOS default). Exit non-zero on any violation.
#
# Usage:
#   bash scripts/check-migration-safety.sh            # check supabase/migrations
#   bash scripts/check-migration-safety.sh selftest   # verify the checker itself
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Whole-word (-w) keyword match works on both GNU and BSD grep.
UNSAFE='drop[[:space:]]+table|truncate|disable[[:space:]]+row[[:space:]]+level[[:space:]]+security'
ACK='safety-ack:'

# check_dir <dir>  -> prints violations, returns 1 if any found.
check_dir() {
  local dir="$1" rc=0 f base num
  shopt -s nullglob
  local list=("$dir"/*.sql)
  if [ ${#list[@]} -eq 0 ]; then echo "no migrations found in $dir"; return 0; fi

  local nums=""
  for f in "${list[@]}"; do
    base="$(basename "$f")"
    if [[ ! "$base" =~ ^([0-9]{4})_.+\.sql$ ]]; then
      echo "BAD NAME: $base (expected NNNN_description.sql)"; rc=1; continue
    fi
    nums="$nums${BASH_REMATCH[1]}
"
  done

  # duplicates
  local dups
  dups="$(printf '%s' "$nums" | grep -v '^$' | sort | uniq -d || true)"
  if [ -n "$dups" ]; then
    echo "DUPLICATE migration number(s): $(printf '%s' "$dups" | tr '\n' ' ')"; rc=1
  fi

  # sequential: unique numbers must be 1,2,3,... with no gaps
  local expect=1
  while IFS= read -r num; do
    [ -z "$num" ] && continue
    if [ "$((10#$num))" -ne "$expect" ]; then
      echo "NON-SEQUENTIAL: expected $(printf '%04d' "$expect"), found $num"; rc=1; break
    fi
    expect=$((expect + 1))
  done < <(printf '%s' "$nums" | grep -v '^$' | sort -u)

  # unsafe keywords without an ack note
  for f in "${list[@]}"; do
    if grep -iqwE "$UNSAFE" "$f"; then
      if ! grep -iq "$ACK" "$f"; then
        echo "UNSAFE keyword without '-- $ACK <reason>' in $(basename "$f"):"
        grep -inwE "$UNSAFE" "$f" | sed 's/^/    /'
        rc=1
      fi
    fi
  done

  return $rc
}

selftest() {
  local tmp pass=0 fail=0
  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' RETURN

  _case() { # <name> <expect: ok|bad>
    local name="$1" expect="$2" got=ok
    check_dir "$tmp" >/dev/null 2>&1 || got=bad
    if [ "$got" = "$expect" ]; then echo "  ok: $name"; pass=$((pass+1));
    else echo "  FAIL: $name (expected $expect, got $got)"; fail=$((fail+1)); fi
    rm -f "$tmp"/*.sql
  }

  printf -- '-- ok\n' > "$tmp/0001_a.sql"; printf -- '-- ok\n' > "$tmp/0002_b.sql"
  _case "sequential clean" ok

  printf -- '-- x\n' > "$tmp/0001_a.sql"; printf -- '-- x\n' > "$tmp/0001_b.sql"
  _case "duplicate number" bad

  printf -- '-- x\n' > "$tmp/0001_a.sql"; printf -- '-- x\n' > "$tmp/0003_c.sql"
  _case "gap in sequence" bad

  printf 'drop table foo;\n' > "$tmp/0001_a.sql"
  _case "unsafe keyword, no ack" bad

  printf -- '-- safety-ack: intentional teardown, reviewed\ndrop table foo;\n' > "$tmp/0001_a.sql"
  _case "unsafe keyword with ack" ok

  printf -- '-- x\n' > "$tmp/01_bad.sql"
  _case "bad filename" bad

  echo "selftest: $pass passed, $fail failed"
  [ "$fail" -eq 0 ]
}

if [ "${1:-}" = "selftest" ]; then
  echo "==> check-migration-safety selftest"
  selftest
else
  echo "==> checking supabase/migrations"
  if check_dir "$REPO/supabase/migrations"; then
    echo "==> migration safety checks passed"
  else
    echo "==> migration safety checks FAILED" >&2
    exit 1
  fi
fi
