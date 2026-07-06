# 52 · RISK-007 closure-criteria evidence tracker

**Tracker only — NOT the closure PR.** This lists every RISK-007 closure criterion, its current evidence status, the proof
still required, who runs it, and where the evidence is recorded. It **does not close RISK-007 and does not unblock Phase
C** — both are separate explicit human decisions (criterion 18/19). **RISK-007 remains OPEN; Phase C remains BLOCKED.**

Canonical criteria source: the RISK-007 row in [docs/04](./04_RISK_REGISTER.md). Design: [42](./42_CONNECTOR_CREDENTIAL_VAULT_DESIGN.md)
/ [44](./44_CONNECTOR_CREDENTIAL_REAL_TOKEN_THREAT_MODEL.md). Evidence inventory: [48](./48_TEST_AND_EVIDENCE_INVENTORY.md).
Gate checklists: [51](./51_RUN_GATES_A_B_PRERUN_CHECKLISTS.md) + connector-runner `docs/DECRYPT_USE_RUN_CHECKLIST.md`.

**Status legend:** DONE · PARTIAL (built/synthetic-proven, hosted proof pending) · PENDING (not yet done) · BLOCKED
(gated on a separate decision). **Execution mode:** agent-buildable · human operator · explicit Sam GO.

## Closure-criteria table

