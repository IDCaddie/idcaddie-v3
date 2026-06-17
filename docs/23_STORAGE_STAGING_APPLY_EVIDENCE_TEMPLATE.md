# 23 · Storage Staging Apply — Evidence Template

**Canonical source for: the evidence a human captures WHILE executing
[22_HOSTED_STORAGE_BUCKET_APPLY_RUNBOOK](./22_HOSTED_STORAGE_BUCKET_APPLY_RUNBOOK.md) against a staging
Supabase project** — exactly what was checked, who ran it, when, against which staging project, what
commands/API checks were run, what passed, what failed, and the artifacts that prove it. Copy this template
into a dated evidence record (e.g. `docs/evidence/storage-staging-<date>.md`) and fill it in **only during a
separately approved staging execution**.

> ## ⚠️ STATUS BANNER (do not remove)
> - **TEMPLATE ONLY — NOTHING APPLIED.** This file applies nothing, creates no bucket, creates no Storage
>   policy, and runs no command.
> - **Does not create the bucket/policies** and **does not execute doc 22** — it only *records* an execution.
> - **Does not close RISK-001.** RISK-001 stays open until the broader hosted-apply criteria
>   ([20 §9](./20_STAGING_HOSTED_APPLY_AND_CUTOVER_DISCIPLINE.md)) are met + separately approved.
> - **Must be filled in only during a separately approved staging execution** (a named human, explicit
>   approval) — never speculatively, never to "pre-bless" an apply.
> - **Production remains untouched.** This template is for **staging only**; production is a separate,
>   separately-approved run.
> - **Cutover remains BLOCKED.** [17_OMC_PRODUCTION_REPLACEMENT_PARITY_GATE](./17_OMC_PRODUCTION_REPLACEMENT_PARITY_GATE.md)
>   remains the binding cutover authority; completing this evidence does **not** authorize cutover.
> - **No secrets.** Never paste a key/token/service-role/connection-string/JWT/secret into this record,
>   logs, or commits. Redact every sample. The Storage tests use **user-scoped JWTs from staging fixtures**.

> **Process:** [22](./22_HOSTED_STORAGE_BUCKET_APPLY_RUNBOOK.md) is the runbook (the steps);
> [21 §6](./21_STORAGE_LOCAL_HARNESS_FEASIBILITY.md) is the proof obligations; **this doc (23) is the
> evidence log** of having satisfied them. All three are gated by [20](./20_STAGING_HOSTED_APPLY_AND_CUTOVER_DISCIPLINE.md).

---

## 1. Execution metadata

| Field | Value |
|---|---|
| Executor name | `______________________` |
| Reviewer name (independent of executor) | `______________________` |
| Date / time (with timezone) | `______________________` |
| Git commit SHA executed from | `______________________` |
| PR number that **authorized** this execution | `#______` |
| Staging Supabase project ref | `______________________` |
| **Confirmed this is the STAGING project, NOT production** | ☐ confirmed — executor initials `____` / reviewer initials `____` |
| **Confirmed `git status --short` was clean** before apply | ☐ confirmed — initials `____` |
| **Confirmed migrations were LISTED before apply** (repo `0001`–`0013` vs staging applied list; no unknown/duplicate) | ☐ confirmed — initials `____` |
| **Confirmed ONLY the approved Storage bucket/policy changes were applied** (no blanket `db push`) | ☐ confirmed — initials `____` |
| **Confirmed NO secrets** were pasted into this doc / logs / commits | ☐ confirmed — initials `____` |

---

## 2. Pre-apply checklist

Run + check **before** touching staging. Every box must be checked (record the command output/initials).

