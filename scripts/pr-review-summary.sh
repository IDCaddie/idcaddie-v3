#!/usr/bin/env bash
#
# pr-review-summary.sh — local/CI reviewer helper. Categorizes the diff vs
# origin/main and points the reviewer at the right docs/07 P0 sections.
# No GitHub API, no network. Bash 3.2 compatible. Never fails the build.
#
# Usage: bash scripts/pr-review-summary.sh [base-ref]   # default base-ref: origin/main
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO"

BASE_REF="${1:-origin/main}"
BRANCH="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo '?')"
base="$(git merge-base "$BASE_REF" HEAD 2>/dev/null || true)"

if [ -n "$base" ]; then tracked="$(git diff --name-only "$base" 2>/dev/null || true)"; else tracked=""; fi
untracked="$(git ls-files --others --exclude-standard 2>/dev/null || true)"
changed="$(printf '%s\n%s\n' "$tracked" "$untracked" | grep -v '^$' | sort -u || true)"

has() { printf '%s\n' "$changed" | grep -qE "$1"; }
yn()  { if has "$1"; then echo yes; else echo no; fi; }

echo "===================  PR review summary  ==================="
echo "branch        : $BRANCH"
echo "base-ref      : $BASE_REF"
echo "merge-base    : ${base:-<none — push base or fetch origin>}"
echo "changed files : $(printf '%s\n' "$changed" | grep -vc '^$')"
echo "-----------------------------------------------------------"
echo "migrations changed?      $(yn '^supabase/migrations/')"
echo "RLS tests changed?       $(yn '^supabase/tests/')"
echo "src changed?             $(yn '^src/')"
echo "scripts/workflows?       $(yn '^(scripts/|\.github/)')"
echo "docs changed?            $(yn '^docs/|(^|/)README')"
echo "risk register (04)?      $(yn '^docs/04_RISK_REGISTER\.md$')"
echo "changelog (05)?          $(yn '^docs/05_ENGINEERING_CHANGELOG\.md$')"
echo "-----------------------------------------------------------"
# Baseline risk tier (ENGINEERING_STANDARDS.md §B). The tier RULES live in change-risk-lib.mjs and are unit-tested
# there — this script owns the git plumbing only, so there is one owner of the rules (§O), not a bash re-statement.
# Node is preinstalled on GitHub runners; if it is absent we say so rather than printing a wrong tier.
if command -v node >/dev/null 2>&1; then
  printf '%s\n' "$changed" | node "$REPO/scripts/change-risk-lib.mjs" || true
else
  echo "baselineRiskTier : <node not found — classify manually per ENGINEERING_STANDARDS.md §B>"
fi
echo "  Baseline only, NOT semantic proof: escalate if this diff actually crosses a higher-risk"
echo "  boundary (ENGINEERING_STANDARDS.md §C). It may never justify de-escalation."
echo "-----------------------------------------------------------"
echo "Changed files:"
printf '%s\n' "$changed" | sed 's/^/    /'
echo "-----------------------------------------------------------"

echo "Likely reviewer focus areas (docs/07_P0_REVIEW_CHECKLIST.md):"
focus=0
flag() { echo "  • $1"; focus=1; }
has '^supabase/migrations/' && flag "Migrations · RLS · tenant isolation · append-only/hosted-apply"
has '^supabase/tests/'      && flag "RLS · positive+negative auth tests"
has 'service|service_role'  && flag "Service-role usage (must be approved server/test path)"
has '^src/'                 && flag "Auth/session · frontend filtering ≠ authorization · tenant scoping"
has 'import|export'         && flag "Imports/uploads · exports/reports · destructive ops"
has '^(scripts/|\.github/)' && flag "CI/scripts · does it weaken a check?"
[ "$focus" -eq 0 ] && echo "  • Low-risk diff — confirm docs/changelog still consistent."

echo "-----------------------------------------------------------"
echo "Reminder: run check-docs-updated.sh, check-migration-safety.sh, test-rls.sh."
echo "==========================================================="
