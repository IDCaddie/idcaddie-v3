-- 0061_canonical_directory_product_read_rpcs.sql
--
-- Phase 15 Part 1 (PR A) — the FIRST reviewed customer read path onto the canonical provider-neutral directory graph, via narrow
-- authenticated SECURITY DEFINER read RPCs (read-access design OPTION B — chosen over broad user-scoped RLS SELECT: ordinary tenant
-- membership is NOT sufficient evidence that every member may enumerate the whole access graph). The six canonical tables STAY DENY-ALL
-- to browser roles — this migration adds NO SELECT policy and does NOT grant SELECT to authenticated; every read goes through these RPCs.
-- Each RPC: derives the caller from auth.uid(); VERIFIES tenant access server-side via has_tenant_role(p_tenant_id, {owner,admin}) — a
-- passed p_tenant_id is verified, NEVER trusted, and a non-owner/admin (viewer/editor/non-member/anon) gets an EMPTY/null result identical
-- to a nonexistent tenant (no existence disclosure); pins search_path; is schema-qualified; uses NO dynamic SQL (filters are bound params);
-- returns ONLY bounded safe fields (canonical row-id UUIDs + safe display columns + sync_status/stale_since) and NEVER external_id /
-- raw_payload / normalized_* / credentials / settings / profiles / last_discovery_run_id / source_endpoint; paginates deterministically
-- (order by id, cursor p_after_id, page size capped 100); and makes a foreign-tenant or missing canonical id return the SAME not-found as
-- an empty result. EXECUTE is granted to authenticated ONLY; public + anon denied; connector_runner is not granted (its write path is
-- untouched). NO write, NO data migration, NO table grant, NO policy. Staging only; RISK-007 OPEN; Phase C BLOCKED; production untouched.

begin;

-- ══ 1. tenant-wide counts (overview header + the "too large to evaluate" path) ═══════════════════════════════════════════════════════
create or replace function public.product_directory_access_counts(
  p_tenant_id uuid, p_connection_id uuid default null, p_provider text default null
) returns jsonb language plpgsql security definer set search_path = public stable as $$
begin
  if not public.has_tenant_role(p_tenant_id, array['owner', 'admin']) then return null; end if; -- verify, never trust; non-owner/admin -> not-found
  return jsonb_build_object(
    'identities',       (select count(*) from public.identity_accounts x where x.tenant_id = p_tenant_id and (p_connection_id is null or x.connection_id = p_connection_id) and (p_provider is null or x.provider = p_provider)),
    'groups',           (select count(*) from public.directory_groups x where x.tenant_id = p_tenant_id and (p_connection_id is null or x.connection_id = p_connection_id) and (p_provider is null or x.provider = p_provider)),
    'applications',     (select count(*) from public.directory_applications x where x.tenant_id = p_tenant_id and (p_connection_id is null or x.connection_id = p_connection_id) and (p_provider is null or x.provider = p_provider)),
    'memberships',      (select count(*) from public.directory_group_memberships x where x.tenant_id = p_tenant_id and (p_connection_id is null or x.connection_id = p_connection_id) and (p_provider is null or x.provider = p_provider)),
    'userAssignments',  (select count(*) from public.directory_application_user_assignments x where x.tenant_id = p_tenant_id and (p_connection_id is null or x.connection_id = p_connection_id) and (p_provider is null or x.provider = p_provider)),
    'groupAssignments', (select count(*) from public.directory_application_group_assignments x where x.tenant_id = p_tenant_id and (p_connection_id is null or x.connection_id = p_connection_id) and (p_provider is null or x.provider = p_provider))
  );
end $$;

-- ══ 2-7. bounded, paginated LIST RPCs (assemble the tenant graph server-side under a total cap + power the list views) ════════════════
create or replace function public.product_list_directory_identities(
  p_tenant_id uuid, p_connection_id uuid default null, p_provider text default null,
  p_include_stale boolean default false, p_after_id uuid default null, p_limit integer default 100
) returns table (
  id uuid, connection_id uuid, provider text, sync_status text, stale_since timestamptz,
  display_name text, login text, email text, is_active boolean, status text
) language plpgsql security definer set search_path = public stable as $$
declare v_limit integer := least(greatest(coalesce(p_limit, 100), 1), 100);
begin
  if not public.has_tenant_role(p_tenant_id, array['owner', 'admin']) then return; end if;
  return query
    select x.id, x.connection_id, x.provider, x.sync_status, x.stale_since, x.display_name, x.login, x.email, x.is_active, x.status
      from public.identity_accounts x
     where x.tenant_id = p_tenant_id
       and (p_connection_id is null or x.connection_id = p_connection_id)
       and (p_provider is null or x.provider = p_provider)
       and (p_include_stale or x.sync_status = 'current')
       and (p_after_id is null or x.id > p_after_id)
     order by x.id
     limit v_limit;
