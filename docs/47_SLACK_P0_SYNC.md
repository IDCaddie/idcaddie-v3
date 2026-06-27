# 47 · Slack P0 sync — spec + build log

Slack P0 proves v3's provider **sync chain** end-to-end using a **server-only dev/test token**, because v3 does not yet
have the provider sync layer the old Firebase app's scrapers provided. **This is a temporary build scaffold — it does
NOT change credential-vault / RISK-007 posture.** Customer-facing v3 credentials still require **OAuth / vault / runner**
(docs 44/46). The old app's pasted-token credential model is **not** backported into v3.

## P0 decisions (confirmed)
- **Provider:** Slack first.
- **Token source for P0:** a **server-only dev/test injected token** (build scaffold only).
- **Customer credential model:** OAuth / vault / runner — **later**, unchanged by P0.
- **Bots:** filtered out for P0.
- **Enterprise Grid:** a single workspace for P0.
- **Resolver write path:** a **separate deep-gate PR** (not part of these PRs).

## PR 1 — server-only dev-token source abstraction
`src/lib/server/sync/provider-token-source.ts` (server-only; no client/route/action/public-API path).
- **Seam:** `ProviderTokenSource.getProviderToken({ provider, tenantId, connectorId, purpose }) → Promise<ProviderToken>`
  — provider/tenant/connector/purpose-aware. The FUTURE vault/OAuth/runner source implements the **same** interface
  (`VaultProviderTokenSource` type placeholder), so P0's dev source swaps out cleanly. **Not implemented in PR 1.**
- **Dev/test implementation:** `createDevProviderTokenSource(env)` — Slack only; reads the token from a **server-only**
  env var `ID_CADDIE_DEV_SLACK_TOKEN` (never `NEXT_PUBLIC_*`, never in code, never persisted to DB, no credential
  document, no credential UI). Returns only the in-memory `{ provider, token }` object; never logs/throws/audits the
  token.
- **Allowlist-shaped fail-closed guard** (`isDevProviderTokenSourceEnabled`): enabled **only** when the runtime is
  **positively local development** (`NODE_ENV === "development"` AND `VERCEL_ENV` ∈ {unset, `development`}) **AND** the
  explicit opt-in `ID_CADDIE_DEV_PROVIDER_TOKEN_SOURCE_ENABLED === "1"`. It is **allow-only-known-local-dev**, NOT
  deny-known-staging/prod: **unknown env, unset env, `test`, staging, Vercel preview, Vercel production all REFUSE**.
- **Request input cannot enable it:** the guard reads **trusted server config (the env map) only** — never a request
  header / query / cookie / body / url. A request carrying `ID_CADDIE_DEV_PROVIDER_TOKEN_SOURCE_ENABLED=1` does **not**
  enable the source (named test).
- **Tests** (`provider-token-source.test.ts`, synthetic `xoxb-…MUSTNOTLEAK…` sentinel only): the full allowlist matrix
  (dev+opt-in enables; staging/prod/preview/unknown/unset/test/missing-opt-in/non-`1`-opt-in all refuse), missing token
  fails closed, unsupported provider fails closed, request-supplied opt-in cannot enable it, the token never appears in
  errors or console, and the server-only boundary (no `"use client"` / no `src/app` import + the runtime sentinel).

## PR 2 — server-only Slack API client (verified in isolation)
`src/lib/server/sync/slack/slack-client.ts` (server-only). Proves **dev-token source → Slack API → normalized records**;
it does **NOT** yet prove records → discovery facts → resolver → UI.
- **Client:** `createSlackClient({ tokenSource, httpClient, identity }, { includeBots })` → `authTest()` + `listUsers()`.
  The token comes ONLY from the PR #187 `ProviderTokenSource` seam (never a direct env read here); Slack is reached ONLY
  via the **injected** `httpClient` (no global `fetch` in the module → no accidental egress) with the token in the
  Authorization header (never the URL/log/record/error).
- **P0 Slack calls:** `auth.test`, `users.list` (single workspace). **Required Slack scopes:** `users:read`,
  `users:read.email`. **Not** implemented yet (future work): Enterprise Grid / `admin.users.list` (multi-workspace).
