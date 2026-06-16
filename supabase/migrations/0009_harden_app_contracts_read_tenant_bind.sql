-- 0009_harden_app_contracts_read_tenant_bind.sql
--
-- Defense-in-depth: make the org-scoped READ policy on `app_contracts` self-sufficient for tenant
-- isolation, matching the standard set by `0007` (app_users) and `0008` (app_user_identity_matches).
--
-- `0006` added "org members read related app_contracts": read a link iff you can read the linked app
-- OR contract (reusing their RLS). That is safe for valid data — the `0005` same-tenant FKs
-- (`app_contracts_app_same_tenant`, `app_contracts_contract_same_tenant`) force the link's `tenant_id`
-- to equal the linked app's and contract's `tenant_id` on every write. But the `0006` policy did not
-- pin tenant INSIDE the policy, so a (normally-impossible) FK-bypassed corrupt row — e.g. one planted
-- via `session_replication_role = replica` by a superuser — would not be re-checked by the policy.
--
-- This forward migration REPLACES that one SELECT policy with an identical one that ALSO pins
-- `a.tenant_id = app_contracts.tenant_id` (app branch) and `c.tenant_id = app_contracts.tenant_id`
-- (contract branch). For valid same-tenant data the behavior is UNCHANGED (the FK already guarantees
-- the pair matches, so the added clause is always true for real rows). Proven by T28 (unchanged valid
-- behavior) + T28h (a planted corrupt cross-tenant row is now hidden).
--
-- Scope: SELECT only. The tenant-member read ("members read app_contracts") and the editor
-- INSERT/UPDATE policies (`0004`) are untouched; NO `DELETE`, NO `FOR ALL`. No other table changed —
-- `people`/`identity_accounts`/`license_*`/`files`/`invoices` are not broadened. `0006` is NOT edited
-- (forward migration only). This is hardening only; RISK-002 stays open.

begin;

drop policy if exists "org members read related app_contracts" on public.app_contracts;

create policy "org members read related app_contracts" on public.app_contracts
for select using (
  exists (
    select 1
    from public.apps a
    where a.id = app_contracts.app_id
      and a.tenant_id = app_contracts.tenant_id   -- explicit tenant-bind (mirror 0007/0008)
  )
  or exists (
    select 1
    from public.contracts c
    where c.id = app_contracts.contract_id
      and c.tenant_id = app_contracts.tenant_id   -- explicit tenant-bind (mirror 0007/0008)
  )
);

commit;
