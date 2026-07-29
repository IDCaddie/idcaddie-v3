# Okta connector threat model (P5E18a — dormant foundation)

Scope: the **dormant** Okta live-connection foundation (`src/lib/server/connector-vault/okta-live/`, runner `okta-provider-scaffold.ts`). In P5E18a the real path is **disabled and unexercised**: Okta is `certificationOnly`, Phase C is BLOCKED, RISK-007 is OPEN, no credential/token/exchange/dispatch exists. This document is the security design the future authorized phase must uphold; every prevention below is already implemented in the dormant modules and covered by a test.

Format per threat: **Attack → Impact → Prevention → Detection → Residual → Evidence**.

---

### 1. OAuth `state` theft / CSRF
- **Attack**: an attacker injects/forges a `state` to complete a connection in a victim's session.
- **Impact**: cross-user connection / account linking.
- **Prevention**: `state` is HMAC-signed over 8 bound fields (subject/tenant/provider/connector/redirect/correlation/expiry/nonce); the signature is verified constant-time BEFORE any field is trusted; generation is actor-authorized (`generateBoundOAuthState`). (`oauth-state.ts`, reused by `okta-oauth-transaction.ts`.)
- **Detection**: `invalid_state`/`bad_signature` reason codes in the callback result (never the value).
- **Residual**: relies on the server-held signing secret staying secret (KMS in production; not present in this phase).
- **Evidence**: `okta-callback-foundation.test.ts` (tampered/missing state rejected), `oauth-state.test.ts`.

### 2. PKCE verifier theft
- **Attack**: steal the PKCE `code_verifier` to complete a code exchange.
- **Impact**: code interception → token.
- **Prevention**: the verifier is generated server-side (`createPkce`), returned **separately** from the transaction, **never** placed on the transaction/record, **never** persisted through `oauth_pending` (whose `FORBIDDEN_KEYS` blocks `verifier`/`pkce`), and never logged. Only the S256 `code_challenge` (non-secret) is public.
- **Detection**: `pkce_unavailable` gate; boundary tests assert the verifier is absent from records.
- **Residual**: server-side verifier store design is deferred to the provisioning phase (must be short-TTL + access-scoped).
- **Evidence**: `okta-oauth-transaction.test.ts` (verifier not on transaction/record), `okta-credential-boundary.test.ts`.

### 3. Authorization-code replay
- **Attack**: replay a captured `code` / re-use a completed transaction.
- **Impact**: duplicate/hijacked exchange.
- **Prevention**: single-use transaction (nonce single-use via `ConsumedNonceStore`; server-side `consumedAt`); expiry (short TTL); `transaction_already_consumed`/`transaction_expired` gates. PKCE further binds the code to the verifier.
- **Detection**: `invalid_state` (replayed nonce), `transaction_already_consumed` reasons.
- **Residual**: production single-use store must be atomic (the existing `oauth-pending-consume` one-atomic-UPDATE pattern).
- **Evidence**: `okta-callback-foundation.test.ts` (replayed nonce rejected; expired/consumed rejected).

### 4. Callback confusion / provider mix-up
- **Attack**: deliver an Okta callback to a Slack handler (or vice-versa) to reuse validation.
- **Impact**: wrong-provider processing.
- **Prevention**: the Okta callback foundation is **not** wired into the shared Slack callback route; it checks `expectedProvider === "okta"` + the state's bound `prov`. Okta reason codes are a separate union (no `oauth_pending.last_rejected_code` drift).
- **Detection**: `wrong_provider` / `wrong_callback_route`.
- **Residual**: when a future phase wires a provider-selecting route, it must select expectedContext+handler by provider.
- **Evidence**: `okta-callback-foundation.test.ts` (wrong route/provider rejected); dangerous-coupling note in the module header.

### 5. Issuer mix-up
- **Attack**: complete against a different Okta issuer than the one bound at initiation.
- **Impact**: token from an attacker-controlled issuer.
- **Prevention**: `issuer_binding_mismatch` gate compares the transaction's `issuerUrl` to the server-known expected issuer; the org validator restricts issuers to Okta apexes / allowlisted custom domains.
- **Detection**: `issuer_binding_mismatch`.
- **Residual**: none in the dormant model (no exchange).
- **Evidence**: `okta-callback-foundation.test.ts` (issuer-binding mismatch rejected), `okta-org-validator.test.ts`.

