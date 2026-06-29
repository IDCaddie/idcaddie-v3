#!/usr/bin/env bash
#
# check-runner-kms-roundtrip.sh — OPERATOR-RUN-ONLY live staging KMS round-trip + AccessDenied negative (doc 42 §91.7).
# It proves the LIVE staging KMS decrypt boundary with SYNTHETIC material only: the runner identity can GenerateDataKey +
# Decrypt on the canonical KEK, and the web identity CANNOT Decrypt. It uses NO real Slack token / client secret / OAuth /
# DB password / service-role key, reads NO Secrets-Manager value, makes NO ECS/deploy call, connects to NO Postgres, and
# changes NO IAM/KMS state (no Encrypt — policy forbids it). The agent and CI NEVER run the live path (CI runs only the
# guard self-test). A green run proves the live decrypt boundary only — it stores no real secret and **RISK-007 stays
# OPEN; Phase C BLOCKED.**
#
# Operator run (live KMS, synthetic only — the agent and CI never run this):
#   ID_CADDIE_RUNNER_KMS_ROUNDTRIP=1 \
#   AWS_PROFILE=<runner staging profile: idcaddie-staging-runner> \
#   ID_CADDIE_RUNNER_KMS_ROUNDTRIP_WEB_PROFILE=<web staging profile: idcaddie-staging-web> \
#   AWS_REGION=ca-central-1 \
#   ID_CADDIE_RUNNER_KMS_ROUNDTRIP_EXPECTED_ACCOUNT=<staging account, see doc 42 §91> \
#   ID_CADDIE_RUNNER_KMS_ROUNDTRIP_ENV=staging \
#   bash scripts/check-runner-kms-roundtrip.sh
#
# Self-test (no AWS, no crypto, CI):  bash scripts/check-runner-kms-roundtrip.sh selftest
set -euo pipefail
umask 077  # any transient material is owner-only

readonly EXPECT_REGION="ca-central-1"
readonly EXPECT_ENV="staging"
readonly KMS_ALIAS="alias/idcaddie-staging-connector-vault"
readonly KMS_CANONICAL_KEY="a1b7eaa9-5ed6-4fb9-8a19-f610c6407d5f"
readonly KMS_SUPERSEDED_KEY="5c6fd833-64a0-41f1-8723-9fdbedf6d5fa"
readonly STAGING_REF="ycdpzduxugdsffjqyoai"
readonly PRODUCTION_REF="dzbfxulvxchdemcettrx"

refuse() { echo "KMS ROUND-TRIP REFUSED: $1"; return 1; }
_row() { printf '  [%s] %s\n' "$1" "$2"; }

# Fail-closed guards (pure — no AWS, no crypto). Returns 0 only for a valid staging round-trip request.
check_guards() {
  [ "${ID_CADDIE_RUNNER_KMS_ROUNDTRIP:-}" = "1" ] || { refuse "roundtrip_disabled (set ID_CADDIE_RUNNER_KMS_ROUNDTRIP=1)"; return 1; }
  [ -n "${AWS_PROFILE:-}" ] || { refuse "missing_runner_profile (set AWS_PROFILE to the idcaddie-staging-runner profile — see docs/47 'Operator AWS profile setup')"; return 1; }
  [ -n "${ID_CADDIE_RUNNER_KMS_ROUNDTRIP_WEB_PROFILE:-}" ] || { refuse "missing_web_profile (the web AccessDenied negative is required evidence; set ID_CADDIE_RUNNER_KMS_ROUNDTRIP_WEB_PROFILE to the idcaddie-staging-web profile — see docs/47 'Operator AWS profile setup')"; return 1; }
  [ -n "${AWS_REGION:-}" ] || { refuse "missing_region (set AWS_REGION)"; return 1; }
  [ "${AWS_REGION:-}" = "$EXPECT_REGION" ] || { refuse "wrong_region (expected $EXPECT_REGION)"; return 1; }
  local acct="${ID_CADDIE_RUNNER_KMS_ROUNDTRIP_EXPECTED_ACCOUNT:-}"
  [ -n "$acct" ] || { refuse "missing_expected_account (set ID_CADDIE_RUNNER_KMS_ROUNDTRIP_EXPECTED_ACCOUNT)"; return 1; }
  [[ "$acct" =~ ^[0-9]{12}$ ]] || { refuse "invalid_expected_account (must be a 12-digit account id)"; return 1; }
  local env="${ID_CADDIE_RUNNER_KMS_ROUNDTRIP_ENV:-}"
  case "$env" in production|prod) { refuse "production_disabled (staging-only)"; return 1; };; esac
  [ "$env" = "$EXPECT_ENV" ] || { refuse "unknown_env (set ID_CADDIE_RUNNER_KMS_ROUNDTRIP_ENV=staging)"; return 1; }
  local ref="${RUNNER_KMS_ROUNDTRIP_PROJECT_REF:-$(cat supabase/.temp/project-ref 2>/dev/null || true)}"
  [ "$ref" != "$PRODUCTION_REF" ] || { refuse "production must not be touched (project ref is $PRODUCTION_REF)"; return 1; }
  [ "$ref" = "$STAGING_REF" ] || { refuse "wrong_project_ref (expected staging $STAGING_REF)"; return 1; }
  return 0
}

