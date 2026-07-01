#!/usr/bin/env bash
#
# check-runner-task-read.sh — OPERATOR-RUN, READ-ONLY task-read READINESS check for the future ECS/Fargate Model B
# task-read (doc 46 §12.5/§12.7/§12.8). It proves — by **metadata + IAM simulation only, NEVER by reading the secret** —
# that the task role would be allowed `secretsmanager:GetSecretValue` on ONLY the pinned secret ARN and denied elsewhere.
# It NEVER calls `get-secret-value`, NEVER reads/prints the secret value, makes NO KMS crypto / ECS / Postgres call, and
# changes NO state. Output is a redacted PASS/FAIL/INFO checklist. RISK-007 stays OPEN.
#
# It proves four IAM-simulation facts (doc 46 §12.7/§12.8): the task role is ALLOWED GetSecretValue on ONLY the pinned
# secret, DENIED on a decoy staging secret, DENIED on a production-named secret (no production access), and DENIED a
# write action (no broad secretsmanager:*; read-only). Allowed AWS (all read-only): sts get-caller-identity,
# secretsmanager describe-secret, iam simulate-principal-policy. FORBIDDEN: aws secretsmanager get-secret-value
# (task-read reads a real value — that is the runner's job at run time, never this readiness check, never CI/agent).
#
# Operator run (after the secret + task role exist — task-role readiness is otherwise PENDING). The principal defaults to
# the current pinned identity (IAM user idcaddie-staging-runner); pass ID_CADDIE_RUNNER_TASK_READ_ROLE_ARN with the real
# ECS/Fargate task-role ARN (user/ or role/) once it is provisioned:
#   ID_CADDIE_RUNNER_TASK_READ=1 AWS_PROFILE=<read-only> AWS_REGION=ca-central-1 \
#   ID_CADDIE_RUNNER_TASK_READ_EXPECTED_ACCOUNT=<staging account, see doc 42 §91> \
#   ID_CADDIE_RUNNER_TASK_READ_ENV=staging \
#   [ID_CADDIE_RUNNER_TASK_READ_ROLE_ARN=arn:aws:iam::<account>:role/<task-role>] \
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
  local role="$DEFAULT_TASK_ROLE"  # default principal name; the operator overrides with a full ARN (see below)
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

  # The principal under test. Default is the current pinned staging identity (IAM user idcaddie-staging-runner, doc 42
  # §91.3 / doc 46 §12.1); the operator OVERRIDES with the real ECS/Fargate task role via ID_CADDIE_RUNNER_TASK_READ_ROLE_ARN
  # (a full user/ OR role/ ARN) once it is provisioned. The raw ARN is used only in the simulation, never printed.
  local role_arn="${ID_CADDIE_RUNNER_TASK_READ_ROLE_ARN:-arn:aws:iam::${expect_acct}:user/${role}}"
  # decoy secrets (simulation-only resource ARNs; no real production/decoy secret is touched or created)
  local decoy_arn="arn:aws:secretsmanager:${region}:${expect_acct}:secret:/idcaddie/staging/slack/decoy-not-authorized"
  local prod_arn="arn:aws:secretsmanager:${region}:${expect_acct}:secret:/idcaddie/production/slack/oauth-client-secret"
  # _sim <action> <resource-arn> -> the EvalDecision string only. simulate-principal-policy EVALUATES the policy; it does
  # NOT perform the action (no read, no write, no production touch).
  _sim() { _aws iam simulate-principal-policy --policy-source-arn "$role_arn" --action-names "$1" \
      --resource-arns "$2" --query 'EvaluationResults[0].EvalDecision' --output text 2>/dev/null || true; }
  # a deny proof PASSes ONLY on a recognized denial decision; empty/unknown (e.g. a transient simulate API error) FAILs
  # (fail-closed — a failed simulation must never read as a denial).
  _denied() { case "$1" in implicitDeny|explicitDeny) return 0;; *) return 1;; esac; }
  _row INFO "principal under test: $([ -n "${ID_CADDIE_RUNNER_TASK_READ_ROLE_ARN:-}" ] && echo 'operator-supplied task role ARN' || echo "default pinned identity ($role)")"

  # (1) §12.7/§12.8: the task role is ALLOWED GetSecretValue on ONLY the pinned ARN...
  local d_allow; d_allow="$(_sim secretsmanager:GetSecretValue "$arn")"
  [ "$d_allow" = "allowed" ] && _row PASS "task role is ALLOWED secretsmanager:GetSecretValue on the pinned secret" || { _row FAIL "task role GetSecretValue on the pinned secret = ${d_allow:-unknown} (expected allowed)"; rc=1; }
  # (2) ...and DENIED on any other staging secret (least-privilege — not a broad resource grant).
  local d_deny; d_deny="$(_sim secretsmanager:GetSecretValue "$decoy_arn")"
  _denied "$d_deny" && _row PASS "task role is DENIED GetSecretValue on a decoy staging secret ($d_deny)" || { _row FAIL "decoy-secret decision = ${d_deny:-unknown} (expected a deny) — least-privilege not verified"; rc=1; }
  # (3) no production-NAMED secret access (name-scoped; real cross-account production isolation is the AWS account
  #     boundary, not this policy). Simulation only — no production resource is touched or created.
  local d_prod; d_prod="$(_sim secretsmanager:GetSecretValue "$prod_arn")"
  _denied "$d_prod" && _row PASS "task role is DENIED GetSecretValue on a production-NAMED same-account secret ($d_prod; name-scoped, not account isolation)" || { _row FAIL "production-named-secret decision = ${d_prod:-unknown} (expected a deny)"; rc=1; }
  # (4) no broad secretsmanager:* — a WRITE action on the pinned secret must be denied (read-only least-privilege).
  local d_write; d_write="$(_sim secretsmanager:PutSecretValue "$arn")"
  _denied "$d_write" && _row PASS "task role is DENIED a write action (secretsmanager:PutSecretValue) — no broad secretsmanager:* ($d_write)" || { _row FAIL "write-action decision = ${d_write:-unknown} (expected a deny) — broad secretsmanager:* / not read-only"; rc=1; }
  _row INFO "all four checks are IAM SIMULATION only — no secret value was read, no action was performed"

  if [ "$rc" -eq 0 ]; then echo "== PASS: task role IAM readiness verified (GetSecretValue on only the pinned secret; denied on decoy / production-named / write) — value NEVER read. RISK-007 still OPEN =="
  else echo "== FAIL: task role readiness did not match — see rows above =="; fi
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
