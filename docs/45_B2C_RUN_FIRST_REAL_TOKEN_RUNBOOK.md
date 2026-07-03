# 45 · B2c-run — First Real Slack OAuth/Token Event (Operational Runbook)

> **STATUS: runbook only. No real run has happened. This PR creates the checklist; it does NOT execute B2c-run.**
> No real Slack API call, no real token, no real client secret has entered the system. **RISK-001 OPEN. RISK-007
> OPEN. Cutover BLOCKED. Connector credentials are NOT production-ready. Live connector use remains BLOCKED.**

**B2c-run is an OPERATIONAL EVENT, not a normal code PR.** It is the **first real Slack OAuth/token event** — the
first time a real Slack `code` is exchanged for a real bot token and the first real decrypt of the app-scoped Slack
client secret. It is the RISK-007 closure-evidence gate (docs/44 §5). It is performed by a **human operator** against
the synthetic-but-now-enabled B2c-route, **only after Sam gives an explicit "GO" immediately before execution.**

This run MUST:
- use a **low-risk Slack DEV workspace/app only** — dedicated, disposable, no real business content, no real members
  beyond the operator/test accounts;
- use a **source-revocable** credential (a Slack app whose client secret + bot token can be regenerated/revoked in the
  Slack app/workspace admin);
- use the **exact staging callback URI only** — **never** a production Slack workspace/app/redirect;
- be run **exactly once, by hand** — **never** as part of a merge, CI job, local test sweep, or casually.

The agent NEVER executes this run. The agent does not run hosted commands, does not enable the guard, does not perform
a real OAuth exchange, and does not touch production. This document is the human operator's checklist.

**Components in play** (all already built + synthetic-tested): B2a state validation (`oauth-state.ts`), B2b exchange
wrapper (`slack-oauth-exchange.ts`), B2c-wire orchestrator (`oauth-callback-orchestrator.ts`), B2c-secret client-secret
store (`slack-client-secret-store.ts` + `connector_app_secrets`, migration 0035), B1 store/encrypt
(`ingestStagingConnectorSecret` → `connector_secrets`), B2c-route (`oauth-callback-route-handler.ts` +
`(authenticated)/connectors/oauth/callback/route.ts`), the staging guard `CONNECTOR_OAUTH_SYNTHETIC_CALLBACK_ENABLED`,
the lifecycle table `connector_secret_lifecycle_events`, and `scripts/check-no-real-tokens.sh`.

---

## 1. Pre-run GO/NO-GO gate

**ALL of the following must be true before running. If ANY item is missing → STOP (outcome NO-GO).**

- [ ] Main is **clean** (no uncommitted changes) and at the **expected commit** (record the SHA).
- [ ] Supabase ref is **staging `ycdpzduxugdsffjqyoai`** (`cat supabase/.temp/project-ref`).
- [ ] **No production link/command** is configured or about to be run (no `--linked` prod, no prod KMS/IAM, no prod
      Vercel env).
- [ ] The **staging-only callback guard** (`CONNECTOR_OAUTH_SYNTHETIC_CALLBACK_ENABLED=1`) is ready to enable on the
      **staging** environment only — and is **OFF** in production.
- [ ] The **production callback remains blocked** (production `isSyntheticCallbackEnabled` is false; no production
      redirect URI configured at Slack).