# Live round-trip (only reached after guards pass). SYNTHETIC data key only; key material lives in shell vars and is
# NEVER printed — the output is a redacted PASS/FAIL checklist + safe error classes only.
run_roundtrip() {
  local profile="$AWS_PROFILE" web="$ID_CADDIE_RUNNER_KMS_ROUNDTRIP_WEB_PROFILE" region="$EXPECT_REGION"
  local expect_acct="$ID_CADDIE_RUNNER_KMS_ROUNDTRIP_EXPECTED_ACCOUNT" rc=0
  _runner() { aws --profile "$profile" --region "$region" "$@"; }   # runner identity (positive path)
  _web()    { aws --profile "$web" --region "$region" "$@"; }        # web identity (negative path — must be denied)
  # defense-in-depth: refuse under shell xtrace (`bash -x`) — it would echo every key-material expansion
  case "$-" in *x*) echo "KMS ROUND-TRIP REFUSED: disable shell xtrace (set +x) — it would print key material"; return 1;; esac
  echo "== runner KMS round-trip (LIVE, SYNTHETIC data key only; no real secret, no Encrypt, no Secrets-Manager) =="

  # account gate
  local live_acct; live_acct="$(_runner sts get-caller-identity --query Account --output text 2>/dev/null || true)"
  [ "$live_acct" = "$expect_acct" ] && _row PASS "runner caller account matches expected staging account" || { _row FAIL "runner caller account mismatch (or sts unavailable) — aborting"; return 1; }

  # runner GenerateDataKey (synthetic, AES_256). The runner identity is allowed GenerateDataKey/Decrypt but NOT
  # DescribeKey (least-privilege, doc 42 §91.4), so the canonical-KEK check uses the GenerateDataKey response's KeyId
  # (no separate describe-key). Capture KeyId + plaintext DEK + wrapped DEK to vars; key material is NEVER printed.
  local gdk keyid pt_b64 ct_b64
  gdk="$(_runner kms generate-data-key --key-id "$KMS_ALIAS" --key-spec AES_256 --query '[KeyId,Plaintext,CiphertextBlob]' --output text 2>/dev/null || true)"
  keyid="$(printf '%s' "$gdk" | cut -f1)"; pt_b64="$(printf '%s' "$gdk" | cut -f2)"; ct_b64="$(printf '%s' "$gdk" | cut -f3)"
  [ -n "$pt_b64" ] && [ -n "$ct_b64" ] && _row PASS "runner kms:GenerateDataKey succeeded (synthetic data key)" || { _row FAIL "runner kms:GenerateDataKey failed (runner identity must allow GenerateDataKey)"; return 1; }
  # canonical KEK gate — derived from the GenerateDataKey KeyId (compared in-shell; the ARN is never printed)
  case "$keyid" in
    *"$KMS_CANONICAL_KEY"*) _row PASS "data key generated under the canonical KEK" ;;
    *"$KMS_SUPERSEDED_KEY"*) _row FAIL "data key generated under the SUPERSEDED key — abort"; return 1 ;;
    *) _row FAIL "data key not generated under the canonical KEK — abort"; return 1 ;;
  esac

  # runner Decrypt the synthetic wrapped DEK → recovered plaintext; round-trip PASS iff it matches (compared in-shell, never printed)
  local recovered
  recovered="$(_runner kms decrypt --ciphertext-blob fileb://<(printf '%s' "$ct_b64" | openssl base64 -d -A) --query 'Plaintext' --output text 2>/dev/null || true)"
  [ -n "$recovered" ] && [ "$recovered" = "$pt_b64" ] && _row PASS "runner kms:Decrypt round-trip matches (synthetic)" || { _row FAIL "runner kms:Decrypt round-trip failed/mismatch"; rc=1; }

  # web Decrypt the SAME synthetic wrapped DEK → MUST be AccessDenied. Capture only the error CLASS; raw stderr discarded.
  local web_err
  if web_err="$(_web kms decrypt --ciphertext-blob fileb://<(printf '%s' "$ct_b64" | openssl base64 -d -A) --query 'Plaintext' --output text 2>&1 >/dev/null)"; then
    _row FAIL "web kms:Decrypt SUCCEEDED — decrypt boundary BROKEN (web must be denied)"; rc=1
  elif printf '%s' "$web_err" | grep -q "AccessDenied"; then _row PASS "web kms:Decrypt = AccessDenied (negative confirmed)";
  else _row FAIL "web kms:Decrypt failed but not with AccessDenied (different error class)"; rc=1; fi

  _row INFO "no kms:Encrypt attempted (runner policy forbids Encrypt; GenerateDataKey returns the data key directly)"
  echo "== round-trip complete: proves the LIVE staging KMS decrypt boundary (synthetic only) — no secret stored, RISK-007 OPEN =="
  return $rc
}

