# P5E16 — Okta connector foundation (evidence)

**Status: the certification-only Okta Workforce Identity connector FOUNDATION is implemented, tested, and GREEN. Okta remains
`certificationOnly`, disabled, and non-runnable.** Date 2026-07-17. Synthetic-staging + certification only; production **untouched**;
`microsoft_entra` unchanged; RISK-007 OPEN; Phase C BLOCKED. **No real Okta tenant, credential, token, OAuth token, API call, ECS,
schedule, promotion, or production access — none.** No DB migration (`connectors.provider` + control-plane tables are provider-neutral).

Canonical model: [`OKTA_CONNECTOR_MODEL.md`](../OKTA_CONNECTOR_MODEL.md) + [`OKTA_CREDENTIAL_AND_CONSENT_MODEL.md`](../OKTA_CREDENTIAL_AND_CONSENT_MODEL.md).
Runner design: `idcaddie-connector-runner` `docs/OKTA_AUTHENTICATION_DESIGN.md` + `OKTA_CERTIFICATION_PLAN.md` + `OKTA_STAGING_OPERATIONS.md`.

## Phase 0 baseline (verified)

v3 HEAD == origin/main == `6983bd9…`; runner HEAD == origin/main == `3cbd145…`; both worktrees clean; AWS Scheduler DISABLED; ECS
running/pending/services 0/0/0; no enabled customer pilot; RISK-007 OPEN; Phase C BLOCKED; no production target.

## What was built (runner; all inert)

11 Okta contract modules (`src/connector-sync/okta-*.ts`): user/page schemas, normalizer, auth (private_key_jwt) + token-schema +
token-cache, secret (staging ARN + metadata-only doc parser), connection (server-derived reference + ownership resolver),
pagination (Link-header cursor), fixtures (synthetic), certification harness, Okta-specific strict manifest + `manifests/okta.v1.json`.
Guard tests extended (`generic-runtime-slack-guard.test.ts` APPROVED + Okta PROHIBITED fingerprint + self-test). **No** live-wiring/
entrypoint/composition/pilot/scheduled file; **no** framework-registry entry (fails closed); **no** vendored-file edit.

## Authentication recommendation

**OAuth 2.0 service app with `private_key_jwt`** (least-privilege, rotatable, revocable, auditable, one-click-friendly). Legacy API
token (SSWS) modeled as a secondary type, not preferred. Scope `okta.users.read` (v1). See the auth design doc.

## Initial certified resource scope

**Users only.** Groups/membership, app-assignments, factors/MFA, system logs, and all writes are deferred (separately authorized).

## Tests + gates (GREEN)

- connector-runner: `tsc` clean; **817 tests pass** (+84 Okta: schemas/normalizer/auth/token/secret/connection/isolation/
  pagination/rate-limits/certification/manifest/dormancy); `vendor:verify` OK (28 files, no vendored edits); `deploy:check` OK.
- Isolation proven: secret ARN pinned; metadata-only doc parser (no key/token leak); ownership resolver (wrong tenant/connector/
  provider/version/status fail); cross-tenant + cross-provider token-cache bleed defense; server-derived org host; caller cannot
  inject host/token/issuer/org/secret-ref.
- Dormancy proven: okta not in the runner framework-registry (fail closed); no okta manifest in the vendored dir; no
  live/entrypoint/composition file; no deployable import of okta; no deploy task-def references okta; `.invalid` cert host only.

## Reviewer findings (Phase 12)

2 adversarial reviewers (credential/isolation/SSRF; data/pagination/dormancy). **No confirmed P0/P1/P2 defects** — every attack class
(private-key/API-token leakage, cross-tenant + cross-provider reuse, token-cache bleed, SSRF/org-host injection, secret-ARN,
pagination link injection, rate-limit amplification, profile overcollection, no-promotion, raw-error leakage, dormancy, production
bypass) held. 4 P3 defense-in-depth hardenings applied anyway: (1) `validateOrgHost` now rejects IP-literal hosts (IMDS/internal);
(2) `isValidClientAssertion` rejects non-ASCII bytes (a JWT is pure-ASCII); (3) `assembleFact` spreads normalized fields FIRST so a
future normalizer can never override a control field (`review_status`/`signal_id`); (4) `handleRateLimit` fails closed on a
NaN/negative attempt count. Re-validated green.

## Confirmations

No real Okta tenant accessed · no credential created or read · no Okta API call · no ECS task launched · no pilot enabled · Okta
remains `certificationOnly` · `microsoft_entra` remains `certificationOnly` · RISK-007 OPEN · Phase C BLOCKED · no production access.
