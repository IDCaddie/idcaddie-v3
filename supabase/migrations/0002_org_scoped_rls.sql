-- 0002_org_scoped_rls.sql
-- Org-scoped authorization for ID Caddie v3.
--
-- WHY A NEW MIGRATION (not editing 0001): 0001 is committed/pushed and is the
-- applied baseline. Rewriting an applied migration diverges every environment
-- that already ran it and breaks migration history. Additive forward migration
-- is the safe, reversible path.
--
-- WHAT THIS CLOSES (see docs/current-security-risk-map.md):
--   * Makes org_manager / org_viewer ENFORCEABLE in Postgres (data-model gap #1-2),
--     not merely documented. 0001 had organization_memberships with RLS enabled
--     but NO policies (unusable) and no org-aware resource policies.
--   * Exact per-org checks — no cross-org manager escalation (legacy P0:
--     firestore.rules:388-409 "manager in ANY group can edit").
--   * Audit-log append-only enforced at the DB layer for ALL roles (legacy P0:
--     editor-writable scraperLogs + Admin-SDK delete + 90-day hard purge).
--
-- RESOURCE -> ORG SCOPING uses ONE canonical owning-org column per resource:
--   apps.responsible_org_id      (procurement/paying org are informational only)
--   contracts.procurement_org_id (paying org is informational only)
-- Rationale: a single explicit column avoids the legacy "any-overlap" escalation.
-- If finer per-resource sharing is needed later, add a resource_grants join table
-- (deferred per docs/v3-data-model.md #8). Other resource tables (app_users,
-- license_*, files, invoices, app_contracts) remain TENANT-scoped for now — org
-- scoping for them is deliberately deferred (see summary "needs manual review").

begin;

-- ── Helper functions ─────────────────────────────────────────────────────────
-- SECURITY DEFINER so they read organization_memberships regardless of that
-- table's RLS (prevents recursive policy evaluation), matching 0001's pattern.

create or replace function public.is_org_member(target_org_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.organization_memberships om
    where om.organization_id = target_org_id
      and om.user_id = auth.uid()
  );
$$;

create or replace function public.has_org_role(target_org_id uuid, allowed_roles text[])
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.organization_memberships om
    where om.organization_id = target_org_id
      and om.user_id = auth.uid()
      and om.role = any(allowed_roles)
  );
$$;

-- Like has_org_role, but ALSO binds the org to a specific tenant. Used by every
-- resource policy so a resource whose owning-org points at a DIFFERENT tenant can
-- never be read/managed across the tenant boundary, even if such a pointer exists.
-- (Closes the cross-tenant leak: org policies must verify org.tenant_id = row.tenant_id.)
create or replace function public.has_org_role_in_tenant(target_org_id uuid, target_tenant_id uuid, allowed_roles text[])
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.organization_memberships om
    join public.organizations o on o.id = om.organization_id
    where om.organization_id = target_org_id
      and o.tenant_id = target_tenant_id          -- org must belong to the row's tenant
      and om.user_id = auth.uid()
      and om.role = any(allowed_roles)
  );
$$;

