-- 0003_org_access_union.sql
-- Fast-follow to 0002. Additive (0001 and 0002 are unchanged).
--
-- PRODUCT RULE (the SQL best practice Mike asked about):
--   READ access derives from the resource's RELATED org facts, not one column.
--   WRITE/stewardship stays SINGLE-org.
--
--   apps     : read  = member of responsible_org_id OR paying_org_id OR procurement_owner_org_id
--              write = member(manager) of responsible_org_id          (steward — unchanged from 0002)
--   contracts: read  = member of procurement_org_id OR paying_org_id
--              write = member(manager) of procurement_org_id           (steward — unchanged from 0002)
--
-- Why: in a holding-company tenant (Omnicom) procurement is often centralized, so a
-- single owning-org column hides resources from the agency that actually pays for or
-- consumes them — breaking chargeback. Reads must follow any related org; only the
-- steward writes. The tenant wall, exact-org writes, audit immutability and the
-- admin-self-promotion fix from 0001/0002 all remain in force.
--
-- Every org FK that now grants READ must also be tenant-bound, so the integrity
-- trigger is broadened to validate ALL access-relevant org columns.
--
-- Future enterprise model may replace these columns with a resource_org_links
-- relationship table + org hierarchy (see docs/v3-data-model.md).

begin;

-- ── apps: broaden READ to the related-org union (writes unchanged) ───────────
drop policy if exists "org members read org apps" on public.apps;
create policy "org members read related apps" on public.apps
for select using (
  exists (
    select 1
    from public.organization_memberships om
    join public.organizations o on o.id = om.organization_id
    where om.user_id = auth.uid()
      and o.tenant_id = apps.tenant_id                       -- tenant-bound (no cross-tenant leak)
      and om.organization_id in (
        apps.responsible_org_id,
        apps.paying_org_id,
        apps.procurement_owner_org_id
      )
  )
);
-- NOTE: "org managers manage org apps" (write/steward = responsible_org_id) is left
-- exactly as 0002 defined it. Reads are multi-org; writes stay single-org.

-- ── contracts: broaden READ to the related-org union (writes unchanged) ──────
drop policy if exists "org members read org contracts" on public.contracts;
create policy "org members read related contracts" on public.contracts
for select using (
  exists (
    select 1
    from public.organization_memberships om
    join public.organizations o on o.id = om.organization_id
    where om.user_id = auth.uid()
      and o.tenant_id = contracts.tenant_id
      and om.organization_id in (
        contracts.procurement_org_id,
        contracts.paying_org_id
      )
  )
);
-- "org managers manage org contracts" (write/steward = procurement_org_id) unchanged.

-- ── Integrity: tenant-bind EVERY access-relevant org FK ──────────────────────
-- 0002 validated only the steward column; now paying/procurement-owner columns also
-- grant read, so all of them must belong to the row's tenant. Same guarantee,
-- broader column set, enforced for every writer including BYPASSRLS roles.
create or replace function public.enforce_owning_org_tenant()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  cols text[] := case tg_table_name
                   when 'apps' then array['responsible_org_id','paying_org_id','procurement_owner_org_id']
                   when 'contracts' then array['procurement_org_id','paying_org_id']
                 end;
  col text;
  org_id uuid;
  org_tenant uuid;
begin
  foreach col in array cols loop
    org_id := (to_jsonb(new) ->> col)::uuid;
    if org_id is not null then
      select tenant_id into org_tenant from public.organizations where id = org_id;
      if org_tenant is null or org_tenant <> new.tenant_id then
        raise exception '%.% (%) is not an organization in tenant %',
          tg_table_name, col, org_id, new.tenant_id
          using errcode = 'check_violation';
      end if;
    end if;
  end loop;
  return new;
end;
$$;

-- Recreate the triggers so they fire on the broadened column set.
drop trigger if exists apps_owning_org_tenant on public.apps;
create trigger apps_owning_org_tenant
  before insert or update of responsible_org_id, paying_org_id, procurement_owner_org_id, tenant_id
  on public.apps
  for each row execute function public.enforce_owning_org_tenant();

drop trigger if exists contracts_owning_org_tenant on public.contracts;
create trigger contracts_owning_org_tenant
  before insert or update of procurement_org_id, paying_org_id, tenant_id
  on public.contracts
  for each row execute function public.enforce_owning_org_tenant();

commit;
