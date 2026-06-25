#!/usr/bin/env bash
# check-no-real-tokens.sh — fail if a PR's CHANGED files contain a REAL provider secret (RISK-007, docs/44 / 42 §89).
#
# Decides per-MATCH (token-scoped), NOT per-line: a matched token is excused ONLY if the TOKEN ITSELF contains a
# documented sentinel marker (SENTINEL / MUSTNOTLEAK / EXAMPLE / a `LEAK…` fixture body / not-a-real-token). So a real
# token is caught even if its line carries a reassuring comment (`// placeholder`), a JSX tag, or a TS generic
# (`<div`, `Map<string>`) — the earlier whole-line allowlist was fail-OPEN and is removed. There is NO whole-file
# allowlist (only the scanner skips itself), so a real token added to ANY file is caught.
#
# Usage:
#   check-no-real-tokens.sh            scan changed files (vs origin/main + working tree + index + untracked)
#   check-no-real-tokens.sh --all      scan every tracked file (used in CI; robust to a shallow clone)
#   check-no-real-tokens.sh selftest   prove the matcher catches positives + excuses sentinels (run in CI first)
#
# NOTE: this is the SOURCE/repo scan. The DB-row token scan for the B2 real-token dry-run (docs/44 §5) lives with the
# B2 evidence harness — B1 runs no real token, so there is no row to scan here. Portable (bash 3.2: no mapfile; BSD
# grep has no -P → perl PCRE). FAILS LOUD if perl is unavailable (never a silent pass).
set -euo pipefail
cd "$(git rev-parse --show-toplevel 2>/dev/null || echo .)"

command -v perl >/dev/null 2>&1 || { echo "check-no-real-tokens: perl is required for the PCRE scan" >&2; exit 2; }

# HIGH-CONFIDENCE full-token patterns (PCRE). Each requires the *structured body*, not just a label/prefix.
PATTERNS=(
  'xox[baprs]-[0-9]{6,}-[0-9A-Za-z-]{8,}'                          # real Slack token (prefix + numeric workspace + body)
  'xapp-[0-9]-[A-Z0-9]{6,}-[0-9]{6,}-[0-9a-f]{16,}'                # Slack app-level token
  'eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{6,}'   # JWT (three base64url segments)
  'AKIA[0-9A-Z]{16}'                                              # AWS access key id
  'ASIA[0-9A-Z]{16}'                                              # AWS temporary access key id
  '-----BEGIN [A-Z ]*PRIVATE KEY-----'                            # PEM private key block
  'gh[posru]_[0-9A-Za-z]{32,}'                                    # GitHub token
  'github_pat_[0-9A-Za-z_]{40,}'                                  # GitHub fine-grained PAT
  'sk-(proj|svcacct|admin)?-?[A-Za-z0-9_-]{32,}'                  # OpenAI secret key (incl. sk-proj-/sk-svcacct-)
  'postgres(ql)?://[^:@/ ]+:[^@/ ]{6,}@(?![^ ]*example\.)(?!localhost|127\.0\.0\.1)[^/ ]+' # DB URL w/ password to a non-local, non-example host
)
# TOKEN-SCOPED allowance — a matched token is excused ONLY if the token body contains one of these (the AWS docs key
# suffix is `…EXAMPLE`, the audit fixtures use `LEAK…`). Applied to the MATCHED TOKEN, never the source line.
SENTINEL='SENTINEL|MUSTNOTLEAK|EXAMPLE|LEAK|not-a-real-token|REDACTEDREDACTED'

# Read text on stdin; print "LINE:TOKEN" for each REAL (non-sentinel) full-token match.
real_token_matches() {
  local text; text="$(cat)"
  local p
  for p in "${PATTERNS[@]}"; do
    printf '%s' "$text" | P="$p" perl -ne 'while (/($ENV{P})/g) { print "$.:$1\n" }' 2>/dev/null | grep -vE "$SENTINEL" || true
  done
}

list_files() {
  if [[ "${1:-}" == "--all" ]]; then
    git ls-files
  else
    { git diff --name-only "origin/main...HEAD" 2>/dev/null || true; git diff --name-only; git diff --cached --name-only; git ls-files --others --exclude-standard; }
  fi
}

run_selftest() {
  local fail=0 s
  # POSITIVES — real-shaped tokens with no sentinel marker; MUST be caught even on a JSX/comment line.
  local POS=(
    '<div token="xoxb-2468013579-2468013579246-AbCdEfGhIjKlMnOpQrStUvWx" /> // placeholder'
    'const m: Map<string> = x; const t = "ghp_ABCDEFGHIJ0123456789abcdefghij0123456789" // synthetic'
    'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwMTIzNDU2In0.abcDEF123456ZZ'
    'AKIAIOSFODNN7REALKEYZ'
    'sk-proj-ABCDEFGHIJ0123456789abcdefghij0123456789'
    'postgres://runner:supersecret@db.prod.internal:5432/x'
  )
  # NEGATIVES — sentinel/example/local; MUST NOT be caught.
  local NEG=(
    'xoxb-SENTINEL-not-a-real-token-0000'
    'AKIAIOSFODNN7EXAMPLE'
    'gho_LEAKLEAKLEAKLEAKLEAKLEAKLEAKLEAK'
    'postgres://postgres:postgres@localhost:5432/db'
    'postgres://runner:pw@db.example.com:5432/postgres'
    'const x: Map<string> = new Map()'
  )
  for s in "${POS[@]}"; do
    [[ -n "$(printf '%s' "$s" | real_token_matches)" ]] || { echo "selftest FAIL — positive not caught: ${s:0:18}…"; fail=1; }
  done
  for s in "${NEG[@]}"; do
    [[ -z "$(printf '%s' "$s" | real_token_matches)" ]] || { echo "selftest FAIL — negative wrongly caught: ${s:0:18}…"; fail=1; }
  done
  if [[ $fail -ne 0 ]]; then echo "==> check-no-real-tokens selftest FAILED"; exit 1; fi
  echo "==> check-no-real-tokens selftest passed (${#POS[@]} positives caught, ${#NEG[@]} negatives excused)"
}

if [[ "${1:-}" == "selftest" ]]; then run_selftest; exit 0; fi

hits=0
scanned=0
while IFS= read -r f; do
  [[ -z "$f" || ! -f "$f" ]] && continue
  [[ "$f" == "scripts/check-no-real-tokens.sh" ]] && continue # the scanner literally contains the patterns
  scanned=$((scanned + 1))
  real="$(real_token_matches < "$f")"
  if [[ -n "$real" ]]; then
    echo "POSSIBLE REAL SECRET in $f:"
    echo "$real" | sed -E 's/(:.{8}).*/\1…[redacted]/'   # never print the full token
    hits=$((hits + $(printf '%s\n' "$real" | grep -c . )))
  fi
done < <(list_files "${1:-}" | sort -u)

if [[ $hits -gt 0 ]]; then
  echo "==> check-no-real-tokens FAILED: $hits possible real secret(s). No real token may be committed (RISK-007)."
  exit 1
fi
echo "==> check-no-real-tokens passed ($scanned file(s) scanned; no real-token shapes)"
