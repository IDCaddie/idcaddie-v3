# 42 · Connector Credential Vault — Security Design

**Status: DRAFT — design only. Connector credential vault design is drafted but not implemented.**
**Connector implementation remains blocked until the vault design is reviewed and accepted.**

This is a **docs-only security design**. **No connector credentials are stored by this PR. No connector sync is
implemented by this PR. No production data was touched. No hosted commands were run. No migrations were added. No
RLS policies were changed. No service-role access was added.** Schema and RLS below are **conceptual only** — no
migration, table, policy, or encryption code ships here. It is the Option-A "connector vault security design PR"
the read-only-parity checkpoint ([41 §32.3](./41_FULL_PARITY_IMPLEMENTATION_ROADMAP.md)) requires before any
connector work, and the prerequisite for **RISK-007** (connector secrets).

---

## 1. Executive summary

The legacy app shipped 52+ connectors/scrapers, each holding provider credentials (OAuth tokens, API keys, PATs,
webhook signing secrets). v3 must not store or use a single connector credential until a vault design is accepted,
because connector secrets are the highest-value target in the system and the existing v3 authorization model
(RLS-as-sole-boundary, **no service-role on request paths**) was built for *reads*, not for *holding secrets a
malicious tenant must never reach*.

The design rests on five load-bearing decisions:

1. **Two-tier split.** *Metadata* (connector name, provider, status, last sync) lives in RLS-readable tables.
   *Secret material* (tokens, keys) lives in a separate store that the `authenticated` Postgres role has **no
   grant on and no RLS read path to** — there is no SQL a logged-in user can run that returns a secret.
2. **Envelope encryption.** Each secret is sealed with a per-secret data key (DEK) under AEAD; DEKs are wrapped by
   a key-encryption key (KEK) held in a managed KMS, never in the repo, env, or a browser-reachable surface.
3. **Server-only secret use.** Decryption happens **only** inside a server-side connector runner, never in a
   request/response path that can reach the browser, never in client code. The client contract is a safe-metadata
   DTO and nothing else.
4. **Re-authorized execution.** Every connector action re-derives the caller's tenant context server-side from the
   JWT and verifies tenant/org membership **and** role (admin/steward) before acting — the runner does not trust a
   client-supplied `tenant_id` and does not run under a blanket service-role.
5. **Auditable, reversible, killable.** Connect/rotate/revoke/sync are append-only audited; secrets are versioned
   and revocable; per-tenant / per-connector / global kill-switches stop execution without a deploy.

Everything below is the detailed form of those five decisions.

## 2. Non-goals

- **Not** implementing the vault, any table, any RLS policy, any encryption code, or any KMS wiring. Conceptual
  only.
- **Not** implementing any connector, OAuth flow, API-key flow, webhook handler, sync job, or provider client.
- **Not** implementing AI, imports, exports, or billing.
- **Not** choosing a final KMS vendor or committing to Supabase Vault vs external KMS — that is an open question
  (§17) to settle in review.
- **Not** a migration. Sequencing (§15) is a *plan*, not a change set.
- **Not** approval to build. See §18.

## 3. Threat model

**Trust boundary.** A request-path actor is an `authenticated` user bound to a tenant via RLS. They are assumed
potentially malicious. The browser is fully untrusted; anything sent to it is considered public. The connector
runner is a *separate* server-side principal, not the user.

Adversary = a malicious authenticated user in **Tenant A**. Each goal and the control that denies it:

| # | Adversary goal | Primary control |
| --- | --- | --- |
| T1 | Read Tenant B connector credentials | Secret store has **no `authenticated` grant + RLS deny-all**; metadata RLS = `is_tenant_member(tenant_id)`; secrets are never in metadata. |
| T2 | Trigger Tenant B connector sync | Runner re-verifies caller membership+role for the *target* connector's tenant server-side; client `tenant_id` never trusted. |
| T3 | Exfiltrate OAuth tokens | Tokens are envelope-encrypted secrets, server-only decrypt, never serialized to client/log/export. |
| T4 | View secrets via browser payload / logs / errors / exports | Client contract = safe-metadata DTO only; log/error redaction deny-list (§11, §20); exports carry metadata only. |
| T5 | Exploit service-role usage | No service-role on request paths (existing `check-auth-safety` gate); runner uses a narrow dedicated identity, never client-reachable. |
| T6 | Replay refresh tokens | Single-flight server-side refresh, refresh-token rotation, old token invalidated on rotate. |
| T7 | Abuse connector callbacks | OAuth `state` is CSRF-bound to initiating user+tenant+connector, single-use, short TTL (§16/§17). |
| T8 | Elevate viewer/editor → admin/steward | Connect/rotate/revoke require admin/steward, checked server-side every action; no client-side-only gate. |
| T9 | Use stale/deleted connector credentials | Versioned secrets + active-version pointer; revoke tombstones + provider-side revoke; runner refuses non-active/revoked. |
| T10 | Poison audit / connector-run records | `audit_logs` append-only (existing `reject_audit_mutation`); run records server-written only, no client write path. |

**Out of scope (named, not solved here):** a compromised KMS root key, a compromised server host with live KEK
access, and a malicious provider. These are residual risks for the incident-response plan (§16 of this doc's
rollout / §24-equivalent) and the open questions, not defended by schema.

## 4. Proposed schema — conceptual only (no migration in this PR)

Conceptual shape only; column names illustrative. **Two tiers**, and the secret tier is deliberately unreadable
from the request path.

**Tier 1 — metadata (RLS-readable, NEVER holds a secret):**
- `connectors` — `id, tenant_id, organization_id?, provider, display_name, status (pending|active|error|revoked|disabled), connected_by, granted_scopes_safe[], last_sync_at, health, created_at, updated_at`. No token, no key, no ciphertext, no key id beyond an opaque non-sensitive handle.
- `connector_runs` — `id, connector_id, tenant_id, status (queued|running|succeeded|failed|canceled|timed_out), started_at, completed_at?, failure_code? (a stable machine code, never a provider message), failure_label? (a short SAFE human label), records_seen?, records_imported?, records_failed?, created_at`. RLS-readable safe metadata only — no secret, no token/key, no raw provider payload. (`provider` is read from the parent `connectors` row, not denormalized onto each run.) Six-state lifecycle + the renamed/added columns ship in migration `0019` (PR D, §28).

**Tier 2 — secrets (NO `authenticated` grant, RLS deny-all, server/KMS path only):**
- `connector_secrets` — `id, connector_id, tenant_id, secret_kind (oauth_access|oauth_refresh|api_key|pat|webhook_signing), version, is_active, ciphertext, dek_wrapped, aead_nonce, aad_digest, expires_at?, created_at, revoked_at?`. The `authenticated` role holds **zero** privileges here; only the connector-runner identity / `SECURITY DEFINER` accessors reach it. Plaintext is never a column.
- `oauth_pending` — short-TTL CSRF/state store. **SUPERSEDED by the stricter §32.3 decision + the shipped `0020` schema (§33): it stores `nonce_hash` (sha256) and NO raw `nonce`, NO raw `state` payload, and NO `pkce_verifier` column** — only `state_jti`/`nonce_hash` + safe metadata (`tenant_id, organization_id?, connector_id?, provider, subject?, intent, expires_at, consumed_at?, created_at, attempt_count, last_rejected_code?`). Server-only; single-use (`UNIQUE(state_jti)`/`UNIQUE(nonce_hash)`); Tier-2 (RLS deny-all + zero `anon`/`authenticated` grant) — no request-path read/write. (The earlier sketch here allowed plaintext `nonce`/`pkce_verifier` at rest; the resolved design hashes the nonce and defers PKCE-verifier handling, so no plaintext secret is stored.)

**Binding.** AEAD additional-authenticated-data (AAD) binds each ciphertext to `{tenant_id, connector_id,
secret_kind, version}` so a row copied/replayed into another tenant or kind fails to decrypt — a structural defense
against confused-deputy and T1/T9.

## 5. RLS policy model — conceptual only

- **Tier 1 tables:** `SELECT` policy = `is_tenant_member(tenant_id)` (the existing, proven helper). `INSERT/UPDATE`
  for connect/rotate/revoke gated to admin/steward via a `can_admin_connector(tenant_id)` predicate (membership +
  role), `WITH CHECK` forbidding `tenant_id` reassignment (same discipline as the `0016` uploader-finalize policy).
- **Tier 2 (`connector_secrets`, `oauth_pending`):** RLS **enabled and deny-all to `authenticated`**, and the role
  is **`REVOKE`d** of `SELECT/INSERT/UPDATE/DELETE` — defense in depth so neither a policy gap nor a grant gap
  alone exposes a secret. Reached only by the runner identity or `SECURITY DEFINER` functions that themselves
  re-check authorization. **Lesson from `0016`:** prefer `REVOKE`+narrow `GRANT` for privilege *changes* (`GRANT
  (col)` is additive) and **assert the privilege surface** (`has_table_privilege`/`has_column_privilege`) in the
  RLS suite for these security-critical tables.
- Cross-tenant metadata reads stay impossible (T1) because Tier-1 RLS is `is_tenant_member`; secret reads are
  impossible because Tier-2 has no authenticated path at all.

## 6. Server-side secret access model

- A single server-only module (Edge/server function) owns decrypt/encrypt. It is **never imported by client
  components** and is covered by `check-auth-safety` (which already forbids service-role/admin clients in `src/`
  request paths). Secrets exist in process memory only for the duration of one provider call and are never
  returned up the stack to a serializable boundary.
- **Least privilege (T5).** The runner authenticates to the secret store / KMS with its **own** narrow identity,
  scoped to the vault operations it needs — not a blanket `service_role`. If any elevated DB access is
  unavoidable, it is a `SECURITY DEFINER` function with a hard-coded, tested authorization check inside, never a
  service-role key handed to request code, never reachable from the browser.
- The decrypt boundary returns a *used result* (e.g. "sync completed, N items") to the request path — **never the
  secret**.

## 7. OAuth flow requirements

- **Authorization-code + PKCE.** Server generates a random `state` (CSRF, T7) and, where applicable, `nonce`
  (OIDC) and PKCE `code_verifier`, persists them in `oauth_pending` keyed to `{initiated_by, tenant_id, provider}`
  with a short TTL, and redirects.
- **Callback validation (T7, §16).** On return: look up `state`; reject if missing/expired/already-consumed; bind
  the result to the *original* user+tenant from `oauth_pending` (never from a client-supplied tenant); verify
  `nonce`/PKCE; mark `state` consumed (single-use).
- **Token storage (T3).** Exchange happens server-side; access+refresh tokens are written as Tier-2 secrets
  (encrypted), `granted_scopes_safe[]` (non-sensitive subset) copied to Tier-1 metadata for display.
- **Refresh/expiry (T6, §8).** Store `expires_at`; refresh server-side ahead of expiry under a **single-flight**
  lock per connector to avoid concurrent-refresh replay; rotate the refresh token on use and invalidate the prior.

## 8. API key / PAT flow requirements

- **Write-only from the user's view.** The key is submitted once over the authenticated server path, written
  straight to Tier-2 encrypted, and **never readable back**. UI shows only a label + last-4 (a non-reversible
  hint), never the value.
- Validation (a test call) happens server-side at connect time; only pass/fail + an error *class* returns to the
  client. Same envelope-encryption, AAD-binding, versioning, and revocation as OAuth secrets.

**Webhook validation (design point 18).** For connectors with inbound webhooks, the per-connector `webhook_signing`
secret is a Tier-2 secret (§4). Inbound requests are validated server-side: **constant-time HMAC compare over the
raw request body** against the stored signing secret; a **bounded timestamp tolerance window** plus a **replay
cache keyed by `{signature, timestamp}` in a server-only (non-RLS-readable, deny-all) store** rejects replays
(T7-adjacent). The target tenant is resolved **only** from the verified payload, never from unauthenticated input.
Until the §17 open questions (which providers, exact header, window, cache backend) are resolved, **no
`webhook_signing` secret is stored and no webhook endpoint is implemented** — webhooks stay out of scope.

## 9. Connector run lifecycle

Six-state lifecycle (migration `0019`, §28): `queued → running → {succeeded | failed | timed_out}`, with
`queued | running → canceled`; the four terminal states (`succeeded/failed/canceled/timed_out`) have no outgoing
transition. Each transition is server-written to `connector_runs` with timestamps + safe counters + a machine
`failure_code` and safe `failure_label` only (no secret, no provider payload). Runs are **rate-limited** per connector/tenant (T2 abuse, cost); the **rate-limit counter is
server-side state** (runner identity / a deny-all store), **never an `authenticated`-writable Tier-1 column**, and
is enforced inside the runner **before any secret is touched** — so a malicious tenant cannot reset or inflate it. Manual sync requires admin/steward;
the runner re-verifies membership+role for the run's tenant before touching secrets (T2). A run that fails records
a `failure_code` (a stable machine code, e.g. `auth_expired`, `provider_5xx`, `rate_limited`) + a short safe
`failure_label` — **never** a raw provider message or token.

## 10. Auditing

Reuse the existing **append-only** `audit_logs` (`reject_audit_mutation`, `0002`) — no new mutable audit surface.
Audited events: `connector.connected / rotated / revoked / disabled / enabled`, `connector.sync.started /
finished`, `connector.secret.refreshed`. Each records actor, tenant, connector id, action, timestamp — and the
**minimal** safe shape the `/audit` DTO already enforces (no `before_json`/`after_json` secret values, no token, no
key). Audit can confirm *that* a secret rotated, never *what* it was. Records are server-written only (T10).

## 11. Logging and redaction

- Structured logs only; a **deny-list** of secret-bearing field names (token, refresh_token, access_token,
  api_key, pat, ciphertext, dek, kek, code_verifier, nonce, client_secret, signing_secret, authorization, cookie)
  is redacted before emit. Decrypted material is **never** logged. Log **identifiers** (connector id, run id), never
  values. A test scans sample log lines for secret-shaped content.

## 12. Browser / client contract

The client may receive **only** safe metadata: connector name, provider, status, last sync time, non-sensitive
granted scopes, connected-by display (if safe), health/status. **What must never be returned to client (T3/T4):**
raw or refresh tokens, API keys/PATs, encrypted blobs, decrypted secrets, DEK/KEK or any key material, storage
paths, service-role context, callback/`state`/signing secrets, and any internal id that is sensitive. The DTO is
the only contract; a test asserts it carries no secret-shaped field (the same discipline as the files/dashboard
DTO no-leak tests).

## 13. Roles and permissions

- **viewer / editor:** read safe connector metadata only. No connect/rotate/revoke/sync.
- **admin / connector-steward:** connect, rotate, revoke, disable/enable, trigger sync. (Whether "steward" is a
  distinct role or just `admin` is an open question, §17.)
- Every privileged action is authorized **server-side** against membership + role (T8); there is no client-side
  authorization. Role is read from the resolved tenant context, never from a client claim.

## 14. Test plan

- **RLS / privilege:** cross-tenant metadata read denied (Tenant A cannot read Tenant B connectors); `authenticated`
  has **no** privilege on `connector_secrets`/`oauth_pending` (assert via `has_table_privilege`); these become new
  assertions in `org_rls_test.sql` (currently 248).
- **No-leak DTO:** connector/run DTOs contain none of the §12 forbidden fields (string-scan test, like
  files/dashboard tests).
- **OAuth:** callback rejects missing/expired/replayed `state`; binds to initiating tenant; PKCE/nonce enforced.
- **Webhook (§18-flow):** HMAC verification + timestamp anti-replay; bad signature rejected.
- **Roles:** viewer/editor denied connect/rotate/revoke; admin/steward allowed.
- **Rotation/revocation/expiry:** active-version pointer; revoked/stale secret refused by runner (T9); single-flight
  refresh (T6).
- **Redaction:** logs/errors carry no secret-shaped content.

## 15. Migration sequencing — plan only (no migration here)

0. **This design reviewed + accepted** (gate — nothing below starts otherwise).
1. Tier-1 metadata + RLS + `connector_runs` + audit event wiring. No secrets yet.
2. Tier-2 secret store + KMS/envelope + server runner skeleton + `oauth_pending`; **`REVOKE` broad, `GRANT`
   narrow**, and add the privilege-surface assertions to the RLS suite (the `0016`/T37 lesson). No providers.
3. One low-risk identity provider behind a feature flag, staging-only, human-verified.
4. Reconcile, then consider a second provider. Each step cites its doc 27 row, carries RLS tests + hosted staging
   validation + evidence, and **ticks no doc 17 §5 box on its own**.

## 16. Rollout plan

Staging-first (`ycdpzduxugdsffjqyoai`), never production (`dzbfxulvxchdemcettrx`) until accepted + the doc 17 §5
cutover gate. Feature-flagged; one connector at a time; a human runs the hosted verification (an agent never seeds
staging, runs hosted commands, or creates hosted users). **Incident response / kill-switch:** a per-connector,
per-tenant, and global execution kill-switch (config flag, no deploy) halts sync; mass-revoke + KEK-rotation/re-wrap
playbook for suspected compromise; revoke calls the provider's revoke endpoint best-effort and always tombstones
locally so a stale credential is unusable (T9).

## 17. Open questions

- ~~**KMS choice:** Supabase Vault (pgsodium) vs external cloud KMS for the KEK~~ — **RESOLVED in §32.1**: external managed KMS (default AWS KMS / GCP KMS) holds the KEK; Supabase Vault rejected for the KEK. (The OAuth-signer-secret, local-dev-secret, and `oauth_pending` replay-store questions are also resolved in §32.)
- **Steward role:** distinct `connector-steward` role vs reuse `admin` (affects the role taxonomy + RLS predicates).
- **Scope granularity:** per-tenant vs per-organization connector ownership (`organization_id` optional in §4).
- **Webhook providers:** which connectors need inbound webhooks → HMAC signing-secret storage + per-provider
  validation; timestamp window + replay cache details.
- **Refresh concurrency:** single-flight implementation (advisory lock vs row lock) under the runner's identity.
- **RISK-007 linkage:** this design is the precondition; acceptance criteria for closing RISK-007's vault
  prerequisite need to be written against §14's tests.

## 18. NOT approved to implement yet

**Connector credential vault design is drafted but not implemented. Connector implementation remains blocked until
the vault design is reviewed and accepted.** No connector credentials are stored by this PR. No connector sync is
implemented by this PR. No production data was touched. No hosted commands were run. No migrations were added. No
RLS policies were changed. No service-role access was added. **Connectors remain not built. AI / Analysis remains
not built. Imports remain not built. Exports remain not built. Billing remains not built. Old-app parity is not
complete. UI/UX parity is not complete. AI/API connector parity is not complete. Upload is not automatically
production-ready. Hosted Auth/tenant-context is verified, but old-app replacement is not yet verified. RISK-001
remains OPEN. Cutover remains BLOCKED.** No doc 17 §5 box is ticked by this design PR.

---

## 19. Design acceptance status (PR #100)

**Connector credential vault design is accepted as the design baseline.** The §1–§18 design is the agreed shape
that all future vault work builds against — changing it requires a documented design revision, not an ad-hoc
implementation choice. **The vault is not implemented. Connectors remain not built. No connector credentials are
stored. No connector sync is implemented.** Acceptance of the *design* is **not** acceptance of any *code*:
**implementation must proceed in gated PRs** (§20), each gate cleared before the next begins. **It is not
connector-ready.** **Connector implementation remains blocked until the gated vault implementation PRs are
complete.** **No production data was touched. No hosted commands were run. No migrations were added. No RLS
policies were changed. No service-role access was added.**

## 20. Implementation sequence (gated PRs — none of these exist yet)

Each PR is separate, reviewed, and merged only after the prior gate passes. No PR may bundle a later step.

- **PR A — Vault schema migration, no execution path.** Creates the conceptual §4 tables (metadata Tier-1 +
  secret Tier-2) as a migration with **REVOKE broad + GRANT narrow** on the secret tables. **No decrypt/encrypt
  code, no runner, no provider, no UI** — schema only.
- **PR B — RLS + deny-all secret tests.** Adds `org_rls_test.sql` assertions: cross-tenant metadata read denied;
  `authenticated` has **no** privilege on `connector_secrets`/`oauth_pending` (`has_table_privilege`); Tier-1
  admin/steward write gating. The suite must be green before any access wrapper exists.
- **PR C — Server-only vault access wrapper + no-browser-import guard.** A server-only encrypt/decrypt module with
  a build/lint guard (extend `check-auth-safety`) proving it is never imported by client code. **Encryption
  wrapper tests pass before any secret of any kind is stored** (OAuth token, API key, PAT, or webhook secret).
- **PR D — Audit/run lifecycle tables or model.** `connector_runs` + the audit event wiring (reuse append-only
  `audit_logs`), server-written only, with tests. Required before any sync.
- **PR E — Connector metadata UI only.** Read-only safe-metadata DTO + page (name/provider/status/last-sync), the
  §12 no-secret-in-DTO test. **No connect/sync action.**
- **PR F — OAuth callback skeleton with state/nonce validation, no provider token storage until tested.** The
  `oauth_pending` CSRF/state/nonce/PKCE flow + callback validation, with tests — **no provider access/refresh
  token is stored until the §14 encryption + callback tests pass.**
- **PR G — First low-risk connector, only after vault tests and audit pass.** One identity provider behind a
  feature flag, staging-only, human-verified, citing its doc 27 row + RLS tests + hosted evidence; ticks no doc 17
  §5 box.

## 21. Do not skip (hard gates)

- **No connector credentials before vault schema + deny-all tests** (PR A + PR B green).
- **No connector secret of ANY kind stored before encryption-wrapper tests** (PR C green) — this covers OAuth
  access/refresh tokens **and** API keys, PATs, and webhook signing secrets (all are envelope-encrypted Tier-2
  secrets per §4/§8, so all require the PR C encrypt/decrypt wrapper, not just OAuth tokens).
- **No connector credential write or sync before the run/audit model** (PR D green) — §10 audits connect/rotate/
  revoke, not only sync, so the audit/run model precedes every audited credential action.
- **No browser exposure of secrets ever** — the client contract is the safe-metadata DTO; secrets never serialize
  to props/HTML/JSON/RSC/logs/errors/exports.
- **No production credential migration before staging verification** — staging-first (`ycdpzduxugdsffjqyoai`),
  human-verified, never production (`dzbfxulvxchdemcettrx`) until accepted + the doc 17 §5 gate.

## 22. Open questions before implementation

These must be resolved (in the relevant gated PR's design note) before that step proceeds: **KMS provider and key
management**; **envelope-encryption library**; **local dev secret handling** (no real secrets in repo/CI);
**rotation UX**; **revocation UX**; **provider-specific OAuth callback routing**; **audit retention**; **rate-limit
store** (server-side, non-client-writable, per §9).

## 23. Acceptance does NOT mean

Accepting this design baseline **does not approve implementation**; **does not approve production**; **does not
close RISK-001**; **does not approve cutover**; **does not permit connector sync**. **RISK-001 remains OPEN. Cutover
remains BLOCKED. Old-app parity is not complete. UI/UX parity is not complete. AI/API connector parity is not
complete. Upload is not automatically production-ready. Hosted Auth/tenant-context is verified, but old-app
replacement is not yet verified.** No doc 17 §5 box is ticked by this acceptance.

## 24. Implementation progress — PR A landed (schema foundation, migration `0017`)

**Connector vault schema foundation is added.** Migration `0017_connector_vault_schema_foundation.sql` creates the
§4 tables — **`public.connectors`** (Tier-1 metadata) + **`public.connector_runs`** (Tier-1 safe run summaries) +
**`public.connector_secrets`** (Tier-2 secret material) — with the §5 RLS/grant posture. Audit reuses the existing
append-only `audit_logs` (§10), so no separate audit table. This is the §20 **PR A** step (schema migration, no
execution path) shipped together with its **PR B** deny-all RLS tests (the schema is not merged untested):
`org_rls_test.sql` **T38** (Tier-1 tenant-member read + no request-path write) + **T39** (Tier-2 deny-all at the
runtime AND privilege-surface layer + the no-secret-column structural check); suite **248 → 292**.

**Connector vault is still not usable.** **Connector secret material is not readable by authenticated users** —
`connector_secrets` is RLS-enabled with **zero policies** (default deny-all) and `authenticated`/`anon` hold **zero
privilege** (T39 proves it three ways: runtime denial, `has_table_privilege`, and an exact-zero-privileges
invariant; `test-rls.sh` re-asserts the revoke after its blanket-grant crutch so the suite reflects the real hosted
surface — the `0015`/`0016` masking lesson). The Tier-1 metadata tables are tenant-member **READ-only** (no INSERT/
UPDATE/DELETE policy or grant — the connect/rotate/revoke write path is a later gated PR). Same-tenant integrity is
enforced at the constraint layer (composite `(connector_id, tenant_id)` FKs, the `0005` pattern), not merely by RLS.

**Connector implementation remains blocked.** **No connector credentials are stored. No connector sync is
implemented. No encryption/decryption wrapper is implemented. No provider connector is implemented. No OAuth
callback is implemented. No connector UI is implemented. No service-role request path is added.** The remaining
gates are unchanged: **next is PR C** (server-only encrypt/decrypt wrapper + no-browser-import guard) — no secret of
any kind may be stored until its tests pass (§21). **No production data was touched. No hosted commands were run. A
human must apply `0017` to staging, then production, in a future step (an agent never runs hosted commands).
RISK-001 remains OPEN. Cutover remains BLOCKED. Old-app parity is not complete. UI/UX parity is not complete. AI/API
connector parity is not complete. Upload is not automatically production-ready. Hosted Auth/tenant-context is
verified, but old-app replacement is not yet verified.** No doc 17 §5 box is ticked by this PR.

## 25. Hardening — connector vault metadata/run grants, migration `0018` (PR #102)

**Staging verification of 0017 found broad metadata/run table grants that must be hardened before the connector
sequence continues.** A human applied `0017` to staging (`ycdpzduxugdsffjqyoai`) and found that, while
`connector_secrets` was correct (RLS enabled, zero policies, no `anon`/`authenticated` privilege), the Tier-1
tables `connectors` and `connector_runs` carried broad `anon`/`authenticated` grants —
`INSERT/UPDATE/DELETE/TRUNCATE/REFERENCES/TRIGGER/SELECT`. Root cause: `0017` did `grant select` but **never
`revoke`d**, so hosted Supabase's default broad grants on new `public` tables survived (`0015`/`0016` masking
lesson — and the local `test-rls.sh` re-assert had only revoked `insert/update/delete/truncate`, not
`REFERENCES/TRIGGER`, so the suite masked it too).

**Connector secret material remained inaccessible to anon and authenticated users.** Throughout, the bug was only
on the Tier-1 metadata/run tables, never the secret tier. **Connector metadata/run grants are being hardened to
least privilege:** migration `0018_harden_connector_vault_grants.sql` does `revoke all` from `anon` +
`authenticated` on **all three** vault tables, then `grant select` back to `authenticated` on `connectors` +
`connector_runs` only. After `0018` the `authenticated` surface is EXACTLY `connectors=SELECT`,
`connector_runs=SELECT`, `connector_secrets=(none)`; `anon=(none)` everywhere — **no
INSERT/UPDATE/DELETE/TRUNCATE/REFERENCES/TRIGGER for any request-path role**. No write policy is added.
`service_role` (trusted, never a request path) is untouched. Idempotent (re-applicable to the staging project that
already holds the broad grants). Proven by `org_rls_test.sql` **T40** (exact per-role privilege arrays +
TRUNCATE/REFERENCES/TRIGGER negatives + tenant-scoped SELECT still works + cross-tenant SELECT still RLS-denied);
the harness re-assert now mirrors `0018` (`revoke all` + `grant select`) so the suite reflects the REAL hosted
surface; suite **292 → 318**. `0018` is privilege-only — no table/column/policy/index change, no function, no
encryption, no service-role path. **Future-build lesson reinforced: a new table migration must `REVOKE` the
hosted-default grants then `GRANT` narrow — `grant select` alone leaves the broad default grants in place — and
the harness re-assert + an EXACT per-role privilege-array test (incl. REFERENCES/TRIGGER) must cover every new
table or the masking recurs.**

**Connector vault is still not usable. Connector implementation remains blocked. No connector credentials are
stored. No connector sync is implemented. No encryption/decryption wrapper is implemented. No provider connector is
implemented. No OAuth callback is implemented. No connector UI is implemented. No service-role request path is
added. No production data was touched. No hosted commands were run by the agent** (a human re-applies `0018` to
staging, then production, in a future step). Next gate is still **PR C** (server-only encrypt/decrypt wrapper).
**Old-app parity is not complete. UI/UX parity is not complete. AI/API connector parity is not complete. Upload is
not automatically production-ready. Hosted Auth/tenant-context is verified, but old-app replacement is not yet
verified. RISK-001 remains OPEN. Cutover remains BLOCKED.** No doc 17 §5 box is ticked by this PR.

## 26. Staging verification — `0018` grant hardening (PR #103)

**Connector vault grant hardening has been applied and verified on staging.** A human applied `0018` to the
staging project `ycdpzduxugdsffjqyoai` (`db push`) and queried the live privilege + policy surface. **Migration
0018 is present on staging** (the remote migration list shows `0018` after `db push`). **The agent ran nothing —
no hosted command, no staging mutation, no secrets. No production data was touched.**

### 26.1 Observed — PASS
The live `information_schema` table-privilege query returned **exactly two rows**:

| grantee | table | privilege |
| --- | --- | --- |
| `authenticated` | `connector_runs` | `SELECT` |
| `authenticated` | `connectors` | `SELECT` |

— no `anon` rows, no `connector_secrets` rows, and **no `INSERT`/`UPDATE`/`DELETE`/`TRUNCATE`/`REFERENCES`/`TRIGGER`
grant for `anon` or `authenticated`** on any connector vault table. `pg_policies` returned exactly the two
tenant-member SELECT policies (`connectors` → "members read tenant connectors", SELECT; `connector_runs` →
"members read tenant connector runs", SELECT); **`connector_secrets` had no policies.** The linked ref remained
`ycdpzduxugdsffjqyoai`.

So, confirmed live: **Connector metadata tables expose authenticated SELECT only. Connector secret material remains
inaccessible to anon and authenticated users. Anon has no connector vault table privileges. No broad INSERT,
UPDATE, DELETE, TRUNCATE, REFERENCES, or TRIGGER grants remain on connector vault tables for anon or
authenticated.** This matches the migration `0018` intent + the local `org_rls_test.sql` T40 exact-privilege-array
proof — the broad hosted-default grants `0017` left in place are gone, and the secret tier was never exposed.

### 26.2 Scope / guardrails
This verifies only the `0018` grant surface on staging — not any connector behavior (there is none). **Connector
vault is still not usable. Connector implementation remains blocked. No connector credentials are stored. No
connector sync is implemented. No encryption/decryption wrapper is implemented. No provider connector is
implemented. No OAuth callback is implemented. No connector UI is implemented. No service-role request path is
added. No production data was touched.** A human re-applies `0018` to production in a future step (an agent never
runs hosted commands); next gate is still **PR C** (server-only encrypt/decrypt wrapper). **Old-app parity is not
complete. UI/UX parity is not complete. AI/API connector parity is not complete. Upload is not automatically
production-ready. Hosted Auth/tenant-context is verified, but old-app replacement is not yet verified. RISK-001
remains OPEN. Cutover remains BLOCKED.** No doc 17 §5 box is ticked by this verification.

## 27. Implementation — PR C: server-only crypto wrapper (PR #104)

**Server-only connector vault crypto wrapper is implemented and tested.** This is the §20 **PR C** gate, the
reviewed envelope-encryption boundary the §21 hard gates require **before any connector secret of any kind may be
stored**.
`src/lib/server/connector-vault/crypto.ts` exposes `encryptConnectorSecret` / `decryptConnectorSecret` over an
**injected `ConnectorVaultKeyProvider`** (the KMS abstraction: `generateDataKey(kekId)` / `unwrapDataKey`). It is
pure AEAD — **no database access, no Supabase client import, no service-role, no `process.env`** (a test asserts
the module's only import is `node:crypto`).

**Crypto.** AES-256-GCM (authenticated encryption); per-secret DEK wrapped by the provider's KEK (envelope, §1.2);
the structured payload is `{ v, alg, kekId, wrappedDek, iv, ciphertext, tag, aadDigest }` (maps to
`connector_secrets` `ciphertext`/`dek_wrapped`/`aead_nonce`/`aad_digest` later). **AAD binds
`{tenant_id, connector_id, secret_kind, version}`** (§4) — decryption fails closed if any of them changes;
plaintext is returned **only** from `decryptConnectorSecret`. The DEK is zeroed after use; errors are typed
`ConnectorVaultCryptoError` with fixed, safe messages (no plaintext / ciphertext / key bytes — §11).

**Server-only boundary (§6).** The module lives under `src/lib/server/`, carries a runtime sentinel that throws if
evaluated in a browser, and a **static guard test** (`no-client-import.test.ts`) asserts no `"use client"` file
and nothing under `src/app` imports it. **The wrapper uses test-only key material in tests only.** An in-memory
`KeyProvider` defined inside the test file (random KEKs, never persisted, never an env secret, no checked-in key)
**no real KMS is integrated in this PR.** +19 tests: round-trip; ciphertext ≠ plaintext and contains no plaintext;
tenant/connector/kind/version-swap each fail; tampered ciphertext / tag fail; wrong KEK id fails; errors carry no
plaintext; input validation; all five secret kinds round-trip; module purity + server-only guards.

**No credential is stored or moved by this PR.** **No real connector credentials are stored. No connector secret
material is inserted, updated, or deleted. No connector sync is implemented. No provider connector is implemented.
No OAuth callback is implemented. No connector UI is implemented. No service-role request path is added. No
production data was touched. No hosted commands were run.** No migration; RLS suite unchanged (318); types 0-diff.
**Connector vault is still not usable for real credentials until the remaining gated PRs are complete.** The
remaining gates are PR D audit/run model → PR E metadata UI → PR F OAuth callback → PR G first connector. **Connector implementation
remains blocked. Old-app parity is not complete. UI/UX parity is not complete. AI/API connector parity is not
complete. Upload is not automatically production-ready. Hosted Auth/tenant-context is verified, but old-app
replacement is not yet verified. RISK-001 remains OPEN. Cutover remains BLOCKED.** No doc 17 §5 box is ticked by
this PR. (Open question §17 deferred: the real KMS provider + local-dev secret handling are still to be chosen.)

## 28. Implementation — PR D: connector run/audit lifecycle foundation (PR #105)

**Connector run/audit lifecycle foundation is added.** This is the §20 **PR D** gate, the safe run/audit model that
must exist before any connector execution or credential storage. **No connector execution is implemented. No provider
connector is implemented.** It is two pieces — a narrow schema widening + a pure server-only model — and nothing
that runs a connector.

**Schema (migration `0019_connector_run_audit_lifecycle.sql`).** Widens the existing `connector_runs` (`0017`) to
the safe run-lifecycle shape: the **six states** `queued / running / succeeded / failed / canceled / timed_out`
(was a 4-state `success` check — there are zero rows, so `success → succeeded` is a free rewrite); renames
`finished_at → completed_at`, `items_seen → records_seen`, `error_class → failure_code`; and adds
`records_imported`, `records_failed` (non-negative counters) + `failure_label` (a short SAFE human label). **Safe
metadata only — no secret, no token/key, no raw provider payload** (the §39/T39 "connector_runs holds no secret
column" invariant still holds). **Grants UNCHANGED:** `connector_runs` keeps the `0018` least-privilege surface —
`authenticated` = `[SELECT]` only (new columns inherit it), `anon` = none, and **no write policy is added** (run
writes remain future server-only/runner work, never a request-path write). Audit reuses the existing **append-only
`audit_logs`** (`reject_audit_mutation`, `0002`) — **no new connector audit table.** No `connector_secrets` change.

**Model (`src/lib/server/connector-vault/run-lifecycle.ts`, server-only, PURE).** Typed lifecycle: the six run
states + terminal set + the only valid transitions (`assertValidRunTransition` / `isValidRunTransition`); the
conceptual audit actions `connector.run.created / .started / .completed / .failed / connector.credential.created /
.revoked`; and pure builders `buildConnectorRunRecord` / `buildConnectorAuditEvent` that **validate then return the
safe shape a future runner would persist — performing NO database write.** A redaction guard
(`assertNoSecretFields` + a credential-value check + `assertSafeFailureLabel`) **rejects any secret-shaped field
name or credential-shaped value** (token/secret/key/refresh/authorization/cookie/ciphertext/…, and JWT/`ghp_`/
`sk-`/`Bearer`-shaped values). The module has **NO imports** (pure TS — no DB, no Supabase, no service-role, no
`process.env`; a test asserts it), a runtime browser sentinel, and the `no-client-import.test.ts` guard now covers
it too (no `"use client"` / `src/app` file imports it).

**Tests** (+16 app tests, 136 → 151; RLS suite **318 → 327** via **T41**): lifecycle state + transition validation;
safe-error-labels-only; secret-shaped field/value rejection in run + audit metadata; module purity + server-only
guard; **T41** proves the six states are accepted + an out-of-set status rejected + the renamed/added safe columns
present (old names gone) + no secret column + the grant shape unchanged (`authenticated [SELECT]` only, `anon`
none, no write policy, audit still reuses `audit_logs`) + the request-path role still cannot write a run. Types
regenerated.

**No connector credentials are stored. No connector secret material is inserted, updated, or deleted. No connector
sync is implemented. No OAuth callback is implemented. No connector UI is implemented. No service-role request path
is added. No production data was touched. No hosted commands were run.** A human applies `0019` to staging then
production in a future step (an agent never runs hosted commands); next gate is **PR E** (connector metadata UI,
read-only) → PR F OAuth callback → PR G first connector. **Connector vault is still not usable for real credentials
until the remaining gated PRs are complete. Connector implementation remains blocked. Old-app parity is not
complete. UI/UX parity is not complete. AI/API connector parity is not complete. Upload is not automatically
production-ready. Hosted Auth/tenant-context is verified, but old-app replacement is not yet verified. RISK-001
remains OPEN. Cutover remains BLOCKED.** No doc 17 §5 box is ticked by this PR.

## 29. Staging verification — `0019` run/audit lifecycle (PR #107)

**Connector run/audit lifecycle migration 0019 has been applied and verified on staging.** A human applied `0019`
to the staging project `ycdpzduxugdsffjqyoai` and queried the live schema + privilege/policy surface. **The agent
ran nothing — no hosted command, no staging mutation, no secrets. No production data was touched.**

### 29.1 Observed — PASS
The remote migration list showed `0019` **absent** before push; `supabase db push --linked` applied
`0019_connector_run_audit_lifecycle.sql`; the list then showed `0019` **present** on Remote. The linked project ref
remained `ycdpzduxugdsffjqyoai`. The live `connector_runs_status_check` query returned the six lifecycle states —
**`connector_runs` supports queued, running, succeeded, failed, canceled, and timed_out.** The table-privilege
query returned **exactly two rows** — `authenticated | connector_runs | SELECT` and `authenticated | connectors |
SELECT` — with **no anon rows and no connector_secrets rows**: **Connector metadata tables expose authenticated
SELECT only. Anon has no connector vault table privileges. Connector secret material remains inaccessible to anon
and authenticated users. No broad INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, or TRIGGER grants remain on
connector vault tables for anon or authenticated.** `pg_policies` returned exactly the two tenant-member SELECT
policies (`connectors` → "members read tenant connectors", SELECT; `connector_runs` → "members read tenant
connector runs", SELECT); **`connector_secrets` has no policies.** This matches the `0019` intent + the local
`org_rls_test.sql` T41 proof — the six-state lifecycle landed and the `0018` least-privilege surface is intact.

### 29.2 Scope / guardrails
This verifies only the `0019` schema + grant/policy surface on staging — not any connector behavior (there is
none). **Connector vault is still not usable. Connector implementation remains blocked. No connector credentials
are stored. No connector sync is implemented. No provider connector is implemented. No OAuth callback is
implemented. No connector UI is implemented. No service-role request path is added. No production data was
touched.** A human re-applies `0019` to production in a future step (an agent never runs hosted commands); next
gate is still **PR E** (read-only connector metadata UI). **Old-app parity is not complete. UI/UX parity is not
complete. AI/API connector parity is not complete. Upload is not automatically production-ready. Hosted
Auth/tenant-context is verified, but old-app replacement is not yet verified. RISK-001 remains OPEN. Cutover
remains BLOCKED.** No doc 17 §5 box is ticked by this verification.

## 30. Implementation — PR E: read-only connector metadata UI (PR #108)

**Read-only connector metadata UI is added.** The §20 **PR E** gate — the first connector *surface*, a
read-only page that displays **only safe Tier-1 connector and connector run metadata**. It adds NO write, NO
credential path, NO provider/OAuth/sync code. **Connector secret material is not queried or displayed.**

**Route + nav.** A new authenticated route `/connectors` (route count 16 → 17) + the nav "Connectors" item
flipped from "Not built yet" to `/connectors` (`IMPLEMENTED_ROUTES` gains it; the nav test now asserts it is
linkable). Mirrors the existing read-only surfaces (`/files`, `/reports`, `/admin`): user-scoped client, RLS
is the authority, fail-closed with a safe label.

**Data (`src/lib/data/connectors.ts`, server-only, READ-ONLY).** `listConnectorsForCurrentUser()` does two
RLS-scoped reads of the **Tier-1 metadata tables only** — `connectors` (safe subset: `id, provider,
display_name, status, granted_scopes_safe, created_at, updated_at`) + `connector_runs` (safe subset:
`status, started_at, completed_at, failure_code, failure_label, records_seen/imported/failed`, latest run per
connector). It **NEVER queries `connector_secrets`** and **never selects** `tenant_id`, `organization_id`,
`connected_by`, `health`, or `last_sync_at`. No service-role, no admin client, no write. A failed connectors
read **fails closed** (`{ ok: false }` → a safe "could not load" label); a failed runs read is non-fatal
(connectors still list with `lastRun = null`).

**Page (`/connectors`).** Renders only the safe DTO: provider, label, status, safe scopes, latest-run
status/date/safe label, created date — plus an empty state ("No connectors to show") and an explicit
**"Not built yet"** section for: connecting a provider, storing credentials, OAuth callback, API key / PAT
entry, run sync, provider connectors, disconnect / revoke, manual run, scheduled run, and real connector
health. No credential form, no connect/reconnect/disconnect button, no sync button.

**Tests** (+7 app tests, 151 → 158; build 16 → 17 routes; RLS suite unchanged **327**, no migration): empty
state, fail-closed, the safe-DTO projection with every forbidden column (`tenant_id`/`organization_id`/
`connected_by`/`health`/`last_sync_at`) provably absent, latest-run selection, non-fatal runs failure, the
pure status helpers, the nav "Connectors is linkable" assertion, and a **static source scan** proving the
page + data code contain no `connector_secrets` query and no secret-shaped column string (`ciphertext`,
`dek_wrapped`, `aead_nonce`, `*_token`) and read only `connectors`/`connector_runs`. Types 0-diff.

**No connector credentials are stored. No connector sync is implemented. No provider connector is implemented.
No OAuth callback is implemented. No credential form is implemented. No connect/reconnect/disconnect action is
implemented. No manual or scheduled run action is implemented. No service-role request path is added. No
production data was touched. No hosted commands were run. Connector vault is still not usable for real
credentials until the remaining gated PRs are complete** (next: PR F OAuth callback skeleton → PR G first
connector). **Connector implementation remains blocked. Old-app parity is not complete. UI/UX parity is not
complete. AI/API connector parity is not complete. Upload is not automatically production-ready. Hosted
Auth/tenant-context is verified, but old-app replacement is not yet verified. RISK-001 remains OPEN. Cutover
remains BLOCKED.** No doc 17 §5 box is ticked by this PR.

## 31. Implementation — PR F: OAuth callback validation skeleton (PR #109)

**OAuth callback skeleton is added. OAuth state/nonce validation is implemented.** The §20 **PR F** gate — the
CSRF/replay validation infrastructure (docs/42 §7/§16) that must exist BEFORE any provider is wired. It is
PURE validation only: **no OAuth code is exchanged for tokens, no access token is stored, no refresh token is
stored, no `connector_secrets` is read or written, no provider is contacted.** The vault stays NOT usable for
real credentials.

**State model (`src/lib/server/connector-vault/oauth-state.ts`, server-only, PURE — only import is
`node:crypto`).** A stateless, **HMAC-SHA256-signed** `state` binds the callback to `{tenant_id, provider,
connector_id?, subject?, redirect_intent, nonce, exp}`. `createOAuthState(ctx, {signer, ttlSeconds, now})`
mints it; `validateOAuthState(state, expectedContext?, {signer, now, consumedNonces?})` verifies the HMAC
over the exact signed bytes **before trusting any field** (constant-time compare), then checks
nonce-presence, expiry, optional tenant/provider/connector binding, and optional single-use replay. It
returns a typed result with a **safe reason CODE** (`bad_signature` / `tenant_mismatch` / `expired` /
`missing_nonce` / `replayed` / …) — **never** a secret, nonce, token, code, or provider payload. The signing
key is held by an **injected signer** (`OAuthStateSigner`; a server-only secret / KMS in production — NOT in
this PR; a test-only in-memory HMAC signer in tests). The module is server-only (runtime browser sentinel +
the `no-client-import` guard) and reads NO `process.env`.

**Replay model.** Single-use replay rejection is supported via an injected `ConsumedNonceStore`; an in-memory
store is used in tests. The **production replay store (the DB-backed single-use `oauth_pending`, §4/§16)
remains a gate** — this PR does not add it (no DB write), so a real deployment must wire it before relying on
single-use semantics.

**Inert callback route (`/connectors/oauth/callback`, route count 17 → 18).** A server-only route handler
that parses `provider/code/state/error`, builds the signer from a **server-only env secret that this PR does
not set** (so the signer is `null` and every callback is inert "not configured" by default), calls the pure
`handleOAuthCallback`, and returns a **safe plain-text inert response** (`no-store`). It **never exchanges the
`code`** (the value is never read, returned, or logged), never calls a provider endpoint, never writes
`connector_secrets`, never marks a connector connected, and never persists the query params. Outcomes:
`provider_error` (a `?error=` from the provider — its value is never surfaced), `not_configured` (default),
`invalid` (bad/missing/expired/tampered state → 400), `received` (valid state → 200, but STOPS — no exchange).

**Tests** (+26 app tests, 158 → 184; build 17 → 18 routes; RLS suite unchanged **327**, no migration, types
0-diff): valid-state-validates; tampered-state / wrong-tenant / wrong-provider / wrong-connector / expired /
missing-nonce / wrong-signing-key all fail with the right reason; missing/malformed state; replay rejected
(and a rejected state does not burn the nonce); results never contain the secret/nonce; the callback handler
rejects missing/tampered state, does not exchange the code (the code value never appears in the outcome), and
returns inert statuses; a static scan proving the module + route do **no `fetch` (no token endpoint), no
`createClient`, no `process.env` (module), no `connector_secrets`, no `service_role`, no `access_token` /
`refresh_token` / `token_endpoint` / `grant_type`**; the server-only no-client-import guard now covers
oauth-state (the inert route is the only allowed `src/app` importer); and the existing connector metadata UI
still queries no `connector_secrets`.

**No OAuth code is exchanged for tokens. No access token is stored. No refresh token is stored. No connector
credentials are stored. No connector secret material is inserted, updated, or deleted. No connector sync is
implemented. No provider connector is implemented. No credential form is implemented. No connect/reconnect/
disconnect action is implemented. No manual or scheduled run action is implemented. No service-role request
path is added. No production data was touched. No hosted commands were run. Connector vault is still not usable
for real credentials until the remaining gated PRs are complete** (next: PR G first connector — only after the
production signer/KMS secret + the single-use `oauth_pending` replay store are wired and tested; §17 open
question). **Connector implementation remains blocked. Old-app parity is not complete. UI/UX parity is not
complete. AI/API connector parity is not complete. Upload is not automatically production-ready. Hosted
Auth/tenant-context is verified, but old-app replacement is not yet verified. RISK-001 remains OPEN. Cutover
remains BLOCKED.** No doc 17 §5 box is ticked by this PR.

## 32. Decision record — KMS / OAuth-signer / local-dev secrets / `oauth_pending` replay store (PR #110)

**KMS/key-provider decision is recorded. OAuth state signer decision is recorded. OAuth replay-store design is
recorded.** This is a **docs/design-decision PR** — it resolves the remaining `§17` open questions that gate any
real credential storage, and **implements nothing**: **No real connector credential storage is implemented. No
OAuth token exchange is implemented. No access token is stored. No refresh token is stored. No connector secret
material is inserted, updated, or deleted.** No migration is added (the `oauth_pending` schema below is
**conceptual/design-only** — its migration is a later gated PR). The vault stays NOT usable for real credentials.

### 32.1 Production `ConnectorVaultKeyProvider` / KMS decision
- **Approach — external managed KMS holds the KEK; envelope encryption only.** The production
  `ConnectorVaultKeyProvider` (§6, the PR C interface `generateDataKey(kekId)` / `unwrapDataKey(wrappedDek,
  kekId)`) is backed by a **managed cloud KMS** (default **AWS KMS**; **GCP KMS** is the equivalent if the runner
  lands on GCP). `generateDataKey` calls the KMS `GenerateDataKey` (returns a plaintext DEK + the KMS-wrapped
  DEK); `unwrapDataKey` calls KMS `Decrypt`. **The KEK never leaves the KMS** and is never stored in Postgres,
  the repo, env, or any browser-reachable surface — only the **wrapped DEK** is persisted (in
  `connector_secrets.dek_wrapped`).
- **REJECTED: Supabase Vault / pgsodium for the KEK** — it co-locates the key material with the ciphertext in the
  same database trust domain, defeating envelope encryption's separation (a DB compromise would yield both). (The
  §3 residual "compromised host with live KEK access" risk is unchanged and remains an incident-response concern,
  not a schema defense.)
- **KEK ownership.** The KEK is owned by the **server-side connector runner identity** (a narrow IAM principal
  whose ONLY KMS permissions are `GenerateDataKey` + `Decrypt` under the single connector-vault KEK) — never the
  request-path `authenticated` role, never a browser, never a blanket service-role. This preserves
  "no service-role on request paths" (§1).
- **Key id / version handling.** `kekId` is a **non-sensitive KMS key handle/alias** (e.g. an alias ARN), stored
  alongside each wrapped DEK so a row records which KEK wrapped it. KEK rotation is by **alias** (the alias points
  at the current KMS key version; old versions stay decryptable), so existing rows unwrap without re-encryption.
  The `EncryptedConnectorSecret.kekId` (PR C) carries this handle.
- **Rotation expectations.** KEK rotation is handled by the KMS (automatic annual rotation enabled, plus on-demand
  rotation on suspected compromise). DEKs are **per-secret** (already true in PR C) and a secret is re-wrapped
  under a fresh DEK on each `version` bump (rotate/reconnect). No mass re-encryption is required for KEK rotation.
- **Unwrap-failure behavior.** A KMS `Decrypt` failure (wrong KEK, revoked key, tamper, KMS unavailable) **fails
  closed**: `unwrapDataKey` throws, the crypto wrapper surfaces the existing typed `ConnectorVaultCryptoError`
  ("data key unwrap failed…") with **no key bytes / ciphertext / plaintext** in the message (PR C redaction), the
  runner marks the run `failed` with a safe `failure_code` (e.g. `key_unwrap_failed`), and **no plaintext secret
  is produced**. A KMS outage degrades to "connector temporarily unavailable", never to a plaintext fallback.
- **Local-dev / test-only provider rules.** Local dev and tests use the **in-memory `ConnectorVaultKeyProvider`**
  (the existing `createInMemoryKeyProvider`, random per-process KEKs in a Map) — **test-only, never production**.
  **No key is ever committed to the repo. No production secret is ever read in tests** (the PR C/PR F purity tests
  already assert the modules read no `process.env` and import no Supabase/service-role). A developer who wants to
  exercise the real KMS path uses their own throwaway dev KMS key + a gitignored `.env.local`, never a prod key.

### 32.2 OAuth state signer secret decision
- **Source — a server-only HMAC signing secret.** The OAuth-state signer (§31, the PR F
  `createHmacStateSigner(secret, keyId)`) is fed a **≥32-byte random secret from a server-only secret store**
  (the runner/host secret manager — e.g. the deploy platform's encrypted env or the same KMS-backed secret path),
  read via the route's `CONNECTOR_OAUTH_STATE_SECRET` env var. It is **NEVER** in the repo, a migration, a
  client bundle, or any browser-reachable surface. (A throwaway value may be set in a gitignored `.env.local` for
  local dev; tests use a fixed test-only secret, never env.)
- **Rotation plan + grace window.** Rotation publishes a new `CONNECTOR_OAUTH_STATE_KEY_ID` + secret. Because a
  signed `state` is short-lived (TTL ≤ 10 min, §31), validation accepts **{current, previous}** signing keys for
  a **grace window equal to the max state TTL** (so in-flight authorizations still validate), then the previous
  key is dropped. `keyId` distinguishes them. No long-lived multi-key set is retained.
- **No-client-exposure rule.** The signing secret is server-only by construction: `oauth-state.ts` is server-only
  (browser sentinel + the `no-client-import` guard) and reads no env; only the inert route reads the env secret,
  and only on the server. The `state` carried to the browser contains the HMAC **signature**, never the key.
- **Safe error behavior.** A signature/expiry/nonce/binding failure returns the existing PR F **safe reason CODE
  only** (`bad_signature` / `expired` / …) — never the signing secret, the nonce, the authorization code, or a
  provider payload; nothing is logged.

### 32.3 `oauth_pending` single-use replay store — design only (no migration in this PR)
Conceptual Tier-2 schema (illustrative columns; the migration is a later gated PR):
- `oauth_pending` — `id, tenant_id, organization_id?, provider, connector_id?, subject?, state_jti (a random
  unique id embedded in the signed state), nonce_hash (sha256 of the nonce — the RAW nonce is never stored),
  expires_at, consumed_at?, created_at, attempt_count? (safe counter), last_rejected_code? (a safe reason code,
  never a secret)`.
- **Single-use enforcement.** `UNIQUE (state_jti)` and `UNIQUE (nonce_hash)`. **Consume is one atomic UPDATE**:
  `update oauth_pending set consumed_at = now() where state_jti = $1 and consumed_at is null and expires_at >
  now() returning ...` — a second callback finds `consumed_at` already set (or no row) and is rejected
  (`replayed`). This is the **server-only consume path**; no request-path role can write it.
- **RLS / grants (mirrors `connector_secrets`).** RLS-enabled with **zero policies (deny-all)**; `anon` and
  `authenticated` hold **zero** privileges (no select/insert/update/delete). **No anon access. No broad
  authenticated write access.** Only the connector-runner identity / a `SECURITY DEFINER` consume function
  reaches it. `service_role` is never used on a request path.
- **Hashing / comparison.** Store `nonce_hash` (sha256), not the raw nonce; where the app compares a hash, use a
  **constant-time** compare (as PR C/PR F already do via `timingSafeEqual`).
- **Expiry / cleanup.** Rows past `expires_at` are swept by a scheduled server-only job (and/or deleted on
  consume after a short retention for audit), keeping the table bounded.
- **Audit (safe metadata only).** `connector.oauth.state.created` / `.consumed` / `.expired` / `.rejected`
  recorded into the **append-only `audit_logs`** (§10) with safe metadata only (tenant/provider/connector id +
  a reason code) — **never the raw nonce, `state`, signing key, token, or authorization code**.

### 32.4 Gates (restated — these MUST hold before any real token is stored)
1. **No real OAuth token storage before the `oauth_pending` replay store is implemented and tested** (the
   stateless PR F skeleton does not provide cross-request single-use; that requires this store).
2. **No real connector credential storage before the production KMS/key-provider (§32.1) is implemented and
   tested** (the in-memory provider is test-only).
3. **No provider connector before the replay store + key provider + the audit path are all complete.**
4. **No browser credential form until the secret write path is explicitly reviewed** (a dedicated security review
   PR, not an incidental UI change).
5. **No production credential storage before staging verification** (apply + verify on staging first, as every
   prior vault migration did).

**No real connector credential storage is implemented. No OAuth token exchange is implemented. No access token is
stored. No refresh token is stored. No connector secret material is inserted, updated, or deleted. No connector
sync is implemented. No provider connector is implemented. No credential form is implemented. No connect/
reconnect/disconnect action is implemented. No manual or scheduled run action is implemented. No service-role
request path is added. No production data was touched. No hosted commands were run. Connector vault is still not
usable for real credentials until the remaining gated PRs are complete.** This PR resolves the `§17` KMS-choice +
the local-dev-secret + the OAuth replay/signer open questions as DECISIONS (the steward-role / scope-granularity
/ webhook / refresh-concurrency `§17` questions remain open). **Connector implementation remains blocked. Old-app
parity is not complete. UI/UX parity is not complete. AI/API connector parity is not complete. Upload is not
automatically production-ready. Hosted Auth/tenant-context is verified, but old-app replacement is not yet
verified. RISK-001 remains OPEN. Cutover remains BLOCKED.** No doc 17 §5 box is ticked by this PR.

## 33. Implementation — `oauth_pending` single-use replay store (PR #111)

**OAuth pending replay store schema is added.** This lands the §32.3 design as migration
`0020_oauth_pending_replay_store.sql` — the §32.4 gate-1 prerequisite before any real OAuth token may be
stored (the stateless PR F `state` proves tamper/expiry/binding but cannot enforce cross-request single-use
without a shared store). **It creates ONLY the table + its deny-all RLS/grant posture + a pure server-only
helper.** No consume function, no route, no token exchange, no credential storage; `connector_secrets` is
untouched. **The oauth_pending table is not readable or writable by anon or authenticated users. OAuth
replay-store implementation remains server-only.**

### 33.1 Schema (migration `0020`)
`public.oauth_pending` — `id, tenant_id, organization_id?, connector_id?, provider, subject?, state_jti,
nonce_hash, intent, expires_at (NOT NULL), consumed_at?, created_at, attempt_count, last_rejected_code?`.
**Safe metadata only** — `nonce_hash` is sha256 (the **raw nonce is never stored**); there is NO raw `state`
payload, authorization code, access/refresh token, API key, webhook secret, PKCE/`code_verifier`, or
provider raw payload column (T42 asserts none exist). `last_rejected_code` is a CHECK-constrained safe reason
code (the PR F `OAuthStateReason` set), never a secret. **Single-use:** `UNIQUE (state_jti)` +
`UNIQUE (nonce_hash)`. **Same-tenant integrity:** the composite `(connector_id, tenant_id)` FK to
`connectors(id, tenant_id)` (MATCH SIMPLE — skipped when `connector_id` is null for a fresh connect) so a
cross-tenant connector can never bind. `expires_at` is required.

### 33.2 RLS / grants (deny-all, server-only — mirrors `connector_secrets`)
RLS-ENABLED with **ZERO policies** (default deny-all); `revoke all on public.oauth_pending from anon,
authenticated` (countering the hosted-default grants — the `0015`/`0016`/`0017`/`0018` masking lesson).
**No authenticated/anon read or write policy; no grant.** After `0020`, `authenticated` and `anon` hold
EXACTLY zero privileges (no SELECT/INSERT/UPDATE/DELETE/TRUNCATE) — there is no SQL a request-path role can
run that touches it. The future server-only consume path (the runner identity / a `SECURITY DEFINER`
accessor; a later gated PR) does the atomic single-use UPDATE. `service_role` is never used on a request
path. The `test-rls.sh` harness re-asserts the `oauth_pending` revoke after its blanket-grant crutch (so the
suite reflects the REAL hosted surface).

### 33.3 Server-only helper (`src/lib/server/connector-vault/oauth-pending.ts`, PURE)
`hashOAuthValue(value)` (sha256 hex — deterministic, so the future consume path hashes a returning nonce the
same way the create path did) + `buildOAuthPendingRecord(input)` which validates and returns the safe row
shape, **hashing the raw nonce and never storing or returning it**, and rejecting any secret-shaped extra
field. NO database access, NO token exchange, NO `connector_secrets`, NO Supabase/service-role import
(only import is `node:crypto`); server-only (runtime browser sentinel + the `no-client-import` guard).

### 33.4 Tests
**T42** (RLS suite **327 → 352**): `oauth_pending` deny-all at runtime (authenticated + anon cannot
read/insert/update/delete) + the catalog/privilege layer (authenticated/anon hold EXACTLY zero privilege) +
structural posture (RLS enabled, zero policies, no raw nonce/state/code/token/secret column, `expires_at`
NOT NULL, UNIQUE `state_jti`/`nonce_hash` reject duplicates, the composite-FK cross-tenant binding blocked) +
`connector_secrets` and the Tier-1 grant surface unchanged by `0020`. **+9 app tests** for the helper
(deterministic hash; the raw nonce is never returned; required-field + invalid-`expiresAt` + secret-shaped
field rejection; module purity). `database.types.ts` regenerated (now includes `oauth_pending`).

**No OAuth code is exchanged for tokens. No access token is stored. No refresh token is stored. No connector
credentials are stored. No connector secret material is inserted, updated, or deleted. No connector sync is
implemented. No provider connector is implemented. No credential form is implemented. No connect/reconnect/
disconnect action is implemented. No manual or scheduled run action is implemented. No service-role request
path is added. No production data was touched. No hosted commands were run. Connector vault is still not
usable for real credentials until the remaining gated PRs are complete** (next: the §32.1 KMS-backed
`ConnectorVaultKeyProvider` implementation, then the server-only consume path, then PR G first connector). A
human applies `0020` to staging then production in a future step (an agent never runs hosted commands).
**Connector implementation remains blocked. Old-app parity is not complete. UI/UX parity is not complete.
AI/API connector parity is not complete. Upload is not automatically production-ready. Hosted
Auth/tenant-context is verified, but old-app replacement is not yet verified. RISK-001 remains OPEN. Cutover
remains BLOCKED.** No doc 17 §5 box is ticked by this PR.

## 34. Staging verification — `0020` oauth_pending replay store (PR #112)

**OAuth pending replay store migration 0020 has been applied and verified on staging.** A human applied `0020`
to the staging project `ycdpzduxugdsffjqyoai` and queried the live RLS / privilege / policy surface. **The
agent ran nothing — no hosted command, no staging mutation, no secrets. No production data was touched.**

### 34.1 Observed — PASS
The remote migration list showed `0020` **absent** before push; `supabase db push --linked` applied
`0020_oauth_pending_replay_store.sql`; the list then showed `0020` **present** on Remote. The linked project
ref remained `ycdpzduxugdsffjqyoai`. The live RLS query returned `connector_secrets rls_enabled = true` and
`oauth_pending rls_enabled = true` — **Oauth_pending RLS is enabled.** The table-privilege query returned
**exactly two rows** — `authenticated | connector_runs | SELECT` and `authenticated | connectors | SELECT` —
with **no anon rows, no connector_secrets rows, and no oauth_pending rows**: **Oauth_pending is not readable or
writable by anon or authenticated users. Connector secret material remains inaccessible to anon and
authenticated users. Connector metadata tables expose authenticated SELECT only. Anon has no connector vault
table privileges. No broad INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, or TRIGGER grants remain on connector
vault tables for anon or authenticated.** `pg_policies` returned exactly the two tenant-member SELECT policies
(`connectors` → "members read tenant connectors", SELECT; `connector_runs` → "members read tenant connector
runs", SELECT); **`connector_secrets` has no policies** and **Oauth_pending has no policies.** This matches the
`0020` intent + the local `org_rls_test.sql` T42 proof — the deny-all replay store landed and the `0018`
least-privilege metadata surface is intact.

### 34.2 Scope / guardrails
This verifies only the `0020` RLS / grant / policy surface on staging — not any connector behavior (there is
none). **No OAuth code is exchanged for tokens. No access token is stored. No refresh token is stored. No
connector credentials are stored. No connector secret material is inserted, updated, or deleted. No connector
sync is implemented. No provider connector is implemented. No credential form is implemented. No connect/
reconnect/disconnect action is implemented. No manual or scheduled run action is implemented. No service-role
request path is added. No production data was touched.** A human re-applies `0020` to production in a future
step (an agent never runs hosted commands); next is the §32.1 KMS-backed key provider → the server-only
consume path → PR G first connector. **Connector vault is still not usable for real credentials until the
remaining gated PRs are complete. Connector implementation remains blocked. Old-app parity is not complete.
UI/UX parity is not complete. AI/API connector parity is not complete. Upload is not automatically
production-ready. Hosted Auth/tenant-context is verified, but old-app replacement is not yet verified. RISK-001
remains OPEN. Cutover remains BLOCKED.** No doc 17 §5 box is ticked by this verification.

## 35. Implementation — KMS-backed `ConnectorVaultKeyProvider` skeleton (PR #113)

**KMS-backed ConnectorVaultKeyProvider skeleton is added. The KMS adapter is server-only.** This lands the
§32.1 production key-provider BOUNDARY (the §32.4 gate-2 prerequisite before any real credential storage) as
`src/lib/server/connector-vault/kms-key-provider.ts` — and stores nothing. **No connector credentials are
stored. No connector secret material is inserted, updated, deleted, or read.** No DB, no Supabase, no
service-role, no `connector_secrets`. **Tests use mocked or test-only key material only. No real KMS
credentials are required in tests.**

### 35.1 Dependency-free KMS boundary (no SDK)
The adapter reduces the external KMS to a tiny `KmsClient` interface — `generateDataKey(kekId)` +
`decrypt(wrappedDek, kekId)` — which maps **1:1 to AWS KMS `GenerateDataKey`/`Decrypt`** (and GCP KMS
`encrypt`/`decrypt`). **No AWS/GCP SDK is added** in this PR. A real KMS-backed `KmsClient` is wired in a
LATER gated PR (the only place an SDK would be introduced, with mocked tests). Keeping the adapter SDK-free
means its unit tests need **no AWS/GCP credentials and make no network call** — a test-only in-memory fake
`KmsClient` (AES-256-GCM over random in-process KEKs, `kekId` bound as AAD) stands in.

### 35.2 Adapter (`createKmsKeyProvider(config)`)
Implements the PR C `ConnectorVaultKeyProvider` (`generateDataKey`/`unwrapDataKey`) over the injected
`KmsClient` + a `{ currentKekId, previousKekIds? }` config, and additionally exposes the non-secret
`currentKekId` / `allowedKekIds` **metadata** a future storage/runner records. Behavior:
- **Wrap (new secrets) only under the current KEK** — `generateDataKey(kekId)` rejects any non-current
  `kekId` (you never wrap a new secret under a retired key).
- **Rotation (current + previous):** `unwrapDataKey` accepts the current OR a previous (grace-window) KEK so
  rows wrapped before a rotation still decrypt; **rotate by alias, no re-encryption** (§32.1).
- **Reject unknown key id** before any KMS call (a row referencing a retired/foreign KEK fails closed).
- **Fail closed when not configured** — `createKmsKeyProvider` throws on missing `kmsClient` / `currentKekId`
  / null config; `kmsKeyProviderConfigFromEnv()` reads `CONNECTOR_VAULT_KMS_KEY_ID` (+ `_PREVIOUS_KEY_IDS`)
  and returns **null when unset** (this PR sets nothing and binds no real client, so production stays inert
  until BOTH env config AND a reviewed real client are wired).
- **Redacted errors** — wrap/unwrap/invalid-DEK failures throw a typed `ConnectorVaultKeyProviderError` with
  a fixed safe message; **never** a plaintext DEK, wrapped-DEK bytes, ciphertext, or KEK material; the
  injected `KmsClient`'s underlying error is swallowed (its message never surfaces). Nothing logs. Key
  ids/aliases are non-sensitive metadata (they name a KMS key, they are not the key) and are never pushed to
  a browser surface. Server-only: runtime browser sentinel + the `no-client-import` guard; the only import is
  the erased `ConnectorVaultKeyProvider` type.

### 35.3 Tests (+11 app tests, 193 → 204; RLS suite unchanged **352**, no migration, types 0-diff)
configured fake provider wraps/unwraps; rotation (a DEK wrapped under the previous KEK still unwraps, a new
wrap under a retired KEK is refused); wrong/unknown key id fails; missing config fails closed; unwrap-failure
and wrap-failure errors contain no plaintext/key/wrapped bytes; an invalid-length DEK from KMS fails closed;
`kmsKeyProviderConfigFromEnv` returns null when unset and parses ids when set; **the crypto wrapper
`encryptConnectorSecret`/`decryptConnectorSecret` round-trips THROUGH the KMS-backed provider** (no real
KMS); module purity (only the `./crypto` type import, no DB/Supabase/service-role/`connector_secrets`/SDK/
network); and the no-client-import guard now covers `kms-key-provider`.

**No OAuth code is exchanged for tokens. No access token is stored. No refresh token is stored. No connector
sync is implemented. No provider connector is implemented. No credential form is implemented. No connect/
reconnect/disconnect action is implemented. No manual or scheduled run action is implemented. No service-role
request path is added. No production data was touched. No hosted commands were run. Connector vault is still
not usable for real credentials until the remaining gated PRs are complete** (next: a reviewed real KMS-backed
`KmsClient` + the server-only `oauth_pending` consume path → PR G first connector). **Connector implementation
remains blocked. Old-app parity is not complete. UI/UX parity is not complete. AI/API connector parity is not
complete. Upload is not automatically production-ready. Hosted Auth/tenant-context is verified, but old-app
replacement is not yet verified. RISK-001 remains OPEN. Cutover remains BLOCKED.** No doc 17 §5 box is ticked
by this PR.

## 36. Implementation — real AWS KMS client adapter skeleton (PR #114)

**Real KMS client adapter skeleton is added. The adapter is server-only.** This lands the concrete `KmsClient`
(PR #113 / §35 boundary) for the §32.1 chosen provider — **AWS KMS** — as
`src/lib/server/connector-vault/aws-kms-client.ts`, and stores nothing. **No connector credentials are stored.
No connector secret material is inserted, updated, deleted, or read.** No DB, no Supabase, no service-role, no
`connector_secrets`. **Tests use mocked KMS responses only. No real KMS credentials are required in tests. No
live KMS calls are made in tests.**

### 36.1 AWS KMS command-shape mapping (still SDK-free — the SDK is the NEXT gate)
The adapter builds the **exact AWS KMS command shapes** and sends them through an INJECTED
`AwsKmsCommandSender` — `(command) => Promise<response>`:
- **wrap → `GenerateDataKey`**: `{ KeyId: <kekId>, KeySpec: "AES_256" }` → `{ Plaintext (the 32-byte DEK),
  CiphertextBlob (the wrapped DEK) }`.
- **unwrap → `Decrypt`**: `{ KeyId: <kekId>, CiphertextBlob: <wrappedDek> }` → `{ Plaintext (the DEK) }`.
  Passing `KeyId` on `Decrypt` makes KMS ENFORCE the blob was wrapped under that key (it errors on mismatch —
  defense in depth) rather than inferring it from the blob.

**NO `@aws-sdk/client-kms` dependency is added in this PR** (following PR #113's dependency-free discipline).
The injected `AwsKmsCommandSender` is the seam: **wiring a real SDK-backed sender — `new KMSClient({region})
.send(new GenerateDataKeyCommand(...))` — is the NEXT gate**, the one PR where `@aws-sdk/client-kms` is
introduced (with the SDK mocked in its tests). Keeping the sender injected means THIS adapter's unit tests
need **no AWS credentials and make no live KMS call** — a mock sender returns canned responses and the tests
assert the emitted command shapes.

### 36.2 Adapter (`createAwsKmsClient({ send, region })`)
Implements the `KmsClient` interface. **Fails closed** on missing config — throws `AwsKmsError` when `send`
is absent, or `region` is missing / fails the AWS region format check (`awsKmsConfigFromEnv()` reads
`CONNECTOR_VAULT_AWS_KMS_REGION` and returns **null** when unset/garbage; it binds NO sender, so a deploy
stays inert until BOTH the region AND a reviewed SDK-backed sender are wired). **Redacted errors** —
GenerateDataKey/Decrypt/malformed-response failures throw a typed `AwsKmsError` with a fixed safe message;
**never** a plaintext DEK, the wrapped/ciphertext blob, the KEK, the region, or the injected sender's
underlying error (it is swallowed). A missing/short `Plaintext` (≠ 32 bytes) fails closed. Nothing logs.
Key ids/aliases + region are non-sensitive metadata, never pushed to a browser surface. Server-only (runtime
browser sentinel + the `no-client-import` guard; the only import is the erased `KmsClient` type). It is wired
to nothing — not the OAuth callback, not a connector — and is reached only via `createKmsKeyProvider` later.

### 36.3 Tests (+11 app tests, 204 → 215; RLS suite unchanged **352**, no migration, types 0-diff)
missing-config fails closed (null / no sender / missing-or-garbage region); wrap maps to a `GenerateDataKey`
command (`KeyId` + `KeySpec: AES_256`); unwrap maps to a `Decrypt` command (`KeyId` + `CiphertextBlob`); a
mocked success returns the plaintext + wrapped DEK only through the contract; a KMS/SDK error is redacted (the
underlying message never surfaces); a malformed/missing response (no `Plaintext` / wrong-length DEK) fails
closed; a wrong `KeyId` on Decrypt fails closed (the mock KMS rejects it); `awsKmsConfigFromEnv` returns null
when unset/garbage; **the AWS adapter composes through `createKmsKeyProvider` + the crypto wrapper —
`encryptConnectorSecret`/`decryptConnectorSecret` round-trip (no real KMS)**; module purity (only the
`./kms-key-provider` type import, no DB/Supabase/service-role/`connector_secrets`/SDK/network); the
no-client-import guard now covers `aws-kms-client`.

**No OAuth code is exchanged for tokens. No access token is stored. No refresh token is stored. No connector
sync is implemented. No provider connector is implemented. No credential form is implemented. No connect/
reconnect/disconnect action is implemented. No manual or scheduled run action is implemented. No service-role
request path is added. No production data was touched. No hosted commands were run. Connector vault is still
not usable for real credentials until the remaining gated PRs are complete** (next: the SDK-wiring gate — a
reviewed real `@aws-sdk/client-kms`-backed `AwsKmsCommandSender` — plus the server-only `oauth_pending` consume
path → PR G first connector). **Connector implementation remains blocked. Old-app parity is not complete. UI/UX
parity is not complete. AI/API connector parity is not complete. Upload is not automatically production-ready.
Hosted Auth/tenant-context is verified, but old-app replacement is not yet verified. RISK-001 remains OPEN.
Cutover remains BLOCKED.** No doc 17 §5 box is ticked by this PR.

## 37. Implementation — AWS KMS SDK sender wiring (PR #115)

**AWS KMS SDK sender wiring is added. The AWS KMS sender is server-only.** This is the SDK-wiring gate (§36's
named next step): the concrete `@aws-sdk/client-kms`-backed implementation of the `AwsKmsCommandSender` seam
PR #114's `createAwsKmsClient` consumes — `src/lib/server/connector-vault/aws-kms-sdk-sender.ts`. It stores
nothing and is **wired to nothing** (no connector, no OAuth callback, no route, no credential-write path).
**No connector credentials are stored. No connector secret material is inserted, updated, deleted, or read.**
No DB, no Supabase, no service-role, no `connector_secrets`. **Tests mock AWS KMS responses only; no real AWS
or KMS credentials are required in tests; no live KMS calls are made in tests.**

### 37.1 The dependency (justified — the ONE place the SDK lands)
This PR adds **`@aws-sdk/client-kms`** (`^3.x`) — the single dependency the §32.1/§36 plan reserved for this
gate, and the only place it is imported. The 2 moderate `npm audit` advisories are PRE-EXISTING transitive
`next`→`postcss` issues, **not** introduced by the AWS SDK (no new advisory comes from it); `npm audit fix
--force` is NOT run (it would downgrade Next — a breaking change). The SDK import is **server-only** (the
module lives under `src/lib/server/`, carries the browser sentinel, and the `no-client-import` guard +
`next build` confirm no client/route reaches it, so it is not bundled into any browser route).

### 37.2 Sender (`aws-kms-sdk-sender.ts`)
- **`awsKmsSenderFromClient(client)`** — the testable core: it turns our `AwsKmsCommand` into the real AWS
  `new GenerateDataKeyCommand({ KeyId, KeySpec: "AES_256" })` / `new DecryptCommand({ KeyId, CiphertextBlob })`,
  calls `client.send(command)`, and maps the SDK output (`{ Plaintext, CiphertextBlob }`) back to our
  `AwsKmsResponse`. The `client` is the minimal `{ send }` surface a real `KMSClient` satisfies — **tests
  inject a MOCK client**, so there is no SDK client construction, no network, and no credentials in tests.
- **`createAwsKmsSdkSender({ region })`** validates the region (fails closed on missing/garbage **before** any
  client is built), constructs `new KMSClient({ region })`, and returns `awsKmsSenderFromClient(client)`. AWS
  credentials resolve lazily from the **runner's IAM identity via the SDK default provider chain** — never
  hardcoded, never a vault-managed secret read here.
- **`createAwsKmsSdkSenderFromEnv()`** returns null unless `CONNECTOR_VAULT_AWS_KMS_REGION` is set (this PR
  sets no env — inert by default; a production deploy stays inert until the region is wired and reviewed).
- **Redaction** — a send failure / malformed response throws a typed `AwsKmsSdkError` with a fixed safe
  message; the raw AWS/SDK error is **swallowed** (no region/key/blob/plaintext/AWS body); nothing logs. The
  downstream §36 adapter also re-redacts + validates the response (DEK = 32 bytes), so a malformed response
  fails closed.

### 37.3 Tests (+10 app tests, 215 → 225; RLS suite unchanged **352**, no migration, types 0-diff)
`createAwsKmsSdkSender` / `awsKmsSenderFromClient` fail closed on bad config / no client; wrap maps to a
`GenerateDataKeyCommand { KeyId, KeySpec: AES_256 }`; unwrap maps to a `DecryptCommand { KeyId, CiphertextBlob
}` (asserting the real SDK Command instances + inputs, via a mock client — **no live call**); a raw AWS/SDK
error is swallowed (its body never surfaces); a malformed (null) response and a missing-`Plaintext` response
(through the §36 adapter) fail closed; `createAwsKmsSdkSenderFromEnv` returns null when unset; **the mocked
SDK sender composes through `createAwsKmsClient` + `createKmsKeyProvider` + the crypto wrapper —
`encryptConnectorSecret`/`decryptConnectorSecret` round-trip (no real KMS)**; module scope (only
`@aws-sdk/client-kms` + `./aws-kms-client`, no DB/Supabase/service-role/`connector_secrets`/raw-fetch); the
no-client-import guard now covers `aws-kms-sdk-sender`; the PR #114 dependency-free command-shape tests stay
green.

**No OAuth code is exchanged for tokens. No access token is stored. No refresh token is stored. No connector
sync is implemented. No provider connector is implemented. No credential form is implemented. No connect/
reconnect/disconnect action is implemented. No manual or scheduled run action is implemented. No service-role
request path is added. No production data was touched. No hosted commands were run. No environment variable is
added to production or staging. Connector vault is still not usable for real credentials until the remaining
gated PRs are complete** (next: the server-only `oauth_pending` consume path → PR G first connector — only
after the runner identity's IAM/KMS grant + a real KEK alias are provisioned and staging-verified by a human).
**Connector implementation remains blocked. Old-app parity is not complete. UI/UX parity is not complete.
AI/API connector parity is not complete. Upload is not automatically production-ready. Hosted Auth/tenant-context
is verified, but old-app replacement is not yet verified. RISK-001 remains OPEN. Cutover remains BLOCKED.** No
doc 17 §5 box is ticked by this PR.

## 38. Implementation — server-only `oauth_pending` consume path (PR #116)

**Server-only oauth_pending consume path is added. The consume path performs atomic single-use consumption.**
This is the §16/§32.3 single-use consume — the last replay-store prerequisite before a first connector can be
sketched — as `src/lib/server/connector-vault/oauth-pending-consume.ts`. It stores nothing and is wired to
nothing (no connector, no OAuth callback change, no route, no credential-write). **No OAuth code is exchanged
for tokens. No access token is stored. No refresh token is stored. No connector credentials are stored. No
connector secret material is inserted, updated, deleted, or read.**

### 38.1 Deny-all preserved (no migration, no service-role request path)
`oauth_pending` is Tier-2 deny-all — RLS-enabled, zero policies, zero `anon`/`authenticated` grant
(migration `0020`, T42). A request-path (`authenticated`) client therefore **cannot** touch it, and this PR
keeps it that way: **Oauth_pending remains not directly readable or writable by anon or authenticated users.**
The consume runs as the SERVER-ONLY connector-runner identity, NOT a browser/request principal. So the module
ships only the PURE consume LOGIC + result classification and **delegates the privileged DB write to an
INJECTED `OAuthPendingConsumer`** (the runner-identity-backed executor — a real DB-backed implementation is
wired in a later gated PR, backed by a `SECURITY DEFINER` accessor / the runner's own connection, never
reachable from request/browser code). **No browser-accessible service-role path is added; no migration is
needed (deny-all is unchanged); the RLS suite stays 352.**

### 38.2 Atomic single-use
The executor's `runAtomicConsume` performs ONE statement — the documented reference SQL:
`update public.oauth_pending set consumed_at = $now where state_jti = $jti and nonce_hash = $nonce_hash and
tenant_id = $tenant_id and provider = $provider and connector_id is not distinct from $connector_id
(null-safe) and consumed_at is null and expires_at > $now returning id, state_jti, consumed_at`. Success is
"exactly one row changed" → `{ ok: true, consumed: { stateJti, consumedAt } }`. A concurrent second callback
finds `consumed_at` already set (or 0 rows) and consumes nothing. On 0 rows, `consumeOAuthPending` does a
READ-ONLY classify (by the unique `state_jti`) and returns a SAFE reason code — `not_found` /
`already_consumed` / `expired` / `tenant_mismatch` / `provider_mismatch` / `connector_mismatch` /
`nonce_mismatch` / `malformed_input` — **never mutating again, so single-use is preserved**. Identity
mismatches are reported before consumed/expired (a wrong tenant/provider/connector/nonce on a known `jti` is
a forgery/confused-deputy signal).

### 38.3 Redaction
A result carries only a safe reason CODE + non-secret metadata (`stateJti`, `consumedAt` timestamp). It NEVER
includes a raw nonce, raw state, authorization code, provider payload, or any secret — `nonce_hash` is the
only nonce-derived input and it is a one-way hash, never echoed back into an error. Nothing logs. The module
is server-only (runtime browser sentinel + the `no-client-import` guard) and PURE — NO imports (no DB, no
Supabase, no service-role, no `process.env`, no `connector_secrets`, no token exchange).

### 38.4 Tests (+16 app tests, 225 → 241; RLS suite unchanged **352**, no migration, types 0-diff)
consume changes exactly one matching row (and issues exactly one atomic mutation); a second consume fails
closed (`already_consumed` — single-use); a fresh-connect (null connector) row consumes on a null input;
every failure case maps to its safe reason (not_found / expired / already_consumed / tenant / provider /
connector [present + fresh-connect-vs-bound] / nonce mismatch / malformed_input); a malformed input never
reaches the atomic mutation; a missing consumer throws a typed error; a failure result echoes back no raw
tenant/nonce/state value; module purity (no imports / DB / Supabase / service-role / `connector_secrets` /
token); and the OAuth callback route **still exchanges no code and stores no token**. The deny-all RLS proofs
(T42 oauth_pending, T39 connector_secrets, T40 connectors/connector_runs authenticated-SELECT-only) are
unchanged and still pass.

**No connector sync is implemented. No provider connector is implemented. No credential form is implemented.
No connect/reconnect/disconnect action is implemented. No manual or scheduled run action is implemented. No
browser-accessible service-role path is added. No production data was touched. No hosted commands were run.
Connector vault is still not usable for real credentials until the remaining gated PRs are complete** (next:
PR G — a first low-risk connector — only after the runner-identity-backed executor + the IAM/KMS grant + a
real KEK alias are provisioned and staging-verified by a human; this PR ships only the pure consume contract).
**Connector implementation remains blocked. Old-app parity is not complete. UI/UX parity is not complete.
AI/API connector parity is not complete. Upload is not automatically production-ready. Hosted Auth/tenant-context
is verified, but old-app replacement is not yet verified. RISK-001 remains OPEN. Cutover remains BLOCKED.** No
doc 17 §5 box is ticked by this PR.

## 39. Provisioning plan — runner identity / DB grants / OAuth consume / KMS-IAM / staging verification (PR #117)

**Runner identity provisioning plan is recorded. KMS/IAM provisioning plan is recorded. OAuth consume
execution plan is recorded.** This is a **docs/design provisioning PR** — it implements NOTHING: **No runner
identity is implemented by this PR. No runner DB grants are added by this PR. No real KMS/IAM grant is
configured by this PR.** No migration, no env secret, no code. It records the provisioning the code primitives
(PR #101–#116) require before any real credential storage or provider connector, so a future implementer (and
a human operator) execute it deliberately, not ad hoc. **The vault stays NOT usable for real credentials.**

### 39.1 Runner identity model
- **The principal.** Connector-vault privileged actions (consume a pending OAuth state, write/read
  `connector_secrets`, write `connector_runs`, KMS wrap/unwrap) execute as a **single dedicated server-side
  "connector runner" identity** — a background worker / server process, NOT a request handler. It is the §3
  "separate server-side principal, not the user." It holds (a) a narrow Postgres role/connection (`§39.2`)
  and (b) a narrow AWS IAM identity (`§39.4`).
- **Which code paths may use it.** ONLY server-only modules under `src/lib/server/connector-vault/` invoked
  by the runner process (the future executors that satisfy the injected `OAuthPendingConsumer` (PR #116),
  `ConnectorVaultKeyProvider` (PR #113), `KmsClient` (PR #114), `AwsKmsCommandSender` (PR #115)). These are
  reached via the runner's own entrypoint (a queue worker / cron / internal job), never via a Next.js route,
  server action, or page render that a browser can trigger.
- **Which paths must NEVER use it.** No browser/client code, no `"use client"` file, no `src/app` route or
  server action, no user-facing page. The existing `no-client-import` guard already fences the server-only
  modules; the runner connection/role is additionally never imported by request-path code (a future guard
  asserts the runner DB client is not reached from `src/app`).
- **How it differs from the normal authenticated-user RLS path.** A request runs as the Supabase `anon`/
  `authenticated` role under the user's JWT, with **RLS as the sole authority** — and that role is **deny-all**
  on `oauth_pending`/`connector_secrets` (it literally cannot touch them). The runner is a *different* DB
  principal with *narrow explicit grants* (not RLS-scoped to a tenant — it re-derives + verifies the tenant
  server-side per action, §3 T2). So the two paths are isolated: the user path can never reach secret/consume
  surfaces; the runner path is never reachable from a browser request.
- **Why it is NOT a broad service-role request path.** The runner is NOT the Supabase `service_role` used on a
  request path (the existing `check-auth-safety` gate forbids that, and the standing rule is "no service-role
  on request paths; RLS is the boundary"). It is a **narrow, dedicated identity** with least-privilege grants
  (`§39.2`), reachable only from the runner process — so it adds **no browser-accessible service-role path**.
  (Implementation may realize it as a dedicated `connector_runner` DB role with explicit grants, or as a
  `SECURITY DEFINER` accessor owned by such a role — chosen + justified in the implementing PR; either way it
  is not a blanket `service_role` exposed to request code.)

### 39.2 Database privileges (intended — least privilege; no grant added here)
The runner's intended Postgres privileges, to be implemented + staging-verified in a FUTURE migration PR
(this PR adds none; the tables stay deny-all to `anon`/`authenticated`):
- **`oauth_pending`** — runner: `SELECT` + `UPDATE (consumed_at)` only (for the atomic single-use consume,
  §38) + `INSERT` (to create the pending row at authorize-time) + a scheduled `DELETE`/sweep of expired rows.
  **NOT** `UPDATE` on any other column, **NOT** broad `DELETE` of arbitrary rows beyond the expiry sweep.
- **`connector_secrets`** — runner: `INSERT` (store a new wrapped secret version), `SELECT` (read a wrapped
  secret to unwrap server-side), `UPDATE (is_active, revoked_at, status)` (rotate/revoke); **NOT** `DELETE`
  (secrets are tombstoned/versioned, never hard-deleted — §9).
- **`connectors` / `connector_runs`** — runner: `INSERT`/`UPDATE` on the safe metadata it writes (connector
  status, run lifecycle rows). `connectors`/`connector_runs` keep the existing **`authenticated` = `[SELECT]`
  only** request-path surface (`0018`/T40) UNCHANGED — the runner's write grant is separate and not given to
  `authenticated`.
- **Hard limits:** **no `anon` access anywhere; no normal `authenticated` direct access to
  `oauth_pending`/`connector_secrets`; no broad `TRUNCATE`/`REFERENCES`/`TRIGGER`** for any of these roles
  (the `0017`/`0018` REVOKE-broad-then-GRANT-narrow lesson + the T39/T40/T42 exact-privilege-array tests
  extend to the runner). Every grant is the minimum verb on the minimum columns.
- **Audit requirement:** EVERY privileged runner action (`connector.run.created/.started/.completed/.failed`,
  `connector.credential.created/.revoked`, `connector.oauth.state.created/.consumed/.expired/.rejected`)
  appends to the **append-only `audit_logs`** (`reject_audit_mutation`, `0002`) with **safe metadata only**
  (tenant/provider/connector id + a reason code) — **never** a raw nonce/state/code/token/key.

### 39.3 OAuth consume execution plan
- The runner (and only the runner) performs the **atomic single-use** `oauth_pending` consume via the PR #116
  `consumeOAuthPending` + a runner-identity-backed `OAuthPendingConsumer` (the `UPDATE … consumed_at = now()
  WHERE … consumed_at IS NULL AND expires_at > now() RETURNING …` of §38). **Consume is single-use**: a
  second/concurrent callback consumes nothing.
- **Expired / reused / mismatched (tenant/provider/connector/nonce) states FAIL CLOSED** — the consume returns
  a safe reason code and the flow stops; nothing downstream runs.
- **The raw nonce / raw state / authorization code are NEVER persisted or logged** — `oauth_pending` stores
  only `nonce_hash` (sha256) + `state_jti` (§32.3); the callback never reads/returns/logs the `code` (§31).
- **No token exchange happens until the consume path is implemented (runner executor) AND staging-verified**
  (§39.6/§39.7 gate). Only after a state is verifiably consumed-exactly-once does the runner proceed to the
  (later) authorization-code exchange — which itself stores only envelope-encrypted secrets, never plaintext.

### 39.4 KMS / IAM provisioning plan
- **KEK alias naming.** A per-environment KMS alias, e.g. `alias/idcaddie-connector-vault-kek-staging` and
  `alias/idcaddie-connector-vault-kek-prod` (distinct keys, distinct accounts/regions where possible). The
  alias — not a raw key ARN — is the configured `kekId` (§32.1), so rotation re-points the alias with no
  re-encryption. The alias is a **non-secret handle** recorded per wrapped DEK.
- **Region / config source.** The AWS region comes from a server-only env var (`§39.5`,
  `CONNECTOR_VAULT_AWS_KMS_REGION`, read by `awsKmsConfigFromEnv` / the SDK sender, PR #114/#115). Region is
  non-secret metadata.
- **IAM principal.** The runner's AWS identity is granted a **narrow IAM policy: only `kms:GenerateDataKey` +
  `kms:Decrypt`, scoped by `Resource` to the single connector-vault KEK alias/ARN** (and optionally a
  `kms:ViaService`/condition limiting use). **No `kms:*`, no `kms:CreateKey`/`ScheduleKeyDeletion`/`PutKeyPolicy`,
  no `Resource: *`, no broad IAM** — deny-broad by construction.
- **Rotation plan.** KMS automatic annual KEK rotation enabled, plus on-demand rotation by alias on suspected
  compromise; per-secret DEKs rotate on each secret `version` bump (§32.1). No mass re-encryption needed.
- **Staging vs production separation.** Separate KEK aliases, separate IAM principals/roles, separate regions/
  accounts where feasible; a staging credential can never decrypt a production secret and vice versa.
- **No committed credentials.** No AWS access key / secret / session token is ever committed to the repo or
  placed in a client bundle. **If the runner runs where an IAM role is available** (an instance/task role /
  OIDC federation), the SDK resolves credentials from the default provider chain (PR #115) and **NO AWS keys
  are placed in app env at all** — preferred. Static AWS keys are a last resort, server-only secret-manager
  only, never in the repo.

### 39.5 Environment / config
- **Conceptual variables (server-only):** `CONNECTOR_VAULT_AWS_KMS_REGION` (region; PR #114/#115),
  `CONNECTOR_VAULT_KMS_KEY_ID` (+ `CONNECTOR_VAULT_KMS_PREVIOUS_KEY_IDS`) (the KEK alias[es]; PR #113/#114),
  `CONNECTOR_OAUTH_STATE_SECRET` (+ `CONNECTOR_OAUTH_STATE_KEY_ID`) (the HMAC state-signing secret; §32.2/§31),
  and the runner's DB connection (a server-only secret). All **server-only**.
- **What may exist in staging:** the staging KEK alias + region + a staging state-signing secret + the runner
  staging DB connection — set by a human on the runner's hosting, after the staging grants/IAM are applied
  and verified (§39.6). **This PR sets none.**
- **What may exist in production:** the production equivalents — set by a human only after staging is verified
  and the production migration + IAM are applied (§39.7). **This PR sets none.**
- **What must NEVER exist in a client bundle:** ANY of the above — no region, alias, signing secret, DB
  connection, or AWS key is ever `NEXT_PUBLIC_*` or imported by a `"use client"`/`src/app` browser path. The
  server-only modules + the `no-client-import` guard enforce this.
- **Fail-closed when missing:** every reader already returns null / throws a typed redacted error when its
  config is unset (`kmsKeyProviderConfigFromEnv`, `awsKmsConfigFromEnv`, `createAwsKmsSdkSenderFromEnv`,
  `createKmsKeyProvider`, the inert OAuth callback) — so an unconfigured deploy is **inert**, never a weak
  default.

### 39.6 Staging verification plan (human-executed; an agent runs nothing hosted)
1. A human applies any future **runner-grant migration to STAGING first** (`db push --linked` against
   `ycdpzduxugdsffjqyoai`), then queries the live surface.
2. **Verify `oauth_pending` remains inaccessible to `anon`/`authenticated`** — exactly zero privilege, RLS-on,
   zero policies (the T42 invariant still holds after the runner grant).
3. **Verify `connector_secrets` remains inaccessible to `anon`/`authenticated`** — exactly zero privilege,
   deny-all (the T39 invariant still holds).
4. **Verify the runner can perform ONLY its intended operations** — the runner role's privilege array equals
   exactly the §39.2 set (no extra verb, no `TRUNCATE`/`REFERENCES`/`TRIGGER`, no DELETE on `connector_secrets`).
5. **Verify NO browser path can invoke runner operations** — `authenticated`/`anon` still cannot consume
   `oauth_pending` or read/write `connector_secrets`; the runner entrypoint is not a route.
6. **Verify the KMS path with a staging-safe / non-production key** (a staging KEK alias or a mocked/test
   provider) — never a production key; a round-trip wrap/unwrap succeeds under the runner's staging IAM only.
7. **Record the evidence (a docs-only verification PR) BEFORE any provider-connector work begins.**

### 39.7 Gates
1. **No real credential storage before the runner DB grants + the KMS IAM are implemented AND staging-verified**
   (§39.2/§39.4/§39.6).
2. **No provider connector before the runner consume path + the KMS path are implemented AND staging-verified.**
3. **No production credential flow before the production migration + the production IAM/KMS are applied AND
   verified** (staging green first, then production, then a recorded production verification — as every prior
   vault migration did).
4. **RISK-001 remains OPEN until the full connector flow is built, verified, and the doc 17 §5 cutover
   criteria are met** — this plan does not advance any §5 box.

**No runner identity is implemented by this PR. No runner DB grants are added by this PR. No real KMS/IAM grant
is configured by this PR. No OAuth code is exchanged for tokens. No access token is stored. No refresh token is
stored. No connector credentials are stored. No connector secret material is inserted, updated, deleted, or
read. No connector sync is implemented. No provider connector is implemented. No credential form is implemented.
No connect/reconnect/disconnect action is implemented. No manual or scheduled run action is implemented. No
browser-accessible service-role path is added. No production data was touched. No hosted commands were run.
Connector vault is still not usable for real credentials until the remaining gated PRs are complete. Connector
implementation remains blocked. Old-app parity is not complete. UI/UX parity is not complete. AI/API connector
parity is not complete. Upload is not automatically production-ready. Hosted Auth/tenant-context is verified, but
old-app replacement is not yet verified. RISK-001 remains OPEN. Cutover remains BLOCKED.** No doc 17 §5 box is
ticked by this PR.

## 40. Implementation — connector_runner DB grant foundation (PR #118)

**Runner DB grant foundation is added. Runner privileges are least-privilege and not granted to anon or
authenticated users.** This lands the §39.2 grant FOUNDATION as migration `0021_connector_runner_grants.sql`
— a dedicated server-side DB principal with the minimum grant the OAuth `oauth_pending` consume (PR #116)
needs, and **nothing else**. No app request path is wired to the runner; no credential is stored; no
`connector_secrets` is read/written by app code. **The vault stays NOT usable for real credentials.**

### 40.1 The role
`create role connector_runner nologin bypassrls` (idempotent). **NOLOGIN** — a privilege-holding role like
`anon`/`authenticated`, not a login (the real runner connection/login wiring is a later ops/PR concern).
**BYPASSRLS, justified + constrained (§39.1):** `oauth_pending` is RLS-enabled with ZERO policies (deny-all
to every non-bypass role — `0020`), so a plain grant alone would still be RLS-denied; the runner is the §3
trusted server principal whose **tenant-bound query contract** (PR #116's `update … where tenant_id = $tid
and state_jti = $jti and nonce_hash = $nh and consumed_at is null and expires_at > now()`) excludes
cross-tenant rows in the WHERE, not via RLS. It is **NOT the broad `service_role`** on a request path — it is
a narrow role reached only from the server-only runner entrypoint, never request/browser code (T43 proves the
exact privilege surface + the constrained query shape; the role is referenced by no `src/`/`src/app` code).

### 40.2 The grants (least privilege; oauth_pending only)
Defensive `revoke all` first, then ONLY:
- `grant select on public.oauth_pending to connector_runner` — the read-only classify lookup.
- `grant update (consumed_at, attempt_count, last_rejected_code) on public.oauth_pending to connector_runner`
  — a **column-level** UPDATE on exactly the single-use / attempt columns the consume sets / a rejected
  attempt records. The immutable identity columns (`tenant_id`/`state_jti`/`nonce_hash`/`provider`/
  `expires_at`/…) are **NOT** updatable by the runner.
- **No INSERT** (authorize-time create is a later PR), **no row delete / no row purge** (the expiry sweep is a
  later PR), **no REFERENCES, no TRIGGER**.
- **DEFERRED (no grant in this PR — §39.2/§39.7):** the runner gets **NO grant on `connector_secrets`** (secret
  read/write is a later, separately-reviewed PR — tombstone/version, never a row delete) and **NO grant on
  `connectors`/`connector_runs`** (the lifecycle metadata write is a later PR). The runner can touch ONLY
  `oauth_pending`, and only as above.

### 40.3 Browser roles unchanged (deny-all preserved)
`anon`/`authenticated` privileges are NOT changed: **Oauth_pending remains not directly readable or writable by
anon or authenticated users. Connector secret material remains inaccessible to anon and authenticated users.**
The secret-table deny-all is re-asserted defensively (idempotent — the `0017`/`0018` pattern). **No policy is
added for any browser role**, so `oauth_pending` keeps its zero-policy deny-all (T42/T43); `connectors`/
`connector_runs` keep `authenticated` = `[SELECT]` only (`0018`/T40). **No browser-accessible service-role path
is added.**

### 40.4 Tests (T43; RLS suite **352 → 387**, grant-only — types 0-diff, no app change)
T43 proves: `connector_runner` exists, is BYPASSRLS + NOLOGIN; its `oauth_pending` privilege is EXACTLY
SELECT + a column-UPDATE on `{consumed_at, attempt_count, last_rejected_code}` (no INSERT/DELETE/TRUNCATE/
REFERENCES/TRIGGER, no UPDATE on the identity columns); it holds ZERO privilege on `connector_secrets`/
`connectors`/`connector_runs`; **functionally** it can `SELECT` + set `consumed_at` (the §38 consume shape)
but CANNOT delete/insert/update-an-identity-column/read `connector_secrets`; and `anon`/`authenticated` keep
their deny-all surface (zero on `oauth_pending`/`connector_secrets`, `[SELECT]`-only on the Tier-1 tables,
`oauth_pending` still zero policies, a normal authenticated user still cannot consume `oauth_pending` or touch
`connector_secrets`). The `test-rls.sh` harness applies `0021` (creating the role); its blanket grant /
re-assert touch only `authenticated`/`anon`, so the runner's privileges reflect EXACTLY `0021`.

A human applies `0021` to staging then production in a future step (an agent never runs hosted commands), and
records the staging verification (§39.6) BEFORE any provider-connector work. **No OAuth code is exchanged for
tokens. No access token is stored. No refresh token is stored. No connector credentials are stored. No
connector secret material is inserted, updated, deleted, or read by app code. No connector sync is implemented.
No provider connector is implemented. No credential form is implemented. No connect/reconnect/disconnect action
is implemented. No manual or scheduled run action is implemented. No production data was touched. No hosted
commands were run. Connector vault is still not usable for real credentials until the remaining gated PRs are
complete. Connector implementation remains blocked. Old-app parity is not complete. UI/UX parity is not
complete. AI/API connector parity is not complete. Upload is not automatically production-ready. Hosted
Auth/tenant-context is verified, but old-app replacement is not yet verified. RISK-001 remains OPEN. Cutover
remains BLOCKED.** No doc 17 §5 box is ticked by this PR.
## 41. Staging verification — `0021` connector_runner DB grants (PR #119)

**Connector runner DB grant migration 0021 has been applied and verified on staging.** A human applied
`0021` to the staging project `ycdpzduxugdsffjqyoai` and queried the live role / privilege / policy surface.
**The agent ran nothing — no hosted command, no staging mutation, no secrets. No production data was touched.**

### 41.1 Observed — PASS
The remote migration list showed `0021` **absent** before push; `supabase db push --linked` applied
`0021_connector_runner_grants.sql`; the list then showed `0021` **present** on Remote. The linked project ref
remained `ycdpzduxugdsffjqyoai`. The role query confirmed `connector_runner` exists with `rolcanlogin = false`
and `rolbypassrls = true` — **Connector_runner is NOLOGIN. Connector_runner has BYPASSRLS only for the narrow
runner consume path.** The table-privilege query returned **exactly three rows** — `authenticated |
connector_runs | SELECT`, `authenticated | connectors | SELECT`, and `connector_runner | oauth_pending |
SELECT` — with **no anon rows, no connector_secrets rows, and no connector_runner privilege on
connectors/connector_runs**: **Connector_runner has SELECT on oauth_pending. Connector_runner has no
connectors or connector_runs privileges.** The column-privilege query for `connector_runner` on
`oauth_pending` returned SELECT on the columns the consume classification reads, and **UPDATE only on
`consumed_at`, only on `attempt_count`, and only on `last_rejected_code`** — **Connector_runner has
column-scoped UPDATE only on consumed_at, attempt_count, and last_rejected_code. Connector_runner has no
connector_secrets privileges.** `pg_policies` returned exactly the two tenant-member SELECT policies
(`connectors` → "members read tenant connectors", SELECT; `connector_runs` → "members read tenant connector
runs", SELECT); **`connector_secrets` has no policies** and **Oauth_pending has no policies.** This matches
the `0021` intent + the local `org_rls_test.sql` T43 proof — the narrow runner grant landed and the deny-all
surface is intact: **Oauth_pending remains not directly readable or writable by anon or authenticated users.
Connector secret material remains inaccessible to anon and authenticated users. Connector metadata tables
expose authenticated SELECT only. Anon has no connector vault table privileges. No broad INSERT, UPDATE,
DELETE, TRUNCATE, REFERENCES, or TRIGGER grants remain on connector vault tables for anon or authenticated.**

### 41.2 Scope / guardrails
This verifies only the `0021` role / grant / policy surface on staging — not any connector behavior (there
is none; the runner role is granted but no runner process or app path uses it). **No OAuth code is exchanged
for tokens. No access token is stored. No refresh token is stored. No connector credentials are stored. No
connector secret material is inserted, updated, deleted, or read. No connector sync is implemented. No
provider connector is implemented. No credential form is implemented. No connect/reconnect/disconnect action
is implemented. No manual or scheduled run action is implemented. No browser-accessible service-role request
path is added. No production data was touched.** A human re-applies `0021` to production in a future step (an
agent never runs hosted commands); next are the runner-identity-backed executors + the KMS/IAM provisioning
(§39.4/§39.7) → PR G first connector. **Connector vault is still not usable for real credentials until the
remaining gated PRs are complete. Connector implementation remains blocked. Old-app parity is not complete.
UI/UX parity is not complete. AI/API connector parity is not complete. Upload is not automatically
production-ready. Hosted Auth/tenant-context is verified, but old-app replacement is not yet verified. RISK-001
remains OPEN. Cutover remains BLOCKED.** No doc 17 §5 box is ticked by this verification.
## 42. Implementation — runner-only `oauth_pending` executor wiring (PR #120)

**Runner-only oauth_pending executor wiring is added. The executor is server-only. The executor is not
exposed to browser request paths.** `src/lib/server/connector-vault/oauth-pending-executor.ts` is the
concrete `OAuthPendingConsumer` (the PR #116 boundary) backed by an INJECTED runner DB client — the wiring a
FUTURE connector runner uses to run the atomic single-use consume through the `connector_runner` role (`0021`,
T43, staging-verified §41). It stores nothing; it is wired to nothing in this PR.

### 42.1 Shape
- `RunnerDbClient` — the minimal injected boundary: `run(sql, params) → { rows }`, a parameterized statement
  runner the future runner backs with a server-only Postgres connection bound to `connector_runner` (NOLOGIN
  + BYPASSRLS, narrow grants). **It is explicitly INJECTED — the module creates NO global service-role /
  admin client.** Tests inject a mock, so there is **no live DB call and no credentials in tests.**
- `createOAuthPendingExecutor(client): OAuthPendingConsumer` — **fails closed** (throws
  `OAuthPendingExecutorError`) when the client is missing/invalid. `runAtomicConsume` issues ONE parameterized
  statement that matches on tenant_id/provider/state_jti/nonce_hash/connector_id (null-safe) + `consumed_at is
  null` + `expires_at > now`, and updates **ONLY `consumed_at`** (within the `0021` 3-column grant; the
  immutable identity columns are never set). `readPendingState` is the read-only classify lookup. Composed
  with PR #116's pure `consumeOAuthPending`, the two give the single-use consume.
- **Redaction:** a DB failure throws a typed error with a fixed safe message — never the raw DB error, a raw
  nonce, raw state, OAuth code, provider payload, token, or secret. The nonce HASH + ids are bound parameters
  (never inlined / logged); nothing logs. Results carry only safe labels (a reason code or `{stateJti,
  consumedAt}`).

### 42.2 Posture (unchanged)
Server-only (sentinel + `no-client-import` guard; its only import is the `./oauth-pending-consume` TYPES,
erased at runtime). **No app route / server action / browser path calls the executor** (a static scan asserts
the `/connectors/oauth/callback` route is still inert — no `fetch`, no executor import, no token exchange).
**Oauth_pending remains not directly readable or writable by anon or authenticated users. Connector secret
material remains inaccessible to anon and authenticated users.** No migration; RLS suite unchanged **387**.

### 42.3 Tests (+12; app 241 → 253)
fail-closed on a missing client; the consume UPDATE shape + bound params (sets only `consumed_at`; null-safe
connector; `consumed_at is null` + `expires_at > $1`); the classify SELECT shape; the FULL chain through
`consumeOAuthPending` with a mock that genuinely models the atomic single-use semantics (consume-exactly-once,
second → already_consumed, fresh-connect null, every mismatch/expired/not_found → its safe reason); both DB
errors redacted; module purity (only the consume types; no createClient/process.env/fetch/connector_secrets/
service_role/token); and the OAuth callback route still inert.

A FUTURE PR wires the real `RunnerDbClient` (a server-only `connector_runner` connection in the runner
process) + the IAM/KMS grant → PR G. **No OAuth code is exchanged for tokens. No access token is stored. No
refresh token is stored. No connector credentials are stored. No connector secret material is inserted,
updated, deleted, or read. No connector sync is implemented. No provider connector is implemented. No
credential form is implemented. No connect/reconnect/disconnect action is implemented. No manual or scheduled
run action is implemented. No browser-accessible service-role request path is added. No production data was
touched. No hosted commands were run. Connector vault is still not usable for real credentials until the
remaining gated PRs are complete. Connector implementation remains blocked. Old-app parity is not complete.
UI/UX parity is not complete. AI/API connector parity is not complete. Upload is not automatically
production-ready. Hosted Auth/tenant-context is verified, but old-app replacement is not yet verified. RISK-001
remains OPEN. Cutover remains BLOCKED.** No doc 17 §5 box is ticked by this PR.
## 43. Hosted provisioning plan — runner DB / AWS KMS wiring + no-real-token staging verification (PR #121)

**Hosted runner/KMS wiring plan is recorded.** The connector-vault primitives now exist (PR #101–#120) but the
HOSTED runner/KMS path is not provisioned or verified. This is a docs/design PR — it implements NOTHING (no
hosted runner, no IAM/KMS grant, no migration, no env secret, no code). It records what a human operator must
provision + verify before any real provider connector or real token storage, so it is done deliberately.
**No hosted runner is implemented by this PR. No real KMS/IAM grant is configured by this PR.**

### 43.1 Hosted runner DB wiring plan
- **How the runner connects.** The connector runner (a server-only background worker/job, NOT a request
  handler) opens a direct Postgres connection to the Supabase DB and authenticates AS the `connector_runner`
  role (NOLOGIN today — provisioning gives it a login secret OR a member login role that `set role
  connector_runner`s; `0021`/T43/§41). It fills the `RunnerDbClient` boundary (PR #120) — the only DB seam
  the executor uses.
- **How credentials are provisioned (outside the repo).** The runner's DB connection string / password lives
  ONLY in the runner host's secret manager (or an injected runtime secret), set by a human — **never** in the
  repo, an app env, or a client bundle. No static DB secret is committed.
- **Why this is NOT a browser/request service-role path.** The runner is a separate server-side principal
  reached only from the runner entrypoint; its connection never exists in a Next.js route, server action, or
  browser bundle (the `no-client-import` guard + the standing "no service-role on request paths" rule hold).
  `connector_runner` is a NARROW role (not `service_role`): its ONLY grant is `oauth_pending`.
- **Exact tables/actions the runner can perform.** ONLY `oauth_pending`: `SELECT` (classify) + a column-scoped
  `UPDATE` on `consumed_at`/`attempt_count`/`last_rejected_code` (the single-use consume sets `consumed_at`) —
  the §38/§42 consume shape, `0021`.
- **What the runner still CANNOT do.** No `oauth_pending` INSERT/DELETE/row-purge; no UPDATE of the immutable
  identity columns; **no grant at all on `connector_secrets`/`connectors`/`connector_runs`** (deferred to
  later gated PRs). It cannot read or write any secret.

### 43.2 Hosted AWS KMS wiring plan
- **KEK alias naming:** `alias/idcaddie-connector-vault-kek-staging` and `alias/idcaddie-connector-vault-kek-prod`
  (the non-secret handle the SDK sender / key provider take as `kekId` — PR #113/#114/#115).
- **Staging vs production KEK separation:** distinct keys / aliases / IAM principals / regions (distinct
  accounts where feasible); a staging credential can never decrypt a production secret, or vice versa.
- **IAM principal:** the runner host's IAM identity (an instance/task role or OIDC federation — NOT a static
  user).
- **Allowed actions: `kms:GenerateDataKey` + `kms:Decrypt` ONLY**, scoped by `Resource` to the single
  connector-vault KEK alias/ARN. **No `kms:*`** (no `CreateKey`/`ScheduleKeyDeletion`/`PutKeyPolicy`/…) and
  **no `Resource: *`**.
- **No static AWS keys in the repo;** **no AWS keys in any browser/client env** (no `NEXT_PUBLIC_*`). With an
  IAM role the SDK resolves credentials from the default provider chain (PR #115) — preferred, so no AWS keys
  live in app env at all.

### 43.3 Environment / config checklist (server-only; this PR sets none)
- Conceptual server-only vars (already documented §39.5): `CONNECTOR_VAULT_AWS_KMS_REGION`,
  `CONNECTOR_VAULT_KMS_KEY_ID` (+ `_PREVIOUS_KEY_IDS`), `CONNECTOR_OAUTH_STATE_SECRET` (+ `_KEY_ID`), and the
  runner DB connection secret.
- **Server-only** — never `NEXT_PUBLIC_*`, never imported by a `"use client"`/`src/app` path.
- **Staging vs production separation** — distinct values per environment, set by a human on the runner host.
- **Fail-closed when missing** — every reader already returns null / throws a typed redacted error
  (`kmsKeyProviderConfigFromEnv`, `awsKmsConfigFromEnv`, `createAwsKmsSdkSenderFromEnv`,
  `createOAuthPendingExecutor`); an unconfigured deploy is inert, never a weak default.

### 43.4 No-real-token staging verification checklist (human-executed; an agent runs nothing hosted)
1. Verify the runner DB connection (as `connector_runner`) can consume `oauth_pending` ONLY — SELECT + the
   3-column UPDATE; it cannot INSERT/DELETE it or touch `connector_secrets`/`connectors`/`connector_runs`.
2. Verify `oauth_pending` stays deny-all to `anon`/`authenticated` (zero privilege, zero policies — T42/T43).
3. Verify `connector_secrets` stays deny-all to `anon`/`authenticated` (zero privilege, zero policies — T39).
4. Verify the KMS path with a **mock / staging-safe dry-run** (a staging KEK alias or an in-memory fake) — a
   wrap/unwrap round-trip under the runner's staging IAM — **without any provider token**.
5. Verify **no token exchange** happens anywhere in the dry run (the callback route stays inert; no `fetch`).
6. Verify **no credential storage** — nothing is written to `connector_secrets`; no access/refresh token persists.
7. Verify **no browser path can invoke runner operations** (`authenticated`/`anon` cannot consume
   `oauth_pending` or reach the runner; the runner entrypoint is not a route).
8. Verify **no KMS SDK bundle ships to the browser** (`@aws-sdk/client-kms` stays server-only; absent from any
   client bundle).
   Record the evidence (a docs-only verification PR) BEFORE any provider-connector work.

### 43.5 Gates before the first connector
1. The hosted runner DB wiring is implemented AND staging-verified (§43.1/§43.4).
2. The AWS KMS / IAM / KEK staging path is implemented AND staging-verified (§43.2/§43.4).
3. The no-real-token full vault chain (state → consume → KMS dry-run) is verified end-to-end.
4. ONLY THEN may a first low-risk connector skeleton be started.

### 43.6 Explicit non-approval
This plan does **not** approve real token storage; does **not** approve connector sync; does **not** approve
production; does **not** close RISK-001; does **not** unblock cutover. **No OAuth code is exchanged for tokens.
No access token is stored. No refresh token is stored. No connector credentials are stored. No connector secret
material is inserted, updated, deleted, or read. No connector sync is implemented. No provider connector is
implemented. No credential form is implemented. No connect/reconnect/disconnect action is implemented. No
manual or scheduled run action is implemented. No browser-accessible service-role request path is added. No
production data was touched. No hosted commands were run. Connector vault is still not usable for real
credentials until hosted runner/KMS verification is complete. Connector implementation remains blocked.
Old-app parity is not complete. UI/UX parity is not complete. AI/API connector parity is not complete. Upload
is not automatically production-ready. Hosted Auth/tenant-context is verified, but old-app replacement is not
yet verified. RISK-001 remains OPEN. Cutover remains BLOCKED.** No doc 17 §5 box is ticked by this PR.
## 44. Tooling — connector-vault staging dry-run verifier (PR #122)

**Hosted runner/KMS no-real-token verifier is added. The verifier is human-run only. The agent did not run
hosted commands.** `scripts/verify-staging-connector-vault-dry-run.mjs` is the executable form of the §43.4
checklist — a staging-ref-guarded gate a human operator runs to PROVE the hosted runner DB connection (as
`connector_runner`) and the AWS KMS path work WITHOUT storing any real provider credential. It is built on the
`verify-staging-rls-suite.mjs` safety model: **it connects to NOTHING, prints NO secret values, and performs
NO hosted mutation itself** — even the confirmed path only PRINTS an ordered runbook (parameterized psql / KMS
commands referencing shell env VARS by name) that the operator runs and records.

### 44.1 Guards (by construction)
The verifier refuses production. The verifier does not use real provider tokens.
- **The verifier refuses production** (`dzbfxulvxchdemcettrx`); requires the staging ref
  (`ycdpzduxugdsffjqyoai`) from the linked file or an explicit `--ref`.
- Requires an explicit human confirmation phrase (`CONNECTOR_VAULT_DRY_RUN_CONFIRM`) before emitting the
  hosted runbook — default mode REFUSES (exit 1) and is what the agent + tests exercise; `--help` prints usage.
- Requires every hosted secret/config via ENV (`CONNECTOR_RUNNER_DB_URL`, `CONNECTOR_VAULT_AWS_KMS_REGION`,
  `CONNECTOR_VAULT_KMS_KEY_ID`; optional setup/state vars) — **names only; values are never read, printed, or
  interpolated** (the runbook prints the shell var, e.g. `$CONNECTOR_RUNNER_DB_URL`); fail-closed listing the
  missing names.
- **The verifier does not use real provider tokens** — the only payload is the clearly-synthetic non-secret
  sentinel `synthetic-vault-dry-run-not-a-token`.

### 44.2 What the runbook proves (human-run, no real token)
Seed ONE synthetic `oauth_pending` row in a synthetic namespace (idempotent); consume it EXACTLY once as
`connector_runner` (expect 1 row); a second consume + every mismatch (nonce/state/tenant/provider) yields 0
rows; `connector_runner` is DENIED on `connector_secrets` (permission denied); `oauth_pending`/
`connector_secrets` stay deny-all to `anon`/`authenticated` (T39/T42/T43/§41); KMS wraps/unwraps the synthetic
payload via the KEK alias (GenerateDataKey + Decrypt only); narrow cleanup by the synthetic key; record
evidence. **No browser route is involved** (the runner is not a route; the callback stays inert).

### 44.3 Tests (+11; app 253 → 266) — mocks only, no hosted call
refuses production; fails closed off-staging / no ref file; refuses with no confirmation (and emits no
runbook, runs no mutation); refuses when confirmed but a required env is missing; emits the runbook only when
confirmed + staging + env present (and still opens no connection); **redacts secrets** (never prints an env
value — references vars by name); uses only the synthetic payload (no provider-token strings); never prints a
`connector_secrets` write (it proves the runner is denied); `--help` exits 0; source imports only `node:fs`
(no DB driver / aws-sdk / supabase client / fetch). The agent runs only `node --check` + these mock tests —
**The agent did not run hosted commands.**

**The verifier does not exchange OAuth codes for tokens. The verifier does not store access tokens. The
verifier does not store refresh tokens. The verifier does not store connector credentials. The verifier does
not insert, update, delete, or read connector secret material. The verifier does not implement connector sync.
The verifier does not implement provider connectors. The verifier does not implement credential forms. The
verifier does not add connect/reconnect/disconnect actions. The verifier does not add manual or scheduled run
actions. The verifier does not add browser-accessible service-role request paths. No OAuth code is exchanged
for tokens. No access token is stored. No refresh token is stored. No connector credentials are stored. No
connector secret material is inserted, updated, deleted, or read. No connector sync is implemented. No provider
connector is implemented. No credential form is implemented. No connect/reconnect/disconnect action is
implemented. No manual or scheduled run action is implemented. No browser-accessible service-role request path
is added. No production data was touched. No hosted commands were run by the agent. Connector vault is still
not usable for real credentials until the human-run staging dry run is executed and recorded. Connector
implementation remains blocked. Old-app parity is not complete. UI/UX parity is not complete. AI/API connector
parity is not complete. Upload is not automatically production-ready. Hosted Auth/tenant-context is verified,
but old-app replacement is not yet verified. RISK-001 remains OPEN. Cutover remains BLOCKED.** No doc 17 §5
box is ticked by this PR.
## 45. Operator procedure — human-run connector-vault staging dry run (PR #123)

**Human-run staging dry-run procedure is recorded.** This is the exact, ordered checklist a human operator
follows to run the §44 verifier (`scripts/verify-staging-connector-vault-dry-run.mjs`) on staging and capture
the no-real-token evidence — the §43.5 gate before any first connector. Docs-only. **No hosted commands were
run by the agent. No production data was touched.** The agent authored this checklist; a human executes it.

### 45.1 Preconditions (operator confirms locally — no mutation)
1. **Confirm the staging ref is `ycdpzduxugdsffjqyoai`** — `cat supabase/.temp/project-ref` returns exactly
   `ycdpzduxugdsffjqyoai` (or you pass `--ref ycdpzduxugdsffjqyoai`).
2. **Confirm production is NOT linked** — the linked ref is NOT `dzbfxulvxchdemcettrx`. (The verifier hard-
   refuses production; this is a belt-and-suspenders check before you start.)

### 45.2 Provision OUTSIDE the repo (operator; never committed)
3. **Provision the runner DB connection as `connector_runner`** — a server-only Postgres connection bound to
   the `connector_runner` role (NOLOGIN + BYPASSRLS, ONLY `oauth_pending` SELECT + the 3-column UPDATE —
   `0021`/T43/§41). Keep the connection string ONLY in the runner host's secret manager / your shell; never
   commit it, never put it in an app env or a client bundle.
4. **Provision the staging AWS IAM / KMS / KEK alias** — a staging KEK alias
   (`alias/idcaddie-connector-vault-kek-staging`) + an IAM role granted ONLY `kms:GenerateDataKey` +
   `kms:Decrypt` scoped to that KEK (no `kms:*`, no `Resource: *`); no static AWS keys (prefer the instance/
   task role via the default provider chain). Distinct from production.
5. **Export the required env vars locally, WITHOUT committing them** — in your shell only (e.g. a sourced
   untracked file): `CONNECTOR_RUNNER_DB_URL`, `CONNECTOR_VAULT_AWS_KMS_REGION`, `CONNECTOR_VAULT_KMS_KEY_ID`
   (optional `CONNECTOR_VAULT_SETUP_DB_URL`, `CONNECTOR_OAUTH_STATE_SECRET`). The verifier reads only their
   PRESENCE and never prints their values.

### 45.3 Run the verifier (operator)
6. **Run the dry-run verifier with the explicit confirmation phrase:**
   `CONNECTOR_VAULT_DRY_RUN_CONFIRM="RUN CONNECTOR VAULT STAGING DRY RUN" node scripts/verify-staging-connector-vault-dry-run.mjs`
   It prints the ordered runbook (it connects to nothing); execute each runbook step against staging in your
   shell, using the synthetic non-secret payload `synthetic-vault-dry-run-not-a-token` only — **no real
   provider token**.

### 45.4 Capture evidence (operator records PASS/FAIL per item — no secrets/URLs/DEKs/ciphertext)
7. Capture, item by item:
   - the verifier **refused production** (run it once with the production ref / `--ref dzbfxulvxchdemcettrx`
     and confirm it exits non-zero);
   - the verifier **confirmed staging** (`ycdpzduxugdsffjqyoai`);
   - the runner **consume path succeeds exactly once** (one synthetic `oauth_pending` row → 1 row consumed);
   - a **second consume fails** (0 rows — single-use);
   - **mismatch cases fail safely** (wrong nonce / state / tenant / provider → 0 rows each);
   - **`connector_secrets` remains inaccessible** (the runner is denied; anon/authenticated deny-all holds);
   - **no real provider token was used** (only the synthetic sentinel);
   - **no OAuth code was exchanged**; **no access token was stored**; **no refresh token was stored**;
   - **no connector sync ran**; **no browser route invoked runner operations**.
8. **Record the evidence in the next docs-only verification PR** (PASS/FAIL, table by table; redact all
   secrets/URLs). That recorded green run is the §43.5 evidence; it does NOT store real credentials, does NOT
   close RISK-001, and does NOT unblock cutover.

**No real provider token is used. No OAuth code is exchanged for tokens. No access token is stored. No refresh
token is stored. No connector credentials are stored. No connector secret material is inserted, updated,
deleted, or read. No connector sync is implemented. No provider connector is implemented. No credential form is
implemented. No browser-accessible service-role request path is added. Connector implementation remains blocked
until human-run staging dry-run evidence is recorded. Old-app parity is not complete. UI/UX parity is not
complete. AI/API connector parity is not complete. Upload is not automatically production-ready. Hosted
Auth/tenant-context is verified, but old-app replacement is not yet verified. RISK-001 remains OPEN. Cutover
remains BLOCKED.** No doc 17 §5 box is ticked by this PR.
## 46. Staging dry-run preflight — BLOCKED on IPv6-only DB host (PR #124)

**Human-run staging dry-run preflight was attempted.** The operator began the §45 procedure against staging
(`ycdpzduxugdsffjqyoai`; production `dzbfxulvxchdemcettrx` not touched; main `46254e9` / PR #123) and hit a
network blocker before any dry-run step ran. This records the attempt + the blocker. Docs-only. **No
production data was touched. No hosted commands were run by the agent** (the agent recorded the operator's
report; it ran nothing hosted).

### 46.1 What the operator provisioned (staging only)
- **connector_runner_login was created on staging** — a LOGIN role for the runner to authenticate as.
  **connector_runner_login is LOGIN and NOINHERIT. connector_runner_login is not BYPASSRLS.**
  **connector_runner remains NOLOGIN and BYPASSRLS** (`0021`/T43/§41 — unchanged). **connector_runner_login
  is granted connector_runner** (so the login role `set role connector_runner`s to get the narrow,
  BYPASSRLS-constrained consume privileges; it does NOT inherit them ambiently — NOINHERIT). The login role
  itself holds no direct table privilege and is not BYPASSRLS, so an un-`set role` session has nothing.

### 46.2 The blocker — IPv6-only direct DB host
- **The staging direct DB host resolves only to IPv6 from the operator environment.** `db.ycdpzduxugdsffjqyoai.supabase.co`
  has **no IPv4 A record** from the operator network and **has an IPv6 AAAA record** only.
- **The Supabase IPv4 add-on was not enabled** (the operator chose not to). So `psql` connectivity from the
  operator Mac is blocked by DNS/network reachability (no IPv4 route; the local network/path is not
  IPv6-capable to that host).
- Consequence: the direct-DB steps of the dry run cannot run from the operator's current environment.

### 46.3 What did NOT happen (the dry run did not run)
**The dry-run was not executed.** The dry-run verifier was not executed against staging.
**No dry-run oauth_pending seed was inserted.** No `oauth_pending` row was inserted by the dry run.
**No runner consume was executed.** No second-consume check was executed. No mismatch consume checks were
executed. **No KMS dry-run was executed.** No `connector_secrets` access was attempted through the dry run.
**No real provider token was used. No OAuth code was exchanged for tokens. No access token was stored. No
refresh token was stored. No connector credentials are stored. No connector secret material was inserted,
updated, deleted, or read. No connector sync was implemented. No provider connector was implemented.**

### 46.4 Resolution path
The Supabase IPv4 add-on was not enabled. connector_runner_login is granted connector_runner. The dry-run must be executed from an IPv6-capable runner host or environment.
**The dry-run must be executed from an IPv6-capable runner host or environment** — i.e. run the §44 verifier
runbook from a host that can reach `db.ycdpzduxugdsffjqyoai.supabase.co` over IPv6 (a runner box / CI / cloud
shell with IPv6, or the Supabase pooler/IPv4 add-on if the operator later opts in), then record the evidence
in the next docs-only verification PR. This does not change the verifier, the runner role model, or any
deny-all posture — it is purely where the human runs it from.

**Connector implementation remains blocked** until the no-real-token dry run is executed from an IPv6-capable
runner host and the evidence is recorded. **Old-app parity is not complete. UI/UX parity is not complete.
AI/API connector parity is not complete. Upload is not automatically production-ready. Hosted Auth/tenant-
context is verified, but old-app replacement is not yet verified. RISK-001 remains OPEN. Cutover remains
BLOCKED.** RLS suite unchanged (**387**); no migration; no code. No doc 17 §5 box is ticked by this PR.
## 47. Staging dry-run — PASS (no-real-token evidence) (PR #125)

**Human-run no-real-token staging dry run was executed** — and PASSED. The operator ran the §44/§45 runbook
against staging (`ycdpzduxugdsffjqyoai`; production `dzbfxulvxchdemcettrx` not touched; main `d3a5289` /
PR #124) from a host that could reach the IPv6-only DB. This records the evidence. Docs-only. **No production
data was touched. No hosted commands were run by the agent** (the agent recorded the operator's report).

### 47.1 IPv6 blocker resolved
**The dry run was executed from an IPv6-capable EC2 host. The staging DB IPv6 connectivity blocker (§46) was
resolved by running from the EC2 host.** The EC2 host resolved the staging DB AAAA record and connected to
`db.ycdpzduxugdsffjqyoai.supabase.co:5432`. Evidence host: EC2 instance `i-00335d464d6f7c299`; runner role
`arn:aws:sts::833822972703:assumed-role/idc-runner-role/i-00335d464d6f7c299`.

### 47.2 Runner DB path — PASS
- **connector_runner_login connected successfully** — `current_user`/`session_user` = `connector_runner_login`.
- **connector_runner_login successfully SET ROLE connector_runner** — after `set role`, `current_user` =
  `connector_runner`, `session_user` = `connector_runner_login`.
- **connector_runner_login had zero direct table grants** (it holds nothing ambiently; it must `set role`).
- **connector_runner was denied access to connector_secrets** — `permission denied` on
  `public.connector_secrets` (the runner has NO grant there — `0021`/T43/§41).
- Tenant A existed (`aaaa1111-1111-1111-1111-111111111111` / "Storage Verifier Tenant A"). A synthetic
  `oauth_pending` row was inserted for Tenant A (state_jti `dryrun-state-jti-tenant-a`, provider `dryrun`,
  sentinel `synthetic-vault-dry-run-not-a-token`). **The first connector_runner consume returned exactly one
  row. The second connector_runner consume returned zero rows** (single-use proven). **The synthetic dry-run
  oauth_pending row was cleaned up** (narrow delete by the synthetic key; no dry-run row remained
  intentionally).

### 47.3 KMS path — PASS (least privilege confirmed)
KMS alias `alias/idcaddie-staging-connector-vault` (key ARN observed from the operator Mac:
`arn:aws:kms:ca-central-1:833822972703:key/a1b7eaa9-5ed6-4fb9-8a19-f610c6407d5f`). From the EC2 runner role:
- **KMS GenerateDataKey succeeded from the EC2 runner role.**
- **KMS Decrypt succeeded from the EC2 runner role.**
- **KMS DescribeKey was denied from the EC2 runner role as expected least-privilege behavior** — the runner
  IAM policy intentionally allows ONLY `GenerateDataKey` + `Decrypt`; the `DescribeKey` denial is the
  least-privilege guard working, NOT a dry-run failure.
- Synthetic envelope round trip passed: `PASS_DEK_UNWRAP`, `PASS_SYNTHETIC_PAYLOAD_ROUNDTRIP`,
  `PASS_KMS_SYNTHETIC_NO_REAL_TOKEN_DRY_RUN`.

### 47.4 What this gate does — and does NOT — change
Evidence (verbatim): Human-run no-real-token staging dry run was executed. The staging DB IPv6 connectivity blocker was resolved by running from the EC2 host. connector_runner_login connected successfully. connector_runner_login successfully SET ROLE connector_runner. connector_runner_login had zero direct table grants. connector_runner was denied access to connector_secrets. A synthetic oauth_pending row was inserted for Tenant A. The first connector_runner consume returned exactly one row. The second connector_runner consume returned zero rows. The synthetic dry-run oauth_pending row was cleaned up. KMS GenerateDataKey succeeded from the EC2 runner role. KMS Decrypt succeeded from the EC2 runner role. KMS DescribeKey was denied from the EC2 runner role as expected least-privilege behavior.
**First low-risk connector skeleton is now unblocked, but real token storage remains gated until a
provider-specific connector PR is reviewed and verified.** The runner DB + KMS path is proven end-to-end with
a synthetic payload only — no real credential ever touched it.

**No real provider token was used. No OAuth code was exchanged for tokens. No access token was stored. No
refresh token was stored. No connector credentials are stored. No connector secret material was inserted,
updated, deleted, or read. No connector sync was implemented. No provider connector was implemented. No
production data was touched. Old-app parity is not complete. UI/UX parity is not complete. AI/API connector
parity is not complete. Upload is not automatically production-ready. Hosted Auth/tenant-context is verified,
but old-app replacement is not yet verified. RISK-001 remains OPEN. Cutover remains BLOCKED.** RLS suite
unchanged (**387**); no migration; no code. No doc 17 §5 box is ticked by this PR.
## 48. Implementation — connector provider registry skeleton (PR #126)

**Connector provider registry skeleton is added. The registry is generic for future SaaS app connectors.
Slack is added as the first inert provider skeleton.** This is the first connector implementation step after
the §47 no-real-token dry-run gate cleared — the provider abstraction that can eventually back many SaaS
connectors, proven now with ONE inert entry. **No provider connector is functional yet.**
`src/lib/server/connector-vault/provider-registry.ts` ships PURE, SAFE METADATA only.

### 48.1 Shape
- `ConnectorProviderDefinition` — safe display/metadata only: `id`, `displayName`, `category`, `authKind`
  (`oauth2`/`api_key` — a label, no secret handling), `capabilities` (`read_users`/`read_apps`/`read_groups`/
  `read_audit`/`read_usage` — display), `status` (`skeleton`/`not_connected`/`disabled`/`future`),
  `reviewGate`, `riskLevel`, `requiredScopes` (DISPLAY-ONLY — never used to build an OAuth request),
  `helpCopy`, `enabled` (default false). NO field holds or references a token/secret/authorize-URL.
- The id type space is generic (`slack`, `google_workspace`, `okta`, `microsoft_entra`, `zoom`, `atlassian`,
  `github`) but only ONE entry is DEFINED now.
- **Slack (inert):** `slack` / "Slack" / `collaboration` / `oauth2` / status `skeleton` / `enabled: false` /
  `riskLevel: low` / `reviewGate: provider-specific-reviewed-pr` / capabilities + scopes as metadata only.
  No OAuth URL is generated; no token exchange; no token storage; no API call.
- Helpers: `listConnectorProviders()`, `getConnectorProvider(id)`, `isSupportedConnectorProvider(id)`,
  `getProviderCapabilities(id)`, `isConnectorProviderReady(id)`.

### 48.2 Fail closed
An unknown/malformed id returns `null` / `[]` / `false`. The registry has NO connect / exchange / sync /
store function — those simply do not exist in this metadata module, so a skeleton provider cannot be used for
them. `isConnectorProviderReady` returns true ONLY when a provider is explicitly `enabled` AND in the
`not_connected` status — every entry today is an inert `skeleton`/`enabled:false`, so it returns false for
all of them. **Real token storage remains gated behind a later provider-specific reviewed PR.**

### 48.3 Posture (unchanged) + tests (+7; app 266 → 273)
Server-only (sentinel + `no-client-import` guard; pure TS data — zero imports). No UI change (the read-only
`/connectors` page already says "coming soon / not built"; the registry is not imported by any app route yet).
No migration; RLS suite unchanged **387**. Tests: lists only safe metadata fields (no token/secret/url value
in the structural fields); Slack skeleton exists + is inert (oauth2, disabled, not ready); supported-check +
capabilities resolve; unknown/malformed fails closed (null/false/[]); NO provider is ready (all inert);
module purity (no createClient/process.env/fetch/connector_secrets/service_role/access_token/refresh_token/
token_endpoint/grant_type/oauth-authorize/https/sync-fn); the OAuth callback route still inert.

**No OAuth code is exchanged for tokens. No access token is stored. No refresh token is stored. No connector
credentials are stored. No connector secret material is inserted, updated, deleted, or read. No connector sync
is implemented. No provider API call is made. No credential form is implemented. No connect/reconnect/
disconnect action is implemented. No browser-accessible service-role request path is added. No production data
was touched. No hosted commands were run. Connector vault is still not usable for real credentials until the
remaining gated PRs are complete. Connector implementation remains blocked. Old-app parity is not complete.
UI/UX parity is not complete. AI/API connector parity is not complete. Upload is not automatically
production-ready. Hosted Auth/tenant-context is verified, but old-app replacement is not yet verified. RISK-001
remains OPEN. Cutover remains BLOCKED.** No doc 17 §5 box is ticked by this PR.
## 49. Implementation — Slack OAuth authorize/callback skeleton (PR #127)

**Slack OAuth authorize/callback skeleton is added. The Slack provider remains non-functional for real
connections.** The first provider-specific connector module — it builds the Slack authorize-redirect URL and
classifies the Slack callback, integrating the existing `oauth-state` signer + the `oauth_pending` replay
shape + the provider registry (§48). It exchanges NO code, stores NO token/credential, touches NO
`connector_secrets`, calls NO Slack API, and marks NO connector connected.
`src/lib/server/connector-vault/providers/slack-oauth.ts`.

### 49.1 Authorize URL builder
`buildSlackAuthorizeUrl(input)` → `{ ok:true, url, stateJti, nonceHash, expiresAt } | { ok:false, reason }`.
It builds `https://slack.com/oauth/v2/authorize?client_id=…&scope=…&redirect_uri=…&state=…` where `state`
is a SIGNED state from `createOAuthState` (the §31 signer boundary). `client_id` is INJECTED (server-only
config / explicit input — never hardcoded, never read from env here). `redirect_uri` is validated (absolute
HTTPS only — `javascript:`/`http:`/`data:`/relative rejected). Scopes default to the registry's Slack DISPLAY
scopes (metadata only). It returns the **oauth_pending alignment values** a FUTURE PR persists at
authorize-time: `stateJti = sha256(state)`, `nonceHash = sha256(nonce)` — one-way hashes; the raw nonce/state
are NEVER persisted. Fail-closed reasons: `wrong_provider`/`missing_client_id`/`missing_redirect_uri`/
`invalid_redirect_uri`/`missing_signer`/`missing_scopes`/`invalid_context`. **The Slack token endpoint
(`oauth.v2.access`) is never built or called.**

### 49.2 Callback validation/classification
`classifySlackCallback(searchParams, opts)` → a SAFE outcome: `provider_error` (Slack `?error=…` cancel —
the raw value is never surfaced) / `not_configured` (no signer wired — the skeleton default) / `invalid`
(`wrong_provider`/`missing_code`/ or an `oauth-state` reason: missing/malformed/bad-signature/expired/
replayed/mismatch) / `received` (a well-formed, valid Slack callback we WOULD consume — returning ONLY the
future-consume keys `stateJti`/`nonceHash`, both one-way hashes). It validates the signed state via
`validateOAuthState`, checks `code` PRESENCE only (the value is never read/returned/logged), and **performs
NO token exchange, NO Slack call, NO `connector_secrets` write, and marks NO connector connected.**

### 49.3 Posture (unchanged) + tests (+15; app 273 → 288)
Server-only (sentinel + `no-client-import` guard; imports only `../oauth-state`, `../provider-registry`,
`node:crypto`). The live `/connectors/oauth/callback` route is UNCHANGED + still inert (no Slack-code
exchange; a static scan re-asserts no `fetch`/`oauth.v2.access`/`connector_secrets`/token). No connect button
/ no UI change. No migration; RLS suite unchanged **387**. The registry still lists Slack as an inert
`skeleton`/`enabled:false` (this skeleton does not flip it). Tests: authorize URL host/path + safe params;
state/nonce bound via the existing signer + alignment hashes; fail-closed on missing client_id/redirect_uri/
signer + unsafe redirect_uri + non-slack provider; callback accepts a valid shape but returns NO
token-exchange action; error/cancel safe; fail-closed on missing code + missing/invalid/tampered state +
wrong provider; module purity (no fetch/createClient/process.env/connector_secrets/service_role/access_token/
refresh_token/client_secret/grant_type/oauth.v2.access/kms; only the authorize URL, never `slack.com/api`).

**No Slack OAuth code is exchanged for tokens. No Slack access token is stored. No Slack refresh token is
stored. No connector credentials are stored. No connector secret material is inserted, updated, deleted, or
read. No Slack API call is made. No connector sync is implemented. No credential form is implemented. No
connect/reconnect/disconnect action is exposed to users. No browser-accessible service-role request path is
added. Real token storage remains gated behind a later provider-specific reviewed PR. No production data was
touched. No hosted commands were run. Connector implementation remains blocked. Old-app parity is not
complete. UI/UX parity is not complete. AI/API connector parity is not complete. Upload is not automatically
production-ready. Hosted Auth/tenant-context is verified, but old-app replacement is not yet verified. RISK-001
remains OPEN. Cutover remains BLOCKED.** No doc 17 §5 box is ticked by this PR.
## 50. Implementation — Slack authorize-time oauth_pending persist (PR #128)

**Slack authorize-time oauth_pending persistence is added. Slack authorize creates a replay-protection row
for a future callback consume step.** It composes the §49 Slack authorize-URL builder with the `oauth_pending`
replay-store shape: at authorize-time it creates the single-use row a FUTURE callback PR consumes exactly
once (§38, PR #116/#120). **Slack remains non-functional for real connections.** It exchanges NO code, stores
NO token/credential, touches NO `connector_secrets`, calls NO Slack API, marks NO connector connected, and
creates NO sync run. `src/lib/server/connector-vault/providers/slack-authorize-pending.ts` — library-only (no
route / server action / connect button).

### 50.1 The INSERT is an injected seam (not a request-path write, no migration)
`oauth_pending` is Tier-2 deny-all to anon/authenticated (`0020`), and `connector_runner` was granted
SELECT + UPDATE but **deliberately NOT INSERT** (`0021` deferred authorize-time create). So a request-path
Supabase client CANNOT write this row — and this PR adds **NO migration and NO global service-role client**.
Instead the privileged INSERT is delegated to an injected `SlackPendingInserter` (the runner-identity-backed
inserter, with the future INSERT grant, is a later gated PR). Tests inject a mock — NO live DB write, NO
credentials in tests. (RLS suite unchanged **387**; the deny-all posture is untouched.)

### 50.2 `persistSlackAuthorizePending(input, inserter)`
→ `{ ok:true, url, stateJti, expiresAt } | { ok:false, reason }`. It validates the inserter is present, the
Slack provider is supported (registry), and the tenant context (tenant required; organization_id/subject
optional + validated if present — matching the nullable `0020` columns); builds the authorize URL via
`buildSlackAuthorizeUrl` (which validates clientId/redirectUri[https-only]/signer/scopes and returns the
one-way hashes); then inserts ONE row `{ tenant_id, organization_id?, provider:'slack', connector_id?,
subject?, state_jti = sha256(state), nonce_hash = sha256(nonce), intent:'connect', expires_at }`.
**Raw nonce is not stored. Raw state is not stored** — the raw nonce is NEVER materialized here (the builder
returns only hashes), so it can never be stored, returned, or logged; the result returns the authorize URL
(the signed `state` is the intended redirect carrier) + safe metadata only.

### 50.3 Fail closed
Raw nonce is not stored. Raw state is not stored.
Missing inserter → `missing_inserter`; unsupported provider → `unsupported_provider`; missing/garbage tenant
(or org/subject) → `missing_tenant`; bad config (client_id/redirect_uri/signer/scopes/unsafe redirect) → the
builder's safe reason (never reaching the insert); a UNIQUE(state_jti|nonce_hash) conflict → `duplicate_pending`;
any other DB failure → `persist_failed`. No partial row on any failure.

### 50.4 Posture (unchanged) + tests (+12; app 288 → 300)
Server-only (sentinel + `no-client-import` guard; imports only `./slack-oauth`, `../provider-registry`,
`../oauth-state` types — no DB client, no `node:crypto`). The live `/connectors/oauth/callback` route is
UNCHANGED + still inert. No connect button / no UI change. The registry still lists Slack as an inert
`skeleton`/`enabled:false` (this persist step does not flip it). Tests: persists exactly one row (provider
slack, ids, intent connect, hashes); stores `state_jti`/`nonce_hash` — never the raw state/nonce (asserts the
raw nonce + raw state string are absent from the row + result); fresh-connect null vs re-auth connector_id;
fail-closed on duplicate / DB error / missing inserter / missing tenant / missing config / unsafe redirect;
module purity (no fetch/createClient/process.env/connector_secrets/service_role/access_token/refresh_token/
client_secret/grant_type/oauth.v2.access/kms/@supabase); callback route still inert.

**No Slack OAuth code is exchanged for tokens. No Slack access token is stored. No Slack refresh token is
stored. No connector credentials are stored. No connector secret material is inserted, updated, deleted, or
read. No Slack API call is made. No connector sync is implemented. No credential form is implemented. No
connect/reconnect/disconnect action is exposed to users. No browser-accessible service-role request path is
added. Real token storage remains gated behind a later provider-specific reviewed PR. No production data was
touched. No hosted commands were run. Connector implementation remains blocked. Old-app parity is not
complete. UI/UX parity is not complete. AI/API connector parity is not complete. Upload is not automatically
production-ready. Hosted Auth/tenant-context is verified, but old-app replacement is not yet verified. RISK-001
remains OPEN. Cutover remains BLOCKED.** No doc 17 §5 box is ticked by this PR.
## 51. Implementation — connector_runner oauth_pending INSERT grant (PR #129)

**connector_runner oauth_pending INSERT grant is added. The grant is limited to authorize-time replay
protection rows.** Migration `0022_connector_runner_oauth_pending_insert.sql` grants `connector_runner` a
COLUMN-LEVEL INSERT on `public.oauth_pending` — ONLY the 9 §50 authorize-time columns — so the future
runner-backed inserter (PR #128 seam) can create the single-use replay row. This is the grant `0021`
DELIBERATELY DEFERRED ("NO INSERT — authorize-time create is a later PR"); this is that later PR. No Slack
code / app change; no token exchange, no `connector_secrets`, no Slack API, no sync.

### 51.1 The grant (least privilege)
`grant insert (tenant_id, organization_id, connector_id, provider, subject, state_jti, nonce_hash, intent,
expires_at) on public.oauth_pending to connector_runner`. The runner can supply ONLY those 9 columns on
INSERT; `id`/`created_at`/`attempt_count` fall back to DEFAULTs and `consumed_at`/`last_rejected_code` to
NULL, and supplying a NON-granted column (e.g. `consumed_at`, `attempt_count`) on INSERT is permission-denied.
The existing surface is UNCHANGED: SELECT + the 3-column UPDATE (consumed_at/attempt_count/last_rejected_code)
from `0021`; **still NO DELETE / no row-purge / no REFERENCES / no TRIGGER**.

### 51.2 What is NOT granted (unchanged)
No oauth_pending policy is added. No connector_secrets policy is added.
**connector_runner still has no connector_secrets privileges. connector_runner still has no connectors or
connector_runs privileges.** **Anon and authenticated roles still have no oauth_pending write access. Anon and
authenticated roles still have no connector_secrets access.** **No oauth_pending policy is added. No
connector_secrets policy is added** — both stay RLS-on, zero-policy deny-all. `0022` re-asserts the secret-
table deny-all defensively (idempotent — the `0017`/`0018`/`0021` pattern).

### 51.3 Tests (T44; RLS suite **387 → 413**, grant-only — types 0-diff, no app change)
T43's stale "no INSERT" assertions are updated (INSERT is now granted column-scoped — `has_table_privilege`
stays false for a column grant, so the proof uses `has_column_privilege` + `role_column_grants`). New **T44**
proves: the runner's `oauth_pending` INSERT column grant is EXACTLY the 9 authorize-time columns; the runner
can INSERT them but NOT `consumed_at`/`attempt_count`/`last_rejected_code`; **functionally** the runner inserts
an authorize-time row supplying the allowed columns, and a non-granted column (`consumed_at`) on INSERT is
permission-denied; SELECT kept; UPDATE columns still EXACTLY the 3 consume columns; still no DELETE/TRUNCATE/
REFERENCES/TRIGGER; ZERO on connector_secrets/connectors/connector_runs; anon/authenticated deny-all + zero
policies on oauth_pending/connector_secrets unchanged after `0022`.

A human applies `0022` to staging then production in a future step (an agent runs nothing hosted) + records
verification before wiring the real runner inserter. **No Slack OAuth code is exchanged for tokens. No Slack
access token is stored. No Slack refresh token is stored. No connector credentials are stored. No connector
secret material is inserted, updated, deleted, or read. No Slack API call is made. No connector sync is
implemented. Real token storage remains gated behind a later provider-specific reviewed PR. No production data
was touched. No hosted commands were run. Connector implementation remains blocked. Old-app parity is not
complete. UI/UX parity is not complete. AI/API connector parity is not complete. Upload is not automatically
production-ready. Hosted Auth/tenant-context is verified, but old-app replacement is not yet verified. RISK-001
remains OPEN. Cutover remains BLOCKED.** No doc 17 §5 box is ticked by this PR.
## 52. Staging verification — `0022` connector_runner oauth_pending INSERT grant (PR #130)

**Migration 0022 was applied and verified on staging. connector_runner oauth_pending INSERT grant is
staging-verified.** A human applied `0022_connector_runner_oauth_pending_insert.sql` to the staging project
`ycdpzduxugdsffjqyoai` and queried the live role / privilege / policy surface. Production
(`dzbfxulvxchdemcettrx`) was not touched. **The agent ran nothing — no hosted command, no staging mutation,
no secrets. No production data was touched. No hosted commands were run by the agent.**

### 52.1 Observed — PASS
connector_runner can INSERT only authorize-time replay columns.
`supabase migration list --linked` shows `0022` present on both Local and Remote; the linked ref remained
`ycdpzduxugdsffjqyoai`. Roles unchanged: `connector_runner` remains NOLOGIN + BYPASSRLS; `connector_runner_login`
remains LOGIN + NOINHERIT and is not BYPASSRLS; **connector_runner_login has no direct table grants.**
- **The INSERT grant is column-level, not table-level.** `connector_runner does not have table-level INSERT on
  oauth_pending. connector_runner_login does not have table-level INSERT on oauth_pending.` **connector_runner
  can INSERT only authorize-time replay columns** — the column-level INSERT is on EXACTLY:
  `connector_id, expires_at, intent, nonce_hash, organization_id, provider, state_jti, subject, tenant_id`.
  **connector_runner cannot INSERT consumed_at, attempt_count, or last_rejected_code.**
- `connector_runner` keeps table-level SELECT on `oauth_pending` (the columns the runner reads). **connector_runner
  can UPDATE only consumed_at, attempt_count, and last_rejected_code** (the `0021` consume columns — unchanged).
- **connector_runner still has no connector_secrets privileges. connector_runner still has no connectors or
  connector_runs privileges.** `authenticated` still has SELECT on `connectors` and `connector_runs` only.
- **Anon and authenticated roles still have no oauth_pending write access. Anon and authenticated roles still
  have no connector_secrets access.** `anon` has no connector-vault grants. **No oauth_pending policy is added.
  No connector_secrets policy is added** — `pg_policies` shows zero on both; `connectors`/`connector_runs`
  retain only their tenant-member SELECT policies.

This matches the `0022` intent + the local `org_rls_test.sql` T44 proof — the narrow column-level INSERT
landed and the deny-all surface is intact.

### 52.2 Scope / guardrails
This verifies only the `0022` role/grant/policy surface on staging — not any connector behavior (there is
none; the grant is in place but no runner process or app path uses it yet). A human re-applies `0022` to
production in a future step (an agent never runs hosted commands), and wires the real runner inserter only in
a later reviewed PR. **No Slack OAuth code is exchanged for tokens. No Slack access token is stored. No Slack
refresh token is stored. No connector credentials are stored. No connector secret material is inserted,
updated, deleted, or read. No Slack API call is made. No connector sync is implemented. Real token storage
remains gated behind a later provider-specific reviewed PR. No production data was touched. Connector
implementation remains blocked. Old-app parity is not complete. UI/UX parity is not complete. AI/API connector
parity is not complete. Upload is not automatically production-ready. Hosted Auth/tenant-context is verified,
but old-app replacement is not yet verified. RISK-001 remains OPEN. Cutover remains BLOCKED.** No doc 17 §5 box
is ticked by this verification.
## 53. Production verification — connector-vault migrations 0016–0022 (PR #131)

**Production was behind from migration 0016 through 0022. Migrations 0016 through 0022 were applied to
production. Production migration list shows 0001 through 0022 present.** A human applied the connector-vault
migration backlog to the PRODUCTION project `dzbfxulvxchdemcettrx` (staging is `ycdpzduxugdsffjqyoai`), then
returned the local repo to staging. This records the production schema/grant verification. **The agent ran
nothing — no hosted command, no staging/production mutation, no secrets. No production data was touched** (the
agent recorded the operator's report).

### 53.1 What was applied (production was behind)
Before the push, production had `0001`–`0015` remote and was MISSING `0016`–`0022`. The human applied, in
order: `0016_files_uploader_finalize_update.sql`, `0017_connector_vault_schema_foundation.sql`,
`0018_harden_connector_vault_grants.sql`, `0019_connector_run_audit_lifecycle.sql`,
`0020_oauth_pending_replay_store.sql`, `0021_connector_runner_grants.sql`,
`0022_connector_runner_oauth_pending_insert.sql`. After the push, `supabase migration list --linked` showed
`0001`–`0022` present on BOTH Local and Remote. The local repo was returned to staging after verification.

### 53.2 Observed on production — PASS
Production connector_runner_login was created as LOGIN and NOINHERIT. Production connector_runner_login is not BYPASSRLS. Production connector_runner_login has no direct table grants. Production connector_runner can INSERT only authorize-time replay columns.
**Production connector_runner oauth_pending INSERT grant is verified.** Roles: production `connector_runner`
exists, is NOLOGIN + BYPASSRLS; **Production connector_runner_login was created as LOGIN and NOINHERIT**
(by the human operator after the push), **is not BYPASSRLS**, is granted `connector_runner`, and **has no
direct table grants**.
- **The production INSERT grant is column-level, not table-level. Production connector_runner does not have
  table-level INSERT on oauth_pending. Production connector_runner_login does not have table-level INSERT on
  oauth_pending. Production connector_runner can INSERT only authorize-time replay columns** — the column-level
  INSERT is on EXACTLY `connector_id, expires_at, intent, nonce_hash, organization_id, provider, state_jti,
  subject, tenant_id`. `connector_runner` keeps table-level SELECT on `oauth_pending`. **Production
  connector_runner can UPDATE only consumed_at, attempt_count, and last_rejected_code.**
- **Production connector_runner still has no connector_secrets privileges. Production connector_runner still
  has no connectors or connector_runs privileges.** Production `authenticated` has SELECT on `connectors` and
  `connector_runs` only.
- **Production anon and authenticated roles still have no oauth_pending write access. Production anon and
  authenticated roles still have no connector_secrets access.** Production `anon` has no connector-vault
  grants. **No oauth_pending policy is added. No connector_secrets policy is added** — `pg_policies` shows zero
  on both; `connectors`/`connector_runs` retain only their tenant-member SELECT policies.

This matches the `0016`–`0022` intent + the local `org_rls_test.sql` (T1–T44, 413 assertions) — production
schema/grants now mirror staging.

### 53.3 What did NOT happen
**No production dry-run seed was inserted. No production runner consume was executed. No production KMS dry-run
was executed.** No production `oauth_pending` seed; no production `connector_secrets` material was read or
written. **No Slack OAuth code is exchanged for tokens. No Slack access token is stored. No Slack refresh token
is stored. No connector credentials are stored. No connector secret material is inserted, updated, deleted, or
read. No Slack API call is made. No connector sync is implemented.** This was a schema/grant alignment only.

### 53.4 Scope / status
**Production schema/grants are now aligned for the connector-vault foundation, but production connector use
remains blocked.** The grant is in place but no runner process or app path uses it, and the no-real-token
dry-run was run on STAGING only (§47), not production. **Real token storage remains gated behind a later
provider-specific reviewed PR. Connector implementation remains blocked. Old-app parity is not complete. UI/UX
parity is not complete. AI/API connector parity is not complete. Upload is not automatically production-ready.
Hosted Auth/tenant-context is verified, but old-app replacement is not yet verified. RISK-001 remains OPEN.
Cutover remains BLOCKED.** No doc 17 §5 box is ticked by this verification.
## 54. Implementation — runner-backed Slack oauth_pending seams (PR #132)

**Runner-backed Slack oauth_pending seams are wired.** This connects the PR #128 `SlackPendingInserter`
(authorize-time INSERT) and the PR #120/#116 `OAuthPendingConsumer` (callback consume) to a REAL runner DB
execution boundary, using the staging+production-verified `0021`/`0022` `connector_runner` grants (§52/§53).
**Slack remains non-functional for real connections.** It exchanges NO code, stores NO token/credential,
touches NO `connector_secrets`, calls NO Slack API, runs NO sync. `src/lib/server/connector-vault/runner-db-client.ts`
— library/server-only (no route / connect button / browser path).

### 54.1 The runner DB client (injected connection; no DB driver dep, no service-role client)
**The runner DB client uses connector_runner_login with SET ROLE connector_runner.** The runner connects as
`connector_runner_login` (LOGIN + NOINHERIT, no direct grants — §53) and `SET ROLE connector_runner`s into the
narrow grants. The actual connection (a server-only Postgres session bound to `connector_runner_login`) is the
FUTURE hosted runner's concern — provided via an INJECTED `RunnerConnection` seam (`runSequence(statements)`
runs parameterized statements in order on ONE connection). This module owns only the SET-ROLE-wrapping + the
statement shapes; **no DB-driver dependency is added, no global/service-role client is created, and tests
inject a mock** (no live DB call, no credentials). `createRunnerDbClient` / `createRunnerPendingInserter` /
`createRunnerOAuthPendingConsumer` all fail closed (typed `RunnerDbError`) on a missing/invalid connection.

### 54.2 Authorize-time inserter
The authorize-time inserter uses only column-level oauth_pending INSERT grants. The callback consumer uses the existing connector_runner consume grant.
`createRunnerPendingInserter(conn)` is the real `SlackPendingInserter`: it issues `SET ROLE connector_runner`
then a parameterized INSERT. **The authorize-time inserter uses only column-level oauth_pending INSERT grants**
— the INSERT names EXACTLY the 9 `0022`-granted columns `(tenant_id, organization_id, connector_id, provider,
subject, state_jti, nonce_hash, intent, expires_at)`, as bound params. **The authorize-time inserter does not
insert consumed_at, attempt_count, or last_rejected_code** (they fall to their defaults / are set only by the
consume path). It fails closed: a UNIQUE(state_jti|nonce_hash) conflict → `duplicate`; any other failure →
`db_error` — a SAFE reason only, never a raw DB error/value.

### 54.3 Callback consumer
`createRunnerOAuthPendingConsumer(conn)` reuses the §38 `createOAuthPendingExecutor` over the SET-ROLE-wrapping
client — so **the callback consumer uses the existing connector_runner consume grant**: SELECT + the
`consumed_at`/`attempt_count`/`last_rejected_code` UPDATE only, the atomic single-use consume + read-only
classify, each running as `connector_runner`. It returns safe labels only; it does NOT exchange a code, store
a token, or call Slack.

### 54.4 Posture (unchanged) + tests (+13; app 300 → 313)
Server-only (sentinel + `no-client-import` guard; imports only `./oauth-pending-executor`,
`./oauth-pending-consume`, `./providers/slack-authorize-pending`). The live `/connectors/oauth/callback` route
is UNCHANGED + still inert (no `runner-db-client` import). No connect button / no UI change. The registry still
lists Slack as an inert `skeleton`/`enabled:false` (this wiring does not flip it). No migration; RLS suite
unchanged **413**. Tests: inserter emits SET ROLE + a parameterized INSERT of ONLY the 9 columns (never
consumed_at/attempt_count/last_rejected_code); duplicate → fail-closed; DB error redacted; missing connection
fails closed; the run client prepends SET ROLE + redacts errors; the FULL chain (persist authorize row →
runner consume exactly once → second consume `already_consumed`; duplicate persist `duplicate_pending`) over a
mock in-memory connection; the consumer issues SET ROLE before consuming; module purity (no fetch/createClient/
process.env/connector_secrets/service_role/access_token/refresh_token/client_secret/grant_type/oauth.v2.access/
kms/@supabase/pg); callback route still inert.

**No Slack OAuth code is exchanged for tokens. No Slack access token is stored. No Slack refresh token is
stored. No connector credentials are stored. No connector secret material is inserted, updated, deleted, or
read. No Slack API call is made. No connector sync is implemented. No credential form is implemented. No
connect/reconnect/disconnect action is exposed to users. No browser-accessible service-role request path is
added. Real token storage remains gated behind a later provider-specific reviewed PR. No production data was
touched. No hosted commands were run. Connector implementation remains blocked. Old-app parity is not complete.
UI/UX parity is not complete. AI/API connector parity is not complete. Upload is not automatically
production-ready. Hosted Auth/tenant-context is verified, but old-app replacement is not yet verified. RISK-001
remains OPEN. Cutover remains BLOCKED.** No doc 17 §5 box is ticked by this PR.
## 55. Architecture — app discovery connectors + app-graph normalization (PR #133)

**App discovery connector architecture is recorded. Discovery connectors are modeled separately from deep
provider sync runners. App graph normalization is the bridge between discovery signals and ID Caddie app
records.** The Slack path (§48–§54) proved the secure connector-vault / replay / runner / KMS model — but the
product promise is not "one custom connector at a time forever": a customer may use 300+ SaaS apps.
**Discovery connectors are intended to discover many SaaS apps quickly through identity and core systems**
(Okta / Google Workspace / Microsoft Entra / imports / browser extension / later spend-invoice feeds), app-
graph normalization merges those signals into candidate app records, and **deep provider sync runners remain
provider-specific and will be added one at a time** for high-value apps. **The old scraper model is being
replaced with discovery connectors plus provider sync runners** (the old app mixed identity discovery with
many app-specific Firebase-Functions scrapers; the rebuild formalizes that into a safer platform model). This
PR records the architecture as SAFE METADATA / TYPES + a pure helper ONLY — no provider is functional.

### 55.1 Three layers
1. **Discovery connectors** — find apps fast from identity/core systems. Connector `kind`s:
   `identity_provider_discovery`, `spend_invoice_discovery`, `import_source`, `browser_extension_discovery`,
   `manual_source`. Discovery capabilities (display labels): `discover_apps`, `discover_assigned_users`,
   `discover_groups`, `discover_login_activity`, `discover_domains`, `discover_owners`,
   `discover_sso_metadata`, `discover_usage_signals`, `discover_spend_signals`, `import_app_inventory`.
2. **App-graph normalization** — the bridge: it de-duplicates/merges disparate discovery signals into
   `NormalizedAppCandidate` records (the product later reconciles them against real `apps`).
3. **Deep provider sync runners** — `kind: deep_provider_sync`, provider-specific enrichment, added one
   reviewed PR at a time (Slack is the first, still a skeleton).

### 55.2 Provider registry taxonomy (`provider-registry.ts`, extended)
_(Summary: Microsoft Entra is added as an inert future identity-provider discovery connector. Discovery connectors are intended to discover many SaaS apps quickly through identity and core systems.)_
`ConnectorProviderDefinition` gains `kind: ConnectorKind` + `discoveryCapabilities: DiscoveryCapability[]`
(display metadata only). New inert FUTURE identity-provider discovery connectors (status `future`, disabled,
NO code, no OAuth URL, no token, no API): **Okta is added as an inert future identity-provider discovery
connector. Google Workspace is added as an inert future identity-provider discovery connector. Microsoft Entra
is added as an inert future identity-provider discovery connector** — each with display `discoveryCapabilities`
(discover_apps / discover_assigned_users / discover_groups / discover_sso_metadata / …) + display-only scope
labels. Slack stays a `deep_provider_sync` skeleton (existing metadata intact). Helpers (fail closed on
unknown): `listDiscoveryProviders` / `listDeepSyncProviders` / `getProviderDiscoveryCapabilities` /
`isDiscoveryProvider` / `isDeepSyncProvider`. **No provider is ready** (`isConnectorProviderReady` false for
all); discovery providers have NO deep-sync read capabilities and cannot sync or exchange tokens.

### 55.3 App-graph normalization (`app-discovery.ts`, types + one pure helper)
Types: `DiscoveredAppSignal` (sourceProvider, appName, appDomain, externalAppId, assignedUserCount,
loginActivitySignal, usageSignals — safe non-secret counts/labels), `AppMatchStatus`, `NormalizedAppCandidate`
(normalizedName/domain, externalIds, sourceProviders, assignedUserCount, confidence, matchStatus). The ONE
pure helper `normalizeDiscoveredAppSignals(signals)` groups signals by a normalized key (domain else name),
merges sources/ids, takes the max assigned-user count, and scores a naive confidence + match status. It is
deterministic and in-memory: **it writes NO DB / no app-graph row, calls NO provider, stores NO credential.**

### 55.4 Posture + tests (+12; app 313 → 325)
Server-only (sentinel + `no-client-import` guard; both modules are pure — zero imports). No DB write, no
provider API/`fetch`, no OAuth URL for Okta/Google/Microsoft, no token exchange, no credential storage, no
sync, no UI action. No migration; RLS suite unchanged **413**. Tests: the 3 inert identity-discovery entries;
discovery vs deep-sync classified separately + disjoint; Slack stays a non-functional deep-sync skeleton; no
provider is ready; discovery providers expose safe metadata only; unknown fails closed; the normalizer merges/
keeps-distinct/fail-soft and its source imports nothing + writes no DB; registry purity.

**No Okta connector is functional. No Google Workspace connector is functional. No Microsoft Entra connector
is functional. No OAuth code is exchanged for tokens. No access token is stored. No refresh token is stored.
No connector credentials are stored. No connector secret material is inserted, updated, deleted, or read. No
provider API call is made. No connector sync is implemented. No app graph write is implemented. No credential
form is implemented. No connect/reconnect/disconnect action is exposed to users. No browser-accessible
service-role request path is added. Real token storage remains gated behind later provider-specific reviewed
PRs. No production data was touched. No hosted commands were run. Connector implementation remains blocked.
Old-app parity is not complete. UI/UX parity is not complete. AI/API connector parity is not complete. Upload
is not automatically production-ready. Hosted Auth/tenant-context is verified, but old-app replacement is not
yet verified. RISK-001 remains OPEN. Cutover remains BLOCKED.** No doc 17 §5 box is ticked by this PR.
## 56. Implementation — graph-scale discovery indexes (PR #134)

**Graph-scale discovery indexes are added. The indexes are schema-grounded against the current 0001 core
graph tables.** Migration `0023_graph_scale_discovery_indexes.sql` adds 36 indexes preparing the core graph
tables for high-volume Okta/Google/Microsoft discovery data BEFORE those connectors write real volume — index
plumbing only: no column/schema change, no grant, no policy, no RLS-behavior change, no app-graph write, no
canonical vendor/app table.

### 56.1 What the indexes support
Summary (verbatim): The indexes support tenant-scoped RLS hot paths. The indexes support high-volume app_users discovery data. The indexes support app-user and identity-account matching. The indexes support case-insensitive email matching through lower(email) and lower(primary_email). The indexes support vendor/app-name normalization through lower(vendor_name) and lower(name). The app_user_identity_matches model is app_user to person, not app_user to identity_account. No identity_account_id column is introduced. No canonical vendor/app registry is implemented in this PR.
**The indexes support tenant-scoped RLS hot paths** (`tenant_memberships_user_tenant_status_idx`; every graph
table's `tenant_id` / `(tenant_id, status)`). **The indexes support high-volume app_users discovery data**
(`app_users` tenant/app, status, external_user_id). **The indexes support app-user and identity-account
matching** — on `person_id` (`app_user_identity_matches_person_idx`, `identity_accounts_person_idx`), because
**the app_user_identity_matches model is app_user to person, not app_user to identity_account** (and
identity_account → person via `person_id`). **The indexes support case-insensitive email matching through
lower(email) and lower(primary_email)** (`app_users_email_lower_idx`, `identity_accounts_email_lower_idx`,
`people_primary_email_lower_idx`). **The indexes support vendor/app-name normalization through
lower(vendor_name) and lower(name)** (`apps_vendor_name_lower_idx`, `apps_name_lower_idx`,
`contracts_vendor_name_lower_idx`). Plus owning-org joins (apps `procurement_owner_org_id`/`paying_org_id`/
`responsible_org_id`; contracts `procurement_org_id`/`paying_org_id`) + invoices/app_contracts/license rollups.

### 56.2 Schema-grounding (verified against `0001`)
Graph tables have NO `organization_id` (apps use procurement_owner_org_id/paying_org_id/responsible_org_id;
contracts use procurement_org_id/paying_org_id); email columns differ (people.primary_email / app_users.email
/ identity_accounts.email); external-id columns differ (app_users.external_user_id /
identity_accounts.external_id). **No identity_account_id column is introduced** — there is none, so no index
references it. `app_user_identity_matches` already has UNIQUE(app_user_id, person_id), so only the tenant +
person_id indexes are added (no duplicate of that leading-app_user_id unique). **No canonical vendor/app
registry is implemented in this PR** (that is the next design/schema PR). **No app graph write is
implemented.**

### 56.3 Concurrency note
Plain (non-CONCURRENT) `CREATE INDEX` is correct HERE because the graph tables are currently near-empty and
this lands before discovery volume. **If these indexes are ever deferred until AFTER discovery data loads, a
future index migration MUST use `CREATE INDEX CONCURRENTLY`** (which CANNOT run inside a transaction block) to
avoid long write locks.

### 56.4 Tests + posture (T45; RLS suite **413 → 424**; types 0-diff, 1553 lines)
New **T45** re-asserts a representative sample of the 36 indexes exists (RLS hot path, app_users/
identity_accounts discovery, the `*_person_idx` match indexes, the lower(email)/lower(name)/lower(primary_email)
FUNCTIONAL indexes, lower(vendor_name) normalization, owning-org joins, invoices/app_contracts/license) +
the schema-grounding guards (NO `identity_account_id` column on `app_user_identity_matches`; the match graph
is app_user → person; identity_accounts → person via person_id). Migration-safety passes (index-only). No
app/UI/route change; generated DB types unchanged (indexes don't affect types).

**No OAuth code is exchanged for tokens. No access token is stored. No refresh token is stored. No connector
credentials are stored. No connector secret material is inserted, updated, deleted, or read. No provider API
call is made. No connector sync is implemented. No credential form is implemented. No connect/reconnect/
disconnect action is exposed to users. No browser-accessible service-role request path is added. Real token
storage remains gated behind later provider-specific reviewed PRs. No production data was touched. No hosted
commands were run. Connector implementation remains blocked. Old-app parity is not complete. UI/UX parity is
not complete. AI/API connector parity is not complete. Upload is not automatically production-ready. Hosted
Auth/tenant-context is verified, but old-app replacement is not yet verified. RISK-001 remains OPEN. Cutover
remains BLOCKED.** No doc 17 §5 box is ticked by this PR.
## 57. Staging verification — graph-scale discovery indexes `0023` (PR #135)

**Graph-scale discovery indexes are applied and verified on staging.** A human applied
`0023_graph_scale_discovery_indexes.sql` to the staging project `ycdpzduxugdsffjqyoai` (local/main at
`b8acc06` — PR #134) and verified the live index set. **The agent ran nothing — no hosted command, no
staging mutation, no secrets. No production migration was run.**

### 57.1 Observed — PASS
Staging is aligned through migration 0023. The indexes support tenant-scoped RLS hot paths, high-volume discovery, and app/user/account matching. Production is not verified for 0023.
`0023` was MISSING on staging before the push; `supabase db push --linked` applied it successfully; **Staging
is aligned through migration 0023** — `supabase migration list --linked` showed `0001` through `0023` aligned
(Local and Remote). **All 36 expected graph-scale indexes were present on staging after verification** (the
index-verification query returned exactly): tenant_memberships_user_tenant_status_idx, app_users_tenant_app_idx, app_users_email_lower_idx,
app_users_external_user_id_idx, app_users_tenant_status_idx, identity_accounts_tenant_idx,
identity_accounts_person_idx, identity_accounts_email_lower_idx, identity_accounts_external_id_idx,
identity_accounts_tenant_provider_idx, people_tenant_idx, people_primary_email_lower_idx,
people_tenant_employee_status_idx, app_user_identity_matches_tenant_idx, app_user_identity_matches_person_idx,
apps_tenant_status_idx, apps_vendor_name_lower_idx, apps_name_lower_idx, apps_procurement_owner_org_idx,
apps_paying_org_idx, apps_responsible_org_idx, contracts_tenant_status_idx, contracts_vendor_name_lower_idx,
contracts_renewal_date_idx, contracts_procurement_org_idx, contracts_paying_org_idx, invoices_tenant_idx,
invoices_app_idx, invoices_contract_idx, invoices_tenant_invoice_date_idx, app_contracts_contract_idx,
license_evaluations_tenant_idx, license_evaluations_app_user_idx, license_evaluations_app_idx,
license_rules_tenant_idx, license_rules_app_active_idx. **The indexes support tenant-scoped RLS hot paths,
high-volume discovery, and app/user/account matching** — the `lower(email)`/`lower(primary_email)`/
`lower(name)`/`lower(vendor_name)` functional indexes, the `*_person_idx` app_user→person + identity_account→
person match indexes, and the owning-org joins all landed. This matches the `0023` intent + the local
`org_rls_test.sql` T45 proof; staging now mirrors the local schema.

### 57.2 Local validation (before the staging apply)
325 tests passed; the RLS migration tests passed (RLS assertions **424**, `ALL ORG-RLS ASSERTIONS PASSED`);
lint, typecheck, build, auth-safety, and migration-safety all passed; generated DB types remained 1553 lines.

### 57.3 Scope / status
This verifies only that `0023` applied + the 36 indexes exist on staging — not any connector behavior (there
is none). **Production is not verified for 0023** (a human applies it to production in a future step; the agent
never runs hosted commands). **No app code changed. No schema changed in this verification PR. No connector
behavior changed. No provider API call was made. No OAuth code was exchanged for tokens. No access token was
stored. No refresh token was stored. No connector credentials were stored. No connector secret material was
inserted, updated, deleted, or read. No connector sync was implemented. No credential form was implemented. No
connect/reconnect/disconnect action was exposed to users. No browser-accessible service-role request path was
added. No production data was touched. Connector implementation remains blocked. Old-app parity is not
complete. UI/UX parity is not complete. AI/API connector parity is not complete. Upload is not automatically
production-ready. Hosted Auth/tenant-context is verified, but old-app replacement is not yet verified. RISK-001
remains OPEN. Cutover remains BLOCKED.** No doc 17 §5 box is ticked by this verification.
## 58. Production verification — graph-scale discovery indexes `0023` (PR #136)

**Graph-scale discovery indexes are applied and verified on production.** A human applied
`0023_graph_scale_discovery_indexes.sql` to the PRODUCTION project `dzbfxulvxchdemcettrx` (staging is
`ycdpzduxugdsffjqyoai`; local/main `76c68fe` — PR #135), verified the live index set, then relinked local back
to staging. **The production apply and verification were human-run; this PR only records the evidence — the
agent did not touch production, ran no hosted command, and made no staging/production mutation.**

### 58.1 Observed — PASS
Production is aligned through migration 0023. All 36 expected graph-scale indexes were present on production after verification.
`0023` was MISSING on production before the push; `supabase db push --linked` applied it successfully to
production; **Production is aligned through migration 0023** — `supabase migration list --linked` showed
production aligned through `0023` after the push. **All 36 expected graph-scale indexes were present on
production after verification** — the production index-verification query returned `expected_index_count = 36`.
**The indexes support tenant-scoped RLS hot paths, high-volume discovery, and app/user/account matching** (the
`lower(email)`/`lower(primary_email)`/`lower(name)`/`lower(vendor_name)` functional indexes, the `*_person_idx`
app_user→person + identity_account→person match indexes, the tenant/status RLS hot-path indexes, and the
owning-org joins). This matches the §57 staging verification + the local `org_rls_test.sql` T45 proof —
production now mirrors staging + the local schema through `0023`.

### 58.2 Link safety
**Local Supabase link was returned to staging after production verification. Final linked ref was
ycdpzduxugdsffjqyoai** (the production link was used only for the human's apply/verify, then reverted, so no
later command can accidentally hit production).

### 58.3 Scope / status
This verifies only that `0023` applied + the 36 indexes exist on production — not any connector behavior
(there is none; the indexes are inert until discovery data lands). **No app code changed. No schema changed in
this verification PR. No migration changed in this verification PR. No connector behavior changed. No provider
API call was made. No OAuth code was exchanged for tokens. No access token was stored. No refresh token was
stored. No connector credentials were stored. No connector secret material was inserted, updated, deleted, or
read. No connector sync was implemented. No credential form was implemented. No connect/reconnect/disconnect
action was exposed to users. No browser-accessible service-role request path was added. Connector
implementation remains blocked. Old-app parity is not complete. UI/UX parity is not complete. AI/API connector
parity is not complete. Upload is not automatically production-ready. Hosted Auth/tenant-context is verified,
but old-app replacement is not yet verified. RISK-001 remains OPEN. RISK-007 remains OPEN. Cutover remains
BLOCKED.** No doc 17 §5 box is ticked by this verification.
## 59. Design — canonical vendor/product/app-instance graph (PR #137)

**Canonical vendor/product/instance graph design is added. This is net-new moat work, not old-app parity
restoration.** Migration `0024_canonical_app_instance_graph.sql` adds the first schema/design foundation for
canonical vendor → product → app-instance modeling. **The old app was also flat at the app-document level. The
old app had manual overlap-analysis grouping, not automatic canonical app resolution** — so this is net-new
product moat, not a parity restoration. (Note: old manual overlap groups may need to be inventoried/ported
later if OMC depends on them — a separate future task.)

### 59.1 The hierarchy — normalize by grouping, not erasing
`vendor → canonical app/product → app instance/site/workspace → users/contracts/invoices/license facts/
metrics`. **`apps` remains the operational app instance/site/workspace row.** Canonical grouping is layered
ABOVE `apps` via `vendors` / `app_products` (canonical) / `app_aliases` (provenance) + a nullable
`apps.canonical_app_id`. **Distinct app instances must not be collapsed into one app row. Canonical matching
groups related apps for roll-up reporting without erasing instance boundaries.**

### 59.2 Schema added (`0024`)
The old app had manual overlap-analysis grouping, not automatic canonical app resolution. Structured instance identity fields are added to apps.
Three tenant-scoped tables (same-tenant integrity via UNIQUE(id, tenant_id) + composite MATCH-SIMPLE FKs, the
`0005` pattern; RLS = members read + editors INSERT + editors UPDATE, **NO DELETE policy** — the `0004`-
hardened evidence-table posture, since canonical groupings are repointed, not erased):
- **`vendors`** — the vendor family (e.g. "Atlassian"); `name`/`normalized_name`/`website_domain`/`source`.
- **`app_products`** — the CANONICAL app/product (e.g. "Jira"/"Confluence"/"Bitbucket"); `vendor_id` (same-
  tenant composite FK), `name`/`normalized_name`/`category`.
- **`app_aliases`** — source/provenance/alias mapping + the resolver's review record: `app_product_id`,
  `app_id` (the operational instance it came from), `alias_type` (domain/instance_domain/external_instance_id/
  provider_app_id/oauth_client_id/sso_app_id/name), `alias_value`, `source`, and the audit/review fields
  reusing the `app_user_identity_matches` pattern — `confidence numeric(5,2)`, `review_status`, `reviewed_by`,
  `reviewed_at`, `provenance jsonb`.

**Structured instance identity fields are added to apps:** `canonical_app_id` (nullable, same-tenant FK to
`app_products`), `instance_domain`, `external_instance_id`, `instance_url`. **instance_domain and
external_instance_id are future merge/no-merge discriminators** (the current v3 `apps` row had no safe
instance discriminator). Indexes for the new tables + the new `apps` canonical/instance fields.

### 59.3 Multi-instance support (Atlassian)
Vendor **Atlassian** → canonical products **Jira / Confluence / Bitbucket** → instances **Jira/Flywheel
(flywheel.atlassian.net), Jira/Perpetua (perpetua.atlassian.net), Confluence/Flywheel
(flywheel.atlassian.net/wiki)** — each a separate `apps` row grouped under one `app_product`, never collapsed.
**Existing app_contracts already supports one contract linked to many app instances** (its `(app_id,
contract_id)` many-to-many PK) — **no replacement for app_contracts is added.** Separate invoices per instance
already work (`invoices.app_id` + `apps.paying_org_id`). **One-invoice-split-across-orgs is documented as
future work only** (a secondary gap; no invoice-allocation rows in this PR).

### 59.4 Metrics + resolver (documented; not implemented)
- **Canonical user rollups must count distinct person_id after identity matching, not sum app_users naively**
  — per-instance counts may use `app_users`, but at the canonical/vendor level a user is distinct `person_id`
  once the app_user→person matching engine exists. **Canonical rollups depend on the app_user to person
  matching engine.**
- **Future resolver (NOT implemented):** deterministic keys first (`instance_domain`, `external_instance_id`,
  `domain`, provider app id, OAuth client id, SSO app id); owner/paying/responsible org influences merge/
  no-merge; same vendor/product but a different `instance_domain`/`external_instance_id` groups under the same
  canonical app but stays separate `apps` rows; low confidence → human review (reusing confidence/reviewed_by/
  reviewed_at); unmerge by repointing aliases/`canonical_app_id`, NOT by rewriting historical users/contracts/
  invoices. **No automatic resolver is implemented.**

### 59.5 Tests + posture (T46; RLS suite **424 → 446**; types 1553 → 1744)
T46 proves: the 3 new tables are RLS-enabled with EXACTLY {SELECT, INSERT, UPDATE} policies (no DELETE/ALL);
functional tenant isolation (a Tenant A member reads its vendor/product, a Tenant B member cannot, a
cross-tenant insert is RLS-denied); the `apps` canonical/instance columns exist; `app_contracts` is unchanged
(its `(app_id, contract_id)` PK intact, no canonical/instance columns); **No identity_account_id is
introduced** (none on any new table or `apps`); the `app_aliases` audit fields exist; `connector_secrets`
still has zero policies (untouched). Migration-safety passes; generated types update for the new schema.

**No app graph writes are implemented. No provider API call is made. No OAuth code is exchanged for tokens. No
access token is stored. No refresh token is stored. No connector credentials are stored. No connector secret
material is inserted, updated, deleted, or read. No connector sync is implemented. No credential form is
implemented. No connect/reconnect/disconnect action is exposed to users. No browser-accessible service-role
request path is added. No production data was touched. No hosted commands were run. Connector implementation
remains blocked. Old-app parity is not complete. UI/UX parity is not complete. AI/API connector parity is not
complete. Upload is not automatically production-ready. Hosted Auth/tenant-context is verified, but old-app
replacement is not yet verified. RISK-001 remains OPEN. RISK-007 remains OPEN. Cutover remains BLOCKED.** No
doc 17 §5 box is ticked by this PR.
## 60. Staging verification — canonical app graph `0024` (PR #138)

**Canonical app graph schema is applied and verified on staging.** A human applied
`0024_canonical_app_instance_graph.sql` to the staging project `ycdpzduxugdsffjqyoai` (local/main `400eafa` —
PR #137) and verified the live schema. **The staging apply and verification were human-run; this PR only
records the evidence — the agent did not touch staging, ran no hosted command, and made no staging/production
mutation.**

### 60.1 Observed — PASS
Staging is aligned through migration 0024. Production is not verified for 0024.
`0024` was MISSING on staging before the push; `supabase db push --linked` applied it successfully to staging;
**Staging is aligned through migration 0024** — `supabase migration list --linked` showed staging aligned
through `0024` after the push. Staging verification confirmed the three canonical graph tables and the new
`apps` columns are present:
- **The vendors table is present on staging.**
- **The app_products table is present on staging.**
- **The app_aliases table is present on staging.**
- **apps.canonical_app_id is present on staging.**
- **apps.instance_domain is present on staging.**
- **apps.external_instance_id is present on staging.**
- **apps.instance_url is present on staging.**

This matches the §59 design + the local `org_rls_test.sql` T46 proof; staging now mirrors the local schema
through `0024`. **apps remains the operational app instance/site/workspace row. The canonical graph groups
related apps without erasing instance boundaries. Distinct app instances must not be collapsed into one app
row. Existing app_contracts remains the contract-to-app-instance linking model.**

### 60.2 Local validation (before the staging apply)
325 tests passed; the RLS migration tests passed (RLS assertions **446**, `ALL ORG-RLS ASSERTIONS PASSED`);
lint, typecheck, build, auth-safety, and migration-safety all passed; generated database types updated to 1744
lines.

### 60.3 Scope / status
This verifies only that `0024` applied + the canonical tables/columns exist on staging — not any resolver or
connector behavior (there is none). **No resolver is implemented. No app graph writes are implemented. No
production migration was run for 0024. Production is not verified for 0024** (a human applies it to production
in a future step; the agent never runs hosted commands). **No app code changed. No schema changed in this
verification PR. No migration changed in this verification PR. No connector behavior changed. No provider API
call was made. No OAuth code was exchanged for tokens. No access token was stored. No refresh token was stored.
No connector credentials were stored. No connector secret material was inserted, updated, deleted, or read. No
connector sync was implemented. No credential form was implemented. No connect/reconnect/disconnect action was
exposed to users. No browser-accessible service-role request path was added. No production data was touched.
Connector implementation remains blocked. Old-app parity is not complete. UI/UX parity is not complete. AI/API
connector parity is not complete. Upload is not automatically production-ready. Hosted Auth/tenant-context is
verified, but old-app replacement is not yet verified. RISK-001 remains OPEN. RISK-007 remains OPEN. Cutover
remains BLOCKED.** No doc 17 §5 box is ticked by this verification.
## 61. Production verification — canonical app graph `0024` (PR #139)

**Canonical app graph schema is applied and verified on production.** A human applied
`0024_canonical_app_instance_graph.sql` to the PRODUCTION project `dzbfxulvxchdemcettrx` (staging is
`ycdpzduxugdsffjqyoai`; local/main `deb7fb2` — PR #138), verified the live schema, then relinked local back to
staging. **The production apply and verification were human-run; this PR only records the evidence — the agent
did not touch production, ran no hosted command, and made no staging/production mutation.**

### 61.1 Observed — PASS
Production is aligned through migration 0024.
`0024` was MISSING on production before the push; `supabase db push --linked` applied it successfully to
production; **Production is aligned through migration 0024** — `supabase migration list --linked` showed
production aligned through `0024` after the push. Production verification confirmed the three canonical graph
tables and the new `apps` columns are present:
- **The vendors table is present on production.**
- **The app_products table is present on production.**
- **The app_aliases table is present on production.**
- **apps.canonical_app_id is present on production.**
- **apps.instance_domain is present on production.**
- **apps.external_instance_id is present on production.**
- **apps.instance_url is present on production.**

**Staging and production are aligned through migration 0024** — this matches the §60 staging verification + the
local `org_rls_test.sql` T46 proof. **apps remains the operational app instance/site/workspace row. The
canonical graph groups related apps without erasing instance boundaries. Distinct app instances must not be
collapsed into one app row. Existing app_contracts remains the contract-to-app-instance linking model.**

### 61.2 Link safety
**Local Supabase link was returned to staging after production verification. Final linked ref was
ycdpzduxugdsffjqyoai** (the production link was used only for the human's apply/verify, then reverted, so no
later command can accidentally hit production).

### 61.3 Scope / status — the schema exists, nothing populates it yet
The canonical graph schema now exists on production, but **No resolver is implemented. No app graph writes are
implemented** — nothing populates the tables yet; the resolver remains design-only (§59). **No app code
changed. No schema changed in this verification PR. No migration changed in this verification PR. No connector
behavior changed. No provider API call was made. No OAuth code was exchanged for tokens. No access token was
stored. No refresh token was stored. No connector credentials were stored. No connector secret material was
inserted, updated, deleted, or read. No connector sync was implemented. No credential form was implemented. No
connect/reconnect/disconnect action was exposed to users. No browser-accessible service-role request path was
added. No production data was touched. Connector implementation remains blocked. Old-app parity is not
complete. UI/UX parity is not complete. AI/API connector parity is not complete. Upload is not automatically
production-ready. Hosted Auth/tenant-context is verified, but old-app replacement is not yet verified. RISK-001
remains OPEN. RISK-007 remains OPEN. Cutover remains BLOCKED.** No doc 17 §5 box is ticked by this
verification.
## 62. Design — resolver + identity-matching engine (PR #140)

**Resolver and identity-matching design is recorded.** **The canonical graph schema exists, but the resolver
does not exist yet. Nothing populates apps.canonical_app_id yet.** This records + safely models how future
validated discovery signals will resolve into canonical vendor/product/app-instance assignments and how
app_users will match to people. **The resolver is the moat engine that will assemble validated discovery
signals into the canonical app graph.** Design + pure types/helpers only (`resolution.ts` —
`src/lib/server/connector-vault/`): **No live resolver job is implemented. No app graph writes are implemented.
No canonical_app_id write is implemented. No app_alias write is implemented. No app_user to person match write
is implemented.** The helpers are pure + in-memory (no DB / Supabase / provider client / fetch /
connector_secrets).

### 62.1 The future flow (none of it runs yet)
validated discovery signals → DETERMINISTIC resolver → low-confidence HUMAN REVIEW → canonical_app_id
assignment → app_user→person matching → baseline metrics → canonical/vendor/product rollups →
recommendations.

### 62.2 Resolver — deterministic-first, probabilistic-second, fail closed
**Resolver matching is deterministic-first and probabilistic-second.**
- **Deterministic-first** (a structured key uniquely identifies the instance/product): `instance_domain`,
  `external_instance_id`, `instance_url`, provider app id, OAuth client id, SSO app id, known domain, explicit
  vendor/product identifiers. A deterministic match may auto-assign.
- **Probabilistic-second** (fuzzy): vendor-name / product-name / domain / contract-invoice vendor similarity.
  These never auto-merge on their own. **Low-confidence matches route to human review** — approve, reject, or
  repoint aliases/`canonical_app_id`; **low-confidence matches must not auto-merge.**
- `classifyResolutionConfidence()` → `deterministic` > `probabilistic_high` > `probabilistic_low` >
  `human_review` (the fail-closed floor); `explainResolutionDecision()` → only `deterministic` auto-assigns,
  everything else (incl. no-match) routes to `human_review`. Unknown/ambiguous input fails closed.

### 62.3 Idempotency + no blind merging
**Discovery re-runs must be idempotent. Runners must upsert on natural keys, not blindly insert.**
**instance_domain and external_instance_id are future merge/no-merge keys.** **Same vendor/product does not
mean same operational app instance.** **Distinct app instances must not be collapsed into one app row** —
`sameOperationalInstance()` returns false when a present merge key (or owning org) differs.
**Atlassian/Jira/Flywheel and Atlassian/Jira/Perpetua must remain distinct app instances** (same product, two
`apps` rows under one `app_product`). Owner/paying/responsible org influences merge/no-merge.

### 62.4 Identity matching — app_user → person
**app_user_identity_matches links app_user_id to person_id.** **There is no identity_account_id on
app_user_identity_matches** (identity_accounts link to person via `person_id`). **No identity_account_id is
introduced** — the `IdentityMatchCandidate` type carries `appUserId` → `personId`, never an
identity_account_id. Matching is deterministic-first (exact normalized email, verified external ids), then
secondary hints (aliases / manager / HR fields, later) routing to review; low confidence → human review.
**Canonical user rollups must count distinct person_id after identity matching, not sum app_users naively.**
**Per-instance counts may use app_users.**

### 62.5 Tests + posture (resolution.test.ts; no schema → RLS **446**, types **1744**, both unchanged)
The pure helpers are tested: deterministic confidence outranks name-similarity; distinct `instance_domain`
values do not auto-merge (Flywheel vs Perpetua stay distinct); unknown/ambiguous routes to `human_review`; no
`identity_account_id` appears in the helper types; no client imports; no provider API/fetch; no
`connector_secrets` references. No migration, no schema change — RLS suite and generated types unchanged.

**No provider API call is made. No OAuth code is exchanged for tokens. No access token is stored. No refresh
token is stored. No connector credentials are stored. No connector secret material is inserted, updated,
deleted, or read. No connector sync is implemented. No credential form is implemented. No
connect/reconnect/disconnect action is exposed to users. No browser-accessible service-role request path is
added. No production data was touched. No hosted commands were run. Connector implementation remains blocked.
Old-app parity is not complete. UI/UX parity is not complete. AI/API connector parity is not complete. Upload
is not automatically production-ready. Hosted Auth/tenant-context is verified, but old-app replacement is not
yet verified. RISK-001 remains OPEN. RISK-007 remains OPEN. Cutover remains BLOCKED.** No doc 17 §5 box is
ticked by this PR.
## 63. Schema — discovery signal / standard fact contract (PR #141)

**Discovery signal fact schema is added. The schema is versioned.** `discovery-facts.ts`
(`src/lib/server/connector-vault/`) adds the first versioned standard-fact contract. **The schema defines
standardized inputs for discovery connectors, deep sync runners, contract intelligence, invoice/spend imports,
and future browser/import sources.** **The schema is the future input contract for the resolver** (PR #140's
pure resolver consumes validated facts; this defines what "validated" means). **The resolver remains
non-live.** Schema + types + tests only — runtime enforcement is zod `safeParse` (zod was already a dependency;
no new dependency added). The only import is `zod`; no DB / Supabase / provider client / fetch /
connector_secrets.

### 63.1 The contract
Every fact carries the core fields: `schema_version` (versioned — required), `signal_id`, `tenant_id`,
`source_type`, `source_provider`, `source_run_id?`, `source_record_id?`, `observed_at`, `confidence` (0..1),
`provenance?` (safe scalars), `review_status?`, `raw_source_ref?` (a non-secret reference, never secret
material). The `fact_type` discriminator covers the 13 required categories: app discovery, app instance
identity, vendor/product, app user/account, person identity candidate, license, usage/activity, role/admin,
group/team membership, contract, invoice/spend, risk/completeness, recommendation evidence.

### 63.2 Safe by construction
Unknown or ambiguous source data fails closed to review.
Every fact schema is STRICT — an unknown key is REJECTED at parse time, so **Signal facts must not contain
token or connector secret material**: access/refresh tokens, API keys, client secrets, `connector_secrets`,
service-role/provider credentials are not valid fields and fail `safeParse`. `raw_source_ref` /
`source_file_id` / `source_clause_text` are references/provenance only — never secret payloads. A
defense-in-depth `hasForbiddenFactKey()` guard also detects token/secret-like keys pre-parse.
**Unknown or ambiguous source data fails closed to review** — an unrecognized `source_type` maps to
`unknown_source` (`classifySourceType()` fails closed) and an unknown `fact_type` fails `safeParse`. Ambiguous
app-instance identity does NOT auto-resolve: `appInstanceCandidateKey()` keys on instance_domain else
external_instance_id, so distinct values stay SEPARATE instance candidates (Flywheel ≠ Perpetua). An
invoice/spend fact carries only CANDIDATE app linkage (`app_candidate_name`) — never a resolved `app_id`.
**Old scraper behavior is a reference to verify, not a source of truth** (provider APIs may have changed). No
LLM is on the runtime ingestion hot path — the contract is a deterministic structural schema only.

### 63.3 Tests + posture (discovery-facts.test.ts; no schema → RLS **446**, types **1744**, both unchanged)
A valid fixture per category parses; missing/wrong `schema_version` fails; an unknown `fact_type` fails closed;
a token-like field and `connector_secrets` are rejected by the strict schema; distinct instance_domain values
stay separate; a contract fact supports `source_clause_text`; an invoice fact does not imply final app linkage;
no Supabase/client imports (only `zod`); no fetch/provider API; no DB writes; no service-role. No migration, no
schema change — RLS suite and generated types unchanged.

**No signal ingestion job is implemented. No database write is implemented. No app graph write is implemented.
No canonical_app_id write is implemented. No app_alias write is implemented. No app_user to person match write
is implemented. No provider API call is made. No OAuth code is exchanged for tokens. No access token is stored.
No refresh token is stored. No API key is stored. No connector credentials are stored. No connector secret
material is inserted, updated, deleted, or read. No connector sync is implemented. No credential form is
implemented. No connect/reconnect/disconnect action is exposed to users. No browser-accessible service-role
request path is added. No production data was touched. No hosted commands were run. Connector implementation
remains blocked. Old-app parity is not complete. UI/UX parity is not complete. AI/API connector parity is not
complete. Upload is not automatically production-ready. Hosted Auth/tenant-context is verified, but old-app
replacement is not yet verified. RISK-001 remains OPEN. RISK-007 remains OPEN. Cutover remains BLOCKED.** No
doc 17 §5 box is ticked by this PR.
## 64. Implementation — fact ingestion staging boundary (PR #142)

**Fact ingestion staging boundary is added.** The first safe, RLS-backed write path for validated discovery
facts — migration `0025_discovery_facts_staging.sql` adds a tenant-scoped `discovery_facts` table and a
server-only ingestion helper (`discovery-fact-staging.ts`) that accepts unknown input, validates it against the
PR #141 zod contract, and stages only clean, validated facts for later resolver / human review. This is NOT a
provider connector, NOT a live resolver, NOT a sync.

### 64.1 The boundary
**Only safeParse-validated facts may be staged. Invalid facts are rejected before persistence. Token-bearing
facts are rejected before persistence. Secret-bearing facts are rejected before persistence.**
`validateDiscoveryFact()` runs the token/secret deny-list (`hasForbiddenFactKey`) FIRST, then PR #141
`safeParse` — anything that is not a clean valid fact is rejected with NO DB call.
`stageDiscoveryFactForReview()` / `stageDiscoveryFactsForReview()` then bind the row to the authenticated
tenant (rejecting a fact that claims a different tenant) and insert through an INJECTED
`DiscoveryFactStagingStore` — backed by the user-scoped (authenticated, RLS-enforced) DAL when wired, **never a
service-role client**. The helper imports no Supabase client; **No service-role client is added.** It stages
ONLY `discovery_facts` columns and stores the original validated fact as `fact_json`.

### 64.2 The table
**The staged fact table is tenant-scoped. The staged fact table is RLS-protected.** `discovery_facts`
(tenant_id FK + UNIQUE(id, tenant_id)) carries schema_version / fact_type / source_type / source_provider /
source_run_id / source_record_id / signal_id / natural_key (deterministic, non-secret) / observed_at /
confidence / review_status (default `pending`, checked) / reviewed_by / reviewed_at / fact_json (NOT NULL) /
provenance_json / rejected_reason. RLS is the `0004`-hardened posture — members read + editors INSERT + editors
UPDATE, **NO DELETE policy** (staged facts are durable review records; a rejected fact is marked
`review_status='rejected'` with `rejected_reason`, never deleted). Indexes on tenant_id, (tenant_id, fact_type),
(tenant_id, source_provider), (tenant_id, review_status), (tenant_id, natural_key), source_run_id. **No
`connector_runner` grant** and no service-role path were added.

### 64.3 Scope — staged facts are inputs, nothing is resolved
**Staged facts are reviewable inputs for the future resolver. The live resolver is not implemented.** The
helper writes ONLY the staging row: **No canonical app graph write is implemented. No apps.canonical_app_id
write is implemented. No app_alias write is implemented. No app_user to person match write is implemented.**

### 64.4 Tests + posture (T47 + discovery-fact-staging.test.ts; RLS suite **446 → 458**; types 1744 → 1828)
T47 proves the table is RLS-enabled with EXACTLY {SELECT, INSERT, UPDATE} policies (no DELETE/ALL), functional
tenant isolation (tenant A cannot read/insert/update tenant B; a Tenant B update of a Tenant A fact scopes to
zero rows), the staging columns + `review_status` default + `fact_json` NOT NULL, `connector_secrets`
untouched, and NO `connector_runner` grant. The helper tests prove a valid fact stages (mocked DB), and
invalid / access_token / refresh_token / connector_secrets / nested-provenance-secret / unknown-fact-type /
wrong-tenant inputs are all rejected BEFORE any insert, and the staged row never carries canonical/alias/match
fields; only-`./discovery-facts` import, no fetch/provider API, no service-role, no connector_secrets.

**No provider API call is made. No OAuth code is exchanged for tokens. No access token is stored. No refresh
token is stored. No API key is stored. No connector credentials are stored. No connector secret material is
inserted, updated, deleted, or read. No connector sync is implemented. No credential form is implemented. No
connect/reconnect/disconnect action is exposed to users. No browser-accessible service-role request path is
added. No production data was touched. No hosted commands were run. Connector implementation remains blocked.
Old-app parity is not complete. UI/UX parity is not complete. AI/API connector parity is not complete. Upload
is not automatically production-ready. Hosted Auth/tenant-context is verified, but old-app replacement is not
yet verified. RISK-001 remains OPEN. RISK-007 remains OPEN. Cutover remains BLOCKED.** No doc 17 §5 box is
ticked by this PR.
## 65. Staging verification — discovery facts staging `0025` (PR #143)

**Discovery facts staging table is applied and verified on staging.** A human applied
`0025_discovery_facts_staging.sql` to the staging project `ycdpzduxugdsffjqyoai` (local/main `06e552a` —
PR #142) and verified the live schema. **The staging apply and verification were human-run; this PR only
records the evidence — the agent did not touch staging, ran no hosted command, and made no staging/production
mutation.**

### 65.1 Observed — PASS
Staging is aligned through migration 0025. The discovery_facts table is present on staging. Production is not verified for 0025.
`0025` was MISSING on staging before the push; `supabase db push --linked` applied it successfully to staging;
**Staging is aligned through migration 0025** — `supabase migration list --linked` showed staging aligned
through `0025` after the push. **The discovery_facts table is present on staging** and the `0025` columns
(schema_version / fact_type / source_type / source_provider / source_run_id / source_record_id / signal_id /
natural_key / observed_at / confidence / review_status / reviewed_by / reviewed_at / fact_json /
provenance_json / rejected_reason) are present. **The discovery_facts table is tenant-scoped and
RLS-protected** (the §64 design + the local `org_rls_test.sql` T47 proof — staging now mirrors the local schema
through `0025`).

### 65.2 What the boundary is (recap)
**The fact ingestion boundary stages only safeParse-validated facts. Invalid facts are rejected before
persistence. Token-bearing facts are rejected before persistence. Secret-bearing facts are rejected before
persistence. Staged facts are reviewable inputs for the future resolver.** The staging table exists, but
nothing resolves facts into the canonical graph yet.

### 65.3 Local validation (before the staging apply)
384 tests passed; the RLS migration tests passed (RLS assertions **458**, `ALL ORG-RLS ASSERTIONS PASSED`);
lint, typecheck, build, auth-safety, and migration-safety all passed; generated database types updated to 1828
lines.

### 65.4 Scope / status
This verifies only that `0025` applied + the `discovery_facts` table/columns exist on staging — not any
resolver or connector behavior (there is none). **The live resolver is not implemented. No canonical app graph
write is implemented. No apps.canonical_app_id write is implemented. No app_alias write is implemented. No
app_user to person match write is implemented. No production migration was run for 0025. Production is not
verified for 0025** (a human applies it to production in a future step; the agent never runs hosted commands).
**No app code changed. No schema changed in this verification PR. No migration changed in this verification PR.
No connector behavior changed. No provider API call was made. No OAuth code was exchanged for tokens. No access
token was stored. No refresh token was stored. No API key was stored. No connector credentials were stored. No
connector secret material was inserted, updated, deleted, or read. No connector sync was implemented. No
credential form was implemented. No connect/reconnect/disconnect action was exposed to users. No
browser-accessible service-role request path was added. No service-role client was added. No production data
was touched. Connector implementation remains blocked. Old-app parity is not complete. UI/UX parity is not
complete. AI/API connector parity is not complete. Upload is not automatically production-ready. Hosted
Auth/tenant-context is verified, but old-app replacement is not yet verified. RISK-001 remains OPEN. RISK-007
remains OPEN. Cutover remains BLOCKED.** No doc 17 §5 box is ticked by this verification.
## 66. Production verification — discovery facts staging `0025` (PR #144)

**Discovery facts staging table is applied and verified on production.** A human applied
`0025_discovery_facts_staging.sql` to the PRODUCTION project `dzbfxulvxchdemcettrx` (staging is
`ycdpzduxugdsffjqyoai`; local/main `9f4b8b6` — PR #143), verified the live schema, then relinked local back to
staging. **The production apply and verification were human-run; this PR only records the evidence — the agent
did not touch production, ran no hosted command, and made no staging/production mutation.**

### 66.1 Observed — PASS
Production is aligned through migration 0025. The discovery_facts table columns are present on production.
`0025` was MISSING on production before the push; `supabase db push --linked` applied it successfully to
production; **Production is aligned through migration 0025** — `supabase migration list --linked` showed
production aligned through `0025` after the push. **The discovery_facts table is present on production. The
discovery_facts table columns are present on production** — id, tenant_id, schema_version, fact_type,
source_type, source_provider, source_run_id, source_record_id, signal_id, natural_key, observed_at, confidence,
review_status, reviewed_by, reviewed_at, fact_json, provenance_json, rejected_reason, created_at, updated_at.
**Staging and production are aligned through migration 0025** — this matches the §65 staging verification + the
local `org_rls_test.sql` T47 proof. **The discovery_facts table is tenant-scoped and RLS-protected.**

### 66.2 Transient 504 (recorded, retried successfully)
**A transient Supabase CLI/login-role 504 occurred during verification and the verification was retried
successfully.** A login-role query returned an unexpected status 504 mid-verification; the column verification
was then retried and returned the full column set above — so the PASS stands. (No data was affected; the 504
was a transient CLI/login-role read, not a migration or write.)

### 66.3 Link safety
**Local Supabase link was returned to staging after production verification. Final linked ref was
ycdpzduxugdsffjqyoai** (the production link was used only for the human's apply/verify, then reverted, so no
later command can accidentally hit production).

### 66.4 Scope / status — the table exists, nothing resolves into the graph yet
**The fact ingestion boundary stages only safeParse-validated facts. Invalid facts are rejected before
persistence. Token-bearing facts are rejected before persistence. Secret-bearing facts are rejected before
persistence. Staged facts are reviewable inputs for the future resolver.** The staging table exists on
production, but nothing resolves facts into the canonical graph yet. **The live resolver is not implemented. No
canonical app graph write is implemented. No apps.canonical_app_id write is implemented. No app_alias write is
implemented. No app_user to person match write is implemented. No app code changed. No schema changed in this
verification PR. No migration changed in this verification PR. No connector behavior changed. No provider API
call was made. No OAuth code was exchanged for tokens. No access token was stored. No refresh token was stored.
No API key was stored. No connector credentials were stored. No connector secret material was inserted,
updated, deleted, or read. No connector sync was implemented. No credential form was implemented. No
connect/reconnect/disconnect action was exposed to users. No browser-accessible service-role request path was
added. No service-role client was added. No production data was touched. Connector implementation remains
blocked. Old-app parity is not complete. UI/UX parity is not complete. AI/API connector parity is not complete.
Upload is not automatically production-ready. Hosted Auth/tenant-context is verified, but old-app replacement
is not yet verified. RISK-001 remains OPEN. RISK-007 remains OPEN. Cutover remains BLOCKED.** No doc 17 §5 box
is ticked by this verification.
## 67. Implementation — discovery fact request adapter (PR #145)

**Discovery fact request adapter is added** (`discovery-fact-adapter.ts`, `src/lib/server/connector-vault/`).
The reviewed server-only seam that wires the existing pieces: a future authenticated request handler calls it
to STAGE an untrusted discovery fact through the SafeParse + RLS-backed `discovery_facts` path (PR #141
contract → PR #142 staging helper), and may optionally get a READ-ONLY resolver preview (PR #140 pure logic).
It wires existing pieces only — no migration, no schema change, no new table.

### 67.1 Staging seam
Discovery fact request adapter is added. The adapter uses the authenticated user-scoped/RLS path. No unauthenticated public fact ingestion route is added.
`submitDiscoveryFactForReview()` / `submitDiscoveryFactsForReview()` delegate to `stageDiscoveryFactForReview`.
**The adapter stages only SafeParse-validated facts. Invalid facts are rejected before persistence.
Token-bearing facts are rejected before persistence. Secret-bearing facts are rejected before persistence**
(a mismatched tenant is rejected too). **The adapter uses the authenticated user-scoped/RLS path** — the
insert runs through the injected user-scoped (authenticated, RLS-enforced) `DiscoveryFactStagingStore`. **No
service-role client is added. No browser-accessible service-role request path is added. No unauthenticated
public fact ingestion route is added** — this module exposes NO HTTP route; a future AUTHENTICATED route
handler injects the store and calls the adapter. It imports no Supabase client, calls no provider, calls no
fetch, and reads/writes no `connector_secrets`.

### 67.2 Read-only resolver preview
**A read-only resolver preview may be returned.** `previewDiscoveryFactResolution()` validates the fact then
predicts an action/confidence/reasons in memory from the fact's own content (mapping the deterministic instance
discriminators to `DiscoveryResolutionInput`, then `explainResolutionDecision`). **Resolver preview output is
not persisted.** The preview takes NO store, writes NO graph, and updates NO staged review_status; it is a
prediction only and never auto-assigns. Because it has no in-memory corpus to run similarity against, a fact
without a deterministic instance key fails closed to `human_review` (the no-blind-merge posture).
`stageAndPreviewDiscoveryFact()` stages a fact AND returns the read-only preview alongside — the preview is
computed in memory and persisted nowhere (the staged row never carries the decision).

### 67.3 Tests + posture (discovery-fact-adapter.test.ts; no schema → RLS **458**, types **1828**, unchanged)
A valid fact stages through the adapter (mocked authenticated store); invalid / access_token / refresh_token /
connector_secrets / wrong-tenant inputs are rejected BEFORE the store call; a deterministic instance signal
returns a read-only preview (deterministic) while an ambiguous fact returns `human_review`; the preview surface
is exactly `{ decision }` (no canonical_app_id / app_alias / match / persisted field) and the staged row never
carries the preview; the adapter imports only sibling server-only modules (no createClient / service-role /
connector_secrets / fetch / Next route handler).

**The live resolver write path is not implemented. No canonical app graph write is implemented. No
apps.canonical_app_id write is implemented. No app_alias write is implemented. No app_user to person match
write is implemented. No provider API call is made. No OAuth code is exchanged for tokens. No access token is
stored. No refresh token is stored. No API key is stored. No connector credentials are stored. No connector
secret material is inserted, updated, deleted, or read. No connector sync is implemented. No credential form is
implemented. No connect/reconnect/disconnect action is exposed to users. No production data was touched. No
hosted commands were run. Connector implementation remains blocked. Old-app parity is not complete. UI/UX
parity is not complete. AI/API connector parity is not complete. Upload is not automatically production-ready.
Hosted Auth/tenant-context is verified, but old-app replacement is not yet verified. RISK-001 remains OPEN.
RISK-007 remains OPEN. Cutover remains BLOCKED.** No doc 17 §5 box is ticked by this PR.
## 68. Implementation — resolver read path for staged facts (PR #146)

**Resolver read path for staged facts is added** (`discovery-fact-read.ts`, `src/lib/server/connector-vault/`).
A READ-ONLY preview over ALREADY-STAGED `discovery_facts` rows: it lists staged facts for the current
authenticated tenant (through the user-scoped, RLS-enforced read store) and computes what the resolver WOULD do
using the pure PR #140 logic — without mutating anything. This is NOT the resolver write path.

### 68.1 The read path
Resolver read path for staged facts is added. Unknown or ambiguous staged facts route to human_review.
**The resolver preview reads staged discovery_facts.** `listStagedDiscoveryFactsForCurrentUser()` reads through
the injected `DiscoveryFactReadStore` (backed by the authenticated user-scoped, RLS-enforced client when wired
— never service-role). Tenant scoping comes from the authenticated context + RLS, NOT a trusted payload
tenant_id: the read functions return `[]` WITHOUT querying the store when there is no authenticated tenant.
`mapDiscoveryFactRowToResolutionInput()` defensively extracts the deterministic instance discriminators from a
row's `fact_json`, and `previewDiscoveryFactResolutionFromRows()` / `previewStagedDiscoveryFacts()` compute
preview decisions in memory via `appResolutionSignals` + `explainResolutionDecision`.

### 68.2 Read-only — persists nothing
**Resolver preview output is read-only. Resolver preview output is not persisted.** The read store exposes only
`listStagedFacts()` (no update/insert) — the preview updates NO `discovery_facts.review_status` and writes NO
canonical app graph. **Unknown or ambiguous staged facts route to human_review** — a row whose `fact_json`
carries no deterministic instance key (or is malformed/missing) yields no signals and fails closed to
`human_review` (no in-memory similarity corpus is consulted). A preview carries only `{ factId, factType,
decision }` — never a persisted/canonical-graph field.

### 68.3 Tests + posture (discovery-fact-read.test.ts; no schema → RLS **458**, types **1828**, unchanged)
Reads staged facts through the injected authenticated store; does NOT call the store when tenant context is
missing (null/undefined/empty → `[]`); a deterministic instance fact previews `deterministic` while an
ambiguous / malformed fact previews `human_review`; the read store has no write/update method and a preview
carries no persisted/canonical-graph field; the module imports only `./resolution` (no createClient /
service-role / connector_secrets / fetch / Next route handler). Existing T47 already proves `discovery_facts`
SELECT tenant isolation, so RLS stays **458**.

**The live resolver write path is not implemented. No canonical app graph write is implemented. No
apps.canonical_app_id write is implemented. No app_alias write is implemented. No app_user to person match
write is implemented. No provider API call is made. No OAuth code is exchanged for tokens. No access token is
stored. No refresh token is stored. No API key is stored. No connector credentials are stored. No connector
secret material is inserted, updated, deleted, or read. No connector sync is implemented. No credential form is
implemented. No connect/reconnect/disconnect action is exposed to users. No browser-accessible service-role
request path is added. No production data was touched. No hosted commands were run. Connector implementation
remains blocked. Old-app parity is not complete. UI/UX parity is not complete. AI/API connector parity is not
complete. Upload is not automatically production-ready. Hosted Auth/tenant-context is verified, but old-app
replacement is not yet verified. RISK-001 remains OPEN. RISK-007 remains OPEN. Cutover remains BLOCKED.** No
doc 17 §5 box is ticked by this PR.
## 69. Implementation — deterministic resolver write path (PR #147)

**Deterministic resolver write path is added. This is the first canonical graph mutation path** (migration
`0026` + `resolver-write.ts`, `src/lib/server/connector-vault/`). It reads staged `discovery_facts`, runs the
pure PR #140 resolver logic, and writes ONLY deterministic, high-confidence outputs into the canonical graph.

### 69.1 Deterministic-only, fail closed
Deterministic resolver write path is added. This is the first canonical graph mutation path.
**Only deterministic resolver outputs may write. Probabilistic matches do not auto-write. Ambiguous matches do
not auto-write. Low-confidence matches remain reviewable. False splits are safer than false merges.**
`applyDeterministicResolution` writes a fact ONLY when the pure resolver returns `auto_assign` (a deterministic
instance key) AND a vendor+product+instance discriminator is present. A missing discriminator, a probabilistic/
name-only signal, or a CONFLICT (the alias natural key already resolves to a different product, or the instance
already has a different `canonical_app_id`) all leave the fact in review — never an overwrite or blind re-merge.

### 69.2 Idempotent natural-key upserts
**Resolver writes are idempotent. Repeated staged fact runs do not create duplicate app_alias rows. Repeated
staged fact runs do not create duplicate vendor/product/app records. Runners must upsert on natural keys, not
blindly insert.** Migration `0026` adds the alias natural key `UNIQUE(tenant_id, alias_type, alias_value)`
(vendor + product natural keys already exist from `0024`), so the whole write is `ON CONFLICT DO NOTHING`
idempotent. **Arrival order must not change persisted resolver state.**

### 69.3 Multi-instance + convergence
**Distinct app instances must not be collapsed into one app row. Jira Flywheel and Jira Perpetua remain
separate app rows** (two distinct `instance_domain` aliases under ONE Jira product, two apps rows). **Slack
multi-source facts converge without duplicate aliases when deterministic evidence is sufficient** (one product;
each deterministic key — domain / external id — is one alias, repeats are no-ops). **A weak signal followed by
deterministic evidence must not create a parallel app** (the weak signal stays reviewable; the later
deterministic signal reuses the same product via the natural key).

### 69.4 Non-destructive unmerge / repoint
**Unmerge/repoint is modeled for deterministic assignments. Unmerge/repoint does not delete historical users,
contracts, or invoices.** `revertCanonicalAppAssignment` clears `apps.canonical_app_id` (un-links the instance)
and `repointAppAlias` changes an alias's target product — both REPOINT only; they never delete the apps row or
its `app_users`/`contracts`/`invoices`.

### 69.5 Safety surface + tests (T48 + resolver-write.test.ts; RLS suite **458 → 478**; types **1828** 0-diff)
The only DB access is through the INJECTED `CanonicalGraphWriteStore`, backed by the authenticated user-scoped
(RLS) client when wired — **No service-role client is added**, no provider call, no token/credential, no
`connector_secrets`, no HTTP/public route. Tenant scoping comes from the authenticated `tenantId` + RLS (writes
nothing without an authenticated tenant). **No app_user to person match write is implemented** (this PR never
touches `app_user_identity_matches`). The migration `0026` is a CONSTRAINT only (types unchanged). T48 proves
persisted-state idempotency on real Postgres (re-run → unchanged counts), the Flywheel ≠ Perpetua split, and
non-destructive unmerge/repoint; the helper tests prove deterministic-only writes, conflict→review,
convergence, arrival-order independence, weak-then-deterministic, tenant isolation, and the no-secret/no-route
surface.

**No provider API call is made. No OAuth code is exchanged for tokens. No access token is stored. No refresh
token is stored. No API key is stored. No connector credentials are stored. No connector secret material is
inserted, updated, deleted, or read. No connector sync is implemented. No credential form is implemented. No
connect/reconnect/disconnect action is exposed to users. No browser-accessible service-role request path is
added. No production data was touched. No hosted commands were run. Connector implementation remains blocked.
Old-app parity is not complete. UI/UX parity is not complete. AI/API connector parity is not complete. Upload
is not automatically production-ready. Hosted Auth/tenant-context is verified, but old-app replacement is not
yet verified. RISK-001 remains OPEN. RISK-007 remains OPEN. Cutover remains BLOCKED.** No doc 17 §5 box is
ticked by this PR.
## 70. Staging verification — resolver natural key `0026` (PR #148)

**Resolver natural-key constraint is applied and verified on staging.** A human applied
`0026_app_alias_natural_key.sql` to the staging project `ycdpzduxugdsffjqyoai` (local/main `99f68ee` —
PR #147) and verified the live schema. **The staging apply and verification were human-run; this PR only
records the evidence — the agent did not touch staging, ran no hosted command, and made no staging/production
mutation.**

### 70.1 Observed — PASS
Staging is aligned through migration 0026. No production migration was run for 0026.
`0026` was MISSING on staging before the push; `supabase db push --linked` applied it successfully to staging;
**Staging is aligned through migration 0026** — `supabase migration list --linked` showed staging aligned
through `0026` after the push. The canonical-graph tables are present on staging: **The app_aliases table is
present on staging. The app_products table is present on staging. The vendors table is present on staging. The
discovery_facts table is present on staging.** **The app_aliases_tenant_type_value_key constraint is present on
staging. The app_aliases natural key is UNIQUE (tenant_id, alias_type, alias_value).** The surrounding
app_aliases constraints (alias_type CHECK, review_status CHECK, same-tenant app FK, same-tenant product FK) are
present. **The database enforces tenant-scoped alias idempotency.**

### 70.2 Code ↔ constraint alignment (the verified claim, precisely scoped)
**The resolver write helper uses the same natural-key model** — tenant + alias_type + alias_value — so the
in-code upsert and the DB constraint agree. **Local persisted-state fixture tests prove repeated deterministic
resolver runs do not increase vendors, products, or aliases. Deterministic resolver writes are idempotent for
the staged fixture cases.** **Probabilistic-only facts do not write canonical graph data. Ambiguous/name-only
facts do not write canonical graph data. Conflicting canonical assignments are not overwritten. Jira Flywheel
and Jira Perpetua remain separate app rows. Unmerge/repoint is non-destructive.** **The deterministic resolver
write path exists in code.** (Precise claim: the DB constraint enforces alias natural-key uniqueness and the
deterministic writes are idempotent for the VERIFIED staged fixture cases — this is NOT a claim that all
resolver behavior is complete.)

### 70.3 Local validation (before the staging apply)
425 tests passed; the RLS migration tests passed (RLS assertions **478**, `ALL ORG-RLS ASSERTIONS PASSED`);
lint, typecheck, build, auth-safety, and migration-safety all passed; generated database types remained 1828
lines.

### 70.4 Scope / status
**The deterministic resolver write path is not yet verified on production. Production is not verified for 0026.
No production migration was run for 0026** (a human applies it to production in a future step; the agent never
runs hosted commands). **No app_user to person match write is implemented. No provider API call was made. No
OAuth code was exchanged for tokens. No access token was stored. No refresh token was stored. No API key was
stored. No connector credentials were stored. No connector secret material was inserted, updated, deleted, or
read. No connector sync was implemented. No credential form was implemented. No connect/reconnect/disconnect
action was exposed to users. No browser-accessible service-role request path was added. No production data was
touched. Connector implementation remains blocked. Old-app parity is not complete. UI/UX parity is not
complete. AI/API connector parity is not complete. Upload is not automatically production-ready. Hosted
Auth/tenant-context is verified, but old-app replacement is not yet verified. RISK-001 remains OPEN. RISK-007
remains OPEN. Cutover remains BLOCKED.** No doc 17 §5 box is ticked by this verification.
## 71. Production verification — resolver natural key `0026` (PR #149)

**Resolver natural-key constraint is applied and verified on production.** A human applied
`0026_app_alias_natural_key.sql` to the PRODUCTION project `dzbfxulvxchdemcettrx` (staging is
`ycdpzduxugdsffjqyoai`; local/main `d9b9f5e` — PR #148), verified the live constraint, then relinked local back
to staging. **The production apply and verification were human-run; this PR only records the evidence — the
agent did not touch production, ran no hosted command, and made no staging/production mutation.**

### 71.1 Observed — PASS
Production is aligned through migration 0026.
`0026` was MISSING on production before the push; `supabase db push --linked` applied it successfully to
production; **Production is aligned through migration 0026** — `supabase migration list --linked` showed
production aligned through `0026` after the push. **The app_aliases_tenant_type_value_key constraint is present
on production. The app_aliases natural key is UNIQUE (tenant_id, alias_type, alias_value). The database enforces
tenant-scoped alias idempotency on production.** **Staging and production are aligned through migration 0026** —
this matches the §70 staging verification.

### 71.2 Link safety
**Local Supabase link was returned to staging after production verification. Final linked ref was
ycdpzduxugdsffjqyoai** (the production link was used only for the human's apply/verify, then reverted, so no
later command can accidentally hit production).

### 71.3 Code ↔ constraint alignment (the verified claim, precisely scoped)
**The resolver write helper uses the same natural-key model** — tenant + alias_type + alias_value — so the
in-code upsert and the production DB constraint agree. **Local persisted-state fixture tests prove repeated
deterministic resolver runs do not increase vendors, products, or aliases. Deterministic resolver writes are
idempotent for the staged fixture cases. This is not a claim that all resolver behavior is complete.**
**Probabilistic-only facts do not write canonical graph data. Ambiguous/name-only facts do not write canonical
graph data. Conflicting canonical assignments are not overwritten. Jira Flywheel and Jira Perpetua remain
separate app rows. Unmerge/repoint is non-destructive.**

### 71.4 Local validation (after the #148 merge)
425 tests passed; the RLS migration tests passed (RLS assertions **478**, `ALL ORG-RLS ASSERTIONS PASSED`);
lint, typecheck, build, auth-safety, and migration-safety all passed; generated database types remained 1828
lines.

### 71.5 Scope / status
**No app_user to person match write is implemented. No app code changed. No schema changed in this verification
PR. No migration changed in this verification PR. No connector behavior changed. No provider API call was made.
No OAuth code was exchanged for tokens. No access token was stored. No refresh token was stored. No API key was
stored. No connector credentials were stored. No connector secret material was inserted, updated, deleted, or
read. No connector sync was implemented. No credential form was implemented. No connect/reconnect/disconnect
action was exposed to users. No browser-accessible service-role request path was added. No production data was
touched. Connector implementation remains blocked. Old-app parity is not complete. UI/UX parity is not
complete. AI/API connector parity is not complete. Upload is not automatically production-ready. Hosted
Auth/tenant-context is verified, but old-app replacement is not yet verified. RISK-001 remains OPEN. RISK-007
remains OPEN. Cutover remains BLOCKED.** No doc 17 §5 box is ticked by this verification.
## 72. Implementation — deterministic identity-match write path (PR #150)

**Deterministic app_user to person identity-match write path is added. This is the first canonical user
matching write path** (migrations `0027`+`0028` + `identity-match-write.ts`, `src/lib/server/connector-vault/`). It
connects an app_user to a person ONLY on deterministic, tenant-safe evidence, so canonical user rollups can
count DISTINCT people instead of raw app accounts. This stays separate from provider sync, probabilistic
matching, and human-review promotion.

### 72.1 The write surface (0027)
Deterministic app_user to person identity-match write path is added. This is the first canonical user matching write path.
`app_user_identity_matches` had RLS enabled with ONLY a SELECT policy (default-deny for writes). Migration
`0027` adds the `0004`-hardened write surface — editors INSERT + editors UPDATE, and **NO DELETE policy** (the
`0004` directive for this table: future write policies must omit DELETE). The helper writes ONLY through the
authenticated user-scoped (RLS) path — **No service-role client is added.** Migration `0028` adds the tenant-scoped app_user uniqueness constraint
`UNIQUE(tenant_id, app_user_id)` — the integrity guard that makes the new editor INSERT policy safe (one
app_user resolves to AT MOST ONE person per tenant; a false double-match is rejected at the DB layer).
(Constraint/policy only — generated types are unaffected.)

### 72.2 Deterministic-only, fail closed
**Only deterministic identity evidence may write. Exact normalized email matches may write. Exact
provider/external identity matches may write where tenant-bound.** `applyDeterministicIdentityMatches` matches
an app_user to a person on: an exact normalized email (app_user.email == person.primary_email, or ==
identity_accounts.email tied to a person); or an exact provider external-user-id tied to a person. **Display-
name-only matches do not write. Domain-only matches do not write. Probabilistic matches do not auto-write.
Ambiguous matches do not auto-write. Multiple candidate people route to review/no-write. Existing conflicting
matches are not overwritten.** No email/external id, multiple candidate people, a tenant mismatch, an existing
match to a different person, or malformed input all fail closed to review (a false person-merge is more
expensive than leaving an app_user unmatched). The deterministic AUTO match is recorded with a `match_method`
(`auto_exact_email` / `auto_identity_account_email` / `auto_external_id`) that distinguishes it from a future
human-confirmed match (a different `match_method` + `reviewed_by`).

### 72.3 Idempotent + tenant-scoped
**Identity matching is tenant-scoped. Repeated deterministic identity match runs are idempotent. Repeated runs
do not create duplicate app_user_identity_matches.** The write upserts on the natural key
`(tenant_id, app_user_id)` (UNIQUE from `0028`) — `ON CONFLICT (tenant_id, app_user_id) DO NOTHING` — so a
re-run adds no rows. The `0001` `UNIQUE(app_user_id, person_id)` is kept, but **`(tenant_id, app_user_id)` is
the constraint that backs the write/idempotency invariant and prevents false person double-matches** — the DB
itself REJECTS a second match for the same app_user to a DIFFERENT person (a `unique_violation`), not only the
helper's in-code conflict check (the editor INSERT policy from `0027` cannot violate this). Tenant scoping
comes from the authenticated `tenantId` + RLS (writes nothing without an authenticated tenant); a candidate
claiming a different tenant is never matched.

### 72.4 Non-destructive correction
**Unmatch/repoint is modeled and non-destructive. Unmatch/repoint does not delete app_users, people,
identity_accounts, apps, contracts, invoices, or audit history.** `repointIdentityMatch` UPDATEs a match's
`person_id` to the correct person — it deletes nothing. Because `app_user_identity_matches` has NO DELETE policy
(the `0004` directive), a wrong match is repointed, never erased. (A soft "unmatched" status would need a future
status column — intentionally NOT invented here; this PR stays minimal and documents the limitation.)

### 72.5 Scope + tests (T49 + identity-match-write.test.ts; RLS suite **478 → 492**; types **1828** 0-diff)
**No app graph write is implemented in this PR. No app_alias write is implemented in this PR.** The helper
writes ONLY `app_user_identity_matches` — never a vendor/product/alias/canonical row. T49 proves the
persisted-state guarantees on real Postgres (the {SELECT, INSERT, UPDATE}-only/no-DELETE policy surface,
re-insert → unchanged count, repoint as a non-destructive UPDATE, Tenant B cannot read/insert a Tenant A match);
the helper tests prove the deterministic-evidence/fail-closed/conflict/idempotency/tenant-isolation behaviors
and the no-app-graph/no-service-role/no-secret/no-route surface.

**No provider API call is made. No OAuth code is exchanged for tokens. No access token is stored. No refresh
token is stored. No API key is stored. No connector credentials are stored. No connector secret material is
inserted, updated, deleted, or read. No connector sync is implemented. No credential form is implemented. No
connect/reconnect/disconnect action is exposed to users. No browser-accessible service-role request path is
added. No production data was touched. No hosted commands were run. Connector implementation remains blocked.
Old-app parity is not complete. UI/UX parity is not complete. AI/API connector parity is not complete. Upload
is not automatically production-ready. Hosted Auth/tenant-context is verified, but old-app replacement is not
yet verified. RISK-001 remains OPEN. RISK-007 remains OPEN. Cutover remains BLOCKED.** No doc 17 §5 box is
ticked by this PR.
## 73. Staging verification — identity match `0027`+`0028` (PR #151)

**Identity match write policies are applied and verified on staging. Identity match tenant app_user uniqueness
is applied and verified on staging.** A human applied `0027_app_user_identity_match_write_policies.sql` and
`0028_app_user_identity_match_tenant_unique.sql` to the staging project `ycdpzduxugdsffjqyoai` (current main
`3f596ba` — PR #150) and verified the live constraints + policies. **The staging apply and verification were
human-run; this PR only records the evidence — the agent did not touch staging, ran no hosted command, and made
no staging/production mutation.**

### 73.1 Observed — PASS
Staging is aligned through migration 0028.
Before the push, staging was missing `0027` and `0028`; the human-run `supabase db push` applied both;
**Staging is aligned through migration 0028** — `supabase migration list --linked` showed staging aligned
through `0028` after the push.

Constraint verification: **The app_user_identity_matches_tenant_app_user_key constraint is present on staging.
The app_user identity-match natural key is UNIQUE (tenant_id, app_user_id). The database enforces one app_user
to at most one person per tenant on staging.** **The existing pair constraint UNIQUE (app_user_id, person_id)
remains present** (`app_user_identity_matches_app_user_id_person_id_key`). **The pair constraint prevents
duplicate pairs, but the tenant/app_user constraint prevents false person double-matches.**

Policy verification: **The app_user_identity_matches INSERT policy is present on staging** (editors insert
app_user_identity_matches). **The app_user_identity_matches SELECT policy is present on staging** (org members
read related app_user_identity_matches). **The app_user_identity_matches UPDATE policy is present on staging**
(editors update app_user_identity_matches). **No DELETE policy is present for app_user_identity_matches.
Correction is repoint/update, not delete.**

### 73.2 Code ↔ constraint alignment (the verified claim, precisely scoped)
**The deterministic identity-match write helper uses the same tenant/app_user natural-key model** — it upserts
ON CONFLICT (tenant_id, app_user_id). **Local fixture tests prove repeated deterministic identity-match runs do
not increase app_user_identity_matches row count. Local tests prove duplicate candidate people route to
review/no-write. Local tests prove plus/dot email variants do not match. Local tests prove display-name-only
and domain-only candidates do not write.** **This is not a claim that all identity matching behavior is
complete** — the precise claim is that deterministic identity-match writes are idempotent for the verified
fixture cases, and the staging DB constraints/policies now enforce the tenant/app_user write invariant.

### 73.3 Local validation (after the #150 merge)
446 tests passed; the RLS migration tests passed (RLS assertions **492**, `ALL ORG-RLS ASSERTIONS PASSED`);
lint, typecheck, build, auth-safety, and migration-safety all passed; generated database types remained 1828
lines.

### 73.4 Scope / status — production NOT verified; preflight required first
No production migration was run for 0027 or 0028. Before production apply, a duplicate preflight query must be run against production and return zero rows.
**The deterministic identity-match write path is not yet verified on production. Production is not verified for
0027 or 0028. No production migration was run for 0027 or 0028** (a human applies them to production in a future
step; the agent never runs hosted commands). **Before production apply, a duplicate preflight query must be run
against production and return zero rows** (the same `(tenant_id, app_user_id)` HAVING count(*) > 1 check that
`0028` embeds — production must have NO existing duplicate before the UNIQUE is added). **No app graph write is
implemented in this verification PR. No app_alias write is implemented in this verification PR. No provider API
call was made. No OAuth code was exchanged for tokens. No access token was stored. No refresh token was stored.
No API key was stored. No connector credentials were stored. No connector secret material was inserted,
updated, deleted, or read. No connector sync was implemented. No credential form was implemented. No
connect/reconnect/disconnect action was exposed to users. No browser-accessible service-role request path was
added. No production data was touched. Connector implementation remains blocked. Old-app parity is not
complete. UI/UX parity is not complete. AI/API connector parity is not complete. Upload is not automatically
production-ready. Hosted Auth/tenant-context is verified, but old-app replacement is not yet verified. RISK-001
remains OPEN. RISK-007 remains OPEN. Cutover remains BLOCKED.** No doc 17 §5 box is ticked by this verification.
## 74. Production verification — identity match `0027`+`0028` (PR #152)

**Identity match write policies are applied and verified on production. Identity match tenant app_user
uniqueness is applied and verified on production.** A human applied `0027_app_user_identity_match_write_policies
.sql` and `0028_app_user_identity_match_tenant_unique.sql` to the production project `dzbfxulvxchdemcettrx`
(current main `7c60a06` — PR #151) and verified the live constraints + policies. **The production apply and
verification were human-run; this PR only records the evidence — the agent did not touch production, ran no
hosted command, and made no production mutation.**

### 74.1 Observed — PASS
Production is aligned through migration 0028. Staging and production are aligned through migration 0028. The
production duplicate preflight returned zero duplicate groups before apply.

Before the push, production was missing `0027` and `0028`; the `0028` duplicate preflight
(`(tenant_id, app_user_id)` HAVING count(*) > 1) returned `duplicate_group_count = 0` — no existing duplicate
to block the UNIQUE; the human-run `supabase db push` then applied both; `supabase migration list --linked`
showed **production aligned through 0028** after the push.

Constraint verification: **The app_user_identity_matches_tenant_app_user_key constraint is present on
production. The app_user identity-match natural key is UNIQUE (tenant_id, app_user_id). The database enforces
one app_user to at most one person per tenant on production. The existing pair constraint UNIQUE (app_user_id,
person_id) remains present** (`app_user_identity_matches_app_user_id_person_id_key`). **The pair constraint
prevents duplicate pairs, but the tenant/app_user constraint prevents false person double-matches.**

Policy verification: **The app_user_identity_matches INSERT policy is present on production** (editors insert
app_user_identity_matches). **The app_user_identity_matches SELECT policy is present on production** (org
members read related app_user_identity_matches). **The app_user_identity_matches UPDATE policy is present on
production** (editors update app_user_identity_matches). **No DELETE policy is present for
app_user_identity_matches. Correction is repoint/update, not delete.**

**Local Supabase link was returned to staging after production verification. Final linked ref was
ycdpzduxugdsffjqyoai.**

### 74.2 Code ↔ constraint alignment (the verified claim, precisely scoped)
**The deterministic identity-match write helper uses the same tenant/app_user natural-key model** — it upserts
ON CONFLICT (tenant_id, app_user_id). **Local fixture tests prove repeated deterministic identity-match runs do
not increase app_user_identity_matches row count. Local tests prove duplicate candidate people route to
review/no-write. Local tests prove plus/dot email variants do not match. Local tests prove display-name-only
and domain-only candidates do not write.** **This is not a claim that all identity matching behavior is
complete** — the precise claim is that deterministic identity-match writes are idempotent for the verified
fixture cases, and the production DB constraints/policies now enforce the tenant/app_user write invariant.

### 74.3 Local validation (after the #151 merge)
446 tests passed; the RLS migration tests passed (RLS assertions **492**, `ALL ORG-RLS ASSERTIONS PASSED`);
lint, typecheck, build, auth-safety, and migration-safety all passed; generated database types remained 1828
lines.

### 74.4 Scope / status — verification only
**No app code changed. No schema changed in this verification PR. No migration changed in this verification PR.
No connector behavior changed. No app graph write is implemented in this verification PR. No app_alias write is
implemented in this verification PR. No provider API call was made. No OAuth code was exchanged for tokens. No
access token was stored. No refresh token was stored. No API key was stored. No connector credentials were
stored. No connector secret material was inserted, updated, deleted, or read. No connector sync was
implemented. No credential form was implemented. No connect/reconnect/disconnect action was exposed to users.
No browser-accessible service-role request path was added. No production data was touched. Connector
implementation remains blocked. Old-app parity is not complete. UI/UX parity is not complete. AI/API connector
parity is not complete. Upload is not automatically production-ready. Hosted Auth/tenant-context is verified,
but old-app replacement is not yet verified. RISK-001 remains OPEN. RISK-007 remains OPEN. Cutover remains
BLOCKED.** No doc 17 §5 box is ticked by this verification.
## 75. Implementation — Okta discovery fact emitter (PR #153)

**Okta discovery fact emitter is added.** This is the FIRST real provider-data mapper
(`okta-discovery-emitter.ts`, `src/lib/server/connector-vault/`). **Okta provider records are transformed into
validated discovery facts** and **Okta facts are staged through the existing safe discovery fact pipeline**
(the PR #141 zod contract → the PR #142 `stageDiscoveryFactsForReview` RLS-backed staging path). It is treated
as high-risk: it maps records yielded by an INJECTED source (the real client is wired later), so **No live Okta
sync is implemented** and **No provider API call is made in production**.

### 75.1 What it emits (existing schema vocabulary only)
Okta facts are staged through the existing safe discovery fact pipeline.
- An Okta application → an `app_discovery` fact (the app exists; `discovered_app_name` = label, `source_app_id`
  = the Okta app id) + an `app_instance_identity` fact (the alias/instance fact: `external_instance_id` = the
  Okta app id = provider_app_id; `instance_domain`/`instance_url` ONLY from explicit `settings.app.domain`/`url`).
- An Okta user → an `app_user_account` fact (the Okta account) + a `person_identity_candidate` fact (the
  identity anchor) when a normalized email is available.
- An Okta app assignment → an `app_user_account` fact carrying the user↔app relationship (`app_id_hint` = the
  Okta app id).
- `source_type` is the existing enum value `identity_provider_discovery` (Okta is an identity-provider discovery
  source — the task's "provider/connector" maps onto this existing vocabulary; no new source_type is invented).
  `source_provider` = `okta`.

### 75.2 Allowlist construction + secret/config landmine blocking
Each fact is built from an EXPLICIT named allowlist of safe Okta fields (app: id/label/name/signOnMode/status +
explicit `settings.app.url`/`settings.app.domain` scalars; user: id/status/profile.email/profile.login;
assignment: id/app id/status) — the raw record is **never spread**. App-level config landmines are NEVER read:
not `settings` as a blob, not `settings.signOn` (signing keys), not `_links`, `credentials`, `client_secret`,
cookies, authorization headers, or any token — app-level Okta config is not assumed safe just because it is not
a user OAuth token. So an unexpected or secret field on a source record cannot reach `fact_json`/`provenance_json`
(proven by tests). Each built fact is re-validated via `parseDiscoveryFact` (`.strict()` + the provenance refine
reject any token/secret key), and the staging helper validates AGAIN.

### 75.3 Determinism, domain-explicitness, normalization, natural-key stability
- Confidence is HIGH (0.9) only because every fact is anchored on a deterministic Okta object id (app id / user
  id) — never on a name. No name-only canonical guess is emitted (no `vendor_product` mapping); canonical
  resolution stays a later, reviewable step. **Okta facts do not write canonical graph records directly. Okta
  facts do not write app_user_identity_matches directly.**
- A `domain`/`instance_domain` is emitted ONLY from a structured, explicit Okta field (`settings.app.domain`) —
  NEVER inferred from label/name/vendor/signOnMode/a guessed URL/display text. An app with only
  label/name/signOnMode/status emits no domain/instance_domain (negative test).
- Email/login normalization REUSES the existing `normalizeEmail` from `resolution.ts` (trim + lowercase only;
  no dot/plus stripping, no domain canonicalization): `Jane.Doe@Acme.com` == `jane.doe@acme.com`; `jane.doe` ≠
  `janedoe`; `jane+test` ≠ `jane`.
- `natural_key` derives from immutable Okta provider ids (app id / user id / app id + user id) via the staging
  helper — changing label/status does not change it; two different apps produce different keys; the same record
  twice produces an identical key (tests).

### 75.4 Safety / tenant scope
Provider payload tenant_id is not trusted. Tenant scope comes from authenticated/server context.
**Provider payload tenant_id is not trusted. Tenant scope comes from authenticated/server context** — every
fact's `tenant_id` is the authenticated argument, never the provider payload (a payload `tenant_id` is simply
never read), and `emitOktaDiscoveryFacts` stages NOTHING without an authenticated tenant. A malformed record (no
stable id) is skipped; one bad record never blocks the rest. The injected source is the only seam (unit tests
inject a mock, so there is NO live API call); the module imports only the three sibling server-only modules
(`discovery-facts`, `discovery-fact-staging`, `resolution`).

### 75.5 Documented schema gaps (no casual schema invention)
There is no dedicated `app_alias` fact type in the current schema, so alias signals are carried as
`app_instance_identity` discriminators (`external_instance_id`, `instance_domain`). A distinct **`sso_app_id`**
alias and explicit **group/app-assignment → `group_membership`** emission have no clean home in the wired source
today; rather than expand the schema or the source plumbing casually, those are left as documented gaps for a
later schema/source PR (the required `app_user_account` user↔app relationship IS emitted).

### 75.6 Scope / status (tests **446 → 472**; RLS **492**; types **1828** 0-diff; no migration)
**No OAuth code is exchanged for tokens. No access token is stored. No refresh token is stored. No API key is
stored. No connector credentials are stored. No connector secret material is inserted, updated, deleted, or read.
No connector sync is implemented. No credential form is implemented. No connect/reconnect/disconnect action is
exposed to users. No browser-accessible service-role request path is added.** No direct write to apps /
app_aliases / vendors / app_products / people / app_users / app_user_identity_matches — only validated discovery
facts are staged. No service-role client, no public unauthenticated route, no production/hosted command.
**Connector implementation remains blocked. Old-app parity is not complete. UI/UX parity is not complete. AI/API
connector parity is not complete. Upload is not automatically production-ready. Hosted Auth/tenant-context is
verified, but old-app replacement is not yet verified. RISK-001 remains OPEN. RISK-007 remains OPEN. Cutover
remains BLOCKED.** No doc 17 §5 box is ticked by this PR.
## 76. Implementation — connector secret vault storage/decrypt boundary (PR #154)

The connector secret VAULT storage/decrypt boundary — the highest-risk security layer so far. It wires the
reviewed envelope crypto (`crypto.ts`) to the `connector_secrets` store behind two STRUCTURALLY SEPARATE
capabilities, so future runner-only connector execution can store encrypted secrets and decrypt them ONLY from a
runner-only boundary. **No live Okta sync is added. This PR does not store real customer tokens. No hosted
staging/production commands were run.**

### 76.1 What this PR implements
- **`secret-vault.ts`** (server-only): `saveConnectorSecret` (encrypt-only), `loadConnectorSecret` (runner-only
  decrypt), `acquireRunnerDecryptCapability`, the `RunnerDecryptCapability` token, and the `RedactedSecret`
  wrapper. Its only import is the sibling `crypto.ts`; no Supabase client, no service-role, no `fetch`, no
  `process.env`, no route/UI.
- **Encrypt/save vs decrypt are structurally different paths.** `saveConnectorSecret` accepts an ENCRYPT-ONLY
  key provider (`generateDataKey` only) and writes ONLY ciphertext; it is given no decrypt key, so the save path
  cannot decrypt by construction (its crypto call gets a throwing `unwrapDataKey`). The save RESULT is a redacted
  reference — no plaintext, no ciphertext, no wrapped DEK.
- **Decrypt is keyed to a runner-only capability, not merely a server-only import.** `loadConnectorSecret`
  requires a `RunnerDecryptCapability`, produced ONLY by `acquireRunnerDecryptCapability` and ONLY when the
  runner-runtime marker is present AND a decrypt-capable KMS provider is supplied. The capability's constructor
  is gated by a module-private symbol token, so it cannot be forged by request-path code. **Request-path decrypt
  is forbidden and tested** (a missing/forged capability fails closed).
- **Migration `0029`** grants the existing `connector_runner` (NOLOGIN, BYPASSRLS, reached only via
  `connector_runner_login` + `SET ROLE`) a NARROW **COLUMN-SCOPED** SELECT/INSERT on `connector_secrets` — the
  deferred secret-store grant `0021` planned. It is column-scoped, NOT table-level (the runner is BYPASSRLS, so
  a table grant would expose every column of every row + any future column), pinned to the exact identity/
  active/envelope columns the `secret-vault.ts` store uses — SELECT (id, tenant_id, connector_id, secret_kind,
  version, status, expires_at, ciphertext, dek_wrapped, aead_nonce, aad_digest, key_id) and INSERT (the
  identity/write + envelope columns). NO UPDATE, NO DELETE, NO TRUNCATE/REFERENCES/TRIGGER, NO table-level
  SELECT/INSERT. **The request-path deny-all is preserved, not weakened**: `connector_secrets` stays RLS-enabled
  with ZERO policies (no DELETE policy, no ALL policy); `authenticated`/`anon` keep EXACTLY zero table + column
  privilege. Generated types unchanged (grants are not columns).
- **Structural redaction.** `RedactedSecret` redacts `toString`/`toJSON`/`util.inspect`; bytes are reachable
  only via `.expose()` (runner use). Errors are typed, static, secret-free. Tests prove the save result omits
  plaintext + ciphertext, the wrapper redacts string/JSON/inspect, and crypto/decrypt errors carry no secret
  material.
- **Defense in depth (catalog-testable now):** request-path deny-all on `connector_secrets` (T39/T40 preserved);
  the narrow COLUMN-SCOPED runner grant (T50 — the exact column-level SELECT/INSERT sets, NO table-level grant,
  no UPDATE/DELETE; functional insert+select of granted columns works, a non-granted column read + update/delete
  are `insufficient_privilege`); the AAD context binding rejects a cross-tenant/cross-context decrypt; tenant_id
  is bound from the server context, never the secret payload.

### 76.2 The decrypt boundary's hosted enforcement (NOT verified in this PR)
In production the REAL cryptographic decrypt boundary is the KMS `Decrypt` grant: the runner's IAM identity has
`kms:Decrypt`; the web/request-path identity does NOT, so its KMS client's `decrypt` fails even with ciphertext
in hand. This PR ships the CODE-LEVEL boundary (the capability gate + the env marker + the narrow DB grant) and
proves it with unit + catalog tests against a MOCK KMS. It does NOT wire a real KMS client and does NOT run in a
hosted environment, so the runtime IAM-grant separation is UNVERIFIED here. That is remaining RISK-007 work.

### 76.3 RISK-007 status — **RISK-007 remains OPEN**
RISK-007 is NOT closed, NOT "effectively addressed", NOT "mostly closed". Precise status:

**Completed by this PR:**
- Encrypted-storage primitive (envelope AES-256-GCM, `crypto.ts`) + a save/load boundary that uses it.
- Request-path-inaccessible secret table (deny-all) — preserved and re-asserted (T39/T40/T50).
- A narrow, explicit, catalog-testable runner grant (`column-scoped SELECT/INSERT`, no UPDATE/DELETE — T50).
- A runner-only decrypt CAPABILITY gate (code-level) + structural redaction + secret-free errors.
- No service-role / request-path leakage (auth-safety + the purity/RLS tests).

**Remaining for RISK-007 (still OPEN):**
- The hosted KMS-grant runtime separation (runner has `kms:Decrypt`, web does not) — the real cryptographic
  decrypt boundary — is NOT wired and NOT verified here (mock KMS only; no real `KmsClient`).
- Audited access/use of secrets (who decrypted what, when) — NOT built.
- Revocation / rotation / tombstone — NOT built (UPDATE/DELETE deliberately NOT granted to the runner).
- Staging verification of `0029` + the vault path — NOT done (no hosted commands run).
- Production verification — NOT done.
- The at-rest schema is incomplete: `connector_secrets` has columns for ciphertext/dek_wrapped/aead_nonce/
  aad_digest/key_id but NONE for the GCM auth `tag` or the `v`/`alg` format metadata that `crypto.ts`'s
  `EncryptedConnectorSecret` carries, so a real secret cannot yet round-trip end to end — a later schema PR
  must add and grant those columns.
- The live provider wiring that would actually store a real token — NOT built (and still gated by RISK-007).

### 76.4 Status (tests **472 → 487**; RLS **492 → 519**; types **1828** 0-diff; migration `0029`)
**No provider API call is made. No OAuth code is exchanged for tokens. No access token is stored. No refresh
token is stored. No API key is stored. No connector credentials are stored. No connector secret material is
inserted, updated, deleted, or read in a hosted environment. No connector sync is implemented. No credential
form is implemented. No connect/reconnect/disconnect action is exposed to users. No browser-accessible
service-role request path is added.** No service-role client; no public route; no UI; no live Okta; no real
customer token stored; any live verification is future work. **Connector implementation remains blocked. Old-app
parity is not complete. RISK-001 remains OPEN. RISK-007 remains OPEN. Cutover remains BLOCKED.** No doc 17 §5 box
is ticked by this PR.

## Staging verification - connector secret vault grants 0029

Staging verification for `0029_connector_runner_secret_grants.sql` completed on project `ycdpzduxugdsffjqyoai`.

Verified:

- staging migration list shows `0029` applied remotely
- `connector_runner` has column-scoped `INSERT`/`SELECT` on `connector_secrets` only
- `connector_runner` has no table-level `SELECT`/`INSERT` on `connector_secrets`
- `connector_runner` has no `UPDATE` or `DELETE` on `connector_secrets`
- `authenticated` and `anon` have no `SELECT` on `connector_secrets`
- `connector_secrets` has zero RLS policies
- local project relink remains staging `ycdpzduxugdsffjqyoai`

Evidence:

- `role_column_grants` shows `INSERT` on `aad_digest`, `aead_nonce`, `ciphertext`, `connector_id`, `dek_wrapped`, `key_id`, `secret_kind`, `tenant_id`, `version`
- `role_column_grants` shows `SELECT` on `aad_digest`, `aead_nonce`, `ciphertext`, `connector_id`, `dek_wrapped`, `expires_at`, `id`, `key_id`, `secret_kind`, `status`, `tenant_id`, `version`
- table privilege check returned `runner_table_select=false`, `runner_table_insert=false`, `runner_update=false`, `runner_delete=false`, `authenticated_select=false`, `anon_select=false`, `policy_count=0`

`RISK-007` remains OPEN. This verifies the staging DB grant surface only; it does not prove hosted KMS/IAM separation, real credential storage, rotation/revocation, audit, or production readiness. Cutover remains BLOCKED.

## Production verification - connector secret vault grants 0029

Production verification for `0029_connector_runner_secret_grants.sql` completed on project `dzbfxulvxchdemcettrx`.

Verified:

- production migration list shows `0029` applied remotely
- `connector_runner` has column-scoped `INSERT`/`SELECT` on `connector_secrets` only
- `connector_runner` has no table-level `SELECT`/`INSERT` on `connector_secrets`
- `connector_runner` has no `UPDATE` or `DELETE` on `connector_secrets`
- `authenticated` and `anon` have no `SELECT` on `connector_secrets`
- `connector_secrets` has zero RLS policies
- local project was relinked back to staging `ycdpzduxugdsffjqyoai`

Evidence:

- `role_column_grants` shows `INSERT` on `aad_digest`, `aead_nonce`, `ciphertext`, `connector_id`, `dek_wrapped`, `key_id`, `secret_kind`, `tenant_id`, `version`
- `role_column_grants` shows `SELECT` on `aad_digest`, `aead_nonce`, `ciphertext`, `connector_id`, `dek_wrapped`, `expires_at`, `id`, `key_id`, `secret_kind`, `status`, `tenant_id`, `version`
- table privilege check returned `runner_table_select=false`, `runner_table_insert=false`, `runner_update=false`, `runner_delete=false`, `authenticated_select=false`, `anon_select=false`, `policy_count=0`

`RISK-007` remains OPEN. This verifies the production DB grant surface only; it does not prove hosted KMS/IAM separation, real credential storage, rotation/revocation, audit, or cutover readiness. Cutover remains BLOCKED.
## 77. Implementation — connector secret envelope schema completion (PR #157)

This completes the **at-rest encrypted-envelope SHAPE** for `connector_secrets` — and ONLY that. #154 added the
vault save/load boundary, but the table (0017) had columns for only FIVE of the eight `EncryptedConnectorSecret`
fields (crypto.ts), so a real encrypted secret could not be persisted + loaded as a COMPLETE envelope. Migration
`0030` adds the three missing columns and extends the runner's COLUMN-scoped grant to cover them.

### 77.1 The completed mapping (every envelope field now has a column)
`ciphertext → ciphertext` · `wrappedDek → dek_wrapped` · `iv → aead_nonce` · `aadDigest → aad_digest` ·
`kekId → key_id` (all 0017) — plus the new 0030 columns: **`tag → aead_tag`** (the 16-byte GCM auth tag,
REQUIRED to decrypt), **`v → envelope_version`** (the payload format version), **`alg → aead_alg`** (the AEAD
algorithm label). `secret-vault.ts` adds pure `encryptedSecretToColumns` / `columnsToEncryptedSecret` mappers
(base64/hex ↔ bytea/text); a store-facing test round-trips a real encrypted payload encrypt → columns →
reconstruct (byte-identical) → decrypt → original plaintext, and `columnsToEncryptedSecret` FAILS CLOSED on an
incomplete row (NULL tag/version/alg — the pre-0030 shape) or an unsupported version/algorithm.

### 77.2 Non-destructive + column-scoped grant (no broadening)
The three columns are NULLABLE with NULL-permissive CHECKs (aead_tag is 16 bytes; envelope_version ≥ 1;
aead_alg is `AES-256-GCM`), so any existing row stays valid — no column is dropped, renamed, or retyped (no real
secret was ever stored: #155/#156 verified the grant surface, they did NOT write a secret). The runner grant
stays COLUMN-scoped (the #154 correction): `REVOKE ALL` then re-`GRANT SELECT/INSERT` the column sets EXTENDED
with the three new columns — **NO table-level SELECT/INSERT, NO UPDATE/DELETE/TRUNCATE/REFERENCES/TRIGGER**.
`authenticated`/`anon` keep EXACTLY zero table + column privilege; `connector_secrets` stays RLS-enabled with
ZERO policies. T50 asserts the exact post-0030 column grants (now 15 SELECT / 12 INSERT columns) + the new
aead_tag/envelope_version grants, and functionally writes the complete envelope. Generated types DO change (new
columns): **1828 → 1837**.

### 77.3 RISK-007 status — **RISK-007 remains OPEN**
This completes the SCHEMA SHAPE for encrypted-envelope persistence ONLY — NOT hosted KMS/IAM separation, NOT
audit, NOT rotation/revocation, NOT cutover readiness. The at-rest schema gap is now CLOSED (the envelope can be
persisted + loaded complete), but the OTHER RISK-007 gaps remain OPEN:
- the hosted KMS-grant runtime separation (runner has `kms:Decrypt`, the web/request-path identity does not —
  the real cryptographic decrypt boundary) — NOT wired/verified (mock KMS only, no real `KmsClient`);
- audited secret access/use; revocation/rotation/tombstone (UPDATE/DELETE still deliberately not granted);
- staging verification of `0030`; production verification of `0030`; live provider token storage.

**No real KMS client is added. No live Okta sync is added. This PR does not store real customer tokens. No
service-role path is added. No provider API call is made. No OAuth code is exchanged for tokens. No access token
is stored. No refresh token is stored. No API key is stored. No connector credentials are stored. No connector
secret material is inserted, updated, deleted, or read in a hosted environment. No connector sync is implemented.
No credential form is implemented. No connect/reconnect/disconnect action is exposed to users. No
browser-accessible service-role request path is added. No hosted staging/production commands were run.
Connector implementation remains blocked. Old-app parity is not complete. RISK-001 remains OPEN. RISK-007 remains
OPEN. Cutover remains BLOCKED.** No doc 17 §5 box is ticked by this PR.

## Staging verification - connector secret envelope schema 0030

Staging verification for `0030_connector_secret_envelope_columns.sql` completed on project `ycdpzduxugdsffjqyoai`.

Verified:

- staging migration list shows `0030` applied remotely
- `connector_secrets` has the new encrypted-envelope columns: `aead_alg`, `aead_tag`, `envelope_version`
- `aead_alg` is `text`, nullable
- `aead_tag` is `bytea`, nullable
- `envelope_version` is `smallint`, nullable
- `connector_runner` has column-scoped `INSERT`/`SELECT` on the complete encrypted envelope column set
- `connector_runner` has no table-level `SELECT`/`INSERT`
- `connector_runner` has no `UPDATE` or `DELETE`
- `authenticated` and `anon` have no `SELECT`
- `connector_secrets` has zero RLS policies
- local project remains linked back to staging `ycdpzduxugdsffjqyoai`

Evidence:

- new columns: `aead_alg text YES`, `aead_tag bytea YES`, `envelope_version smallint YES`
- `role_column_grants` includes `INSERT` on `aad_digest`, `aead_alg`, `aead_nonce`, `aead_tag`, `ciphertext`, `connector_id`, `dek_wrapped`, `envelope_version`, `key_id`, `secret_kind`, `tenant_id`, `version`
- `role_column_grants` includes `SELECT` on `aad_digest`, `aead_alg`, `aead_nonce`, `aead_tag`, `ciphertext`, `connector_id`, `dek_wrapped`, `envelope_version`, `expires_at`, `id`, `key_id`, `secret_kind`, `status`, `tenant_id`, `version`
- table privilege check returned `runner_table_select=false`, `runner_table_insert=false`, `runner_update=false`, `runner_delete=false`, `authenticated_select=false`, `anon_select=false`, `policy_count=0`

`RISK-007` remains OPEN. This verifies the staging DB schema and grant surface only; it does not prove hosted KMS/IAM separation, real credential storage, rotation/revocation, audit, or cutover readiness. Cutover remains BLOCKED.

## Production verification - connector secret envelope schema 0030

Production verification for `0030_connector_secret_envelope_columns.sql` completed on project `dzbfxulvxchdemcettrx`.

Verified:

- production migration list shows `0030` applied remotely
- `connector_secrets` has the new encrypted-envelope columns: `aead_alg`, `aead_tag`, `envelope_version`
- `aead_alg` is `text`, nullable
- `aead_tag` is `bytea`, nullable
- `envelope_version` is `smallint`, nullable
- `connector_runner` has column-scoped `INSERT`/`SELECT` on the complete encrypted envelope column set
- `connector_runner` has no table-level `SELECT`/`INSERT`
- `connector_runner` has no `UPDATE` or `DELETE`
- `authenticated` and `anon` have no `SELECT`
- `connector_secrets` has zero RLS policies
- local project was relinked back to staging `ycdpzduxugdsffjqyoai`

Evidence:

- new columns: `aead_alg text YES`, `aead_tag bytea YES`, `envelope_version smallint YES`
- `role_column_grants` includes `INSERT` on `aad_digest`, `aead_alg`, `aead_nonce`, `aead_tag`, `ciphertext`, `connector_id`, `dek_wrapped`, `envelope_version`, `key_id`, `secret_kind`, `tenant_id`, `version`
- `role_column_grants` includes `SELECT` on `aad_digest`, `aead_alg`, `aead_nonce`, `aead_tag`, `ciphertext`, `connector_id`, `dek_wrapped`, `envelope_version`, `expires_at`, `id`, `key_id`, `secret_kind`, `status`, `tenant_id`, `version`
- table privilege check returned `runner_table_select=false`, `runner_table_insert=false`, `runner_update=false`, `runner_delete=false`, `authenticated_select=false`, `anon_select=false`, `policy_count=0`

`RISK-007` remains OPEN. This verifies the production DB schema and grant surface only; it does not prove hosted KMS/IAM separation, real credential storage, rotation/revocation, audit, live provider token storage, or cutover readiness. Cutover remains BLOCKED.
## 78. Implementation — runner-backed connector_secrets store adapter (PR #160)

Wires the vault save/load boundary to the real `connector_secrets` table over the COMPLETE `0030` encrypted
envelope. `connector-secret-store.ts` (`createRunnerConnectorSecretStore`) implements the existing injected
`ConnectorSecretWriteStore` / `ConnectorSecretReadStore` (secret-vault.ts) using the runner DB client path ONLY.
It adds NO migration (the `0029`/`0030` grant + schema already exist) and stores NO real provider token (nothing
calls it with one yet). This is the DB read/write adapter ONLY.

### 78.1 Runner-only, column-scoped, parameterized
- Every statement runs under **`SET ROLE connector_runner`** via the injected `RunnerConnection` (the same seam
  as `runner-db-client.ts`, wrapped by `createRunnerDbClient` which prepends the `SET ROLE` and redacts raw DB
  errors). NO service-role / global / request-path client; NO Supabase client import; NO `fetch`; NO
  `process.env`; NO route/UI. The module imports only `./runner-db-client` + `./secret-vault`.
- **SAVE** inserts ONLY the 12 granted write columns — identity (`tenant_id`, `connector_id`, `secret_kind`,
  `version`) + the complete envelope (`ciphertext`, `dek_wrapped`, `aead_nonce`, `aad_digest`, `key_id`,
  `aead_tag`, `envelope_version`, `aead_alg`) via `encryptedSecretToColumns`. It NEVER writes `id` (server
  default), `is_active`/`status`/`created_at`/`revoked_at`. `RETURNING id`; every value is parameterized
  (`$1..$12`). The returned result is the row id ONLY — **no plaintext, no ciphertext**.
- **LOAD** selects ONLY granted columns and filters to one ACTIVE, non-expired row for
  (tenant, connector, kind, version): `... and status = 'active' and (expires_at is null or expires_at > now())`,
  reconstructing the complete envelope via `columnsToEncryptedSecret`. Identity values are parameterized
  (`$1..$4`).
- **NO UPDATE and NO DELETE** are issued here (revocation/rotation stays deferred — RISK-007).

### 78.2 Fail-closed
A missing insert id, MORE THAN ONE matching active row (`limit 2` detects it), or an INCOMPLETE/unsupported
stored envelope (the `columnsToEncryptedSecret` mapper rejects a pre-`0030`/partial row or a non-v1/non-AES
algorithm) all throw a typed, secret-free error; a no-match load returns `null`.

### 78.3 Tests
`connector-secret-store.test.ts` (mock `RunnerConnection`) proves: the save/load issue `SET ROLE
connector_runner` then the parameterized statement; the INSERT/SELECT name ONLY allowed columns (no
`is_active`/`created_at`/`revoked_at`, no `id` in the insert list, no UPDATE/DELETE/TRUNCATE); the save result
carries no plaintext/ciphertext; the load reconstructs the complete envelope byte-identical and decrypts;
fail-closed on no-id / ambiguous (>1) / incomplete row; and the server-only purity surface (only sibling
imports; no service-role/client/fetch/process.env/route). **T51** runs the adapter's EXACT SELECT shape as
`connector_runner` against real Postgres — proving every projected/filtered column (incl. `status`/`expires_at`)
is grant-accessible under the `0029`/`0030` COLUMN grant AND that the active/expiry/status filter is correct;
**T50 is unchanged (not weakened)**. Tests **489 → 499**; RLS suite **522 → 525**; generated types unchanged
(**1837**, 0-diff — no migration).

### 78.4 RISK-007 status — **RISK-007 remains OPEN**
This is the runner DB read/write adapter ONLY. It does NOT prove or provide hosted KMS/IAM separation (the real
decrypt boundary — runner has `kms:Decrypt`, web does not; mock KMS only, no real `KmsClient`), real
end-to-end runner secret write/load against hosted, audit, rotation/revocation, live provider token storage, or
cutover readiness. **No service-role path is added. No browser/request-path access is added. No public route is
added. No OAuth code is exchanged for tokens. No real provider token is stored. No Okta live client is added. No
UPDATE or DELETE on connector_secrets is issued. No hosted staging/production commands were run. Connector
implementation remains blocked. Old-app parity is not complete. RISK-001 remains OPEN. RISK-007 remains OPEN.
Cutover remains BLOCKED.** No doc 17 §5 box is ticked by this PR.
## 79. Verification harness — connector secret store synthetic dry-run (PR #161)

Adds `scripts/verify-staging-connector-secret-store-dry-run.mjs` (+ its guard test) — a **human-run, staging-only,
NO-REAL-TOKEN** runbook emitter that proves the PR #160 runner-backed connector_secrets store adapter can WRITE
and LOAD a **synthetic** encrypted secret through the REAL hosted grant shape, without ever using or printing a
real provider token. **This is still no-real-token verification INFRASTRUCTURE** — the agent does NOT run it; a
human operator runs the emitted runbook against staging in a later evidence PR.

### 79.1 What the harness is (and is not)
It is a runbook EMITTER, identical in safety posture to `verify-staging-connector-vault-dry-run.mjs`: it connects
to NOTHING, performs NO hosted mutation itself, and prints NO secret values. The confirmed path only PRINTS an
ordered, parameterized runbook the operator executes. It calls NO provider API, exchanges NO OAuth code, uses NO
real Okta/Slack/Google token, adds NO public route, uses NO service-role path, and never makes the web/request
runtime capable of decrypting (the unwrap/decrypt step runs only as the runner with the runner's KMS Decrypt
grant).

### 79.2 Gates (fail closed)
Refuses the PRODUCTION ref `dzbfxulvxchdemcettrx`; requires the STAGING ref `ycdpzduxugdsffjqyoai`; requires the
explicit confirmation phrase `RUN CONNECTOR SECRET STORE STAGING DRY RUN`; requires the hosted DB connections by
ENV NAME only (`CONNECTOR_RUNNER_DB_URL`, `CONNECTOR_VAULT_SETUP_DB_URL`; KMS env is OPTIONAL); never reads,
prints, or interpolates an env VALUE. The only payload is the synthetic sentinel
`synthetic-vault-dry-run-not-a-token`.

### 79.3 What the runbook proves (synthetic data only)
(1) required hosted env present by name; (2) linked ref is staging, not production; (3) a narrow, explicit
synthetic tenant+connector seed (setup conn) that is cleaned up; (4) the runner DB path uses `SET ROLE
connector_runner`; (5) the store adapter WRITE uses ONLY the 12 allowed encrypted-envelope columns (the adapter's
exact INSERT shape, parameterized); (6) the adapter LOAD reads back ONLY an active/non-expired matching synthetic
row (the adapter's SELECT shape); (7) the envelope is reconstructed from the columns; (8) KMS wrap/unwrap of the
synthetic payload works IF KMS env is supplied; (9) wrong tenant/connector/kind/version returns 0 (fail closed);
(10) expired/revoked/inactive rows are NOT returned; (11) cleanup is narrow + synthetic-keyed ONLY, on the
SETUP/admin connection (the runner holds NO DELETE grant — and this PR adds NONE; deleting the synthetic
connector cascades its connector_secrets); (12) the runbook records RISK-007 OPEN + cutover BLOCKED.

### 79.4 Constraints honored
Parameterized SQL only; no broad deletes; no real token-shaped sample values; NO UPDATE on connector_secrets;
the cleanup DELETE runs on the setup/admin conn (NOT the runner) and is synthetic-keyed. It does NOT broaden
`connector_runner` privileges, adds NO grant, and does NOT weaken T50 or T51 (no migration, no RLS-test change).
The guard test proves: refuses production / unknown ref / no-confirmation / missing-env; prints no env/secret
VALUE (var names only); synthetic payload only with no provider-token / token-exchange / provider-client strings;
the secret INSERT names exactly the 12 allowed columns (no id/is_active/created_at/revoked_at); the SQL is
parameterized and the cleanup is narrow synthetic-keyed; no GRANT; source imports only `node:fs`.

### 79.5 Status — **RISK-007 remains OPEN**
**This PR adds the harness only; it includes NO direct human-run hosted evidence, so hosted KMS/IAM separation is
NOT proven by it. Real connector credential storage/use is still NOT allowed.** A green human-run dry run (a
future evidence PR) would prove the store-adapter SHAPE with SYNTHETIC data only — it would NOT store a real
credential and would NOT, on its own, prove hosted KMS/IAM separation. **No provider API call is made. No OAuth
code is exchanged for tokens. No access token / refresh token / API key / connector credential is stored. No
real provider token is used. No connector sync is implemented. No connect/reconnect/disconnect action is exposed
to users. No browser-accessible service-role request path is added. No hosted staging/production commands were
run by the agent. Connector implementation remains blocked. Old-app parity is not complete. Connector
credentials are not production-ready. RISK-001 remains OPEN (no separate hosted evidence in this PR). RISK-007
remains OPEN. Cutover remains BLOCKED.** No doc 17 §5 box is ticked by this PR.
## 80. Staging verification — connector secret store synthetic dry-run (PR #163)

A human operator ran the PR #161 NO-REAL-TOKEN staging synthetic dry-run of the PR #160 runner-backed
connector_secrets store adapter on staging `ycdpzduxugdsffjqyoai`, and it PASSED for the store-adapter DB SHAPE
with SYNTHETIC data only. **The dry-run and its verification were human-run; this PR only records the non-secret
evidence — the agent did not touch staging and ran no hosted command.** Recorded 2026-06-24.

### 80.1 What ran
- Script: `scripts/verify-staging-connector-secret-store-dry-run.mjs` — the #161 harness (`dc8abcc`,
  sha256 `7048c678…b3eb82`), generated for staging only.
- Staging ref used: `ycdpzduxugdsffjqyoai`. **Production ref `dzbfxulvxchdemcettrx` was NOT used.**
- Synthetic sentinel `synthetic-vault-dry-run-not-a-token` only. No real provider token was used. No secret
  values were printed.

### 80.2 Observed — PASS (synthetic data only)
- **`SET ROLE connector_runner`** was used for the runner path.
- The adapter's **12-column INSERT** path returned **1 row** (writes only the allowed identity + envelope
  columns).
- The adapter's **active/non-expired SELECT** path returned **1 row**.
- A **wrong tenant/connector/kind/version** SELECT returned **0 rows** (fail closed).
- **Expired and revoked** rows were **excluded** from the active/non-expired SELECT.
- **Cleanup was narrow and synthetic-keyed** (the synthetic tenant + `dryrun-kek-%` key prefix, on the
  setup/admin connection; the runner holds no DELETE grant and none was added).

### 80.3 The precise claim — what this does and does NOT prove
This run proves the runner-backed store-adapter **DB grant SHAPE** on real hosted staging: the `0029`/`0030`
COLUMN-scoped INSERT/SELECT under `SET ROLE connector_runner`, the active/non-expired filter, fail-closed on a
wrong context, expired/revoked exclusion, and narrow synthetic-keyed cleanup — all with SYNTHETIC data only.

It does **NOT**:
- store a real connector credential (only the synthetic sentinel was used);
- **prove hosted KMS/IAM separation** — the run did not exercise (or did not record) a real KMS Decrypt/unwrap
  against a request-path-vs-runner IAM boundary, so the hosted KMS/IAM decrypt separation remains UNVERIFIED;
- prove a full end-to-end real-secret encrypt→store→load→decrypt path against a real KMS;
- permit real connector credential storage or use.

### 80.4 Remaining RISK-007 work (still OPEN)
Hosted KMS/IAM grant runtime separation (runner has `kms:Decrypt`, web does not — the real cryptographic decrypt
boundary), audited secret access/use, revocation/rotation/tombstone, and real (non-synthetic) credential storage
all remain. **No real KMS client is added. No live Okta sync is added. This PR stores no real customer token. No
service-role path is added. No provider API call was made. No OAuth code was exchanged for tokens. No connector
credential is stored. No hosted production commands were run. Connector implementation remains blocked. Old-app
parity is not complete. Connector credentials are not production-ready. RISK-001 remains OPEN. RISK-007 remains
OPEN. Cutover remains BLOCKED.** No doc 17 §5 box is ticked by this PR.
## 81. Verification harness — hosted KMS/IAM separation synthetic dry-run (PR #164)

Adds `scripts/verify-staging-kms-iam-separation-dry-run.mjs` (+ its guard test) — a **human-run, staging-only,
SYNTHETIC-ONLY** runbook emitter for the **key remaining RISK-007 boundary**: proving that the hosted RUNNER
runtime CAN `kms:Decrypt` and the WEB/REQUEST runtime CANNOT. **This PR adds the harness only; it includes NO
direct human-run hosted evidence, so the KMS/IAM separation is NOT proven by it.** RISK-007 stays OPEN.

### 81.1 What the harness is (and is not)
A runbook EMITTER, same safety posture as the §79 store-adapter harness: it connects to NOTHING, performs NO
hosted action itself, and prints NO secret values. The confirmed path only PRINTS an ordered runbook the human
operator executes. It is a **KMS/IAM test ONLY** — it touches NO database, writes NO `connector_secrets` row, and
**broadens NO `connector_runner` DB grant** (no migration, no RLS change). It calls NO provider API, exchanges NO
OAuth code, stores NO real credential, and creates NO public route to secrets. It never grants the web/request
runtime decrypt capability.

### 81.2 Gates (fail closed)
Refuses the PRODUCTION ref `dzbfxulvxchdemcettrx`; requires the STAGING ref `ycdpzduxugdsffjqyoai`; requires the
confirmation phrase `RUN KMS IAM SEPARATION STAGING DRY RUN`; requires the hosted identity/config by ENV NAME
only (`CONNECTOR_VAULT_AWS_KMS_REGION`, `CONNECTOR_VAULT_KMS_KEY_ID`, `CONNECTOR_VAULT_RUNNER_AWS_PROFILE`,
`CONNECTOR_VAULT_WEB_AWS_PROFILE`); never reads/prints/interpolates an env VALUE. The only plaintext is the
synthetic sentinel `synthetic-kms-dry-run-not-a-token`. Output is redacted — plaintext (after creation),
ciphertext, data keys, wrapped DEKs, KMS response bodies, ARNs, and key material are NEVER printed; the operator
records only PASS/FAIL + an error CLASS (e.g. `AccessDenied`).

### 81.3 What the runbook tests (synthetic material only)
1. **RUNNER POSITIVE** — as the runner IAM identity: `kms:GenerateDataKey` → DEK + wrapped DEK; AES-256-GCM
   encrypt the synthetic sentinel; `kms:Decrypt` the wrapped DEK → recover the DEK → decrypt → assert it equals
   the synthetic sentinel. Expect PASS (the runner CAN GenerateDataKey/Encrypt/Decrypt — requirement 1).
2. **WEB/REQUEST NEGATIVE (the load-bearing proof)** — as the web/request IAM identity: attempt `kms:Decrypt` on
   the wrapped DEK → **expect `AccessDeniedException`**. If it SUCCEEDS, the separation is BROKEN (the web
   runtime can decrypt vault secrets) — recorded as FAIL + a RISK-007 finding, not as proof (requirement 2).
3. **WEB SURFACE** — confirm the web identity's intended KMS scope (encrypt-only, or none); the only hard
   requirement is that `kms:Decrypt` is DENIED.
4. **EVIDENCE distinction** — a future human-run evidence PR must distinguish: (a) the DB grant SHAPE already
   proven by #163; (b) KMS/IAM separation PROVEN by this run ONLY if step 1 = PASS AND step 2 = DENIED, else NOT
   proven (or BROKEN); (c) real-credential readiness STILL blocked until audit + rotation/revocation + lifecycle
   are complete.
5. **FAILURE STATES (explicit + safe)** — runner cannot decrypt → vault crypto/IAM path broken (NOT proven);
   web CAN decrypt → separation BROKEN (RISK-007 finding); a missing identity/KEK/permission setup →
   INCONCLUSIVE (NOT proven; no false claim). No key material printed in any state.

### 81.4 Status — **RISK-007 remains OPEN**
This harness ADDS the test capability; it does NOT itself prove anything (the agent does not run it). Even a
green human-run dry run would prove ONLY the **KMS/IAM decrypt separation** with SYNTHETIC material — it would
NOT store a real credential and would NOT, on its own, close RISK-007: **audited secret access/use,
revocation/rotation/tombstone, and the full real-credential lifecycle remain.** **No real KMS client is added to
app code. No live Okta sync is added. This PR stores no real customer token. No service-role path is added. No
provider API call is made. No OAuth code is exchanged for tokens. No connector credential is stored. No
connector_runner DB grant is broadened. No hosted command was run by the agent. Connector implementation remains
blocked. Old-app parity is not complete. Connector credentials are not production-ready. RISK-001 remains OPEN.
RISK-007 remains OPEN. Cutover remains BLOCKED.** No doc 17 §5 box is ticked by this PR.
## 82. Staging verification — hosted KMS/IAM separation synthetic dry-run (PR #165)

A human operator ran the PR #164 SYNTHETIC-ONLY hosted KMS/IAM separation dry-run on staging
`ycdpzduxugdsffjqyoai`, and the **load-bearing negative passed**: the hosted RUNNER identity can use KMS for the
synthetic vault path, and the WEB/REQUEST identity is DENIED `kms:Decrypt`. **The dry-run and its verification
were human-run; this PR only records the non-secret evidence — the agent did not touch staging and ran no hosted
command.** Recorded 2026-06-24.

This UPDATES the §80 (#163) note that the hosted KMS/IAM separation was UNVERIFIED: the **synthetic KMS/IAM
decrypt separation boundary is now PROVEN** on staging. It does **NOT** close RISK-007 — see §82.4.

### 82.1 What ran
- Script: `scripts/verify-staging-kms-iam-separation-dry-run.mjs` — the #164 harness (`073eb84`), generated for
  staging only.
- Staging ref used: `ycdpzduxugdsffjqyoai`. **Production ref `dzbfxulvxchdemcettrx` was NOT used** (PASS).
- Synthetic plaintext `synthetic-kms-dry-run-not-a-token` only (PASS). No real provider token used (PASS). No
  secret values printed (PASS).

### 82.2 Observed — PASS (synthetic material only)
- **Two distinct IAM identities:** runner profile works (PASS); web/request profile works (PASS); the runner and
  web/request identities are different (PASS).
- **Runner POSITIVE:** `kms:GenerateDataKey` path (PASS); `kms:Encrypt` path (PASS); `kms:Decrypt` path (PASS);
  synthetic envelope encrypt/decrypt under the runner DEK round-trips to the synthetic sentinel (PASS).
- **Web/request NEGATIVE (load-bearing):** web/request identity `kms:Decrypt` is DENIED (PASS) — the proof of
  separation.
- **No side effects:** no DB grants changed (PASS); no `connector_secrets` rows written (PASS); no production
  command run (PASS); cleanup/not-applicable (PASS — the KMS test persists no DB state).

### 82.3 The precise claim — what this proves
This proves the **hosted staging SYNTHETIC KMS/IAM decrypt separation boundary**: the runner identity can use
KMS for the synthetic vault path (GenerateDataKey + Encrypt + Decrypt + a synthetic envelope round-trip), and the
web/request identity is DENIED `kms:Decrypt`. The load-bearing NEGATIVE test passed (web decrypt denied), so the
boundary holds with synthetic material. A web/request decrypt SUCCESS would have been a RISK-007 failure; it did
not occur.

### 82.4 What this does NOT do — **RISK-007 remains OPEN**
This evidence is **synthetic-only** and involves **no real connector credential**. It does **NOT**:
- close RISK-007 by itself;
- permit real connector credential storage or use;
- supply the still-missing **audit** of secret access/use, **rotation/revocation/tombstone**, or the **real
  credential lifecycle** — all of which remain before any real credential can be stored or used.

**No real KMS client is added to app code. No live Okta sync is added. This PR stores no real customer token. No
service-role path is added. No public route to secrets is added. No `connector_runner` DB grant is broadened. No
provider API call was made. No OAuth code was exchanged for tokens. No connector credential is stored. No hosted
production commands were run. Connector implementation remains blocked. Old-app parity is not complete. Connector
credentials are not production-ready. RISK-001 remains OPEN. RISK-007 remains OPEN. Cutover remains BLOCKED.** No
doc 17 §5 box is ticked by this PR.
## 83. Connector secret lifecycle audit scaffolding (PR #166)

Adds a narrow, ALLOWLIST-based connector-secret lifecycle **audit-event builder** —
`src/lib/server/connector-vault/secret-audit.ts` (+ load-bearing redaction tests) — for store/load/decrypt
lifecycle metadata only. It does **not** store or expose any secret and does **not** enable real credentials.

### 83.1 Scope — builder + tests only (honest integration)
The #160 runner-backed store adapter has **no real call sites yet** and there is **no real credential lifecycle**,
so per the scope rule this PR adds the **pure builder + tests only** — it wires NO writer and emits NO audit row.
A future server-only writer (when a real lifecycle exists) maps the builder's output 1:1 onto the existing
append-only `audit_logs` table (`action` / `resource_type` / `tenant_id` / `after_json`; `created_at` is the DB
default). **No migration is added** — `audit_logs` (0001, append-only via the 0002 reject-mutation trigger)
already supports these events as `action` strings + an allowlisted `after_json`. **Do not claim the real
credential lifecycle emits audit events — no real lifecycle exists.**

### 83.2 Supported events (this PR) — store / load / decrypt only
`connector_secret.store.attempted|succeeded|failed`, `connector_secret.load.attempted|succeeded|failed`,
`connector_secret.decrypt.attempted|succeeded|failed` (nine total). **Rotation/revocation/delete/update events
are intentionally NOT added** — those belong with the behavior that emits them, which does not exist yet.

### 83.3 Allowlist, not denylist (the load-bearing property)
`buildConnectorSecretAuditEvent(input)` constructs `after_json` from an EXPLICIT set of permitted fields and
NEVER spreads the input — there is no metadata-passthrough field, so any extra property on a (hostile) input is
structurally DROPPED (never read, never in the output). Allowed metadata only: `event`, `tenant_id` (the repo's
`tenant_id` convention), `connector_id`, `secret_kind`, `version`, derived `result` status, optional `actor_type`
(allowlist: `connector_runner`), optional static `error_class` (a fixed allowlist; unknown → `unknown_error`;
honored only on `.failed`, dropped otherwise), and an optional safe-shaped `correlation_id`. Identity fields are
uuid-shaped; `secret_kind` is a bounded lower-snake token; `correlation_id` is restricted to a uuid or a short
prefixed id (`run-`/`job-`/`req-`/`corr-`/`trace-`/`span-`…) so a high-entropy opaque blob (a 64-char hex key, a
base64 DEK, key material) is structurally rejected rather than echoed. As defense in depth, every emitted string
value is re-scanned with the shared credential-value guard, so a credential-shaped value cannot ride in through
an allowed field.

**Hard-prohibited (structurally dropped or rejected):** plaintext, provider/refresh/access token, client secret,
ciphertext, DEK / wrapped DEK, key material, AEAD tag, nonce/IV, `aad_digest`, KMS response body, DB URL, env
values, raw error object, and arbitrary metadata passthrough. The redaction tests feed an intentionally hostile
object containing all of these and assert none of the names or values survive into the audit record, thrown
errors, or snapshots; that unknown fields are DROPPED (not redacted-in-place); that error handling records only a
safe static class; that the event type is restricted to the nine supported events (rotation/revocation rejected);
and that the source opens no DB/provider/route/service-role path.

### 83.4 What this is NOT — **RISK-007 remains OPEN**
This is audit SCAFFOLDING only. It stores no real provider token, exchanges no OAuth code, executes no connector,
adds no request-path decrypt, no service-role secret path, and no API route for secret save/load/decrypt; it adds
no `UPDATE`/`DELETE` on `connector_secrets` and no rotation/revocation events or behavior; it broadens no
permission and adds no migration. Prior synthetic evidence stands: the **synthetic DB grant/adapter shape is
proven by #163** and the **synthetic KMS/IAM decrypt separation is proven by #165**. Real connector credential
storage/use is still **NOT allowed**; **rotation/revocation and the real credential lifecycle remain missing**.
**Connector implementation remains blocked. Old-app parity is not complete. Connector credentials are not
production-ready. RISK-001 remains OPEN. RISK-007 remains OPEN. Cutover remains BLOCKED.** No doc 17 §5 box is
ticked by this PR.
## 84. Connector secret store/load audit wiring — ATOMIC, fail-closed (PR #167)

Wires the #166 allowlist audit builder into the #160 runner-backed store adapter so every store/load operation
emits a PERSISTED audit row, with FAIL-CLOSED semantics. This stores NO real credential, calls NO provider, and
does NOT decrypt; RISK-007 remains OPEN.

### 84.1 Preconditions (answered before implementing — the amendment's gate)
1. **Shared transaction supported — YES.** `RunnerConnection.runSequence(statements)` runs an ordered statement
   array on ONE connection, so a single `runSequence([set role connector_runner, begin, INSERT connector_secrets …
   returning id, INSERT audit_logs, commit])` is one transaction containing BOTH inserts.
2. **The audit writer enlists in the runner transaction — YES.** `secret-audit-writer.ts` is a PURE
   statement-builder: it turns a #166 record into the `audit_logs` INSERT `{sql, params}` that the store adapter
   splices into its OWN `runSequence` (same connection, same `connector_runner` role, same `begin`/`commit`). It
   opens NO connection, uses NO separate role, owns NO RPC/transaction.
3. **connector_runner can INSERT audit_logs — only after migration `0031`.** It could not before; `0031` adds the
   smallest safe grant: COLUMN-scoped INSERT on `audit_logs` of EXACTLY `(tenant_id, action, resource_type,
   after_json)`. audit_logs ONLY; no select/update/delete; no other table.
4. **Append-only holds for the runner — YES** (proven under `set role connector_runner` in T52): the 0002
   `audit_logs_no_mutation` trigger (`before update or delete`) fires for every role, so the runner can INSERT but
   never UPDATE/DELETE an audit row.
5. **The two inserts share a transaction — YES** → wired implementation (not a stop-and-propose).

### 84.2 STORE is atomic (no orphaned, unaudited secret; no compensating delete)
`insertEncryptedSecret` runs the `connector_secrets` INSERT and its `connector_secret.store.succeeded` audit
INSERT in ONE runner transaction (`begin … commit`). The secret row commits ONLY if its audit row commits; if the
audit INSERT fails, the WHOLE transaction rolls back — there is NEVER a committed secret without its audit, and
there is NO compensating DELETE. `store.attempted` (before) and `store.failed` (on a rolled-back failure) are
audit-only writes, each fail-closed (a failed audit write throws and aborts the operation). T52 proves the atomic
commit AND the atomic rollback under the real `connector_runner` role.

### 84.3 LOAD is fail-closed by ordering (caller gets no secret when audit fails)
`findEncryptedSecret` is a read (no row to roll back). It writes `load.attempted`, runs the SELECT, then writes
`load.succeeded` (or `load.failed` with a static class — `ambiguous_match`/`invalid_envelope`/`load_failed`)
BEFORE returning. If the `load.succeeded` audit write fails, the load THROWS and the caller receives NO
secret/envelope.

### 84.4 Allowlist glue + redaction
The adapter passes the #166 builder ONLY the explicit identity it picks from the store input (`tenant_id`,
`connector_id`, `secret_kind`, `version`, actor `connector_runner`, and a static `error_class` on failures) —
NEVER the raw input, the `encrypted` envelope, plaintext, ciphertext, a DEK/tag/nonce/aad_digest, a KMS response,
a DB URL, or a raw error. Any hostile/benign extra field on the store input is structurally dropped (tested with
secret-shaped fields AND a benign `favoriteColor`). The audit row is the #166 allowlist `after_json` only; the
writer serializes exactly the four granted columns.

### 84.5 What this is NOT — **RISK-007 remains OPEN**
Only the six store/load events are wired; **decrypt audit remains BUILDER-ONLY** (no decrypt call site exists) and
NO `rotation`/`revocation`/`delete`/`update` event is introduced. The synthetic DB grant/adapter shape is proven
by #163 and the synthetic KMS/IAM decrypt separation by #165, but this PR stores NO real provider token, exchanges
NO OAuth code, executes NO connector, adds NO request-path decrypt, NO service-role secret path, and NO API route;
it adds NO UPDATE/DELETE on `connector_secrets` and NO rotation/revocation. The only privilege broadened is the
narrow `0031` audit-INSERT grant (audit_logs only). **Real connector credential storage/use is still NOT allowed;
rotation/revocation and the real credential lifecycle remain missing. Connector implementation remains blocked.
Old-app parity is not complete. Connector credentials are not production-ready. RISK-001 remains OPEN. RISK-007
remains OPEN. Cutover remains BLOCKED.** No doc 17 §5 box is ticked by this PR.
## 85. Connector secret lifecycle data model — DECISION: Model B (PR #168, design/spec only)

**This is a design/spec PR. It resolves the connector-secret lifecycle (rotation / revocation / tombstone) data
model and gives the next implementation PR exact instructions. NO lifecycle behavior, migration, code, or runtime
event constant is added here.** RISK-007 remains OPEN.

### 85.1 Decision — Model B (separate append-only lifecycle table)
Lifecycle state lives in a **separate, INSERT-only `connector_secret_lifecycle_events` table**, NOT in a mutable
`connector_secrets.status`. **`connector_secrets` stays append-only: no UPDATE, no DELETE, no new UPDATE grant.**

**Why Model B (not "UPDATE connector_secrets.status"):**
- Rotation is naturally insert-only — a new secret version is a NEW `connector_secrets` row (higher `version`).
- Revocation must support **revoke-without-replacement**, which an insert-only event expresses cleanly.
- Updating `connector_secrets.status` would require granting `connector_runner` **UPDATE** on the secret table —
  weakening the exact append-only invariant RISK-007 has protected (T50 asserts no runner UPDATE/DELETE).
- A separate lifecycle table keeps the encrypted-envelope rows **immutable** and lifecycle state **append-only**.
- The load query gets more complex, but the complexity is contained, explicit, and testable (see §85.6).

### 85.2 Data model — `connector_secret_lifecycle_events` (proposed; INSERT-only)
A minimal append-only table. **All lifecycle writes are INSERT-only.** Proposed shape (the implementation PR
finalizes exact types against the live schema):

| column | notes |
| --- | --- |
| `id` | uuid pk, server default |
| `tenant_id` | uuid not null, FK `tenants(id)` on delete cascade (tenant isolation key) |
| `connector_id` | uuid not null, FK `connectors(id)` |
| `secret_kind` | text not null (the bounded lower-snake kind, matching `connector_secrets`) |
| `version` | integer not null (the targeted secret version) |
| `lifecycle_event_type` | text not null, CHECK in (`revoked`, `tombstoned`, `superseded`) — `superseded` only if needed |
| `reason_class` | text — a SAFE STATIC reason class only (a fixed allowlist; never free-form, never a raw error) |
| `actor_type` | text — actor/runtime type if available (e.g. `connector_runner`) |
| `correlation_id` | text — request/job/run id, grammar-safe only (uuid or `run-`/`job-`/… prefixed; see §83.3) |
| `audit_log_id` | uuid null — optional reference to the paired `audit_logs` row, if useful |
| `created_at` | timestamptz not null default `now()` (the DB owns the timestamp) |

**Hard-prohibited columns/values (never stored):** plaintext, provider/access/refresh token, client secret,
ciphertext, DEK / wrapped DEK / key material, AEAD tag, nonce/IV, `aad_digest`, KMS response, DB URL, env values,
raw error object, or any arbitrary-metadata passthrough. The table holds ONLY non-secret lifecycle metadata.

### 85.3 Lifecycle monotonicity (toward non-loadable; never reversible)
Lifecycle events are **monotonic toward a non-loadable state**:
- The presence of ANY `revoked` event for a `(tenant_id, connector_id, secret_kind, version)` **permanently** makes
  that version non-loadable.
- The presence of ANY `tombstoned` event for that key **permanently** makes that version non-loadable.
- There is **NO** `unrevoked` / `reactivated` / `restored` / `untombstoned` (or equivalent) event — none is
  defined, none may be added without a separate reviewed design change.
- A later lifecycle event MUST NOT make a revoked/tombstoned version loadable again.
- If multiple lifecycle events exist for the same version, **any terminal non-loadable event WINS** (revoked or
  tombstoned dominates `superseded` and dominates the absence of events).

### 85.4 Rotation semantics
- INSERT a NEW `connector_secrets` row with a **higher `version`** (a new encrypted envelope).
- The old version's row remains **immutable** — **no UPDATE, no DELETE** of the old secret row.
- The old version MAY be marked `superseded` via an INSERT-only lifecycle event (optional; `superseded` alone is
  NOT terminal — it does not by itself make a version non-loadable, but a higher eligible version will win the
  latest-lookup per §85.6).
- When implemented, the rotation new-secret INSERT + the `superseded` lifecycle event (if used) + the rotation
  audit event **commit atomically** (§85.8).

### 85.5 Revocation semantics
- INSERT a lifecycle event row stating `(tenant_id, connector_id, secret_kind, version)` is `revoked`.
- The revoked secret version is **no longer loadable** (§85.3, §85.6).
- **Revoke-without-replacement is supported** (no new secret row is required).
- **No UPDATE** to `connector_secrets`; **no DELETE** from `connector_secrets`.
- When implemented, the revocation lifecycle event + its audit event **commit atomically** (§85.8).

### 85.6 Load query semantics — fail-closed latest-intent (resolve the ugly cases EXPLICITLY)
The load must be **fail-closed**. A version is **ELIGIBLE** iff: the exact `connector_secrets` row exists, is
`status='active'`, is not expired (`expires_at is null or expires_at > now()`), its stored envelope is complete/
well-formed, AND there is **NO** `revoked` and **NO** `tombstoned` lifecycle event for that exact version.

**Exact-version lookup** (the current `findEncryptedSecret(tenant, connector, kind, version)`): return the secret
**only if that exact version is ELIGIBLE**; otherwise return `null` / fail closed.

**Latest-version lookup** (if/when added — NOT in the current adapter): this is **latest-INTENT, not
highest-eligible**:
1. Determine the **highest `version`** across ALL `connector_secrets` rows for `(tenant, connector, secret_kind)` —
   **including** revoked, tombstoned, superseded, expired, and malformed rows.
2. Evaluate **eligibility of that single highest version ONLY** (§ above).
3. If that highest version is revoked / tombstoned / expired / malformed / inactive / otherwise ineligible →
   return `null` / fail closed.
4. **DO NOT** silently fall back to a lower valid version. **DO NOT** compute "highest ELIGIBLE version" — that
   would silently skip a revoked/tombstoned/expired HIGHER version and violate the safety rule.
- **Reason:** falling back to a lower version can **resurrect an old credential** after an intended revoke, a
  failed rotation, or an expiry — which is unsafe.

**Expiry is treated as strictly as revocation in this phase:** highest version expired + lower version valid →
return `null` (deliberate fail-closed). Any future relaxation that allows expiry fallback MUST be a separate
reviewed design change, **never an implementation accident**.

**Explicit edge cases (all must be documented + tested when implemented):**
- several active versions exist → the highest version wins **only if eligible**;
- highest version expired, lower version valid → **null** (no fallback);
- highest version revoked, lower version active → **null** (no fallback);
- highest version tombstoned, lower version active → **null** (no fallback);
- all versions revoked → **null**;
- exact version revoked → **null**;
- exact version expired → **null**;
- tombstoned version → **null**;
- multiple lifecycle events for a version (incl. revoked/tombstoned) → the **terminal non-loadable event wins**.

### 85.7 Tombstone semantics
- An explicit INSERT-only `tombstoned` lifecycle event.
- Makes the secret version **non-loadable** (§85.3, §85.6).
- Used for intentional, **non-destructive** retirement — **no hard delete** of the secret row.
- When implemented, the tombstone lifecycle event + its audit event **commit atomically** (§85.8).

### 85.8 Grants & RLS (spec for the implementation PR)
- **`connector_secrets`:** NO UPDATE/DELETE grant — unchanged. Rotation = a new INSERT row (the existing 0029/0030
  column INSERT/SELECT grant already covers it). T50 stays intact.
- **`connector_secret_lifecycle_events`:** narrow, explicit grants only —
  - `connector_runner` needs **column-scoped INSERT** (the non-secret lifecycle columns) for revoke/tombstone/
    supersession events;
  - `connector_runner` needs **column-scoped SELECT** (the eligibility columns: tenant/connector/kind/version/
    `lifecycle_event_type`) so the load query can test revocation/tombstone state;
  - `connector_runner` must **NOT** get UPDATE or DELETE on the lifecycle table;
  - no broad grants; no grant to `anon`/`authenticated`/`public` beyond a tenant-member RLS read if desired;
  - **no service-role request path; no public/API route.**
- **Append-only protection:** an `audit_logs`-style `before update or delete` trigger (or equivalent) MUST reject
  UPDATE/DELETE on the lifecycle table, **proven under `set role connector_runner`** (mirror T52).
- **RLS/tests** must prove tenant isolation (a tenant cannot read another tenant's lifecycle events) and the runner
  grant boundary (INSERT + SELECT only; no UPDATE/DELETE; column-scoped).

### 85.9 Atomicity requirements (for the implementation PR)
When implemented, each lifecycle mutation + its audit event **commit atomically in ONE runner transaction**
(the §84 pattern; the audit writer enlists in the runner tx — no separate connection/role/RPC):
- rotation: new-secret INSERT + (optional) `superseded` lifecycle event + the rotation audit event — atomic;
- revocation: `revoked` lifecycle event + the revocation audit event — atomic;
- tombstone: `tombstoned` lifecycle event + the tombstone audit event — atomic;
- **audit failure rolls back the lifecycle change; lifecycle-write failure rolls back the audit write; NO
  compensating DELETE.**

**Real DB tests (under `set role connector_runner`) must prove:** audit failure leaves no lifecycle event;
lifecycle failure leaves no audit event; rotation audit failure leaves no new secret row; revocation audit
failure leaves no lifecycle event; tombstone audit failure leaves no lifecycle event; no hard delete exists;
append-only enforcement holds under `connector_runner`.

### 85.10 Audit event names — RESERVED in prose only (no runtime constants here)
The lifecycle audit events below are **reserved by name** for the implementation PR. **Do NOT add these as
runtime event constants until the behavior is implemented** (the #166 builder still supports ONLY the nine
store/load/decrypt events; #167 wired ONLY the six store/load events; decrypt + these lifecycle events remain
unwired):
`connector_secret.rotation.{attempted,succeeded,failed}`,
`connector_secret.revocation.{attempted,succeeded,failed}`,
`connector_secret.tombstone.{attempted,succeeded,failed}`.

### 85.11 Status — **RISK-007 remains OPEN**
**Model B is the selected lifecycle model.** `connector_secrets` remains append-only; revocation/tombstone state
will be INSERT-only in the separate `connector_secret_lifecycle_events` table; latest lookup computes the highest
version across ALL rows first, then checks eligibility, with NO fallback to lower versions; lifecycle events are
monotonic and revoked/tombstoned versions cannot be reactivated. **No lifecycle behavior, migration, code, or
runtime event constant is implemented in this PR.** Store/load audit (the synthetic DB shape proven by #163, the
KMS/IAM decrypt separation by #165, the audit scaffolding #166, and the atomic store/load audit wiring #167)
stands; this PR only DESIGNS the lifecycle model on top of it. **Real connector credential storage/use is still
NOT allowed; rotation/revocation behavior and the real credential lifecycle remain missing. Connector
implementation remains blocked. Old-app parity is not complete. Connector credentials are not production-ready.
RISK-001 remains OPEN. RISK-007 remains OPEN. Cutover remains BLOCKED.** No doc 17 §5 box is ticked by this PR.
## 86. Model B lifecycle table + lifecycle-aware load (PR #169, implementation)

Implements the §85 Model B lifecycle TABLE and the lifecycle-aware LOAD only. **Read-only this PR:** it adds NO
lifecycle write helper, NO lifecycle audit event/runtime constant, and NO runner INSERT grant on the lifecycle
table — those land with the revoke/tombstone write helpers in the next PR. `connector_secrets` stays append-only.
RISK-007 remains OPEN.

### 86.1 Migration `0032` — `connector_secret_lifecycle_events` (INSERT-only)
A new append-only table holding ONLY non-secret lifecycle metadata (id, tenant_id, connector_id, secret_kind,
version, `lifecycle_event_type` ∈ {revoked, tombstoned, superseded}, `reason_class`, actor_type, correlation_id,
optional `audit_log_id`, created_at). It carries NO plaintext/ciphertext/DEK/wrapped-DEK/key-material/AEAD-tag/
nonce/IV/aad_digest/KMS-response/raw-error/env value. Same-tenant FK `(connector_id, tenant_id) → connectors`.
Deny-all RLS (zero policies; authenticated/anon get nothing). An append-only trigger
(`connector_secret_lifecycle_no_mutation`, `before update or delete`) rejects UPDATE/DELETE for EVERY role.

### 86.2 Grants — SELECT-ONLY for `connector_runner` (this PR)
`grant select (tenant_id, connector_id, secret_kind, version, lifecycle_event_type) on
connector_secret_lifecycle_events to connector_runner` — EXACTLY the five columns the load eligibility check reads.
**NO INSERT** (the runner reads lifecycle state here; lifecycle WRITES + the runner INSERT grant are deferred to
the write-helper PR — do not grant privileges ahead of code), **NO UPDATE, NO DELETE**. `connector_secrets`
keeps NO UPDATE/DELETE grant (T50 intact). In tests, lifecycle rows are seeded ONLY by the test/admin setup path.

### 86.3 Lifecycle-aware load (the load-bearing claim)
The runner load query is now lifecycle-aware (Model B fail-closed latest-INTENT — §85.6):
- **Exact-version** (`findEncryptedSecret`): the SELECT adds a `NOT EXISTS (… lifecycle_event_type IN
  ('revoked','tombstoned') …)` for the exact `(tenant, connector, kind, version)`. It returns the secret ONLY if
  the exact version is active, non-expired, well-formed, AND has no terminal lifecycle event. The `NOT EXISTS` is
  **purely additive** — with no lifecycle rows it is always true, so the no-lifecycle path is byte-for-byte the
  pre-lifecycle (#163/#167) behavior (regression-proven).
- **Latest-INTENT** (`findLatestEncryptedSecret`, new): resolves the **highest `version` across ALL rows**
  (`select max(version) …`, including revoked/tombstoned/superseded/expired/inactive — a NUMBER only, no secret),
  then loads the eligibility of **THAT single version only** via the lifecycle-aware exact load. It **NEVER falls
  back to a lower version**: if the highest version is revoked/tombstoned/expired/inactive — or its stored
  envelope is incomplete/unsupported — it returns null (or throws, as the envelope mapper fails closed at that
  version). Highest revoked + lower active → null; highest tombstoned + lower active → null; highest expired +
  lower valid → null; all revoked → null. **Eligibility is defined ONLY by `status='active'` + non-expired + no
  `revoked`/`tombstoned` lifecycle event** (the #169 prompt's "if a row is not provably eligible, fail closed").
  There is **no `malformed` SQL predicate or load-query branch**: an incomplete/unsupported envelope simply makes
  the envelope mapper (`columnsToEncryptedSecret`) fail closed at the resolved version, which is NOT retried at a
  lower version — it is the pre-existing #167 fail-closed behavior, not a new eligibility condition.

### 86.4 Tests
- **Real DB (T53 / updated T51):** T53 proves TWO SEPARATE protections — (1) the runner GRANT SHAPE under
  `set role connector_runner` (SELECT-only on the five columns; INSERT/UPDATE/DELETE all FAIL); (2) the
  append-only TRIGGER itself, proven against a PRIVILEGED test/admin role that CAN attempt UPDATE/DELETE and is
  STILL rejected by the trigger (asserting the `append-only` error message — so the block is the trigger, NOT mere
  grant-absence). T53 also proves the lifecycle-aware SELECT excludes an ACTIVE version that has a `revoked`
  event, and that `connector_secrets` still has no runner UPDATE/DELETE. T51 now runs the lifecycle-aware SELECT
  shape (grant-compatible; identical result with no lifecycle rows).
- **Unit:** exact active/no-event → returns; exact excluded → null; latest highest active → returns the highest;
  latest highest revoked/tombstoned/expired with a lower valid → null AND the adapter queries ONLY the highest
  version (never the lower one — the no-fallback proof); no versions → null; regression: the no-lifecycle path is
  unchanged and the existing #167 store/load tests still pass against the new query. No secret/envelope/key
  material appears in any lifecycle row; no hard delete exists.

### 86.5 Status — **RISK-007 remains OPEN**
**Model B lifecycle table is implemented; load semantics are fail-closed latest-intent; `connector_runner` has
SELECT-only lifecycle access in this PR.** Lifecycle WRITE helpers (revoke/tombstone), the runner INSERT grant on
the lifecycle table, and lifecycle AUDIT events/writes are deferred to the next PR. **Real connector credential
storage/use remains NOT allowed; real credential save/load/use is still missing; rotation/revocation behavior and
the real credential lifecycle remain missing. No real provider token, no OAuth/token exchange, no live connector,
no request-path decrypt, no service-role secret path, no public route. No UPDATE/DELETE on `connector_secrets`; no
hard delete. Connector credentials are not production-ready. RISK-001 remains OPEN. RISK-007 remains OPEN. Cutover
remains BLOCKED.** No doc 17 §5 box is ticked by this PR.

## 87. Revoke/tombstone lifecycle write helpers + atomic lifecycle audit (PR #170, implementation)

Implements the §85/§86 Model B **write** side: the runner-only `revoke`/`tombstone` helpers that APPEND a
`revoked`/`tombstoned` lifecycle event for an EXISTING secret version, atomically with their audit, with exactly one
terminal outcome. `connector_secrets` is never mutated (the T50 append-only invariant holds).

**Migration `0033`** — a COLUMN-scoped `connector_runner` INSERT on `connector_secret_lifecycle_events` of EXACTLY
the eight safe-metadata columns (`tenant_id, connector_id, secret_kind, version, lifecycle_event_type, reason_class,
actor_type, correlation_id`); keeps the §86 SELECT grant; NO UPDATE/DELETE; NOT `id`/`created_at`/`audit_log_id`.

**Why a helper-level existence check (not a FK):** a clean composite FK from the lifecycle table to
`connector_secrets (tenant_id, connector_id, secret_kind, version)` would require adding a UNIQUE constraint to the
append-only `connector_secrets` table — awkward and out of scope. Instead existence is enforced IN the statement by
`ins_lifecycle`'s `WHERE EXISTS (the connector_secrets row)`, which is also the SINGLE source of truth for the
terminal outcome (below), so there is no second predicate that could race.

**`connector-secret-lifecycle.ts` — one atomic CTE (`LIFECYCLE_WRITE_SQL`):**

```
with ins_lifecycle as (
  insert into connector_secret_lifecycle_events (…8 cols…)
  select …  where exists (select 1 from connector_secrets cs where cs.tenant_id=$1 and …version=$4)
  returning version),                                  -- the SINGLE existence determination
  ins_attempted as ( insert audit <op>.attempted  values(…) ),                 -- UNCONDITIONAL
  ins_succeeded as ( insert audit <op>.succeeded  select … where exists     (select 1 from ins_lifecycle) ),
  ins_failed    as ( insert audit <op>.failed     select … where not exists (select 1 from ins_lifecycle) )  -- target_not_found
select count(*) from ins_lifecycle;                    -- 0 = nonexistent (THROW); 1 = ok
```

- **Exactly one terminal outcome:** `succeeded` and `failed` both derive from `ins_lifecycle`'s RETURNING, so they
  are mutually exclusive by construction — never both, never neither.
- **Nonexistent target:** the helper THROWS `ConnectorSecretLifecycleError` (the caller NEVER receives `{ ok }`); NO
  lifecycle row, NO `succeeded`; the `attempted` + `failed`(`target_not_found`) audit rows ARE committed (the failed
  attempt is auditable). The **orphan invariant binds lifecycle ROWS** (never reference a nonexistent version), NOT
  the attempted/failed AUDIT rows.
- **Atomic / fail closed:** it is ONE statement — any insert failure (e.g. the succeeded audit) rolls the WHOLE
  statement back (no lifecycle row without its audit, no compensating DELETE). A general DB error → throw, nothing
  committed.
- **Monotonic + permanent:** only a terminal `revoked`/`tombstoned` event is ever inserted — NO unrevoke/
  reactivate/restore, NO rotation helper. The helpers return `{ ok }` / throw — never a secret/envelope/key
  material; each audit row is the §82 (#166) allowlist builder's output only (a static `target_not_found` class on
  failure, never a raw error or credential shape). Six `revocation`/`tombstone` events + `target_not_found` were
  added to the #166 allowlist.

**Proof — RLS T54** (real DB, under the runner): grant shape (8 columns; no table-level INSERT; no UPDATE/DELETE);
the §86 append-only trigger STILL rejects the runner's and a privileged role's UPDATE/DELETE now that the runner
holds INSERT (row unchanged / still exists); the actual CTE for an EXISTING version → lifecycle + attempted +
succeeded (no failed, one terminal), for a NONEXISTENT version → attempted + failed(`target_not_found`) (no
lifecycle, no succeeded, one terminal); a forced in-CTE succeeded-audit failure rolls back the lifecycle insert.
Helper unit tests cover the same plus redaction + scope guards.

**Scope fences (unchanged):** no rotation helper, no real provider token, no OAuth/token exchange, no live connector
execution, no request-path decrypt, no service-role secret path, no public/API route. No UPDATE/DELETE on
`connector_secrets` or the lifecycle table; no hard delete. The §86 load semantics are unchanged. Real connector
credential storage/use remains NOT allowed; real credential save/load/use is still missing; rotation and the rest of
the real credential lifecycle remain missing. **RISK-001 remains OPEN. RISK-007 remains OPEN. Cutover remains
BLOCKED.** No doc 17 §5 box is ticked by this PR.

## 88. Real-token threat model & implementation gate (PR #171, docs only)

The synthetic vault is built (§76–§87). Before any **real** provider token is stored, decrypted, or used, the
safety requirements, the single allowed first-real-credential path, the threat model, the evidence gate, the kill
switch, and the merge gates are defined in a dedicated doc: **[44_CONNECTOR_CREDENTIAL_REAL_TOKEN_THREAT_MODEL](./44_CONNECTOR_CREDENTIAL_REAL_TOKEN_THREAT_MODEL.md)**.

Highlights (the canonical text is doc 44):
- **First real credential** = a Slack bot OAuth access token (`xoxb-`) from a disposable NON-production dev
  workspace, **source-revocable** via `auth.revoke` + app removal; refresh + rotation OUT of scope.
- **Only allowed ingestion path** = server-only callback → **runner** one-time `oauth.v2.access` exchange →
  **encrypt-only** key provider → atomic store; with a **complete plaintext-lifetime trace** (the deliverable) and a
  forbidden list. The browser never sees the token (only `state`+`code`).
- **Real decrypt/use stays BLOCKED** (runner-only when later allowed — no web/request/service-role decrypt, no route
  returns a token).
- **Blast-radius**, **RISK-007 closure evidence gate** (the staging dry-run **IS** the first real-token event, NOT
  synthetic), and a **provider-side-first kill switch**.
- **PR sequence:** A (this docs gate) → B (staging ingestion; also adds versioned `connector_runner_login` DDL) → C
  (staging decrypt) → D (live behind a staging flag) → E (prod-readiness) → only then RISK-007 closure.

This PR is **docs only** — no code, migration, test, or real token. **RISK-001 remains OPEN. RISK-007 remains OPEN.
Cutover remains BLOCKED.** Connector credentials are not production-ready. No doc 17 §5 box is ticked.

## 89. Staging-only store/encrypt ingestion path (PR #172, B1 — synthetic only)

Implements the **store/encrypt half** of the docs/44 §2 ingestion path — **B1 of the §7 B1/B2 split** — proven with
**synthetic sentinel values only**. The OAuth `oauth.v2.access` exchange + the first real-token event are deferred to
**B2** (token born server-side, no human handling); **merging B1 does NOT authorize a real-token run.**

**`connector-secret-ingest.ts` — `ingestStagingConnectorSecret(input, deps)`** is the smallest guarded server-only
entry that encrypts + stores through the existing `saveConnectorSecret` (encrypt-only provider → atomic store +
audit → redacted `SavedSecretRef`). Fail-closed guards, in order:

1. **PRODUCTION HARD-BLOCK** — `isStagingIngestEnvironment()` allows ingestion ONLY when the explicit
   `CONNECTOR_VAULT_STAGING_INGEST_ENABLED=1` opt-in is set AND the deployment is non-production
   (`VERCEL_ENV`/`NODE_ENV` ≠ `production`). Fail-closed default-off; read from the **trusted server env**, never
   request data (a caller cannot spoof it). B2's route must resolve the env from this same signal.
2. **provider/kind allowlist** — Slack dev-workspace bot OAuth access token ONLY (docs/44 §1; crypto kind
   `oauth_access_token` → DB `oauth_access`).
3. **required identity** — `tenant_id`, `connector_id` (uuid), `version` (positive int; explicit + monotonic).
4. **grammar-safe `correlation_id`** — the #166 grammar (`isSafeCorrelationId`), threaded into the store audit rows
   (never the secret row).

On success: encrypt-immediately + atomic store + `store.attempted`/`store.succeeded` audit + a redacted
`SavedSecretRef` (ids + KEK handle — no plaintext/ciphertext/wrapped DEK). On ANY guard/encrypt/audit failure:
NOTHING commits (no `connector_secrets` row, no succeeded audit; the existing atomic rollback, no compensating
DELETE) and a STATIC error is thrown. **Plaintext is never logged, echoed, serialized, traced, or returned.**

**Plaintext handling (docs/44 §2):** B1 has **no HTTP route**, so there is no request-body observer surface
(middleware / logger / tracer / body-parser) — that analysis lands with **B2's** callback route. The wrapper takes
the plaintext as a function argument and hands it straight to the encrypt call; the live reference is dropped after
encrypt, with the V8-heap residual documented in docs/44 §2 step 7 (NOT a hard wipe).

**Secret scanner** `scripts/check-no-real-tokens.sh` scans changed files (incl. untracked) for high-confidence
full-token shapes (Slack `xox*`/`xapp-`, JWT, `AKIA`/`ASIA`, PEM private key, `gho_`/`github_pat_`, `sk-`, DB URL
with an embedded password) and fails closed on a hit (matches redacted).

**Proof:** 14 synthetic tests — envelope-only store with no token anywhere (row/ref/audits/console), the production
hard-block refusing (no row, no audit, no DB touch), forbidden provider/kind + invalid ids/version/correlation_id
rejected, and fail-closed rollback on audit/encryption failure.

**Scope (unchanged):** NO real token, NO operator/admin-console paste, NO OAuth exchange, NO Slack API call, NO
callback route, NO live connector, NO request-path decrypt, NO route returning a token, NO production enablement, NO
rotation. **RISK-001 remains OPEN. RISK-007 remains OPEN. Cutover remains BLOCKED.** Connector credentials are not
production-ready. No doc 17 §5 box is ticked.

## 90. Slack OAuth authorize / callback / exchange — DESIGN GATE (PR #173, B2 design only)

**DESIGN ONLY. No OAuth implementation, no callback route wiring, no Slack API call, no real token, no live
connector, no request-path decrypt, no production enablement, no RISK-007 closure.** This section designs the
Slack OAuth authorize → callback → code-exchange path so the *first* real token can later be **born server-side**
(B2c) without ever being human-handled (preserving docs/44 §1/§2). It builds on the inert scaffolding already in
the repo: the HMAC-signed state (`oauth-state.ts`), the `oauth_pending` single-use replay store (migration `0020`),
the Slack provider module (`providers/slack-oauth.ts`, `SLACK_AUTHORIZE_URL = https://slack.com/oauth/v2/authorize`),
the inert callback route (`…/connectors/oauth/callback/route.ts`, returns `not_configured`/`received`, **never**
exchanges), and the B1 store path (`ingestStagingConnectorSecret` → `saveConnectorSecret`).

### 90.1 Code-vs-token boundary (the core invariant)

- The OAuth **callback receives an authorization `code`** on the request path. The `code` is **not** the bot token,
  but it is **sensitive + one-time exchangeable** (whoever exchanges it first wins).
- The `code` may exist on the request path **only long enough** to (a) parse the callback query, (b) validate the
  signed `state` + bind it (90.2), and (c) hand off to the **server-side** exchange. It is held as a local value in
  the server-only handler — never a field, never returned.
- The `code` must **never** be logged, stored, echoed, audited in raw form, included in an error, or returned to the
  browser. (Audit records only a safe `callback.received` event — 90.7 — never the `code`.)
- The **`code` → token exchange happens server-side ONLY** (runner identity → Slack `oauth.v2.access`, 90.4). The
  browser never sees the token; the token never travels back toward the request path / response body.
- The resulting Slack **bot token is encrypted + stored IMMEDIATELY** through the existing vault path
  (`saveConnectorSecret` / the B1 `ingestStagingConnectorSecret` guard) — born server-side, encrypted before any
  reference escapes the exchange call chain. **No code path exposes the token after exchange** (no route returns it;
  decrypt stays runner-only + blocked until PR C).

### 90.2 OAuth state / CSRF / tenant + actor binding

The signed state already exists (`OAuthStatePayload { v, tid, prov, cid, sub, intent, nonce, exp }`,
HMAC-signed via `CONNECTOR_OAUTH_STATE_SECRET`, constant-time verified). The replay/pending row exists
(`oauth_pending`: `tenant_id, organization_id, connector_id, provider, subject, state_jti, nonce_hash =
sha256(nonce), intent, expires_at`; single-use `UNIQUE(state_jti)` + `UNIQUE(nonce_hash)`; the raw nonce is NEVER
stored). Design of the binding:

| Concern | Design |
|---|---|
| **state format** | the existing `<b64url(payload)>.<b64url(HMAC)>`; payload v1 = `{tid, prov, cid, sub, intent, nonce, exp}`. Opaque + integrity-protected; carries **no secret** (the nonce is single-use CSRF, not a credential). |
| **state storage** | the `oauth_pending` row (safe metadata only; `nonce_hash`, never the raw nonce). The signed state is the bearer; the row is the single-use + actor record. |
| **state expiry** | `exp` in the payload **and** `expires_at` on the row (short TTL, docs/42 §16); the callback rejects `expired` and a swept/absent row. |
| **one-time use** | `UNIQUE(nonce_hash)` + the consume step (mark consumed) ⇒ a second callback with the same nonce is `replayed`. The nonce is consumed ONLY for an otherwise-valid state (a rejected state never burns a nonce). |
| **tenant binding** | `payload.tid` must equal the completing context's tenant (`tenant_mismatch`). |
| **provider binding** | `payload.prov` must equal the expected provider (`provider_mismatch`) — only the provider that initiated the authorize may complete it. |
| **connector binding** | `payload.cid` must equal the completing context's connector — **UNCONDITIONAL, null-normalized** (`connector_mismatch`): a fresh-connect (`cid=null` both) matches, but a re-auth state (`cid=A`) can never complete a fresh-connect context, nor connector A complete connector B. (Not gated on `!= null`, so the compare can't be skipped.) |
| **exact redirect URI binding** | the `redirect_uri` sent to Slack at authorize is bound and must match the callback **EXACTLY** — full-string equality, **NOT** prefix/substring/origin-only/loose. Designed as: bind the exact `redirect_uri` to the state (extend the payload or pin it per-app) and reject any mismatch (`redirect_uri_mismatch`). `buildSlackAuthorizeUrl` already requires an absolute-HTTPS redirect (no `http:`/`javascript:`/relative). |
| **actor / session binding (✅ DONE in B2a, #174)** | **B2a implemented this:** `validateOAuthState` now compares `payload.sub` against the completing session (`subject_mismatch`; `session_required` if no completing actor), binds the EXACT redirect URI (`redir` → `redirect_uri_mismatch`) + correlation id (`corr` → `correlation_mismatch`), and `generateBoundOAuthState` adds generation-time actor authorization. *(Original gap:)* the previous `validateOAuthState` bound `tid`/`prov`/`cid` but **did NOT compare `payload.sub` or `intent` to the completing session.** B2a MUST add **actor/session binding**: the completing session's authenticated subject must equal `payload.sub` **and** `oauth_pending.subject` (a new `subject_mismatch`/`session_mismatch` reason code), and `intent` must match. **How the callback obtains the subject (B2a must name it, not assume a layout):** an App Router **route handler does NOT run the `(authenticated)/layout.tsx` auth gate**, so the callback handler MUST itself resolve the authenticated user (e.g. `getSessionUser()` / `supabase.auth.getUser()` **inside** the handler) and compare to `payload.sub`/`oauth_pending.subject`. **Routing caveat:** the callback path is not in `proxy.ts` `PUBLIC_PREFIXES`, so an **unauthenticated** browser returning from Slack is 302'd to `/login` and the in-flight `code`/`state` are dropped — B2a must define how the session is guaranteed present at callback (e.g. require an active session + re-entry after login, or a controlled allowlist with auth enforced inside the handler), never weakening the subject check. Without all this, an attacker-initiated authorize could be completed by a victim session even though tenant/provider match. |
| **correlation_id binding** | a **prefixed grammar-safe** `correlation_id` (the #166 `SAFE_CORRELATION_RE`, e.g. `corr-…`/`run-…`) is generated at authorize **for the audit rows**, kept **separate** from `state_jti` (which is the random `oauth_pending` lookup key, sha256-hex shaped — NOT the correlation_id), and threaded into every audit row (§90.7) so authorize→callback→exchange→store correlate. |
| **failure behavior** | every check is fail-closed: any mismatch/expired/replayed/bad-signature ⇒ reject with a safe reason CODE (§90.7), **no** exchange, **no** state burned on a rejected state, **no** raw `code`/nonce surfaced. |

**OAuth state MUST bind — and the callback MUST compare against the completing request/session — ALL EIGHT of:**

1. **actor/session subject** (`sub`) — the authenticated user completing the callback;
2. **tenant_id** (`tid`);
3. **provider** (`prov`);
4. **connector_id** (`cid`) — for re-auth;
5. **the EXACT redirect URI** / redirect intent (full-string equality; **no** prefix/substring/origin/loose);
6. a **correlation / operation id** (the prefixed grammar-safe `correlation_id`) — the **audit-correlation** binding,
   carried so authorize→callback→exchange→store correlate; compared **when an expected value is supplied** ("if
   applicable" — `correlation_mismatch`). It is NOT the confused-deputy defense (the seven below are);
7. **expiry** (`exp` in the payload **and** `expires_at` on the row);
8. a **single-use marker** (`nonce_hash`, consumed exactly once).

**State binding (generation) MUST bind all eight; state validation MUST compare each SECURITY-bound field — the
actor subject, tenant, provider, connector, EXACT redirect URI, expiry, and single-use marker — against the
completing request/session and MUST FAIL CLOSED (a safe reason code — §90.7) on ANY mismatch** (the correlation id is
compared when an expected value is supplied). Well-formed + unexpired + unused is **NOT sufficient** — the per-field
equality check against the completing session/request is **mandatory** for the seven security bindings, and is a
**B2a implementation requirement** (not merely a risk note). This closes: callback replay, CSRF, tenant swap, connector swap,
**wrong-user callback completing setup**, **attacker-initiated authorize completed by a victim session**,
redirect-URI confusion, and stale/replayed state. **Redirect URI matching is EXACT** (no prefix/substring/origin/
loose).

> **B2a schema/code change (not this PR):** the new `subject_mismatch`/`session_mismatch` and `redirect_uri_mismatch`
> reason codes do not exist yet — B2a must extend the `OAuthStateReason` union + `validateOAuthState`, and (to
> persist a rejected-attempt code) the **migration** that widens the `oauth_pending.last_rejected_code` CHECK
> allowlist to include them. The exact redirect URI must also be carried (extend the signed payload or pin per-app)
> so the callback can compare it full-string.

### 90.3 Slack client secret is VAULT-GRADE (not ordinary config)

> **✅ B2c-secret status (#178):** the vault-grade store is implemented (synthetic) — the app-scoped
> `connector_app_secrets` table (migration 0035; NO tenant_id; RLS deny-all; runner column-scoped, T56), the
> `slack-client-secret-store.ts` envelope save + the load-bearing `withSlackClientSecret` scoped decrypt-and-use
> closure (NO `loadClientSecret(): string` API), and the app-scope AAD (a staging ciphertext cannot decrypt as
> production). NO real client secret entered the system; the app-secret USE audit remains future.
>
> **✅ B2c-run PREP (#181):** the reviewed, synthetic-tested ingestion path is now turnkey — `client-secret-ingest-
> harness.ts` (`readSecretFromStream(stdin)` → `ingestClientSecret` → `saveSlackClientSecret`; stdin-only, refuses
> argv/env secret, envelope-only, redacted, fail-closed, catch never surfaces the secret), `connector-oauth-config.ts`
> `connectorOAuthRedirectUri()` (the EXACT staging redirect from server config — placeholder removed), a guarded
> pre-flight (`scripts/b2c-ingest-client-secret.mjs`), and `connector_runner_login` documented + proven minimal-
> privilege (RLS T57). The hosted `RunnerConnection` (connector_runner_login) + real KMS provider remain B2c-run
> prerequisites (injected). See docs/45 §11. NO real run.

The Slack **client secret** is the **master capability** that converts authorization codes into tokens — its
compromise is *more* severe than a single bot-token compromise (it can mint tokens for every code). It must NOT be
the unprotected weak point behind a vault that carefully protects the tokens it mints. There is **no** client-secret
**store** today (no table, no storage code path); `client_secret` appears in the repo only as redaction-denylist
entries, leak-test fixtures, and comments. Design:

- **Storage (DEFAULT decision):** a dedicated **app-level KMS-encrypted store** — the same AES-256-GCM envelope +
  KEK-in-external-KMS scheme as the bot-token vault, AAD-bound + append-only/versioned, gated by the **same runner
  IAM `kms:Decrypt` boundary**. Because the client secret is **app-level** (one per Slack app, not per
  tenant/connector), it does NOT fit `connector_secrets` (per-tenant) → a small dedicated table (e.g.
  `connector_app_secrets`) keyed by app/provider. AWS **Secrets Manager** is a documented **alternative** that, if
  chosen in B2c, requires its OWN evidence that its access boundary is ≥ the runner `kms:Decrypt` boundary. The
  concrete schema is specified + provisioned in B2c (the migration/store), never in this design PR. (B2b only mocks
  the injected `ClientSecretProvider`; the vault-grade store itself is FUTURE — B2c.)
- **Read identity:** ONLY the **runner** exchange identity (the same `connector_runner` + KMS `kms:Decrypt` boundary
  that decrypts bot tokens). The web/request identity holds **no** access (no `kms:Decrypt`, deny-all).
- **Use identity:** the client secret is read + used to call Slack **only** inside the server-side exchange (90.4),
  never on the request path.
- **NEVER a plaintext env var.** `CONNECTOR_OAUTH_STATE_SECRET` (the HMAC state key) is a *different*, lower-grade
  secret; the **client secret** must be vault-grade. (B2c evidence must prove it is not sitting in a plaintext env.)
- **Rotation:** rotate at the Slack app (provider-side: regenerate the client secret in the Slack app config) +
  re-encrypt/replace in the store; a versioned app-secret with the same monotonic/append-only discipline as the
  bot-token vault. **Provider-side revocation/rotation:** a Slack app admin regenerates the client secret in the
  Slack app settings (immediately invalidates the old one) — the named operator is recorded.
- **Audit:** every read/use of the client secret emits a safe audit event (90.7) — never the value.
- **Blast radius if it leaks:** an attacker can exchange any intercepted `code` and mint bot tokens for the app's
  scopes across any workspace that installed the app → **app-wide**, far worse than one bot token. Hence vault-grade.
- **Why ≥ bot-token strength:** same KEK/KMS + IAM `kms:Decrypt` runner-only boundary, same encrypt-only/decrypt-
  runner-only asymmetry, same allowlist audit — so the secret that *mints* tokens is protected at least as strongly
  as the tokens it mints.

> **Gate:** before the first real OAuth exchange (B2c), evidence MUST prove the Slack client secret is protected with
> vault-grade controls and is **not** in a plaintext env var (docs/44 §5).

### 90.4 Slack exchange path

> **✅ B2b status (#175):** the MOCKED exchange wrapper is implemented — `slack-oauth-exchange.ts`
> `exchangeSlackOAuthCode(input, deps)` builds this shape against an INJECTED http client + an INJECTED client-secret
> provider + the B1 store handoff (no global fetch, no real Slack call, no real token). The vault-grade/KMS-backed
> client-secret store (§90.3) and exchange-specific audit (§90.6) remain FUTURE (B2c). The token endpoint is still
> NEVER reached by a real network call.

- **Endpoint:** Slack `https://slack.com/api/oauth.v2.access` (the token endpoint — currently NEVER built). Bot-token
  install flow (OAuth v2).
- **Request shape (high level):** `POST` `application/x-www-form-urlencoded` with `client_id`, `client_secret`,
  `code`, and the **exact** `redirect_uri`. Over TLS only.
- **`client_id`:** non-secret app config (may be env/config).
- **`client_secret`:** read from the **vault-grade** store (90.3) at exchange time — never env plaintext.
- **Calling identity:** the **runner** server-side runtime (the only identity with client-secret access + the
  `kms:Decrypt` boundary). Never the web/request identity, never the browser.
- **Timeout/retry:** a short timeout; **no blind retry of the code** (a `code` is single-use — a retry after a
  partial success risks double-spend/duplicate token). Retry only on a clean pre-send/network failure where Slack
  provably did not consume the code; otherwise fail closed.
- **No token logging; no raw Slack-response logging.** The Slack JSON response (which contains `access_token`) is
  parsed in memory; only the bot token field is extracted → encrypted; the raw response is never logged/persisted.
- **Slack error sanitization:** map Slack's `error` codes to safe static reason classes (§90.7); never echo the raw
  Slack body or an error containing token/code material.
- **Partial failures fail closed:** if the token is received but encryption/store/audit fails, the operation fails
  closed (no half-stored secret; the just-minted token is dropped/unusable; consider provider-side revoke in cleanup,
  docs/44 §6). 
- **Bot token ONLY** is accepted for the first credential (docs/44 §1). An unexpected token type / missing bot token
  ⇒ fail closed (§90.7).
- **Refresh / rotation OUT of scope** unless explicitly decided (docs/44 §1: token rotation not enabled for the first
  credential → no refresh token to handle).

### 90.5 Receipt-to-encryption: zero observers (implementation plan)

When B2a/B2c implement the callback + exchange, EVERY surface that could observe the callback query / `code` / Slack
exchange request / Slack response / token / client secret must be proven not to record raw material:

| Surface | Prevention |
|---|---|
| **proxy / platform access logs** (Vercel) | the `code` arrives as a **query param** in the callback URL → access logs / Referer can capture full URLs. Mitigation: treat the callback URL as sensitive; **redirect to strip the query** immediately (303 to a clean path) so the `code` does not persist in history/Referer; rely on POST-style handoff where possible; confirm the platform does not log full query strings (or that the surface is enumerated in docs/44 §5 (the OAuth-evidence sub-block) as a residual). |
| **Next.js middleware / route handler** | the callback handler is server-only; it reads `searchParams.get("code")` into a local, validates state, hands to the exchange. No middleware logs the body; `proxy.ts` (session refresh) must not log the callback URL. |
| **logger** | the vault code never calls `console.*`; the exchange + store paths emit ONLY allowlist audit (90.7). No request-body logger on this route. |
| **tracer / analytics** | the only telemetry is client-side Vercel Analytics/Speed Insights (off the server-side path); **no** server tracer/error-monitoring vendor exists (docs/44 §5/§15). Adding one later requires re-checking this row. |
| **request parser / validator** | the state validator returns reason CODES only (never the nonce/code); the `code` is passed by value to the exchange, never serialized. |
| **error handler** | errors are static, redacted (`ConnectorSecret*Error` / sanitized Slack reason); never the raw Slack body, `code`, token, or client secret. |
| **framework helpers** | no `JSON.stringify` of the request/response onto a log; the redacted `SavedSecretRef` is the only thing returned upstream. |

### 90.6 Audit design

Events (allowlist builder, the #166 grammar (`secret-audit.ts`) — safe static fields + a grammar-safe `correlation_id`):
`connector_oauth.authorize.initiated`, `connector_oauth.callback.received`, `connector_oauth.exchange.attempted`,
`connector_oauth.exchange.succeeded`, `connector_oauth.exchange.failed`, plus the existing
`connector_secret.store.attempted/succeeded/failed` for the bot-token store, and a client-secret-use event
(90.3). Audit MUST **never** include: the raw authorization `code`, the raw Slack response, the token, a refresh
token, the client secret, ciphertext/key material, or a raw error body. **Safe/static reason classes only** (§90.7).
(The exact event constants + builder extension are implemented in B2a/B2b, not this PR.)

### 90.7 Failure modes (all fail-closed — no token/code/secret leaked, no half-state)

invalid state, expired state, replayed state, **session/actor mismatch**, tenant mismatch, connector mismatch,
**redirect URI mismatch**, Slack exchange failure, Slack returns no bot token, Slack returns an unexpected token
type, client secret unavailable, client secret access denied, vault encryption failure, vault store failure, audit
failure, and lifecycle/revoke failure during cleanup → each yields a safe reason CODE (§90.7), **no**
`connector_secrets` row without its audit, **no** token toward the browser, **no** raw material in logs/errors. On a
post-mint failure, cleanup includes provider-side revoke + vault tombstone (docs/44 §6).

### 90.8 Implementation sequence after this design

- **B2 (this PR #173)** — design gate (docs only).
- **B2a** — state generation + validation ONLY, with **actor/session + exact-redirect binding added**, synthetic
  callback tests, **no** Slack exchange.
- **B2b** — Slack exchange wrapper against **mocked** Slack responses (injected http client + injected client-secret
  provider + B1 store handoff); **no** real Slack call, **no** real token. _(✅ done, #175.)_ The vault-grade
  client-secret store itself + exchange-specific audit are **FUTURE — B2c** (not wired in B2b).
- **B2c — SPLIT into FOUR separate PRs/steps (never combined):**
  - **B2c-wire** _(✅ done, #176)_ — synthetic end-to-end callback composition (pure function): `oauth-callback-
    orchestrator.ts` composes B2a validate (gate) → B2b mocked exchange → B1 store, threading the validated payload as
    the single source of truth (`b1StoreHandoff` wires the real B1 ingestion). Mocked Slack, synthetic token, mocked
    client secret — no real call/token/secret, no route.
  - **B2c-secret** _(✅ done, #178)_ — the vault-grade/KMS-backed Slack **client-secret store** (§90.3): app-scoped
    `connector_app_secrets` (NO tenant_id; RLS deny-all; runner column-scoped, T56) + `slack-client-secret-store.ts`'s
    load-bearing `withSlackClientSecret` scoped decrypt-and-use closure (no `loadClientSecret` API) + app-scope AAD
    (staging≠production). Synthetic — no real client secret/token. *(The real injected http client + the app-secret
    use audit (§90.6/§90.7) remain future.)*
  - **B2c-route** _(✅ done, #179)_ — the **production OAuth callback route** wrapping the B2c-wire orchestrator, still
    **synthetic** (no real Slack egress), with the App-Router request-path discipline **proven** (server-only,
    staging/test-guarded, explicit actor/session resolution — no layout-auth reliance; no query-string/`state`/`code`
    logging; no raw `state`/`code` in error responses; safe/static failures). No real token.
  - **B2c-run** _(future — runbook ready, #180)_ — the staging real OAuth exchange harness, **explicitly authorized by
    Sam** — the **first real-token event** (token born server-side, immediately encrypted; docs/44 §5). An operational
    go/no-go, **not a normal code PR.** The operator checklist is
    [45_B2C_RUN_FIRST_REAL_TOKEN_RUNBOOK](./45_B2C_RUN_FIRST_REAL_TOKEN_RUNBOOK.md); #180 created the runbook only — no
    real run happened.
- **B2d** — live connector use behind a staging flag (later). Production readiness later. **Only then** consider
  RISK-007 closure.

**RISK-001 remains OPEN. RISK-007 remains OPEN. Cutover remains BLOCKED.** Connector credentials are not
production-ready. No doc 17 §5 box is ticked by this PR.
