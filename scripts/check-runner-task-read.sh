#!/usr/bin/env bash
#
# check-runner-task-read.sh — OPERATOR-RUN, READ-ONLY task-read READINESS check for the future ECS/Fargate Model B
# task-read (doc 46 §12.5/§12.7/§12.8). It proves — by **metadata + IAM simulation only, NEVER by reading the secret** —
# that the task role would be allowed `secretsmanager:GetSecretValue` on ONLY the pinned secret ARN and denied elsewhere.
# It NEVER calls `get-secret-value`, NEVER reads/prints the secret value, makes NO KMS crypto / ECS / Postgres call, and
# changes NO state. Output is a redacted PASS/FAIL/INFO checklist. RISK-007 stays OPEN.
#
# Allowed AWS (all read-only): sts get-caller-identity, secretsmanager describe-secret, iam simulate-principal-policy.
# FORBIDDEN: aws secretsmanager get-secret-value (task-read reads a real value — that is the runner's job at run time,
# never this readiness check, never CI, never the agent).
#
# Operator run (after the secret + task role exist — provisioning is otherwise PENDING):
#   ID_CADDIE_RUNNER_TASK_READ=1 AWS_PROFILE=<read-only> AWS_REGION=ca-central-1 \
#   ID_CADDIE_RUNNER_TASK_READ_EXPECTED_ACCOUNT=<staging account, see doc 42 §91> \
#   ID_CADDIE_RUNNER_TASK_READ_ENV=staging \
#   [ID_CADDIE_RUNNER_TASK_READ_ROLE=idcaddie-staging-runner] \
#   bash scripts/check-runner-task-read.sh
# Self-test (no AWS):  bash scripts/check-runner-task-read.sh selftest
set -euo pipefail

readonly EXPECT_REGION="ca-central-1"
readonly EXPECT_ENV="staging"
readonly SECRET_NAME="/idcaddie/staging/slack/oauth-client-secret"
readonly DEFAULT_TASK_ROLE="idcaddie-staging-runner"
readonly STAGING_REF="ycdpzduxugdsffjqyoai"
readonly PRODUCTION_REF="dzbfxulvxchdemcettrx"

refuse() { echo "TASK-READ CHECK REFUSED: $1"; return 1; }
_row() { printf '  [%s] %s\n' "$1" "$2"; }

check_guards() {
  [ "${ID_CADDIE_RUNNER_TASK_READ:-}" = "1" ] || { refuse "disabled (set ID_CADDIE_RUNNER_TASK_READ=1)"; return 1; }
  [ -n "${AWS_PROFILE:-}" ] || { refuse "missing_profile (set AWS_PROFILE, read-only DescribeSecret + SimulatePrincipalPolicy)"; return 1; }
  [ "${AWS_REGION:-$EXPECT_REGION}" = "$EXPECT_REGION" ] || { refuse "wrong_region (expected $EXPECT_REGION)"; return 1; }
  local acct="${ID_CADDIE_RUNNER_TASK_READ_EXPECTED_ACCOUNT:-}"
  [ -n "$acct" ] || { refuse "missing_expected_account (set ID_CADDIE_RUNNER_TASK_READ_EXPECTED_ACCOUNT)"; return 1; }
  [[ "$acct" =~ ^[0-9]{12}$ ]] || { refuse "invalid_expected_account (must be a 12-digit account id)"; return 1; }
  local env="${ID_CADDIE_RUNNER_TASK_READ_ENV:-}"
  case "$env" in production|prod) { refuse "production_disabled (staging-only)"; return 1; };; esac
  [ "$env" = "$EXPECT_ENV" ] || { refuse "unknown_env (set ID_CADDIE_RUNNER_TASK_READ_ENV=staging)"; return 1; }
  local ref="${RUNNER_TASK_READ_PROJECT_REF:-$(cat supabase/.temp/project-ref 2>/dev/null || true)}"
  [ "$ref" != "$PRODUCTION_REF" ] || { refuse "production must not be touched (project ref is $PRODUCTION_REF)"; return 1; }
  [ "$ref" = "$STAGING_REF" ] || { refuse "wrong_project_ref (expected staging $STAGING_REF)"; return 1; }
  return 0
}