- [ ] On `main`
- [ ] Pulled latest (`git pull --ff-only`)
- [ ] Clean working tree (`git status --short` empty)
- [ ] No duplicate `* 2.*` / `* 3.*` files
- [ ] `npm test` passes (**67/67** at baseline)
- [ ] `npm run lint` passes
- [ ] `npx tsc --noEmit` passes
- [ ] `npm run build` passes (routes unchanged)
- [ ] `scripts/check-auth-safety.sh` passes (no service-role in `src/`)
- [ ] `scripts/check-migration-safety.sh` passes
- [ ] `scripts/test-rls.sh` passes (**RLS 205**, `0001`–`0013`)
- [ ] `scripts/gen-types-local.sh` produces **no unexpected diff**
- [ ] **Linked Supabase project confirmed = STAGING only** (visually verified ref + dashboard)
- [ ] **Staging env vars wired** per [24_STAGING_ENVIRONMENT_VARIABLES_AND_WIRING_CHECKLIST](./24_STAGING_ENVIRONMENT_VARIABLES_AND_WIRING_CHECKLIST.md) (names set, no values pasted; no service-role on browser/request path; no production values)
- [ ] **Production project NOT targeted** (and not reachable from this session)
- [ ] **Rollback / disable plan reviewed** (how to drop the bucket/policies; see §6)
- [ ] **Read [22_HOSTED_STORAGE_BUCKET_APPLY_RUNBOOK](./22_HOSTED_STORAGE_BUCKET_APPLY_RUNBOOK.md)**
- [ ] **Read [21 §6](./21_STORAGE_LOCAL_HARNESS_FEASIBILITY.md) acceptance checklist**
- [ ] **No service-role on any request/browser path** (confirmed in the intended upload design)

---

## 3. Apply evidence

> Record **redacted** evidence only. Do **not** paste runnable mutating commands here; the apply is done by
> the human per [22 §3/§4](./22_HOSTED_STORAGE_BUCKET_APPLY_RUNBOOK.md) under explicit approval. **No
> `supabase db push --linked`; no blanket apply; no secrets.** Placeholders to fill:

- **Migration-list output / bucket-existence check BEFORE apply:**
  ```
  (paste redacted migration list — repo 0001–0013 vs staging applied list; and the "does contract-files exist?" check)
  ```
- **Exact approved apply artifact / SQL / policy text used** (the finalized bucket config + object policies — redacted of any project-specific secret):
  ```
  (paste the exact approved text that was applied — finalized per doc 22 §5, NOT the illustrative shape verbatim unless it was the final)
  ```
- **Executor initials confirming the apply was MANUALLY APPROVED before running:** `____`
- **Bucket creation evidence** (redacted): `____________________`
- **Policy creation evidence** (redacted): `____________________`
- **Policy names applied** (list): `____________________`
- **Bucket privacy evidence** (`public = false`): `____________________`
- **Public URL disabled evidence** (no public base URL / public GET fails): `____________________`
- **No-production-apply evidence** (proof the same change was NOT applied to production): `____________________`

---

## 4. Required Storage verification checklist (the acceptance gate — reproduces [21 §6](./21_STORAGE_LOCAL_HARNESS_FEASIBILITY.md))

