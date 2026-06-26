# 44 — Connector Credential: Real-Token Threat Model & Implementation Gate

**Status: DESIGN GATE — not implementation.** This document is **docs-only**. It defines the exact safety
requirements, the single allowed first-real-credential path, the threat model, the evidence required, the
rollback/kill-switch plan, and the merge gates that **must** be satisfied **before any real provider token is
stored, decrypted, or used**. It implements nothing and grants nothing.

> **Posture (unchanged by this PR):**
> - **Real connector credentials remain BLOCKED.** No real provider token has entered the system.
> - **RISK-007 remains OPEN.** This doc does **not** close it; it refines the closure evidence (§5).
> - **RISK-001 remains OPEN. Cutover remains BLOCKED.** Connector credentials are **not production-ready**.
> - **This is a design gate, not implementation.** No code, no migration, no test, no real token.
> - **The first staging real-token dry-run (§5) IS the first real-token event.** It is **not synthetic** and must
>   be treated with the same care as production.

---

## 0. Current state this gate builds on (grounded facts, verified)

The synthetic vault is built and request-path-fenced. The threat model is anchored to these **actual** primitives
(PRs #160–#170; doc 42 §76–§87):

- **Two-role DB identity.** `connector_runner` is `NOLOGIN BYPASSRLS` (migration `0021`) — a privilege role like
  `anon`/`authenticated`, reached only by connecting as the LOGIN role `connector_runner_login` (LOGIN, NOINHERIT,
  **no** direct grants) and running `SET ROLE connector_runner` (`runner-db-client.ts`). Tenant isolation is by the
  query's `WHERE tenant_id = $1` (BYPASSRLS bypasses RLS; the vault tables are RLS-enabled deny-all).
  ⚠️ **GAP:** `connector_runner_login` is **not created by any committed migration** — it is a manual,
  staging-only provisioning step (doc 42 §46.1). The production login chain has **no versioned DDL**. *(See §2/§7
  prerequisite.)*
- **Column-scoped runner grants (no table-level, no UPDATE/DELETE on the secret tables):**
  - `connector_secrets`: SELECT (15 cols) + INSERT (12 envelope cols). **No UPDATE/DELETE** → append-only.
  - `connector_secret_lifecycle_events`: SELECT (5) + INSERT (8). **No UPDATE/DELETE** (append-only trigger).
  - `audit_logs`: INSERT (`tenant_id, action, resource_type, after_json`) only. Append-only trigger.
  - `oauth_pending`: SELECT + INSERT (9 authorize cols) + UPDATE (3 consume cols). No DELETE.
  - `anon`/`authenticated` (browser/request-path roles): **deny-all** on every vault table (RLS-enabled, zero
    policies, `revoke all`), re-asserted across `0017`–`0033`.
- **Envelope encryption.** Per-secret DEK (AES-256-GCM, 12-byte nonce, 16-byte tag, 32-byte DEK); the DEK is wrapped
  by a KEK held in **external KMS** (the KEK never leaves KMS). At rest = 8 columns: `ciphertext, dek_wrapped,
  aead_nonce, aead_tag, aad_digest, key_id, envelope_version, aead_alg`. AAD binds the ciphertext to
  `{tenantId, connectorId, secretKind, version}` → a row copied cross-tenant/kind/version **fails GCM auth on
  decrypt** (confused-deputy / replay defense). The plaintext DEK is transient and zeroed (`dek.fill(0)`).
- **Asymmetric encrypt/decrypt capability.** SAVE uses an **encrypt-only** key provider (only `generateDataKey`;
  `unwrapDataKey` always throws) → the request-initiated save path **structurally cannot decrypt**. DECRYPT requires
  an unforgeable module-private `RunnerDecryptCapability` **and** the runner's **KMS `kms:Decrypt` IAM grant** — the
  real cryptographic boundary. The web/request IAM identity does **not** hold `kms:Decrypt`, so it cannot unwrap a
  DEK even holding the ciphertext.
- **Audit is allowlist-built.** 15 events (`store/load/decrypt` + `revocation/tombstone` × `attempted/succeeded/
  failed`); `after_json` is EXACTLY 8 allowlisted keys (`event, connector_id, secret_kind, version, result,
  actor_type?, error_class?, correlation_id?`), built field-by-field (never spreads input), with a defense-in-depth
  value scan (`CREDENTIAL_VALUE_RE` rejects JWT/`xox*`/`gh*`/OpenAI-key shapes) and a 9-class static `error_class`
  allowlist. A credential-shaped value cannot reach an audit row.
- **Everything is inert.** There is **zero non-test caller** of `saveConnectorSecret`/`loadConnectorSecret`/
  `createRunnerConnectorSecretStore`, **no** real OAuth token exchange anywhere (no `fetch`, no `oauth.v2.access`),
  **no** KMS client bound in production (`kmsKeyProviderConfigFromEnv()` returns null unless env is set), and every
  registered provider is `enabled:false` (`isConnectorProviderReady` is false for **all**). The OAuth callback route
  returns inert `not_configured` (503) because `CONNECTOR_OAUTH_STATE_SECRET` is unset.
- **What is proven, and only synthetically.** Hosted-staging KMS/IAM decrypt-separation passed **synthetic-only**
  (doc 42 §82, 2026-06-24): the **hosted runner IAM identity** has `kms:Decrypt` on the staging KEK
  (`alias/idcaddie-staging-connector-vault`, `arn:aws:kms:ca-central-1:833822972703:key/…`, doc 42 §47.3), and the
  **web/request IAM identity** is denied. (The recorded runner principal in the §47 dry-run is the EC2 assumed role
  `idc-runner-role`; the specific staging IAM profile names are an operational detail, not pinned by this doc.) The
  store-adapter DB shape passed synthetic (doc 42 §80). **No real token has ever entered any of these paths.**
- **Reconciled staging KMS/IAM (doc 42 §91, 2026-06-25 — IAM-side policy fix, simulation-proven; live B2 NOT run).** The
  **current local B2 path is IAM-user based**: runner `idcaddie-staging-runner` (inline policy `kms-runner` grants only
  `kms:GenerateDataKey` + `kms:Decrypt` on the **canonical** KEK `alias/idcaddie-staging-connector-vault` →
  `…key/a1b7eaa9…`; **no** `kms:Encrypt`/`DescribeKey`/wildcard) and web `idcaddie-staging-web` (**denied** `kms:Decrypt`,
  `explicitDeny` — the denied-decrypt half, preserved). A superseded key `…key/5c6fd833…` exists and is **not** the
  B2c-run KEK. The EC2-role evidence is historical; the live KMS round-trip + denied-decrypt proof are still pending.
  Production KMS/IAM separation is **unverified**.
- **Fargate + Secrets Manager task-read ingestion (doc 46 §12, 2026-06-26 — SPEC, not built).** The Phase C runner is an
  **ECS/Fargate one-shot** task that ingests the client secret via **AWS Secrets Manager task-read (Model B)**, not ECS
  Exec stdin (Exec session logging could capture the master credential). **New secret-at-rest surface:** the plaintext
  client secret sits in a **staging-only** Secrets Manager secret (`/idcaddie/staging/slack/oauth-client-secret`,
  KMS-encrypted at rest) from the operator's one-time Console write until **post-ingest cleanup** (disable → prove
  unreadable → delete). Contained by: task role reads **only** that ARN (no `secretsmanager:*`); web/request identity has
  **no** read + stays `explicitDeny` on `kms:Decrypt`; the task passes plaintext **directly** to `ingestClientSecret`
  (in-memory, no disk/log/env — the committed core is unchanged); CloudTrail logs the access with **no** plaintext. The
  secret must not outlive the run. Nothing here is built; **no real secret has entered Secrets Manager.**