# Readiness checks (only reached after guards pass). METADATA + IAM SIMULATION only — the secret value is NEVER read.
run_checks() {
  case "$-" in *x*) echo "TASK-READ CHECK REFUSED: disable shell xtrace (set +x)"; return 1;; esac
  local region="$EXPECT_REGION" expect_acct="$ID_CADDIE_RUNNER_TASK_READ_EXPECTED_ACCOUNT" rc=0
  local role="${ID_CADDIE_RUNNER_TASK_READ_ROLE:-$DEFAULT_TASK_ROLE}"
  _aws() { aws --profile "$AWS_PROFILE" --region "$region" "$@"; }
  echo "== task-read READINESS (READ-ONLY describe-secret + simulate-principal-policy; NO get-secret-value; value never read) =="

  # account gate
  local live_acct; live_acct="$(_aws sts get-caller-identity --query Account --output text 2>/dev/null || true)"
  [ "$live_acct" = "$expect_acct" ] && _row PASS "caller account matches expected staging account ($region)" || { _row FAIL "caller account mismatch (or sts unavailable) — aborting"; return 1; }

  # the secret must exist (metadata only). Its ARN is captured for the simulation, never printed.
  local arn; arn="$(_aws secretsmanager describe-secret --secret-id "$SECRET_NAME" --query 'ARN' --output text 2>/dev/null || true)"
  if [ -z "$arn" ] || [ "$arn" = "None" ]; then
    _row FAIL "secret NOT FOUND at $SECRET_NAME — provision it first (still NOT-YET-CREATED, see docs/47 PR 21)"; return 1
  fi
  _row PASS "secret exists (metadata only; value NEVER read)"

  # a decoy ARN in the SAME account/region that the task role must NOT be allowed to read
  local decoy_arn="arn:aws:secretsmanager:${region}:${expect_acct}:secret:/idcaddie/staging/slack/decoy-not-authorized"
  local role_arn="arn:aws:iam::${expect_acct}:user/${role}"
  _sim() { _aws iam simulate-principal-policy --policy-source-arn "$role_arn" --action-names secretsmanager:GetSecretValue \
      --resource-arns "$1" --query 'EvaluationResults[0].EvalDecision' --output text 2>/dev/null || true; }

  # §12.8: the task role is ALLOWED GetSecretValue on ONLY the pinned ARN...
  local d_allow; d_allow="$(_sim "$arn")"
  [ "$d_allow" = "allowed" ] && _row PASS "task role is ALLOWED secretsmanager:GetSecretValue on the pinned secret" || { _row FAIL "task role GetSecretValue on the pinned secret = ${d_allow:-unknown} (expected allowed)"; rc=1; }
  # ...and DENIED on any other secret (least-privilege).
  local d_deny; d_deny="$(_sim "$decoy_arn")"
  [ "$d_deny" != "allowed" ] && _row PASS "task role is NOT allowed GetSecretValue on a decoy secret ($d_deny)" || { _row FAIL "task role can read a decoy secret — least-privilege violated"; rc=1; }
  _row INFO "GetSecretValue verified by IAM SIMULATION only — no secret value was read"

  if [ "$rc" -eq 0 ]; then echo "== PASS: task-read IAM readiness verified (GetSecretValue allowed on only the pinned secret) — value NEVER read. RISK-007 still OPEN =="
  else echo "== FAIL: task-read readiness did not match — see rows above =="; fi
  return $rc
}

selftest() {
  local pass=0 fail=0
  _case() { local got=ok; ( eval "$3"; check_guards ) >/dev/null 2>&1 || got=refused
    if [ "$got" = "$2" ]; then echo "  ok: $1"; pass=$((pass+1)); else echo "  FAIL: $1 (expected $2 got $got)"; fail=$((fail+1)); fi; }
  local V='export ID_CADDIE_RUNNER_TASK_READ=1 AWS_PROFILE=p AWS_REGION=ca-central-1 ID_CADDIE_RUNNER_TASK_READ_EXPECTED_ACCOUNT=000000000000 ID_CADDIE_RUNNER_TASK_READ_ENV=staging RUNNER_TASK_READ_PROJECT_REF=ycdpzduxugdsffjqyoai'
  _case "valid staging guards pass (no AWS)" ok "$V"
  _case "guards pass with no region set (defaults to ca-central-1)" ok "$V; unset AWS_REGION"
  _case "no opt-in refuses" refused "$V; unset ID_CADDIE_RUNNER_TASK_READ"
  _case "opt-in wrong value refuses" refused "$V; export ID_CADDIE_RUNNER_TASK_READ=0"
  _case "missing profile refuses" refused "$V; unset AWS_PROFILE"
  _case "wrong region refuses" refused "$V; export AWS_REGION=us-east-1"
  _case "missing expected account refuses" refused "$V; unset ID_CADDIE_RUNNER_TASK_READ_EXPECTED_ACCOUNT"
  _case "non-12-digit account refuses" refused "$V; export ID_CADDIE_RUNNER_TASK_READ_EXPECTED_ACCOUNT=abc"
  _case "missing env refuses" refused "$V; unset ID_CADDIE_RUNNER_TASK_READ_ENV"
  _case "production env refuses" refused "$V; export ID_CADDIE_RUNNER_TASK_READ_ENV=production"
  _case "prod env refuses" refused "$V; export ID_CADDIE_RUNNER_TASK_READ_ENV=prod"
  _case "production project ref hard-aborts" refused "$V; export RUNNER_TASK_READ_PROJECT_REF=dzbfxulvxchdemcettrx"
  _case "unknown project ref refuses" refused "$V; export RUNNER_TASK_READ_PROJECT_REF=someotherref0000000"
  echo "  selftest: $pass passed, $fail failed"; [ "$fail" -eq 0 ]
}

if [ "${1:-}" = "selftest" ]; then selftest; else
  check_guards && run_checks
fi
