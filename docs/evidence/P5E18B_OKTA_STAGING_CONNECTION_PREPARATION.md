# P5E18b — Okta staging connection preparation (evidence)

**Status: the real Okta staging connection PATH is prepared in code + schema + IaC, and STOPS before authorization, token exchange, API calls, and any sync — all dormant/reversible.** Date 2026-07-17. **Migration 0048 was NOT applied to hosted staging. No AWS hosted mutation occurred. No Okta app, no client id, no client secret, no authorization code, no token, no Okta API call, no credential body/reference, no connector execution, no ECS task, no schedule, no first-sync authorization, no production access — none.** Okta + Microsoft Entra remain `certificationOnly`; RISK-007 OPEN; Phase C BLOCKED.

## Source
- v3 branch `feat/okta-staging-connection-preparation` off `main` `9f0ac77`; runner branch `feat/okta-staging-credential-wiring` off `main` `83089d3`. Baseline suites green before changes (v3 1503 / runner 836). AWS identity = staging account 833822972703 (ca-central-1); Supabase linked ref = staging `ycdpzduxugdsffjqyoai`. Not production.

## Design
- **Callback route (Phase 8):** a DEDICATED, provider-isolated Okta route at `/connectors/oauth/okta/callback` (NOT the shared Slack callback — zero coupling). It runs the 13 ordered gates (`evaluateOktaCallback`) and invokes the token-exchange adapter ONLY on `validated_no_exchange`, which is unreachable while certificationOnly + governance blocked. An extra env gate (`isOktaCallbackEnabled`, OFF by default + in production) is a further independent block. The authorization code is never echoed/logged; the redirect is a FIXED customer-safe path.
- **PKCE (Phase 4):** transient server-only verifier store — short TTL, one-time (`takeOnce` deletes), auto-expiry, never client-readable/logged; never persisted in `oauth_pending` or any app table. Only the S256 challenge is non-secret.
- **Transaction persistence (Phase 4):** a single-use store boundary over the non-secret record (state nonce HASH + challenge, no verifier/token/code); consume-once with replay/expiry/invalidation.
- **Token-exchange adapter (Phase 6):** HTTPS-only, issuer-bound exact `/oauth2/v1/token`, POST, `authorization_code` grant, exact redirect, PKCE verifier, private_key_jwt assertion, strict timeout + AbortSignal, no broad retries, max response size, content-type validation, sanitized error taxonomy. Validates the response: token type Bearer, granted scope EXACTLY `okta.users.read` (rejects broader/missing), expiry bounds, required fields. The raw token is handed straight to the vault-write boundary and is NEVER in a log/exception/audit/return (only a branded `VaultBoundAccessTokenRef`). Dependency-injected; exercised only with mocked transport — no real Okta call.
- **Credential-write boundary (Phase 7):** write-only secret store interface → returns a POINTER; the app DB gets only a reference + version + non-secret metadata + status `connected_unsynced`. Idempotent; atomic — rolls the secret back (markRevoked) if the DB reference write fails; no read-after-write of the secret value; the full ref is never returned. No real secret body created.
- **Connection persistence (Phase 9):** atomic connected-unsynced (issuer binding, credential version, exact scope, sync count 0, last sync null, scheduling disabled, first-sync absent, audit event); rollback on commit failure. Unreachable while certificationOnly.
- **Disconnect (Phase 10):** admin-gated, idempotent; marks disconnected, invalidates execution eligibility + pending transactions, disables schedule, revokes the credential reference via a server-only sink; reveals no secret identifier; no real Okta revocation call.
- **Client config (Phase 5):** server-only model resolving client id (non-secret; ABSENT until operator-supplied → fails closed), private_key_jwt method, credential reference, redirect, issuer, exact scope, endpoints, timeout, staging env, lifecycle gate.
- **Runner credential-consumption (Phase 11):** dormant boundary — validated credential reference + issuer binding + the full dispatch guard (certificationOnly/schedule/phase/first-sync/scope/limit/production); the credential resolver is invoked ONLY when every gate passes (never today).

## Migration 0048 (issuer binding)
- `supabase/migrations/0048_connector_okta_issuer_binding.sql` — non-secret per-org Okta issuer binding (org/provider/host/canonical https issuer/environment/lifecycle/exact scope/audit). CHECKs: provider=okta, scope=`{okta.users.read}`, https issuer, staging-only; partial unique indexes (one active/org, one active/issuer → no cross-org reassignment); composite same-tenant FK; **no secret fields**; RLS: org-manager read only + server-only (service_role) write; ACTIVATES nothing.
- **Applied to LOCAL** (throwaway Postgres via `scripts/test-rls.sh`) — the full RLS suite passed incl. `connector_okta_issuer_binding_test.sql` (I0–I4). **NOT applied to hosted staging.**

