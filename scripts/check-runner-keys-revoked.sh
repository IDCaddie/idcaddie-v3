#!/usr/bin/env bash
#
# check-runner-keys-revoked.sh — OPERATOR-RUN temp-key cleanup verification (doc 42 §91.7(f)). After the operator DELETES
# the temporary IAM access keys used for the runner/web KMS test (in the AWS IAM Console — NOT by this script), this
# confirms the cleanup in whichever of two valid states applies, per old profile:
#   STATE 1 — the old profile still EXISTS locally: `sts get-caller-identity` must FAIL with a revoked-key class
#             (InvalidClientTokenId / UnrecognizedClientException). AccessDenied means STILL-LIVE → fail closed.
#   STATE 2 — the old profile was already REMOVED locally: PASS the LOCAL cleanup portion (local_profiles_removed). This
#             does NOT prove AWS-side deletion — that is the operator's authoritative IAM Console action, recorded apart.
# It is READ-ONLY — it creates/deletes/deactivates NO key, makes NO IAM/KMS/Secrets-Manager call, performs NO KMS crypto,
# and prints NO access key id / secret / ARN / account — only a redacted PASS/FAIL checklist + the safe error CLASS.
# RISK-007 stays OPEN.
#
# Operator run (old profile NAMES default to the pinned staging identities; override only if you named them differently):
#   ID_CADDIE_RUNNER_KEYS_REVOKED=1 ID_CADDIE_RUNNER_KEYS_REVOKED_ENV=staging \
#   [AWS_PROFILE=idcaddie-staging-runner] [ID_CADDIE_RUNNER_KEYS_REVOKED_WEB_PROFILE=idcaddie-staging-web] \
#   [AWS_REGION=ca-central-1] bash scripts/check-runner-keys-revoked.sh
# Self-test (no AWS):  bash scripts/check-runner-keys-revoked.sh selftest
set -euo pipefail

readonly EXPECT_REGION="ca-central-1"
readonly EXPECT_ENV="staging"
readonly STAGING_REF="ycdpzduxugdsffjqyoai"
readonly PRODUCTION_REF="dzbfxulvxchdemcettrx"

refuse() { echo "KEY-REVOCATION CHECK REFUSED: $1"; return 1; }
_row() { printf '  [%s] %s\n' "$1" "$2"; }

# The OLD temp-key profile NAMES to check (default to the pinned staging identities; overridable). They are checked for
# BOTH states: present-locally → live dead-key sts probe; absent-locally → local-cleanup evidence. No longer hard-required
# (the operator may have already removed them — that is a valid cleanup state), so a missing profile is not a refusal.
old_runner_profile() { echo "${AWS_PROFILE:-idcaddie-staging-runner}"; }
old_web_profile() { echo "${ID_CADDIE_RUNNER_KEYS_REVOKED_WEB_PROFILE:-idcaddie-staging-web}"; }

# Fail-closed guards (pure — no AWS). Returns 0 only for a valid staging request. Profiles are NOT required here (see
# above); region defaults to the pinned staging region but a wrong region is still refused.
check_guards() {
  [ "${ID_CADDIE_RUNNER_KEYS_REVOKED:-}" = "1" ] || { refuse "disabled (set ID_CADDIE_RUNNER_KEYS_REVOKED=1)"; return 1; }
  [ "${AWS_REGION:-$EXPECT_REGION}" = "$EXPECT_REGION" ] || { refuse "wrong_region (expected $EXPECT_REGION)"; return 1; }
  local env="${ID_CADDIE_RUNNER_KEYS_REVOKED_ENV:-}"
  case "$env" in production|prod) { refuse "production_disabled (staging-only)"; return 1; };; esac
  [ "$env" = "$EXPECT_ENV" ] || { refuse "unknown_env (set ID_CADDIE_RUNNER_KEYS_REVOKED_ENV=staging)"; return 1; }
  local ref="${RUNNER_KEYS_REVOKED_PROJECT_REF:-$(cat supabase/.temp/project-ref 2>/dev/null || true)}"
  [ "$ref" != "$PRODUCTION_REF" ] || { refuse "production must not be touched (project ref is $PRODUCTION_REF)"; return 1; }
  [ "$ref" = "$STAGING_REF" ] || { refuse "wrong_project_ref (expected staging $STAGING_REF)"; return 1; }
  return 0
}

