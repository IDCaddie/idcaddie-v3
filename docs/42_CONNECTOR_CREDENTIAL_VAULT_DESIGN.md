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
- `oauth_pending` — short-TTL CSRF/state store: `state, nonce?, pkce_verifier?, tenant_id, organization_id?, provider, initiated_by, expires_at, consumed_at?`. Server-only; single-use. `pkce_verifier`/`nonce` are acceptable as plaintext-at-rest **only** because `oauth_pending` is Tier-2 (RLS deny-all + zero `authenticated` grant), single-use, and short-TTL — there is no request-path read; both are also on the §11 redaction deny-list.

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

- **KMS choice:** Supabase Vault (pgsodium) vs external cloud KMS for the KEK — affects §6 and the runner identity.
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

**Tests** (+15 app tests, 136 → 151; RLS suite **318 → 327** via **T41**): lifecycle state + transition validation;
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
