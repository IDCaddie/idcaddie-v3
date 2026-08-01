# 81 · Slack Connector — State of Completion

**Canonical source for: what is real, what remains synthetic, and the exact remaining work.** Phase 8.

## Stage classification

| Stage | Class | Why |
|---|---|---|
| Slack app, redirect URL, scopes, workspace | **REAL** | External; exists per operator. Not verifiable from the repo. |
| Authorize URL + `oauth_pending` issue | **REAL** | `slack-authorize-pending.ts`, state signed and bound. |
| State generation / consume / replay denial | **REAL** | Hosted-proven: a replay returned `already_consumed` (docs/52 row 9). |
| `oauth.v2.access` exchange | **REAL** | `slack-oauth-exchange.ts` — injected HTTP client, no global fetch. Ran once for real (RUN GATE A, 2026-07-04). |
| Real exchange wiring | **REAL but UNUSED** | `oauth-real-exchange-wiring.ts` assembles every real seam behind `CONNECTOR_OAUTH_REAL_EXCHANGE_ENABLED`. **Zero non-test callers.** |
| **Callback route** | **SYNTHETIC** | `/connectors/oauth/callback` imports `handleSyntheticSlackOAuthCallback`; production-disabled. **This is the remaining OAuth boundary.** |
| Secret storage | **REAL** | Envelope (KMS-wrapped DEK + AEAD). Three real `oauth_access` rows for the Slack connector; RUN GATE B proved rotation + revocation. |
| Verification (`auth.test`) | **REAL** | Manifest endpoint; decrypt/use proven against live Slack (docs/52 row 7). |
| Discovery manifest | **REAL** | `slack.v1.json`: bearer auth, 18 rps / burst 5, 500-request / 100k-item / 600s budget, cursor pagination (`max_pages` 200), field maps, scopes. |
| Discovery executor | **REAL** | Generic, rate-limited, budgeted, buffered — flushes only on full endpoint success. |
| **Fact sink** | **SYNTHETIC** | In-memory only. "Facts go only to the injected in-memory sink." **No DB writer exists.** |
| Canonical persistence | **BUILT (Phase 8)** | Migration 0076 — see below. Was previously **MISSING**. |
| Home / SaaS / App Accounts / Sync Health / Findings | **UNUSED** | Nothing to render until the sink writes. |

## What Phase 8 added

**Migration 0076** — canonical, **provider-agnostic** app-account evidence:
`app_accounts` · `app_account_groups` · `app_account_group_memberships` · `app_account_identity_matches` ·
`connector_capability_state`.

Provider-agnostic on purpose: the manifest already emits generic `app_user_account` / `group` facts, as do the Okta and Entra
normalizers. Slack-specific tables would defeat Phase 7B.

Design rules carried forward from earlier phases rather than rediscovered:
- **No FK to `identity_accounts`, in either direction.** A Slack member is evidence, not a person.
- **Composite endpoint FKs** (0056/0059/0072) — an edge can only reference its own connector's rows.
- **The 0070 invariant from the start** — a `current` row carries no `stale_since`.
- **No raw provider status** — bucketed to `active|inactive|deleted|unknown`, the lesson from Okta's `PROVISIONED`.
- **`account_kind`** separates `bot`/`service` from `human`, so a workspace of 40 never reports 55 users.
- **Matching has exactly two methods**, `manual` and `normalized_email`. There is no display-name method and it cannot be added
  without changing a CHECK.
- **`plan_dependent` / `permission_dependent`** are distinct capability states, so one gated endpoint never marks a healthy
  connector broken.

**Slack capabilities** are now declared from what the manifest actually reads: `app_accounts` and `roles` **implemented**;
`usage`, `licenses`, `activity` **planned** (Business+/Enterprise-gated, no scope requested); all directory capabilities
**not_applicable** — Slack is not an identity provider.

## Phase 8C progress

**Built:** `slack-http-client.ts` — the ONE concrete `SlackHttpClient`. Every other vault module takes the type injected and never
reaches the network, which is what has kept an accidental `slack.com` call out of the suite for eight phases. This is the single
file to review for network behaviour.

Containment properties, each enforced and mutation-tested rather than documented:
- **Host allowlist checked before the request is attempted** — rejecting after `fetch` would already have sent the secret.
  Covers suffix attacks (`slack.com.evil.test`), scheme downgrade, and other subdomains.
- **`redirect: "error"`** — a 30x on a token endpoint would forward the credential-bearing body wherever it points.
- **`cache: "no-store"`.**
- **The underlying network error is discarded, not wrapped** — fetch failures embed the URL and callers log errors. Only a static
  reason (`bad_host` / `network` / `timeout`) escapes.
- **The body is read once and closed over**, so `json()` is re-callable and cannot fail mid-exchange with a consumed stream.

**Not yet built:** the route that assembles `RealExchangeConfig` and calls the orchestrator. `makeRealOrchestratorDeps` needs
`expectedContext`, `signer`, `pendingConsumer`, `httpClient` (now available), `clientId`, `clientSecretDeps` (KMS provider +
envelope store) and `ingestDeps`. Concrete implementations exist for all of them.

## Remaining work, in order

1. **DB fact sink** in the runner — write `app_user_account` / `group` facts through SECURITY DEFINER promote RPCs, mirroring the
   Okta promote/stale pattern (completeness gate, latest-run guard, mass-stale circuit breaker).
2. **Promote/stale RPCs** for the 0076 tables.
3. **Replace the synthetic callback** with `oauth-real-exchange-wiring`. It is already assembled; it needs a caller and the
   staging flag. *This crosses the client-secret decrypt boundary in the request path and warrants its own explicit GO.*
4. **Product RPCs + surfaces** — App Accounts, Sync Health, matching review.
5. **Hosted run** — decrypt the existing token, `users.list` + `usergroups.list` against the controlled workspace.

## Update — Phase 8D (migration 0077)

Boundary 2 is **closed**. The executor's facts now reach the database: `saas-fact-rows.ts` splits envelope from payload,
`DiscoveryWriter.insertFacts` writes them batched through the 0041 function, and the five 0077 RPCs promote them into
`app_accounts` / `app_account_groups` behind a **per-resource** completeness gate. Full model in
[82](82_SAAS_EVIDENCE_WRITE_BOUNDARY.md).

**Boundary 1 remains open and deliberate:** `/connectors/oauth/callback/route.ts` still imports
`handleSyntheticSlackOAuthCallback`. `oauth-real-exchange-wiring.ts` still has zero non-test callers. Replacing it
crosses the client-secret decrypt boundary in the request path and needs its own GO.

So the write path is complete ahead of the thing that will feed it. A live sweep still needs the real callback wired
**and** a Slack-honoured token.

## Hosted staging state

The Slack connector `1575cde3…` is **disconnected** (Phase 5B demo disposition, deliberate). Two active `oauth_access` secrets
remain from 2026-07-05; whether the token is still valid at Slack is **unverified** — it has not been exercised since.
