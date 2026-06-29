#!/usr/bin/env bash
#
# check-runner-keys-revoked.sh — OPERATOR-RUN dead-key verification (doc 42 §91.7(f)). After the operator DELETES the
# temporary IAM access keys used for the runner/web KMS test (in the AWS IAM Console — NOT by this script), this confirms
# both old profiles are DEAD: each must FAIL `sts get-caller-identity`. It is READ-ONLY — it creates/deletes/deactivates
# NO key, makes NO IAM/KMS/Secrets-Manager call, performs NO KMS crypto, and prints NO access key id / secret / ARN /
# account — only a redacted PASS/FAIL checklist + the safe error CLASS. RISK-007 stays OPEN.
#
# Operator run (after deleting both temp keys in the Console):
#   ID_CADDIE_RUNNER_KEYS_REVOKED=1 \
#   AWS_PROFILE=idcaddie-staging-runner \
#   ID_CADDIE_RUNNER_KEYS_REVOKED_WEB_PROFILE=idcaddie-staging-web \
#   AWS_REGION=ca-central-1 ID_CADDIE_RUNNER_KEYS_REVOKED_ENV=staging \
#   bash scripts/check-runner-keys-revoked.sh
# Self-test (no AWS):  bash scripts/check-runner-keys-revoked.sh selftest
set -euo pipefail

readonly EXPECT_REGION="ca-central-1"
readonly EXPECT_ENV="staging"
readonly STAGING_REF="ycdpzduxugdsffjqyoai"
readonly PRODUCTION_REF="dzbfxulvxchdemcettrx"

refuse() { echo "KEY-REVOCATION CHECK REFUSED: $1"; return 1; }
_row() { printf '  [%s] %s\n' "$1" "$2"; }

# Fail-closed guards (pure — no AWS). Returns 0 only for a valid staging request.
check_guards() {
  [ "${ID_CADDIE_RUNNER_KEYS_REVOKED:-}" = "1" ] || { refuse "disabled (set ID_CADDIE_RUNNER_KEYS_REVOKED=1)"; return 1; }
  [ -n "${AWS_PROFILE:-}" ] || { refuse "missing_runner_profile (set AWS_PROFILE to the old idcaddie-staging-runner profile — see docs/47)"; return 1; }
  [ -n "${ID_CADDIE_RUNNER_KEYS_REVOKED_WEB_PROFILE:-}" ] || { refuse "missing_web_profile (set ID_CADDIE_RUNNER_KEYS_REVOKED_WEB_PROFILE to the old idcaddie-staging-web profile — see docs/47)"; return 1; }
  [ -n "${AWS_REGION:-}" ] || { refuse "missing_region (set AWS_REGION)"; return 1; }
  [ "${AWS_REGION:-}" = "$EXPECT_REGION" ] || { refuse "wrong_region (expected $EXPECT_REGION)"; return 1; }
  local env="${ID_CADDIE_RUNNER_KEYS_REVOKED_ENV:-}"
  case "$env" in production|prod) { refuse "production_disabled (staging-only)"; return 1; };; esac
  [ "$env" = "$EXPECT_ENV" ] || { refuse "unknown_env (set ID_CADDIE_RUNNER_KEYS_REVOKED_ENV=staging)"; return 1; }
  local ref="${RUNNER_KEYS_REVOKED_PROJECT_REF:-$(cat supabase/.temp/project-ref 2>/dev/null || true)}"
  [ "$ref" != "$PRODUCTION_REF" ] || { refuse "production must not be touched (project ref is $PRODUCTION_REF)"; return 1; }
  [ "$ref" = "$STAGING_REF" ] || { refuse "wrong_project_ref (expected staging $STAGING_REF)"; return 1; }
  return 0
}