-- "Present in the tenant at all" via a tenant membership OR any org membership in
-- that tenant. Used only for BASELINE visibility (tenant/org rows), NOT for
-- resource reads — so an org-only user does not inherit tenant-wide resource read.
create or replace function public.is_tenant_participant(target_tenant_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.is_tenant_member(target_tenant_id)
      or exists (
        select 1
        from public.organization_memberships om
        join public.organizations o on o.id = om.organization_id
        where o.tenant_id = target_tenant_id
          and om.user_id = auth.uid()
      );
$$;

-- ── Baseline visibility for org-only users ───────────────────────────────────
-- (0001 keyed tenant/org reads on tenant_membership only, blinding org-only users.)

create policy "org participants read tenant" on public.tenants
for select using (public.is_tenant_participant(id));

create policy "org members read their org" on public.organizations
for select using (public.is_org_member(id));

-- ── organization_memberships: 0001 enabled RLS but defined NO policies ────────
-- Without these the table is unusable AND unadministrable. org_manager gets NO
-- insert/update policy here, so a manager cannot self-grant a role in another org
-- (escalation blocked at the membership layer, not just the resource layer).

create policy "users read own org memberships" on public.organization_memberships
for select using (user_id = auth.uid());

create policy "tenant admins read org memberships" on public.organization_memberships
for select using (
  exists (
    select 1 from public.organizations o
    where o.id = organization_id
      and public.has_tenant_role(o.tenant_id, array['owner','admin'])
  )
);

create policy "tenant admins manage org memberships" on public.organization_memberships
for all
using (
  exists (
    select 1 from public.organizations o
    where o.id = organization_id
      and public.has_tenant_role(o.tenant_id, array['owner','admin'])
  )
)
with check (
  exists (
    select 1 from public.organizations o
    where o.id = organization_id
      and public.has_tenant_role(o.tenant_id, array['owner','admin'])
  )
);

-- ── apps: org-scoped read + manage (additive to 0001 tenant policies) ─────────

-- READ: org members (manager OR viewer) see apps owned by their org IN THIS TENANT.
-- NULL responsible_org_id => false => no org access (such apps are visible only to
-- tenant-wide roles via 0001's "members read apps"). The tenant binding in
-- has_org_role_in_tenant prevents a foreign-tenant org pointer from leaking the row.
create policy "org members read org apps" on public.apps
for select using (public.has_org_role_in_tenant(responsible_org_id, tenant_id, array['manager','viewer']));

-- MANAGE: org managers create/update/delete apps owned by an org they manage IN THIS
-- TENANT. USING gates the EXISTING row's (org, tenant); WITH CHECK gates the RESULTING
-- row's (org, tenant). Together they block reassigning into an unmanaged or
-- foreign-tenant org and block cross-tenant inserts — i.e. no escalation.
create policy "org managers manage org apps" on public.apps
for all
using (public.has_org_role_in_tenant(responsible_org_id, tenant_id, array['manager']))
with check (public.has_org_role_in_tenant(responsible_org_id, tenant_id, array['manager']));

-- ── contracts: org-scoped read + manage (canonical column = procurement_org_id) ─

create policy "org members read org contracts" on public.contracts
for select using (public.has_org_role_in_tenant(procurement_org_id, tenant_id, array['manager','viewer']));

create policy "org managers manage org contracts" on public.contracts
for all
using (public.has_org_role_in_tenant(procurement_org_id, tenant_id, array['manager']))
with check (public.has_org_role_in_tenant(procurement_org_id, tenant_id, array['manager']));

-- ── Integrity: a resource's canonical owning-org must live in the resource's tenant ─
-- Policy guards above stop the *leak*; this trigger stops the corrupt pointer from
-- ever being written (by anyone, including BYPASSRLS service_role / SECURITY DEFINER
-- writers). 0001's tenant-editor WITH CHECK only validates has_tenant_role(tenant_id)
-- and would otherwise let an editor stamp a foreign-tenant org id onto a row.
create or replace function public.enforce_owning_org_tenant()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  owning_col text;
  owning_org uuid;
  org_tenant uuid;
begin
  -- Read the table's canonical owning-org column dynamically: a single function can't
  -- name-reference both new.responsible_org_id and new.procurement_org_id (PL/pgSQL
  -- resolves every field reference against the actual row type, even in a dead CASE arm).
  owning_col := case tg_table_name when 'apps' then 'responsible_org_id'
                                   when 'contracts' then 'procurement_org_id' end;
  owning_org := (to_jsonb(new) ->> owning_col)::uuid;
  if owning_org is null then
    return new;  -- no owning org => tenant-wide only, nothing to bind
  end if;
  select tenant_id into org_tenant from public.organizations where id = owning_org;
  if org_tenant is null or org_tenant <> new.tenant_id then
    raise exception 'owning organization % does not belong to tenant %', owning_org, new.tenant_id
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

drop trigger if exists apps_owning_org_tenant on public.apps;
create trigger apps_owning_org_tenant
  before insert or update of responsible_org_id, tenant_id on public.apps
  for each row execute function public.enforce_owning_org_tenant();

drop trigger if exists contracts_owning_org_tenant on public.contracts;
create trigger contracts_owning_org_tenant
  before insert or update of procurement_org_id, tenant_id on public.contracts
  for each row execute function public.enforce_owning_org_tenant();

-- ── Fix pre-existing 0001 tenant-membership escalation ───────────────────────
-- 0001's "admins manage tenant memberships" gates only on the ACTOR's role, never
-- on the role VALUE written, so an admin could self-promote to owner and demote the
-- real owner (tenant takeover). Split: owners manage everything; admins manage only
-- NON-owner rows and may not write role='owner'.
drop policy if exists "admins manage tenant memberships" on public.tenant_memberships;

create policy "owners manage tenant memberships" on public.tenant_memberships
for all
using (public.has_tenant_role(tenant_id, array['owner']))
with check (public.has_tenant_role(tenant_id, array['owner']));

create policy "admins manage non-owner memberships" on public.tenant_memberships
for all
using (
  public.has_tenant_role(tenant_id, array['owner','admin'])
  and tenant_memberships.role <> 'owner'
)
with check (
  public.has_tenant_role(tenant_id, array['owner','admin'])
  and tenant_memberships.role <> 'owner'
);

-- ── audit_logs: append-only, enforced for EVERY role ─────────────────────────
-- 0001 gives a SELECT policy and no write policies, so `authenticated` already
-- cannot UPDATE/DELETE (RLS filters all rows -> 0 affected). This trigger ALSO
-- blocks UPDATE/DELETE for privileged/bypassrls roles (e.g. service_role) and any
-- future SELECT-visible path. INSERT stays open to trusted server paths
-- (service role / SECURITY DEFINER writers). No UPDATE/DELETE policy is added.
--
-- Retention note: this intentionally blocks deletes too (legacy hard-purged at
-- 90 days). Any future retention must be a deliberate archival mechanism
-- (e.g. partition detach), not row DELETE.

create or replace function public.reject_audit_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception 'audit_logs is append-only: % is not permitted', tg_op
    using errcode = 'insufficient_privilege';
end;
$$;

drop trigger if exists audit_logs_no_mutation on public.audit_logs;
create trigger audit_logs_no_mutation
  before update or delete on public.audit_logs
  for each row execute function public.reject_audit_mutation();

commit;
