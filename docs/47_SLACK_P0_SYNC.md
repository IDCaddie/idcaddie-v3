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

## PR 6 — manual server-only run trigger (LOCAL/DEV ONLY)
Wires the merged pieces into one manual run: **dev-token source (#187) → Slack client (#188) → emitter (#189) →
tenant-scoped resolver (#190)**. Structurally disabled outside local dev. **No UI button, no scheduler, no background
job, no OAuth/runner, no public route/server action, no service-role, no production.**
- **Orchestrator (`src/lib/server/sync/run-slack-sync-dev.ts`):** `runSlackSyncDev({ env, tokenSource, httpClient, store,
  identity, observedAt })` → a **safe aggregate summary** (`{ ok, teamPresent, usersFetched, factsEmitted, factsRejected,
  appUsersWritten, peopleWritten, matchesWritten, matchConflicts, skipped }` or `{ ok:false, errorCode }`). The token
  comes ONLY via the #187 seam; it is **never** logged/returned/in the summary or errors. Failures surface only a SAFE
  code (`invalid_auth`/`missing_scope`/`ratelimited`/`malformed_response`/`resolve_failed`/`run_disabled`/`missing_tenant`)
  — never a token, raw response, email, or name. `tenant_id` is the caller's arg, never a Slack payload.
- **Allowlist-shaped run guard** `isDevSlackSyncRunEnabled`: enabled ONLY in positively-confirmed local dev (`NODE_ENV=
  development` + `VERCEL_ENV`∈{unset,development}) AND a distinct explicit opt-in `ID_CADDIE_DEV_SLACK_SYNC_ENABLED=1`.
  unknown/unset/test/staging/preview/production all refuse; request input cannot enable it (env-only).
- **User-scoped context (#5):** `dev-user-scoped-client.ts` `createDevUserScopedClient(env)` — the standard server client
  is cookie-bound (needs a Next request), so a standalone run builds a user-scoped client from a **dev tenant-member's
  JWT** (`ID_CADDIE_DEV_USER_JWT`) in the Authorization header over the **public anon key**. RLS applies (writes as a
  tenant member); it is **never** service-role; the JWT is read from a server-only env var and never logged.
- **Concrete resolver store (#6):** `supabase-slack-resolver-store.ts` implements the #190 `SlackResolverStore` over the
  injected user-scoped client — apps/app_users via `upsert(onConflict=the 0036 tenant-scoped keys)`, people via
  get-or-create against the functional `lower(primary_email)` index, matches via `ON CONFLICT (tenant_id, app_user_id)
  DO NOTHING` (the 0028 no-repoint invariant). Errors surface only `store_write_failed`. **No migration** (the 0036/0028
  keys suffice); **no service-role**.
- **Trigger = a REAL committed command** `npm run slack:sync:dev` (`run-slack-sync-dev.liverun.test.ts`, run via vitest —
  the repo's TS runner that resolves the chain; plain `node` cannot, no `tsx`). It builds the REAL deps (token source +
  `slackFetchHttpClient` + `createSupabaseSlackResolverStore(createDevUserScopedClient(env))`) and invokes
  `runSlackSyncDev`, printing ONLY the safe summary. **DOUBLE-gated** (`ID_CADDIE_DEV_SLACK_SYNC_ENABLED=1` AND
  `SLACK_SYNC_LIVE=1`) → SKIPPED in `npm test`/CI, no client/network at import. The guarded `.mjs`
  (`scripts/run-slack-sync-dev.mjs`) remains as a pre-flight (prints the procedure, refuses the prod ref / token-in-argv).
  **No public route / server action / UI button.**
- **Tests (53 + a real-DB IT):** orchestrator (guard allowlist, request-can't-enable, chain order, token-never-leaks,
  no-email/name/raw in summary, idempotent rerun, all safe-failure paths) + concrete-store shape/safety + dev-client
  (anon-key + JWT header, not service-role, fail-closed, no-JWT-echo) + `.mjs` guards + a server-only/no-`src/app`-import
  static scan.
- **Real DB/RLS proof of the TS store — RUN, not mocks.** `supabase-slack-resolver-store.it.test.ts` runs the store's
  supabase-js/PostgREST queries against a **LOCAL Supabase stack** as a **tenant-member JWT** (service-role used for
  fixture setup ONLY): the 0036-key upsert is idempotent (one row on re-run), the full graph (app_user+person+match)
  writes, the get-or-create matches `_` LITERALLY (the LIKE-escape, so a `_` email can't grab the wrong person), and
  **RLS DENIES a cross-tenant write** (member B → tenant A ⇒ `store_write_failed`, nothing written). Run via
  `npm run test:store-it` (`scripts/test-store-it.sh` → `supabase start` + vitest) and in CI (`store-integration.yml`).
  The SQL-layer `org_rls_test.sql` Test 58 still proves the same constraints/RLS independently.
- **Safe resolver-failure diagnostics:** a resolver/store failure returns `{ ok:false, errorCode:"resolve_failed",
  failedStage, table, safeDbCode, safeReason, usersFetched, factsEmitted, factsRejected }`. The concrete store attaches a
  **value-free** `StoreWriteFailure` = `{ table, op, code }` — **only** the SQLSTATE/PostgREST `code` (e.g. `42501`),
  NEVER the DB message/details/hint (those embed row values like emails). `safeReason` maps the code:
  `42501→rls_denied`, `23502/23503/23505/23514→constraint_violation`, `42703/42P01/PGRST204/PGRST205→schema_mismatch`,
  else `unknown`. Unit-tested (mapping + no token/email/name/raw in the diagnostic) and the real cross-tenant RLS denial
  in the store IT confirms the live code is `42501`.
- **Live-run failure analysis (2026-06-27):** the first operator live run returned `resolve_failed`; tenant
  `7a296850-…` had **0 apps / 0 app_users / 0 people / 0 matches** (no partial writes) — consistent with the FIRST store
  write (`upsert_app`) being RLS-denied before any insert. With the new diagnostics the rerun will report
  `failedStage:"upsert_app", table:"apps", safeDbCode:"42501", safeReason:"rls_denied"` ⇒ **the dev-user JWT
  (`ID_CADDIE_DEV_USER_JWT`) is not an `owner`/`admin`/`editor` member of `SLACK_SYNC_TENANT_ID`** (RLS `has_tenant_role`
  requires an active membership). Fix: sign in as / mint a JWT for a user who is an active write-role member of that
  tenant (or add the membership), then rerun.
- **Live end-to-end run — SUCCEEDED (2026-06-27, operator, local/dev).** After using an active write-role member JWT for
  the tenant, `npm run slack:sync:dev` ran the full chain (dev-token source → Slack client → emitter → resolver store →
  tenant-scoped DB rows). **Safe summary:** `ok:true, teamPresent:true, usersFetched:1, factsEmitted:6, factsRejected:0,
  appUsersWritten:1, peopleWritten:1, matchesWritten:1, matchConflicts:0, skipped:2`. Output was safe — **no token, JWT,
  email, name, raw Slack response, or raw DB payload**. The written rows are visible via the PR-5 read-only UI and the run
  is idempotent on re-run. It needed operator-only secrets (a rotated dev Slack token + a dev tenant-member JWT + a dev
  Slack workspace), so the agent could not perform it. **This is a dev/test token run — NOT customer OAuth, NOT the
  production runner, NOT a scheduler. RISK-001/RISK-007 remain OPEN.**

## PR 7 — run lifecycle/status for the manual Slack sync
Adds a minimal, auditable, tenant-scoped run record so each manual sync has safe status/counts/error visibility. Proves
*manual Slack sync run → run status/counts/error summary → read-only visibility*. **No scheduler, no OAuth, no runner, no
KMS, no Connect-Slack, no service-role, no production. RISK-007 stays OPEN.**
- **Table — `manual_sync_runs` (migration 0037, additive + RLS).** Distinct from `connector_runs` (0017): that table is
  keyed to an OAuth-connected `connectors` row (FK) and reserved for the future server-only runner; the dev manual sync
  has NO connectors/vault row, so reusing it would force a fake "connected" connector + expand the connectors write
  surface. `connector_id` here is a plain LABEL (not an FK). Columns: `tenant_id`, `source` (='slack'), `connector_id`,
  `status` (running|succeeded|failed), `started_at`, `finished_at`, `error_code`, `failed_stage`, the eight counts
  (`users_fetched`, `facts_emitted`, `facts_rejected`, `app_users_written`, `people_written`, `matches_written`,
  `match_conflicts`, `skipped`), `created_by` (`default auth.uid()` — the actor from the JWT), timestamps. **Never** a
  token / JWT / email / name / raw Slack response / raw user record / raw DB payload.
- **RLS:** members READ (`is_tenant_member`); owner/admin/editor WRITE (`has_tenant_role`); no DELETE (append-only audit
  log). Tenant-scoped; no cross-tenant access by source/connector label alone.
- **Write path:** `manual-sync-run-recorder.ts` (`createSupabaseManualSyncRunRecorder`, over the injected user-scoped
  client — RLS, never service-role): `start()` opens a `running` row; `finish()` closes it from the SAFE
  `RunSlackSyncSummary` → `succeeded` (+counts) or `failed` (+`error_code`/`failed_stage`). `recorded-slack-sync-run.ts`
  wraps the chain: refused runs make NO record; `start` BEFORE the chain, `finish` AFTER. **A process crash between
  start and finish leaves the row `running` — never a misleading `succeeded`.** The live entrypoint now records.
- **Read/UI:** `getLatestSlackSyncRunForCurrentTenant` (RLS-scoped read DAL, safe DTO) drives a read-only **"Last Slack
  sync"** section on the existing app detail page (Slack-synced apps) — status, last-successful-sync time, latest safe
  error code, and the counts. Empty state when no runs. **No Run button, no Connect button, no scheduler language.**
- **Concurrent-run locking — deferred (next PR).** No existing safe locking pattern in the repo; a DB lock (e.g. a
  partial unique index on active runs) needs stale-run reconciliation to avoid a stuck `running` blocking all future
  runs. The start→finish status model already prevents a misleading success; concurrent-run locking + stale-run
  reconciliation are the next PR.
- **Tests:** recorder unit (start/finish mapping; only safe columns written; safe error) + wrapper unit (guard → no
  record; start-before/finish-after; crash → failed, never misleading-success) + read-DAL unit (safe DTO; empty state) +
  page static scan (read-only status, no run/connect button, no scheduler language, no token/raw). **Real DB/RLS:**
  `org_rls_test.sql` **Test 59** (member read; owner/admin/editor write; viewer read-only; cross-tenant read+write
  isolation; `created_by` default) + a TS recorder IT (`manual-sync-run-recorder.it.test.ts`) against a local Supabase
  stack (member writes; cross-tenant denial; `created_by` = the member) via `npm run test:store-it` + CI `store-integration.yml`.

## PR 8 — concurrent-run locking + stale-run reconciliation
Closes PR 7's documented gap. Proves *run starts → active-run lock acquired → duplicate refused → run finishes →
lock released* and *stale running run → safely marked failed without pretending success*. **No scheduler, no retry
worker, no OAuth/runner, no Connect-Slack, no service-role in product code, no production. RISK-007 stays OPEN.**
- **Lock (migration 0038, additive — CREATE INDEX only):** a **partial unique index**
  `manual_sync_runs (tenant_id, source, connector_id) where status = 'running'` → at most ONE active run per
  (tenant, source, connector). The key includes `tenant_id`, so the lock is **tenant-scoped** (tenant A's active run
  never blocks tenant B). DB-enforced — no app-code check-then-insert race: a concurrent `start()` INSERT hits the index
  → unique_violation → the recorder returns **`run_already_active`**.
- **Duplicate-run behavior:** a refused run **creates NO record** (the INSERT fails) and **never touches the chain** — no
  Slack call, no emitter, no resolver write. The wrapper returns `{ ok:false, errorCode:"run_already_active" }`; the
  existing active run is untouched.
- **Stale reconciliation (inline, no scheduler):** at the start of each manual run, BEFORE acquiring the lock,
  `reconcileStaleRuns` marks any run stuck in `running` past the threshold as **`failed` / `error_code=
  "stale_run_reconciled"`** with `finished_at` set — **no success counts invented**, no token/JWT/email/name/raw. This
  releases a stuck lock so new runs can proceed. Threshold = **`STALE_RUN_MS` = 30 minutes** (a code constant). The 0037
  immutability trigger permits this (running→failed is not yet terminal); completed runs stay immutable and `created_by`
  integrity holds. Tenant-scoped via RLS — a tenant cannot reconcile another tenant's runs.
- **Safe error codes:** `run_already_active`, `stale_run_reconciled` (plus the unchanged Slack/resolve safe codes).
- **Robustness:** the reconcile step is **best-effort** (a reconcile DB error never aborts an otherwise-valid run — `start()`
  is the authoritative lock); and `finish()` closes **only a still-`running`** row, so if an abnormally long (>30 min)
  run is concurrently reconciled mid-flight, its `finish()` is a safe no-op (it never trips the 0037 completed-run
  immutability) — the record reads `stale_run_reconciled` and the chain's already-committed writes stand.
- **UI:** no change needed — PR 7's read-only "Last Slack sync" section already shows `running`/`succeeded`/`failed`,
  and a stale-reconciled run surfaces as `failed` with `error: stale_run_reconciled`. (`run_already_active` is a transient
  refusal that writes no record, so it never appears as a run.)
- **Tests:** recorder unit (start → run_already_active on 23505; reconcile marks stale failed, scoped, no counts) +
  wrapper unit (reconcile-before-lock; duplicate → run_already_active with NO chain call) + **real DB/RLS**
  `org_rls_test.sql` **Test 60** (the partial-index lock; tenant-scoped; lock released after a run leaves running) + a TS
  recorder IT (second run refused + not recorded; tenant A does not block tenant B; stale reconciled then a new run
  starts; tenant A cannot reconcile tenant B). `gen-types` 0-diff (an index changes no columns).

## PR 9 — controlled internal run-trigger exposure
Lets an authorized internal operator start a Slack sync **without the terminal command** — through a tightly gated
internal-dev surface. Proves *internal authorized trigger → guard checks → run lock acquired → chain executes →
manual_sync_runs records status/counts/errors → UI-readable status*. **No scheduler, no retry worker, no OAuth/runner,
no KMS, no customer-facing Connect-Slack, no production enablement, no service-role in product code. RISK-007 stays OPEN.**
- **Trigger shape:** a `"use server"` **server action** (`internal/slack-sync/actions.ts`) over a server-only
  orchestrator (`internal-slack-trigger.ts`), invoked from a **hidden, flag-gated internal page**
  (`internal/slack-sync/page.tsx` — **not in the nav**). No public/unauthenticated route, no customer-facing button.
  Because it runs in a request context it uses the **cookie `createClient()`** (the authenticated operator's own
  user-scoped client) — RLS-governed as that user, **never service-role, never a dev JWT**.
- **Env guard `isInternalSlackTriggerEnabled`:** allowlist-shaped, fail-closed — enabled ONLY in positively-confirmed
  local dev (`NODE_ENV=development`, `VERCEL_ENV`∈{unset,development}) AND a **distinct** opt-in
  `ID_CADDIE_INTERNAL_SLACK_TRIGGER_ENABLED=1`. unknown/unset/test/preview/production refuse; a request cannot enable it.
- **Authorization (`authorizeInternalTrigger`, pure):** requires an authenticated user AND a **single active write-role
  (owner/admin/editor) tenant membership**, with `tenant_id` resolved server-side from `resolveTenantContext` — NEVER
  from the request (there is no tenant/connector request input to spoof; `connector_id` is a fixed server label). Refuses
  `unauthenticated` / `no_active_tenant` / `tenant_switch_required` (multiple tenants) / `insufficient_role` (viewer).
- **Execution:** reuses the existing chain end-to-end (token source #187 → client #188 → emitter #189 → resolver store
  #190 → recorder + lock/stale-reconcile #194/#195) via `recordedSlackSyncRun` — no duplicated chain logic. A refused
  trigger and a **duplicate active run (`run_already_active`) never call Slack/emitter/resolver** and write no record.
- **Safe response:** the orchestrator returns the safe `RunSlackSyncSummary` (ok/status/errorCode/failedStage/safeReason
  + counts/runId) — **no token, JWT, email, name, raw Slack response, raw DB payload, auth header, request body, or
  stack trace**. Surfaced via the page's "Last run" status (RLS-scoped `getLatestSlackSyncRunForCurrentTenant`).
- **UI:** a hidden internal-dev page labeled **"Internal dev Slack sync"** — the form button renders ONLY when the env
  flag is on AND the user is a write-role member; in any deployed/non-dev environment it shows "not enabled" (no button).
  Not in the nav, not customer-facing, no Connect-Slack/OAuth/scheduler/production language.
- **No migration, no new RLS:** the write path is the PR #194/#195 recorder (RLS already proven by `org_rls_test` Test
  59/60 + the recorder IT — cross-tenant write/reconcile denied); this PR adds an **app-layer** authz gate on top.
- **Tests:** `internal-slack-trigger.test.ts` — env-guard allowlist matrix; the authz matrix (owner/admin/editor allowed;
  unauthenticated/viewer/no-tenant/multi-tenant/disabled refused; request can't enable); the orchestration (authorized →
  chain called with the auth-derived tenant; refused → chain NEVER called; duplicate → `run_already_active` passthrough;
  safe summary has no token/email/name/raw) + a page/action static scan (flag-gated, internal-dev label, no
  customer-facing/scheduler CTA, no token/raw, action takes no caller input).

## PR 10 — scheduler/retry worker (LOCAL/DEV/INTERNAL ONLY)
A guarded scheduler/retry worker that runs the Slack sync automatically, reusing the PR #194/#195 run lifecycle + lock +
stale-reconcile. Proves *tick → eligible target selected → stale runs reconciled → lock acquired → chain executes →
`manual_sync_runs` records succeeded/failed → duplicate active runs skipped (`run_already_active`)*. **No OAuth/runner,
no KMS, no customer-facing Connect-Slack, no production enablement, no service-role in product code. RISK-007 stays OPEN.**
- **Scheduler shape — ROUTE-based + worker function.** A worker tick `runSlackSyncSchedulerTick` (eligibility + per-target
  run via `recordedSlackSyncRun`) plus a **cron-secret + env-flag gated POST route** `/api/internal/slack-scheduler` (a
  thin wrapper over the testable `handleSlackSchedulerRequest`). The route is **PRODUCTION-DISABLED** (the allowlist env
  flag is false outside local dev) and **NOT a public unauthenticated route** (a cron secret header gates it; when
  disabled it returns 404). **Production cron INFRA (a Vercel cron that hits the route) is NOT wired** — deferred.
- **Enablement flags (all required, fail-closed):** `ID_CADDIE_SLACK_SCHEDULER_ENABLED=1` (the scheduler opt-in) +
  `ID_CADDIE_SLACK_SCHEDULER_SECRET=<cron secret>` (the route header `x-scheduler-secret` must match, constant-time) +
  `ID_CADDIE_SLACK_SCHEDULER_CONNECTORS=<comma-separated connector ids>` + `SLACK_SYNC_TENANT_ID` (the dev tenant) +
  the chain's own flags (`ID_CADDIE_DEV_SLACK_SYNC_ENABLED`, the dev token, `ID_CADDIE_DEV_USER_JWT`).
- **Environment guard `isSlackSchedulerEnabled`:** allowlist-shaped — ONLY `NODE_ENV=development` +
  `VERCEL_ENV`∈{unset,development} + the distinct scheduler opt-in. unknown/unset/test/preview/production refuse; a
  request cannot enable it. **Local/dev/internal ONLY** (the chain itself only runs in local dev).
- **Write identity (§8 — a tick has no browser session):** the worker writes via the **existing dev-user-JWT client**
  (`createDevUserScopedClient`, PR #192) — a **user-scoped (RLS) client, NEVER service-role**. Every write is RLS-governed
  as that dev tenant member; tenant isolation is the DB's, identical to the manual run. **No service-role shortcut.**
- **Tenant/connector eligibility (§5):** an explicit **tenant-scoped connector allowlist** (`parseSchedulerTargets` →
  `(SLACK_SYNC_TENANT_ID, connector_id)` pairs). Tenant-scoped + connector-scoped; **never "run all tenants"**, no
  cross-tenant lookup, no request-supplied tenant.
- **Duplicate runs:** handled by the PR #195 lock — `recordedSlackSyncRun` reconciles stale, then acquires the per-target
  lock; a concurrent active run returns **`run_already_active`** and **never calls Slack/emitter/resolver**.
- **Stale runs:** reconciled to `failed`/`stale_run_reconciled` by the existing PR #195 path (inside `recordedSlackSyncRun`)
  before the lock — never invented success, completed-run immutability + actor pin intact.
- **Retry/backoff policy (`classifyTargetEligibility`):** per tick, each target runs at most once (no in-tick loop, no
  rapid Slack calls). Retry is an **allowlist (fail-closed)**: ONLY known-transient failures
  (`ratelimited`/`slack_error`/`http_error`/`malformed_response`/`run_crashed`/`resolve_failed`/`store_write_failed`/
  `stale_run_reconciled`) are retried — **every other failure, including auth/scope/config AND any unknown/permanent
  Slack token code (e.g. `token_revoked`, `account_inactive`), fails closed = NOT retried**. A transient failure or a
  success is eligible again only **after a 30-minute backoff** (`SCHEDULER_INTERVAL_MS`); a stale `running` becomes
  eligible (the chain then reconciles + re-locks it). Rate-limit handling follows the Slack client's safe error behavior.
- **Credential source:** the existing **dev/internal** token source (#187) + the dev-user-JWT client only. **No customer
  credentials, no production OAuth/vault/runner, no pasted token, no token in DB/logs/docs/run-records/test output.**
- **Safe to log/return:** the tick result is **connector label + status/errorCode + counts ONLY** — never a token, JWT,
  email, name, raw Slack response, raw DB payload, or auth header. The route returns this JSON; a tick error is a safe 500.
- **How to operate it (local dev):** set the flags above + the dev token/JWT, run `next dev`, then `POST
  /api/internal/slack-scheduler` with `x-scheduler-secret: <secret>` (a local cron entry or `curl`). Each tick reconciles
  stale runs, runs eligible connectors, and records safe status; results are visible via the PR #5 "Last Slack sync" /
  PR #9 "Last run" status. **Disabled by default — does nothing without all flags.**
- **How to test it:** `npm test` (`slack-sync-scheduler.test.ts` — env-guard matrix; eligibility/retry/backoff matrix;
  target parsing; constant-time secret; the route handler 404/401/200/500; tick orchestration with injected deps:
  disabled→no work, eligible→runs, ineligible→skipped, duplicate→`run_already_active`, safe results). No new
  migration/RLS — the write path is the PR #194/#195 recorder (RLS proven by `org_rls_test` Test 59/60 + the recorder IT).
- **Out of scope / remains unsafe-incomplete:** OAuth/vault/runner production credential source (RISK-007, still OPEN);
  customer-facing Connect-Slack; **production scheduler enablement (Vercel cron infra) — DEFERRED, not wired**;
  first-class connector lifecycle/status; Google Workspace; value-layer/license/spend reporting. **RISK-007 remains OPEN.**

## PR 11 — Slack production credential path FOUNDATION (vault token source, fail-closed)
Moves the token model from "dev source only" toward "OAuth/vault/runner source → existing Slack chain" — but keeps every
risky production enablement **disabled**. **RISK-007 stays OPEN.** No real OAuth, no customer Connect-Slack, no production
token exchange, no customer/production credentials, no service-role, no KMS/IAM change, no migration, no production touch.
- **What PR #198 adds:** (1) `vault-provider-token-source.ts` — `createVaultProviderTokenSource()`, a **typed FAIL-CLOSED
  placeholder** implementing the same `ProviderTokenSource` seam whose `getProviderToken` **always throws** a generic
  error (no token loading, no fake/mock, no fallback); (2) `provider-token-source-selector.ts` —
  `createProviderTokenSource(env)`, an **env-driven selector** that wires the chain to choose its token source by
  environment/config; (3) the three chain callers (scheduler, internal trigger, manual-run entrypoint) now build the
  token source via the selector instead of the dev source directly.
- **Why a placeholder (verified from source, not assumed):** a real reader cannot be wired yet — **all of**: no hosted
  runner exists and an in-repo runner is architecturally forbidden (**doc 46 §11** — the app stays pg-free); production
  KMS/IAM is **unverified/unprovisioned** (**doc 44 §0**; the real AWS-SDK KMS sender is imported by nothing but its
  test); the OAuth callback is **fully synthetic + production-disabled** (no real exchange, no real client secret); and
  the **doc 44 §5 first-real-token dry-run (the 17-item executed-proof) has NOT run**. The contract IS concrete (the
  `connector_secrets` envelope can hold Slack tokens; `loadConnectorSecret`/`RunnerConnection` exist), so the future swap
  is a documented zero-caller-change drop-in — but building a real reader now would require faking it. **Hard-stops 1–7
  all apply → typed fail-closed placeholder.**
- **Dev source vs vault source:** the **dev source** (`createDevProviderTokenSource`, PR #187) reads a server-only
  `ID_CADDIE_DEV_SLACK_TOKEN`, is enabled ONLY in positively-confirmed local dev + opt-in, and returns an in-memory
  `{provider, token}` for LOCAL proof. The **vault source** is the production-shaped seam that will (in a future PR) load
  the token through the runner/KMS/vault boundary; **today it loads nothing and always fails closed**. The dev token env
  is read by the dev source ONLY (static-scanned); the vault source + selector never read it.
- **Guard behavior (allowlist-shaped, fail-closed):** `isDevProviderTokenSourceEnabled` = local dev + opt-in (unchanged).
  `isVaultProviderTokenSourceEnabled` is **always false** (no provisioned/approved production-credential-ready state; even
  if a future flag were set, `getProviderToken` still throws). A request can never enable either (env-only).
- **Token-source SELECTION rules:** `createProviderTokenSource(env)` returns the **dev source ONLY** when
  `isDevProviderTokenSourceEnabled(env)` (local dev + opt-in); **every other environment** (unknown/unset/test/staging/
  preview/production) gets the **vault source**, which fails closed. **There is NO vault→dev fallback** — outside local
  dev the chain can only get the throwing vault source, never the dev token (proven: production WITH the dev token env
  present still fails closed).
- **Effect on scheduler / manual run / internal trigger:** all three now select the token source by env. In local
  dev + opt-in nothing changes (they get the dev source). In any deployed/non-dev environment they get the fail-closed
  vault source, so the chain refuses (no token) — which is the desired posture until the production path is real.
- **The future OAuth → vault → runner → sync handoff (documented, NOT coded):** Slack OAuth callback → token exchange →
  `connector_secrets` envelope (KMS-wrapped DEK, doc 42) → the **hosted runner** (a separate deployable, doc 46 §11)
  reads it via `loadConnectorSecret(capability, {context, store})`, `capability =
  acquireRunnerDecryptCapability({runnerEnv: CONNECTOR_VAULT_RUNNER, keyProvider})`, `keyProvider =
  createKmsKeyProvider(createAwsKmsClient(createAwsKmsSdkSenderFromEnv()))`. None of this is imported or instantiated in
  this PR.
- **What remains for RISK-007 (still OPEN):** the **doc 44 §5** first-real-token staging dry-run (17 executed-proof
  evidence items: zero token across all log surfaces, envelope-only DB row, web-identity-cannot-decrypt negative,
  wrong-tenant fails query+AEAD, revoked-cannot-load, audit-failure rollback, provider revoke, cleanup); a **hosted
  runner** built as a separate deployable (doc 46 §11/§12, ECS/Fargate one-shot, Secrets Manager task-read); **production
  KMS/IAM** provisioned + verified by a LIVE round-trip + executed AccessDenied negative (doc 44 §5 item 6, not
  simulate-only); the **B2c-run** first-real-token runbook (doc 45, gated, not authorized); a reviewed migration for the
  `connector_runner_login` identity. Only then is the runner-backed vault source wired, gated behind a future approved
  production-credential-ready flag.
- **Why customer-facing Connect-Slack is still NOT ready:** there is no real OAuth exchange, no real token in the vault,
  no hosted runner to decrypt it, and no verified production KMS/IAM — so no customer credential can be born or used.
- **Test evidence:** `vault-provider-token-source.test.ts` (always throws regardless of env/request; enable flag always
  false; error carries no token/env/request; imports nothing from the vault/runner/KMS/AWS layer + reads no token env) +
  `provider-token-source-selector.test.ts` (dev source only in local-dev+opt-in; every other env → fail-closed vault;
  **no vault→dev fallback** even with the dev token present; request can't enable; no leak) + the server-only static scan
  (sentinel + no-`src/app`-import) + the no-direct-token-env-read invariant (only the dev source reads it).
- **Operator notes:** nothing to enable. The vault source is intentionally inert. Do NOT set
  `ID_CADDIE_VAULT_PROVIDER_TOKEN_SOURCE_ENABLED` (no effect — the source still throws) and do NOT add any
  `CONNECTOR_VAULT_AWS_KMS_REGION`/`CONNECTOR_VAULT_RUNNER`/`CONNECTOR_VAULT_KMS_KEY_ID` defaults; production stays
  blocked. See **docs 42/44/45/46** + **doc 04 RISK-007** for the full closure path. **RISK-007 remains OPEN.**

## PR 12 — hosted connector runner SKELETON (typed app↔runner seam, fail-closed)
Lands the **typed boundary** the future hosted runner implements — **without** building an in-repo runner or enabling any
credential use. **RISK-007 stays OPEN.** No real Slack token load, no real KMS/AWS/pg, no real OAuth, no production touch,
no KMS/IAM change, no migration, no new dependency.
- **Why a SEAM, not an in-repo runner (doc 46 §11, PINNED):** the conforming runner is a **separate deployable in its own
  repo** (Option A) that **vendors** the committed connector-vault core at a pinned commit (Option B). The app repo
  **stays pg-free** — adding `pg` here is NOT authorized, and an in-repo runner would require a new decision replacing
  §11. So PR #199 ships **only the typed contract + a disabled placeholder** the separate runner will implement.
- **Runner skeleton location:** `src/lib/server/connector-vault/runner-ingest-entrypoint.ts` (server-only) — co-located
  with the committed core the runner vendors. It defines: the **`RunnerIngestEntrypoint`** seam (`run(request, deps?)`),
  **`RunnerIngestRequest`** (a NON-secret envelope — provider/tenant/connector/purpose/secretKind/appEnv/version; carries
  NO plaintext), **`RunnerIngestResult`** (redacted: `{ok, secretId|reason, provider}`), the closed **`RunnerIngestReason`**
  enum (reuses the harness `IngestReason` + `disabled`/`unsupported_provider`/`unsupported_purpose`/`missing_tenant`/
  `missing_connector`), a pure **`validateRunnerIngestRequest`**, the **`isRunnerIngestEntrypointEnabled`** guard, and the
  **`createDisabledRunnerIngestEntrypoint`** placeholder.
- **What is intentionally DISABLED:** `isRunnerIngestEntrypointEnabled` is **always false** (`productionRunnerReady`
  hardcoded false — no separate runner deployable, no provisioned/verified prod KMS-IAM, no first-real-token; even the
  future opt-in flag has no effect). `createDisabledRunnerIngestEntrypoint().run()` **always returns `{ok:false,
  reason:"disabled"}`** — it loads NO token, instantiates NO pg/KMS/AWS/RunnerConnection, logs NO request fields.
- **Why no real token is loaded yet:** the real ingest (Secrets-Manager-read plaintext → `ingestClientSecret` →
  `runSequence([SET ROLE, INSERT])`) lives in the SEPARATE runner. The app repo holds only the typed seam; the future
  swap is zero-contract-change (the runner vendors this contract + the committed core).
- **Boundary rules (app ↔ runner):** the app runtime never imports the runner internals from a route/request surface, is
  **pg-free**, and never imports `@aws-sdk/client-secretsmanager`; `@aws-sdk/client-kms` is confined to the two committed
  KMS adapters. Enforced by a new scan **`scripts/check-app-runtime-imports.sh`** (+ selftest), plus the extended
  connector-vault **no-client-import** (the entrypoint can't be imported by `src/app`/`"use client"`) and **no-disk**
  (the entrypoint imports only `node:crypto` + relative; no fs/tmpdir sink) scans.
- **Relation to RISK-007 / `VaultProviderTokenSource`:** this is a **gate, not closure**. `VaultProviderTokenSource`
  (PR #198) stays fail-closed; this seam is the runner side of the same future path. RISK-007 stays OPEN.
- **Test evidence:** `runner-ingest-entrypoint.test.ts` — the enable guard is always false (incl. opt-in set); `run()`
  always fails closed with `disabled` and leaks no input/token; `validateRunnerIngestRequest` returns each safe static
  reason; a `MUSTNOTLEAK` request field never appears in any result; the module's ONLY import is a single TYPE import
  from the committed harness (so no value from the vault/runner/KMS/AWS layer is imported/instantiated). The three
  boundary scans pass; `check-no-real-tokens`/`check-auth-safety` unchanged-green.
- **What remains before `VaultProviderTokenSource` can be real (RISK-007 closure):** the conforming hosted runner built
  as a **separate deployable** that vendors the core byte-identical (doc 46 §11) on **ECS/Fargate one-shot + Secrets
  Manager task-read** (doc 46 §12); **production/staging KMS + IAM provisioned and VERIFIED** by a live round-trip +
  executed AccessDenied negative (doc 42 §91 / doc 44 §0); the **doc 44 §5 first-real-token staging dry-run** (17
  executed-proof items); a **reviewed `connector_runner_login` provisioning** (staging-only, doc 45); the **doc 45 B2c-run
  first-real-token runbook** executed with explicit GO; then the runner-backed vault source wired behind a future approved
  production-credential-ready flag. **RISK-001/RISK-007 remain OPEN; cutover BLOCKED; not customer-production-ready.**

## PR 13 — separate hosted connector runner DEPLOYABLE skeleton (`runner/connector-runner/`, fail-closed)
Implements the PR #199 typed runner seam as a **structurally separate, in-repo deployable skeleton** — disabled,
fail-closed, **pg/AWS/KMS-free**, loads no real secret. **RISK-007 stays OPEN.** No real token/OAuth/KMS-decrypt/Secrets-
Manager/Postgres, no production deploy, no production env, no service-role.
- **§11 decision (recorded):** doc 46 §11.4 required a new explicit decision for any in-repo runner; PR #200 records it
  in **doc 46 §14** — the runner SKELETON now lives in-repo, EXTENDING §11 while preserving its hard line (no `pg`/AWS in
  the app; the app stays pg-free; production runner repo-separation still per §11).
- **Runner location:** `runner/connector-runner/` (a top-level directory, **outside `src/`**) — its own `tsconfig.json`,
  `npm run runner:typecheck` (independent compile, run in CI) and `npm run runner:test` (independent test run). Excluded
  from the app build (root `tsconfig.json` `exclude`).
- **Separate from the app runtime:** the app `src/` **never imports the runner** (enforced by
  `scripts/check-app-runtime-imports.sh`, now also scanning `runner/`); the runner **vendors** the typed contract
  (`src/contract.ts`, self-contained — no app-`src/` import), mirroring doc 46 §11.2.
- **What it implements (from the PR #199 seam):** `ConnectorRunner.run(request)` → a redacted `RunnerResult`
  (`{ok, secretId|reason, provider}`); a **non-secret** `RunnerRequest` (provider/tenant/connector/purpose/secretKind/
  appEnv/version + optional `requestId`; no plaintext); `validateRunnerRequest`; `isConnectorRunnerEnabled` (allowlist,
  **always false** — `productionRunnerProvisioned` hardcoded false); `createConnectorRunner` (fail-closed: `run()` always
  returns `{ok:false, reason:"runner_disabled"}`); a safe `main()` (prints a static line, exits 1).
- **Still disabled / why no real secret:** the real ingest (Secrets-Manager-read plaintext → `ingestClientSecret` →
  `runSequence`) needs the production runner host + provisioned/verified KMS-IAM + the first-real-token dry-run — none
  exist. The skeleton must NOT gain `pg`/AWS until that decision (§11.1/§11.3) + RISK-007 closure.
- **No secret access (§6):** the runner imports NO AWS SDK / KMS / Secrets-Manager / pg / vault reader / fs secret
  writer — types only. Enforced by `check-app-runtime-imports.sh` (scans `runner/` for forbidden imports) + the runner's
  own static self-test.
- **No new dependency:** uses the root's `typescript`/`vitest`; no AWS/pg deps added.
- **Test evidence:** `runner/connector-runner/src/entrypoint.test.ts` — runner disabled by default; unsupported
  provider/purpose + missing tenant/connector rejected with safe reasons; request can't enable; no token/secret in
  output or errors; the runner imports nothing from pg/AWS/KMS/Secrets-Manager/app-`src/` (static); `main()` exits 1.
  The boundary scan's selftest covers app→runner and runner→forbidden-import cases. `runner:typecheck` proves
  independent compilation.
- **What remains before RISK-007 can close:** the real hosted runner deploy (ECS/Fargate one-shot) · Secrets Manager
  task-read · production KMS/IAM provisioned + verified · first-real-token staging dry-run (doc 44 §5) · B2c-run runbook
  (doc 45) · reviewed `connector_runner_login` provisioning · real runner-backed `VaultProviderTokenSource`.
  **RISK-001/RISK-007 remain OPEN; cutover BLOCKED.**

### Remaining PRs after PR 4
- **PR 5** — UI display of synced Slack data. **PR 6** — manual server-only run trigger. **Later** — scheduler / run
  lifecycle. **Later** — OAuth/vault/runner production credential path (RISK-007). The concrete Supabase store impl for
  the resolver is also a near-term wiring step.

### Constraints carried by PR 1
- The dev-token source is for **local development proof only** and is **structurally disabled outside local/dev**.
- It **must be removed or replaced** by the OAuth/vault/runner source **before any production connector use**.
- PR 1 adds **no** Slack API client, **no** Slack call, **no** OAuth, **no** runner/Fargate/KMS/IAM, **no** customer
  credential, **no** real token. **RISK-001 / RISK-007 remain OPEN; cutover BLOCKED.**
