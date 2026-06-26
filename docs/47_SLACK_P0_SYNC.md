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
agent does NOT run it. **PR 2's live verification is DEFERRED until run locally; PR 3 (discovery-fact emitter) must NOT
start until the real field-path report is produced and reconciled.** Exact command:
```
NODE_ENV=development ID_CADDIE_DEV_PROVIDER_TOKEN_SOURCE_ENABLED=1 ID_CADDIE_DEV_SLACK_TOKEN=<dev-bot-token> \
  node scripts/verify-slack-field-paths-dev.mjs
```
(Mint a read-only bot token in the **disposable** Slack test workspace with scopes `users:read` + `users:read.email`;
set it locally only; report only the safe output.)

### Constraints carried by PR 1
- The dev-token source is for **local development proof only** and is **structurally disabled outside local/dev**.
- It **must be removed or replaced** by the OAuth/vault/runner source **before any production connector use**.
- PR 1 adds **no** Slack API client, **no** Slack call, **no** OAuth, **no** runner/Fargate/KMS/IAM, **no** customer
  credential, **no** real token. **RISK-001 / RISK-007 remain OPEN; cutover BLOCKED.**
