# 19 · Connector Credential Vault & Secret-Handling Design

**Canonical source for: the SAFE future path for collecting, storing, using, rotating, and deleting
connector credentials (Okta / Google / Microsoft Entra / Slack / SCIM / SaaS scrapers / inbound API
tokens) in ID Caddie v3.** This is **design only** — nothing here is built. Its purpose is to make
**RISK-007** (no credential vault) addressable by a future, tested, reviewed implementation, and to ensure
**no real secret is ever collected or stored until that vault exists.**

> **Status (do not overclaim):** **DESIGNED, NOT BUILT.** There is no vault, no connector table, no
> encryption code, no OAuth flow, no sync worker, no connector UI, and no migration in the repo. This doc
> **does not close RISK-007** and **does not make v3 connector-ready or cutover-ready.** Legacy stored 50+
> connector secrets in **plaintext** ([current-security-risk-map.md](./current-security-risk-map.md)); v3
> will **not** port that. Implementation is gated on this design being reviewed + the §8 tests being green.

> **Relationship to the gate (see §11):** [18_OMC_CONFIRMATION_PASS](./18_OMC_CONFIRMATION_PASS.md) may
> confirm connector **existence/status only — never tokens.** Credential collection waits until this vault
> is implemented + reviewed. [17_OMC_PRODUCTION_REPLACEMENT_PARITY_GATE](./17_OMC_PRODUCTION_REPLACEMENT_PARITY_GATE.md)
> remains the binding cutover gate; connector workflows OMC uses must be implemented, tested, hosted-applied,
> and verified before cutover. **Cutover stays BLOCKED.**

This design inherits the v3 invariants ([02_SECURITY_AND_RLS](./02_SECURITY_AND_RLS.md),
[01_ARCHITECTURE](./01_ARCHITECTURE.md)): **RLS is the authorization boundary** (never app-layer filtering);
**no service-role key on any request/browser path**; **composite same-tenant FKs** (`0005` pattern) so
cross-tenant references fail at the DB; **append-only audit** (`0010` pattern); **no hard delete of evidence**
(`0004` posture).

---

## 1. Threat model

The asset is **connector secrets** (OAuth tokens, API keys, service-account JSON, SCIM bearer tokens,
inbound-API tokens) and the data synced through them. Threats and the mitigation this design must enforce:

