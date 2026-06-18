# 28 · Production Apply Runbook — Contract-Files Storage

**Canonical source for: the exact reviewed, human-executed steps to apply the private `contract-files`
Storage bucket + `storage.objects` object policies to the PRODUCTION Supabase project — and to verify them
through the real Storage REST API in production.** This mirrors the staging apply ([22](./22_HOSTED_STORAGE_BUCKET_APPLY_RUNBOOK.md)/[26](./26_STORAGE_REST_VERIFICATION_RUNBOOK.md))
but targets **production** (`dzbfxulvxchdemcettrx`) and is gated by the cutover authority ([17](./17_OMC_PRODUCTION_REPLACEMENT_PARITY_GATE.md)).

> ## ✅ EXECUTED 2026-06-18 — evidence in [29_PRODUCTION_STORAGE_APPLY_EVIDENCE](./29_PRODUCTION_STORAGE_APPLY_EVIDENCE.md)
> A **human** executed this runbook against production `dzbfxulvxchdemcettrx`: migrations `0001`–`0014` applied,
> private `contract-files` bucket + 2 `authenticated` policies (0 unsafe), and the production REST verifier
> passed **14/14** (a missing `public.files` `authenticated` grant was found + codified as migration `0015`).
> **RISK-001 still OPEN** (only criterion 5, the doc 17 §5 cutover checklist, is unmet); **cutover still BLOCKED;
> upload not automatically production-ready.** The banner/steps below describe the runbook as authored; the
> agent ran nothing.

> ## ⚠️ STATUS BANNER (do not remove)
> - **Production apply is NOT executed by the docs PR.** This is a *runbook a human follows* under explicit
>   approval — the docs PR applies nothing, mutates nothing, and runs no command.
> - **No production mutation in this PR.** **No secrets are recorded** (this doc holds no key/password/JWT/anon
>   key/connection-string/project secret; production values live in the dashboard / an approved secret manager).
> - **RISK-001 remains OPEN until production apply, production verification, and the doc 17 cutover checklist
>   pass.** Staging is verified ([25 §0.3](./25_STAGING_SCHEMA_AND_STORAGE_APPLY_EVIDENCE.md)); production is not.
> - **Cutover remains BLOCKED.** [17 §5](./17_OMC_PRODUCTION_REPLACEMENT_PARITY_GATE.md) is the binding cutover
>   gate and is **separate from and required in addition to** this apply (§12). Completing this runbook does
>   **not** authorize cutover.
> - This runbook does **not** make v3 production-ready, upload-ready, or OMC replacement-complete. OMC/Flywheel
>   is a paying production **replacement, not a pilot**.

> **Hard rule:** every hosted-mutating step here is **human-run under explicit approval** ([20 §3](./20_STAGING_HOSTED_APPLY_AND_CUTOVER_DISCIPLINE.md)).
> **An agent NEVER executes a production apply, `supabase db push --linked`, bucket/policy creation, or the
> production REST verifier.** An agent may only prepare/record this runbook.

---

## 1. Production preflight checks (all must hold before starting)

- [ ] On the reviewed `main` commit; `git status` clean; no `* 2.*`/`* 3.*` strays.
- [ ] `npm test` 67/67, `scripts/test-rls.sh` **222** green locally (the file-row + Storage-helper authority is proven).
- [ ] **Staging is fully applied AND verified** (§3) — the production apply must never run ahead of a green staging.
- [ ] A **named human approver** has signed off on this specific **production** apply (doc 20 §3/§9), and a
      **maintenance/change window** + customer-impact assessment is agreed (this touches the live OMC system).
- [ ] A **rollback/disable plan** is reviewed (§10) and the executor can drop the bucket/policies fast.
- [ ] A **production backup / restore point** is confirmed available before any mutation.
- [ ] The intended bucket config is recorded: `contract-files` · `public=false` · `file_size_limit=26214400`
      (25 MiB = `MAX_CONTRACT_FILE_BYTES`) · `allowed_mime_types={application/pdf}` — identical to staging.
- [ ] **No service-role on any app/browser/request path** in the intended design (user-scoped client only).
- [ ] No secrets will be pasted into this doc, the PR, logs, screenshots, or chat.

## 2. Confirm the linked project is PRODUCTION — only when intentionally applying

> Production and staging are different projects. The CLI is normally linked to **staging**
> (`ycdpzduxugdsffjqyoai`). You re-link to **production** (`dzbfxulvxchdemcettrx`) **only** at the moment of an
> approved production apply, and you re-link **back to staging immediately after**.

- [ ] `supabase link --project-ref dzbfxulvxchdemcettrx` (production) — only inside the approved window.
- [ ] `cat supabase/.temp/project-ref` → **must print `dzbfxulvxchdemcettrx`** for the production steps, **and
      you have confirmed you intend a production apply.** If you did **not** intend production, STOP and re-link
      to staging.
