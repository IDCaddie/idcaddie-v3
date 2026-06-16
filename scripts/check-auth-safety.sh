#!/usr/bin/env bash
#
# check-auth-safety.sh — static guardrails over src/ for the auth/session layer.
# Fails (exit 1) if any of these appear under src/:
#   * the service-role key env name (SUPABASE_SERVICE_ROLE...)
#   * a `service_role` reference (service-role client / privilege escalation)
#   * a hardcoded Supabase URL or key literal (must come from env, never inlined)
#   * localStorage (auth/tenant/role state must not live in client storage)
#
# Heuristic, not a full taint analysis — it catches the obvious P0s cheaply.
# Bash 3.2 compatible. Usage:
#   bash scripts/check-auth-safety.sh            # scan src/
#   bash scripts/check-auth-safety.sh selftest   # verify the checker itself
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# scan_dir <dir> -> prints violations, returns 1 if any found.
scan_dir() {
  local dir="$1" rc=0 hits
  if [ ! -d "$dir" ]; then echo "no source dir at $dir"; return 0; fi

  _grep() { grep -rInE "$1" "$dir" 2>/dev/null || true; }
  _flag() { # <label> <pattern>
    hits="$(_grep "$2")"
    if [ -n "$hits" ]; then
      echo "VIOLATION: $1"
      printf '%s\n' "$hits" | sed 's/^/    /'
      rc=1
    fi
  }

  _flag "service-role key env referenced under src/"      'SUPABASE_SERVICE_ROLE'
  _flag "service_role referenced under src/"               'service_role'
  _flag "hardcoded Supabase URL literal (use env)"         'https://[a-z0-9-]+\.supabase\.(co|in)'
  _flag "hardcoded JWT/anon key literal (use env)"         'eyJ[A-Za-z0-9_-]{10,}'
  _flag "localStorage used under src/ (no auth/role state in client storage)" 'localStorage'

  return $rc
}

selftest() {
  local tmp pass=0 fail=0
  tmp="$(mktemp -d)"; mkdir -p "$tmp/src"
  trap 'rm -rf "$tmp"' RETURN

  _case() { # <name> <expect: ok|bad>
    local name="$1" expect="$2" got=ok
    scan_dir "$tmp/src" >/dev/null 2>&1 || got=bad
    if [ "$got" = "$expect" ]; then echo "  ok: $name"; pass=$((pass+1));
    else echo "  FAIL: $name (expected $expect, got $got)"; fail=$((fail+1)); fi
    rm -f "$tmp/src"/*.ts
  }

  printf 'const x = process.env.NEXT_PUBLIC_SUPABASE_URL;\n' > "$tmp/src/ok.ts"
  _case "clean env-based usage" ok

  printf 'const k = process.env.SUPABASE_SERVICE_ROLE_KEY;\n' > "$tmp/src/a.ts"
  _case "service-role env" bad

  printf 'createClient(url, key, { auth: { role: "service_role" } });\n' > "$tmp/src/b.ts"
  _case "service_role literal" bad

  printf 'const u = "https://abcdef.supabase.co";\n' > "$tmp/src/c.ts"
  _case "hardcoded supabase url" bad

  printf 'const t = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9abc";\n' > "$tmp/src/d.ts"
  _case "hardcoded jwt key" bad

  printf 'localStorage.setItem("role", "admin");\n' > "$tmp/src/e.ts"
  _case "localStorage usage" bad

  echo "selftest: $pass passed, $fail failed"
  [ "$fail" -eq 0 ]
}

if [ "${1:-}" = "selftest" ]; then
  echo "==> check-auth-safety selftest"
  selftest
else
  echo "==> scanning src/ for auth/session safety"
  if scan_dir "$REPO/src"; then
    echo "==> auth safety checks passed"
  else
    echo "==> auth safety checks FAILED" >&2
    exit 1
  fi
fi