end $$;

create or replace function public.product_list_directory_groups(
  p_tenant_id uuid, p_connection_id uuid default null, p_provider text default null,
  p_include_stale boolean default false, p_after_id uuid default null, p_limit integer default 100
) returns table (
  id uuid, connection_id uuid, provider text, sync_status text, stale_since timestamptz, name text, group_type_category text
) language plpgsql security definer set search_path = public stable as $$
declare v_limit integer := least(greatest(coalesce(p_limit, 100), 1), 100);
begin
  if not public.has_tenant_role(p_tenant_id, array['owner', 'admin']) then return; end if;
  return query
    select x.id, x.connection_id, x.provider, x.sync_status, x.stale_since, x.name, x.group_type_category
      from public.directory_groups x
     where x.tenant_id = p_tenant_id
       and (p_connection_id is null or x.connection_id = p_connection_id)
       and (p_provider is null or x.provider = p_provider)
       and (p_include_stale or x.sync_status = 'current')
       and (p_after_id is null or x.id > p_after_id)
     order by x.id
     limit v_limit;
end $$;

create or replace function public.product_list_directory_applications(
  p_tenant_id uuid, p_connection_id uuid default null, p_provider text default null,
  p_include_stale boolean default false, p_after_id uuid default null, p_limit integer default 100
) returns table (
  id uuid, connection_id uuid, provider text, sync_status text, stale_since timestamptz,
  label text, name text, status_category text, sign_on_category text, catalog_match_status text
) language plpgsql security definer set search_path = public stable as $$
declare v_limit integer := least(greatest(coalesce(p_limit, 100), 1), 100);
begin
  if not public.has_tenant_role(p_tenant_id, array['owner', 'admin']) then return; end if;
  return query
    select x.id, x.connection_id, x.provider, x.sync_status, x.stale_since, x.label, x.name, x.status_category, x.sign_on_category, x.catalog_match_status
      from public.directory_applications x
     where x.tenant_id = p_tenant_id
       and (p_connection_id is null or x.connection_id = p_connection_id)
       and (p_provider is null or x.provider = p_provider)
       and (p_include_stale or x.sync_status = 'current')
       and (p_after_id is null or x.id > p_after_id)
     order by x.id
     limit v_limit;
end $$;

-- edge lists: keyed on the edge's own id for a stable cursor; ROW-id references only.
create or replace function public.product_list_group_memberships(
  p_tenant_id uuid, p_connection_id uuid default null, p_provider text default null,
  p_include_stale boolean default false, p_after_id uuid default null, p_limit integer default 100
) returns table (
  id uuid, connection_id uuid, provider text, directory_group_id uuid, identity_account_id uuid, sync_status text, stale_since timestamptz
) language plpgsql security definer set search_path = public stable as $$
declare v_limit integer := least(greatest(coalesce(p_limit, 100), 1), 100);
begin
  if not public.has_tenant_role(p_tenant_id, array['owner', 'admin']) then return; end if;
  return query
    select x.id, x.connection_id, x.provider, x.directory_group_id, x.identity_account_id, x.sync_status, x.stale_since
      from public.directory_group_memberships x
     where x.tenant_id = p_tenant_id
       and (p_connection_id is null or x.connection_id = p_connection_id)
       and (p_provider is null or x.provider = p_provider)
       and (p_include_stale or x.sync_status = 'current')
       and (p_after_id is null or x.id > p_after_id)
     order by x.id
     limit v_limit;
end $$;