### 6. Tenant substitution / cross-organization connection access
- **Attack**: complete a transaction minted for tenant/org A within tenant/org B's session.
- **Impact**: cross-tenant connection.
- **Prevention**: state binds `tid` + generation-time actor authorization; callback checks `organization_mismatch` + `subject_mismatch`; the credential-reference store is tenant+connector+provider scoped (`SET ROLE connector_runner`, exact-one-row); RLS deny-all on the reference table.
- **Detection**: `organization_mismatch` / `subject_mismatch` / `tenant_mismatch`.
- **Residual**: RLS + BYPASSRLS runner isolation must remain intact (unchanged this phase).
- **Evidence**: `okta-callback-foundation.test.ts` (cross-org rejected); 0043 RLS tests (existing).

### 7. Open redirect / attacker-controlled callback target
- **Attack**: supply a malicious `redirect_uri` or post-connection `returnRoute`.
- **Impact**: token/code exfiltration or phishing.
- **Prevention**: the redirect URI is a **server-trusted** exact string (never request-derived); the authorize builder validates it against a fixed callback-path regex; the return route is same-site-allowlisted (`isSafeReturnRoute`).
- **Detection**: `invalid_redirect_uri` / `unsafe_return_route` / `redirect_uri_mismatch`.
- **Residual**: none — the redirect is a server constant.
- **Evidence**: `okta-authorize-url.test.ts`, `okta-oauth-transaction.test.ts` (return-route allowlist), `okta-connect-gate.test.ts`.

### 8. SSRF via organization/issuer
- **Attack**: enter an org value pointing at loopback/link-local/metadata/private hosts.
- **Impact**: server-side request to an internal target.
- **Prevention**: `validateOktaOrganization` (server-side, no network) rejects non-https schemes, credentials, ports, paths/query/fragments, whitespace, localhost/loopback, private + link-local IPs (incl. `169.254.169.254`), IP literals, non-ASCII/punycode, and non-Okta domains; it never trusts the client normalizer.
- **Detection**: typed reason (`private_or_link_local`, `loopback`, `ip_literal`, `non_https_scheme`, …).
- **Residual**: none in the dormant model (no network at all).
- **Evidence**: `okta-org-validator.test.ts` (table-driven, incl. cloud-metadata IP).

### 9. Malicious custom domain
- **Attack**: pass a look-alike custom Okta domain.
- **Impact**: connect to an attacker host.
- **Prevention**: custom domains are accepted only by **exact match** against an explicit server allowlist (empty by default); homoglyph/IDN rejected (non-ASCII banned; `xn--` only via allowlist).
- **Detection**: `not_allowed_custom_domain` / `bad_punycode`.
- **Residual**: the allowlist must be curated per authorized pilot.
- **Evidence**: `okta-org-validator.test.ts` (allowlist + punycode cases).

### 10. Scope escalation
- **Attack**: request broader scopes (groups/apps/logs/factors/write).
- **Impact**: over-privileged access.
- **Prevention**: `scopesExactlyApproved` enforces the EXACT set `["okta.users.read", "okta.groups.read", "okta.apps.read"]` — all three READ-ONLY — as a SET: ordering is irrelevant, and a missing scope, an extra scope, a duplicate, a malformed name and any `.manage`/`.write` scope each fail closed with their own diagnostic. Prohibited families are enumerated AND backed by a write-verb suffix rule so an unenumerated write scope cannot slip through. The connect gate enforces it, and the DB enforces it independently via the `okta_issuer_scope_chk` CHECK (migration `0062`).
- **SUPERSEDED (O1B)**: this entry previously claimed the exact set was `["okta.users.read"]`. That was false in two ways — the connector-runner had already been authorized for `okta.groups.read` (Phase 5) and `okta.apps.read` (Phases 9–12), and V3 additionally listed `okta.apps.read` as **prohibited**, so a customer granting the correct scopes would have been *rejected*. The users-only claim is retained here only to record why the old contract was wrong.
- **Detection**: `scope_not_exact` / `scope_not_approved`.
- **Residual**: broadening scope is a separate authorized capability phase.
- **Evidence**: `okta-org-validator.test.ts` (scope table), `okta-authorize-url.test.ts`, runner `okta-provider-scaffold.test.ts`.

