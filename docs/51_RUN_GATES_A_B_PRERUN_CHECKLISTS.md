# 51 · RUN GATE A / B — pre-run checklists (human-gated RISK-007 closure runs)

**Canonical, non-executing gates.** These are the checklists a human operator works through **before** the two remaining
human-gated RISK-007 closure runs. Nothing here executes anything: no AWS call, no OAuth, no ECS run-task, no
`get-secret-value`, no hosted apply. Each run needs an **explicit "Sam GO" immediately before it** — no prior approval in
this repo implies it. **RISK-007 remains OPEN and Phase C remains BLOCKED before, during, and after these runs** — a green
run is *evidence*, not closure (see "What success does NOT mean" in each).

Canonical references: KMS/IAM verifier [docs/49](./49_KMS_IAM_SEPARATION_VERIFIER.md); B2c real-exchange wiring
[docs/50](./50_B2C_REAL_EXCHANGE_RUNBOOK.md); login-chain migration `0039`; connector-runner decrypt/use mode
(idcaddie-connector-runner PR #18) + its runner-side companion `docs/DECRYPT_USE_RUN_CHECKLIST.md`.

Environment constants (identifiers, **not** secrets): staging Supabase ref `ycdpzduxugdsffjqyoai` (**the only permitted
ref**); production ref `dzbfxulvxchdemcettrx` (**must NEVER be touched**); vault KMS alias
`alias/idcaddie-staging-connector-vault`; region `ca-central-1`.

**Never put a secret value in chat, a doc, a commit, or a log** — DB URLs, passwords, client secrets, OAuth codes, access
tokens, key material. Record PASS/FAIL + safe metadata (ids, redacted refs, error *classes*) only.

---

## Execution order (the whole gated sequence)
1. **Apply/verify `0039` on hosted staging** if not already applied (role SHAPE only; password stays operator-set
   out-of-band). Confirm the `connector_runner_login` shape (T57 criteria).
2. **Run the KMS/IAM separation verifier** (docs/49) — record the allowed/denied matrix green.
3. **RUN GATE A** — first real B2c token exchange (this doc, Checklist A).
4. **RUN GATE B** — hosted decrypt/use + rotation/revocation (this doc, Checklist B).
5. **Permanent-deletion follow-up** if any exposed/superseded material needs scheduled deletion (record the window).
6. **Open the RISK-007 closure PR** (docs-only register update) once all evidence is recorded + reviewed.
7. **Phase C unblock is SEPARATE** — its own explicit decision after closure, never bundled with a run.

Steps 1–2 are prerequisites for A; A is a prerequisite for B. Do them in order; do not skip.

---

## Checklist A — RUN GATE A: first real B2c token exchange (staging)

### A1 · Preconditions
- [ ] **Disposable Slack DEV workspace + throwaway DEV app ONLY** — never a customer/production Slack workspace or app.
- [ ] **Staging only** — ref `ycdpzduxugdsffjqyoai`; production ref `dzbfxulvxchdemcettrx` is forbidden and hard-blocked.
- [ ] **Explicit "Sam GO"** obtained immediately before the run (not implied by any earlier approval).
- [ ] Acknowledged: **RISK-007 stays OPEN** and **Phase C stays BLOCKED** before/during/after this run.

### A2 · Required repo state
- [ ] `idcaddie-v3` main includes **#224** (decrypt/use harness), **#225 + #226** (`0039` + hosted-safe repair),
      **#227** (KMS/IAM verifier), **#228** (B2c real-exchange wiring).
- [ ] `idcaddie-connector-runner` main includes **#18** (guarded decrypt/use mode).
- [ ] The exact deploy artifact (image/commit) is pinned and recorded.

### A3 · Required hosted state
- [ ] Staging migrations include **`0039`** (`connector_runner_login` provisioned); role shape verified against T57
      (LOGIN, NOINHERIT, no superuser/createdb/createrole/replication/bypassrls, zero direct grants, member of exactly
      `connector_runner` with SET/no-USAGE).
- [ ] **KMS/IAM separation verifier (docs/49) run green**, OR explicitly scheduled as its own gate BEFORE this run —
      never assumed.
- [ ] The vault KMS alias/CMK + the `connector_app_secrets` slack client-secret envelope exist in staging.

### A4 · Required secret handling
- [ ] **No secret values** pasted into chat / docs / logs (client secret, OAuth code, access token, DB URL, password).
- [ ] The Slack DEV app **client secret** is ingested only via the **approved stdin-only ingest** to staging
      `connector_app_secrets` — never argv/env, never committed, never echoed.
- [ ] **No manual `get-secret-value`** of any real secret; the runtime reads secrets only through the approved path.
- [ ] `CONNECTOR_OAUTH_REAL_EXCHANGE_ENABLED=1` is set **only** in the ephemeral staging run environment, **never** in
      CI or any shared/production environment; it must be non-production (the gate hard-blocks prod).

### A5 · Run steps (dry-run / preflight first; exact values redacted)
- [ ] **Preflight (INERT launcher — built):** run the operator pre-flight, which assembles nothing and runs no exchange:
      `CONNECTOR_OAUTH_REAL_EXCHANGE_ENABLED=1 node scripts/run-gate-a-b2c-real-exchange-launcher.mjs --confirm="RUN B2C FIRST REAL TOKEN STAGING" --app-env=staging --redirect-uri=https://idcaddie-v3.vercel.app/connectors/oauth/callback`
      — it REFUSES unless: staging ref (`ycdpzduxugdsffjqyoai`, prod hard-blocked), gate ON + non-prod, exact confirm phrase,
      `--app-env=staging`, exact staging redirect URI, and no secret/code/token/DB-URL in argv or env; then it emits the
      procedure. It VERIFIES the gate is OFF by default / ON only non-prod, the `oauth_pending` replay consumer is wired,
      the `payload.corr == oauth_pending.state_jti` correlation holds (key identity + the atomic multi-field WHERE, now
      guarded fail-closed on an empty corr), and that a real exchange cannot run without the durable pending row.
- [ ] **Approval phrase (exact):** `RUN B2C FIRST REAL TOKEN STAGING` — recorded with the "Sam GO".
- [ ] **The launcher is pre-flight ONLY.** The actual exchange is a SEPARATE, explicitly-Sam-approved step that assembles
      the real deps via `makeRealOrchestratorDeps` (gated) with the Slack DEV app `client_id`, the server-trusted
      `expectedContext` (from the `oauth_pending` lookup), and the config redirect URI — **no client secret / token / DB
      URL on the command line**; the browser callback route stays synthetic and is NOT wired to the real path.
- [ ] Complete ONE authorize → callback with the DEV workspace; do not retry a consumed state.

### A6 · Evidence to collect (PASS/FAIL + safe metadata only)
- [ ] **OAuth state consumed exactly once** (the `oauth_pending` row flips to consumed).
- [ ] **Token exchange succeeded** (redacted result: `ok`, a `secretId` ref — never the token).
- [ ] **`connector_secrets` row written envelope-only** — ciphertext columns only, no plaintext column.
- [ ] **No plaintext token in logs** (run the log plaintext scan — expect zero hits).
- [ ] **Lifecycle/audit rows**: `connector_secret.store.attempted` → `store.succeeded`.
- [ ] **Replay attempt fails closed** — re-presenting the same state returns `already_consumed`, stores nothing.
- [ ] **Row scoped to the correct tenant/connector** (the validated payload's tenant/connector, not any query decoy).

### A7 · Stop conditions (abort + record a finding; do not proceed)
- Any plaintext (token / client secret / code / DB URL) in logs or output.
- Wrong Slack workspace/app (not the disposable DEV one).
- The production ref appears anywhere, or any production identity is used.
- A required migration (`0039`) is missing / the role shape is wrong.
- KMS/IAM separation was not verified (docs/49 not green).
- A duplicate token row appears, or a **replay is accepted** (state reused successfully).

### A8 · What success does NOT mean
- It does **not** close RISK-007 on its own (audited access/use + rotation/revocation + lifecycle remain).
- It does **not** unblock Phase C on its own (a separate decision).
- It does **not** prove all providers — it is one provider (Slack), one disposable workspace, staging only.

---

## Checklist B — RUN GATE B: hosted decrypt/use + rotation/revocation

### B1 · Preconditions
- [ ] A **B2c-created `connector_secrets` row exists** (RUN GATE A completed) for the target tenant/connector/version.
- [ ] The connector-runner **decrypt/use one-shot mode is built and PINNED** (image/commit recorded; `vendor:verify`
      green against the pinned v3 SHA).
- [ ] **Task-definition + IAM prerequisites verified** (idcaddie-connector-runner `deploy/DECRYPT_USE_IAM.md`): task role
      has `kms:Decrypt` on the vault CMK + the `0029/0030/0032` column-scoped read; **execution role unchanged**; roles
      separate; DB URL injected via Secrets Manager (never inline).
- [ ] **Explicit "Sam GO"** obtained immediately before the run.
- [ ] Staging only; production ref forbidden; RISK-007 OPEN / Phase C BLOCKED acknowledged.

### B2 · Decrypt/use proof
- [ ] The runner **decrypts the envelope under the TASK ROLE** (runner-only capability) and USES it.
- [ ] It **emits a redacted proof only** (identifiers + non-reversible fingerprint + byte length) — **no plaintext token
      printed** anywhere.
- [ ] The **web/request path remains DENIED** decrypt (re-confirm via the KMS/IAM verifier or the recorded matrix).

### B3 · Rotation proof
- [ ] A **rotated token is stored envelope-only** as a new version.
- [ ] The **prior version is inactive/replaced** per the lifecycle model (the lifecycle-aware load returns the active
      version; superseded versions are excluded).
- [ ] A **lifecycle/audit event is recorded** for the rotation.

### B4 · Revocation proof
- [ ] The **revoke/tombstone flow runs** for a target version.
- [ ] A **post-revoke decrypt/use FAILS SAFELY** (the lifecycle-aware load excludes revoked/tombstoned; the runner fails
      closed with a static reason, no plaintext).
- [ ] A **lifecycle/audit event is recorded** for the revocation.

### B5 · Evidence to collect (safe metadata only)
- [ ] **Task ARN + exit code** of the one-shot decrypt/use task.
- [ ] The **redacted outcome** line (fingerprint + byte length + use result) — never the token.
- [ ] **DB row metadata only** (ids, version, status, lifecycle_event_type) — no ciphertext dump, no plaintext.
- [ ] **Log plaintext scan** result (expect zero token/secret hits).
- [ ] **KMS/IAM metadata / verdicts** (the separation matrix still green; the decrypt happened under the task role).

### B6 · Stop conditions (abort + record a finding)
- Any plaintext leak (token / key material) in logs, output, or errors.
- Any **broad DB grant** discovered (e.g. `SELECT *` / non-column-scoped / a grant beyond `0029/0030/0032`).
- The **wrong role** performs the decrypt (web/request/execution role instead of the task role).
- A row for the **wrong tenant** is read/written.
- **Production** is touched in any way.
- **Revoke fails unsafe** (a revoked/tombstoned version still decrypts/uses).

### B7 · What success does NOT mean
- It still needs the **RISK-007 closure review + register PR** (docs-only) before RISK-007 can change state.
- **Phase C unblock is SEPARATE** — its own explicit decision after closure, never implied by a green run.
