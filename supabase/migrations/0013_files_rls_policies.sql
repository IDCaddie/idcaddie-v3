-- 0013_files_rls_policies.sql
--
-- Add the FIRST tested RLS policies for public.files — a SELECT (read) and an INSERT (write)
-- policy — so the table is no longer zero-policy/default-deny. This is the §5 step of
-- docs/16_CONTRACT_PDF_AI_EXTRACTION_DESIGN.md. It adds POLICIES ONLY: NO Storage bucket, NO upload
-- route, NO signed-URL logic, NO scan/AI/OCR, NO Edge Function/worker, NO service-role, NO UI, NO
-- table/column change. It does NOT edit any applied migration (0001–0012).
--
-- POSTURE (mirrors the contract model exactly):
--   * tenant-bound throughout; tenant_id ↔ contract_id are bound by the 0012 same-tenant FK.
--   * READ = tenant-member-only (org-scoped file read is a LATER, separate step — docs/16 §5).
--   * WRITE (insert) = the SAME contract-write authority as 0004: tenant owner/admin/editor, OR the
--     procurement-org manager of the linked contract. `paying_org_id` grants NO file write (read ≠
--     write — docs/13 §3). The writer must be themselves (`uploaded_by = auth.uid()` — no spoofing).
--   * NO UPDATE policy — file scan/extraction status transitions are a FUTURE worker/service design
--     (docs/16 §6/§8), deliberately NOT a broad user UPDATE. NO DELETE policy, NO `FOR ALL` — files
--     are evidence (archive/soft-delete is a separate future design; the 0004 no-hard-delete posture).
--
-- This still does NOT surface files in the app: there is no DAL/route/UI reading or writing files.
-- It only makes the future file surface AUTHORIZED-BY-DESIGN and TESTED (T33 updated + new T34).

begin;

-- ── Helper: caller has CONTRACT-WRITE authority for a given contract (the 0004 model) ─────────────
-- SECURITY DEFINER so it reads contracts.procurement_org_id regardless of RLS — the same pattern as
-- has_tenant_role / has_org_role_in_tenant (0001/0002). NO recursion: contracts/org-membership
-- policies never reference files. SECURITY DEFINER changes only the executing ROLE, not session GUCs,
-- so auth.uid() inside the membership helpers still resolves to the CALLER (the writing user).
-- `paying_org_id` is NEVER referenced here, so it can never grant file write.
create or replace function public.can_write_contract(target_contract_id uuid, target_tenant_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select
    public.has_tenant_role(target_tenant_id, array['owner','admin','editor'])
    or exists (
      select 1
      from public.contracts c
      where c.id = target_contract_id
        and c.tenant_id = target_tenant_id
        and public.has_org_role_in_tenant(c.procurement_org_id, c.tenant_id, array['manager'])
    );
$$;

-- ── SELECT: tenant members read their tenant's files ─────────────────────────────────────────────
-- Tenant-member-only for now (org-scoped read — an org user reading a file iff they can read the
-- linked contract — is a LATER step, mirroring how app_contracts/app_users were tenant-only before
-- 0006/0007). NOTE the deliberate asymmetry: an org procurement-manager may INSERT a file for their
-- contract (below) but cannot yet LIST files (no tenant membership) — read is broadened later.
create policy "members read tenant files" on public.files
for select using (public.is_tenant_member(tenant_id));

-- ── INSERT: only a contract-writer may create a file metadata row, only as themselves ────────────
-- can_write_contract = tenant editor+ OR procurement-org manager of the linked contract (0004). With
-- contract_id NULL, can_write_contract reduces to the tenant-editor branch (an org manager has no
-- contract to anchor on). uploaded_by must equal the caller (no uploaded_by spoofing). paying_org
-- never qualifies. The 0012 (contract_id, tenant_id) FK blocks any cross-tenant contract attachment.
create policy "writers insert contract files" on public.files
for insert with check (
  uploaded_by = auth.uid()
  and public.can_write_contract(contract_id, tenant_id)
);

-- No UPDATE / DELETE / FOR ALL policy is added (see header).

commit;