| # | Closure criterion | Status | Evidence (if done) | Required next evidence (if pending) | Execution mode | Notes / stop conditions |
|---|---|---|---|---|---|---|
| 1 | Encrypted credential store implemented | **DONE** | Migrations `0017`–`0038` (two-tier `connector_secrets` DENY-ALL envelope store + `connector_app_secrets` + `connector_secret_lifecycle_events` + `oauth_pending`); ~79 files in `src/lib/server/connector-vault/`; design [42](./42_CONNECTOR_CREDENTIAL_VAULT_DESIGN.md) | — | agent-buildable (done) | Vault-ref-not-secret; redacted metadata; no service-role on request paths |
| 2 | §8 connector RLS/grant tests green | **DONE** | `T38`–`T58` green in the CI RLS suite (`supabase/tests/org_rls_test.sql`); enforced every PR | — | agent-buildable (done) | Extended by T57 (login-chain) this cycle |
| 3 | Hosted migrations/grants applied + verified | **DONE — hosted staging (Step 1, 2026-07-03)** | `0029` runner-secret grants hosted-verified staging + production (register). **Step 1 staging apply/verify:** `supabase db push --linked` applied `0036`–`0040` (resolver natural keys / `manual_sync_runs` / active-lock / `connector_runner_login` provision / app-user absence fields) to staging ref `ycdpzduxugdsffjqyoai`; production ref `dzbfxulvxchdemcettrx` **not** linked/touched. Post-apply migration list = **0001–0040 Local = Remote**. Schema verified: `app_users.last_seen_at` present; `app_users.sync_status` present, default `active`, NOT NULL; `manual_sync_runs.app_users_marked_stale` present, default `0`, NOT NULL (0040). `connector_runner_login` **direct table grants = 0** (no broad grant / `SELECT *` / grant beyond `0029/0030/0032`). Existing envelope row intact (1 app-level staging Slack `oauth_client_secret` row; **no secret value read/printed**). No AWS, no ECS, no `GetSecretValue`, no KMS decrypt/`GenerateDataKey`, no OAuth/token, no production. | **Recorded (this row).** Staging apply/verify evidence only — does **not** close RISK-007. | human operator (done) | Stop: any broad grant / `SELECT *` / grant beyond `0029/0030/0032` — none (0 direct grants) |
| 4 | `connector_runner_login` versioned + hosted-verified | **DONE — hosted staging (Step 1, 2026-07-03)** | Versioned migration `0039` (#225) + hosted-safe repair (#226); T57 asserts the full secure shape in CI. **Hosted staging apply + verify (Step 1, ref `ycdpzduxugdsffjqyoai`):** `0039` applied; `connector_runner_login` role shape verified per T57 — `rolcanlogin=true`, `rolinherit=false`, `rolsuper=false`, `rolcreatedb=false`, `rolcreaterole=false`, `rolreplication=false`, `rolbypassrls=false`; `pg_has_role(connector_runner_login, connector_runner, 'SET')=true`, `…'USAGE')=false`; direct table grants = 0. Password stays operator-set out-of-band (never committed; not in this evidence). No secret value read; no production touched. | **Recorded (this row).** Staging role-shape evidence only — does **not** close RISK-007. | human operator (done) | Password stays operator-set out-of-band; never committed |
| 5 | KMS/IAM separation verified in hosted env | **DONE — hosted staging PASS (2026-07-04)** | Verifier built (#227) + NO_WEB mode (#237) + structural key-policy KMS model (#239, after `iam:SimulatePrincipalPolicy`+key-policy proved unusable for a **role** principal across two reruns: `ResourceNames … not a valid ARN: *`, then `Invalid caller — cannot be implied from policySourceArn`). **Hosted staging PASS** — acct `833822972703`/ca-central-1, caller `sam-cli`, mode B (`CONNECTOR_VAULT_WEB_ROLE_ARN=NONE`). The default account-root "Enable IAM" delegation on both CMKs read **`overbroad`** (correctly — root delegation is not key-policy separation); **both key policies were tightened to least-privilege**: vault `alias/idcaddie-staging-connector-vault` — admin/manage = `sam-cli` + new durable `idcaddie-staging-kms-admin` role; runtime-use = `idcaddie-staging-slack-taskread` for `kms:Decrypt`+`kms:GenerateDataKey` only. Decoy `alias/idcaddie-staging-kek` — admin/manage only, **no** runtime-use. Both: **no root, no wildcard/bare-account principal, no exec-role KMS, no KMS grants** (none pre-existed; Access Analyzer returned no findings). **Final matrix = `ALL SEPARATION CHECKS PASS`:** task→vault `Decrypt`/`GenerateDataKey` allowed; task→decoy `Decrypt`/`GenerateDataKey` denied; exec→vault `Decrypt` denied; web `Decrypt` = `no_web_aws_principal`; SM DB-URL secret allowed(exec) / connector secret denied(exec) / connector secret allowed(task); alias = match. Negatives: **NO** `kms:Decrypt`/`GenerateDataKey` executed, **NO** `GetSecretValue` value read, **NO** ECS, **NO** DB, **NO** production, **NO** secret/DB-URL/token/ARN printed. | **Recorded (this row).** Hosted evidence for the **KMS/IAM separation boundary on staging only** — it does **NOT** close RISK-007 (audited secret access/use, rotation/revocation, lifecycle remain). Next human gate: **RUN GATE A**. | human operator (done) | Load-bearing denials held: exec + decoy denied, no wildcard/root grant, correct alias — staging only, not a production claim |
| 6 | First real B2c token exchange (staging) | **DONE — hosted staging (RUN GATE A, 2026-07-04)** | RUN GATE A ran once on ECS: the runner exchanged the one-time Slack OAuth code for a bot token (real Slack call succeeded). `oauth_pending` consumed **exactly once** (`state_jti` = corr `ef00ea32-df37-4979-8fc0-0b16bbfefc88`); one-time code secret + per-run task-role grant removed after; image digest-pinned `@sha256:76266bc8…`. No plaintext token/code logged. Redacted evidence: connector-runner `docs/STAGING_LIVE_RUN_EVIDENCE.md` §8. | **Recorded (this row).** Staging RUN GATE A exchange only — does **not** close RISK-007 (criteria 9/12/13/15 remain). | explicit Sam GO (done) | Staging only (`ycdpzduxugdsffjqyoai`); production not touched |
| 7 | Per-tenant `connector_secrets` token stored envelope-only | **DONE — hosted staging (RUN GATE A, 2026-07-04)** | One real **per-tenant** token stored **envelope-only**: row `c606b52a-6b93-46aa-9f94-745334691a7b`, tenant `aaaa1111-1111-1111-1111-111111111111`, connector `1575cde3-a392-4927-b4c5-1bb8342a5715`, DB `secret_kind=oauth_access`, version 1, active; ciphertext columns only (no plaintext column); audit `store.attempted`→`store.succeeded`. Evidence: runner `STAGING_LIVE_RUN_EVIDENCE.md` §8. | **Recorded.** Staging only — does not close RISK-007. | explicit Sam GO (done) | Envelope-only; ids are row identifiers, not secret values |
| 8 | No plaintext token in logs/errors/results | **DONE — hosted staging (RUN GATE A + decrypt/use, 2026-07-04)** | Hosted log plaintext scan at the RUN GATE A exchange **and** the decrypt/use run: **zero hits**; only redacted proof lines (kind/version/bytes/SHA-256 fingerprint). Synthetic no-leak assertions + `check-no-real-tokens` remain in CI. Evidence: runner `STAGING_LIVE_RUN_EVIDENCE.md` §8–§9, §11. | — (RUN GATE B Gate 2D redaction scan clean, 2026-07-06; "no obvious secret-shaped data") | explicit Sam GO | Stop: ANY plaintext (token/secret/code/DB URL) in logs/output |
| 9 | Replay / state reuse denied | **DONE — hosted staging (Gate 3A read-only + Gate 3E hosted replay-check, 2026-07-05/06)** | **Gate 3A (read-only, staging `ycdpzduxugdsffjqyoai`):** the RUN GATE A v2 `oauth_pending` row (`state_jti fa6e77bf…`, provider `slack`, connector `1575cde3…`) reads `consumed=true`, `expired=true`, `consumed_at 2026-07-05 22:36:12.965+00`, `expires_at 2026-07-05 22:38:36.224+00`; the consume SQL requires `consumed_at is null and expires_at > now`, so any re-consume matches **0 rows**; local replay tests pass (v3 `oauth-pending-consume` + `run-gate-a-authorize`; runner `run-gate-a`). **Gate 3E (hosted, image `@sha256:8cf95593…395aaa`, task `b32c95d2…`, exit 0):** a consume-only replay-check attempted the atomic consume against that already-consumed state and **FAILED CLOSED as `already_consumed`** — `result=already_consumed no_slack=true no_store=true no_code=true redacted=true`; log scan **0**; temporary task-def deregistered. **NO Slack, NO OAuth code, NO KMS, NO token store, NO connector_secrets write, NO v3.** Evidence: runner `STAGING_LIVE_RUN_EVIDENCE.md` §12. | **Recorded.** Replay/state-reuse denied — single-use held (3A) + explicit hosted `already_consumed` (3E). Staging only. | explicit Sam GO (done) | Stop: a replay is accepted (state reused successfully) — did NOT happen |
| 10 | Runner decrypt/use proof | **DONE — hosted staging (2026-07-04)** | The stored `connector_secrets` `oauth_access` v1 row was decrypted via KMS under the **runner-only** decrypt capability and used from ECS (exit 0): `kind=oauth_access_token version=1 bytes=59 fingerprint=5364c1fb…754 use=true(runner-decrypt-verified)`; then a real Slack `auth.test` returned **200 ok** (`use=true(slack-auth-test:200:ok)`). **No plaintext token logged** (`fingerprint` is a SHA-256 digest, not the token). Evidence: runner `STAGING_LIVE_RUN_EVIDENCE.md` §9. | **Recorded.** Decrypt/use proven; rotation/revocation are criteria 12/13 (RUN GATE B). | explicit Sam GO (done) | Staging only; wrong role cannot decrypt |
| 11 | Web/request path decrypt DENIED | **DONE — hosted staging (web side), 2026-07-04** | Hosted verifier (criterion 5) recorded `web kms:Decrypt → no_web_aws_principal` **PASS** in mode B: the web/request runtime has **no AWS principal** — the staging IAM role list shows only `idcaddie-staging-connector-runner-exec`, `idcaddie-staging-slack-taskread`, `idcaddie-staging-kms-admin` (no web/request role). Stronger than a denied role (no principal → cannot authenticate to AWS); CI import boundary bars KMS/Secrets-Manager on the request path; token source hard-throws. | Web side **recorded (staging)**. Runner-side decrypt/use is criterion 10 (**RUN GATE B**). | human operator (done, web side) | Load-bearing negative; stop if any web/request AWS principal appears OR can decrypt — staging only |
| 12 | Rotation exercised end-to-end | **DONE — hosted staging (RUN GATE B, 2026-07-06)** | Gate 2A stored a successor `oauth_access` **v2** envelope-only (secret id `636a65ff…`, corr `fa6e77bf…`; `store.attempted`→`succeeded` 2026-07-05 22:36:13Z; one-shot code secret + IAM grant cleaned; no plaintext). Gate 2C **superseded v1** (a `revoked` lifecycle event, reason `superseded`, actor `connector_runner`, 2026-07-06 00:21:58Z). Gate 2D proved the prior version unusable + v2 usable. Evidence: runner `STAGING_LIVE_RUN_EVIDENCE.md` §11. **HONEST SCOPE:** v2 wraps the **SAME underlying Slack token** as v1 (identical SHA-256 fingerprint `5364c1fb…754`) — Slack `oauth.v2.access` re-issued the existing token for the already-installed DEV app — so this exercised the **vault-version rotation + supersede + revoke lifecycle**, NOT a provider-side token change (a new bot token was not forced). | **Recorded.** Vault rotation lifecycle proven on staging; a provider-side token rotation (new bot token) was not exercised (Slack re-issued the same token). **DECISION (2026-07-06, Sam):** for staging RISK-007 closure the proven **vault-version rotation/supersede/revoke lifecycle is SUFFICIENT for criterion 12** — RUN GATE B created + stored + used v2, revoked v1 as superseded, and Gate 2D proved v1 fails closed while v2 stays usable. A **provider-side new-token rotation is FUTURE HARDENING** (not a closure blocker) unless separately required; Slack `auth.revoke` stays **deferred** because v1/v2 share the same provider token (revoking now would likely kill the active v2). | explicit Sam GO (done) | Prior version unusable after supersede — verified (Gate 2D). Staging only. |
| 13 | Revocation / tombstone exercised | **DONE — hosted staging (RUN GATE B, 2026-07-06)** | Gate 2C revoked v1 via `run-gate-b-revoke-task.js` (exit 0; corr `run-gate-b-revoke-v1-superseded-20260706T002136Z`; redacted `revoked_version=1 lifecycle_event=revoked reason=superseded`). One lifecycle row (version 1, `revoked`, `superseded`, `connector_runner`, 2026-07-06 00:21:58Z); `v1_revoked_once=true`; v2 not revoked/tombstoned. **Gate 2D — v1 decrypt/use FAILS CLOSED** (`version=1 read=false reason=revoked_or_unreadable`), **v2 still usable** (Slack `auth.test` 200 ok); redaction scan clean. Evidence: runner `STAGING_LIVE_RUN_EVIDENCE.md` §11. **Provider-side Slack `auth.revoke` was NOT performed — a SEPARATE operator step; and correctly so here, because v1 and v2 share the same Slack token (revoking it at Slack would also kill the active v2).** | **Recorded.** DB revocation + post-revoke fail-closed proven on staging. | explicit Sam GO (done) | Post-revoke decrypt fails closed — verified. Provider-side auth.revoke deferred (shared token); required only if v1's token must die at Slack. |
| 14 | Lifecycle/audit rows verified | **DONE — hosted staging (store + revocation, 2026-07-04/06)** | RUN GATE A `store.attempted`→`store.succeeded` verified (v1 2026-07-04; v2 2026-07-05 22:36:13Z). RUN GATE B: the `revoked`/`superseded` `connector_secret_lifecycle_events` row + the revoke audit rows verified (2026-07-06 00:21:58Z). All metadata only; no plaintext in `after_json`. | — | explicit Sam GO (done) | Metadata only; never plaintext in audit `after_json` |
| 15 | Source staging Slack secret permanent deletion (after 2026-07-10) | **PENDING** | Scheduled `delete-secret --recovery-window-in-days 7` (2026-07-03); proven unreadable (#16, docs/48) | **Confirm permanent deletion** of `/idcaddie/staging/slack/oauth-client-secret` after the `2026-07-10` window | human operator | Metadata ops only; never `get-secret-value`; do not force-delete before the window |
| 16 | Production not touched until explicitly approved | **DONE (ongoing invariant)** | Production ref `dzbfxulvxchdemcettrx` hard-blocked in every gate/ingest guard; no production apply/run occurred | Keep enforced through every gate | human operator (invariant) | Stop the moment any production identity/ref/apply appears |
| 17 | First-real-token / B2c / decrypt-use evidence recorded in docs | **PARTIAL — RUN GATE A + decrypt/use + RUN GATE B recorded (2026-07-04/06)** | Redacted evidence recorded: connector-runner `docs/STAGING_LIVE_RUN_EVIDENCE.md` §8 (exchange + envelope store) + §9 (decrypt/use + Slack `auth.test`) + §11 (RUN GATE B rotation/revocation); this tracker rows 6/7/8/10/12/13/14. | Only criterion 15 (permanent source-secret deletion after 2026-07-10) evidence remains | agent-buildable **after** the runs | Do not record evidence for a run that has not happened |
| 18 | RISK-007 closure register PR prepared only after all required evidence exists | **PENDING** | — (**this tracker is NOT that PR**) | Draft the closure register update once criteria 3–15 are recorded green | agent-buildable **after** all evidence | Do not flip RISK-007 to closed here or in any run PR |
| 19 | Phase C unblock remains SEPARATE | **BLOCKED (separate decision)** | — | An explicit human decision **after** RISK-007 closure — never bundled with a run or this tracker | explicit Sam GO | Never imply Phase C unblock from a green run |

## Current completed evidence (recorded)
- **Staging app-level Slack client-secret envelope ingest — SUCCESS** (envelope-only), via the separate connector-runner
  (**PR #16**; recorded by risk milestone **PR #220**). App-level only — **not** per-tenant customer credentials.
- **Source Slack SM secret** scheduled for deletion (`--recovery-window-in-days 7`, 2026-07-03) and **proven unreadable**
  post-cleanup (PR #16; [docs/48](./48_TEST_AND_EVIDENCE_INVENTORY.md)).
- **Evidence PR #16** (connector-runner live-run evidence + cleanup proof); **risk milestone PR #220**; **docs
  reconciliation PR #221**.
- **Build PRs (synthetic-proven, merged):** v3 #224 (decrypt/use harness), runner #18 (guarded decrypt/use mode), v3
  #225/#226 (`0039` login-chain DDL + hosted-safe repair), v3 #227 (KMS/IAM verifier), v3 #228 (B2c real-exchange wiring).
- **Gate checklists (merged):** v3 #229 (RUN GATE A/B, docs/51), runner #19 (`DECRYPT_USE_RUN_CHECKLIST.md`).
- **RUN GATE A — hosted staging SUCCESS (2026-07-04):** first real B2c Slack OAuth exchange; per-tenant bot token stored
  **envelope-only** in `connector_secrets` (row `c606b52a…`, tenant `aaaa1111…`, connector `1575cde3…`, `oauth_access` v1);
  `oauth_pending` consumed once (`state_jti`=corr `ef00ea32…`); `store.attempted`→`store.succeeded`; log scan zero hits;
  one-time code secret + per-run grant removed. Records **criteria 6, 7, 8** (+ store-side 14). Evidence: runner
  `docs/STAGING_LIVE_RUN_EVIDENCE.md` §8. **Staging only; does not close RISK-007.**
- **Runner decrypt/use + Slack auth.test — hosted staging SUCCESS (2026-07-04):** the stored row decrypted via KMS under
  the runner-only capability and used for a real Slack `auth.test` (**200 ok**), no plaintext token logged. Records
  **criterion 10**. Evidence: runner `STAGING_LIVE_RUN_EVIDENCE.md` §9. (Runner deploy fix: `Dockerfile` `COPY decrypt-use-task.ts`.)
- **RUN GATE B rotation/revocation — hosted staging SUCCESS (2026-07-05/06):** Gate 2A stored a successor `oauth_access`
  **v2** envelope-only (id `636a65ff…`); Gate 2B proved v2 usable (Slack `auth.test` 200 ok); Gate 2C **revoked v1**
  (reason `superseded`, one `revoked` lifecycle row, `connector_runner`, 2026-07-06 00:21:58Z); Gate 2D proved **v1
  fails closed** (`read=false reason=revoked_or_unreadable`) while **v2 stays usable**; redaction scan clean. All four
  ECS tasks exit 0; temporary task-defs deregistered. Records **criteria 12, 13, 14-events**. Evidence: runner
  `STAGING_LIVE_RUN_EVIDENCE.md` §11. **HONEST SCOPE:** v2 wraps the **same Slack token** as v1 (identical fingerprint) —
  Slack re-issued the existing token — so this proved the **vault-version rotation/supersede/revoke lifecycle**, not a
  provider-side token change; **provider-side Slack `auth.revoke` was NOT performed** (a separate step, and correctly
  deferred since v1/v2 share the token). **Staging only; does not close RISK-007.**
- **Criterion 9 replay/state-reuse — hosted staging DONE (2026-07-05/06):** **Gate 3A** (read-only) confirmed the RUN GATE A
  v2 `oauth_pending` row is `consumed_at`-set + expired, and the consume SQL (`consumed_at is null and expires_at > now`)
  makes a re-consume a 0-row no-op; **Gate 3E** ran a consume-only replay-check one-shot on ECS (image `@sha256:8cf95593…`,
  task `b32c95d2…`, exit 0) that attempted the atomic consume against the consumed state and **failed closed as
  `already_consumed`** (`no_slack=true no_store=true no_code=true`; log scan 0; task-def deregistered). No Slack / OAuth code /
  KMS / token store / connector_secrets write / v3. Records **criterion 9**. Evidence: runner `STAGING_LIVE_RUN_EVIDENCE.md`
  §12. **Staging only; does not close RISK-007.**

## Current pending human gates (in execution order — docs/51)
1. ~~Apply/verify `0039` on hosted staging~~ **✅ DONE (Step 1, 2026-07-03)** — `0036`–`0040` applied to staging (`ycdpzduxugdsffjqyoai`), migration list `0001–0040 Local = Remote`, `connector_runner_login` role shape verified (T57), 0 direct grants (criteria 3, 4 recorded above). Staging apply/verify only — **does not close RISK-007**.
2. ~~Rerun the KMS/IAM separation verifier hosted in NO_WEB_AWS_PRINCIPAL mode~~ **✅ DONE (2026-07-04)** — hosted staging `ALL SEPARATION CHECKS PASS` after least-privilege tightening of both CMK key policies (criteria 5, 11 recorded above). Staging KMS/IAM separation evidence only — **does not close RISK-007**.
3. ~~**RUN GATE A** — first real B2c token exchange, staging~~ **✅ DONE (2026-07-04)** — real exchange + envelope-only
   store (criteria 6, 7, 8 recorded; store-side 14). Staging only — **does not close RISK-007**.
4. ~~**RUN GATE B** — hosted rotation/revocation~~ **✅ DONE (2026-07-05/06)** — criteria 12, 13, 14-events recorded above.
   Staging only — **does not close RISK-007**. (Vault-version rotation lifecycle proven; provider-side token rotation NOT
   forced — Slack re-issued the same token — and provider-side `auth.revoke` deferred, see criteria 12/13.)
5. ~~**Gate 3 (Criterion 9)** — hosted replay/state-reuse denied~~ **✅ DONE (2026-07-05/06)** — Gate 3A read-only + Gate 3E
   hosted `already_consumed` (criterion 9 recorded above). Staging only — **does not close RISK-007**.
6. **Permanent-deletion follow-up** after 2026-07-10 (criterion 15). **← next open item.**

**Remaining before RISK-007 can close (criterion 18 gates on criteria 3–15 green):**
- **Criterion 15** — confirm permanent deletion of the source staging Slack secret after `2026-07-10`.
- **Provider-side Slack `auth.revoke`** for v1 — a separate operator step (deferred here because v1/v2 share the token); do it
  only if v1's token must be invalidated at Slack (which would also kill v2 until re-authorized).
- **Whether a provider-side token rotation (a genuinely new bot token) is required** for criterion 12, or the vault-version
  rotation suffices — a criterion-18 judgment.

Then: finish evidence (criterion 17) → draft the RISK-007 closure register PR (criterion 18, only after criterion 15 is green
+ the items above resolved; criteria 9/12/13/14-events are now DONE-staging) → Phase C unblock as a separate decision
(criterion 19).

## Remaining closure sequencing (2026-07-06 — planning only; does NOT close RISK-007)
Criteria 3–14 are DONE-staging. What remains, in the safe order (do NOT jump ahead of a gate):
1. **Criterion 15 — date-gated (`>= 2026-07-10`).** After the 7-day recovery window (scheduled `delete-secret`, 2026-07-03),
   confirm `/idcaddie/staging/slack/oauth-client-secret` is **permanently deleted** (Secrets Manager **metadata only** —
   e.g. `describe-secret` → `ResourceNotFound`; **never** `get-secret-value`). **Not actionable before 2026-07-10.**
2. **Criterion 12 — DECIDED (2026-07-06, Sam).** For staging RISK-007 closure the proven **vault-version
   rotation/supersede/revoke lifecycle is SUFFICIENT** (RUN GATE B: v2 created/stored/usable, v1 revoked as superseded, Gate 2D
   v1 fails closed + v2 usable). A **provider-side new-token rotation is FUTURE HARDENING** (not a closure blocker) unless
   separately required — Slack re-issued the same token, so RUN GATE B was not a provider-side rotation. See criterion 12 row.
3. **Provider-side Slack `auth.revoke` — DEFERRED; do NOT run now.** v1 and v2 **share the same provider token** (Slack
   re-issued it), so revoking now **would likely kill the active v2**. Only actionable once a genuinely new token exists
   (a real provider-side rotation) or on connector decommission.
4. **Criterion 18 — closure register (docs), only after 15 + 12 are resolved.** Draft the RISK-007 closure register; flipping
   RISK-007 to closed is a **deliberate, separate step** — not done here.
5. **Criterion 19 — Phase C unblock, only after 18.** A separate explicit Sam decision; never bundled with a run.
6. **`connectors.status` / `granted_scopes_safe` follow-up — decoupled.** A product decision on activation ownership; it
   **does NOT gate RISK-007 closure** and is tracked separately.

**RISK-007 remains OPEN; Phase C remains BLOCKED.** Staging only (`ycdpzduxugdsffjqyoai`); production (`dzbfxulvxchdemcettrx`)
untouched.

**Staging-run follow-ups (do NOT reopen RISK-007; do NOT gate closure on their own):**
- **Connector activation:** `connectors.status` is still `pending` and `granted_scopes_safe` is `NULL` after RUN GATE A —
  decide whether the OAuth exchange or the first sync owns connector activation.
- **`secret_kind` naming:** DB `connector_secrets.secret_kind` = `oauth_access` vs the vault context kind `oauth_access_token`
  — reconcile the naming (cosmetic; the decrypt/use proof matched correctly).

## Explicit non-goals of THIS PR
- **Does not close RISK-007** — it stays OPEN.
- **Does not unblock Phase C** — it stays BLOCKED.
- **Does not claim production readiness** — the RUN GATE A + decrypt/use proofs are **staging only**
  (`ycdpzduxugdsffjqyoai`); **production (`dzbfxulvxchdemcettrx`) was not touched** and is out of scope (criterion 16).
- **Does not claim a provider-side token rotation** — RUN GATE B (2026-07-05/06) exercised the **vault-version**
  rotation/supersede/revoke lifecycle (criteria 12/13/14-events, **DONE-staging**), but v2 wraps the **same Slack token** as
  v1 (Slack re-issued it), so a new provider bot token was **not** minted and provider-side `auth.revoke` was **not** run.
  The RUN GATE A/B exchanges, decrypt/use, and revocation **have** run on staging (2026-07-04/06) — recorded above.
