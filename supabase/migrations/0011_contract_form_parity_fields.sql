-- 0011_contract_form_parity_fields.sql
--
-- Add the schema-backed legacy contract-form fields that v3 can safely support now (PR #32),
-- closing the low-risk parity gaps recorded in docs/15_LEGACY_CONTRACT_FORM_INSPECTION.md. These are
-- PLAIN, ADDITIVE column additions to public.contracts — NO RLS/policy change, NO DELETE/FOR ALL, NO
-- audit-trigger change, NO data backfill, NO edit of an applied migration.
--
-- SAFE FOR EXISTING ROWS: the four text/date columns are nullable (existing rows read NULL until
-- edited); the two boolean flags are NOT NULL DEFAULT false — matching the 0001 convention
-- (license_rules.active, license_evaluations.is_billable) — so every existing contract reads
-- auto_renew=false / month_to_month=false, a safe non-destructive default (Postgres backfills the
-- default in place; no row is rewritten with surprising data).
--
-- AUTHORIZATION + AUDIT UNCHANGED: the existing write authority (0004 — tenant editor+ OR
-- procurement-org manager; paying_org never grants write; no DELETE/FOR ALL) and the audit-on-write
-- trigger (0010) already govern these new columns automatically — an INSERT/UPDATE that sets them is
-- authorized and audited with no change here. The 0010 after_json allowlist intentionally records
-- only id/name/operation/status/org-ids; these new fields are ordinary, non-sensitive contract data
-- (shown in the normal UI), so they are deliberately NOT added to the audit metadata.
--
-- DELIBERATELY NOT ADDED (see docs/15): legacy `commodity_software` / `commodity_leases` (hidden in
-- the legacy app via `showif … && false` — not user-visible) and `validated` (legacy read-only,
-- system-managed — not part of a create/edit form). Adding them would be inventing UI, not parity.

begin;

alter table public.contracts
  add column category text,
  add column procurement_date date,
  add column notes text,
  add column po_number text,
  add column auto_renew boolean not null default false,
  add column month_to_month boolean not null default false;

commit;