- [ ] Cross-check the Supabase **dashboard project name** matches production before any mutating command.
- [ ] **Never** run a blanket `supabase db push --linked` to apply *everything* — the bucket + object policies
      are applied as the **specific, approved** changes only (§7). If the linked project or intent is unclear, **STOP**.
- [ ] After the production steps complete: **re-link back to staging** and confirm `supabase/.temp/project-ref`
      = `ycdpzduxugdsffjqyoai`, so the default link is not left pointing at production.

## 3. Confirm staging evidence (PR #55) is green and recorded

- [ ] [25 §0/§0.2/§0.3](./25_STAGING_SCHEMA_AND_STORAGE_APPLY_EVIDENCE.md) shows the **staging** apply +
      **REST authorization verification PASSED (14/14, 2026-06-18)** via `scripts/verify-staging-storage-rest.mjs`
      (real Storage REST API, user-scoped JWTs, no service-role, no production touched) + check-15 local `test-rls.sh` 222.
- [ ] Staging policy set = **2 `authenticated` policies (INSERT/SELECT), 0 unsafe** (no UPDATE/DELETE/`FOR ALL`/anon/public).
- [ ] **Production must reproduce the exact same applied artifact** as the verified staging set — no
      production-only divergence. **Do not proceed if staging evidence is missing, stale, or red.**

## 4. Production bucket — create or verify `contract-files`

- [ ] If absent: create the bucket via the production dashboard / Management API (human) with **`public=false`**,
      `file_size_limit=26214400`, `allowed_mime_types={application/pdf}`.
- [ ] If present: verify those exact values; **confirm `public=false`** (no public bucket, no public base URL).
- [ ] Record (redacted) the bucket-existence/privacy evidence — **no secrets**.

## 5. Production migration status through `0014`

- [ ] `supabase migration list --linked` (production) → confirm `0001`–`0014` are the expected applied set;
      **no unknown/duplicate** migration on production.
- [ ] If `0001`–`0014` are not all applied: apply only the expected, approved migrations under doc 20 (staging-
      first is already satisfied) — **never** an unreviewed blanket push.
- [ ] Re-run `supabase migration list --linked` and confirm `0001`–`0014` applied. Migration `0014` carries the
      `can_write_contract_file` / `can_read_contract_file` helpers the policies depend on.

## 6. Production helper-function verification

- [ ] Confirm both helpers exist in production (public schema):
      `public.can_write_contract_file(uuid, uuid)` and `public.can_read_contract_file(uuid, uuid)` — both
      `SECURITY DEFINER`, `stable`, `search_path=public` (from `0014`).
- [ ] Confirm they are **not** widened (write = `can_write_contract`, never `paying_org`; read = `is_tenant_member`)
      and that no `storage.*` policy is yet present for `contract-files` (that is §7).

## 7. Production Storage object-policy apply plan (the exact reviewed change)

> Apply the **same finalized policies as [22 §5](./22_HOSTED_STORAGE_BUCKET_APPLY_RUNBOOK.md)** — to **production
> `storage.objects`** (human-run; **not** a migration — doc 21). Two `authenticated` policies, nothing else:

- **INSERT** — `contract_files insert (metadata + contract-write)`: allowed only when a `files` metadata row
  exists for the path's `(file_id, tenant_id)` **and** the caller has contract-write authority
  (`can_write_contract_file`), on a server-derived `contracts/{uuid}/{uuid}.pdf` path (strict 8-4-4-4-12
  lowercase-UUID shape guard).
- **SELECT** — `contract_files select (readable metadata)`: allowed only when the caller can read the
  associated metadata (`can_read_contract_file`).
- **NO UPDATE policy. NO DELETE policy. NO `FOR ALL` policy. NO `anon`/public policy.** Overwrite/`upsert`/
  move/copy/delete and anonymous access all deny (no matching policy = deny). The exact SQL is doc 22 §5 Step B
  (apply it verbatim to production; do not improvise).

## 8. Structural policy verification (production)

- [ ] `select policyname, cmd, roles from pg_policies where schemaname='storage' and tablename='objects' and
      policyname ilike '%contract%'` → exactly the **2** policies above, both `{authenticated}`.
- [ ] **Unsafe-policy count = 0**: no UPDATE, no DELETE, no `ALL`/`FOR ALL`, no `anon`, no public policy.
- [ ] Object-path shape is the canonical `contracts/{tenant_id}/{file_id}.pdf` (8-4-4-4-12 lowercase UUIDs).
- [ ] Bucket is **private** (`public=false`). Record (redacted) evidence. **Structural ≠ live authz** (§9).