# A profile is DEAD iff `sts get-caller-identity` FAILS with a dead-key error class. The captured sts output (which on an
# unexpected SUCCESS would contain the ARN) is held in a var and NEVER printed — only the matched error CLASS is shown.
verify_dead() { # <label> <profile>
  local label="$1" profile="$2" sts_out="" class="" ec=0
  sts_out="$(aws --profile "$profile" --region "$EXPECT_REGION" sts get-caller-identity --query 'Arn' --output text 2>&1)" || ec=$?
  if [ "$ec" -eq 0 ]; then
    _row FAIL "$label temp access key STILL WORKS — delete it in the IAM Console (it must fail sts)"; return 1
  fi
  # ONLY a deleted/deactivated IAM-user access key produces these on sts get-caller-identity (which needs no permission).
  # AccessDenied = a credential that STILL AUTHENTICATES but is explicitly denied (i.e. LIVE), SignatureDoesNotMatch =
  # clock skew / corrupted local secret on a LIVE key, ExpiredToken = an STS session token (not these long-lived keys) —
  # none mean "revoked", so they fall through to the fail-closed FAIL branch.
  class="$(printf '%s' "$sts_out" | grep -oE 'InvalidClientTokenId|UnrecognizedClientException' | head -1 || true)"
  if [ -n "$class" ]; then _row PASS "$label temp access key is REVOKED / not usable (sts rejected: $class)"; return 0
  else _row FAIL "$label sts failed but not with a revoked-key error class — cannot confirm revoked (fail-closed)"; return 1; fi
}

run_checks() {
  case "$-" in *x*) echo "KEY-REVOCATION CHECK REFUSED: disable shell xtrace (set +x)"; return 1;; esac
  local rc=0
  echo "== dead-key verification (READ-ONLY sts get-caller-identity; no IAM/KMS/secret calls; no key material printed) =="
  verify_dead "old runner (AWS_PROFILE)" "$AWS_PROFILE" || rc=1
  verify_dead "old web ($ID_CADDIE_RUNNER_KEYS_REVOKED_WEB_PROFILE)" "$ID_CADDIE_RUNNER_KEYS_REVOKED_WEB_PROFILE" || rc=1
  if [ "$rc" -eq 0 ]; then echo "== PASS: both temporary keys verified REVOKED / not usable — §91.7(f) verification satisfied. RISK-007 still OPEN =="
  else echo "== FAIL: a temporary key is not confirmed revoked — delete/deactivate it in the IAM Console before proceeding =="; fi
  return $rc
}

selftest() {
  local pass=0 fail=0
  _case() { local got=ok; ( eval "$3"; check_guards ) >/dev/null 2>&1 || got=refused
    if [ "$got" = "$2" ]; then echo "  ok: $1"; pass=$((pass+1)); else echo "  FAIL: $1 (expected $2 got $got)"; fail=$((fail+1)); fi; }
  local V='export ID_CADDIE_RUNNER_KEYS_REVOKED=1 AWS_PROFILE=runnerp ID_CADDIE_RUNNER_KEYS_REVOKED_WEB_PROFILE=webp AWS_REGION=ca-central-1 ID_CADDIE_RUNNER_KEYS_REVOKED_ENV=staging RUNNER_KEYS_REVOKED_PROJECT_REF=ycdpzduxugdsffjqyoai'
  _case "valid staging guards pass (no AWS)" ok "$V"
  _case "no opt-in refuses" refused "$V; unset ID_CADDIE_RUNNER_KEYS_REVOKED"
  _case "opt-in wrong value refuses" refused "$V; export ID_CADDIE_RUNNER_KEYS_REVOKED=0"
  _case "missing runner profile refuses" refused "$V; unset AWS_PROFILE"
  _case "missing web profile refuses" refused "$V; unset ID_CADDIE_RUNNER_KEYS_REVOKED_WEB_PROFILE"
  _case "missing region refuses" refused "$V; unset AWS_REGION"
  _case "wrong region refuses" refused "$V; export AWS_REGION=us-east-1"
  _case "missing env refuses" refused "$V; unset ID_CADDIE_RUNNER_KEYS_REVOKED_ENV"
  _case "production env refuses" refused "$V; export ID_CADDIE_RUNNER_KEYS_REVOKED_ENV=production"
  _case "prod env refuses" refused "$V; export ID_CADDIE_RUNNER_KEYS_REVOKED_ENV=prod"
  _case "production project ref hard-aborts" refused "$V; export RUNNER_KEYS_REVOKED_PROJECT_REF=dzbfxulvxchdemcettrx"
  _case "unknown project ref refuses" refused "$V; export RUNNER_KEYS_REVOKED_PROJECT_REF=someotherref0000000"
  echo "  selftest: $pass passed, $fail failed"; [ "$fail" -eq 0 ]
}

if [ "${1:-}" = "selftest" ]; then selftest; else
  check_guards && run_checks
fi
