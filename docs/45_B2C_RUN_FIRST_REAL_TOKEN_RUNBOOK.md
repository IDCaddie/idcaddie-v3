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
- Pass a literal value through a **protected runtime variable read from a prompt / a temp file with `0600` perms / an
  approved secret-handling method** that does NOT write the secret to shell history (e.g. `read -rs VAR` then use
  `"$VAR"`, never echo it; or a temp file you `shred`/`rm` immediately).
- **Clear any temporary secret material immediately after inspection** (`unset VAR`; remove/shred the temp file).
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
- [ ] All §1 gate items true. Sam "GO" recorded (who/when). _If not → NO-GO._

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