selftest() {
  local pass=0 fail=0
  _case() { local got=ok; ( eval "$3"; check_guards ) >/dev/null 2>&1 || got=refused
    if [ "$got" = "$2" ]; then echo "  ok: $1"; pass=$((pass+1)); else echo "  FAIL: $1 (expected $2 got $got)"; fail=$((fail+1)); fi; }
  local V='export ID_CADDIE_RUNNER_KMS_ROUNDTRIP=1 AWS_PROFILE=runnerp ID_CADDIE_RUNNER_KMS_ROUNDTRIP_WEB_PROFILE=webp AWS_REGION=ca-central-1 ID_CADDIE_RUNNER_KMS_ROUNDTRIP_EXPECTED_ACCOUNT=000000000000 ID_CADDIE_RUNNER_KMS_ROUNDTRIP_ENV=staging RUNNER_KMS_ROUNDTRIP_PROJECT_REF=ycdpzduxugdsffjqyoai'
  _case "valid staging guards pass (no AWS, no crypto)" ok "$V"
  _case "no opt-in refuses" refused "$V; unset ID_CADDIE_RUNNER_KMS_ROUNDTRIP"
  _case "opt-in wrong value refuses" refused "$V; export ID_CADDIE_RUNNER_KMS_ROUNDTRIP=0"
  _case "missing runner profile refuses" refused "$V; unset AWS_PROFILE"
  _case "missing web profile refuses" refused "$V; unset ID_CADDIE_RUNNER_KMS_ROUNDTRIP_WEB_PROFILE"
  _case "missing region refuses" refused "$V; unset AWS_REGION"
  _case "wrong region refuses" refused "$V; export AWS_REGION=us-east-1"
  _case "missing expected account refuses" refused "$V; unset ID_CADDIE_RUNNER_KMS_ROUNDTRIP_EXPECTED_ACCOUNT"
  _case "non-12-digit account refuses" refused "$V; export ID_CADDIE_RUNNER_KMS_ROUNDTRIP_EXPECTED_ACCOUNT=abc"
  _case "missing env refuses" refused "$V; unset ID_CADDIE_RUNNER_KMS_ROUNDTRIP_ENV"
  _case "production env refuses" refused "$V; export ID_CADDIE_RUNNER_KMS_ROUNDTRIP_ENV=production"
  _case "prod env refuses" refused "$V; export ID_CADDIE_RUNNER_KMS_ROUNDTRIP_ENV=prod"
  _case "production project ref hard-aborts" refused "$V; export RUNNER_KMS_ROUNDTRIP_PROJECT_REF=dzbfxulvxchdemcettrx"
  _case "unknown project ref refuses" refused "$V; export RUNNER_KMS_ROUNDTRIP_PROJECT_REF=someotherref0000000"
  echo "  selftest: $pass passed, $fail failed"; [ "$fail" -eq 0 ]
}

if [ "${1:-}" = "selftest" ]; then selftest; else
  check_guards && run_roundtrip
fi
