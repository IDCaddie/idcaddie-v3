-- ============================================================================
-- local_demo.sql — LOCAL/DEMO fixture for ID Caddie v3.  NOT a migration.
-- ============================================================================
-- Purpose: predictable, repeatable sample data for local development and demos
-- (a tenant, organizations, memberships, sample apps/contracts) so tenant/org
-- context resolution and the future read-only inventory have something to show.
--
-- ⛔ LOCAL ONLY. Never apply to hosted Supabase. Never include in
--    supabase/migrations/. Never `supabase db push`. This file:
--      * INSERTS synthetic rows into `auth.users` — only valid against a LOCAL
--        auth shim / local stack; hosted GoTrue owns that table.
--      * is run by scripts/seed-local-demo.sh against a throwaway local Postgres.
--
-- Safe to rerun: deterministic UUIDs + idempotent upserts (no destructive TRUNCATE).
-- All data is synthetic. No real customer names, no PII, no secrets. App/vendor
-- names (Slack, Google Workspace, Salesforce) are generic product names, not customers.
-- ============================================================================

begin;

-- ── Demo auth users (LOCAL shim only) ──────────────────────────────────────
-- u1: tenant owner + org manager (the primary stable demo user).
-- u2: org-only user (no tenant membership) to exercise the org-only context path.
insert into auth.users (id, email) values
  ('d0000000-0000-0000-0000-000000000001','demo.owner@example.test'),
  ('d0000000-0000-0000-0000-000000000002','demo.orguser@example.test')
on conflict (id) do nothing;

insert into public.profiles (id, email, full_name) values
  ('d0000000-0000-0000-0000-000000000001','demo.owner@example.test','Demo Owner'),
  ('d0000000-0000-0000-0000-000000000002','demo.orguser@example.test','Demo Org User')
on conflict (id) do update set email = excluded.email, full_name = excluded.full_name;

-- ── Tenant ─────────────────────────────────────────────────────────────────
insert into public.tenants (id, name, slug) values
  ('d0000000-0000-0000-0000-00000000a000','Demo Tenant','demo-tenant')
on conflict (id) do update set name = excluded.name, slug = excluded.slug;

-- ── Organizations (all in Demo Tenant) ─────────────────────────────────────
insert into public.organizations (id, tenant_id, name, type) values
  ('d0000000-0000-0000-0000-00000000b001','d0000000-0000-0000-0000-00000000a000','Demo Corporate','business_unit'),
  ('d0000000-0000-0000-0000-00000000b002','d0000000-0000-0000-0000-00000000a000','Demo Marketing','agency'),
  ('d0000000-0000-0000-0000-00000000b003','d0000000-0000-0000-0000-00000000a000','Demo IT','business_unit'),
  ('d0000000-0000-0000-0000-00000000b004','d0000000-0000-0000-0000-00000000a000','Demo Procurement','business_unit')
on conflict (id) do update set name = excluded.name, type = excluded.type;

-- ── Memberships ────────────────────────────────────────────────────────────
-- u1: active tenant owner of Demo Tenant.
insert into public.tenant_memberships (id, tenant_id, user_id, role, status) values
  ('d0000000-0000-0000-0000-00000000c001','d0000000-0000-0000-0000-00000000a000','d0000000-0000-0000-0000-000000000001','owner','active')
on conflict (id) do update set role = excluded.role, status = excluded.status;

-- u1 also manages Demo IT; u2 (org-only) manages Demo Marketing.
insert into public.organization_memberships (id, organization_id, user_id, role) values
  ('d0000000-0000-0000-0000-00000000c002','d0000000-0000-0000-0000-00000000b003','d0000000-0000-0000-0000-000000000001','manager'),
  ('d0000000-0000-0000-0000-00000000c003','d0000000-0000-0000-0000-00000000b002','d0000000-0000-0000-0000-000000000002','manager')
on conflict (id) do update set role = excluded.role;

-- ── Sample apps (owning-org FKs pass enforce_owning_org_tenant: all Demo Tenant) ──
insert into public.apps
  (id, tenant_id, name, vendor_name, category, status,
   responsible_org_id, paying_org_id, procurement_owner_org_id) values
  ('d0000000-0000-0000-0000-00000000e001','d0000000-0000-0000-0000-00000000a000','Slack','Slack','Collaboration','active',
   'd0000000-0000-0000-0000-00000000b003','d0000000-0000-0000-0000-00000000b002','d0000000-0000-0000-0000-00000000b004'),
  ('d0000000-0000-0000-0000-00000000e002','d0000000-0000-0000-0000-00000000a000','Google Workspace','Google','Productivity','active',
   'd0000000-0000-0000-0000-00000000b003','d0000000-0000-0000-0000-00000000b001','d0000000-0000-0000-0000-00000000b004'),
  ('d0000000-0000-0000-0000-00000000e003','d0000000-0000-0000-0000-00000000a000','Salesforce','Salesforce','CRM','active',
   'd0000000-0000-0000-0000-00000000b002','d0000000-0000-0000-0000-00000000b002','d0000000-0000-0000-0000-00000000b004')
on conflict (id) do update set
  name = excluded.name, vendor_name = excluded.vendor_name, category = excluded.category,
  status = excluded.status, responsible_org_id = excluded.responsible_org_id,
  paying_org_id = excluded.paying_org_id, procurement_owner_org_id = excluded.procurement_owner_org_id;

-- ── Sample contracts ───────────────────────────────────────────────────────
insert into public.contracts
  (id, tenant_id, vendor_name, contract_name, status, currency, total_cost,
   procurement_org_id, paying_org_id) values
  ('d0000000-0000-0000-0000-00000000f001','d0000000-0000-0000-0000-00000000a000','Slack','Slack Enterprise Agreement','active','USD',48000.00,
   'd0000000-0000-0000-0000-00000000b004','d0000000-0000-0000-0000-00000000b002'),
  ('d0000000-0000-0000-0000-00000000f002','d0000000-0000-0000-0000-00000000a000','Google','Google Workspace Agreement','active','USD',72000.00,
   'd0000000-0000-0000-0000-00000000b004','d0000000-0000-0000-0000-00000000b001')
on conflict (id) do update set
  contract_name = excluded.contract_name, status = excluded.status,
  total_cost = excluded.total_cost, procurement_org_id = excluded.procurement_org_id,
  paying_org_id = excluded.paying_org_id;

-- ── App ↔ contract links ───────────────────────────────────────────────────
insert into public.app_contracts (app_id, contract_id, tenant_id, relationship_type) values
  ('d0000000-0000-0000-0000-00000000e001','d0000000-0000-0000-0000-00000000f001','d0000000-0000-0000-0000-00000000a000','primary'),
  ('d0000000-0000-0000-0000-00000000e002','d0000000-0000-0000-0000-00000000f002','d0000000-0000-0000-0000-00000000a000','primary')
on conflict (app_id, contract_id) do nothing;

commit;