- [ ] **#179 PROXY FIX VERIFIED SYNTHETICALLY — pre-run, BEFORE any real `code` exists (GO/NO-GO).** With ONLY
      synthetic values, confirm the unauthenticated callback path does NOT leak the OAuth query through the auth
      redirect: an **unauthenticated** request to the staging callback with a **synthetic** `?code=SYN&state=SYN`
      redirects to a **CLEAN `/login`** (no `code`/`state`), the `/login` URL does **not** preserve the OAuth query,
      and **no `Referer`/header** carries `code`/`state` (the `proxy.ts` `redirectUrl.search = ""` fix from #179). This
      MUST PASS **before** the run is allowed to produce any real `code` — if it does not, **NO-GO** (do not enable the
      real run). _(Re-confirm on the real path post-run in §6 — but the gate is HERE, pre-run.)_
- [ ] **Slack DEV workspace/app confirmed** — a dedicated Slack app in a dev workspace, not production.
- [ ] The Slack workspace is **dedicated, disposable, and contains NO real business content.**
- [ ] The Slack workspace has **no real users/members** beyond the operator/test accounts needed for the run.
- [ ] **If only a shared dev workspace is available → STOP and document the exact bot scopes + blast radius** (what the
      bot token could read/do across that workspace) **before proceeding.** Do not proceed on a shared workspace
      without that written blast-radius note + Sam's explicit acknowledgement.
- [ ] The Slack app **redirect URI is the EXACT staging callback URI only** (the deployed staging
      `…/connectors/oauth/callback`). Record it verbatim.
- [ ] **No production redirect URI** is configured on the Slack app.
- [ ] **Provider-side revocation operator identified and present** (a person with Slack app-admin access who can
      regenerate the client secret + revoke the bot token during the run).
- [ ] **Provider-side revocation method documented** (the exact Slack admin steps — see §8).
- [ ] **Vault-side revoke/tombstone method ready** (the `connector_secret_lifecycle_events` revoke/tombstone INSERT
      path; record the exact query/helper).
- [ ] **Log surfaces identified** (the full list in §6).
- [ ] **DB inspection queries ready** (§5 — prepared, structural-first, secret-safe).
- [ ] **Scanner commands ready** (`scripts/check-no-real-tokens.sh selftest` and `--all`, plus the log scans in §6).
- [ ] **Evidence capture location ready** (a private, access-controlled location — NOT a public PR/issue/screenshot;
      see the secret-handling rules in §5).
- [ ] **Sam gives an explicit "GO" for THIS run** (record who, when, and the authorized scope — one run).

> If any item above is missing or uncertain → **STOP. Outcome = NO-GO. Do not run.**

---

## 2. Secrets involved — track TWO real secrets separately

Both are **first-real-secret events**. Handle each as a real credential from the moment it exists.

### A. Slack **client secret** (the OAuth master credential — app-scoped)
- This run is the **first real decrypt** of the app-scoped client secret.
- It must be decrypted **only** through the B2c-secret approved boundary (`withSlackClientSecret` → the exchange
  callback). There is no `loadClientSecret()` API; do not add one.
- **No plaintext env var** for the client secret. **No request-path decrypt.** **No exposure in logs/errors/audit.**
- **Verify no plaintext trace after the run** (§5/§6).
- It is stored app-scoped in `connector_app_secrets` (envelope only, migration 0035).

### B. Slack **bot token** (the credential the exchange mints)
- This run produces the **first real bot token** via the Slack exchange.
- It is **born server-side** (the runner exchange path) and **never returned to the browser/request path.**
- It is **immediately stored through the vault** (B1 `ingestStagingConnectorSecret` → `connector_secrets`,
  envelope-only).
- The DB row is **envelope-only** (ciphertext + wrapped DEK + metadata; no plaintext).
- It is **source-revoked at Slack during cleanup** (§8) — provider-side revocation is non-optional.

---

## 3. Exactly ONE controlled run

Perform **exactly one** controlled run:
- **one** Slack authorize, **one** callback, **one** code exchange, **one** store operation.
- **No loops. No broad test sweeps. No retry storm. No live connector use after the token is stored. No production
  run.**
- **If the run fails → STOP, collect evidence (§4/§7), and do NOT keep retrying without review.** A Slack `code` is
  single-use; a retry after a partial success risks a double-spend / a second token. Treat any second attempt as a new,
  separately-authorized event.

---

## 4. Evidence to collect

Capture (into the private evidence location) proof of each:

- [ ] callback route was hit (route handler reached, guard passed on staging).
- [ ] B2a state validation **succeeded** (the single matching `oauth_pending` row consumed once).
- [ ] Slack exchange `attempted` → `succeeded` (or `failed`, with a safe reason) — observed via safe reason codes only.
- [ ] the client-secret decrypt occurred **only** through the approved `withSlackClientSecret` boundary.
- [ ] the bot token was stored as an **envelope only** (a `connector_secrets` row with ciphertext/DEK/metadata).
- [ ] **audit rows exist** for the store (`connector_secret.store.attempted` + `.succeeded`).
- [ ] **no plaintext** in: the DB row, the audit rows, the logs, the route response body, the response headers, any
      thrown error, the console output, and any snapshots/artifacts.
- [ ] **wrong-tenant cannot load** the stored secret (RLS/app-scope boundary holds).
- [ ] a **revoked/tombstoned** token **cannot load** (lifecycle-aware fail-closed load).
- [ ] the **#179 proxy fix was verified SYNTHETICALLY pre-run (§1), BEFORE any real `code` existed** (the
      unauthenticated callback drops `code`/`state` on the `/login` redirect) — and re-confirmed on the real path (§6).