### 11. Token leakage
- **Attack**: a raw access/refresh token reaches a component/response/log/DB/snapshot.
- **Impact**: credential disclosure.
- **Prevention**: the token-exchange interface returns only an opaque `VaultBoundAccessTokenRef` (never a token); no exchange is implemented (throws); the credential-reference table stores only a pointer; audit events forbid token fields; server-only sentinels + `no-client-import` guard keep it off the client.
- **Detection**: boundary tests scan record/DTO/audit shapes for token fields.
- **Residual**: the future vault-writing boundary must envelope-encrypt (existing `connector_secrets` model).
- **Evidence**: `okta-dormancy.test.ts`, `okta-credential-boundary.test.ts`, `okta-audit-events` allowlist.

### 12. Credential-reference substitution
- **Attack**: swap a connection's credential reference for another's.
- **Impact**: use of the wrong tenant's credential.
- **Prevention**: exact-one-row (tenant, connector, provider) read with a defense-in-depth identity re-check; `unique(tenant_id, connector_id, provider)`; composite same-tenant FK; deny-all RLS.
- **Detection**: `identity mismatch` / `ambiguous` store errors (redacted).
- **Residual**: unchanged 0043 posture.
- **Evidence**: existing `connector-credential-reference-store.test.ts`; `okta-credential-boundary.test.ts`.

### 13. Stale authorization (gate changed after initiation)
- **Attack**: complete a callback after lifecycle/governance changed (e.g. downgraded).
- **Impact**: proceeding under a revoked posture.
- **Prevention**: the callback re-checks lifecycle + governance at gate 13 (`lifecycle_changed`/`governance_changed`); first-sync re-checks lifecycle/governance/expiry.
- **Detection**: `lifecycle_changed` / `governance_changed`.
- **Residual**: none in the dormant model.
- **Evidence**: `okta-callback-foundation.test.ts` (certificationOnly blocks gate 13).

### 14. Execution after disconnect
- **Attack**: run a sync for a disconnected connection.
- **Impact**: unauthorized data pull.
- **Prevention**: disconnect invalidates execution eligibility immediately, pauses schedules, invalidates pending transactions, and requests credential revocation; execution eligibility requires the full independent gate set (none satisfied post-disconnect).
- **Detection**: eligibility `failing` gate list; disconnect audit event.
- **Residual**: the future executor must consult eligibility per run.
- **Evidence**: `okta-dormancy.test.ts` (disconnect idempotent + eligibility never runnable).

### 15. Excessive pagination / user-count explosion / retry storms
- **Attack**: force unbounded pages/users/retries.
- **Impact**: DoS / cost / provider ban.
- **Prevention**: bounded budget (`OKTA_DEFAULT_BUDGET`: maxPages/maxRecords/maxRetries/maxRuntime), `OKTA_MAX_PAGE_ITEMS` cap, dispatch guard `excessive_user_limit`, first-sync `maxUserCount`/`maxRuns` bounds (default 0 / non-runnable), retries off by default.
- **Detection**: `excessive_user_limit` / budget-exceeded reasons.
- **Residual**: the live pagination must enforce the budget (existing `okta-pagination.ts`).
- **Evidence**: runner `okta-provider-scaffold.test.ts` (limit gates), `okta-first-sync-authorization` bounds.

### 16. PII leakage in logs
- **Attack**: a name/email/profile lands in a log or audit event.
- **Impact**: privacy breach.
- **Prevention**: `safeOktaLogFields` whitelists only ids/counts; audit events allow only a closed non-secret key set + stable reason codes (never a raw message/error body); user schema rejects `credentials`/`_embedded`.
- **Detection**: allowlist rejects unknown keys (throws).
- **Residual**: call sites must use the helpers (unwired in this phase).
- **Evidence**: `okta-provider-scaffold.test.ts` (safe log fields), `okta-dormancy.test.ts` (audit sanitization).

### 17. Preview / live-state confusion
- **Attack**: a "Preview" UI label is treated as authorization to run the real path.
- **Impact**: accidental live activation.
- **Prevention**: execution decisions consult the provider **lifecycle** + governance, never the UI label; `REAL_OKTA_CONNECTION_AVAILABLE=false`; the connect gate does not read the UI label.
- **Detection**: connect-gate `lifecycle_not_pilot_ready`; UI-label tests.
- **Residual**: none — the separation is enforced in code.
- **Evidence**: `okta-connect-gate.test.ts`, `okta-connection-labels.test.ts`.

