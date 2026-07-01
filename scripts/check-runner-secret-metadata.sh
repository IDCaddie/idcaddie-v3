#!/usr/bin/env bash
#
# check-runner-secret-metadata.sh — OPERATOR-RUN, READ-ONLY, METADATA-ONLY verification of the staging Slack OAuth
# client-secret reference in AWS Secrets Manager (doc 46 §12.4). It confirms the secret EXISTS with the right name /
# region / account / KMS association via `aws secretsmanager describe-secret` — which returns ONLY metadata, never the
# value. It NEVER calls `get-secret-value`, NEVER reads/prints/logs the secret value, makes NO KMS crypto / IAM / ECS /
# Postgres call, and changes NO state. Output is a redacted PASS/FAIL/INFO checklist. RISK-007 stays OPEN.
#
# Operator run (after provisioning the secret per the docs/47 runbook — value entered in the Console, never on argv):
#   ID_CADDIE_RUNNER_SECRET_METADATA=1 \
#   AWS_PROFILE=<read-only profile with secretsmanager:DescribeSecret> \
#   AWS_REGION=ca-central-1 \
#   ID_CADDIE_RUNNER_SECRET_METADATA_EXPECTED_ACCOUNT=<staging account, see doc 42 §91> \
#   ID_CADDIE_RUNNER_SECRET_METADATA_ENV=staging \
#   [ID_CADDIE_RUNNER_SECRET_METADATA_EXPECTED_KMS=alias/idcaddie-staging-connector-vault] \
#   bash scripts/check-runner-secret-metadata.sh
# Self-test (no AWS):  bash scripts/check-runner-secret-metadata.sh selftest
set -euo pipefail

readonly EXPECT_REGION="ca-central-1"
readonly EXPECT_ENV="staging"
readonly SECRET_NAME="/idcaddie/staging/slack/oauth-client-secret"
readonly STAGING_REF="ycdpzduxugdsffjqyoai"
readonly PRODUCTION_REF="dzbfxulvxchdemcettrx"

refuse() { echo "SECRET-METADATA CHECK REFUSED: $1"; return 1; }
_row() { printf '  [%s] %s\n' "$1" "$2"; }

# Fail-closed guards (pure — no AWS). Returns 0 only for a valid staging request.
check_guards() {
  [ "${ID_CADDIE_RUNNER_SECRET_METADATA:-}" = "1" ] || { refuse "disabled (set ID_CADDIE_RUNNER_SECRET_METADATA=1)"; return 1; }
  [ -n "${AWS_PROFILE:-}" ] || { refuse "missing_profile (set AWS_PROFILE to a read-only profile with secretsmanager:DescribeSecret)"; return 1; }
  [ "${AWS_REGION:-$EXPECT_REGION}" = "$EXPECT_REGION" ] || { refuse "wrong_region (expected $EXPECT_REGION)"; return 1; }
  local acct="${ID_CADDIE_RUNNER_SECRET_METADATA_EXPECTED_ACCOUNT:-}"
  [ -n "$acct" ] || { refuse "missing_expected_account (set ID_CADDIE_RUNNER_SECRET_METADATA_EXPECTED_ACCOUNT)"; return 1; }
  [[ "$acct" =~ ^[0-9]{12}$ ]] || { refuse "invalid_expected_account (must be a 12-digit account id)"; return 1; }
  local env="${ID_CADDIE_RUNNER_SECRET_METADATA_ENV:-}"
  case "$env" in production|prod) { refuse "production_disabled (staging-only)"; return 1; };; esac
  [ "$env" = "$EXPECT_ENV" ] || { refuse "unknown_env (set ID_CADDIE_RUNNER_SECRET_METADATA_ENV=staging)"; return 1; }
  local ref="${RUNNER_SECRET_METADATA_PROJECT_REF:-$(cat supabase/.temp/project-ref 2>/dev/null || true)}"
  [ "$ref" != "$PRODUCTION_REF" ] || { refuse "production must not be touched (project ref is $PRODUCTION_REF)"; return 1; }
  [ "$ref" = "$STAGING_REF" ] || { refuse "wrong_project_ref (expected staging $STAGING_REF)"; return 1; }
  return 0
}

