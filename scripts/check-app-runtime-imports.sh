#!/usr/bin/env bash
#
# check-app-runtime-imports.sh — enforce the app↔runner boundary (doc 46 §11). The conforming connector runner is a
# SEPARATE deployable; the app repo stays pg-free and the request/route surface holds no runner internals or KMS client.
# Fails (exit 1) if any of these appear under src/:
#   * an import of `pg` / `postgres`                          (app stays pg-free — the runner owns pg)
#   * an import of `@aws-sdk/client-secretsmanager`           (Secrets-Manager task-read is the runner's, not the app's)
#   * a src/app (route/request surface) import of a runner-internal vault module
#       (runner-db-client / client-secret-ingest-harness / slack-client-secret-store / runner-ingest-entrypoint)
#       or of `@aws-sdk/client-kms`                            (those stay server-lib / runner-vendored, never request-path)
#   * an import of `@aws-sdk/client-kms` outside the two committed KMS adapters (aws-kms-client.ts / aws-kms-sdk-sender.ts)
#
# Heuristic, bash 3.2 compatible. Usage:
#   bash scripts/check-app-runtime-imports.sh            # scan src/
#   bash scripts/check-app-runtime-imports.sh selftest   # verify the checker itself
set -euo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

scan_dir() {
  local src="$1" app="$1/app" rc=0
  if [ ! -d "$src" ]; then echo "no source dir at $src"; return 0; fi

  _flag() { # <label> <hits>
    if [ -n "$2" ]; then echo "VIOLATION: $1"; printf '%s\n' "$2" | sed 's/^/    /'; rc=1; fi
  }

  # form-agnostic, quote-anchored exact specifier — catches `from "pg"`, `require("pg")`, side-effect `import "pg"`, and
  # dynamic `import("pg")`; does NOT false-positive on path substrings like "@/lib/pg-utils" / "./postgres-helpers".
  _flag "pg / postgres imported under src/ (app stays pg-free; the runner is a separate deployable — doc 46 §11)" \
    "$(grep -rInE --include="*.ts" --include="*.tsx" --exclude="*.test.ts" --exclude="*.test.tsx" "['\"](pg|postgres)['\"]" "$src" 2>/dev/null || true)"

  _flag "@aws-sdk/client-secretsmanager imported under src/ (Secrets-Manager task-read is the runner's, not the app's)" \
    "$(grep -rInE --include="*.ts" --include="*.tsx" --exclude="*.test.ts" --exclude="*.test.tsx" "['\"]@aws-sdk/client-secretsmanager['\"]" "$src" 2>/dev/null || true)"

  # the app runtime must be Secrets-Manager-READ-free: GetSecretValue (SDK/CLI) is confined to the separate runner
  # boundary (doc 46 §12.5). Its API name must not appear in app runtime code at all.
  _flag "Secrets Manager GetSecretValue referenced under src/ (task-read is the runner's — the app must never read secret values)" \
    "$(grep -rInE --include="*.ts" --include="*.tsx" --exclude="*.test.ts" --exclude="*.test.tsx" "GetSecretValue|getSecretValue|get-secret-value" "$src" 2>/dev/null || true)"

  if [ -d "$app" ]; then
    _flag "src/app imports a runner-internal vault module or a KMS client (must stay server-lib / runner-vendored)" \
      "$(grep -rInE --include="*.ts" --include="*.tsx" --exclude="*.test.ts" --exclude="*.test.tsx" "['\"][^'\"]*(runner-db-client|client-secret-ingest-harness|slack-client-secret-store|runner-ingest-entrypoint|@aws-sdk/client-kms)['\"]" "$app" 2>/dev/null || true)"
  fi

  _flag "@aws-sdk/client-kms imported outside the committed KMS adapters (aws-kms-client.ts / aws-kms-sdk-sender.ts)" \
    "$(grep -rIlE --include="*.ts" --include="*.tsx" --exclude="*.test.ts" --exclude="*.test.tsx" "['\"]@aws-sdk/client-kms['\"]" "$src" 2>/dev/null | grep -vE "(aws-kms-client|aws-kms-sdk-sender)\.ts$" || true)"

  # the app runtime must NOT import the separate connector-runner deployable (doc 46 §11)
  _flag "src/ imports the connector-runner deployable (the app runtime must not import the runner — doc 46 §11)" \
    "$(grep -rInE --include="*.ts" --include="*.tsx" --exclude="*.test.ts" --exclude="*.test.tsx" "['\"][^'\"]*connector-runner[^'\"]*['\"]" "$src" 2>/dev/null || true)"

  return $rc
}

# The connector-runner skeleton must import NO secret-access module (pg/AWS/KMS/Secrets-Manager/vault reader) and must
# NOT reach into the app `src/` (it vendors the contract; doc 46 §11.2 / §6 of PR #200).
scan_runner() {
  local runner="$1" rc=0
  if [ ! -d "$runner" ]; then return 0; fi
  _flag2() { if [ -n "$2" ]; then echo "VIOLATION: $1"; printf '%s\n' "$2" | sed 's/^/    /'; rc=1; fi; }
  # form-agnostic + comment-safe: the forbidden token must be a QUOTED import specifier, so this catches static
  # `from "pg"`, `require("pg")`, side-effect `import "pg"`, and dynamic `import("pg")` (mirroring scan_dir's pg rule),
  # while never matching prose that merely mentions pg/aws/etc.
  _flag2 "connector-runner imports a forbidden module (pg/AWS/KMS/Secrets-Manager/vault reader) or reaches into app src/" \
    "$(grep -rInE --include="*.ts" --exclude="*.test.ts" "['\"](pg|postgres)['\"]|['\"][^'\"]*(@aws-sdk|client-secretsmanager|secret-vault|connector-secret-store|runner-db-client|kms-key-provider)[^'\"]*['\"]|['\"]@/[^'\"]*['\"]|['\"][^'\"]*\.\./src/[^'\"]*['\"]" "$runner" 2>/dev/null || true)"
  return $rc
}