### Hosted staging apply — exact command sequence (REVIEWED, NOT RUN — requires a separate explicit GO)
```bash
# 0. POSITIVELY confirm the linked target is STAGING (ycdpzduxugdsffjqyoai), NOT production
cat supabase/.temp/project-ref     # must read: ycdpzduxugdsffjqyoai
# 1. Dry-run: confirm ONLY 0048 is pending on staging
supabase migration list --linked   # 0048 shows as local-only / pending; all prior applied
# 2. Review the diff (non-destructive: a new table + RLS only)
supabase db diff --linked --schema public   # (or review 0048_*.sql directly)
# 3. Apply ONLY the pending migration to staging
supabase db push --linked
# 4. Verify
supabase migration list --linked   # 0048 now applied
#    Safe schema-metadata + aggregate verification (no PII, no secret):
#    - table + RLS enabled + policies present (pg_class.relrowsecurity, pg_policies)
#    - select count(*) from public.connector_okta_issuer_bindings;  -- expect 0 (no real bindings)
```
Safety: non-destructive (create table + RLS only); no data insert; no credential reference; production never selected. See the GO checklist below.

## AWS staging IaC (Phase 7/12) — prepared, NOT applied
- `idcaddie-connector-runner/deploy/scripts/okta-secret-read-grant.sh` — least-privilege `GetSecretValue` grant on the EXACT `/idcaddie/staging/connector/okta/<segment>` ARN to the shared task role (mirrors the Entra pattern; prod-ref + wildcard refusal). **Not run.**
- `idcaddie-connector-runner/deploy/OKTA_STAGING_IAM.md` — the secret-namespace + IAM change spec. Execution role unchanged. `deploy:check` green (20 files).
- Read-only staging check: ECS cluster `idcaddie-staging-connector-runner` = ACTIVE, 0 services/running/pending (dormant). No AWS resource created/modified.

## Tests + validation
- v3: `tsc` 0; full suite **1527 green** (+~40 new: token-exchange adapter, staging wiring, callback route, org-import guard); RLS suite green (0048 local + T64). runner: `tsc` 0; full suite **841 green** (+5); `vendor:verify` + `deploy:check` green. lint / build / auth-safety / no-real-token / docs-drift / migration-safety / diff / NUL — run in Phase 18.

## Reviewer findings (Phase 16 — four reviewers)
- **OAuth callback + token-exchange:** no P0/P1. Two LATENT notes for the future live phase (not exploitable while dormant): (a) the callback's `expectedIssuerUrl` is derived from the transaction, so gate 9 is a tautology in the dormant wiring — a real flow must source it from an independent issuer-binding server-of-record; (b) the token endpoint host trusts `issuerUrl` verbatim (server config, never request-derived today) — the live phase should validate the resolved host against the expected org.
- **Secret storage + IAM:** no P0/P1. Note: credential-write idempotency is external (relies on the future sink's unique constraint) — add a test when the sink is real.
- **Tenant isolation + RLS:** **one P1 (fixed)** — the RLS test harness didn't re-revoke writes on the new table, so the write-denial test passed via RLS rather than the real grant surface. Fixed: `scripts/test-rls.sh` now revokes-all + grants SELECT on `connector_okta_issuer_bindings` (mirroring 0048's hosted posture), the I2 test now asserts writes are denied at the PRIVILEGE layer, and I5 adds an exact-privilege backstop (authenticated = SELECT-only; anon = nothing + read-denied). The migration itself was already correct.
- **Runner dormancy + production-safety:** no P0/P1.

## Remaining operator actions & governance blockers
- Operator: create the staging Okta app (private_key_jwt, `okta.users.read`, exact redirect), enter the secret into Secrets Manager, provide the non-secret client id/issuer via `CONNECTOR_OKTA_*` — per `OKTA_STAGING_APP_SETUP.md`. Then apply migration 0048 to staging + the IAM grant.
- Governance blockers (all fail closed today): RISK-007 OPEN, Phase C BLOCKED, Okta certificationOnly, hosted OAuth disabled.

## Explicit-GO checklist (each requires its own approval; NONE performed in P5E18b)
- [ ] **Hosted staging migration apply (0048)** — run the reviewed command sequence above after positively confirming ref `ycdpzduxugdsffjqyoai`.
- [ ] **AWS staging secret + IAM provisioning** — create `/idcaddie/staging/connector/okta/<segment>` + run `okta-secret-read-grant.sh attach <arn>`.
- [ ] **Okta administrator app creation** — per `OKTA_STAGING_APP_SETUP.md`, stopping before the authorize button.
