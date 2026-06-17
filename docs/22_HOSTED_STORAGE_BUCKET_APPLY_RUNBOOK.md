# 22 · Hosted Staging — Contract-Files Bucket Apply Runbook

**Canonical source for: the exact reviewed, human-executed STAGING apply + verification steps to create
the private `contract-files` Supabase Storage bucket and its object policies — the gate that must pass in
hosted staging before any contract PDF upload action can ship.**

> **Status (do not overclaim):** **RUNBOOK ONLY — NOTHING APPLIED.** This PR applies nothing, creates no
> bucket, creates no Storage policy, deploys nothing, and adds no secrets. It is the *script a human
> follows later* against a **staging** Supabase project. It **does not** make v3 ready, **does not** close
> RISK-001/002/016, and **does not** authorize cutover. The upload action/route/UI, signed-URL flow, and
> AI/OCR are **separate later PRs** that may ship only **after** this runbook passes in staging.

> **Where this sits:**
> - [20_STAGING_HOSTED_APPLY_AND_CUTOVER_DISCIPLINE](./20_STAGING_HOSTED_APPLY_AND_CUTOVER_DISCIPLINE.md) —
>   the general hosted-apply/deploy discipline (staging-first, verify-after-apply, stop/rollback). This
>   runbook is a **specific instance** of that discipline for the Storage bucket.
> - [21_STORAGE_LOCAL_HARNESS_FEASIBILITY](./21_STORAGE_LOCAL_HARNESS_FEASIBILITY.md) — proved Storage
>   object-RLS **cannot** be tested locally; §6 there is the verification this runbook executes (reproduced
>   in §6 below).
> - [16_CONTRACT_PDF_AI_EXTRACTION_DESIGN](./16_CONTRACT_PDF_AI_EXTRACTION_DESIGN.md) §3 — the storage model;
>   [PR #40 `src/lib/files/pdf-validation.ts`] — the server-side validation + the server-derived path.
> - **Doc 17 remains the binding cutover gate; cutover stays BLOCKED.**

This runbook **does not edit migrations `0001`–`0013`** and **does not put Storage policies into
`supabase/migrations/`** (that would break the plain-Postgres `test-rls.sh`/`gen-types` harnesses — doc 21).
The bucket + object policies are **hosted Storage objects** applied directly to the staging project by the
human executor, then verified through the **Storage REST API** (§6) — not via the local migration harness.

---

## 1. The intended private bucket

| Property | Value |
|---|---|
| **Bucket name** | `contract-files` (canonical — `src/lib/files/pdf-validation.ts` `CONTRACT_FILES_BUCKET`) |
| **Visibility** | **PRIVATE only** (`public = false`) — **no public bucket, no public URLs** |
| **Reads** | **short-lived signed URLs only**, issued after a server-side auth check; never a public GET |
| **Writes** | server-mediated upload on the **user-scoped client** (never service-role, never public PUT) |
| **Object path** | `contracts/{tenant_id}/{file_id}.pdf` — **server-derived** (`buildContractFileObjectPath`, PR #40); `tenant_id` from resolved context, `file_id` a server-issued UUID; **both server-derived only**, never client-supplied; original filename is display metadata only |
| **Size cap** | consistent with `MAX_CONTRACT_FILE_BYTES` (25 MiB) |
| **Authority** | mirrors the `0013` files-table authority — contract-write only (tenant `owner`/`admin`/`editor` OR procurement-org manager); **`paying_org` never grants write**; **no UPDATE/DELETE/`FOR ALL`** |

The **source of truth is the DB `files` row** (RLS `0013`/T34), not the Storage object. The upload flow
inserts the `files` row first (0013-gated contract-write authority), then uploads the object; the Storage
object policy is **tenant-prefix defense-in-depth** on top of that.

---

## 2. Preconditions (all must hold before starting)

- [ ] Working tree is **clean** and on the **reviewed `main` commit** (PR #40 validation + PR #41 spike merged).
- [ ] `npm test` 67/67, `scripts/test-rls.sh` **205** green locally (the file-row authority is already proven).
- [ ] The Supabase CLI is logged in to the **STAGING** project **only** — **never production**. The executor
      has visually confirmed the active project ref is the staging project (see §3 step 2). **If unsure, STOP.**
- [ ] A **human approver** has signed off on running this specific staging apply (doc 20 §3/§9).
- [ ] An **OMC-shaped (synthetic) staging dataset** exists with ≥2 tenants + the role fixtures needed to
      exercise §6 (tenant editor, procurement-org manager, paying-org manager, viewer, a second tenant).
- [ ] **No real customer secrets** are used; staging secrets are separate from production (doc 20 §6).

---

## 3. Exact staged apply sequence

Execute **in order**, by a human, against **staging only**. Stop on any surprise (§7).

1. **Confirm clean `main`.** `git status` clean; `git rev-parse HEAD` matches the reviewed commit; `git log`
   shows PRs through #41 merged. Do **not** apply from a dirty tree or an unreviewed branch.
2. **Confirm the LINKED STAGING project — and only staging.** Verify the active project ref is the **staging**
   project (e.g. `supabase projects list` and confirm the linked ref; cross-check the dashboard URL/name).
   **Never run this against production.** **Never** `supabase db push --linked` to apply *everything* — this
   runbook applies **only** the bucket + object policies. If the linked project is production or unknown, **STOP**.
3. **List migrations first.** Compare the repo's `supabase/migrations/` (`0001`–`0013`) against the staging
   project's applied-migration list. Confirm they match and that **no unknown/duplicate migration** exists on
   staging. (This runbook adds **no** migration; this step is a safety check, not an apply.)
4. **Apply ONLY the approved Storage bucket + object-policy changes** (§5) — the private `contract-files`
   bucket + the `storage.objects` policies — via the Supabase dashboard Storage admin and/or a reviewed SQL
   statement run in the staging SQL editor. Apply **nothing else**; do not run a blanket `db push`.
5. **Verify schema/policies.** Confirm the bucket exists and is **private** (`public = false`), and that the
   `storage.objects` policies are present and named as intended, with **no broad `FOR ALL`/UPDATE/DELETE**
   policy and no public-read policy.
6. **Run the Storage API verification (§6)** — exercise the real storage-api through the Storage REST API
   with real user JWTs from the staging fixtures. **Every §6 box must pass.**
7. **STOP before production.** This runbook ends at verified staging. Production is a **separate** execution
   of this runbook against the production project, only after a staging soak + the doc 17 §5 go/no-go +
   human + OMC sign-off (doc 20 §9 "Before production Supabase apply"). **Do not auto-promote.**

---

## 4. What the executor applies (and what they must NOT)

**Apply (staging):**
- A **private** bucket `contract-files` (`public = false`, size limit ≈ 25 MiB).
- `storage.objects` RLS policies (INSERT + SELECT) scoping objects to the uploader's tenant prefix and
  mirroring the `0013` contract-write authority — §5 illustrative shape.

**Must NOT:**
- Create a **public** bucket or any public URL.
- Add a **broad `FOR ALL`**, or an UPDATE/DELETE policy (unless explicitly justified + re-verified — §6).
- Use a **service-role** key on any app request/browser path (the upload action uses the user-scoped client).
- Put the policies into `supabase/migrations/` (breaks `test-rls.sh`/`gen-types` — doc 21).
- Touch **production**, or apply anything beyond the bucket + its policies.

---

## 5. Illustrative object-policy shape (ADAPT + VERIFY in staging — not applied here, not a migration)

> **Illustrative only.** The executor finalizes the exact predicate against the real storage-api and
> proves it via §6. This is **not** applied by this PR, **not** in `supabase/migrations/`, and **not**
> locally tested (doc 21 — the local harness has no `storage` schema). It exists so the executor has a
> concrete starting point, not a verified artifact.

The object path is `contracts/{tenant_id}/{file_id}.pdf`, so `(storage.foldername(name))[1] = 'contracts'`
and `(storage.foldername(name))[2]` is the `tenant_id`. The policy binds writes to a tenant the caller has
**contract-write authority** in (reusing the `0013`/`can_write_contract` model); per-contract precision lives
in the `files`-row INSERT (the source of truth), with the Storage policy as tenant-prefix defense-in-depth:

```sql
-- ILLUSTRATIVE — finalize + verify in STAGING via §6; NOT a migration, NOT applied here.
-- INSERT: write only into the caller's own authorized tenant prefix of the private bucket.
create policy "contract_files upload (own tenant, contract-write)" on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'contract-files'
    and (storage.foldername(name))[1] = 'contracts'
    and public.has_tenant_role(((storage.foldername(name))[2])::uuid, array['owner','admin','editor'])
    -- INCOMPLETE AS WRITTEN: this only encodes the tenant-editor branch. A procurement-org manager may
    -- NOT be a tenant member, so this literal predicate would DENY them — yet §6 requires proving they
    -- CAN upload for a contract they can write. Per-contract authority is carried by the 0013 files-row
    -- INSERT (the source of truth), which the upload action performs FIRST. Before §6 can pass, the
    -- executor must EITHER extend this predicate to also allow the org-manager case (e.g. an
    -- OR public.has_org_role_in_tenant(...) branch keyed off the path's tenant prefix / the linked
    -- contract) OR bind the object write to an existing files row for that tenant. Finalize + prove in §6.
  );

-- SELECT: read/list only within the caller's own tenant prefix (reads still go via signed URLs).
create policy "contract_files read (own tenant)" on storage.objects
  for select to authenticated
  using (
    bucket_id = 'contract-files'
    and (storage.foldername(name))[1] = 'contracts'
    and public.is_tenant_member(((storage.foldername(name))[2])::uuid)
  );

-- NO UPDATE policy, NO DELETE policy, NO `FOR ALL` (mirrors 0013/T34). No anon/public policy.
```

---

## 6. Verification checklist (run in STAGING via the Storage REST API — every box must pass)

Reproduced from [21 §6](./21_STORAGE_LOCAL_HARNESS_FEASIBILITY.md). This is the acceptance gate.

**Bucket setup**
- [ ] Bucket `contract-files` exists and is **PRIVATE** (`public = false`).
- [ ] **No public read** — no public bucket, no public base URL; object access is **signed-URL only**.
- [ ] Server-side size limit consistent with `MAX_CONTRACT_FILE_BYTES` (25 MiB).

**Authority (mirrors `0013`/T34 — contract-write, never `paying_org`)**
- [ ] **Tenant editor can upload only under their own tenant prefix** `contracts/{their_tenant_id}/…`.
- [ ] **Procurement-org manager can upload only when contract-write authority exists** for the linked contract.
- [ ] **`paying_org` manager is DENIED upload** (read ≠ write).
- [ ] **Tenant viewer is DENIED upload.**
- [ ] **Cross-org manager (different org) is DENIED upload** for a contract they cannot write.
- [ ] **UPDATE/DELETE/`FOR ALL` denied** (overwrite / `upsert:true` / move / copy / delete) for everyone
      (or own-prefix-only if ever explicitly justified) — **no broad UPDATE/DELETE, no leftover `FOR ALL`**.
- [ ] **Tenant B cannot overwrite or delete a tenant A object** (verified through the Storage REST API).

**Tenant isolation / no public access**
- [ ] **Tenant A cannot read/list tenant B's prefix**; a user reads/lists only their own
      `contracts/{their_tenant_id}/…` prefix.
- [ ] **Cross-tenant denial:** tenant B cannot read, list, or sign-URL an object under tenant A's prefix.
- [ ] **No public access:** an anonymous/unauthenticated GET is denied; reads succeed **only** via a
      short-lived signed URL issued after an auth check.
- [ ] A signed URL is **short-lived** + single-object-scoped (no listing, no cross-tenant access).

**Integrity / preservation**
- [ ] Object path is the **server-derived** `contracts/{tenant_id}/{file_id}.pdf` (PR #40); a client-supplied
      path/filename cannot escape the tenant prefix.
- [ ] The **`0013` files-table RLS is unchanged** + still green (Storage policy is an additional parallel
      boundary, not a replacement; the file metadata row remains the source of truth).
- [ ] **No service-role on any app request/browser path** in the (future) upload action — user-scoped client only.
- [ ] **Post-apply:** re-run `scripts/test-rls.sh` (still **205**, no drift) and record the staging
      verification per [20 §9](./20_STAGING_HOSTED_APPLY_AND_CUTOVER_DISCIPLINE.md).

---

## 7. Stop / rollback rules

**STOP and roll back** (drop the bucket/policies in staging, fix forward) on any of:
- The linked project is **production or unknown** (§3 step 2).
- Any **§6 box fails** (e.g. a public read works, a cross-tenant read/overwrite/delete succeeds, a
  paying-org/viewer upload succeeds, or an UPDATE/DELETE/`FOR ALL` is reachable).
- Any **unexpected/duplicate migration** appears on staging (§3 step 3).
- **Generated-type drift** or **`scripts/test-rls.sh` not 205** after apply.
- Any **secret** appears in logs/output/policy text; any **service-role** on a request path.
- Any **data-destructive** behavior not explicitly approved + reversible.

On STOP: halt, roll back the bucket/policies, record what happened, open a fix-forward PR. Never push through.

---

## 8. After verified staging (do NOT auto-promote)

- Record the §6 results + who ran/approved it (doc 20 §9 "After staging Supabase apply").
- Soak; only then schedule the **production** execution of this runbook (a separate, separately-approved run)
  per doc 20 §9 "Before production Supabase apply" + the doc 17 §5 go/no-go.
- The **upload action / route / UI, signed-URL read path, and AI/OCR are separate later PRs** — they may
  ship only after §6 passes in staging (and, for cutover, after doc 17 §5).

---

## 9. Non-goals (this PR)

This PR does **not**: apply anything to hosted Supabase · run `supabase db push --linked` · create a bucket
· create a Storage policy · add an upload route/action/UI · implement signed URLs · add a service-role
runtime path · deploy production · add secrets · add a migration · change RLS/types/routes. It is the
**runbook only**.

---

## 10. Risk posture

**RISK-001** (no hosted apply), **RISK-002** (`files` not surfaced), **RISK-007** (no credential vault),
**RISK-016** all remain **OPEN**. Cutover stays **BLOCKED**. OMC/Flywheel is a paying production
replacement, **not a pilot**. Executing this runbook in staging is necessary plumbing toward closing
RISK-001 for the Storage surface — it is **not** closure, and **not** permission to cut over.