Run **in staging via the Storage REST API** with user-scoped JWTs from the staging fixtures. **Every box must
be `pass`** (or an explicitly justified+approved exception) before any upload action may ship. Each row needs
a **result**, **evidence** (link or pasted redacted output), **reviewer initials** (not just the executor's),
and **notes**.

| # | Proof obligation | Result (pass / fail / not run) | Evidence (link or redacted output) | Reviewer initials | Notes |
|---|---|---|---|---|---|
| 1 | **Private bucket exists** (`contract-files`, `public = false`) | | | | |
| 2 | **Public access denied** — no public base URL works | | | | |
| 3 | **Unauthenticated list/read denied** (anon GET/LIST fails) | | | | |
| 4 | **Tenant A user can access ONLY tenant A prefix** (`contracts/{A}/…`) | | | | |
| 5 | **Tenant B user CANNOT read/list tenant A prefix** | | | | |
| 6 | **Tenant B CANNOT overwrite/delete/move/copy a tenant A object** | | | | |
| 7 | **Tenant editor can upload** when the `files`-row authority allows (own tenant prefix) | | | | |
| 8 | **Procurement-org manager can upload ONLY for a writable contract** (if the policy design supports it; else carried by the `0013` files-row INSERT) | | | | |
| 9 | **Paying-org manager DENIED upload** (read ≠ write) | | | | |
| 10 | **Tenant viewer DENIED upload** | | | | |
| 11 | **Cross-org manager DENIED upload** (org they can't write) | | | | |
| 12 | **UPDATE/DELETE/`FOR ALL` absent or proven denied** (overwrite / `upsert:true` / move / copy / delete) | | | | |
| 13 | **Server-derived path only** (client path/filename can't escape the tenant prefix) | | | | |
| 14 | **Original filename NOT used in the object path** (display metadata only) | | | | |
| 15 | **`contracts/{tenant_id}/{file_id}.pdf` path enforced** | | | | |
| 16 | **`0013` files-table RLS still passes** (`scripts/test-rls.sh` → 205; Storage policy is parallel, not a replacement) | | | | |
| 17 | **No service-role used by any request/browser path** (user-scoped client only) | | | | |
| 18 | **Signed URLs (if tested) are short-lived + issued only after authz** (single-object scope; no listing/cross-tenant) | | | | |
| 19 | **No public URLs** anywhere for contract files | | | | |
| 20 | **Server-side file-size limit** consistent with `MAX_CONTRACT_FILE_BYTES` (25 MiB) is configured on the bucket | | | | |

**Overall verification result:** ☐ ALL pass · ☐ failures present (see §5).

---

## 5. Failure log

One block per failure. **Any failure of a tenant-isolation / public-access / destructive-write / service-role
obligation (rows 2–6, 12, 17, 19) is critical → STOP + roll back (§6).**

| # | What failed | Expected behavior | Actual behavior | Severity (critical/high/med/low) | Apply stopped? (yes/no) | Rollback/disable action taken | Follow-up PR required |
|---|---|---|---|---|---|---|---|
| 1 | | | | | | | |
| 2 | | | | | | | |

---

## 6. Rollback / disable evidence

If anything failed or looked wrong, record the rollback. Production is never touched regardless.

- **Bucket disabled/deleted (if needed):** `____________________`
- **Policies removed or tightened (if needed):** `____________________`
- **Upload action blocked** (it is not shipped yet — confirm no upload path is live): `____________________`
- **Production untouched — confirmed:** ☐ confirmed — initials `____`
- **Customer impact:** ☐ none / staging only — initials `____`

---

## 7. Final staging signoff

Sign **only** if every gate is true. This signs off the **staging** Storage apply evidence — **not** the
upload action, **not** production, **not** cutover.

- [ ] **All required checks (§4) passed** (or each exception is justified, approved, and logged in §5).
- [ ] **No critical/high failures remain open.**
- [ ] **No cross-tenant read/write is possible** (rows 4–6, 11 proven).
- [ ] **No public access is possible** (rows 2, 3, 19 proven).
- [ ] **No destructive overwrite/delete across tenants is possible** (rows 6, 12 proven).
- [ ] **No service-role request path** (row 17 proven; `check-auth-safety.sh` green).
- [ ] **RISK-001 remains OPEN** unless the broader hosted-apply criteria ([20 §9](./20_STAGING_HOSTED_APPLY_AND_CUTOVER_DISCIPLINE.md)) are satisfied **and separately approved** — this evidence alone does not close it.
- [ ] **The upload action may proceed ONLY in a later PR** if this evidence is complete + reviewed (and even then it ships behind its own review).
- [ ] **Production promotion requires a SEPARATE PR / runbook / execution** (a fresh evidence record), not this one.

| Signoff | Name | Initials | Date |
|---|---|---|---|
| Executor | | | |
| Reviewer (independent) | | | |
| Approver (per [20 §3/§9](./20_STAGING_HOSTED_APPLY_AND_CUTOVER_DISCIPLINE.md)) | | | |

---

## 8. Non-goals (of this template doc / PR #43)

This doc/PR does **not**: mutate hosted Supabase · apply anything · run `supabase db push --linked` · create
a bucket · create a Storage policy · apply to production · add an upload action/route/UI · implement signed
URLs · add AI/OCR · add connector credentials · add a migration/app code/route/package/type change · add
secrets · close RISK-001/002/007/016 · authorize cutover. It is the **evidence template only**.

## 9. Risk posture

**RISK-001** (no hosted apply), **RISK-002** (`files` not surfaced), **RISK-007** (no credential vault),
**RISK-016** all remain **OPEN**. Cutover stays **BLOCKED** (doc 17). OMC/Flywheel is a paying production
replacement, **not a pilot**. Filling in this template during a staging execution is *evidence capture* —
it is **not** Storage-ready, **not** upload-ready, and **not** cutover-ready.