- [ ] **provider-side revocation succeeds** (the Slack token is dead — §8).
- [ ] **vault-side revoke/tombstone succeeds** (`connector_secret_lifecycle_events` records it).
- [ ] the **staging guard is disabled** after the run (the route refuses again).

---

## 5. DB inspection (envelope-only; secret-safe)

Verify directly against staging (read-only inspection — never a destructive command):

- [ ] the `connector_secrets` row contains **envelope/ciphertext fields only** (ciphertext, dek_wrapped, aead_nonce,
      aad_digest, key_id — and the format/tag columns); **no plaintext column, no plaintext value.**
- [ ] **no Slack token literal** appears in any row.
- [ ] **no SHA-256 of the token** appears anywhere unexpected (the design stores no token hash in app rows; if one
      appears in an unexpected place, treat as a finding).
- [ ] **no client-secret literal** appears in any row.
- [ ] **no app-secret plaintext** appears (`connector_app_secrets` is **envelope only**).
- [ ] **audit rows** contain **safe/static metadata only** (event type + safe ids + safe reason class).
- [ ] **lifecycle rows** (`connector_secret_lifecycle_events`) contain **no secret material.**
- [ ] the **`connector_app_secrets`** table contains **envelope only.**

**Do not print the real token/client secret into terminal output where avoidable.** Prefer **structural/pattern scans
first** (e.g. search for the prefix `xoxb-`, or the Slack token grammar `xox[baprs]-…`). Use a **literal** search only
when required to disambiguate a suspected hit, and handle it carefully:

- **Never type the token/client secret directly into a shell command** (it would land in shell history + process args).
- Pass a literal value through a **protected runtime variable read from a prompt** (`read -rs VAR` then use `"$VAR"`,
  never echo it) — **prefer in-memory; do NOT write the secret to a temp file.** If a `0600` temp file is genuinely
  unavoidable, clean it up **fail-loud and portable** (`shred -u "$f" 2>/dev/null || rm -f "$f"` then
  `[ -e "$f" ] && { echo "FATAL: secret file remains"; exit 1; }`) — never a bare `shred` (it no-ops on macOS).
- **Clear any temporary secret material immediately after inspection** (`unset VAR`; for any temp file use the portable
  fail-loud cleanup + existence check above — never a silent `shred`).
- **Never paste a token/client secret into PR comments, docs, screenshots, terminal transcripts, or chat.**

> **The act of scanning for a secret must NOT create a new secret leak.** Structural-pattern-first; literal-only-when-
> necessary; secret-material never persisted to history/artifacts.

---

## 6. Log scanning

Inspect **every** log surface:

- [ ] route handler logs
- [ ] proxy/middleware logs (`src/proxy.ts` / `src/lib/supabase/proxy.ts`)
- [ ] app/server logs
- [ ] build/runtime logs
- [ ] Vercel/deployment logs (if the staging app is deployed there)
- [ ] Supabase log surfaces (if applicable)
- [ ] browser-visible response body/headers (the callback response + the redirect Location)
- [ ] analytics/tracing/error-monitoring surfaces (note: only `@vercel/analytics` exists — a page-layout client
      component; confirm it captured no callback query)

Scan each for:

- [ ] the prefix `xoxb-` and the Slack token structural pattern (`xox[baprs]-` + digits + body).
- [ ] the exact token literal — **only if necessary**, handled via the §5 secret-safe method.
- [ ] the token SHA-256 — **only if necessary**, handled safely.
- [ ] the client-secret literal — **only if necessary**, handled safely.
- [ ] the authorization `code` literal — **only if necessary**, handled safely.
- [ ] raw `code=` and raw `state=` substrings.
- [ ] Slack response fields (e.g. `access_token`, `bot_user_id`, raw response JSON).
- [ ] unexpected token/client-secret words appearing in logs.

**Also verify the #179 proxy fix held on a real path:**
- [ ] an **unauthenticated** callback request does **NOT** redirect to `/login?code=…&state=…` (the query is dropped).
- [ ] the `/login` URL does **not** preserve the OAuth `code`/`state` query.
- [ ] **no Referer/header leak** from that path (the redirect Location carries no `code`/`state`).

Run `scripts/check-no-real-tokens.sh selftest` and `--all` as the structural backstop.

---

## 7. Failure handling

Define the response if ANY of these occurs:

- the callback route leaks `code`/`state`; the client-secret decrypt leaks plaintext; a Slack token appears in logs;
  a DB row contains plaintext; an audit row contains plaintext; a wrong tenant can load; a revoke/tombstone fails;
  provider-side revocation fails; the staging guard cannot be disabled; the real Slack exchange fails; Slack returns an
  unexpected token type; the scanner finds a token pattern.

**Default response:**
- **STOP immediately. Do NOT retry.**
- **If a live token was issued or MAY have been issued → revoke provider-side FIRST** (kill the Slack token/app at the
  source).
- **After provider-side revocation, preserve the evidence** of the leak AND of the revocation.
- **Tombstone/revoke the vault-side secret** if it was stored.
- **Keep RISK-007 OPEN.**
- **Do NOT proceed to live connector use.**

**Ordering rule (containment beats forensics for a live exposed credential):**
1. **Provider-side revocation comes FIRST** when a live token may be exposed (a dead Slack token can't be abused
   regardless of where the leaked copy is).
2. **Evidence capture follows immediately after revocation.**
3. **Vault-side tombstone/revoke follows provider-side revocation** — UNLESS the vault row is the only immediate
   containment available (then tombstone first to stop a load, then revoke provider-side).

> **A vault-side tombstone is NOT a substitute for provider-side revocation of a leaked live Slack token.** A vault
> tombstone only stops **THIS system** from loading/using the token — the Slack token remains **live everywhere else**
> (anyone holding the leaked copy can still use it). **Provider-side revocation at Slack is what actually KILLS the
> token at the source.** If provider-side revocation is temporarily unreachable, a vault tombstone is **only a PARTIAL
> STOPGAP** — **the incident is NOT contained until provider-side revocation succeeds.** Keep escalating (find another
> Slack app-admin, rotate the client secret, uninstall the app) until the token is confirmed dead at the source; do
> NOT close the incident or mark cleanup complete on a tombstone alone.

---

## 8. Cleanup / kill switch (provider-side revocation is NON-OPTIONAL)

After the run (pass or fail), perform + record:

- [ ] **vault-side revoke/tombstone** of the stored secret (INSERT into `connector_secret_lifecycle_events`; record the
      lifecycle event id).
- [ ] **provider-side Slack token revocation** — at the Slack app/workspace admin: revoke the bot token (and, for a
      full kill, uninstall the app / rotate the client secret). Record the operator + timestamp.
- [ ] **confirm the provider-side token is dead** — an independent check that the revoked token no longer authenticates
      to Slack (a safe `auth.test`-style check by the operator, NOT through this app's request path; the token value
      handled per §5).
- [ ] **disable the staging callback guard** (`CONNECTOR_OAUTH_SYNTHETIC_CALLBACK_ENABLED` unset/`0` on staging).
- [ ] **verify the route refuses** after the guard is disabled (a request returns the generic 404; no request material
      logged).
- [ ] **verify the revoked/tombstoned credential cannot load** (lifecycle-aware fail-closed load returns null/denies).
- [ ] **verify no live connector use happened** (no connector run executed against the token after store — B2d is
      future + blocked).
- [ ] **document the final evidence** in the private evidence location + the §9 checklist.

