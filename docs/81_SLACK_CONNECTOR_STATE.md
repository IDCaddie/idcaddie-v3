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
| **Callback route** | **REAL (handoff) / SYNTHETIC (elsewhere)** | Phase 8K: under the staging environment identity the route validates the state, **seals the authorization code to the completion worker's public key**, hands it off over Vercel OIDC, and redirects to a truthful pending page. It never claims "Connected" — it cannot, because it does not do the exchange. The synthetic handler remains only for environments the identity gate refuses. **The worker does not exist yet, and the worker-host allowlist is empty in code, so the real path fails closed today.** See the Phase 8K note below and doc [83 §8](83_REAL_OAUTH_COMPLETION_ARCHITECTURE.md). |
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

### Phase 8E — what is built, and the one thing that still blocks it

Built and tested (`oauth-callback-real-runner.ts`, `oauth-callback-real-runner.test.ts`):

- **Workspace binding.** `oauth.v2.access` returns the team the user actually consented on — the authorize URL cannot
  pin it, so the response is the only place the answer exists. The exchange now compares `team.id` (never the name)
  against server-trusted config and refuses **before the store handoff**, so a wrong-workspace token never reaches the
  vault. Unset config is a refusal, not a wildcard.
- **Exact callback allowlist.** `REDIRECT_RE` constrains the shape but accepts any host, and the redirect URI is what
  the client secret and the authorization code get posted against. Whole URIs are now compared as strings — not hosts
  parsed out of the value, because `connector-oauth-config.test.ts` asserts this module never contains `.host`, and
  that guard exists precisely because the one mistake this file must never make is trusting a request Host header.
- **Fail-closed assembly.** Real mode requires an explicit opt-in, refuses in production, and has **no default** for
  the workspace, tenant, connector, correlation, client id or callback. Every refusal is a bounded static reason that
  carries no env value, host or id.
- The expected context follows the RUN GATE A model: operator-supplied server-trusted values, the same triple the
  authorize half persisted into `oauth_pending`, re-checked by the atomic consume.

**The blocker is not code.** `withSlackClientSecret` needs a `ConnectorVaultKeyProvider` (AWS KMS) and
`createRunnerAppSecretStore` needs a `RunnerConnection` — i.e. the **runner's `connector_runner_login` DB identity and
AWS KMS credentials, in the Vercel request path**. That is exactly the boundary crossing this document says needs its
own GO, and it is a credential-provisioning decision, not an implementation detail. Until those exist on the staging
deployment, `buildRealCallbackRunner` has no deps to be handed and the route correctly stays synthetic.

The route is deliberately **not** switched in this phase: flipping it while the real deps cannot be constructed would
mean either a silent fallback to synthetic (forbidden) or a route that always 500s.

## Hosted staging state

The Slack connector `1575cde3…` is **disconnected** (Phase 5B demo disposition, deliberate). Two active `oauth_access` secrets
remain from 2026-07-05; whether the token is still valid at Slack is **unverified** — it has not been exercised since.

## Update — Phase 8K (the handoff)

**Boundary 1 is closed, in the shape doc 83 §2 corrected to.** `/connectors/oauth/callback` no longer imports the
synthetic handler on the real path. Under the staging environment identity it runs `handleHandoffCallback`, which:

1. validates the signed state against server-trusted context, **before** the authorization code is touched;
2. seals the code to the completion worker's X25519 public key (`node:crypto`, no KMS, no new dependency);
3. builds the canonical protocol-v2 body and presents a Vercel OIDC assertion obtained from the platform's request
   context and exchanged for the dedicated worker audience (Phase 8R — doc 83 §8.4; it is **not** read from the
   environment, which is the build/local-dev path);
4. posts once to the pinned worker path and accepts only a two-word acknowledgement;
5. redirects to `/connectors/oauth/pending`, which reads `product_oauth_completion_job_status` and nothing else.

The Phase 8E blocker is gone by construction rather than by provisioning: `withSlackClientSecret` and
`createRunnerAppSecretStore` are **not on this path at all**. V3 needs no KMS grant and no database identity for
completion, and an architecture test asserts it cannot acquire one by accident.

**What still blocks a live run** — none of it code in this repository except the last line:

- the completion worker itself (PR 4), holding the private sealing key and `OAUTH_COMPLETER_DB_URL`;
- the worker's deployed host, its OIDC audience and Vercel federation, and both KMS keys;
- the Slack redirect registration;
- a reviewed change adding the worker host to `WORKER_ALLOWED_HOSTS`, which is **empty in code** so the real path fails
  closed until then.

`oauth-real-exchange-wiring.ts` and `oauth-callback-real-runner.ts` still have zero non-test callers and are left in
place: they are the lineage the runner vendors from, not dead app code. Nothing in the callback path can reach them, and
the architecture test is what says so.
