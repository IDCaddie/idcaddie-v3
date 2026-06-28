#!/usr/bin/env bash
#
# check-runner-infra-preflight.sh — SAFE, READ-ONLY staging infrastructure preflight for the connector runner.
# It DESCRIBES the intended AWS / KMS / IAM / Secrets-Manager shape; it NEVER deploys, NEVER runs an ECS task, NEVER
# calls a KMS crypto op (Decrypt / Encrypt / GenerateDataKey), NEVER reads a Secrets-Manager value (GetSecretValue),
# NEVER connects to Postgres, NEVER changes any IAM / KMS / secret state. It is fail-closed and opt-in only. A PASS proves
# the resource SHAPE + the IAM allow/deny simulation match the design — it does NOT verify cryptography, does NOT read a
# secret, and does NOT close RISK-007 (which stays OPEN; Phase C BLOCKED).
#
# Operator run (live, read-only AWS — the agent and CI never run this):
#   ID_CADDIE_RUNNER_PREFLIGHT=1 AWS_PROFILE=<read-only-profile> AWS_REGION=ca-central-1 \
#   ID_CADDIE_RUNNER_PREFLIGHT_EXPECTED_ACCOUNT=<staging account, see deploy/README.md> \
#   ID_CADDIE_RUNNER_PREFLIGHT_ENV=staging \
#   bash scripts/check-runner-infra-preflight.sh
#
# Self-test (no AWS, CI):  bash scripts/check-runner-infra-preflight.sh selftest
set -euo pipefail

# --- pinned NON-secret staging resource references (the resources under test; doc 42 §91 / doc 46 §12). The 12-digit
#     account is intentionally NOT embedded here — it is passed explicitly and verified against live sts (see guards). ---
readonly EXPECT_REGION="ca-central-1"
readonly EXPECT_ENV="staging"
readonly KMS_ALIAS="alias/idcaddie-staging-connector-vault"
readonly KMS_CANONICAL_KEY="a1b7eaa9-5ed6-4fb9-8a19-f610c6407d5f"   # alias MUST resolve to this key
readonly KMS_SUPERSEDED_KEY="5c6fd833-64a0-41f1-8723-9fdbedf6d5fa"  # alias must NOT resolve to this (superseded)
readonly RUNNER_USER="idcaddie-staging-runner"
readonly WEB_USER="idcaddie-staging-web"
readonly RUNNER_POLICY="kms-runner"
readonly SECRET_NAME="/idcaddie/staging/slack/oauth-client-secret"
readonly STAGING_REF="ycdpzduxugdsffjqyoai"
readonly PRODUCTION_REF="dzbfxulvxchdemcettrx"  # hard-abort if targeted
readonly GONE_EC2="i-00335d464d6f7c299"          # §47 host is GONE — must not resolve to a running instance

refuse() { echo "PREFLIGHT REFUSED: $1"; return 1; }

# Fail-closed guards (steps 1-6). PURE — no AWS call, no state. Returns 0 only for a valid staging preflight request.
check_guards() {
  [ "${ID_CADDIE_RUNNER_PREFLIGHT:-}" = "1" ] || { refuse "preflight_disabled (set ID_CADDIE_RUNNER_PREFLIGHT=1)"; return 1; }
  [ -n "${AWS_PROFILE:-}" ] || { refuse "missing_profile (set AWS_PROFILE)"; return 1; }
  [ -n "${AWS_REGION:-}" ]  || { refuse "missing_region (set AWS_REGION)"; return 1; }
  [ "${AWS_REGION:-}" = "$EXPECT_REGION" ] || { refuse "wrong_region (expected $EXPECT_REGION)"; return 1; }
  local acct="${ID_CADDIE_RUNNER_PREFLIGHT_EXPECTED_ACCOUNT:-}"
  [ -n "$acct" ] || { refuse "missing_expected_account (set ID_CADDIE_RUNNER_PREFLIGHT_EXPECTED_ACCOUNT)"; return 1; }
  [[ "$acct" =~ ^[0-9]{12}$ ]] || { refuse "invalid_expected_account (must be a 12-digit account id)"; return 1; }
  local env="${ID_CADDIE_RUNNER_PREFLIGHT_ENV:-}"
  case "$env" in production|prod) { refuse "production_disabled (this preflight is staging-only)"; return 1; };; esac
  [ "$env" = "$EXPECT_ENV" ] || { refuse "unknown_env (set ID_CADDIE_RUNNER_PREFLIGHT_ENV=staging)"; return 1; }
  # project-ref hard-abort: never run while pointed at the production project
  local ref="${RUNNER_PREFLIGHT_PROJECT_REF:-$(cat supabase/.temp/project-ref 2>/dev/null || true)}"
  [ "$ref" != "$PRODUCTION_REF" ] || { refuse "production must not be touched (project ref is $PRODUCTION_REF)"; return 1; }
  [ "$ref" = "$STAGING_REF" ] || { refuse "wrong_project_ref (expected staging $STAGING_REF)"; return 1; }
  return 0
}