selftest() {
  local tmp pass=0 fail=0
  tmp="$(mktemp -d)"; mkdir -p "$tmp/src/app"
  trap 'rm -rf "$tmp"' RETURN
  _case() { # <name> <expect ok|bad>
    local got=ok; scan_dir "$tmp/src" >/dev/null 2>&1 || got=bad
    if [ "$got" = "$2" ]; then echo "  ok: $1"; pass=$((pass+1)); else echo "  FAIL: $1 (expected $2, got $got)"; fail=$((fail+1)); fi
    rm -f "$tmp/src"/*.ts "$tmp/src/app"/*.ts
  }

  printf 'import type { X } from "./local";\n' > "$tmp/src/ok.ts"; _case "clean relative import" ok
  printf 'import { Pool } from "pg";\n' > "$tmp/src/a.ts"; _case "pg static import" bad
  printf 'import "pg";\n' > "$tmp/src/a.ts"; _case "pg side-effect import" bad
  printf 'const p = await import("pg");\n' > "$tmp/src/a.ts"; _case "pg dynamic import" bad
  printf 'const r = require("postgres");\n' > "$tmp/src/a.ts"; _case "postgres require" bad
  printf 'import x from "@/lib/pg-utils";\nimport y from "./postgres-helpers";\n' > "$tmp/src/a.ts"; _case "pg-substring paths are NOT flagged" ok
  printf 'import x from "@aws-sdk/client-secretsmanager";\n' > "$tmp/src/b.ts"; _case "secretsmanager import" bad
  printf 'const r = await client.send(new GetSecretValueCommand({}));\n' > "$tmp/src/b.ts"; _case "GetSecretValue referenced in app src" bad
  printf 'import { RunnerConnection } from "@/lib/server/connector-vault/runner-db-client";\n' > "$tmp/src/app/c.ts"; _case "src/app imports runner internal" bad
  printf 'import x from "@aws-sdk/client-kms";\n' > "$tmp/src/app/d.ts"; _case "src/app imports KMS client" bad
  printf 'import x from "@aws-sdk/client-kms";\n' > "$tmp/src/other.ts"; _case "KMS import outside the adapters" bad
  printf 'import x from "@aws-sdk/client-kms";\n' > "$tmp/src/aws-kms-client.ts"; _case "KMS import in an adapter is allowed" ok
  printf 'import x from "../../runner/connector-runner/src/entrypoint";\n' > "$tmp/src/e.ts"; _case "src/ imports the connector-runner" bad

  # runner-side checks
  mkdir -p "$tmp/runner"
  _rcase() { # <name> <expect ok|bad>
    local got=ok; scan_runner "$tmp/runner" >/dev/null 2>&1 || got=bad
    if [ "$got" = "$2" ]; then echo "  ok: $1"; pass=$((pass+1)); else echo "  FAIL: $1 (expected $2, got $got)"; fail=$((fail+1)); fi
    rm -f "$tmp/runner"/*.ts
  }
  printf 'import type { X } from "./contract";\n' > "$tmp/runner/ok.ts"; _rcase "runner clean vendored import" ok
  printf 'import { Pool } from "pg";\n' > "$tmp/runner/a.ts"; _rcase "runner imports pg (static)" bad
  printf 'import "pg";\n' > "$tmp/runner/a.ts"; _rcase "runner imports pg (side-effect)" bad
  printf 'const p = await import("pg");\n' > "$tmp/runner/a.ts"; _rcase "runner imports pg (dynamic)" bad
  printf 'import x from "@aws-sdk/client-kms";\n' > "$tmp/runner/a.ts"; _rcase "runner imports KMS" bad
  printf 'import "@aws-sdk/client-kms";\n' > "$tmp/runner/a.ts"; _rcase "runner imports KMS (side-effect)" bad
  printf 'import x from "@aws-sdk/client-secretsmanager";\n' > "$tmp/runner/a.ts"; _rcase "runner imports Secrets Manager" bad
  printf 'import "../../src/lib/server/connector-vault/crypto";\n' > "$tmp/runner/a.ts"; _rcase "runner reaches into app src (side-effect)" bad
  printf 'import x from "@/lib/server/connector-vault/crypto";\n' > "$tmp/runner/a.ts"; _rcase "runner reaches into app via @/" bad

  echo "  selftest: $pass passed, $fail failed"; [ "$fail" -eq 0 ]
}

if [ "${1:-}" = "selftest" ]; then selftest; else
  echo "==> checking app↔runner import boundary under src/ + runner/"
  rc=0
  scan_runner "$REPO/runner" || rc=1   # || avoids set -e short-circuit so BOTH scans report
  scan_dir "$REPO/src" || rc=1
  [ "$rc" -eq 0 ] && echo "==> app↔runner import boundary checks passed"
  exit "$rc"
fi