> **Provider-side revocation is non-optional.** Proving the bot token + client secret can be killed **at the source**
> is the containment story that justifies storing a real credential at all (docs/44 §6).

---

## 9. Go/No-Go checklist (fill in per run)

**Run id / date / operator / authorizing approver (Sam): __________   Main SHA: __________   Ref: ycdpzduxugdsffjqyoai**

### Pre-run GO
- [ ] All §1 gate items true, **including the #179 proxy-fix synthetic check (verified BEFORE any real `code` exists)**. Sam "GO" recorded (who/when). _If not → NO-GO._

### During-run observations
- [ ] Exactly one authorize / callback / exchange / store (§3). No loops/retries/sweeps.
- [ ] State validation succeeded; exchange succeeded; token stored envelope-only; client-secret decrypt only via the
      approved boundary.

### Post-run evidence
- [ ] §4 evidence captured. §5 DB inspection clean (envelope-only; no plaintext). §6 log scans clean (no `xoxb-`/
      `code=`/`state=`/token/secret). #179 proxy fix verified on a real path.

### Revocation / cleanup evidence
- [ ] §8 complete: vault tombstone/revoke done; provider-side Slack revocation done + confirmed dead; staging guard
      disabled; route refuses; revoked credential cannot load; no live connector use.

### Final decision (choose one)
- [ ] **PASS** — evidence clean, token stored envelope-only, revocation works, guard disabled.
- [ ] **FAIL-CLEANUP-COMPLETE** — issue found; provider-side + vault-side cleanup done; evidence preserved; escalate the
      finding.
- [ ] **FAIL-CLEANUP-INCOMPLETE** — issue found; cleanup incomplete → **ESCALATE immediately** (live exposure risk).
- [ ] **NO-GO** — prerequisites missing; run not performed.

> **No outcome of this run closes RISK-007 by itself.** A PASS is the *evidence* that feeds the RISK-007 closure
> decision (docs/44 §5) — closure is a separate, explicit decision by Sam, not an automatic consequence of a PASS.

---

## 10. Posture (this PR)

- **B2c-run runbook created ONLY.** No real run happened in this PR.
- **No real token entered the system. No real client secret entered the system. No real Slack API call happened.**
- **RISK-007 remains OPEN. RISK-001 remains OPEN. Cutover remains BLOCKED.**
- **Connector credentials are not production-ready. Live connector use remains BLOCKED.**
- B2c-run is the explicitly-authorized operational go/no-go for the first real token — **not a normal code PR**; it is
  executed by a human operator per this runbook, only after Sam's explicit "GO."

---

## 11. B2c-run PREP harness (PR #181) — exact ingestion + readiness commands

