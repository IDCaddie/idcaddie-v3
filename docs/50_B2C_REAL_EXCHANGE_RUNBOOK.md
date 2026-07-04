# 50 · B2c real OAuth-exchange runbook (RUN GATE A)

**Status:** the real-exchange path is **wired + synthetic-tested**, **GATED OFF**, and **NOT YET RUN**. The first real
token exchange (B2c-run) is a **separate, explicitly-Sam-approved** step. RISK-007 remains **OPEN**; Phase C remains
**BLOCKED**; real connector-credential storage/use stays **not allowed** until closure.

## What is wired (this PR — synthetic only)
`src/lib/server/connector-vault/oauth-real-exchange-wiring.ts` assembles the real dependency seams behind an explicit
gate — it performs **no** real OAuth call, KMS decrypt, DB read, or secret read; it only composes:
- **Durable replay gate** — the orchestrator now calls an optional `pendingConsume(payload)` after validation and before
  the exchange; the wiring backs it with the DB atomic `oauth_pending` single-use consume. A replayed/reused state fails
  closed **before** the code is presented. (Synthetic-tested: a second use of the same state → `already_consumed`.)
- **Client-secret decrypt boundary** — the app-level client secret is decrypted **only inside** `withSlackClientSecret`
  (runner decrypt capability + KMS + `connector_app_secrets`, buffer-wiped after use); it never returns to UI/request.
- **Real HTTP client** — the Slack `oauth.v2.access` call goes through the injected `SlackHttpClient` (no global `fetch`).
- **Envelope-only store** — the resulting token is handed to `b1StoreHandoff` → `connector_secrets`, encrypted envelope
  only, tenant/connector/version-scoped; the orchestrator never sees the token; the result is a redacted ref.

## The gate (fail-closed, default OFF)
`isRealExchangeEnabled(env)` returns true **only** when `CONNECTOR_OAUTH_REAL_EXCHANGE_ENABLED=1` **and** the environment
is non-production. `makeRealOrchestratorDeps` **throws** unless the gate is on. The agent and CI never set the flag.

## Operator pre-flight launcher (INERT — built, not the run)
`scripts/run-gate-a-b2c-real-exchange-launcher.mjs` (npm: `run-gate-a:preflight:selftest`) is the guarded operator
pre-flight for RUN GATE A. It **assembles nothing and runs no exchange** — its sole import is `node:fs`, it never calls
Slack, never builds an authorize URL, never reads a secret/code/token/DB URL, and never imports the real-exchange wiring.
It **refuses** unless: the linked Supabase ref is exactly `ycdpzduxugdsffjqyoai` (prod `dzbfxulvxchdemcettrx` hard-blocked),
`CONNECTOR_OAUTH_REAL_EXCHANGE_ENABLED=1` in a non-production env, `--confirm="RUN B2C FIRST REAL TOKEN STAGING"`,
`--app-env=staging`, `--redirect-uri` equal to the exact staging callback URI, and **no** client secret / bot token /
OAuth code / DB URL / password in argv or env (refused and never echoed); then it emits the procedure. §5's correlation
seam is now **enforced explicitly**: `makeReplayConsume` guards a non-empty `payload.corr` and uses it as the
`oauth_pending.state_jti` single-use key, so an empty/mismatched correlation fails closed (`correlation_missing`/`not_found`)
before any exchange. **This launcher is the pre-flight only — RUN GATE A remains PENDING and has not been run.**

## Prerequisites for a real run (ALL required, in order)
1. **Explicit Sam GO** — a real run is not implied by any prior approval. It is its own decision.
2. **Disposable Slack DEV workspace ONLY** — never a customer/production Slack workspace. The connector app is a throwaway
   dev app; its client secret is ingested to **staging** `connector_app_secrets` via the existing stdin-only ingest.
3. **Staging only** — staging Supabase ref `ycdpzduxugdsffjqyoai`; production ref `dzbfxulvxchdemcettrx` must not be touched.
   The ingest/prod guards + `isRealExchangeEnabled` all hard-block production.
4. **The KMS/IAM separation is verified green** (docs/49) and the `connector_runner_login` chain is provisioned
   (migration 0039) before any decrypt/store.
5. **Authorize front-half + `oauth_pending` provisioning** — run the authorize preparer `prepareRunGateAAuthorize`
   (`src/lib/server/connector-vault/run-gate-a-authorize.ts`, staging-only, injected signer + runner-backed inserter, no
   Slack call) to persist the single-use `oauth_pending` row and emit the aligned triple: the **authorize URL** (open it on
   the DEV workspace), the signed **`state`** (→ `CONNECTOR_OAUTH_CALLBACK_STATE`), and the **expectedContext env** (tenant/
   connector/subject/**correlation**). The persisted `oauth_pending.state_jti = corr`, which is the exact key the runner
   consume (`makeReplayConsume`) matches on — pinned by the `run-gate-a-authorize` integration test (authorize→consume:
   found, then replay/mismatch fail closed). Do not hand-assemble the state/row/env; the preparer emits them aligned.

## Expected evidence (record in a docs-only PR — never a secret)
- The redacted store ref (`secretId`) + the envelope columns being ciphertext (no plaintext).
- The audit rows: `connector_secret.store.attempted` → `store.succeeded` (the atomic store audit).
- A **replay attempt** returning `already_consumed` (fail-closed proof).
- PASS/FAIL only — never the token, client secret, code, DB URL, or key material.

## What NOT to run
- No production. No customer Slack workspace. No `get-secret-value` of a real customer secret.
- Do not set `CONNECTOR_OAUTH_REAL_EXCHANGE_ENABLED=1` in CI or any shared/production environment.
- Do not treat a green run as RISK-007 closure — audited access/use, rotation/revocation, and the full lifecycle remain.

## After the run
RISK-007 remains **OPEN** (a first-token run is evidence, not closure); Phase C remains **BLOCKED** until the documented
closure criteria (audit + rotation/revocation + lifecycle + separation evidence) are all met and reviewed.