# Read-only live describe/simulate checks (step 7+). ONLY reached after guards pass. Every call is read-only; output is a
# redacted PASS/FAIL/UNKNOWN checklist — never a secret value, key material, password, or raw policy/secret JSON.
run_live_preflight() {
  local profile="$AWS_PROFILE" region="$EXPECT_REGION" expect_acct="$ID_CADDIE_RUNNER_PREFLIGHT_EXPECTED_ACCOUNT"
  local rc=0
  _aws() { aws --profile "$profile" --region "$region" "$@"; }   # every live call is funneled through here (read-only)
  _row() { printf '  [%s] %s\n' "$1" "$2"; }

  echo "== connector-runner staging infra preflight (READ-ONLY DESCRIBE; no crypto, no secret read, no deploy) =="

  # 7) live caller account must match the explicitly-expected staging account
  local live_acct; live_acct="$(_aws sts get-caller-identity --query Account --output text 2>/dev/null || true)"
  if [ "$live_acct" = "$expect_acct" ]; then _row PASS "caller account matches expected staging account, region $region";
  else _row FAIL "caller account does not match expected (or sts unavailable) — aborting live checks"; return 1; fi
  local arn; arn="$(_aws sts get-caller-identity --query Arn --output text 2>/dev/null || true)"
  _row INFO "caller principal: ${arn:-unknown}"

  # 8) KMS alias resolves to the canonical (Enabled) key, NOT the superseded key — describe only, no crypto
  local keyid; keyid="$(_aws kms describe-key --key-id "$KMS_ALIAS" --query 'KeyMetadata.KeyId' --output text 2>/dev/null || true)"
  local keystate; keystate="$(_aws kms describe-key --key-id "$KMS_ALIAS" --query 'KeyMetadata.KeyState' --output text 2>/dev/null || true)"
  if [ "$keyid" = "$KMS_CANONICAL_KEY" ] && [ "$keystate" = "Enabled" ]; then _row PASS "KMS alias resolves to canonical key (state Enabled)";
  elif [ "$keyid" = "$KMS_SUPERSEDED_KEY" ]; then _row FAIL "KMS alias resolves to the SUPERSEDED key — must point at the canonical key"; rc=1;
  else _row FAIL "KMS alias does not resolve to the canonical Enabled key (got id=${keyid:-none} state=${keystate:-none})"; rc=1; fi

  # 9) IAM principals exist (no creation/modification)
  for u in "$RUNNER_USER" "$WEB_USER"; do
    if _aws iam get-user --user-name "$u" --query 'User.Arn' --output text >/dev/null 2>&1; then _row PASS "IAM user exists: $u";
    else _row FAIL "IAM user missing: $u"; rc=1; fi
  done

  # 10) IAM allow/deny SHAPE via read-only simulation (no policy change). runner: GenerateDataKey+Decrypt allowed,
  #     Encrypt not allowed; web: Decrypt explicitly denied. We print only the EvalDecision string.
  local key_arn="arn:aws:kms:${region}:${expect_acct}:key/${KMS_CANONICAL_KEY}"
  _sim() { _aws iam simulate-principal-policy --policy-source-arn "arn:aws:iam::${expect_acct}:user/$1" \
      --action-names "$2" --resource-arns "$key_arn" --query 'EvaluationResults[0].EvalDecision' --output text 2>/dev/null || true; }
  local r_gdk r_dec r_enc w_dec
  r_gdk="$(_sim "$RUNNER_USER" kms:GenerateDataKey)"; r_dec="$(_sim "$RUNNER_USER" kms:Decrypt)"
  r_enc="$(_sim "$RUNNER_USER" kms:Encrypt)";         w_dec="$(_sim "$WEB_USER" kms:Decrypt)"
  [ "$r_gdk" = "allowed" ] && _row PASS "runner kms:GenerateDataKey = allowed" || { _row FAIL "runner kms:GenerateDataKey = ${r_gdk:-unknown}"; rc=1; }
  [ "$r_dec" = "allowed" ] && _row PASS "runner kms:Decrypt = allowed"          || { _row FAIL "runner kms:Decrypt = ${r_dec:-unknown}"; rc=1; }
  [ "$r_enc" != "allowed" ] && _row PASS "runner kms:Encrypt = not allowed ($r_enc)" || { _row FAIL "runner kms:Encrypt unexpectedly allowed"; rc=1; }
  [ "$w_dec" = "explicitDeny" ] && _row PASS "web kms:Decrypt = explicitDeny" || { _row FAIL "web kms:Decrypt = ${w_dec:-unknown} (must be explicitDeny)"; rc=1; }
  _row INFO "runner inline policy of record: $RUNNER_POLICY (read-only; not modified)"

  # 11) Secrets-Manager reference: metadata only (describe-secret). NOT-YET-CREATED is an expected, non-failing state.
  if _aws secretsmanager describe-secret --secret-id "$SECRET_NAME" --query 'Name' --output text >/dev/null 2>&1; then
    _row INFO "secret reference exists (metadata only; value NOT read): $SECRET_NAME";
  else _row INFO "missing_secret_reference (expected — staging secret not provisioned yet): $SECRET_NAME"; fi

  # 12) §47 EC2 host must be GONE (not a usable running instance)
  local ec2state; ec2state="$(_aws ec2 describe-instances --instance-ids "$GONE_EC2" --query 'Reservations[0].Instances[0].State.Name' --output text 2>/dev/null || true)"
  [ -z "$ec2state" ] || [ "$ec2state" = "None" ] && _row PASS "§47 EC2 host is gone" || _row INFO "§47 EC2 instance state: $ec2state"

  echo "== preflight complete: PASS proves SHAPE/IDENTITY only — no crypto verified, no secret read, RISK-007 OPEN =="
  return $rc
}

