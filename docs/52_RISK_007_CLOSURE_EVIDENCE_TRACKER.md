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
| 3 | Hosted migrations/grants applied + verified | **PARTIAL** | `0029` runner-secret grants hosted-verified staging + production (register) | Apply/verify **`0039`** on hosted staging; confirm broader per-tenant grants | human operator | Stop: any broad grant / `SELECT *` / grant beyond `0029/0030/0032` |
| 4 | `connector_runner_login` versioned + hosted-verified | **PARTIAL** | Versioned migration `0039` (#225) + hosted-safe repair (#226); T57 asserts the full secure shape in CI | Hosted **apply + verify** `0039` on staging (role shape per T57) | agent-buildable (versioned ✓) → human operator (hosted verify) | Password stays operator-set out-of-band; never committed |
| 5 | KMS/IAM separation verified in hosted env | **BLOCKED (pending rerun)** | Verifier **built** (#227, docs/49) — matrix logic + selftests green; **NO_WEB_AWS_PRINCIPAL mode added** (docs/49 mode B) after hosted preflight found **no web/request AWS role exists by design** (v3 web = Vercel + Supabase RLS). Preflight (2026-07-03, staging acct `833822972703`/ca-central-1): vault alias/CMK, decoy CMK, DB-URL & connector secret ARNs collected; only `…-connector-runner-exec` + `…-slack-taskread` roles exist. No secret read, no decrypt, no get-secret-value, no ECS, no production. **Two mode-B reruns surfaced `iam:SimulatePrincipalPolicy`+KMS-key-policy limitations, now resolved by evidence-model change:** (a) 5e4950c — `ResourceNames … not a valid ARN: *` (key policy `Resource:"*"`); (b) 96270e1 — `Invalid caller — Caller is not present and cannot be implied from policySourceArn` (a **role** principal cannot be simulated against a KMS key policy via `--resource-policy`). Root fix: **KMS rows now use STRUCTURAL key-policy analysis** (`kms:GetKeyPolicy` metadata → `evaluateKeyPolicyAccess`; allowed/denied/overbroad/error), not simulation; Secrets-Manager rows still simulate; web=no_web; alias unchanged. Web/secret/alias rows already passed on the hosted reruns. | **Rerun** the verifier hosted with `CONNECTOR_VAULT_WEB_ROLE_ARN=NONE` (docs/49 mode B) after the structural-KMS fix → record the matrix green incl. `web=no_web_aws_principal`, the KMS rows evidenced from the key policy, + the 3 evidence anchors | human operator | Stop: web/request (if a role existed) OR exec role granted KMS; task granted the decoy; wildcard/root KMS grant (`overbroad`); wrong alias; **NOT yet a final PASS** |
| 6 | First real B2c token exchange (staging) | **PENDING** | Real-exchange wiring **built + gated** (#228, docs/50) — synthetic-proven | **RUN GATE A** (docs/51 Checklist A): disposable Slack DEV workspace, staging | explicit Sam GO | Stop: wrong workspace/app; production ref; missing `0039`/KMS-IAM verify |
| 7 | Per-tenant `connector_secrets` token stored envelope-only | **PENDING** | Store path built + synthetic-proven (#228); **one app-level** Slack client secret ingested envelope-only (#16) — app-level only, **not** per-tenant | RUN GATE A stores a real per-tenant token envelope-only (ciphertext columns only) | explicit Sam GO | Stop: any plaintext column; wrong-tenant row; duplicate token row |
| 8 | No plaintext token in logs/errors/results | **PARTIAL** | Synthetic-proven across the code + tests (redacted proof only; no-leak assertions; `check-no-real-tokens`) | Hosted **log plaintext scan** at RUN GATE A + B → zero hits | explicit Sam GO | Stop: ANY plaintext (token/secret/code/DB URL) in logs/output |
| 9 | Replay / state reuse denied | **PARTIAL** | Synthetic-proven: durable replay gate (#228) — reused state → `already_consumed`, stores nothing | Hosted replay attempt at RUN GATE A fails closed | explicit Sam GO | Stop: a replay is accepted (state reused successfully) |
| 10 | Runner decrypt/use proof | **PENDING** | Harness **built** (#224) + guarded runner mode (#18) — synthetic-proven | **RUN GATE B** (runner `DECRYPT_USE_RUN_CHECKLIST.md`): decrypt under the task role → redacted proof | explicit Sam GO | Stop: plaintext printed; wrong role decrypts |
| 11 | Web/request path decrypt DENIED | **PARTIAL** | KMS/IAM verifier (#227) + design boundary (runner-only capability; server-only); **stronger than a denied role** — the web/request runtime has **no AWS principal at all** (no role in `833822972703`; CI import boundary bars KMS/Secrets-Manager on the request path; token source hard-throws) | Hosted denial recorded via docs/49 **mode B** (`web=no_web_aws_principal` + 3 anchors) at criterion 5 rerun; RUN GATE B for the runner side | human operator / Sam GO | Load-bearing negative; stop if any web/request AWS principal appears OR can decrypt |
| 12 | Rotation exercised end-to-end | **PENDING** | Lifecycle model built (`0032/0033`, lifecycle helpers) | **RUN GATE B**: rotated token stored envelope-only, prior version superseded, audit row | explicit Sam GO | Stop: prior version still active after rotation |
| 13 | Revocation / tombstone exercised | **PENDING** | Lifecycle events `0032` + INSERT grant `0033` + revoke/tombstone helpers built | **RUN GATE B**: revoke/tombstone runs; **post-revoke decrypt/use fails safely**; audit row | explicit Sam GO | Stop: a revoked/tombstoned version still decrypts (fails unsafe) |
| 14 | Lifecycle/audit rows verified | **PARTIAL** | Audit builder + atomic store audit built + synthetic-tested (`secret-audit*`) | Hosted rows verified at RUN GATE A (`store.*`) + B (rotation/revocation events) | explicit Sam GO | Metadata only; never plaintext in audit `after_json` |
| 15 | Source staging Slack secret permanent deletion (after 2026-07-10) | **PENDING** | Scheduled `delete-secret --recovery-window-in-days 7` (2026-07-03); proven unreadable (#16, docs/48) | **Confirm permanent deletion** of `/idcaddie/staging/slack/oauth-client-secret` after the `2026-07-10` window | human operator | Metadata ops only; never `get-secret-value`; do not force-delete before the window |
| 16 | Production not touched until explicitly approved | **DONE (ongoing invariant)** | Production ref `dzbfxulvxchdemcettrx` hard-blocked in every gate/ingest guard; no production apply/run occurred | Keep enforced through every gate | human operator (invariant) | Stop the moment any production identity/ref/apply appears |
| 17 | First-real-token / B2c / decrypt-use evidence recorded in docs | **PENDING** | — (no run yet → nothing to record) | After RUN GATE A/B: a **docs-only evidence PR** (redacted, PASS/FAIL, safe metadata) | agent-buildable **after** the runs | Do not record evidence for a run that has not happened |
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

## Current pending human gates (in execution order — docs/51)
1. **Apply/verify `0039` on hosted staging** (criteria 3, 4).
2. **Rerun the KMS/IAM separation verifier** hosted in **NO_WEB_AWS_PRINCIPAL mode** (`CONNECTOR_VAULT_WEB_ROLE_ARN=NONE`, docs/49 mode B) — the web/request runtime has no AWS principal by design; record `web=no_web_aws_principal` + the 3 anchors (criteria 5, 11). *Currently blocked pending this rerun — not a final PASS.*
3. **RUN GATE A** — first real B2c token exchange, staging, disposable Slack DEV workspace (criteria 6, 7, 8, 9, 14).
4. **RUN GATE B** — hosted decrypt/use + rotation/revocation (criteria 10, 11, 12, 13, 14).
5. **Permanent-deletion follow-up** after 2026-07-10 (criterion 15).

Then: record evidence (criterion 17, docs-only) → draft the RISK-007 closure register PR (criterion 18) → Phase C unblock
as a separate decision (criterion 19).

## Explicit non-goals of THIS PR
- **Does not close RISK-007** — it stays OPEN.
- **Does not unblock Phase C** — it stays BLOCKED.
- **Does not claim production readiness.**
- **Does not claim** any first-real-token / B2c / decrypt-use / rotation / revocation run has happened — those are all
  PENDING on the human gates above.
