-- 0012_files_metadata_foundation.sql
--
-- Add the metadata columns the FUTURE contract PDF upload + AI extraction workflow
-- (docs/16_CONTRACT_PDF_AI_EXTRACTION_DESIGN.md) will need — WITHOUT surfacing the table. This is
-- ADDITIVE schema only: NO RLS policy, NO Storage, NO bucket, NO functions/jobs, NO upload/route/UI,
-- NO signed-URL logic, NO AI/OCR, NO Edge Function, NO service-role, NO DELETE/FOR ALL, NO edit of
-- an applied migration. `public.files` stays RLS-enabled but DEFAULT-DENY (no policy) — it remains
-- not surfaced; nothing is readable/writable by `authenticated` until a future, separately-tested RLS
-- PR. **RISK-002 stays OPEN.**
--
-- SAFE FOR EXISTING ROWS: every added column is nullable OR NOT NULL with a default, so Postgres
-- backfills the default in place without rewriting surprising data — the metadata columns
-- (contract_id/storage_bucket/content_type/byte_size/sha256/extraction_result_json/extraction_error)
-- are nullable; the three lifecycle flags default to their initial state (upload `pending`, scan
-- `pending`, extraction `not_started`); `updated_at` defaults to now().
--
-- SAME-TENANT INTEGRITY (the `0005` pattern): `contract_id` gets a COMPOSITE same-tenant FK
-- `(contract_id, tenant_id) -> contracts(id, tenant_id)`, reusing the `contracts_id_tenant_key`
-- UNIQUE(id, tenant_id) that `0005` already created (no new parent constraint needed). MATCH SIMPLE
-- (default) keeps a NULL `contract_id` valid; the pair must match, so a tenant-B file can NEVER be
-- attached to a tenant-A contract — the write fails with a foreign_key_violation at the constraint
-- layer, not merely hidden by RLS. Default ON DELETE (NO ACTION): a composite FK cannot use
-- ON DELETE SET NULL (it would null the NOT NULL `tenant_id`), and contracts are not hard-deletable
-- (`0004`); tenant deletion still cascades both files and contracts via their own `tenant_id` FKs.
--
-- updated_at: the schema has NO standard moddatetime/updated_at trigger — every table's `updated_at`
-- is default-only and bumped explicitly by the writer (e.g. `contracts`). We keep that convention:
-- `updated_at` defaults to now() on insert; a future writer/worker sets it on update. A project-wide
-- moddatetime trigger is a separate decision, deliberately NOT introduced by this foundation PR.
--
-- Status enums match docs/16 §4 as implemented here (the design doc is updated to these exact values).

begin;

alter table public.files
  add column contract_id uuid,
  add column storage_bucket text,
  add column content_type text,
  add column byte_size bigint,
  add column sha256 text,
  add column upload_status text not null default 'pending',
  add column scan_status text not null default 'pending',
  add column extraction_status text not null default 'not_started',
  add column extraction_result_json jsonb,
  add column extraction_error text,
  add column updated_at timestamptz not null default now();

-- Tight status enums + value guards (only the designed states / well-formed values are storable).
alter table public.files
  add constraint files_upload_status_check
    check (upload_status in ('pending','uploaded','failed')),
  add constraint files_scan_status_check
    check (scan_status in ('pending','passed','failed','skipped')),
  add constraint files_extraction_status_check
    check (extraction_status in ('not_started','queued','processing','completed','failed')),
  add constraint files_byte_size_nonneg
    check (byte_size is null or byte_size >= 0),
  add constraint files_sha256_hex
    check (sha256 is null or sha256 ~ '^[a-f0-9]{64}$');

-- Same-tenant composite FK for the contract link (0005 pattern; reuses contracts_id_tenant_key).
alter table public.files
  add constraint files_contract_same_tenant
    foreign key (contract_id, tenant_id) references public.contracts (id, tenant_id);

-- Tenant-scoped indexes to support FUTURE contract-file reads + status/job sweeps (not surfaced yet).
create index files_tenant_contract_idx        on public.files (tenant_id, contract_id);
create index files_tenant_upload_status_idx    on public.files (tenant_id, upload_status);
create index files_tenant_scan_status_idx      on public.files (tenant_id, scan_status);
create index files_tenant_extraction_status_idx on public.files (tenant_id, extraction_status);

commit;
