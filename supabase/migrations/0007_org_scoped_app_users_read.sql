-- 0007_org_scoped_app_users_read.sql
--
-- Org-scoped READ for `app_users` (narrows RISK-002 for this one child table — READ ONLY).
--
-- Before this, `app_users` had only a tenant-member SELECT policy ("members read app users", `0001`),
-- so an org-only user (no tenant membership) could not read ANY app-user rows. That blocked showing a
-- per-app account roster on an app detail page for org-only users.
--
-- This adds ONE permissive SELECT policy: an org-only user may read an `app_users` row iff they can
-- ALREADY read the linked **app** under their existing related-org RLS. We express that by reusing
-- `apps` RLS directly — the EXISTS subquery is itself filtered by `apps`' SELECT policies for the
-- invoking user, so this grants NO visibility beyond "you can already read the app this user belongs
-- to". (Same subquery-RLS mechanism as `0003`/`0006`.)
--
-- The subquery ALSO pins `a.tenant_id = app_users.tenant_id` explicitly (mirroring `0003`'s apps
-- policy), so the policy is self-sufficient for tenant isolation rather than relying solely on the
-- `0005` same-tenant FK (`app_users_app_same_tenant`, which already forces the pair to match on every
-- write). Belt-and-suspenders: even a (normally-impossible) corrupt cross-tenant row planted by
-- bypassing that FK would be denied by this policy. `app_users.tenant_id` is NOT NULL. Proven by T29
-- (positive + cross-tenant/non-member denial + a planted-corrupt-row defense check).
-- NOTE: the sibling `0006` (`app_contracts`) currently relies on the `0005` FK for the same binding
-- (proven no-leak by T28); hardening it with an explicit tenant clause is a safe future follow-up.
--
-- Scope guardrails:
--   * SELECT only. The tenant-member read ("members read app users") and the editor INSERT/UPDATE
--     policies (`0004`) are untouched. NO DELETE policy is added — `0004`'s hard-delete protection holds.
--   * Read for `app_users` ONLY. `people`, `identity_accounts`, `app_user_identity_matches`,
--     `license_rules`, `license_evaluations`, `files`, `invoices` are unchanged (tenant-only or
--     default-deny). No identity matching / license evaluation / provisioning. RISK-002 is NARROWED,
--     not closed.

begin;

create policy "org members read related app_users" on public.app_users
for select using (
  exists (
    select 1 from public.apps a
    where a.id = app_users.app_id
      and a.tenant_id = app_users.tenant_id   -- explicit tenant-bind (defense in depth; mirrors 0003)
  )
);

commit;
