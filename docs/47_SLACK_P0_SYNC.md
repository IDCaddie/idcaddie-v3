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

### Constraints carried by PR 1
- The dev-token source is for **local development proof only** and is **structurally disabled outside local/dev**.
- It **must be removed or replaced** by the OAuth/vault/runner source **before any production connector use**.
- PR 1 adds **no** Slack API client, **no** Slack call, **no** OAuth, **no** runner/Fargate/KMS/IAM, **no** customer
  credential, **no** real token. **RISK-001 / RISK-007 remain OPEN; cutover BLOCKED.**