create or replace function public.product_list_user_assignments(
  p_tenant_id uuid, p_connection_id uuid default null, p_provider text default null,
  p_include_stale boolean default false, p_after_id uuid default null, p_limit integer default 100
) returns table (
  id uuid, connection_id uuid, provider text, directory_application_id uuid, identity_account_id uuid, sync_status text, stale_since timestamptz
) language plpgsql security definer set search_path = public stable as $$
declare v_limit integer := least(greatest(coalesce(p_limit, 100), 1), 100);
begin
  if not public.has_tenant_role(p_tenant_id, array['owner', 'admin']) then return; end if;
  return query
    select x.id, x.connection_id, x.provider, x.directory_application_id, x.identity_account_id, x.sync_status, x.stale_since
      from public.directory_application_user_assignments x
     where x.tenant_id = p_tenant_id
       and (p_connection_id is null or x.connection_id = p_connection_id)
       and (p_provider is null or x.provider = p_provider)
       and (p_include_stale or x.sync_status = 'current')
       and (p_after_id is null or x.id > p_after_id)
     order by x.id
     limit v_limit;
end $$;

create or replace function public.product_list_group_assignments(
  p_tenant_id uuid, p_connection_id uuid default null, p_provider text default null,
  p_include_stale boolean default false, p_after_id uuid default null, p_limit integer default 100
) returns table (
  id uuid, connection_id uuid, provider text, directory_application_id uuid, directory_group_id uuid, sync_status text, stale_since timestamptz
) language plpgsql security definer set search_path = public stable as $$
declare v_limit integer := least(greatest(coalesce(p_limit, 100), 1), 100);
begin
  if not public.has_tenant_role(p_tenant_id, array['owner', 'admin']) then return; end if;
  return query
    select x.id, x.connection_id, x.provider, x.directory_application_id, x.directory_group_id, x.sync_status, x.stale_since
      from public.directory_application_group_assignments x
     where x.tenant_id = p_tenant_id
       and (p_connection_id is null or x.connection_id = p_connection_id)
       and (p_provider is null or x.provider = p_provider)
       and (p_include_stale or x.sync_status = 'current')
       and (p_after_id is null or x.id > p_after_id)
     order by x.id
     limit v_limit;
end $$;

-- ══ 8. entity-focused IDENTITY subgraph (bounded by one identity's neighborhood) — for the identity detail view ══════════════════════
create or replace function public.product_identity_access_subgraph(
  p_tenant_id uuid, p_identity_id uuid, p_include_stale boolean default false
) returns jsonb language plpgsql security definer set search_path = public stable as $$
declare v_identity jsonb; v_group_ids uuid[]; v_app_ids uuid[];
begin
  if not public.has_tenant_role(p_tenant_id, array['owner', 'admin']) then return null; end if;
  select to_jsonb(t) into v_identity from (
    select id, connection_id, provider, sync_status, stale_since, display_name, login, email, is_active, status
      from public.identity_accounts where id = p_identity_id and tenant_id = p_tenant_id
  ) t;
  if v_identity is null then return null; end if; -- foreign or missing -> uniform not-found

  select coalesce(array_agg(distinct m.directory_group_id), '{}') into v_group_ids
    from public.directory_group_memberships m
   where m.tenant_id = p_tenant_id and m.identity_account_id = p_identity_id and (p_include_stale or m.sync_status = 'current');
  select coalesce(array_agg(distinct app_id), '{}') into v_app_ids from (
    select ua.directory_application_id as app_id from public.directory_application_user_assignments ua
      where ua.tenant_id = p_tenant_id and ua.identity_account_id = p_identity_id and (p_include_stale or ua.sync_status = 'current')
    union
    select ga.directory_application_id from public.directory_application_group_assignments ga
      where ga.tenant_id = p_tenant_id and ga.directory_group_id = any(v_group_ids) and (p_include_stale or ga.sync_status = 'current')
  ) s;

  return jsonb_build_object(
    'identity', v_identity,
    'memberships', (select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb) from (
      select connection_id, provider, directory_group_id, identity_account_id, sync_status, stale_since from public.directory_group_memberships
       where tenant_id = p_tenant_id and identity_account_id = p_identity_id and (p_include_stale or sync_status = 'current')) t),
    'groups', (select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb) from (
      select id, connection_id, provider, sync_status, stale_since, name, group_type_category from public.directory_groups
       where tenant_id = p_tenant_id and id = any(v_group_ids)) t),
    'userAssignments', (select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb) from (
      select connection_id, provider, directory_application_id, identity_account_id, sync_status, stale_since from public.directory_application_user_assignments
       where tenant_id = p_tenant_id and identity_account_id = p_identity_id and (p_include_stale or sync_status = 'current')) t),
    'groupAssignments', (select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb) from (
      select connection_id, provider, directory_application_id, directory_group_id, sync_status, stale_since from public.directory_application_group_assignments
       where tenant_id = p_tenant_id and directory_group_id = any(v_group_ids) and (p_include_stale or sync_status = 'current')) t),
    'applications', (select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb) from (
      select id, connection_id, provider, sync_status, stale_since, label, name, status_category, sign_on_category, catalog_match_status from public.directory_applications
       where tenant_id = p_tenant_id and id = any(v_app_ids)) t)
  );