---

## 1. First real credential

**Decision: the first allowed real credential is a Slack bot OAuth access token (`xoxb-…`) issued for a dedicated,
disposable, non-production Slack workspace + app.** Slack is the furthest-along provider (the only one with a
dedicated modules, `providers/slack-oauth.ts` + `providers/slack-authorize-pending.ts`) and a Slack bot token is
source-revocable, which is mandatory below.

| Attribute | Value |
|---|---|
| **Provider** | Slack |
| **Credential kind** | OAuth bot access token (`xoxb-…`) |
| **Token type** | **Access token** (bot token). NOT a refresh token, NOT a raw OAuth authorization code, NOT a long-lived API key. The OAuth `code` is exchanged **once** server-side and never stored. |
| **Source of credential** | Slack's `oauth.v2.access` token endpoint, called **once** server-side (runner identity) during the §2 ingestion, in exchange for a one-time authorization `code` from the Slack OAuth consent flow. |
| **Who/what may submit it** | **No human ever submits/pastes the token.** A workspace admin of the **disposable dev workspace** completes the Slack consent screen; the `code` returns to the server-only callback; the **runner** performs the one-time exchange. Manual token paste is forbidden (§2). |
| **Short- vs long-lived** | **Long-lived** (a non-rotating Slack bot token does not expire). Acceptable **only because it is source-revocable** (below). Token rotation (short-lived + refresh) is deliberately **NOT** enabled for the first credential. |
| **Refresh** | **OUT of scope.** Token rotation is not enabled, so there is no refresh token to store/handle. |
| **Rotation** | **OUT of scope.** No rotation helper exists (the audit allowlist deliberately rejects `rotation` events). Revocation/tombstone (Model B, PR #170) is the only lifecycle write that exists. |
| **Scopes / privilege** | **Lowest possible, read-only** (e.g. a single `channels:read`/`team:read`). No write/admin scopes. The dev workspace contains **no** real organizational data. |

### Source-revocability (mandatory)

The first real credential **must be invalidatable at the provider source**, not only tombstoned locally:

- **Provider-side revocation mechanism:** Slack `auth.revoke` (revokes the specific token) **and** removing/
  uninstalling the app from the workspace (App Management → *Remove App*) invalidates all of the app's tokens.
- **Who may execute provider-side revocation:** an **admin/owner of the disposable dev Slack workspace** (or anyone
  holding the token, via `auth.revoke`). The named operator is recorded in the §5 evidence + §6 runbook.
- **Expected time to provider-side invalidation:** effectively immediate — `auth.revoke` invalidates the token on
  the next API call; app removal invalidates all tokens at once. The §5 dry-run **must verify** invalidation by
  observing a post-revocation API call fail with `token_revoked`/`invalid_auth`.

> **Gate:** if the provider-side revocation path is ever **not known or not available** for a chosen first
> credential, **real credential use remains BLOCKED**. The Slack `auth.revoke` + app-removal path above satisfies
> this; PR B must re-confirm it against the live Slack API console before any real token is stored.

> The first credential **is** decided (above). It nonetheless stays blocked until the §5 evidence is produced and
> signed off — this section defines the target, not an authorization to ingest.

---

## 2. Allowed ingestion path (the ONLY path)

The first real credential may enter **only** via this path. Anything else is out of scope and forbidden.

> **Build split (§7).** This path is built in two PRs without ever weakening the no-human-handling property:
> **B1** builds the **store/encrypt half** (the guards + atomic encrypt-immediately + store + audit) and proves it
> **with synthetic sentinel values only** — no real token, no operator/admin-console paste, no OAuth exchange, no
> Slack API call, no callback route. **B2** builds the **token-source half** — the server-side `oauth.v2.access`
> exchange below, where the token is **born inside the trusted server/runner path and immediately encrypted**, so
> **no human ever sees/copies/pastes/submits it**. The **first real-token event happens only in B2**, as a
> separately authorized run (§5/§6). The token-source rows below describe the **B2** path; they are NOT a
> human-paste path and must never be weakened to one.

| Concern | Requirement |
|---|---|
| **Caller identity** | The server-only OAuth **callback route** (`src/app/(authenticated)/connectors/oauth/callback/route.ts`), reached after the dev-workspace admin completes Slack consent. The browser only carries the opaque, HMAC-signed `state` + the one-time `code` in the redirect — never a token. |
| **Server/runtime identity** | A **server-only** Next.js route handler / server action (never a `"use client"` component, never the browser). The HMAC state signer must be configured (`CONNECTOR_OAUTH_STATE_SECRET`) so the callback is no longer inert. |
| **Runner identity** | The **one-time token exchange** (`oauth.v2.access`) and the **encrypt + store** run under the **runner** (`connector_runner_login` → `SET ROLE connector_runner`), using the **encrypt-only** key provider. The request/web identity performs **no** crypto and holds **no** `kms:Decrypt`. |
| **Encryption path** | `encryptConnectorSecret` → envelope (per-secret DEK via KMS `GenerateDataKey`, AES-256-GCM, AAD = `{tenant, connector, secret_kind, version}`), then `insertEncryptedSecret` (atomic `set role`/`begin`/INSERT/`store.succeeded` audit/`commit`). Only the **wrapped DEK + ciphertext** are persisted. |
| **KMS key** | The KEK in external KMS (staging: `alias/idcaddie-staging-connector-vault`). The KEK never leaves KMS; the runner's IAM identity calls `GenerateDataKey` on store. |
| **Tenant binding** | `tenant_id` is bound in the row, the query `WHERE`, **and** the AEAD AAD — a row read under the wrong tenant fails GCM authentication. The dev-workspace credential is stored under a **dedicated staging tenant**. |
| **Connector binding** | `connector_id` + `secret_kind` are bound in the row and the AAD; the secret is loadable only for that exact connector/kind/version. |
| **Audit requirements** | `store.attempted` → (atomic) row + `store.succeeded`, or `store.failed` — via the allowlist builder only (`secret-audit.ts` `buildConnectorSecretAuditEvent`; the 8-key allowlist + `CREDENTIAL_VALUE_RE` value scan, §0 + doc 42 audit sections). **Fail-closed:** the secret row commits **only if** its `store.succeeded` audit commits (PR #167 atomicity). |
| **Lifecycle / version** | Append-only: a new credential is a new `version`; revoke/tombstone is an INSERT into `connector_secret_lifecycle_events` (Model B). No UPDATE/DELETE of `connector_secrets`. |
| **Failure behavior** | Any failure (exchange error, KMS error, audit failure) is **fail-closed**: no secret row without its audit, no plaintext logged, the operation throws a **static** error (no raw provider/KMS error echoed). |

### Plaintext lifetime trace (the deliverable)

The forbidden list below is necessary but **not** sufficient. This is the **positive** journey of the plaintext
token — where it exists, who sees it, and exactly where it dies:

1. **First plaintext existence — at Slack, then in the one-time exchange response.** The token does **not** exist in
   plaintext anywhere in our system until the runner calls `oauth.v2.access` (over TLS) and receives the response
   body. The browser and the request URL **never** carry the token (the redirect carries only `state` + one-time
   `code`).
2. **Transport protection.** The Slack consent redirect (browser↔Slack), the callback (browser↔our server), and the
   token exchange (our runner↔Slack) are **all TLS**. The `code`→token exchange is **server→Slack only**.
3. **Runtime that receives plaintext.** Only the **server-only runner runtime** (the route handler / server action
   executing the exchange) ever holds the plaintext token, as a local in-memory `string`/`Buffer`.
4. **Memory buffers that may contain plaintext.** (a) the HTTPS response body buffer from `oauth.v2.access`; (b) the
   parsed token `string`; (c) the `plaintext` arg to `encryptConnectorSecret`; (d) the transient AES-GCM input. The
   transient **DEK** is zeroed (`dek.fill(0)`); the plaintext **token** is dropped (de-referenced) at step 6 but is
   **not** wiped (see step 7's residual-exposure note).
5. **The exact plaintext→ciphertext point.** `encryptConnectorSecret({ plaintext, context, keyProvider, kekId })`
   produces the AEAD ciphertext + wrapped DEK and **returns the ciphertext envelope** (`EncryptedConnectorSecret`).
   After this call returns, **only ciphertext leaves the function** — no plaintext.
6. **The exact plaintext-discard point.** Immediately after `encryptConnectorSecret` returns the **ciphertext
   envelope** (no plaintext), the local plaintext token goes out of scope (no field, no return, no log) and is
   eligible for GC. Each store-boundary return is **redacted**: `saveConnectorSecret` returns a `SavedSecretRef`
   (`{ secretId, tenantId, connectorId, secretKind, version, kekId }` — no ciphertext, no wrapped DEK), and the
   low-level `insertEncryptedSecret` returns only `{ id }`. **Plaintext is on NONE of these return paths**; nothing
   downstream (DB, audit, response) holds it.
7. **What bounds the plaintext lifetime.** No reference to the plaintext is retained after the encrypt call — no
   field, no return, no log, no queue, no external hop — so it becomes **unreachable** once the call chain unwinds.
   **Residual exposure (stated, not hidden):** unlike the DEK (zeroed via `dek.fill(0)`), the plaintext token
   `Buffer`/`string` is **NOT** wiped — a JS `string` cannot be overwritten in place — so the bytes remain reachable
   in the V8 heap until **non-deterministic GC**, which can **outlive** the request handler's stack frame. The true
   bound is therefore *"no live reference + unreachable after the call,"* **NOT** a guaranteed in-memory wipe.
   *(Hardening for PR B: carry the token as a `Buffer` and `fill(0)` it immediately after encrypt; the unavoidable
   immutable-string copy is the minimized-but-nonzero residual to accept explicitly.)*
8. **What guarantees non-persistence.** (a) `insertEncryptedSecret` writes only the 12 envelope columns — there is
   **no** plaintext column and no runner grant to write one; (b) the audit builder's 8-key allowlist + value scan
   cannot carry a token; (c) the store/load adapters return only a **redacted ref** (`SavedSecretRef` / `{ id }`) or
   the **encrypted** envelope — never plaintext; (d) request/web identity holds no `kms:Decrypt`, so even the
   ciphertext is unreadable off the runner.
9. **How to verify plaintext was not logged or stored.** The §5 dry-run + §6 inspection: grep the server/function/
   DB logs, tracing, and error-monitoring for the token's distinctive `xoxb-` prefix (and a hash of the token) and
   confirm **zero** hits; confirm the DB row holds an envelope only (no plaintext); confirm no analytics/tracing
   span carries it; confirm the token is absent from shell/command/browser history, clipboard, and screenshots.

### Forbidden in the ingestion path (necessary, not sufficient)

- ❌ **Browser-side token handling** (the browser must never see the token; only `state`+`code` transit it). *Not
  justified or risk-accepted for the first credential → forbidden.*
- ❌ Request-path decrypt; ❌ service-role secret write/read/decrypt; ❌ any log line containing token material.
- ❌ Manual token paste into the DB; ❌ token in env vars; ❌ token in docs; ❌ token in local shell/command history;
  ❌ token in PR comments; ❌ token in test fixtures; ❌ token in screenshots; ❌ token in issue comments;
  ❌ token in analytics / error monitoring / tracing.

### B2 OAuth — three secrets, traced separately (design; the implementation lands in B2a–B2c — doc 42 §90)

The steps above trace the **Slack bot token**. The B2 OAuth path introduces **two more** sensitive values that must
each be traced separately:

- **Authorization `code` (request-path, one-time).** Arrives as a **query parameter** on the callback URL. It is
  read once into a local in the server-only callback handler, used only to (a) validate + bind the signed state
  (§2 binding / doc 42 §90.2) and (b) hand to the server-side exchange; then discarded (no field/return/log). It is
  **not** the token, but it is one-time exchangeable. **Risk surface:** query strings can leak via proxy/platform
  **access logs**, **browser history**, and **`Referer`** headers — so the callback must be treated as sensitive and
  the query **stripped immediately** (a 303 redirect to a clean path) and the access-log surface enumerated (doc 42
  §90.5; the §5 OAuth-evidence sub-block). It is **never** logged, stored, echoed, audited raw, returned to the browser, or retried after a
  possible Slack consume (single-use). Live reference dropped at the end of the exchange call chain (V8-heap residual
  as in step 7 — not a hard wipe).
- **Slack client secret (vault-grade — doc 42 §90.3).** It exists in plaintext **only** transiently inside the
  server-side exchange: the runner reads it from the **KMS-backed vault-grade store** (never a plaintext env var),
  uses it to sign the `oauth.v2.access` POST, and drops the live reference when the exchange returns. Only the runner
  process reads it; it is **never** logged, echoed into errors, traced, or sent toward the browser. Its lifetime is
  bounded to the single exchange call; like the token, the JS reference is dropped (V8-heap residual documented, not
  wiped). Evidence (§5, OAuth sub-block) must prove it is vault-grade + not in a plaintext env before the first real exchange.
- **Slack bot token** — born in the `oauth.v2.access` response (server-side runner only); encrypted immediately via
  the existing vault path; traced in steps 1–9 above.

---

## 3. Allowed decrypt / use path

**Real decrypt/use remains BLOCKED by this gate.** Storing the first real credential (PR B) does **not** authorize
decrypting or using it; that is a **separate** PR (PR C) behind its own evidence.

When later allowed (PR C), the decrypt/use path **must**:

- be reachable **only by the runner identity** holding both the module-private `RunnerDecryptCapability` **and** the
  KMS `kms:Decrypt` IAM grant;
- have **no** web/request-identity decrypt (the request path holds no `kms:Decrypt` and the save provider is
  encrypt-only — both already true);
- have **no** service-role decrypt path;
- expose **no** route/endpoint that returns a decrypted token (a connector uses the token server-side; it is never
  returned to a client);
- emit `decrypt.attempted/succeeded/failed` audit (allowlist only) and place **no** token material in any log.

Until PR C ships and is verified, `decryptConnectorSecret`/`loadConnectorSecret` stay caller-less in production.

---

## 4. Blast-radius analysis

| Scenario | Outcome |
|---|---|
| **Web/request identity compromised — can it decrypt?** | **No.** It holds no `kms:Decrypt`, the save provider is encrypt-only, and it has deny-all (RLS + `revoke all`) on the secret tables. It cannot read the ciphertext, and could not unwrap the DEK even if it did. |
| **Service role compromised — what can it read/write?** | The vault deliberately uses **no** service-role secret path. Service role is not granted `kms:Decrypt` and is not part of the runner identity; it must never be wired to the secret tables. (Prerequisite: confirm no service-role grant exists before PR B — see §7.) |
| **`connector_runner` (DB role) compromised** | It can INSERT secrets/lifecycle/audit rows and SELECT the **ciphertext envelope** for any tenant (BYPASSRLS) — but it **cannot UPDATE/DELETE** secrets, lifecycle, or audit rows (append-only), and **cannot decrypt** without the KMS `kms:Decrypt` IAM grant. DB compromise alone yields ciphertext, not plaintext. |
| **KMS runner role (IAM `kms:Decrypt`) compromised** | It can unwrap DEKs **for rows it can also read** → plaintext exposure for stored secrets. This is the highest-value target; it is why `kms:Decrypt` is isolated to the runner IAM identity, why the first credential is low-privilege + source-revocable, and why §6 includes IAM key deactivation. |
| **DB-only access compromised** (e.g. a DB dump) | Exposes **ciphertext envelopes only** (wrapped DEK + AEAD ciphertext). No plaintext; no KEK; no `kms:Decrypt`. Useless without the separate KMS grant. |
| **Audit insert fails** | **Fail-closed:** the secret store/lifecycle write rolls back in the same transaction — no secret/lifecycle row commits without its audit (PR #167/#170). No unsafe operation proceeds unaudited. |
| **Lifecycle revoke fails** | The revoke helper **throws**; no partial state. The targeted version remains in its prior state (loadable iff it was loadable). The caller must retry/escalate (§6); a credential believed-revoked-but-not is treated as **still live** until provider-side revocation (below) confirms. |
| **Tenant binding wrong** | A wrong-tenant load returns **null** (the `WHERE tenant_id` filter) and, even if a row were force-read, **GCM authentication fails** because `tenant_id` is in the AAD → decrypt throws. Wrong-tenant access yields nothing usable. |
| **First credential leaks BEFORE encryption** (plaintext, steps 1–5) | This is the **only** window of plaintext exposure (one server-side stack frame). Mitigation: minimize the window (§2 trace), TLS everywhere, no logging, and — because the credential is **source-revocable + low-privilege + dev-workspace-only** — a leak is killed at the Slack source (§6) with negligible real-world blast radius. |
| **First credential leaks AFTER provider ingestion** (ciphertext at rest) | Killed at the source: revoke at Slack (`auth.revoke` / app removal) **and** tombstone locally. Source revocation makes the stored token inert regardless of ciphertext exposure. |
| **Local vault tombstone succeeds but provider-side revocation FAILS** | The credential **remains exposed at the provider** — a local tombstone only stops *our* load, not Slack's acceptance of the token. This is treated as an **open incident**: the token is **still live** until provider-side revocation is confirmed; §6 mandates retrying provider revocation, rotating the app, and (if needed) removing the app/workspace. **Local tombstone is never sufficient on its own.** |

---

## 5. Evidence required before RISK-007 closure

> **The staging dry-run that produces this evidence IS the first real-token event. It is NOT synthetic.** It must
> use the §1 source-revocable, low-risk Slack dev-workspace credential and be treated with the same care as
> production (named operator, fresh temporary IAM keys, full log inspection, immediate source revocation after).

RISK-007 closure requires **all** of:

1. **Staging real-credential store dry-run** with the §1 low-risk, source-revocable Slack dev-workspace token (the
   first real-token event), on staging `ycdpzduxugdsffjqyoai` only.
2. **No token printed in logs** — across the **named staging surfaces** (item 15), grep for the **full token**, the
   `xoxb-` prefix, a **truncated** prefix, **and** a SHA-256 hash of the token (a high-entropy Slack secret can evade
   a single literal grep via truncation or base64/url-encoding): **zero** hits is the only PASS. *Absence of a log
   line is only as strong as log coverage (item 15 names what is NOT covered).* The structural audit allowlist
   (`CREDENTIAL_VALUE_RE`) protects **audit rows only** — general app/platform logs have no structural redaction, so
   this grep is the load-bearing control.
3. **No token in browser/devtools** — confirmed (the browser carried only `state`+`code`). *Browser token handling
   is forbidden, not risk-accepted.*
4. **Audit rows** for `store.attempted/succeeded/failed` present and allowlist-shaped (no token material).
5. **DB row holds an envelope only** — dump the **FULL** `connector_secrets` row (ALL columns, not only the 8
   envelope columns) and grep **every text/bytea column** — including the free-text `aad_digest`, `key_id`,
   `secret_kind`, `aead_alg` — for the `xoxb-` prefix **and** a SHA-256 of the token: **zero** hits across ALL
   columns. Also confirm **no plaintext-capable column exists** by diffing the live table against migrations
   `0017`/`0030`. (Shape — "the 8 envelope columns populated" — is necessary but is NOT the non-persistence check.)
6. **Web/request identity cannot decrypt** — an **executed negative on staging** (not a code re-read): the web/
   request IAM identity attempts `kms:Decrypt` of a real stored wrapped DEK and is **observed** to return
   `AccessDenied` (capture the API response / CloudTrail entry); **and** a web-role `SELECT` on `connector_secrets`
   returns zero rows / permission denied (deny-all RLS). Residual exposure stated: the web identity can reach **only**
   the ciphertext-envelope path, itself blocked by deny-all RLS — and cannot unwrap the DEK regardless.
7. **Runner identity can decrypt only through the allowed path** (PR C; runner IAM `kms:Decrypt` + capability), and
   **only** then.
8. **Wrong tenant cannot load** — BOTH sub-checks observed (the query filter is NOT the cryptographic boundary; the
   AAD is): **(a)** a normal cross-tenant load returns **null** (the `WHERE tenant_id` filter); **and** **(b)** a
   force-fed envelope decrypted under a **mismatched** `SecretContext` **throws** an AEAD/GCM auth failure (`aad
   mismatch`) — proving the structural confused-deputy/replay defense, not just the query filter.
9. **Revoked credential cannot load**; 10. **Tombstoned credential cannot load** (Model B lifecycle exclusion).
11. **Audit failure blocks the unsafe operation** — an **induced fault on staging** (not a happy-path + code-read):
    force the `store.succeeded` audit INSERT to fail **inside the runner transaction** (e.g. revoke the `0031`
    `audit_logs` grant or violate an `audit_logs` constraint), then **observe** (a) the operation throws, (b)
    `count(*)` on `connector_secrets` for that exact `(tenant, connector, secret_kind, version)` is **0** (full
    rollback — **no** compensating DELETE), and (c) **no** `store.succeeded` audit row exists.
12. **Provider-side revocation path verified** — `auth.revoke` / app removal observed to invalidate the token
    (a post-revocation Slack API call returns `token_revoked`/`invalid_auth`).
13. **Vault-side tombstone/revoke path verified** — the revoke/tombstone helper makes the version non-loadable;
    **and** an **induced** in-CTE audit failure (same fault-injection as item 11, on the lifecycle CTE) leaves **no**
    lifecycle row and **no** succeeded audit (fail-closed, observed — not code-read).
14. **Rollback / cleanup verified** — the test credential is revoked at Slack, tombstoned locally, the dev workspace/
    app is removed, and temporary IAM keys are deleted (§6).
15. **Logs inspected and clean** — enumerate the **exact** staging surfaces and record each one's retention window:
    Vercel runtime/function/build logs for the staging deployment, and Supabase Postgres logs for
    `ycdpzduxugdsffjqyoai`. The telemetry stack is **determinate** today: the ONLY telemetry is Vercel **Analytics +
    Speed Insights** (both **client-side**, `src/app/layout.tsx`; RISK-013), which is structurally **off** the
    server-side token path (§2 steps 3–7), and there is **NO** error-monitoring or tracing vendor (no
    Sentry/OpenTelemetry/Datadog/PostHog/Axiom anywhere). Apply item 2's multi-pattern grep to **each** server-side
    surface (zero hits = PASS), and **explicitly state what is NOT covered** (e.g. any surface whose retention has
    already rolled off, or any new vendor added before the dry-run) — "clean" is bounded by log coverage. *(If a
    server-side error-monitoring/tracing vendor is added later, it MUST be added to this list before the dry-run.)*
16. **Docs updated** — evidence recorded (a dedicated evidence doc, non-secret only).
17. **Production still blocked** until explicitly approved (production KMS/IAM separation is still **unverified**).

Additional prerequisites surfaced by the current code (must be resolved before/within PR B, not at closure):

- **Versioned runner login DDL** — `connector_runner_login` must be created by a reviewed migration (or a reviewed,
  recorded bootstrap), not a manual staging-only step; the production identity chain needs versioned, auditable DDL.
- **Production KMS/IAM separation** must be provisioned + verified before any production real-token consideration
  (only staging synthetic separation is proven today).

### Additional evidence before the first real OAuth exchange (B2c — doc 42 §90)

Because B2c mints the first real token via the Slack `oauth.v2.access` exchange, the §1–17 evidence above ALSO
requires, before any real OAuth run:

1. **Staging-only flag** set (the exchange path is gated, never production).
2. **A dedicated test Slack dev workspace + app** (disposable, non-production, no real org data).
3. **A source-revocable token** (Slack bot token; `auth.revoke` / app removal — §1).
4. **The provider-side revocation operator identified** (the dev-workspace admin, named in the evidence/runbook).
5. **No production redirect URI** — the registered Slack redirect URI is the staging one only.
6. **Exact redirect URI verified** — the Slack-app-registered redirect URI matches the authorize + callback
   **exactly** (full-string; no prefix/origin/loose — doc 42 §90.2).
7. **Log / tracing / access-log surfaces identified** for the **authorization `code`** (query-string surface) +
   token + client secret (doc 42 §90.5; the access-log/Referer surfaces for the `code`).
8. **Scanner passing with Slack structural patterns** (`scripts/check-no-real-tokens.sh` already catches `xox*` +
   the auth-`code`/client-secret shapes are enumerated before the run).
9. **Slack client secret protected with vault-grade controls** (doc 42 §90.3 — KMS-backed, runner-only, ≥ bot-token
   strength).
10. **Slack client secret NOT in a plaintext env var** — an **executed negative**: grep the staging env / secret
    surfaces (deployment env vars, `.env*`, function config) for the client-secret value **and** its shape with
    **zero** hits (item 2's multi-pattern discipline), and confirm the exchange resolves it **only** from the
    KMS-backed store (item 9), never `process.env`.
11. **A runbook for provider-side revocation** (Slack `auth.revoke` + app removal) **and** for **vault tombstone/
    revoke** (§6).
12. **Explicit Sam authorization** for the real-token run (B2c is not authorized by merging B2/B2a/B2b).

---

## 6. Kill switch / rollback

If the first real credential leaks, or any check fails, execute **provider-side first**, then local:

1. **Revoke at the Slack source (authoritative):** call `auth.revoke` for the token **and** remove/uninstall the app
   from the dev workspace (App Management → *Remove App*). Provider-side revocation is what actually kills the token.
2. **Who performs it:** the named **dev-workspace admin/owner** (recorded in the §5 evidence + this runbook).
3. **Verify provider-side revocation succeeded:** make a Slack API call with the token and confirm
   `token_revoked`/`invalid_auth`; confirm the app no longer appears installed.
4. **Tombstone/revoke in the vault:** call the runner `revoke`/`tombstone` helper (PR #170) for the exact
   `(tenant, connector, secret_kind, version)` → the version becomes non-loadable (Model B). *(Local only — never a
   substitute for step 1.)*
5. **Disable the runner decrypt path:** unset the runner KMS env (`CONNECTOR_VAULT_KMS_KEY_ID` / the runner AWS
   profile) so no `kms:Decrypt` is possible; if PR C shipped a decrypt entrypoint, disable its flag.
6. **Remove/deactivate IAM access if needed:** cut the runner's temporary programmatic access — if the runner
   authenticates with long-lived keys, deactivate + delete its temporary IAM access keys; if it uses an EC2/STS
   assumed role (e.g. `idc-runner-role`), rotate/disable that role's session instead (there are no long-lived keys
   to delete). Keep the IAM identities/policies + the KEK in place; cut only the temporary access path. Escalate to
   disabling the runner IAM identity if compromise is suspected.
7. **Confirm no plaintext leaked:** grep server/function/DB/tracing/error-monitoring/analytics for the `xoxb-` prefix
   + a token hash; confirm zero hits; confirm clipboard/shell/command/browser history + screenshots are clean.
8. **Inspect — logs:** server logs, serverless function logs, Postgres logs, tracing spans, error-monitoring events.
9. **Inspect — DB rows:** the `connector_secrets` row (envelope only, no plaintext) + the
   `connector_secret_lifecycle_events` revoked/tombstoned row.
10. **Inspect — audit rows:** `connector_secret.store.*` and `connector_secret.revocation/tombstone.*` rows are
    present, allowlist-shaped, and carry no token material.
11. **If audit fails:** treat the operation as not-performed (fail-closed); do **not** proceed; investigate the audit
    path before any retry.
12. **If wrong-tenant access is detected:** treat as a confused-deputy incident — revoke the credential at source,
    tombstone locally, and audit the `tenant_id` binding + AAD path before any further real-token work.
13. **If vault tombstone succeeds but provider-side revocation FAILS:** the token is **still live** — this is an open
    incident. Retry `auth.revoke`, remove the app, and (if necessary) delete the dev workspace/app entirely; do not
    consider the credential neutralized until a Slack API call confirms invalidation.

---

## 7. Implementation PR sequence (proposed)

| PR | Scope | Real token? |
|---|---|---|
| **PR A** | **This docs-only threat model / gate.** | No |
| **PR B1** | **Staging-only store/encrypt INGESTION path — SYNTHETIC ONLY.** The smallest guarded entry that encrypts + stores a connector secret through the existing vault (`saveConnectorSecret`): the production hard-block, the Slack-bot-token provider/kind allowlist, the required-identity + grammar-safe `correlation_id` guards, and the atomic store + audit — all proven with **synthetic sentinel** values. **No real token, no operator/admin-console paste, no OAuth exchange, no Slack API call, no callback route, no live connector, no decrypt.** It proves the path is *designed not to leak a token if a token flows through it*, without any real token. **Merging B1 does NOT authorize a real-token run.** | **No — synthetic only.** |
| **PR B2 (design)** | **Slack OAuth authorize/callback/exchange DESIGN GATE** (docs only — doc 42 §90): the code-vs-token boundary, state/CSRF/actor binding, the **vault-grade Slack client secret**, the exchange path, the auth-code/token/client-secret plaintext traces (§5 below), audit, failure modes, and the B2a–B2d sequence. **No OAuth implementation, no callback route, no Slack API call, no real token.** | **No — design only.** |
| **PR B2a (✅ DONE, #174)** | **State generation + validation** — **implemented:** binds + validates all eight fields, adds **actor/session + exact-redirect + correlation binding** (new `session_required`/`subject_mismatch`/`redirect_uri_mismatch`/`correlation_mismatch` codes) + **generation-time actor authorization**; `serverTrustedRedirectUri` (no Host-spoof); migration `0034` widens the reason-code CHECK; 26 synthetic tests + RLS T55. **No** Slack exchange/API/callback-route-exchange/real-token. *(Still future: the versioned `connector_runner_login` DDL + the HMAC-signer/KMS staging config land with B2b/B2c.)* | **No — synthetic.** |
| **PR B2b (✅ DONE, #175)** | **Slack exchange wrapper against MOCKED Slack responses** — **implemented:** `slack-oauth-exchange.ts` `exchangeSlackOAuthCode` reads the client secret from an INJECTED provider (never env), calls the token endpoint via an INJECTED http client (no global fetch / no fallback — stubbed fetch fails loud), parses the bot-token response in memory, hands the token to the B1 store path, returns a REDACTED ref; fail-closed + sanitized; 18 synthetic tests with a token-shaped `xoxb-…MUSTNOTLEAK…` sentinel. **No** real Slack call, **no** real token. *(Still future: the vault-grade/KMS-backed client-secret store + exchange-specific audit — wired in B2c.)* | **No — mocked.** |
| **PR B2c — SPLIT into FOUR separate steps (never combined)** | B2c is split so each trust boundary gets its own review/authorization: | |
| &nbsp;&nbsp;↳ **B2c-wire (✅ DONE, #176)** | **Synthetic callback composition** (pure function) — `oauth-callback-orchestrator.ts` composes B2a validate (gate) → B2b mocked exchange → B1 store, threading the validated payload as the single source of truth; `b1StoreHandoff` wires the real B1 ingestion (token→ciphertext). **Mocked Slack, synthetic token, mocked client secret — no real call/token/secret, no route.** | **No — synthetic.** |
| &nbsp;&nbsp;↳ **B2c-secret (✅ DONE, #178)** | The **vault-grade KMS-backed Slack client-secret store** (§90.3) — **implemented (synthetic):** new app-scoped `connector_app_secrets` table (NO tenant_id; RLS deny-all; runner column-scoped, T56) + `slack-client-secret-store.ts` with the load-bearing `withSlackClientSecret` scoped decrypt-and-use closure (no `loadClientSecret` API — plaintext reaches only the exchange callback, never returned/logged/thrown) + app-scope AAD (staging≠production). **No real client secret entered the system, no real token.** *(The app-secret USE audit remains future.)* | **No — synthetic; introduces the (synthetic) master-credential store path.** |
| &nbsp;&nbsp;↳ **B2c-route (✅ DONE, #179)** | The **production OAuth callback route** wrapping the B2c-wire orchestrator — **implemented (synthetic):** `oauth-callback-route-handler.ts` + the `(authenticated)/connectors/oauth/callback/route.ts` shim, with the request-path discipline **proven**: server-only, **production-disabled** (`isSyntheticCallbackEnabled` trusted-env-only — generic 404, earliest refusal, no disclosure), explicit session resolution (no layout-auth reliance), no query-string/`state`/`code` logging, no raw `state`/`code` in error responses, safe/static 303s only; synthetic deps (no global fetch, can't reach slack.com), **does NOT touch the client-secret decrypt boundary**. **No real Slack egress, no real token, no real client secret.** | **No — synthetic route, request-discipline proof.** |
| &nbsp;&nbsp;↳ **B2c-run (future — runbook ready, #180)** | The **FIRST real Slack OAuth/token event** — server-side `oauth.v2.access` exchange; the token is **born inside the trusted server/runner path** and immediately encrypted/stored via B1's path — **no human ever sees/copies/pastes/submits it.** An **explicitly-authorized operational go/no-go** (Sam), governed by §5 (incl. its OAuth sub-block) / §6 — **not a normal code PR.** The **operational checklist is [45_B2C_RUN_FIRST_REAL_TOKEN_RUNBOOK](./45_B2C_RUN_FIRST_REAL_TOKEN_RUNBOOK.md)** (go/no-go gate, single controlled run, evidence capture, secret-safe DB/log scanning, failure handling with containment-first ordering, provider-side + vault-side revocation, post-run verification). **#180 created the runbook only — no real run happened.** | **Yes — first real-token event (staging, §1 credential, treated as production).** |
| **PR C (decrypt)** | **Staging real DECRYPT/USE harness** — runner-only decrypt of the B2c-stored token behind an explicit staging flag; verify §5 items 7–13. No live connector traffic beyond the minimal read proving the token works + is revocable. | Yes (staging) |
| **PR B2d** | **Live connector use** behind an explicit **staging** feature flag (the first real provider sync), low-privilege/read-only. | Yes (staging) |
| **PR E** | **Production-readiness review** — production KMS/IAM separation provisioned + verified, production runner identity, full evidence, sign-off. | — |
| **then** | **Only after PR E** consider RISK-007 closure (per doc 04 closure criteria + §5 here). | — |

---

## 8. Posture language (must remain true until explicitly changed)

- **Real credentials remain BLOCKED by this PR.**
- **RISK-007 remains OPEN** (this is a design gate, not implementation; closure is gated on §5 + doc 04).
- **RISK-001 remains OPEN.**
- **Cutover remains BLOCKED.**
- **Connector credentials are NOT production-ready.**
- **This PR is a design gate, not implementation** — docs only; no code, migration, test, or real token.
- **The first staging real-token dry-run (§5) is the first real-token event and must NOT be treated as synthetic.**