# Metadata-only checks (only reached after guards pass). Every AWS call is read-only describe/identity; the secret VALUE
# is never requested (no get-secret-value) and never printed. Output is a redacted PASS/FAIL/INFO checklist.
run_checks() {
  case "$-" in *x*) echo "SECRET-METADATA CHECK REFUSED: disable shell xtrace (set +x)"; return 1;; esac
  local region="$EXPECT_REGION" expect_acct="$ID_CADDIE_RUNNER_SECRET_METADATA_EXPECTED_ACCOUNT" rc=0
  _aws() { aws --profile "$AWS_PROFILE" --region "$region" "$@"; }
  echo "== Secrets Manager secret METADATA verification (READ-ONLY describe-secret; NO get-secret-value; value never read/printed) =="

  # account gate
  local live_acct; live_acct="$(_aws sts get-caller-identity --query Account --output text 2>/dev/null || true)"
  [ "$live_acct" = "$expect_acct" ] && _row PASS "caller account matches expected staging account ($region)" || { _row FAIL "caller account mismatch (or sts unavailable) — aborting"; return 1; }

  # existence + name (describe-secret returns metadata only, never the value)
  local name; name="$(_aws secretsmanager describe-secret --secret-id "$SECRET_NAME" --query 'Name' --output text 2>/dev/null || true)"
  if [ -z "$name" ]; then
    _row FAIL "secret NOT FOUND at $SECRET_NAME — provision it per the docs/47 runbook (still NOT-YET-CREATED)"; return 1
  fi
  [ "$name" = "$SECRET_NAME" ] && _row PASS "secret exists with the expected name" || { _row FAIL "secret name mismatch"; rc=1; }

  # ARN region/account (the raw ARN — incl. its random suffix — is NEVER printed; only the match result is)
  local arn; arn="$(_aws secretsmanager describe-secret --secret-id "$SECRET_NAME" --query 'ARN' --output text 2>/dev/null || true)"
  case "$arn" in
    arn:aws:secretsmanager:"$region":"$expect_acct":secret:*) _row PASS "secret ARN is in the expected region + account" ;;
    *) _row FAIL "secret ARN region/account does not match expected"; rc=1 ;;
  esac

  # KMS association (metadata only). Empty => the AWS-managed default key. If an expected KMS ref is supplied, it must match.
  local kms; kms="$(_aws secretsmanager describe-secret --secret-id "$SECRET_NAME" --query 'KmsKeyId' --output text 2>/dev/null || true)"
  local want_kms="${ID_CADDIE_RUNNER_SECRET_METADATA_EXPECTED_KMS:-}"
  if [ -n "$want_kms" ]; then
    case "$kms" in *"$want_kms"*) _row PASS "secret encrypted with the expected KMS key" ;; *) _row FAIL "secret KMS key does not match the expected key"; rc=1 ;; esac
  elif [ -z "$kms" ] || [ "$kms" = "None" ]; then _row INFO "secret uses the AWS-managed default key (aws/secretsmanager) — pass an expected KMS ref to assert a customer-managed key"
  else _row INFO "secret has a customer-managed KMS key association (id not printed)"; fi

  # version count + tag KEYS (counts/keys only — never a value)
  local vers; vers="$(_aws secretsmanager describe-secret --secret-id "$SECRET_NAME" --query 'length(VersionIdsToStages)' --output text 2>/dev/null || true)"
  [ -n "$vers" ] && [ "$vers" != "None" ] && _row INFO "secret has $vers version(s)" || true
  local tagkeys; tagkeys="$(_aws secretsmanager describe-secret --secret-id "$SECRET_NAME" --query 'Tags[].Key' --output text 2>/dev/null || true)"
  [ -n "$tagkeys" ] && [ "$tagkeys" != "None" ] && _row INFO "secret tag keys present (values not printed)" || _row INFO "secret has no tags"

  if [ "$rc" -eq 0 ]; then echo "== PASS: secret metadata verified (exists, name, region/account, KMS association) — value NEVER read. RISK-007 still OPEN =="
  else echo "== FAIL: secret metadata did not match — see rows above =="; fi
  return $rc
}

selftest() {
  local pass=0 fail=0
  _case() { local got=ok; ( eval "$3"; check_guards ) >/dev/null 2>&1 || got=refused
    if [ "$got" = "$2" ]; then echo "  ok: $1"; pass=$((pass+1)); else echo "  FAIL: $1 (expected $2 got $got)"; fail=$((fail+1)); fi; }
  local V='export ID_CADDIE_RUNNER_SECRET_METADATA=1 AWS_PROFILE=p AWS_REGION=ca-central-1 ID_CADDIE_RUNNER_SECRET_METADATA_EXPECTED_ACCOUNT=000000000000 ID_CADDIE_RUNNER_SECRET_METADATA_ENV=staging RUNNER_SECRET_METADATA_PROJECT_REF=ycdpzduxugdsffjqyoai'
  _case "valid staging guards pass (no AWS)" ok "$V"
  _case "guards pass with no region set (defaults to ca-central-1)" ok "$V; unset AWS_REGION"
  _case "no opt-in refuses" refused "$V; unset ID_CADDIE_RUNNER_SECRET_METADATA"
  _case "opt-in wrong value refuses" refused "$V; export ID_CADDIE_RUNNER_SECRET_METADATA=0"
  _case "missing profile refuses" refused "$V; unset AWS_PROFILE"
  _case "wrong region refuses" refused "$V; export AWS_REGION=us-east-1"
  _case "missing expected account refuses" refused "$V; unset ID_CADDIE_RUNNER_SECRET_METADATA_EXPECTED_ACCOUNT"
  _case "non-12-digit account refuses" refused "$V; export ID_CADDIE_RUNNER_SECRET_METADATA_EXPECTED_ACCOUNT=abc"
  _case "missing env refuses" refused "$V; unset ID_CADDIE_RUNNER_SECRET_METADATA_ENV"
  _case "production env refuses" refused "$V; export ID_CADDIE_RUNNER_SECRET_METADATA_ENV=production"
  _case "prod env refuses" refused "$V; export ID_CADDIE_RUNNER_SECRET_METADATA_ENV=prod"
  _case "production project ref hard-aborts" refused "$V; export RUNNER_SECRET_METADATA_PROJECT_REF=dzbfxulvxchdemcettrx"
  _case "unknown project ref refuses" refused "$V; export RUNNER_SECRET_METADATA_PROJECT_REF=someotherref0000000"
  echo "  selftest: $pass passed, $fail failed"; [ "$fail" -eq 0 ]
}

if [ "${1:-}" = "selftest" ]; then selftest; else
  check_guards && run_checks
fi