selftest() {
  local pass=0 fail=0
  _case() { # <name> <expect ok|refused> ; the env is set by the caller in a subshell
    local got=ok; ( eval "$3"; check_guards ) >/dev/null 2>&1 || got=refused
    if [ "$got" = "$2" ]; then echo "  ok: $1"; pass=$((pass+1)); else echo "  FAIL: $1 (expected $2 got $got)"; fail=$((fail+1)); fi
  }
  local VALID='export ID_CADDIE_RUNNER_PREFLIGHT=1 AWS_PROFILE=p AWS_REGION=ca-central-1 ID_CADDIE_RUNNER_PREFLIGHT_EXPECTED_ACCOUNT=000000000000 ID_CADDIE_RUNNER_PREFLIGHT_ENV=staging RUNNER_PREFLIGHT_PROJECT_REF=ycdpzduxugdsffjqyoai'
  _case "valid staging guards pass (no AWS)" ok "$VALID"
  _case "no opt-in refuses" refused "$VALID; unset ID_CADDIE_RUNNER_PREFLIGHT"
  _case "opt-in wrong value refuses" refused "$VALID; export ID_CADDIE_RUNNER_PREFLIGHT=0"
  _case "missing profile refuses" refused "$VALID; unset AWS_PROFILE"
  _case "missing region refuses" refused "$VALID; unset AWS_REGION"
  _case "wrong region refuses" refused "$VALID; export AWS_REGION=us-east-1"
  _case "missing expected account refuses" refused "$VALID; unset ID_CADDIE_RUNNER_PREFLIGHT_EXPECTED_ACCOUNT"
  _case "non-12-digit account refuses" refused "$VALID; export ID_CADDIE_RUNNER_PREFLIGHT_EXPECTED_ACCOUNT=abc"
  _case "missing env refuses" refused "$VALID; unset ID_CADDIE_RUNNER_PREFLIGHT_ENV"
  _case "production env refuses" refused "$VALID; export ID_CADDIE_RUNNER_PREFLIGHT_ENV=production"
  _case "prod env refuses" refused "$VALID; export ID_CADDIE_RUNNER_PREFLIGHT_ENV=prod"
  _case "production project ref hard-aborts" refused "$VALID; export RUNNER_PREFLIGHT_PROJECT_REF=dzbfxulvxchdemcettrx"
  _case "unknown project ref refuses" refused "$VALID; export RUNNER_PREFLIGHT_PROJECT_REF=someotherref0000000"
  echo "  selftest: $pass passed, $fail failed"; [ "$fail" -eq 0 ]
}

if [ "${1:-}" = "selftest" ]; then selftest; else
  check_guards && run_live_preflight
fi