# Is <name> present in the given profile list? Exact whole-line match (`grep -Fxq` = fixed-string, whole-line, quiet) so
# a superset/substring name can never false-match. The list is captured by the caller (never printed).
profile_present() { printf '%s\n' "$2" | grep -Fxq -- "$1"; }

# LAST_MODE is set by verify_profile: live_revoked | live_fail | local_removed.
LAST_MODE=""

# STATE 1 — the profile EXISTS locally: live dead-key probe. A profile is REVOKED iff `sts get-caller-identity` FAILS
# with a deleted/deactivated-key class. The captured sts output (which on an unexpected SUCCESS would contain the ARN) is
# held in a var and NEVER printed — only the matched error CLASS is shown.
verify_dead_live() { # <label> <profile>
  local label="$1" profile="$2" sts_out="" class="" ec=0
  sts_out="$(aws --profile "$profile" --region "$EXPECT_REGION" sts get-caller-identity --query 'Arn' --output text 2>&1)" || ec=$?
  if [ "$ec" -eq 0 ]; then
    _row FAIL "$label temp access key STILL WORKS — delete/deactivate it in the IAM Console (it must fail sts)"; return 1
  fi
  # ONLY a deleted/deactivated IAM-user access key produces these on sts get-caller-identity (which needs no permission).
  # AccessDenied = a credential that STILL AUTHENTICATES but is explicitly denied (i.e. LIVE), SignatureDoesNotMatch =
  # clock skew / corrupted local secret on a LIVE key, ExpiredToken = an STS session token (not these long-lived keys) —
  # none mean "revoked", so they fall through to the fail-closed FAIL branch.
  class="$(printf '%s' "$sts_out" | grep -oE 'InvalidClientTokenId|UnrecognizedClientException' | head -1 || true)"
  if [ -n "$class" ]; then _row PASS "$label temp access key is REVOKED / not usable (sts rejected: $class)"; return 0
  else _row FAIL "$label sts failed but not with a revoked-key error class — cannot confirm revoked (fail-closed)"; return 1; fi
}

# Verify one old profile in whichever state applies. STATE 2 — the profile is ALREADY REMOVED locally: this is valid
# LOCAL cleanup evidence (the credentials are no longer present on this machine). It does NOT prove AWS-side deletion —
# that is the operator's authoritative Console action, recorded separately.
verify_profile() { # <label> <profile-name> <profiles-list> <explicit:0|1>
  local label="$1" profile="$2" profiles="$3" explicit="$4"
  # If the operator EXPLICITLY named this profile, always run the live probe (never silently treat it as removed — a
  # truly-gone explicit profile yields a not-found sts error, which is not a revoked class, so it fails closed). Only a
  # DEFAULTED (unset) name that is absent from the local list counts as local cleanup.
  if [ "$explicit" = 1 ] || profile_present "$profile" "$profiles"; then
    if verify_dead_live "$label" "$profile"; then LAST_MODE="live_revoked"; return 0; else LAST_MODE="live_fail"; return 1; fi
  fi
  _row PASS "$label local profile REMOVED (local_profiles_removed) — credentials no longer present locally; AWS-side deletion/deactivation is the operator's authoritative IAM Console action — NOT proven or confirmed by this run"
  LAST_MODE="local_removed"; return 0
}

