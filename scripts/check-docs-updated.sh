#!/usr/bin/env bash
#
# check-docs-updated.sh — reviewer aid that makes documentation drift visible.
# Compares the branch against its merge-base with origin/main and flags changes
# that should normally come with a docs update. This is a HEURISTIC, not perfect
# static analysis: it fails loudly on the cases that matter and warns on the rest.
#
# Escape hatch: add a top-level `.docs-not-needed.md` (see .docs-not-needed.template.md)
# justifying why no docs are needed; a valid one downgrades the doc FAILs to a pass.
#
# Bash 3.2 compatible. Usage:
#   bash scripts/check-docs-updated.sh [base-ref]   # default base-ref: origin/main
#
# REQUIRE_BASE=1 (set by CI): if the merge-base with base-ref cannot be computed,
# FAIL loudly instead of silently skipping the drift checks. Locally it stays
# graceful (untracked-only) for developer convenience.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO"

BASE_REF="${1:-origin/main}"
REQUIRE_BASE="${REQUIRE_BASE:-0}"
base="$(git merge-base "$BASE_REF" HEAD 2>/dev/null || true)"

if [ -z "$base" ]; then
  msg="cannot compute merge-base with '${BASE_REF}' (ref missing or no common history)."
  if [ "$REQUIRE_BASE" = "1" ]; then
    echo "FATAL: ${msg}" >&2
    echo "       Refusing to silently skip docs-drift checks. Fetch the base branch first" >&2
    echo "       (e.g. 'git fetch origin <branch>') so the full diff can be computed." >&2
    exit 2
  fi
  echo "check-docs-updated: ${msg}"
  echo "  (local convenience mode — checking untracked files only; set REQUIRE_BASE=1 to enforce.)"
fi

# Changed = committed-on-branch (vs merge-base) UNION still-untracked files, so the
# check is useful both in CI (committed) and locally before committing.
if [ -n "$base" ]; then tracked="$(git diff --name-only "$base" 2>/dev/null || true)"; else tracked=""; fi
untracked="$(git ls-files --others --exclude-standard 2>/dev/null || true)"
changed="$(printf '%s\n%s\n' "$tracked" "$untracked" | grep -v '^$' | sort -u || true)"

if [ -z "$changed" ]; then
  echo "check-docs-updated: no changes detected vs ${BASE_REF} — nothing to check."
  exit 0
fi

has() { printf '%s\n' "$changed" | grep -qE "$1"; }

docs_changed=false;      if has '^docs/|(^|/)README'; then docs_changed=true; fi
changelog_changed=false; if has '^docs/05_ENGINEERING_CHANGELOG\.md$'; then changelog_changed=true; fi
risk_changed=false;      if has '^docs/04_RISK_REGISTER\.md$'; then risk_changed=true; fi
testplan_changed=false;  if has '^supabase/tests/rls_test_plan\.md$'; then testplan_changed=true; fi

# Escape hatch validation
escape=false
if [ -f .docs-not-needed.md ]; then
  missing=""
  for h in "Why docs are not needed" "Reviewer" "Date" "Files considered" "Risk assessment" "Follow-up needed"; do
    grep -qi "$h" .docs-not-needed.md || missing="$missing\n    - $h"
  done
  if [ -z "$missing" ]; then escape=true; echo "note: valid .docs-not-needed.md present — doc requirements waived."
  else echo "WARN: .docs-not-needed.md present but missing headings:$(printf "$missing")"; fi
fi

fail=0; warn=0
FAIL() { echo "FAIL: $1"; fail=1; }
WARN() { echo "WARN: $1"; warn=1; }

if has '^supabase/migrations/' && ! $docs_changed && ! $escape; then
  FAIL "migrations changed but no docs/ or README updated. Update docs/03_DATABASE_AND_MIGRATIONS.md (or add .docs-not-needed.md)."
fi
if has '^supabase/tests/' && ! $testplan_changed && ! $docs_changed && ! $escape; then
  FAIL "supabase/tests changed but supabase/tests/rls_test_plan.md / docs not updated."
fi
if has '^(scripts/|\.github/workflows/)' && ! $docs_changed && ! $escape; then
  FAIL "scripts/ or workflows changed but no docs/README updated."
fi
if has '^src/(app|lib|server|components)/' && ! $docs_changed; then
  WARN "src/ changed without a docs update — check docs/00_PRODUCT_STATUS.md and docs/06_BUILD_SEQUENCE.md."
fi

# Every PR should leave a trail in the engineering changelog (warn, never block).
$changelog_changed || WARN "docs/05_ENGINEERING_CHANGELOG.md not updated — every PR should add an entry."
if has '^supabase/(migrations|tests)/' && ! $risk_changed; then
  WARN "DB/RLS changed but docs/04_RISK_REGISTER.md not touched — confirm no risk opened/closed."
fi

echo "----"
echo "check-docs-updated: ${fail} failure(s), ${warn} warning(s)."
[ "$fail" -eq 0 ] || { echo "Documentation drift detected. Update the docs above or justify with .docs-not-needed.md."; exit 1; }
echo "OK (warnings do not block)."
