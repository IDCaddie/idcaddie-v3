# 30 · Doc 17 Cutover Blocker Sequence

**Canonical ranked sequence of the remaining OMC cutover blockers** from the
[17 §5](./17_OMC_PRODUCTION_REPLACEMENT_PARITY_GATE.md) go/no-go checklist — what is left, in what order, and the
next PRs to do **before any cutover talk**. This is a planning/sequencing doc; it builds nothing and approves nothing.

> ## ⚠️ STATUS BANNER (do not remove)
> - **Docs-only blocker sequencing.** This doc adds no code, migration, script, env, or hosted command; **no
>   production/staging commands were run.**
> - **The `contract-files` Storage path is COMPLETE end-to-end — but NOT SUFFICIENT for cutover.** Staging +
>   production applied + REST-verified 14/14 + synthetic cleanup recorded
>   ([25](./25_STAGING_SCHEMA_AND_STORAGE_APPLY_EVIDENCE.md)/[29](./29_PRODUCTION_STORAGE_APPLY_EVIDENCE.md)).
>   It satisfies only **1 of 17** doc 17 §5 boxes' worth of the gate (the no-service-role/private-bucket
>   boundary); **16 boxes remain unmet.**
> - **RISK-001 remains OPEN** unless every documented closure criterion is satisfied — criteria (1)–(4) are met,
>   but **(5) the doc 17 §5 cutover checklist is NOT** ([04 · RISK-001](./04_RISK_REGISTER.md)). Materially
>   reduced ≠ closed.
> - **Cutover remains BLOCKED.** **Upload is not automatically production-ready.** v3 is **not** OMC
>   replacement-ready. OMC/Flywheel is a paying production **replacement, not a pilot**.

---

## 1. Where the gate stands (snapshot)

