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
