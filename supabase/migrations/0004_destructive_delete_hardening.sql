-- 0004_destructive_delete_hardening.sql
--
-- Remove normal authenticated HARD-DELETE access from core business/evidence tables.
-- Before any write UI exists, a deleted app/contract/person/app-user/org/app-contract-link
-- would destroy customer evidence with no recovery path and no archive UI. So we split the
-- broad `FOR ALL` manage policies (which silently grant DELETE) into explicit INSERT + UPDATE
-- policies and DO NOT recreate a DELETE policy. With no permissive DELETE policy, RLS makes a
-- DELETE affect 0 rows for `authenticated` — reads/inserts/updates are unchanged.
--
-- Scope (the 6 evidence tables among the core set that had a FOR ALL policy):
--   organizations, apps, contracts, app_contracts, people, app_users
-- The other "core" tables (identity_accounts, app_user_identity_matches, license_rules,
-- license_evaluations, files, invoices) have RLS enabled but NO policy = default-deny already
-- (incl. DELETE), so nothing to change there; their future write policies must likewise omit DELETE.
--
-- Intentionally NOT touched:
--   * tenant_memberships / organization_memberships keep their FOR ALL manage policies —
--     removing a membership is normal, reversible access administration, not evidence destruction.
--   * audit_logs stays append-only (no policy + trigger; 0002).
--   * All SELECT policies (tenant + org-union reads from 0001/0002/0003) are untouched, so
--     `/apps` and `/apps/[id]` read behavior is preserved.
--
-- Future hard-delete (if ever needed) belongs in an audited admin/service break-glass path,
-- not the general authenticated app path. Archive / soft-delete UI is NOT built in this PR.
--
-- Reversible for review: re-adding a `FOR ALL ... ` policy would restore the old behavior, but
-- that is exactly the unsafe path this migration removes — do not.

begin;

-- ── Tenant-wide editor manage (0001 "editors manage <t>" FOR ALL) → INSERT + UPDATE ──────────
-- owner/admin/editor keep create + edit on their tenant's rows; DELETE is removed.

drop policy if exists "editors manage organizations" on public.organizations;
create policy "editors insert organizations" on public.organizations
  for insert with check (public.has_tenant_role(tenant_id, array['owner','admin','editor']));
create policy "editors update organizations" on public.organizations
  for update using (public.has_tenant_role(tenant_id, array['owner','admin','editor']))
  with check (public.has_tenant_role(tenant_id, array['owner','admin','editor']));

drop policy if exists "editors manage apps" on public.apps;
create policy "editors insert apps" on public.apps
  for insert with check (public.has_tenant_role(tenant_id, array['owner','admin','editor']));
create policy "editors update apps" on public.apps
  for update using (public.has_tenant_role(tenant_id, array['owner','admin','editor']))
  with check (public.has_tenant_role(tenant_id, array['owner','admin','editor']));

drop policy if exists "editors manage contracts" on public.contracts;
create policy "editors insert contracts" on public.contracts
  for insert with check (public.has_tenant_role(tenant_id, array['owner','admin','editor']));
create policy "editors update contracts" on public.contracts
  for update using (public.has_tenant_role(tenant_id, array['owner','admin','editor']))
  with check (public.has_tenant_role(tenant_id, array['owner','admin','editor']));

drop policy if exists "editors manage app_contracts" on public.app_contracts;
create policy "editors insert app_contracts" on public.app_contracts
  for insert with check (public.has_tenant_role(tenant_id, array['owner','admin','editor']));
create policy "editors update app_contracts" on public.app_contracts
  for update using (public.has_tenant_role(tenant_id, array['owner','admin','editor']))
  with check (public.has_tenant_role(tenant_id, array['owner','admin','editor']));

drop policy if exists "editors manage people" on public.people;
create policy "editors insert people" on public.people
  for insert with check (public.has_tenant_role(tenant_id, array['owner','admin','editor']));
create policy "editors update people" on public.people
  for update using (public.has_tenant_role(tenant_id, array['owner','admin','editor']))
  with check (public.has_tenant_role(tenant_id, array['owner','admin','editor']));

drop policy if exists "editors manage app users" on public.app_users;
create policy "editors insert app users" on public.app_users
  for insert with check (public.has_tenant_role(tenant_id, array['owner','admin','editor']));
create policy "editors update app users" on public.app_users
  for update using (public.has_tenant_role(tenant_id, array['owner','admin','editor']))
  with check (public.has_tenant_role(tenant_id, array['owner','admin','editor']));

-- ── Org-manager steward manage (0002 "org managers manage org <t>" FOR ALL) → INSERT + UPDATE ─
-- Steward (org manager of the canonical owning org, tenant-bound) keeps create + edit; DELETE removed.

drop policy if exists "org managers manage org apps" on public.apps;
create policy "org managers insert org apps" on public.apps
  for insert with check (public.has_org_role_in_tenant(responsible_org_id, tenant_id, array['manager']));
create policy "org managers update org apps" on public.apps
  for update using (public.has_org_role_in_tenant(responsible_org_id, tenant_id, array['manager']))
  with check (public.has_org_role_in_tenant(responsible_org_id, tenant_id, array['manager']));

drop policy if exists "org managers manage org contracts" on public.contracts;
create policy "org managers insert org contracts" on public.contracts
  for insert with check (public.has_org_role_in_tenant(procurement_org_id, tenant_id, array['manager']));
create policy "org managers update org contracts" on public.contracts
  for update using (public.has_org_role_in_tenant(procurement_org_id, tenant_id, array['manager']))
  with check (public.has_org_role_in_tenant(procurement_org_id, tenant_id, array['manager']));

commit;