- **Handling:** cursor pagination via `response_metadata.next_cursor` (capped at 100 pages); `ok:false` → safe Slack
  error code; `invalid_auth` / `missing_scope`; `429` / `Retry-After` → `SlackApiError("ratelimited", retryAfterSeconds)`;
  malformed/non-JSON/missing-field → fail closed; missing profile fields → `undefined` (not empty); deleted/restricted/
  ultra-restricted flags explicit; **bots filtered by default** (incl. `USLACKBOT`).
- **Normalized record** (`SlackUserRecord`): only allowlisted non-secret fields (slackUserId, teamId, email?,
  displayName?, title?, status?, roleHint, isAdmin/Owner/PrimaryOwner/Restricted/UltraRestricted/Bot/Deleted, has2fa,
  hasSso, lastActivityAt?, timezone?, rawProvenance{updated,tzOffset,color}). **No raw Slack object spread; no token /
  auth header / full response / unknown object / tenant_id-from-Slack.**
- **Tests** (`slack-client.test.ts`, 22, mocked — no network): auth.test ok/fail, users.list, pagination, `ok:false`,
  invalid-auth/missing-scope, 429/Retry-After, malformed, with/without email, bot filtering, deleted/restricted flags,
  no-raw-spread (hostile extra `token`/`secret` fields dropped), no-token-leak in records/errors/console, global `fetch`
  never called, server-only boundary.

### Live field-path verification (§4) — DEV-ONLY, MANUAL (the old scraper is a reference, NOT ground truth)
Mock tests prove client BEHAVIOR; they do **not** prove Slack's current response shape. `scripts/verify-slack-field-
paths-dev.mjs` is the **local-dev-only** command that calls real Slack once (auth.test + users.list) and prints **safe
aggregates / field-path presence only** — never the token, an email, a name, the raw response, an auth header, or an
`xoxb-` value. It is **allowlist-shaped** (local dev + the PR #187 opt-in) and **fails closed** in CI/staging/prod; the
agent does NOT run it. Exact command:
```
NODE_ENV=development ID_CADDIE_DEV_PROVIDER_TOKEN_SOURCE_ENABLED=1 ID_CADDIE_DEV_SLACK_TOKEN=<dev-bot-token> \
  node scripts/verify-slack-field-paths-dev.mjs