doc 17 §5 has **17 go/no-go boxes; cutover is a NO unless EVERY box is true.** Today **0 boxes are "go" for
cutover** as a set (the no-service-role boundary is the only one independently satisfied). The detailed mapping
is the [doc 17 cutover readiness review](./05_ENGINEERING_CHANGELOG.md) (PR #60) and the line-item
[27_LEGACY_OMC_FULL_PARITY_MATRIX](./27_LEGACY_OMC_FULL_PARITY_MATRIX.md).

**Storage is DONE but not sufficient:** the private bucket + object policies are applied + REST-verified in
staging **and** production; that closes the *Storage authorization boundary* only. It does **not** build the
upload/file/AI product surface, does **not** verify the rest of the schema/RLS against hosted Auth, and does
**not** advance any of the 16 remaining boxes.

---

## 2. Remaining blockers, bucketed (doc 17 §5)

Box numbers refer to doc 17 §5 (lines 277–293).

### A. Product / code gaps
- **Files not app-surfaced** — no upload UI, server upload action, signed-URL read flow, validation/scan gate,
  preview, or file/extraction audit (boxes 9, 13-flow, 14). *(Storage boundary is ready; the app path is not.)*
- **PDF/AI extraction not built** — legacy's default contract-create path is upload-PDF (boxes 1, 9).
- **Imports/connectors not built** — no connector subsystem, no SCIM, no scheduled sync, **no credential vault
  (RISK-007)**, no non-destructive upsert writer (boxes 1, 11, 12).
- **License rules / evaluations / ELU / waste, invoices, reporting/exports, dashboards** — not built (box 1).
- **IDC platform billing** (the ~$3.5k/mo revenue cron + surface) — not built (box 1).
- **App-contract link/unlink + cost allocation** — read-only today (box 1).
- **UAR / unmanaged / orphaned / stale users / people directory / identity matching** — missing (box 1).
- **Admin / settings parity** (user/role/group/company-settings UI, password reset) — missing (box 1).
- **Audit UI** — `audit_logs` is append-only but unsurfaced; only `contracts` has audit-on-write (`0010`) (box 14).

### B. Hosted staging verification gaps
- **Full schema + `org_rls_test.sql` RLS suite NOT re-run against hosted Postgres/Auth** — only Storage
  object-RLS was REST-verified, and a shim-vs-hosted divergence was already found + fixed (`0015`) (boxes 5, 8).
- **Vercel staging not verified against hosted Supabase Auth** — auth/session + tenant-context not exercised +
  recorded on hosted Auth (box 6).
- **No OMC-shaped staging dataset; critical flows not validated end-to-end in staging** (boxes 7, 9).

### C. Data migration / OMC parity gaps
- **No OMC data-migration plan** (Firestore + Storage → Postgres + Supabase Storage, incl. file bytes + AI
  history) — cutover as-is loses the historical corpus; never via `local_demo.sql` (RISK-015) (box 16).
- **§4 parity not closed** — most required workflows are `partial`/`not-built`/`blocked` in doc 27 (boxes 1, 2).
- **OMC §9 confirmation pass (doc 18) not completed** — `probably`/`unknown` rows remain, counting as required
  (boxes 3, 4).

### D. Security / privacy gaps
- **Credential vault not implemented (RISK-007)** — prerequisite for ANY connector secret (box 11).
- **RISK-002** (child/link tables not fully org-scoped for reads; org-scoped file read deferred), **RISK-013**
  (telemetry privacy review before real customer traffic), **RISK-009** (audit retention) — open.
- *(Satisfied:* no service-role on any request/browser path; `check-auth-safety.sh` green — box 10.)*

### E. Operational cutover gaps
- **No deploy/promote CI; no rehearsed rollback/DR/backup-restore** (box 15) — the 4 CI workflows are PR-time
  gates only.
- **No post-cutover monitoring/alerting** (doc 17 §3).
- **No documented old-app freeze / cutover plan** (data-migration cutoff, freeze window, switchover, fallback)
  (box 16).

### F. Customer / OMC signoff gaps
- **No OMC acceptance signoff recorded** (box 17).
- **No OMC confirmation** of the conditional blockers (SAML SSO, SCIM, connector long-tail — doc 17 §9).

---

## 3. Ranked sequence (do in this order; each is a separate, reviewed step)

| Rank | Blocker step | doc 17 §5 boxes it advances | Kind |
|---|---|---|---|
| 1 | **Hosted staging auth/session/tenant-context verification** — run real hosted Supabase Auth via Vercel staging; re-run the full schema + RLS suite against hosted Postgres/Auth (not the shim) | 5, 6, 8 | hosted verification |
| 2 | **OMC-shaped staging dataset + critical-workflow validation plan** — load an OMC-shaped dataset in staging; define + run the critical-flow validations | 7, 9 | hosted verification |
| 3 | **Required-workflow parity build plan (from doc 27)** — sequence the missing/partial *required* workflows (files surface, imports/connectors+vault, license/invoices/reporting, billing, link/unlink, UAR/people, admin, audit UI) | 1, 2, 11, 12, 14 | product/code |
| 4 | **OMC data-migration plan** — Firestore + Storage → Postgres + Supabase Storage (rows + bytes + history), with reconciliation; never via `local_demo.sql`. **→ PREPARED (planning only): [34_OMC_LEGACY_DATA_MIGRATION_PLAN](./34_OMC_LEGACY_DATA_MIGRATION_PLAN.md)** (sources→targets, blocked-until-built, 8 phases, reconciliation incl. file byte/checksum, non-destructive rules, security, named tooling PRs, evidence). No migration built/run. | 16 | data migration |
| 5 | **Rollback rehearsal plan** — DB + app rollback, deploy/promote CI, backup-restore, rehearsed in staging; post-cutover monitoring. **→ PREPARED (planning only): [35_CUTOVER_ROLLBACK_REHEARSAL_PLAN](./35_CUTOVER_ROLLBACK_REHEARSAL_PLAN.md)** (rollback definition, 8 domains, 6 staging rehearsal phases, 7 production triggers, hard-stop rules + owners, box-15 evidence). No rollback rehearsed/run. | 15 | operational |
| 6 | **OMC acceptance / signoff plan** — §9 confirmation pass (doc 18) resolved; old-app freeze/cutover plan; OMC acceptance signoff. **→ PREPARED (planning only): [36_OMC_ACCEPTANCE_SIGNOFF_PLAN](./36_OMC_ACCEPTANCE_SIGNOFF_PLAN.md)** (acceptance definition, 8 signoff domains, signers-by-role, evidence package, 4 outcomes, approved-removal recording, evidence format, hard rules). No signoff recorded. | 3, 4, 16, 17 | customer/signoff |

**These are planning/sequencing steps. Each underlying build/verification is its own future PR; none is started
here, and none may be hand-waved at cutover.**

---

## 4. The next 3 PRs (before ANY cutover talk)

1. **Hosted staging Auth + RLS-suite verification** — wire Vercel staging to hosted Supabase Auth, exercise
   auth/session + tenant-context, and re-run the full `org_rls_test.sql` RLS suite against hosted Postgres/Auth
   (boxes 5, 6, 8). *(Closes the "is the schema/RLS actually correct on hosted, not just the shim?" gap that
   the `0015` discovery proved is real.)* **→ PREPARED (not executed): the plan + verifier
   `scripts/verify-staging-auth-tenant-context.mjs` are in [31_HOSTED_STAGING_AUTH_TENANT_CONTEXT_VERIFICATION](./31_HOSTED_STAGING_AUTH_TENANT_CONTEXT_VERIFICATION.md); a human runs it later in an approved staging window.**
2. **OMC-shaped staging dataset + critical-workflow validation plan** — define the dataset shape and the
   critical-flow acceptance checks, loaded + validated in staging (boxes 7, 9). **→ PREPARED (not executed):
   the dataset definition + validation plan + the review-and-apply SQL template are in
   [32_STAGING_OMC_SHAPED_DATASET_AND_CRITICAL_FLOW_VALIDATION](./32_STAGING_OMC_SHAPED_DATASET_AND_CRITICAL_FLOW_VALIDATION.md)
   (runbook only — no committed runnable seed; a human loads + validates later in staging).**
3. **Required-workflow parity build plan from doc 27** — a sequenced plan for the missing/partial *required*
   workflows (start with the files product surface that sits on the now-ready Storage boundary), each citing its
   doc 27 row(s) (boxes 1, 2). *(Per doc 09, future feature PRs must cite doc 27 rows with evidence.)*
   **→ PREPARED (planning only): the ranked, buildable plan (9 implementation tracks, P0/P1/P2, P0 detail, and
   the next 3 implementation PRs) is in [33_REQUIRED_WORKFLOW_PARITY_BUILD_PLAN](./33_REQUIRED_WORKFLOW_PARITY_BUILD_PLAN.md).
   No feature built; build PRs follow once items #1/#2 are executed green.**

Everything after that (data migration, rollback rehearsal, OMC signoff) follows §3 ranks 4–6.

---

## 5. Standing constraints (unchanged by this doc)

- **Cutover scope = FULL old-app parity** (decision of record [38_OMC_FULL_PARITY_SCOPE_DECISION](./38_OMC_FULL_PARITY_SCOPE_DECISION.md)): every old-app capability is required unless OMC waives it in writing; the MVP subset framing is **not** sufficient for cutover. The blocker sequence below is necessary but **not** the whole scope — the build (item #3) spans the full doc 27 matrix, likely **dozens of PRs**.
- **Storage path is complete but NOT sufficient for cutover.**
- **RISK-001 remains OPEN** unless every documented closure criterion is satisfied (criterion 5 — doc 17 §5 —
  is not). Do not mark it closed.
- **Cutover remains BLOCKED.** Doc 17 §5 is the binding go/no-go; **every** box must be true.
- **Upload is not automatically production-ready.**
- This doc runs no production/staging command and changes no code/migration/script/env/hosted state.

---

## 6. Hosted-staging RLS suite re-run (sub-task of item #1, boxes 5/8) — PREPARED, not yet run

The remaining part of doc 17 §5 boxes 5/8 is the **full `org_rls_test.sql` suite re-run against hosted** (the
PR #68 verifier covered Auth + tenant-isolation/`files`-grant spot checks, not the whole suite).

**Analysis (`scripts/test-rls.sh` + `supabase/tests/org_rls_test.sql`).** `test-rls.sh` applies migrations to a
**throwaway postgres:16 container** and runs the suite via `psql ... ON_ERROR_STOP=1` — it relies on the
container being **disposable**, not on rollback. The suite's fixture setup is destructive: `truncate table` **17
core tables incl. `public.audit_logs` restart identity cascade**, `delete from auth.users`, then ~116 INSERT /
~77 UPDATE / ~70 DELETE + `set role authenticated|service_role`.

**Hosted staging RLS execution is prepared but not yet run.** **Raw `org_rls_test.sql` must not be run directly
against hosted staging unless wrapped in a proven rollback-only, staging-ref-guarded runner** — and even
rollback-only against the **shared** staging project is unsafe: the `TRUNCATE` includes `audit_logs` and fires a
**statement-level** trigger event that the row-level `reject_audit_mutation()` (`0002`) does **not** cover (it
would wipe append-only audit history); `delete from auth.users` mutates the managed auth schema; `TRUNCATE`
takes ACCESS EXCLUSIVE locks on 17 live tables; the privileged ops need a near-superuser connection.

**Safe approach:** run it against a **dedicated, disposable, isolated** hosted Postgres (a separate scratch
Supabase project or a Supabase branch DB — **never** the shared staging project `ycdpzduxugdsffjqyoai`, **never**
production `dzbfxulvxchdemcettrx`), seeded fresh and disposed after. The runner
`scripts/verify-staging-rls-suite.mjs` enforces this: it hard-refuses unless staging is the linked ref,
hard-refuses if production is linked, and **detects the destructive statements and refuses the raw run against
the shared project**. The script **connects to nothing**; only the explicit `disposable-isolated` opt-in **emits
a rollback-only runbook** (snapshot key-table counts → `begin … rollback` → prove post==pre counts incl.
`audit_logs` → dispose) for a human to run against a separate disposable project — so no connection string is
handled and **no secrets/URLs are printed**. **This PR prepares the runner; it does not run it. Production must
not be touched. RISK-001 remains OPEN. Cutover remains BLOCKED. Upload is not automatically production-ready.**
