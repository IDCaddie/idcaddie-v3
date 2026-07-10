# 48 · Test & Evidence Inventory (cross-repo)

**Canonical, redacted inventory of what evidence exists, what each test/check proves, and what is still unproven** across
the two in-scope repos — `idcaddie-v3` (the app + canonical docs) and `idcaddie-connector-runner` (the separate one-shot
ECS/Fargate secret-ingest runner). Its purpose is to let an external reviewer orient quickly without needing hosted
credentials or a live run.

> **Posture (current, 2026-07-10):** **RISK-007 is CLOSED at its staging-defined criteria (R-018/#291). Phase C is UNBLOCKED as a governance state only (R-019/#292)** — C-2c staging live sync completed (connector-runner PR #36) (separate per-run Sam GO + clean Phase-2c readiness run required); the C-2c connector live data-sync ran on staging only (connector-runner PR #36, 2026-07-10); production untouched. Nothing here closes RISK-007,
> unblocks Phase C, or claims the first-real-token dry-run / B2c-run / decrypt-use / production / full-vault closure is
> complete. **No secret values, DB URLs, passwords, tokens, private keys, ciphertext, or KMS key IDs/ARNs appear in this
> file.** Dates are UTC.

---

## 1. Current evidence state (as of 2026-07-03)

| Item | Where | State |
|---|---|---|
| Staging Slack client-secret **live task-read → envelope ingest** | connector-runner **PR #16**, `docs/STAGING_LIVE_RUN_EVIDENCE.md` | **Succeeded once** (task exit 0), staging only |
| RISK-007 **partial-mitigation milestone** recorded | idcaddie-v3 **PR #220**, `docs/04_RISK_REGISTER.md` | Recorded; RISK-007 stays OPEN |
| RISK-007 / vault **stale-doc reconciliation** | idcaddie-v3 **PR #221** (`04`, `19`, `42`) | Docs now say "built + one slice proven; broader closure pending" |
| connector-runner **README reconciliation** | connector-runner **PR #17** | Status now reflects the one recorded live run |
| doc 02 **RLS count reconciliation** | idcaddie-v3 **PR #222** | `T1–T60`; live count deferred to doc 00 |

**RISK-007 remains OPEN. Phase C remains BLOCKED.**

---

## 2. Test inventory — idcaddie-v3

**RLS / authorization suite** — the load-bearing security tests.

- **File:** `supabase/tests/org_rls_test.sql` (plan: `supabase/tests/rls_test_plan.md`).
- **Range:** **T1–T60** (60 tests) — verified by counting `T<n>` in the file.
- **Assertion count:** doc-maintained; the canonical current figure lives in **`docs/00_PRODUCT_STATUS.md`** (**RLS suite 631 as of PR #181**). `scripts/test-rls.sh` emits no count itself — it runs the suite under `ON_ERROR_STOP=1` so any failed assertion fails the script/CI.
- **CI:** `.github/workflows/rls-tests.yml` runs `scripts/test-rls.sh` on a **throwaway Docker `postgres:16`** on every PR.
- **Major areas covered:** tenant isolation + org-scoped reads (T1–T35 era); connector-vault tenant isolation and the **deny-all secret boundary** (T38–T58): connector metadata isolation (T38), `connector_secrets` **DENY-ALL** + no readable secret column (T39), hardened `[SELECT]`-only grant surface (T40), append-only lifecycle + runner INSERT-only + atomicity rollback (T5x), `connector_app_secrets` request-path deny-all (T56), `connector_runner_login` minimal-privilege NOINHERIT/zero-grants (T57), resolver idempotent-upsert + cross-tenant write denial (T58).
- **What it PROVES:** the RLS/grant boundary — no logged-in (`authenticated`) user can read a secret; cross-tenant reads/writes are denied at the DB; the runner role is column-scoped and minimal.
- **What it does NOT prove:** hosted **KMS/IAM** separation; rotation/revocation exercised end-to-end; production behavior; anything about the live AWS path (that is the connector-runner evidence).

**Other v3 test/check surfaces**

- **App unit/integration tests:** `npm test` (vitest, ~74 `*.test.ts`), incl. heavy `src/lib/server/connector-vault/` coverage — e.g. `crypto.test.ts` proves AEAD encrypt→decrypt round-trip, AAD tenant/connector/kind/version binding, tamper + wrong-KEK rejection, and plaintext-never-in-error redaction **using an in-memory fake KEK** (NOT the real KMS CMK).
- **CI workflows:** `app-ci.yml` (lint / `vitest run` / `tsc --noEmit` / `runner:typecheck` / build), `rls-tests.yml`, `store-integration.yml` (local Supabase + PostgREST/RLS), `migration-safety.yml` (numbering + unsafe-keyword safety), `review-discipline.yml` (auth-safety, app↔runner import boundary, deploy-template inertness, runner-guard **self-tests**, docs-drift, no-real-tokens scan).
- **Runner guard self-tests** (`scripts/check-runner-*.sh` + `.test.ts`): infra-preflight, kms-roundtrip, keys-revoked, secret-metadata, task-read — all run in **`selftest`** mode in CI (no AWS creds), so they prove the guard LOGIC, not a hosted run.

> **Destructive-suite caveat:** the raw `org_rls_test.sql` **TRUNCATE**s tables and deletes `auth.users` as fixtures. It is safe on the **throwaway Docker** postgres that `test-rls.sh` spins up, but it **must NOT** run against shared hosted staging — a hosted RLS-parity run requires a **disposable, isolated** project via `scripts/verify-staging-rls-suite.mjs` (prepared, not yet run — see §6).

---

## 3. Test inventory — idcaddie-connector-runner

CI (`.github/workflows/ci.yml`, single `build` job) is **synthetic only**: no AWS creds/OIDC, no `get-secret-value`, no ECS, no DB URL, no real Slack secret. The only credential is a scoped **read-only SSH deploy key** so `vendor:verify` can check out the pinned `idcaddie-v3` source for its byte-diff.

| Check | Command / file | Proves | Does NOT prove |
|---|---|---|---|
| **vendor:verify** (authoritative) | `npm run vendor:verify` → `scripts/vendor-verify.mjs`; `test/vendor-verify.test.ts` | The 7 vendored `connector-vault` files are **byte-identical** to `idcaddie-v3` @ pinned SHA `acae16b` (fails on drift) | That the vendored core is itself correct (that is the v3 test suite's job) |
| **task-read refusal** | `test/ingest-task-read.test.ts`, `test/task-secret-read.test.ts` | The entrypoint **fails closed** unless every operator guard + config var is set; wrong env/region/project-ref/secret-id refuse; production ref → hard abort | A successful live read (that is evidence §4) |
| **synthetic smoke** | `test/task-read-ingest.test.ts`; `node dist/ingest-task-read.js --synthetic` | The reader→ingest→RunnerConnection composition round-trips an envelope with a **fake XOR KMS + fake in-memory pg**; plaintext sentinel never persisted/logged | The real KMS/DB/Secrets Manager path |
| **DB URL guard** | `test/runner-connection.test.ts` | The DB URL must be `connector_runner_login[.<staging-ref>]`, `sslmode` secure, and the **correct us-east-1 pooler host**; wrong user/host/sslmode/production-ref refuse **before any connection**; URL/password never leak in errors | Live connectivity |
| **SQLSTATE / connect diagnostics** | `test/runner-connection.test.ts` | A DB failure surfaces a **sanitized** reason (`ingest_failed:<SQLSTATE>` for query errors; `ingest_failed:runner_db_connect_failed`/`_timeout` / `28P01` for connect/auth) with no host/URL/password leak | The specific hosted failure mode |
| **deploy:check** | `npm run deploy:check` → `deploy/scripts/check-deploy-templates.mjs`; `test/check-deploy-templates.test.ts` | The Fargate deploy package: task/exec **role separation**, no plaintext DB URL (injected via `secrets.valueFrom`), exec role reads only the DB-URL secret, no Slack-secret reference, no `get-secret-value`, no production ref, ASCII-only AWS artifacts | Anything about the live AWS account state |
| **Docker / image / CA** | `Dockerfile` + `deploy:check` Dockerfile guards | Distroless non-root runtime; the **public Supabase CA** is baked in via `NODE_EXTRA_CA_CERTS` (a certificate, not a private key); no `RUN` in the runtime stage | A clean **ECR image scan** (that is evidence §4, an out-of-band run) |

**Also:** `npm run typecheck`, `npm run build`, and the local refusal smoke (`node dist/ingest-task-read.js` with no guards → `REFUSED`).

---

## 4. Evidence inventory (redacted)

All human-run, under explicit operator approval, **staging only**. **No secret values are recorded anywhere** — the runner's outcome line carries only a redacted DB row UUID (`secret_id`), not the secret.

### 4a. Recorded in connector-runner `docs/STAGING_LIVE_RUN_EVIDENCE.md` (PR #16)

These five are the committed, reviewer-reproducible-from-the-doc evidence rows.

| Evidence | What it shows |
|---|---|
| **Live ECS run** | One-shot Fargate task (task-def rev 4 / image `a99b24d`), **exit 0**, outcome `OK: stored Slack client secret (envelope-only). secret_id=<uuid>` |
| **Envelope-only DB verification** | Exactly 1 `connector_app_secrets` v1 row; row id = the logged `secret_id`; `AES-256-GCM`; byte lengths nonce 12 / tag 16 / ciphertext 32 / dek_wrapped 184 / aad_digest 64; all envelope fields non-null; **no plaintext column** |
| **Log plaintext scan** | 0 hits for secret / DB URL / username / host / connection-string / production ref |
| **Source Slack SM secret — scheduled deletion** | `delete-secret --recovery-window-in-days 7` (recoverable, not force-delete); marked `2026-07-03`; permanent-deletion date **`2026-07-10`** |
| **Post-cleanup read-failure proof** | `GetSecretValue` → **`InvalidRequestException`** ("marked for deletion") — error class only; unreadable to all principals incl. the task role |

### 4b. Verified operationally during the run/apply sequence, but NOT yet captured in a committed evidence doc (gap — see §6)

These checks were run and passed during the approved operator sequence, but their **results are not recorded in any committed repo artifact** — a reviewer cannot reproduce them from a doc. A follow-up evidence PR should capture them (redacted).

| Check | Result (operational, uncommitted) | Nearest committed reference |
|---|---|---|
| **ECR image scan** | Image `a99b24d` scan reported **0 findings** (distroless) | none recorded — capture in a follow-up evidence PR |
| **IAM role-separation** | Exec: Slack `implicitDeny` / DB-URL `allowed`; Task: Slack `allowed` / DB-URL `implicitDeny` | **expected** outputs + STOP-checks in connector-runner `docs/OPERATOR_APPLY_PLAN_PR6.md` (a pre-deploy checklist, NOT a recorded run) |
| **KMS / CloudTrail metadata** | Success path — DB-URL + Slack `GetSecretValue`, KMS `GenerateDataKey` + `Decrypt` (envelope encrypt + round-trip self-check), metadata only | none recorded — capture in a follow-up evidence PR |

**Hosted v3 evidence (separate, storage/auth track — genuinely recorded):** `docs/25` (staging apply + Storage REST authz 14/14), `docs/29` (production apply + Storage REST 14/14), `docs/31` (hosted staging Auth/tenant-context 8/8) — all redacted attestations.

---

## 5. Cross-repo provenance map

```
idcaddie-v3 @ acae16b  ──(7 files vendored verbatim)──▶  idcaddie-connector-runner/vendor/connector-vault/
        │                                                        │
        │  (VENDOR.lock: sourceSha=acae16b, 7 files)             │  npm run vendor:verify
        │                                                        ▼
        │                                          byte-diff each vendored file vs the pinned
        │                                          idcaddie-v3 source — FAILS on any drift
        ▼                                                        │
docs/04_RISK_REGISTER.md (RISK-007 milestone, PR #220/#221) ◀───┘  runner ran once → PR #16 evidence
```

- **`vendor:verify` purpose:** guarantee the runner executes the *reviewed* connector-vault core unchanged — the runner cannot silently diverge from the v3-reviewed code.
- **Authoritative-for-what:**
  - **idcaddie-v3** is authoritative for: the connector-vault **source code**, the **RLS/§8 tests**, the **risk register** (RISK-007 status), the storage/auth **hosted evidence** (docs 25/29/31), and the **canonical figures** (doc 00).
  - **idcaddie-connector-runner** is authoritative for: the **live ECS run evidence** (`docs/STAGING_LIVE_RUN_EVIDENCE.md`, PR #16), the **operator runbook** (`FIRST_LIVE_RUN_CHECKLIST.md`), and the **deploy package** (`deploy/`).

---

## 6. Remaining unproven / not yet complete

- **First-real-token staging dry-run** (doc 44 §5) — **NOT run**. The runner client-secret read is a *precondition*, now met; the 17-item real-token evidence is not produced.
- **B2c-run** (doc 45) — **NOT run**. No real Slack OAuth token has been minted/stored.
- **Decrypt/use harness** (doc 44 §7) — **NOT run**. The stored envelope has never been decrypted through the **real KMS CMK** (round-trip is only asserted structurally by byte-lengths + proven against a *fake* KEK in unit tests).
- **Per-tenant customer connector credentials** — the proven slice is the **app-level** Slack client secret (non-tenant-scoped `connector_app_secrets`); the Tier-2 per-tenant `connector_secrets` path is built + RLS-tested but not exercised live.
- **Rotation / revocation** — schema + append-only lifecycle events exist; not exercised end-to-end on hosted.
- **Hosted RLS-suite parity** — the full `org_rls_test.sql` has not been re-run against a disposable hosted project (`verify-staging-rls-suite.mjs` prepared, not run).
- **Production** — untouched. No production KMS/IAM separation, no production live ingest.
- **Uncommitted operational evidence** — the ECR image scan (0 findings), the IAM role-separation simulations, and the KMS round-trip metadata (§4b) were run and passed during the approved sequence but are **not yet recorded in a committed evidence doc**; a follow-up evidence PR should capture them (redacted).
- **Governance (2026-07-10):** **RISK-007 is CLOSED at its staging-defined criteria (R-018/#291); Phase C is UNBLOCKED as a governance state only (R-019/#292)** — C-2c staging live sync completed 2026-07-10 (staging-only, production untouched; connector-runner PR #36); the C-2c connector live data-sync ran on staging only (connector-runner PR #36, 2026-07-10); production untouched.

---

## 7. External reviewer notes

**Where to start:** this doc → `docs/00_PRODUCT_STATUS.md` (current figures) → `docs/04_RISK_REGISTER.md` (RISK-007) → for the connector path: `docs/42` (implemented design), `docs/46` (runner spec), then connector-runner `docs/STAGING_LIVE_RUN_EVIDENCE.md` + `README.md`.

**Authoritative docs:** doc 00 (figures), doc 04 (risk status), doc 42 (implemented vault design), doc 46 (runner spec); connector-runner `STAGING_LIVE_RUN_EVIDENCE.md` (live-run evidence).

**Safe to run (read-only, local, no secrets):**
- idcaddie-v3: `npm test`, `scripts/test-rls.sh` (throwaway Docker postgres — disposable), `scripts/test-store-it.sh` (local Supabase stack). The `check-runner-*` scripts run `selftest` (no AWS).
- connector-runner: `npm run vendor:verify` (needs the pinned source; `--allow-blob-only` is the fallback without the deploy key, with stated limits), `npm test`, `npm run typecheck`, `npm run build`, `npm run deploy:check`, and the local refusal + `--synthetic` smokes.

**Require explicit human approval (do NOT run as a reviewer without it):** any `verify-staging-*.mjs` / `verify-production-*.mjs` hosted verifier (needs hosted creds); the raw `org_rls_test.sql` against any **shared** database (destructive — disposable isolated project only).

**Must NOT be run without explicit approval, ever:** an ECS `run-task` / live task-read; `get-secret-value` / any real secret read; a real **KMS decrypt** of a stored envelope; the **B2c-run** / first-real-token dry-run / decrypt-use harness; **anything touching production**; force-deleting the staging source secret before its `2026-07-10` window; and **do not** flip RISK-007 to closed or unblock Phase C — both are separate explicit human decisions.