run_checks() {
  case "$-" in *x*) echo "KEY-REVOCATION CHECK REFUSED: disable shell xtrace (set +x)"; return 1;; esac
  local rc=0 modes="" runner web profiles list_ec=0 r_explicit=0 w_explicit=0
  runner="$(old_runner_profile)"; web="$(old_web_profile)"
  if [ -n "${AWS_PROFILE:-}" ]; then r_explicit=1; fi                              # operator named the runner profile
  if [ -n "${ID_CADDIE_RUNNER_KEYS_REVOKED_WEB_PROFILE:-}" ]; then w_explicit=1; fi # operator named the web profile
  echo "== temp-key cleanup verification (READ-ONLY: sts get-caller-identity + local 'aws configure list-profiles'; no IAM/KMS/secret calls; no key material printed) =="
  # Enumerate local profiles ONCE (LOCAL, no network, no secrets). If enumeration itself FAILS, fail closed — we must not
  # declare a profile "removed" when we could not actually list profiles.
  profiles="$(aws configure list-profiles 2>/dev/null)" || list_ec=$?
  if [ "$list_ec" -ne 0 ]; then
    _row FAIL "could not enumerate local AWS profiles ('aws configure list-profiles' failed) — cannot verify cleanup (fail-closed)"
    echo "== FAIL: local profile enumeration failed — cannot confirm cleanup =="; return 1
  fi
  verify_profile "old runner ($runner)" "$runner" "$profiles" "$r_explicit" || rc=1; modes="$modes $LAST_MODE"
  verify_profile "old web ($web)" "$web" "$profiles" "$w_explicit" || rc=1;          modes="$modes $LAST_MODE"

  if [ "$rc" -ne 0 ]; then
    echo "== FAIL: a temp key STILL WORKS or could not be confirmed revoked — delete/deactivate it in the IAM Console before proceeding =="
  elif ! printf '%s' "$modes" | grep -q local_removed; then
    echo "== PASS: both old profiles present and live sts REJECTED them (revoked) — §91.7(f) AWS-side dead-key verification satisfied. RISK-007 still OPEN =="
  elif ! printf '%s' "$modes" | grep -q live_revoked; then
    echo "== PASS (local cleanup): both old profiles are REMOVED locally (local_profiles_removed). This run did NOT perform a live AWS dead-key check; the authoritative AWS-side deletion/deactivation is the operator's IAM Console action — record it separately. RISK-007 still OPEN =="
  else
    echo "== PASS (mixed): see per-profile rows — some live-revoked, some locally removed. AWS-side deletion for removed profiles is the operator's Console action. RISK-007 still OPEN =="
  fi
  return $rc
}

selftest() {
  local pass=0 fail=0
  _case() { local got=ok; ( eval "$3"; check_guards ) >/dev/null 2>&1 || got=refused
    if [ "$got" = "$2" ]; then echo "  ok: $1"; pass=$((pass+1)); else echo "  FAIL: $1 (expected $2 got $got)"; fail=$((fail+1)); fi; }
  local V='export ID_CADDIE_RUNNER_KEYS_REVOKED=1 AWS_REGION=ca-central-1 ID_CADDIE_RUNNER_KEYS_REVOKED_ENV=staging RUNNER_KEYS_REVOKED_PROJECT_REF=ycdpzduxugdsffjqyoai; unset AWS_PROFILE ID_CADDIE_RUNNER_KEYS_REVOKED_WEB_PROFILE'
  _case "valid staging guards pass, no profiles set (default to pinned names — the removed-profiles case)" ok "$V"
  _case "guards pass with no region set (defaults to ca-central-1)" ok "$V; unset AWS_REGION"
  _case "guards pass with explicit profiles set" ok "$V; export AWS_PROFILE=idcaddie-staging-runner ID_CADDIE_RUNNER_KEYS_REVOKED_WEB_PROFILE=idcaddie-staging-web"
  _case "no opt-in refuses" refused "$V; unset ID_CADDIE_RUNNER_KEYS_REVOKED"
  _case "opt-in wrong value refuses" refused "$V; export ID_CADDIE_RUNNER_KEYS_REVOKED=0"
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