### 18. Production activation by configuration mistake
- **Attack**: a misconfig enables the real path in production.
- **Impact**: unapproved production run.
- **Prevention**: governance `hostedOAuthEnabled=false` + Phase C blocked + certificationOnly (all must flip); first-sync `environment="staging"` only; runner dispatch `production_not_authorized`; the existing production-ref refusal + env gates (`CONNECTOR_OAUTH_*_ENABLED` default off, non-prod) are unchanged.
- **Detection**: `production_not_authorized` / `governance_blocked`.
- **Residual**: production enablement is a separate, multi-signature governance action.
- **Evidence**: `okta-provider-scaffold.test.ts` (production gate), `okta-connect-gate.test.ts` (governance/env gates).

---

## Deferred design (recorded, not a gap in dormancy)
- **Issuer-binding persistence**: the per-org issuer/host binding is modeled at the app layer (`OktaOAuthTransaction`/`OktaCallbackTransaction`); a dedicated non-secret RLS-gated table is **deferred to the credential-provisioning phase** (alongside the deferred 0043 write path), because P5E18a persists **no** rows. No migration is added in this phase.
- **private_key_jwt signing**: KMS-backed client-assertion signing is unbuilt (runner `okta-auth.ts` takes a pre-signed assertion). No key material is handled.
- **Token-exchange + vault write**: interface only; the live HTTP + envelope-encrypted vault write is the future authorized edge.

RISK-007 remains OPEN. Phase C remains BLOCKED. Okta + Microsoft Entra remain `certificationOnly`.

---

## P5E18b addendum — staging connection path (still dormant)

P5E18b adds the real staging PATH (persistence + exchange + write boundaries + a dedicated callback route + migration 0048) while keeping every real action fail-closed. New surfaces map to the threats above:

- **PKCE verifier theft (#2):** the verifier now has a concrete transient store — short-TTL, one-time (`takeOnce` deletes), auto-expiry, server-only, never in a cookie/URL/audit/log and never persisted in `oauth_pending` or any app table. Only the S256 challenge is persisted. Evidence: `okta-pkce-verifier-store.ts` + `okta-staging-wiring.test.ts`.
- **Token leakage (#11):** the token-exchange adapter validates the response (Bearer, expiry, size, content-type, and the granted scope against the approved contract — `okta.users.read` at the time this entry was written; **superseded in O1B** by the three-scope set, since each resource task requests only the one scope its endpoint needs) and hands the raw token straight to the vault-write boundary — never a raw token in a log/exception/audit/return (only a branded `VaultBoundAccessTokenRef`). Evidence: `okta-token-exchange-adapter.test.ts` (asserts the raw token never appears in the result).
- **Credential-reference substitution / partial write (#12):** the credential-write boundary is write-only (no read-after-write of the value), idempotent, atomic — rolls the secret back if the DB reference write fails; the full ref is never returned to a customer. Evidence: `okta-credential-write.ts` + rollback test.
- **Open redirect / callback confusion (#4, #7):** the callback route is provider-ISOLATED at `/connectors/oauth/okta/callback` (zero Slack coupling), uses a server-trusted exact redirect, never echoes the code, and redirects only to a fixed customer-safe path; the exchange is invoked only on `validated_no_exchange` (unreachable while certificationOnly) plus an env gate off by default + in production.
- **Cross-org access / tenant isolation (#6):** migration 0048 issuer binding is RLS org-manager-read-only + server-only-write, with a partial unique index preventing an issuer from being actively bound to a second org. Evidence: `connector_okta_issuer_binding_test.sql` (I1 cross-org denied, I4 reassignment blocked).
- **Production activation by misconfig (#18):** the issuer binding is CHECK-constrained to `environment='staging'`; the client config requires staging; the runner consumption boundary rejects production; the AWS IaC refuses any production ref/wildcard; migration 0048 was NOT applied to hosted staging and no AWS resource was created. New env gate `isOktaCallbackEnabled` is off by default + in production.

private_key_jwt signing remains KMS-backed + unbuilt; no client secret exists; no real Okta call is made anywhere. RISK-007 OPEN; Phase C BLOCKED; Okta certificationOnly.