PR #181 added the reviewed, synthetic-tested pieces that make the client-secret ingestion turnkey. **None of this runs a
real secret; the real run is still B2c-run (Sam's explicit GO).**

### 11.1 Safe client-secret ingestion (stdin only — NEVER argv/env/history)
The ingestion LOGIC is the reviewed core `src/lib/server/connector-vault/client-secret-ingest-harness.ts`
(`readSecretFromStream(process.stdin)` → `ingestClientSecret({ plaintext, appEnv: "staging", version: 1 }, { keyProvider, kekId, store })`).
It reads the secret from **stdin**, encrypts immediately via the KMS/envelope boundary, writes an **envelope-only** row
to `connector_app_secrets`, and returns only a redacted `secret_id` (or a safe static reason). It is invoked **inside
the hosted runner runtime** (which supplies the real KMS provider + the `RunnerConnection` as `connector_runner_login`).

> **Runner location + runtime + ingestion are PINNED (doc 46 §11–§12, 2026-06-26):** the hosted runner is a **separate
> deployable** (Option A) that **vendors** the `connector-vault` core at a pinned app-repo commit, runs as an
> **ECS/Fargate one-shot task** on the current IAM-user model (the §47 EC2 `i-00335d…` is **gone** — not reused), and
> ingests the client secret via **AWS Secrets Manager task-read (Model B)** — **not** ECS Exec stdin (Exec session
> logging could capture the master credential). The committed core is unchanged; only the plaintext **source** changes
> (the task fetches the secret from Secrets Manager into memory and calls `ingestClientSecret` directly — no disk, no
> log, no env, no laptop→task pipe). **The stdin-only command below stays valid for an *interactive* runner; for the
> Fargate runtime, Secrets Manager task-read SUPERSEDES it** (doc 46 §12.3). **Adding `pg` to the app repo is NOT
> authorized.** Phase C stays BLOCKED until the Fargate runtime + the Secrets Manager task-read model are implemented
> and reviewed (doc 46 §12.8 tests first).

Pre-flight first (refuses production ref / env-secret / argv-secret; emits the procedure — never holds the secret):
```
node scripts/b2c-ingest-client-secret.mjs --confirm
```
> **⛔ Phase C is BLOCKED until a conforming hosted runner exists.** The committed core takes an **injected**
> `RunnerConnection` (a `connector_runner_login` Postgres pool); this repo is deliberately **pg-free** and owns **no**
> runnable ingestion entrypoint. The hosted-runner entrypoint that performs Phase C is specified in
> **[46_HOSTED_RUNNER_INGEST_ENTRYPOINT_SPEC](./46_HOSTED_RUNNER_INGEST_ENTRYPOINT_SPEC.md)** (where it runs, how it
> injects the connection, the env, the guards, the atomicity guarantee, and the tests required before any real secret).

Then, **on the hosted runner host** (per doc 46 §5), **pipe** the secret on stdin from an **IN-MEMORY** source so it
**never touches disk** (never type it, never argv, never env, never a temp file):
```
unset HISTFILE; set +o history                 # this shell only
CONNECTOR_VAULT_AWS_KMS_REGION=ca-central-1 CONNECTOR_VAULT_KMS_KEY_ID=alias/idcaddie-staging-connector-vault \
  pass show slack/staging-client-secret | <hosted-runner ingest entrypoint reading stdin>   # doc 46 §4 wiring; no disk
```
**WARNING — never type the client secret into argv, an env var, an interactive prompt (shell history), or a temp file.**
Pipe it straight from a no-echo in-memory source. `SLACK_CLIENT_SECRET` must **not** be set in the environment — the
harness and the launcher both refuse if it is.

> If a temp file is **genuinely unavoidable**, it must be **fail-loud and portable** (a bare `shred` silently no-ops on
> macOS, leaving the OAuth master credential in plaintext):
> ```
> umask 077                                    # 0600 before writing
> ...write secret to "$f"... ; <runner reads stdin> < "$f"
> shred -u "$f" 2>/dev/null || rm -f "$f"      # portable: shred if present, else rm
> [ -e "$f" ] && { echo "FATAL: secret file remains"; exit 1; }   # verify gone — never silent
> ```

### 11.2 Exact staging callback URL + trusted-redirect config check
- **Register in Slack (verbatim):** `https://idcaddie-v3.vercel.app/connectors/oauth/callback` (no trailing slash).
- The server validates against the **same** value via `connectorOAuthRedirectUri()`
  (`connector-oauth-config.ts`) — server config only, **never** request-derived (no Host/X-Forwarded-Host). The route
  now uses this (the old `app.example.com` placeholder is gone). Confirm it matches:
  ```
  # both must print the identical string:
  node -e "console.log(require('./src/lib/server/connector-vault/connector-oauth-config').STAGING_OAUTH_REDIRECT_URI)" 2>/dev/null \
    || grep -n 'STAGING_OAUTH_REDIRECT_URI' src/lib/server/connector-vault/connector-oauth-config.ts
  ```
  (or set `CONNECTOR_OAUTH_REDIRECT_URI` on staging to the exact URL).

### 11.3 connector_runner_login readiness check
The `connector_runner_login` **role SHAPE is now provisioned by migration `0039_connector_runner_login_provision.sql`**
(LOGIN + NOINHERIT, member of `connector_runner` with `set true, inherit false`, zero direct grants, no dangerous
attributes) — applying it to hosted staging/production remains a **separate, explicitly-approved** operator step. The
**PASSWORD stays environment-specific and is NEVER committed** — the operator sets it out-of-band after the shape exists:
```sql
alter role connector_runner_login password '<supplied-out-of-band, never committed>';
```
Verify minimal privilege (a core-shape subset of RLS T57, which additionally asserts NOREPLICATION and the
`pg_has_role(…,'SET')=true` / `pg_has_role(…,'USAGE')=false` membership semantics):
```sql
select rolname, rolsuper, rolinherit, rolcreaterole, rolcreatedb, rolbypassrls, rolcanlogin
  from pg_roles where rolname = 'connector_runner_login';
-- expect: rolsuper=f, rolinherit=f, rolcreaterole=f, rolcreatedb=f, rolbypassrls=f, rolcanlogin=t
select count(*) from information_schema.role_table_grants where grantee = 'connector_runner_login';  -- expect 0
-- confirm SET ROLE works and NOINHERIT denies ambient access:
set session authorization connector_runner_login;
  select 1 from public.connector_app_secrets;   -- expect: insufficient_privilege (NOINHERIT, no direct grant)
  set role connector_runner; select 1 from public.connector_app_secrets;  -- expect: allowed (granted)
reset role; reset session authorization;
```

### 11.4 KMS key readiness check
- **Canonical staging KEK (doc 42 §91):** set `CONNECTOR_VAULT_KMS_KEY_ID=alias/idcaddie-staging-connector-vault` — it
  must resolve to `arn:aws:kms:ca-central-1:833822972703:key/a1b7eaa9-5ed6-4fb9-8a19-f610c6407d5f` (Enabled) before any
  live B2 / secret load (`aws kms describe-key --key-id alias/idcaddie-staging-connector-vault`). The code is
  alias-agnostic (reads the env handle; no default). **Do NOT** use the superseded key `…key/5c6fd833…`.
- **IAM (current local path, IAM-user model):** runner `idcaddie-staging-runner` inline policy `kms-runner` grants only
  `kms:GenerateDataKey` + `kms:Decrypt` on the canonical key (no `kms:Encrypt`/`DescribeKey`/wildcard); web
  `idcaddie-staging-web` stays **denied** `kms:Decrypt`. Simulation-proven (doc 42 §91.6): runner GenerateDataKey/Decrypt
  = allowed, web Decrypt = explicitDeny. `createKmsKeyProvider` **fails closed** on a missing client/KEK.
- **Live proof still pending:** mint fresh temp keys for both users → set the env → run the synthetic wrap/unwrap
  (`scripts/verify-staging-connector-vault-dry-run.mjs`) + the denied-decrypt
  (`scripts/verify-staging-kms-iam-separation-dry-run.mjs`) → delete the temp keys and verify they are dead. No
  client-secret load until live B2 is green.

### 11.5 DB inspection after ingestion (envelope-only)
```sql
select id, app_env, provider, secret_kind, version, is_active, kek_id, aead_alg, aad_digest,
       (ciphertext is not null) as has_ciphertext, (aead_tag is not null) as has_tag
  from public.connector_app_secrets where app_env='staging' and provider='slack' order by created_at desc limit 3;
-- envelope columns present; the text columns (provider/secret_kind/kek_id/aead_alg/aad_digest) carry NO secret.
```

### 11.6 Scanner / log checks after ingestion
`scripts/check-no-real-tokens.sh --all`; scan the runner's stdout/stderr + log surfaces (docs/45 §6) for the client
secret structurally first (it must appear nowhere); the harness output is only the redacted `secret_id`/reason.

### 11.7 Cleanup if ingestion fails partway
- If the row was written but the run is aborted: **tombstone/revoke** the app-secret version (the lifecycle path) so it
  cannot load, then re-run only after review. Prefer in-memory ingestion (no temp file); if a `0600` temp file exists,
  clean it portably + fail-loud (`shred -u "$f" 2>/dev/null || rm -f "$f"`; then `[ -e "$f" ] && { echo "FATAL: secret
  file remains"; exit 1; }`) — never a bare `shred`. `unset` any shell var. If a real client
  secret was exposed at any point, follow the §7/§8 containment ordering (provider-side rotation first — a tombstone is
  only a partial stopgap).
