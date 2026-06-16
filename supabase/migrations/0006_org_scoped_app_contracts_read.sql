-- 0006_org_scoped_app_contracts_read.sql
--
-- Org-scoped READ for `app_contracts` (narrows RISK-002 for this one link table — READ ONLY).
--
-- Before this, `app_contracts` had only a tenant-member SELECT policy ("members read app_contracts",
-- `0001`), so an org-only user (no tenant membership) could not read ANY link rows. That blocked
-- showing "linked apps" on a contract and "linked contracts" on an app for org-only users.
--
-- This adds ONE permissive SELECT policy: an org-only user may read a link row iff they can ALREADY
-- read the linked app OR the linked contract under their existing related-org RLS. We express that by
-- reusing `apps`/`contracts` RLS directly — the EXISTS subqueries are themselves filtered by those
-- tables' SELECT policies for the invoking user, so this grants NO visibility beyond "you can already
-- read one side of the link". (This is the same subquery-RLS mechanism `0003` already relies on.)
-- The same-tenant composite FKs (`0005`) guarantee the linked app/contract live in the link's own
-- tenant, so there is no cross-tenant path. Proven by T28 (positive + cross-tenant-denial assertions).
--
-- Scope guardrails:
--   * SELECT only. The tenant-member read ("members read app_contracts") and the editor INSERT/UPDATE
--     policies (`0004`) are untouched. NO DELETE policy is added — `0004`'s hard-delete protection holds.
--   * Read for `app_contracts` ONLY. `people`, `app_users`, `identity_accounts`, `files`, `invoices`,
--     `license_rules`, `license_evaluations` are unchanged (tenant-only or default-deny). RISK-002 is
--     NARROWED, not closed.

begin;

create policy "org members read related app_contracts" on public.app_contracts
for select using (
  exists (select 1 from public.apps a      where a.id = app_contracts.app_id)
  or
  exists (select 1 from public.contracts c where c.id = app_contracts.contract_id)
);

commit;
