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