```
(Mint a read-only bot token in the **disposable** Slack test workspace with scopes `users:read` + `users:read.email`;
set it locally only; report only the safe output.)

### Live verification result — RUN (2026-06-26, disposable test workspace; safe aggregates only)
`auth.test ok`, `team_id`/`user_id` present; `users.list ok`, **single page** (pagination handled). Aggregate of 3
members (2 bots, 1 sampled non-bot): withEmail 1, missingEmail 2, withDisplayName 3, withRealName 3, withTitle 3, withTz
3, with2fa 0, withSso 0, missingId 0.
- **PRESENT** (confirmed): `id`, `team_id`, `deleted`, `is_admin`, `is_owner`, `is_primary_owner`, `is_restricted`,
  `is_ultra_restricted`, `is_bot`, `tz`, `updated`, `profile.display_name`, `profile.real_name`, `profile.title`,
  `profile.status_text`.
- **ABSENT / stale** in the P0 `users.list` shape: **`has_2fa`, `has_sso`** → reconciled: removed from required output;
  **provenance-only when present**; defer real 2FA/SSO posture to Enterprise Grid / SCIM / a security-posture path.
- **`profile.email`: ABSENT on the sampled non-bot member.** Small-sample caveat — the run had only 1 non-bot member,
  who had no email set; this proves email **can** be absent (handle defensively), **not** that Slack email is
  unavailable. Reconciled: `email` is **optional** in the client (records never require it; missing-email + present-email
  both tested). **PR 3 must emit `person_identity_candidate` only when `email` exists.**

**Rerun (2026-06-26, after token rotation) — still INCONCLUSIVE for non-bots:** total 3 (2 bots, 1 non-bot),
`withEmail` 1, sampled non-bot `profile.email` ABSENT. A single workspace-wide `withEmail` could belong to a **bot** —
it does **not** prove email reaches a real non-bot member. The verify command was therefore upgraded to break email
presence **by user type** and to sample a **non-bot WITH email** for the field-path block. Its safe output now reports:
`total`, `bots`, `nonBots`, `usersWithEmail`, `botsWithEmail`, `nonBotsWithEmail`, `nonBotsMissingEmail`,
`sampledNonBotHasEmail`, `sampledNonBotWithEmailFound`, and (if found) the field-path block from a non-bot with email
(else `sampled non-bot with email: NOT FOUND`). It never prints emails/names/raw/token/`xoxb-`.

**Final run (2026-06-26, after adding a non-bot member with an email) — EMAIL GATE CLOSED ✅.** Safe output: total 3
(2 bots, 1 non-bot), `usersWithEmail` 1, `botsWithEmail` 0, **`nonBotsWithEmail` 1**, `nonBotsMissingEmail` 0,
**`sampledNonBotWithEmailFound: true`**, **`sampledNonBotHasEmail: true`**. Field-path block on the sampled non-bot
member **with email**: **PRESENT** `id`, `team_id`, `deleted`, `is_admin`, `is_owner`, `is_primary_owner`,
`is_restricted`, `is_ultra_restricted`, `is_bot`, `tz`, `updated`, **`profile.email`**, `profile.display_name`,
`profile.real_name`, `profile.title`, `profile.status_text`; **ABSENT** `has_2fa`, `has_sso`.

> **✅ EMAIL MERGE GATE for #188 — CLOSED.** `nonBotsWithEmail >= 1` AND `profile.email` PRESENT on a real non-bot
> member are both confirmed. Conclusions, locked in: (a) `profile.email` is present on a real non-bot member when an
> email exists, but remains **per-user optional** (the client never requires it); (b) **PR 3 emits
> `person_identity_candidate` ONLY when `email` exists**; (c) `has_2fa` / `has_sso` remain **unavailable** via P0
> `users.list` and must **not** be required (2FA/SSO posture → Enterprise Grid / SCIM / a security-posture path).
> The PR-3 email precondition is satisfied.

## PR 3 — Slack discovery-fact emitter (records → validated facts)
`src/lib/server/connector-vault/slack-discovery-emitter.ts` (server-only). Proves **normalized Slack records →
fact candidates → `parseDiscoveryFact` → safe fact array**. It STOPS there — **no DB staging, no resolver, no Slack
call, no UI, no manual trigger, no OAuth/runner/KMS** (it imports only the discovery-fact contract + the existing
`normalizeEmail` + the Slack record TYPES). Mirrors `okta-discovery-emitter.ts`.
- **Input (injected):** the `auth.test` workspace identity + `SlackUserRecord[]` from the PR #188 client, `tenantId`
  (authenticated arg), and `observedAt` (caller-provided ISO). `source_type = deep_provider_sync`, `source_provider =
  slack`.
- **Facts emitted (P0):** **app_discovery** (`Slack` / `Communication`, once, `slack:app_discovery:slack`);
  **app_instance_identity** (once, anchored on `team_id`, `slack:app_instance:{team_id}`); **app_user_account** (one per
  non-bot user, `slack:app_user:{team_id}:{user_id}` — **always**, even without email); **person_identity_candidate**
  (**only when email exists**, `primary_email` = normalized lower-cased Slack email, `slack:person:{email}`);
  **role_admin** (only admin/owner/primary_owner, priority primary_owner > owner > admin); **usage_activity** (only when
  a real last-activity ts exists). No Enterprise Grid `group_membership` in P0.
- **Field rules (per PR #188 live verification):** `email` is optional — missing email never drops `app_user_account`
  and **never constructs** a `person_identity_candidate`; **`has_2fa`/`has_sso` are never read** (unavailable via P0
  `users.list`; a future Enterprise Grid/SCIM/security-posture source may surface them); `display_name` → `real_name`
  fallback was already applied by PR #188; `title`/`tz`/`updated`/restricted/ultra/deleted flags ride **provenance**;
  never a raw Slack object, token, or auth header.
- **Idempotency:** deterministic signal ids (Slack ids / team id / normalized email) — no random ids, no timestamps in
  ids. `tenant_id` ALWAYS from the authenticated arg (a payload `tenant_id` is never read); `observed_at` from the
  caller. Every candidate re-validated with `parseDiscoveryFact` (strict) — invalid dropped (safe count only, no raw
  record logged), one bad record never fails the batch; bots skipped defensively.
- **Tests** (`slack-discovery-emitter.test.ts`, 16, synthetic): all fact types, email-present/absent, no-email→no-person
  (+ no malformed empty-email person), role priority, plain-member→role_hint-only, usage gated on activity, bot skip,
  tenant-from-arg (payload tenant_id ignored), no-token/raw-object leak, deterministic ids, has_2fa/has_sso never read,
  malformed-record skip, every fact passes `parseDiscoveryFact`, fail-closed on empty tenant/observed_at/team_id.
- **Schema note:** no new `source_type` invented (`deep_provider_sync`). No schema gaps required for P0 — the six fact
  types + provenance cover the verified Slack `users.list` shape. **Resolver write path remains the next deep-gate PR**
  (after the emitter/staging boundary); PR 3 does **not** stage.

## PR 4 — discovery facts → tenant-scoped resolver write path (DEEP GATE)
`src/lib/server/connector-vault/slack-resolver-write.ts` (server-only) + migration `0036` + real RLS tests. Turns
ALREADY-VALIDATED Slack facts (PR #189) into graph rows: **apps → app_users → people → app_user_identity_matches**,
idempotently and tenant-scoped. **No UI, no manual trigger, no scheduler, no Slack call, no OAuth/runner/KMS, no
service-role.**
- **Write path = direct resolver** (the injected user-scoped store pattern of `resolver-write.ts`/`identity-match-write.ts`),
  NOT staging-first — these facts are already validated by PR #189; the resolver writes the graph directly via an
  RLS-enforced store. (The concrete Supabase store impl is wired in a later PR, matching the existing resolver modules;
  this PR delivers the resolver logic + the DB-level proof.)
- **Tables written:** `apps`, `app_users`, `people`, `app_user_identity_matches`. **Not** `identity_accounts` (RLS
  default-deny — no authenticated write path; person matching goes via `people` + matches).
- **Migration `0036` (staging) — tenant-scoped natural keys for idempotent upsert** (defensive preflight, additive only,
  no RLS change): `apps UNIQUE(tenant_id, external_instance_id)` (Slack team_id; manual apps keep it NULL = distinct),
  `app_users UNIQUE(tenant_id, app_id, external_user_id)`, `people UNIQUE(tenant_id, lower(primary_email))`. Tenant scope
  is in **every** key (no global provider uniqueness — a Slack user id in two tenants is two rows). `app_user_identity_
  matches` already had `UNIQUE(tenant_id, app_user_id)` (0028).
- **Tenant isolation:** `tenant_id` ALWAYS from the authenticated `authTenantId` arg; a fact whose `tenant_id` differs is
  a SPOOF and is **skipped** (writes nothing). RLS (`has_tenant_role([owner,admin,editor])`) is the authoritative
  boundary; the resolver is the user-scoped caller (no service-role/admin client).
- **Idempotency: DB-enforced**, not app-code-only — upserts target the 0036 keys; a re-run updates apps/app_users/people
  in place. **Matches honour the 0028 deterministic-identity invariant: `ON CONFLICT (tenant_id, app_user_id) DO NOTHING`
  + a caller-side conflict guard** (`getExistingMatchPersonId`) — a re-run whose app_user now resolves to a DIFFERENT
  person is **left for review (`matchConflicts`), NEVER silently repointed** (same contract as `identity-match-write.ts`;
  `match_method=auto_exact_email`). Proven in `org_rls_test.sql` **Test 58** (real Postgres + RLS, acting as the
  `authenticated` non-superuser role) for **all four tables** (apps/app_users/people in 58a–c, matches in 58f): the keys
  exist, ON CONFLICT re-run does not duplicate, a **direct duplicate INSERT is REFUSED by the DB constraint**, a match
  re-run to a different person does **not** repoint, the same external id in two tenants stays separate, and a **Tenant A
  user cannot write a Tenant B row** (RLS WITH CHECK denies).
- **Data rules (per PR #188/#189):** `app_user` written even without email; `person`+match only when email exists
  (skipped otherwise, never crashes); **exact-email-only matching** (`match_method=auto_exact_email`, the 0028 one-per-
  app_user key) — **no fuzzy/name merge**; usage last-active → `app_users.last_active_at`; **`role_admin` has no role
  column (documented schema gap)** → the safe role label rides `app_users.raw_payload` as sanitized provenance
  (`{provider, role_hint}`) only; never a token / auth header / raw Slack object.
- **Transaction model:** per-fact best-effort (matches the existing resolver modules); every write is tenant-scoped by
  `authTenantId` so there is no unsafe partial cross-tenant state. One bad fact is skipped (counted), never blocks the
  batch.
- **Tests:** `slack-resolver-write.test.ts` (12, in-memory store modelling the natural keys — idempotency, same-id-two-
  tenants, spoofed-tenant ignored, fail-closed empty tenant, email-optional, exact-email-only, role-gap, usage,
  no-token-leak, bot skip) + **real DB/RLS** `org_rls_test.sql` Test 58 (the tenant-isolation property — proven, not
  mocked).
- **Schema gaps found (documented, not invented):** no role column on `app_users` (role → raw_payload provenance); no
  `app_instances` table (instance identity uses the `apps` 0024 instance columns); `identity_accounts` is RLS
  default-deny (not written in P0).

## PR 5 — read-only UI display of synced Slack data
Surfaces the PR #190-resolved rows in the EXISTING authenticated app surface — **read-only**, RLS-scoped, no writes.
- **UI surface extended:** the existing **app detail page** (`src/app/(authenticated)/apps/[id]/page.tsx`), which already
  renders the RLS-scoped `app_users` roster (the app_user's own name/email/external-id/status/last-active + a
  matched/unmatched status only — no matched-person PII, no `raw_payload`, no token). PR 5 adds a
  **"Synced from Slack" marker** + reframes the roster heading to **"Synced Slack users" (read-only preview)** when the
  app is a connector-synced Slack workspace, with a Slack-specific empty state.
- **Read path / DAL:** the existing `getAppDetailForCurrentUser` + `listAppUsersForApp` (user-scoped `createClient`, RLS-
  enforced, **no service-role**, no `tenant_id` from the caller, `raw_payload`/`source` excluded). The only DAL change is
  additive + read-only: `AppDetail` now exposes the **non-secret** connector markers `external_instance_id` + `instance_url`
  (migration 0024) so the UI can identify a synced app.
- **Identification (read-model):** a pure `classifySlackSync({ externalInstanceId, vendorName })` → an app is Slack-synced
  when it has an `external_instance_id` (the resolver set it to the Slack team_id — a **structural** marker, not display-
  name-only) AND `vendor_name="Slack"`. **Read-model note (gap, not a blocker):** there is no first-class `provider`/`source`
  enum column today (the provider also lives in `app_users.raw_payload`, which the read DAL excludes); identification uses
  the instance marker + vendor. A future schema enhancement could add a dedicated `source='slack'` column.
- **What appears:** the Slack workspace app + its synced users (display name, email when present, status, last active,
  matched/unmatched status). **Role/admin hint is NOT shown** — it lives in `app_users.raw_payload` which the safe DAL
  excludes (the PR #4 no-role-column gap); surfacing it would need a real column (deferred). No raw payload, no token, no
  cross-tenant data, no people/identity-account-table PII (the matched person's name/identity-account details are never shown).
- **No false readiness:** copy is read-only-preview only ("Synced from Slack", "Read-only Slack sync preview", "Manual run
  coming next") — never "Connect Slack" / "Run sync" / OAuth / "production connector ready"; no connect/sync button (the
  pre-existing disabled "Connector sync — Not built yet" chip stays).
- **Empty/missing-data safe:** no app row → standard not-found; Slack app with no users → "No synced Slack users yet…";
  users without email / last-active / role → render safely ("—"), never crash.
- **Tests:** `slack-sync-display.test.ts` (classifier matrix, copy has no false-readiness CTA / no token, and a static
  scan that the page identifies rows via `classifySlackSync` and renders no active connect/sync CTA and no `raw_payload`/
  token) + extended `apps.test.ts` (the DAL returns the new markers). **No new RLS test needed:** `external_instance_id`
  is on the already-RLS-scoped `apps` row, and the roster read is the existing RLS-proven path (`org_rls_test.sql`
  T25/T28/T29); no new read DAL crosses a tenant boundary.

### Remaining PRs after PR 4
- **PR 5** — UI display of synced Slack data. **PR 6** — manual server-only run trigger. **Later** — scheduler / run
  lifecycle. **Later** — OAuth/vault/runner production credential path (RISK-007). The concrete Supabase store impl for
  the resolver is also a near-term wiring step.

### Constraints carried by PR 1
- The dev-token source is for **local development proof only** and is **structurally disabled outside local/dev**.
- It **must be removed or replaced** by the OAuth/vault/runner source **before any production connector use**.
- PR 1 adds **no** Slack API client, **no** Slack call, **no** OAuth, **no** runner/Fargate/KMS/IAM, **no** customer
  credential, **no** real token. **RISK-001 / RISK-007 remain OPEN; cutover BLOCKED.**
