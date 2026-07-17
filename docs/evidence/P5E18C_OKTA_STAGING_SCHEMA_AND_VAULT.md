# P5E18c — Okta staging schema + vault/IAM boundary (evidence)

**Status: the approved Okta staging SCHEMA was applied and the staging VAULT/IAM boundary was provisioned — all DORMANT, no secret material, nothing activated.** Date 2026-07-17. Migration 0048 applied to hosted **staging only** (`ycdpzduxugdsffjqyoai`); an EMPTY Okta secret container + a least-privilege IAM read grant were created on staging AWS (833822972703, ca-central-1). **No secret material, no Okta app, no client id, no client secret, no token, no authorization code, no Okta API call, no credential reference, no connector execution, no ECS task, no schedule, no first-sync authorization, no production access — none.** Okta + Microsoft Entra remain `certificationOnly`; RISK-007 OPEN; Phase C BLOCKED.

## Source SHAs
- v3 `main` = `1fc167957e656f6014973517159d4fc57b083899`; runner `main` = `c4e968a8a6bd46bfb37d74b29ac0cedd8059060d`. Clean trees at start.

## Staging target confirmation (Phase 0)
- AWS account = **833822972703** (staging); region = **ca-central-1**. Supabase linked ref = **ycdpzduxugdsffjqyoai** (staging). Migration 0048 was the ONLY pending staging migration (all prior 0032–0047 applied).

## Migration 0048 (Phase 1–2)
- **Reviewed non-destructive:** only `create table/index if not exists`, `enable row level security`, `revoke all from anon,authenticated`, `grant select to authenticated`, `create policy` — no drop/truncate/delete/update/broadening, no anon grant, no INSERT/UPDATE/DELETE grant, no FOR ALL policy. No token/secret/authorization-code/verifier columns. Provider constrained to okta, scope to `okta.users.read`, environment to staging.
- **Local re-validation before apply:** `scripts/test-rls.sh` (throwaway Postgres, all migrations + RLS suite) GREEN; `check-migration-safety.sh` passed.
- **Hosted apply (staging):** `supabase db push --linked` after positively confirming ref `ycdpzduxugdsffjqyoai`; dry-run showed ONLY `0048` pending. Applied.
- **Migration status:** `supabase migration list --linked` → `0048 | 0048 | 0048` (local = remote = applied).

### Schema/RLS verification (safe metadata; hosted staging)
```
table_exists=1 · rls_enabled=true · checks_present=4 (provider/scope/https/env) · unique_indexes=2 (active-org, active-issuer) · policies=1 (org-manager read)
```

### Zero-row verification (safe aggregates; hosted staging)
```
connector_okta_issuer_bindings=0 · connectors(provider='okta')=0 · connector_credential_references(provider='okta')=0 · oauth_pending(provider='okta')=0
```
No Okta connection, transaction, credential, or issuer-binding row was created. The migration activated no application behavior.

## Staging secret container (Phase 3) — redacted metadata, NO secret material
- Name: `/idcaddie/staging/connector/okta/staging-app-v1`
- ARN: `arn:aws:secretsmanager:ca-central-1:833822972703:secret:/idcaddie/staging/connector/okta/staging-app-v1-******` (random suffix redacted)
- **Version stages: NONE** — an EMPTY container; **no secret body / no placeholder material** was written (create-secret succeeded without a value; no `get-secret-value` was ever run).
- Tags: `Environment=staging`, `Provider=okta`, `State=dormant`, `Phase=P5E18c`, `SecretMaterial=none`.
- The private_key_jwt key is to be entered by an operator in a future GO-gated step (see `runbooks/OKTA_STAGING_APP_SETUP.md`).

## Staging IAM grant (Phase 4) — redacted metadata
- Policy `idcaddie-staging-okta-secret-read` attached to the EXISTING shared runner **task** role `idcaddie-staging-slack-taskread` (the **execution** role was NOT modified — role separation preserved).
- Single statement: `Effect=Allow`, `Action=secretsmanager:GetSecretValue` (only), `Resource=` the EXACT one Okta staging ARN (no wildcard, no list/describe, no write/update/delete, no production ref).
- Applied via `idcaddie-connector-runner/deploy/scripts/okta-secret-read-grant.sh attach <arn>` after independently confirming: staging account, staging region, exact task role, exact secret resource, no wildcard, no production reference; `validate` + `policy` reviewed first.
- Verified via `iam get-role-policy` metadata: GetSecretValue-only, exact ARN, no wildcard.

## Dormancy proof (Phase 5)
- Okta remains `certificationOnly` (code unchanged this phase); `isConnectorProviderReady("okta")` = false.
- runner: `resolveFrameworkProvider("okta")` = `provider_not_registered`; the dispatch guard = `provider_certification_only` (okta-provider-scaffold tests green).
- No credential body (empty secret container). No credential reference (0 rows). No authorization / schedule / first-sync authorization. ECS cluster `idcaddie-staging-connector-runner` = 0 running / 0 pending / 0 services (no task launched). No connector executed; no provider API call.
- The migration + container + grant created the boundary and activated NOTHING.

## Blockers still active
RISK-007 OPEN · Phase C BLOCKED · Okta certificationOnly · hosted OAuth disabled · no Okta app · no client id · no client secret · no token. All real execution fails closed.