| # | Threat | Mitigation (required by this design) |
|---|---|---|
| T1 | **Tenant→tenant secret read** — Tenant B reads Tenant A's credentials/metadata. | Every connector table is `tenant_id`-scoped + RLS `is_tenant_member`/role-gated; composite same-tenant FKs (`0005`). **Secret material is not stored in any RLS-readable column at all** (§3) — it lives in the vault keyed by a handle, so even a full row read leaks nothing. |
| T2 | **Legitimate tenant admin reaching another tenant's connector.** | Authority is `tenant_id`-bound (`has_tenant_role(tenant_id, …)`); a tenant admin has zero authority outside their tenant. Cross-tenant references blocked at the FK layer, not just hidden by RLS. |
| T3 | **App bug leaks a token to the browser/client.** | Raw secrets **never enter the app request path**: the user-scoped server client (RLS-bound) cannot read secret material (it isn't in a readable column); decryption happens only in an isolated trusted job (§4). The DAL/API returns **redacted metadata only** (§3). No client component ever holds a secret. |
| T4 | **Logs accidentally record tokens.** | Central redaction requirement (§9): no token in errors, no `Authorization` headers logged, no raw provider responses that may contain secrets; only safe diagnostic fields. |
| T5 | **Background worker overreach** — a sync worker touches the wrong tenant/connector or escalates. | Workers **re-derive** the tenant + connector + acting authorization from their job row server-side (never trust a passed-in `tenant_id` as authority); per-tenant scoping; no cross-tenant fan-out in a single privileged context (§7, T-W tests in §8). |
| T6 | **Stale / revoked tokens** — a token revoked at the provider is still used or shown as live. | Status lifecycle (`active`/`expired`/`revoked`/`error`) + `last_used_at`/`last_verified_at`; sync verifies/refreshes and downgrades status on auth failure; revoked credentials are never used for sync. |
| T7 | **Rotation / deletion mishandled** — rotation overwrites history; deletion destroys the audit trail. | Rotation creates a **new version row** (history preserved), does not blind-mutate; delete/revoke is **audited** and **soft-disable before any hard destruction** (§3). |
| T8 | **Service-role misuse** — a service-role key on a request path bypasses all RLS. | **No service-role key on any request/browser path** (repo invariant). Secret access is confined to an isolated trusted job with its own vault-key access, unreachable from the browser, never the request DAL (§4). A service-role *app route* is forbidden (it would bypass tenant RLS everywhere — [02 §4a](./02_SECURITY_AND_RLS.md)). |
| T9 | **Hosted/staging/prod bleed** — staging secrets used in prod, or one key for all envs. | Per-environment vaults + per-environment keys; staging connectors use staging provider apps + staging secrets; **never** copy prod secrets to staging; keys are environment-scoped and never in the repo or generated types. |

---

## 2. Data model direction (design only — DO NOT implement)

Six future tables. All are **`tenant_id`-scoped**, RLS-enabled, and use the **composite same-tenant FK**
pattern (`(child_ref, tenant_id) → parent(id, tenant_id)`, `0005`). **None stores raw secret material in a
readable column** — secrets live in the vault (§3/§4), referenced by an opaque handle. Columns are
indicative, not final.

### `connector_integrations` — one row per configured connector instance
- `id uuid pk`, `tenant_id uuid` (FK → tenants), `provider text` (`okta`/`google`/`entra`/`slack`/`scim`/`scraper`/`inbound_api`), `display_name text`, `status text` (`draft`/`active`/`disabled`/`error`), `config_json jsonb` (**non-secret** config only — base URL, scopes requested, schedule), `created_by uuid` (→ profiles), `created_at`, `updated_at`, `disabled_at`.
- **Tenant binding / FK:** `(tenant_id)` + composite same-tenant FKs to any referenced app. **RLS:** members read; **connector-admin** role creates/updates (§5). **Never readable:** nothing here is a secret — but `config_json` must be schema-validated to reject any secret-shaped field.
- **Audit:** create/enable/disable audited (append-only, `0010` pattern).

### `connector_credentials` — the credential record (metadata + vault handle, NEVER the secret)
- `id uuid pk`, `tenant_id uuid`, `integration_id uuid` (composite same-tenant FK → connector_integrations), `kind text` (`oauth`/`api_key`/`service_account`/`scim_bearer`), `status text` (`active`/`expired`/`revoked`/`error`), **`vault_ref text`** (opaque handle into the secret store — **NOT the secret**), `fingerprint text` (non-reversible hash for display/compare), `last_four text` (display only), `scopes text[]`, `expires_at`, `created_by`, `created_at`, `last_used_at`, `last_verified_at`, `revoked_at`, `revoked_by`.
- **Tenant binding / FK:** `(integration_id, tenant_id)` composite FK. **RLS:** members read **the redacted columns**; connector-admin rotates/revokes. **NEVER readable by normal authenticated users — and never stored here at all:** the raw token, refresh token, client secret, private key. Only `vault_ref`/`fingerprint`/`last_four` exist on the row, and `vault_ref` is **not usable** without separate vault-key access (§4).
- **Audit:** create/rotate/revoke audited.

### `connector_credential_versions` — rotation history (append-only)
- `id uuid pk`, `tenant_id`, `credential_id uuid` (composite same-tenant FK), `version int`, `vault_ref text` (handle for that version), `fingerprint text`, `created_by`, `created_at`, `retired_at`, `retire_reason text`.
- **RLS:** members read redacted history; **no UPDATE / no DELETE** (append-only — rotation inserts a new version, never mutates an old one). **Never readable:** the secret (only the handle/fingerprint).

### `connector_sync_runs` — one row per sync attempt
- `id uuid pk`, `tenant_id`, `integration_id` (composite same-tenant FK), `mode text` (`dry_run`/`apply`), `status text` (`queued`/`running`/`succeeded`/`failed`/`partial`), `triggered_by uuid`, `started_at`, `finished_at`, `counts_json jsonb` (added/updated/unchanged/would-tombstone — **non-secret aggregates only**), `error_summary text` (**redacted**, §9).
- **RLS:** members read; connector-admin triggers. **Audit:** start/finish audited.

### `connector_sync_events` — per-record sync detail (normalized, non-secret)
- `id uuid pk`, `tenant_id`, `run_id` (composite same-tenant FK), `entity_type text` (`app_user`/`person`/`app`…), `external_id text`, `action text` (`insert`/`update`/`noop`/`tombstone_candidate`), `diff_json jsonb` (**normalized, non-secret** field changes), `applied bool`.
- **RLS:** members read. **Never store:** raw provider payloads that may carry secrets — only normalized, scrubbed fields (§7 separation of raw vs normalized).

### `connector_sync_dry_runs` — preview output before any write
- `id uuid pk`, `tenant_id`, `run_id` (FK, `mode='dry_run'`), `preview_json jsonb` (the diff a human reviews before approving an `apply`), `expires_at`.
- **RLS:** members read; connector-admin approves the corresponding `apply`. Dry-runs **write nothing** to product tables.

**Cross-cutting:** every table has `tenant_id`; **no `FOR ALL` and no `DELETE` policy** on credential/version
tables (delete is via an audited soft-disable + a later, separately-justified hard-purge job, never a user
`DELETE`); the secret itself is **out of band** in the vault, so the generated types never carry readable
secret data (§3).

---

## 3. Secret storage model (the approved future path)

1. **Secrets are encrypted-at-rest in a managed secret system, or encrypted before persistence — never
   plain text/jsonb in an app table.** Plain Postgres `text`/`jsonb` is unacceptable (§4) because any DB
   read, backup, log, replica, or generated-type leak would expose raw tokens (the legacy P0).
2. **The DB row stores only an opaque `vault_ref` + redacted metadata** (provider, status, `fingerprint`,
   `last_four`, `scopes`, `created_at`, `last_used_at`, `expires_at`). The raw secret is **not a column**.
3. **Secrets are never returned to the client.** The DAL/API/server actions return redacted metadata only.
   No server action, route handler, or React Server Component ever serializes a secret to the client.
4. **Secrets are never included in generated types as readable app data.** `vault_ref` is a handle, not a
   value; if a future column could carry secret data it must be excluded from the user-scoped read surface
   (separate privilege, separate schema, or vault-only) so `database.types.ts` never exposes a readable token.
5. **Secrets are never logged** (§9).
6. **Display is redacted only:** provider/kind, status, `last_four`/`fingerprint`, `created_at`,
   `last_used_at`, `expires_at`. Never the token, refresh token, client secret, or private key.
7. **Rotation creates a new version** (`connector_credential_versions`) and flips the active pointer; it does
   **not** blind-mutate or destroy prior history.
8. **Delete/revoke is audited and soft-first:** revoke → mark `revoked` + stop using it (audited); a hard
   purge of vault material is a later, separately-reviewed, audited step — never an un-audited user `DELETE`.

---

## 4. Key management

**Why plain Postgres text/jsonb is unacceptable for raw tokens:** the app DB role (even RLS-bound) can read
columns it has policy access to; backups/replicas/exports/log statements/generated types can surface column
values; a single SQL-injection or over-broad policy would dump every tenant's tokens. Secrets must be
protected by a key the **app database role does not hold**.

**Options (preferred path first):**
1. **Supabase Vault / managed secrets (preferred for the Supabase-native path):** secrets stored encrypted
   with the key managed by the platform outside the app table; the app stores a `vault_ref` and only an
   **isolated trusted job** with explicit secret access can decrypt. Keeps secrets out of normal RLS-readable
   columns and out of generated types.
2. **KMS-backed envelope encryption** (cloud KMS data key; ciphertext in a restricted table the request role
   cannot read): equivalent guarantee if Vault is unavailable; the KMS key is never in the DB or repo.
3. **External secret manager** (e.g. a dedicated secrets service) referenced by handle: strongest separation,
   most operational overhead.

**Key separation:** the encryption/decryption key (or KMS/Vault access) is held **outside the app database
access path** — not in `database.types.ts`, not in a client bundle, not in the user-scoped server client, not
in the repo. **Only the isolated trusted job** (out-of-request worker / Edge Function with its own scoped
secret access) can resolve a `vault_ref` to plaintext, and only to call the provider — never to return it.

**What the app can/cannot do with elevated privilege:**
- **Cannot:** use a service-role key on any request/browser path; read raw secrets from the request DAL;
  decrypt secrets in a React Server Component or route handler that serves the browser.
- **Can (future, isolated):** an out-of-request trusted job re-derives tenant+connector authorization, fetches
  the `vault_ref`, decrypts **only in memory inside that job**, calls the provider, and writes back redacted
  status/results. This job is never reachable from the browser and never returns secret material.

---

## 5. Authorization model

Mirrors the contract write model (`0004`): authority is **`tenant_id`-bound** and **role-gated**, enforced by
RLS, not the app. A new **`connector_admin`** capability (a tenant role grant, e.g. owner/admin or an explicit
connector-admin) governs credential mutation. **Related-org read does NOT imply credential authority. The
paying org NEVER gains connector-credential write authority merely because it pays for a contract.**

| Action | Who | Boundary |
|---|---|---|
| View connector existence/status (redacted) | tenant member (`is_tenant_member`) | RLS SELECT on metadata; **no secret columns exist** |
| Create a connector integration | tenant connector-admin (`has_tenant_role(tenant_id, ['owner','admin'])` or explicit grant) | RLS INSERT WITH CHECK; `created_by = auth.uid()` |
| Start OAuth / install flow | tenant connector-admin | server-only; tenant + actor re-derived server-side (§6) |
| Rotate credentials | tenant connector-admin | inserts a new version; audited; old version retired |
| Disable / revoke credentials | tenant connector-admin | soft-disable + audit; secret stops being used |
| Trigger dry-run sync | tenant connector-admin (or a sync-operator role) | writes nothing to product tables |
| Approve sync / import (apply) | tenant connector-admin / approver | explicit human approval of the dry-run diff (§7) |
| View sync results | tenant member | tenant-scoped RLS |
| Export connector-derived data | per existing export authority (tenant-scoped) | export never includes secret material |

**Hard rules:** a related-org/payor reader can **see contract/app links** but has **no** create/rotate/revoke
authority on credentials; `paying_org_id` is **never** referenced in any credential write policy (read ≠ write,
mirroring [13 §3](./13_CONTRACT_STEWARD_WRITE_DESIGN.md)); no `FOR ALL`, no user `DELETE` on credential tables.

---

## 6. OAuth / token onboarding flow (design)

For OAuth providers (Okta/Google/Entra/Slack) the future onboarding flow must be:
- **Server-only callback.** The OAuth redirect lands on a server route handler; the browser never receives
  the authorization code exchange result or any token.
- **State + nonce + PKCE** where the provider supports it; `state` is a server-generated, single-use,
  tenant+actor-bound value (verified on callback) to defeat CSRF/mix-up.
- **Tenant + acting user re-derived server-side** on callback from the session + the `state` record — never
  trusted from a query param or client value.
- **No token in URL fragments, query strings, logs, or client state.** The token goes straight from the
  server-side code exchange into the vault (`vault_ref` stored); only redacted metadata is persisted on the row.
- **Redacted success/failure messages** to the user ("Okta connected" / "Connection failed — check provider
  settings") — never the error body if it can contain a token.
- **Audit events** for: `connector.oauth_start`, `connector.oauth_callback`, `connector.connect_succeeded`,
  `connector.connect_failed`, `connector.revoke`, `connector.rotate` — append-only, actor = `auth.uid()`,
  **no secret in the audit payload**.

API-key / service-account / SCIM-bearer connectors (no OAuth dance): in the **future implementation** (none
exists today — §12), the secret would be entered **once on a server-only path** and written straight to the
vault; it is never echoed back, never stored in a readable column, and the entry form never re-displays it.
**No such entry path exists in this PR, and no real secret is collected (see header + §12).**

---

## 7. Connector sync model (non-destructive)

- **Dry-run first.** Every connector run defaults to `mode='dry_run'`, producing a `connector_sync_dry_runs`
  preview and **writing nothing** to product tables.
- **Preview diff before writes.** A human reviews the dry-run diff (added/updated/unchanged/would-tombstone)
  and explicitly approves an `apply` (§5).
- **Idempotent import.** `apply` is an **upsert** keyed by `(tenant_id, provider, external_id)`; re-running
  produces no spurious changes.
- **No destructive deletes from remote absence alone.** A record missing from a fetch is **never** hard-deleted.
  Legacy's blind full-replace (hard-delete anything not in the latest run) is **not ported** — it loses data on
  a transient API failure or partial page.
- **Tombstone / stale marking requires review.** Absence marks a record `tombstone_candidate`; an admin reviews
  before any soft-disable. Distinguish "authoritatively empty" from "fetch failed" before acting.
- **Separate raw ingestion → normalized mapping → approved application.** Raw provider payloads (which may
  contain secret-ish fields) are scrubbed/normalized before storage; only normalized, non-secret fields land in
  `connector_sync_events`; application to product tables is a distinct, approved step.
- **Audit everything** — runs, approvals, applied changes (append-only).
- **Rate-limit / backoff / error handling** per provider; failures downgrade credential status (T6) and never
  leak the provider error body (§9).
- **No cross-tenant worker fan-out mistakes.** A worker processes exactly one tenant's connector per job and
  re-derives authorization from the job row; it never holds multiple tenants' decrypted secrets at once.

---

## 8. RLS / testing plan (future — must be green before any connector ships)

These tests must exist (mirroring the `org_rls_test.sql` discipline) before credentials are collected:
- **Tenant isolation (metadata):** Tenant A cannot see Tenant B connector integrations/credentials/runs.
- **No secret material readable:** there is **no column** returning a raw token to any authenticated user;
  a `select *` on credential tables returns only `vault_ref`/`fingerprint`/`last_four`/status — assert the
  secret columns do not exist in the readable surface.
- **Write authority:** a non-admin cannot create/rotate/revoke a connector credential (RLS WITH CHECK denies).
- **Related-org / payor cannot mutate:** a payor/related-org reader of a contract/app gets **no** credential
  write authority (assert denial); `paying_org_id` never appears in a credential write policy.
- **Worker re-derivation:** worker/SECURITY DEFINER functions re-derive tenant + connector authorization from
  the job row; a forged `tenant_id` does not grant cross-tenant access.
- **Sync results tenant-scoped:** Tenant A cannot read Tenant B's `connector_sync_runs`/`_events`/`_dry_runs`.
- **Audit append-only:** connector audit rows cannot be updated/deleted (`0010` pattern).
- **No `DELETE` / `FOR ALL`** on credential/version tables unless explicitly justified + tested.
- **No secret exposure through views/DAL/API:** assert no view, DAL helper, or API response serializes a secret
  field (the column doesn't exist on the read surface; the vault handle is non-resolvable without the isolated job).

---

## 9. Logging / redaction rules

- **No token in errors** — never include a token/refresh-token/client-secret/private-key in an error message,
  exception, or stack.
- **No `Authorization` headers in logs** — strip auth/cookie headers before logging any request/response.
- **No raw provider responses** if they may contain secrets — log normalized, scrubbed summaries only.
- **A central redaction helper is required** for the future implementation (one funnel that all connector
  logging/errors pass through; deny-by-default — log only an allowlist of safe diagnostic fields).
- **Safe diagnostic fields only:** provider, integration id, tenant id, run id, status, counts, HTTP status
  code, retry/backoff state, redacted error category. Never the secret, never the raw payload.

---

## 10. Connector-specific notes (future considerations)

- **Okta:** OAuth or API token + directory read; service-account-style secret → vault; strong evidence OMC uses
  Okta as source-of-truth, so sync must never blind-delete on a transient Okta failure (T6/§7).
- **Google Workspace:** service-account JSON **including a private key** — must be vaulted, never plaintext,
  never in generated types; domain-wide-delegation scope is sensitive (least-privilege, audited).
- **Microsoft Entra:** OAuth app + client secret/cert; same vault path; tenant-bound app registration is an
  operational (non-repo) step.
- **Slack:** OAuth bot/user tokens; scopes recorded redacted; revoke on disconnect.
- **SCIM:** an inbound bearer token v3 issues/accepts — **hash/vault it** (legacy validated by plaintext string
  equality, which is unacceptable); rotate-able; SCIM provisions login accounts, so soft-disable (never hard
  delete) on deprovision.
- **SaaS app scrapers:** per-provider secrets vaulted; the long-tail set is OMC-confirmation-gated (doc 18) —
  build only what OMC actually uses.
- **CSV / file imports (no API token):** no credential to vault, **but the file may be sensitive** — it flows
  through the (future) private Storage + validation path ([16](./16_CONTRACT_PDF_AI_EXTRACTION_DESIGN.md)),
  redacted in logs, and the same non-destructive upsert rules (§7) apply.

---

## 11. Relationship to docs 17 / 18

- **[18_OMC_CONFIRMATION_PASS](./18_OMC_CONFIRMATION_PASS.md) confirms connector EXISTENCE/STATUS only —
  never tokens/keys/credentials.** Confirming "OMC uses Okta + Google" is fine; collecting an Okta token is not,
  and is explicitly out of scope of the confirmation pass (doc 18 §4/§10).
- **Credential collection waits** until this vault design is **implemented and reviewed** (the §8 tests green,
  hosted-applied, verified). No real secret is collected before then.
- **[17_OMC_PRODUCTION_REPLACEMENT_PARITY_GATE](./17_OMC_PRODUCTION_REPLACEMENT_PARITY_GATE.md) cutover remains
  BLOCKED** until the connector workflows OMC actually uses are implemented, tested, hosted-applied, and verified
  — the vault is a **prerequisite** for any connector implementation (doc 17 §3/§4.6/§7 Track B).
- **This PR does not make v3 connector-ready or cutover-ready**, and **does not close RISK-007.**

---

## 12. Explicit non-goals (this PR)

- **No real secrets / tokens / keys** collected, requested, pasted, or stored.
- **No connector implementation** (no Okta/Google/Entra/Slack/SCIM/scraper code).
- **No hosted environment setup**; **no Supabase project mutation** (no `db push`, no hosted apply).
- **No Vercel env changes**; **no OAuth app registration.**
- **No sync/import code**; **no encryption code**; **no UI.**
- **No RLS migration** (no new tables/policies in this PR — design only).
- **No RISK-007 closure** (no implemented/tested vault exists) and **no readiness claim.**
