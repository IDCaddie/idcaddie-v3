# 29 · Production Storage Apply & REST Verification — Evidence (2026-06-18)

**Dated evidence record for the human-executed PRODUCTION apply + verification of the private `contract-files`
bucket + `storage.objects` policies** — the production analog of the staging evidence
([25](./25_STAGING_SCHEMA_AND_STORAGE_APPLY_EVIDENCE.md)), executed per the runbook
[28_PRODUCTION_STORAGE_APPLY_RUNBOOK](./28_PRODUCTION_STORAGE_APPLY_RUNBOOK.md).

> ## ⚠️ STATUS BANNER (do not remove)
> - **Production Storage REST authorization verification PASSED** (14/14) against production `dzbfxulvxchdemcettrx`.
> - **The production verifier used real Supabase Storage REST API calls with user-scoped JWTs.**
> - **No service-role key was used by the verifier.** **No secrets, passwords, anon keys, or JWTs are recorded** here.
> - **Production apply and verification do not approve cutover by themselves.**
> - **RISK-001 remains OPEN** — its closure criterion (5) (the [17 §5](./17_OMC_PRODUCTION_REPLACEMENT_PARITY_GATE.md)
>   cutover checklist) is **not** satisfied; only (1)–(4) are. The risk register does not state every closure
>   criterion is satisfied ([04 · RISK-001](./04_RISK_REGISTER.md)).
> - **Cutover remains BLOCKED until the doc 17 cutover checklist passes.**
> - **Upload is not automatically production-ready** (no upload route/action/UI, signed-URL route, or AI
>   extraction has shipped).
> - **This PR records evidence + codifies a discovered grant (migration `0015`). It runs no production command
>   and mutates nothing.**

---

## 1. Execution metadata

| Field | Value |
|---|---|
| Date | 2026-06-18 |
| Executor | **Human operator** (the agent ran nothing against production) |
| Production project ref | `dzbfxulvxchdemcettrx` |
| Staging project ref (for contrast) | `ycdpzduxugdsffjqyoai` |
| CLI link now | re-linked back to staging (`ycdpzduxugdsffjqyoai`) |
| Recorded by | this PR (docs/evidence + migration `0015` codification only — no production command run) |

## 2. Production apply — recorded

- **Migrations:** `0001`–`0014` applied successfully to production.
- **Private bucket `contract-files`:** `public=false` · `file_size_limit=26214400` (25 MiB) · `allowed_mime_types=[application/pdf]`.
- **`storage.objects` policies — exactly 2 contract policies, both `{authenticated}`:**

  | Policy | cmd | roles |
  |---|---|---|
  | `contract_files insert (metadata + contract-write)` | INSERT | `{authenticated}` |
  | `contract_files select (readable metadata)` | SELECT | `{authenticated}` |

- **Unsafe policy count = 0** (no UPDATE, no DELETE, no `ALL`/`FOR ALL`, no `anon`, no public).
- **Production synthetic Auth users:** 6 synthetic `@idcaddie-production.local` users created (synthetic-only test identities).
- **Production synthetic fixture counts:** tenants=2 · profiles=6 · tenant_memberships=3 · organizations=5 · organization_memberships=3 · contracts=3 · files=0 (before the verifier run).

## 3. Production discovery — `public.files` privilege grant (codified as migration `0015`)

The production verifier initially **failed**: the `authenticated` role lacked base table privileges on
`public.files` even though the `0013` RLS policies existed (RLS gates *which* rows; the role still needs the
base SELECT/INSERT table privilege). The human applied:

```
grant select, insert on public.files to authenticated;
```

After that, the rollback insert probe passed and the verifier passed **14/14**.

**Codification:** this PR adds **`supabase/migrations/0015_files_authenticated_grants.sql`** with exactly that
idempotent grant — **SELECT + INSERT only** (mirrors the `0013` policy surface; no UPDATE/DELETE policy ⇒ no
UPDATE/DELETE privilege), **`authenticated` only** (no `anon`, no `service_role`). The local `test-rls.sh`
harness had masked this gap by applying a broad blanket grant itself (not part of the migration chain); `0015`
puts the **specific** privilege into the schema so any hosted apply gets it deterministically. (Grant not
broadened; Storage policies untouched.)

## 4. Production Storage REST authorization verification — PASSED 14/14

`node scripts/verify-production-storage-rest.mjs` (production-targeted, user-scoped, anon-key-only, fail-loud)
run against production `dzbfxulvxchdemcettrx`:

| # | Check | Result |
|---|---|---|
| 1 | Tenant editor can upload under own tenant prefix | **PASS** |
| 1b | Tenant editor cannot upload under another tenant prefix | **PASS** |
| 2 | Procurement-org manager uploads only where contract-write authority exists | **PASS** |
| 3 | Paying-org manager is denied upload | **PASS** |
| 4 | Tenant viewer is denied upload | **PASS** |
| 5 | Cross-org manager is denied upload | **PASS** |
| 6 | Tenant A cannot read or list tenant B prefix | **PASS** |
| 7 | Tenant B cannot read, list, or sign tenant A object | **PASS** |
| 8 | Anonymous/public GET is denied | **PASS** |
| 9 | Overwrite/upsert is denied | **PASS** |
| 10 | Move/copy/delete are denied | **PASS** |
| 11 | Signed URL is single-object scoped with 60s `expiresIn` | **PASS** |
| 12 | Object-path shape self-test | **PASS** |
| 13 | Bad-UUID / traversal paths fail closed | **PASS** |
| 14 | `files` table is the source of truth (no files row ⇒ upload denied) | **PASS** |
| 15 | Local RLS remains separate — verify with `scripts/test-rls.sh` (222) | local (not a REST check) |

**The production verifier used real Supabase Storage REST API calls with user-scoped JWTs. No service-role key
was used by the verifier. No secrets, passwords, anon keys, or JWTs are recorded.**

## 5. RISK-001 status after this evidence

Per [04 · RISK-001](./04_RISK_REGISTER.md) the closure criteria are:

| # | Criterion | Status |
|---|---|---|
| 1 | Staging object policies applied | ✅ DONE (PR #52) |
| 2 | Staging REST authorization verification | ✅ DONE (PR #55) |
| 3 | Production apply + production REST verification | ✅ DONE (this evidence — §2/§4) |
| 4 | Evidence recorded | ✅ DONE (this doc + migration `0015`) |
| 5 | [17 §5](./17_OMC_PRODUCTION_REPLACEMENT_PARITY_GATE.md) cutover checklist satisfied | ⏳ **NOT satisfied** |

**Criterion (5) is not met, so RISK-001 remains OPEN.** Production apply + verification do **not** approve
cutover by themselves; **cutover remains BLOCKED until the doc 17 cutover checklist passes**, which also depends
on the full [27](./27_LEGACY_OMC_FULL_PARITY_MATRIX.md) parity matrix (mostly missing/blocked). **Upload is not
automatically production-ready.** v3 is **not** OMC-replacement-complete. OMC/Flywheel is a paying production
**replacement, not a pilot**.