## 9. Production Storage REST authorization verification plan

> Reproduce the **staging** REST verification (doc 26) against **production**, with **production synthetic-only**
> fixtures — the same 15 obligations, user-scoped JWTs, **anon key only, no service-role**.

- [ ] One-time **production** admin fixture setup (separate, elevated, human-run; doc 26 §5 shape) creates
      **synthetic** users/tenants/orgs/contracts in production. **Use synthetic data only — never real customer
      data for the test; isolate + remove it afterward.**
- [ ] Run the **production-targeted** verifier: `supabase link --project-ref dzbfxulvxchdemcettrx` → confirm the
      ref → set **local** env `PRODUCTION_SUPABASE_URL` / `PRODUCTION_SUPABASE_ANON_KEY` /
      `PRODUCTION_STORAGE_TEST_USERS` (pointed at production; **local only, never committed, never printed**) →
      `node scripts/verify-production-storage-rest.mjs`.
      *(Use `scripts/verify-production-storage-rest.mjs` — the production variant (PR #57), which **fail-loud
      refuses** unless the linked ref + URL are production `dzbfxulvxchdemcettrx` and refuses the staging ref.
      Do NOT edit/weaken the staging verifier's guard. Both verifiers are user-scoped, anon-key-only, no
      service-role.)*
- [ ] **All 14 REST checks must pass** + check-12 self-test + check-15 local `test-rls.sh` 222 — same as staging.
- [ ] Confirm: real Storage REST API calls, user-scoped JWTs, **no service-role used by the verifier**, and
      record per-check `[PASS]` evidence (§11) — **no tokens/passwords/anon keys/JWTs**.

## 10. Stop and rollback rules

- **STOP immediately** on any of: linked project not confirmed production-with-intent; staging evidence
  missing/stale/red; an unexpected/unknown migration on production; a structural check showing an UPDATE/DELETE/
  `FOR ALL`/anon/public policy; any REST check failing; any sign of touching real customer data.
- **Rollback:** drop the just-applied `storage.objects` policies (and the bucket if newly created and empty);
  remove synthetic fixtures; restore from the §1 backup/restore point if needed. Record the rollback evidence.
- **Any tenant-isolation / public-access / destructive-write / service-role failure is CRITICAL → stop + roll
  back; do not proceed to cutover.**
- After stop/rollback, **re-link back to staging** and leave production untouched-beyond-rollback.

## 11. Evidence recording requirements

Record into a dated production evidence doc (e.g. a [23](./23_STORAGE_STAGING_APPLY_EVIDENCE_TEMPLATE.md) copy
or a new `docs/evidence/storage-prod-<date>.md`) — **names + redacted output + `pass/fail` only; no secrets**:

- [ ] Date / executor / **independent reviewer** initials; approval reference (doc 20 §3/§9).
- [ ] Linked ref confirmed `dzbfxulvxchdemcettrx`; window + customer-impact note.
- [ ] Bucket privacy evidence (`public=false`); migration list `0001`–`0014`; helper existence; the **2** policy
      names + cmds + roles; **unsafe-policy count = 0**.
- [ ] Production REST verifier result: **14/14** + check 12 + check 15 (`test-rls.sh` 222); confirmation of
      user-scoped JWTs + **no service-role**.
- [ ] Synthetic-test-data cleanup confirmation; rollback plan; **no secrets recorded** confirmation; re-linked to staging.

## 12. The doc 17 cutover checklist remains separate and required

- **This runbook applies + verifies the production Storage boundary. It does NOT authorize cutover.** Cutover is
  governed solely by [17 §5](./17_OMC_PRODUCTION_REPLACEMENT_PARITY_GATE.md) (the go/no-go) and the full
  [27](./27_LEGACY_OMC_FULL_PARITY_MATRIX.md) parity matrix, **all of which must independently pass**.
- **RISK-001 closure requires ALL of:** (1) staging policies applied ✅, (2) staging REST verification ✅
  (PR #55), (3) the **production apply** (this runbook, when executed + recorded), (4) **production verification**
  (§9, recorded), and (5) the [17 §5](./17_OMC_PRODUCTION_REPLACEMENT_PARITY_GATE.md) cutover checklist —
  ([04 · RISK-001](./04_RISK_REGISTER.md)). Until **all** are done, **RISK-001 remains OPEN and cutover remains BLOCKED.**

## Risk posture

**RISK-001** (full apply/verification incomplete), **RISK-002**, **RISK-007**, **RISK-016** remain **OPEN**.
Cutover stays **BLOCKED**. Executing this runbook later applies the production Storage boundary — it is **not**
production-ready, **not** upload-ready, **not** OMC-replacement-complete, and **does not** close RISK-001 or
authorize cutover on its own.