end $$;

-- ══ 9. entity-focused APPLICATION subgraph (bounded by one app's neighborhood) — for the application detail view ═════════════════════
create or replace function public.product_application_access_subgraph(
  p_tenant_id uuid, p_application_id uuid, p_include_stale boolean default false
) returns jsonb language plpgsql security definer set search_path = public stable as $$
declare v_app jsonb; v_group_ids uuid[]; v_identity_ids uuid[];
begin
  if not public.has_tenant_role(p_tenant_id, array['owner', 'admin']) then return null; end if;
  select to_jsonb(t) into v_app from (
    select id, connection_id, provider, sync_status, stale_since, label, name, status_category, sign_on_category, catalog_match_status
      from public.directory_applications where id = p_application_id and tenant_id = p_tenant_id
  ) t;
  if v_app is null then return null; end if;

  select coalesce(array_agg(distinct ga.directory_group_id), '{}') into v_group_ids
    from public.directory_application_group_assignments ga
   where ga.tenant_id = p_tenant_id and ga.directory_application_id = p_application_id and (p_include_stale or ga.sync_status = 'current');
  select coalesce(array_agg(distinct ident_id), '{}') into v_identity_ids from (
    select ua.identity_account_id as ident_id from public.directory_application_user_assignments ua
      where ua.tenant_id = p_tenant_id and ua.directory_application_id = p_application_id and (p_include_stale or ua.sync_status = 'current')
    union
    select m.identity_account_id from public.directory_group_memberships m
      where m.tenant_id = p_tenant_id and m.directory_group_id = any(v_group_ids) and (p_include_stale or m.sync_status = 'current')
  ) s;

  return jsonb_build_object(
    'application', v_app,
    'userAssignments', (select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb) from (
      select connection_id, provider, directory_application_id, identity_account_id, sync_status, stale_since from public.directory_application_user_assignments
       where tenant_id = p_tenant_id and directory_application_id = p_application_id and (p_include_stale or sync_status = 'current')) t),
    'groupAssignments', (select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb) from (
      select connection_id, provider, directory_application_id, directory_group_id, sync_status, stale_since from public.directory_application_group_assignments
       where tenant_id = p_tenant_id and directory_application_id = p_application_id and (p_include_stale or sync_status = 'current')) t),
    'groups', (select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb) from (
      select id, connection_id, provider, sync_status, stale_since, name, group_type_category from public.directory_groups
       where tenant_id = p_tenant_id and id = any(v_group_ids)) t),
    'memberships', (select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb) from (
      select connection_id, provider, directory_group_id, identity_account_id, sync_status, stale_since from public.directory_group_memberships
       where tenant_id = p_tenant_id and directory_group_id = any(v_group_ids) and (p_include_stale or sync_status = 'current')) t),
    'identities', (select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb) from (
      select id, connection_id, provider, sync_status, stale_since, display_name, login, email, is_active, status from public.identity_accounts
       where tenant_id = p_tenant_id and id = any(v_identity_ids)) t)
  );
end $$;

-- ══ least privilege: EXECUTE to authenticated ONLY; public + anon denied. connector_runner NOT granted (write path untouched). ════════
do $$
declare f text;
begin
  foreach f in array array[
    'public.product_directory_access_counts(uuid, uuid, text)',
    'public.product_list_directory_identities(uuid, uuid, text, boolean, uuid, integer)',
    'public.product_list_directory_groups(uuid, uuid, text, boolean, uuid, integer)',
    'public.product_list_directory_applications(uuid, uuid, text, boolean, uuid, integer)',
    'public.product_list_group_memberships(uuid, uuid, text, boolean, uuid, integer)',
    'public.product_list_user_assignments(uuid, uuid, text, boolean, uuid, integer)',
    'public.product_list_group_assignments(uuid, uuid, text, boolean, uuid, integer)',
    'public.product_identity_access_subgraph(uuid, uuid, boolean)',
    'public.product_application_access_subgraph(uuid, uuid, boolean)'
  ] loop
    execute format('revoke execute on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end $$;

commit;
