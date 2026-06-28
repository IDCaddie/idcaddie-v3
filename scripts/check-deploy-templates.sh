#!/usr/bin/env bash
#
# check-deploy-templates.sh — keep the connector-runner deploy package INERT (PR #202). Scoped to
# runner/connector-runner/deploy/ ONLY (the real staging account legitimately appears in other committed docs, so this
# is NOT repo-wide). Fails (exit 1) if any of:
#   * a required placeholder (REPLACE_WITH_ACCOUNT_ID/REGION/SECRET_REF/KMS_KEY_REF/DB_REF) is missing from the templates
#   * a real value appears anywhere in deploy/: a bare 12-digit AWS account, an account-bearing ARN, a KMS key UUID, a
#     Slack token (xoxb-…), an AWS access key (AKIA…), an `sb_secret`/service-role-ish key, or a DB URL with a password
#   * an EXECUTABLE deploy/apply command appears in a NON-prose file (Dockerfile/JSON/env) — aws ecs run-task,
#     terraform apply, cdk deploy, docker push, aws cloudformation deploy/…-stack, aws ecr … (README.md may mention these
#     in prose marked "future, not implemented")
#   * the Dockerfile carries a secret build ARG / baked AWS credential
#
# Usage: bash scripts/check-deploy-templates.sh [selftest]
set -euo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

scan_deploy() {
  local d="$1" rc=0
  if [ ! -d "$d" ]; then echo "no deploy dir at $d"; return 0; fi
  _flag() { if [ -n "$2" ]; then echo "VIOLATION: $1"; printf '%s\n' "$2" | sed 's/^/    /'; rc=1; fi; }

  # 1) required placeholders present (across the templates)
  local all; all="$(cat "$d"/* 2>/dev/null || true)"
  for ph in REPLACE_WITH_ACCOUNT_ID REPLACE_WITH_REGION REPLACE_WITH_SECRET_REF REPLACE_WITH_KMS_KEY_REF REPLACE_WITH_DB_REF; do
    printf '%s' "$all" | grep -q "$ph" || { echo "VIOLATION: required placeholder $ph missing from deploy templates"; rc=1; }
  done

  # 2) no real values anywhere under deploy/ (incl. README)
  _flag "account-bearing ARN with a real 12-digit account" \
    "$(grep -rInE "arn:aws:[a-z0-9-]+:[a-z0-9-]*:[0-9]{12}:" "$d" 2>/dev/null || true)"
  _flag "bare 12-digit AWS account id (use REPLACE_WITH_ACCOUNT_ID)" \
    "$(grep -rInE "(^|[^0-9])[0-9]{12}([^0-9]|$)" "$d" 2>/dev/null || true)"
  _flag "KMS key UUID (use REPLACE_WITH_KMS_KEY_REF / an alias)" \
    "$(grep -rInE "key/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}" "$d" 2>/dev/null || true)"
  _flag "Slack token / AWS access key / service-role secret" \
    "$(grep -rInE "xox[baprs]-|xapp-|A(KIA|SIA)[0-9A-Z]{16}|sb_secret_[A-Za-z0-9]" "$d" 2>/dev/null || true)"
  local dburl_hit; dburl_hit="$(grep -rInE "postgres(ql)?://[^:@/]+:[^@/]{6,}@" "$d" 2>/dev/null || true)"
  _flag "DB URL carrying a password" "$dburl_hit"

  # 3) no EXECUTABLE deploy/apply command in any NON-prose file (.md may describe them as future/not-implemented). The
  # scan is recursive over every non-.md file (NOT an extension allowlist), so a future deploy.yml / Makefile / *.bash is
  # covered too. Verb list covers the common ECS/IaC/k8s deploy tools.
  local cmd_hit; cmd_hit="$(grep -rInE "aws ecs (run-task|start-task|update-service|register-task-definition)|terraform apply|cdk deploy|pulumi up|sam deploy|docker push|aws cloudformation (deploy|create-stack|update-stack)|aws ecr get-login|kubectl apply|helm (install|upgrade)" "$d" --exclude="*.md" 2>/dev/null || true)"
  _flag "executable deploy/apply command in a template (must stay prose-only in README)" "$cmd_hit"

  # 4) Dockerfile: no secret build arg / baked AWS credential
  if [ -f "$d/Dockerfile" ]; then
    _flag "Dockerfile secret build ARG / baked AWS credential" \
      "$(grep -InE "^[[:space:]]*(ARG|ENV)[[:space:]]+[A-Za-z0-9_]*(SECRET|TOKEN|PASSWORD|PASSWD|CREDENTIAL|PRIVATE_KEY)|AWS_SECRET_ACCESS_KEY|AWS_ACCESS_KEY_ID|--build-arg" "$d/Dockerfile" 2>/dev/null || true)"
  fi

  return $rc
}

selftest() {
  # fresh temp dir per case — no cross-case state
  local pass=0 fail=0 T
  local PH='REPLACE_WITH_ACCOUNT_ID REPLACE_WITH_REGION REPLACE_WITH_SECRET_REF REPLACE_WITH_KMS_KEY_REF REPLACE_WITH_DB_REF'
  _seed() { T="$(mktemp -d)"; printf '%s\n' "$PH" > "$T/env.example"; printf 'FROM node:22-slim\nCMD ["node","-e","process.exit(1)"]\n' > "$T/Dockerfile"; }
  _check() { local got=ok; scan_deploy "$T" >/dev/null 2>&1 || got=bad
    if [ "$got" = "$2" ]; then echo "  ok: $1"; pass=$((pass+1)); else echo "  FAIL: $1 (expected $2 got $got)"; fail=$((fail+1)); fi
    rm -rf "$T"; }

  _seed; _check "clean placeholders-only deploy" ok
  _seed; rm -f "$T/env.example"; printf 'REPLACE_WITH_ACCOUNT_ID\n' > "$T/t.json"; _check "missing placeholders" bad
  _seed; printf 'arn:aws:iam::123456789012:role/x\n' >> "$T/t.json"; _check "real account-bearing ARN" bad
  _seed; printf 'CONNECTOR_VAULT_SECRET=xoxb-not-a-real-token-EXAMPLE\n' >> "$T/t.json"; _check "slack token" bad
  _seed; printf 'url=postgres://u:MUSTNOTLEAKpw@db.internal:5432/x\n' >> "$T/t.json"; _check "db url with password" bad
  _seed; printf 'RUN aws ecs run-task --cluster x\n' >> "$T/Dockerfile"; _check "executable deploy command (Dockerfile)" bad
  _seed; printf 'run: aws ecs run-task --cluster idcaddie-staging\n' > "$T/deploy.yml"; _check "deploy command in .yml (not allowlisted ext)" bad
  _seed; printf 'deploy:\n\tsam deploy --guided\n' > "$T/Makefile"; _check "deploy command (new verb) in Makefile" bad
  _seed; printf 'pulumi up --yes\n' > "$T/run.bash"; _check "deploy command in .bash" bad
  _seed; printf 'ARG SLACK_CLIENT_SECRET\n' >> "$T/Dockerfile"; _check "secret build ARG" bad
  _seed; printf 'see aws ecs run-task (future, not implemented)\n' > "$T/README.md"; _check "prose deploy mention in README is allowed" ok

  echo "  selftest: $pass passed, $fail failed"; [ "$fail" -eq 0 ]
}

if [ "${1:-}" = "selftest" ]; then selftest; else
  echo "==> checking connector-runner deploy templates are inert"
  scan_deploy "$REPO/runner/connector-runner/deploy" && echo "==> deploy template checks passed"
fi
