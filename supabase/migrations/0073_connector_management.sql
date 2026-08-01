-- 0073_connector_management.sql
--
-- Phase 5 — the foundation for managing MANY directories instead of one.
--
-- Three things, all additive:
--
--   1. DISCONNECT. A connector can be retired without a replacement. 0071 gave us supersession — "this connector was replaced by
--      that one" — which is the RIGHT answer for replacing a connector but the wrong one for switching a directory off: there is
--      no successor to point at. Rather than invent a second exclusion mechanism, both now feed ONE notion of "active".
--
--        superseded_by    -> replaced by another connector reading the same organization  (0071)
--        disconnected_at  -> retired with no successor                                    (here)
--        active           -> neither
--
--      Disconnect is a READ-TIME exclusion exactly like supersession. No row is deleted, no directory record is touched, no run or
--      audit event is removed, and clearing the column restores everything. That is the whole point: an auditor asking "who could
--      reach this application in June" must still get an answer after the connector is gone.
--
--   2. THE ACTIVE PREDICATE, widened. All ten product read RPCs now exclude a connector that is superseded OR disconnected. Every
--      body below un-widens to byte-identical 0071/0072 — the predicate is the only change.
--
--   3. TWO MANAGEMENT READS. `product_connector_inventory` returns one row per connector with its lifecycle, evidence timestamps
--      and directory counts, so the management page is ONE round trip rather than one per connector. `product_connector_runs`
--      returns a connector's discovery history.
--
-- WHAT THIS DOES NOT DO. It does not merge organizations: counts stay per connector, which is what makes multiple active Okta
-- organizations work at all. It adds no discovery, no scheduling, no write to any directory table, and no new provider.
--
-- Staging only.

-- ══ 1. DISCONNECT ════════════════════════════════════════════════════════════════════════════════════════════════════════
alter table public.connectors
  add column if not exists disconnected_at timestamptz,
  add column if not exists disconnected_reason text;

-- Both together or neither: a timestamp with no reason is an undocumented decision, and a reason with no timestamp excludes
-- nothing. Mirrors the supersession triple from 0071.
alter table public.connectors
  add constraint connectors_disconnect_complete_chk
  check ((disconnected_at is null and disconnected_reason is null)
      or (disconnected_at is not null and disconnected_reason is not null)) not valid;
alter table public.connectors validate constraint connectors_disconnect_complete_chk;

comment on column public.connectors.disconnected_at is
  'When this connector was retired with no successor. While set, it is excluded from every product read surface; its rows, runs and audit history are retained unchanged and are restored by clearing the column. Use superseded_by instead when another connector took over the same organization.';

create index if not exists connectors_inactive_idx on public.connectors (id)
  where superseded_by is not null or disconnected_at is not null;

-- ══ 2. PRODUCT READS EXCLUDE INACTIVE CONNECTORS ═════════════════════════════════════════════════════════════════════════
-- The 0071 predicate widened from `superseded_by is not null` to `(superseded_by is not null or disconnected_at is not null)`.
-- Enforcing it here rather than per-caller is what keeps Home, Directory, Access, Findings and every detail page on one scope.

-- ── product_directory_access_counts
create or replace function public.product_directory_access_counts(
  p_tenant_id uuid, p_connection_id uuid default null, p_provider text default null
) returns jsonb language plpgsql security definer set search_path = public stable as $$
begin
  if not public.has_tenant_role(p_tenant_id, array['owner', 'admin']) then return null; end if; -- verify, never trust; non-owner/admin -> not-found
  return jsonb_build_object(
    'identities',       (select count(*) from public.identity_accounts x where x.tenant_id = p_tenant_id and (p_connection_id is null or x.connection_id = p_connection_id) and (p_provider is null or x.provider = p_provider) and not exists (select 1 from public.connectors sc where sc.id = x.connection_id and (sc.superseded_by is not null or sc.disconnected_at is not null))),
    'groups',           (select count(*) from public.directory_groups x where x.tenant_id = p_tenant_id and (p_connection_id is null or x.connection_id = p_connection_id) and (p_provider is null or x.provider = p_provider) and not exists (select 1 from public.connectors sc where sc.id = x.connection_id and (sc.superseded_by is not null or sc.disconnected_at is not null))),
    'applications',     (select count(*) from public.directory_applications x where x.tenant_id = p_tenant_id and (p_connection_id is null or x.connection_id = p_connection_id) and (p_provider is null or x.provider = p_provider) and not exists (select 1 from public.connectors sc where sc.id = x.connection_id and (sc.superseded_by is not null or sc.disconnected_at is not null))),
    'memberships',      (select count(*) from public.directory_group_memberships x where x.tenant_id = p_tenant_id and (p_connection_id is null or x.connection_id = p_connection_id) and (p_provider is null or x.provider = p_provider) and not exists (select 1 from public.connectors sc where sc.id = x.connection_id and (sc.superseded_by is not null or sc.disconnected_at is not null))),
    'userAssignments',  (select count(*) from public.directory_application_user_assignments x where x.tenant_id = p_tenant_id and (p_connection_id is null or x.connection_id = p_connection_id) and (p_provider is null or x.provider = p_provider) and not exists (select 1 from public.connectors sc where sc.id = x.connection_id and (sc.superseded_by is not null or sc.disconnected_at is not null))),
    'groupAssignments', (select count(*) from public.directory_application_group_assignments x where x.tenant_id = p_tenant_id and (p_connection_id is null or x.connection_id = p_connection_id) and (p_provider is null or x.provider = p_provider) and not exists (select 1 from public.connectors sc where sc.id = x.connection_id and (sc.superseded_by is not null or sc.disconnected_at is not null)))
  );
end $$;

-- ── product_list_directory_identities
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
       and not exists (select 1 from public.connectors sc where sc.id = x.connection_id and (sc.superseded_by is not null or sc.disconnected_at is not null))
       and (p_connection_id is null or x.connection_id = p_connection_id)
       and (p_provider is null or x.provider = p_provider)
       and (p_include_stale or x.sync_status = 'current')
       and (p_after_id is null or x.id > p_after_id)
     order by x.id
     limit v_limit;
end $$;

-- ── product_list_directory_groups
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
       and not exists (select 1 from public.connectors sc where sc.id = x.connection_id and (sc.superseded_by is not null or sc.disconnected_at is not null))
       and (p_connection_id is null or x.connection_id = p_connection_id)
       and (p_provider is null or x.provider = p_provider)
       and (p_include_stale or x.sync_status = 'current')
       and (p_after_id is null or x.id > p_after_id)
     order by x.id
     limit v_limit;
end $$;

-- ── product_list_directory_applications
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
       and not exists (select 1 from public.connectors sc where sc.id = x.connection_id and (sc.superseded_by is not null or sc.disconnected_at is not null))
       and (p_connection_id is null or x.connection_id = p_connection_id)
       and (p_provider is null or x.provider = p_provider)
       and (p_include_stale or x.sync_status = 'current')
       and (p_after_id is null or x.id > p_after_id)
     order by x.id
     limit v_limit;
end $$;

-- ── product_list_group_memberships
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
       and not exists (select 1 from public.connectors sc where sc.id = x.connection_id and (sc.superseded_by is not null or sc.disconnected_at is not null))
       and (p_connection_id is null or x.connection_id = p_connection_id)
       and (p_provider is null or x.provider = p_provider)
       and (p_include_stale or x.sync_status = 'current')
       and (p_after_id is null or x.id > p_after_id)
     order by x.id
     limit v_limit;
end $$;

-- ── product_list_user_assignments
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
       and not exists (select 1 from public.connectors sc where sc.id = x.connection_id and (sc.superseded_by is not null or sc.disconnected_at is not null))
       and (p_connection_id is null or x.connection_id = p_connection_id)
       and (p_provider is null or x.provider = p_provider)
       and (p_include_stale or x.sync_status = 'current')
       and (p_after_id is null or x.id > p_after_id)
     order by x.id
     limit v_limit;
end $$;

-- ── product_list_group_assignments
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
       and not exists (select 1 from public.connectors sc where sc.id = x.connection_id and (sc.superseded_by is not null or sc.disconnected_at is not null))
       and (p_connection_id is null or x.connection_id = p_connection_id)
       and (p_provider is null or x.provider = p_provider)
       and (p_include_stale or x.sync_status = 'current')
       and (p_after_id is null or x.id > p_after_id)
     order by x.id
     limit v_limit;
end $$;

-- ── product_identity_access_subgraph
create or replace function public.product_identity_access_subgraph(
  p_tenant_id uuid, p_identity_id uuid, p_include_stale boolean default false
) returns jsonb language plpgsql security definer set search_path = public stable as $$
declare v_identity jsonb; v_group_ids uuid[]; v_app_ids uuid[];
begin
  if not public.has_tenant_role(p_tenant_id, array['owner', 'admin']) then return null; end if;
  select to_jsonb(t) into v_identity from (
    select id, connection_id, provider, sync_status, stale_since, display_name, login, email, is_active, status
      from public.identity_accounts a where a.id = p_identity_id and a.tenant_id = p_tenant_id
        and not exists (select 1 from public.connectors sc where sc.id = a.connection_id and (sc.superseded_by is not null or sc.disconnected_at is not null))
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

-- ── product_application_access_subgraph
create or replace function public.product_application_access_subgraph(
  p_tenant_id uuid, p_application_id uuid, p_include_stale boolean default false
) returns jsonb language plpgsql security definer set search_path = public stable as $$
declare v_app jsonb; v_group_ids uuid[]; v_identity_ids uuid[];
begin
  if not public.has_tenant_role(p_tenant_id, array['owner', 'admin']) then return null; end if;
  select to_jsonb(t) into v_app from (
    select id, connection_id, provider, sync_status, stale_since, label, name, status_category, sign_on_category, catalog_match_status
      from public.directory_applications a where a.id = p_application_id and a.tenant_id = p_tenant_id
        and not exists (select 1 from public.connectors sc where sc.id = a.connection_id and (sc.superseded_by is not null or sc.disconnected_at is not null))
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

-- ── product_group_access_subgraph
create or replace function public.product_group_access_subgraph(
  p_tenant_id uuid, p_group_id uuid, p_include_stale boolean default false
) returns jsonb language plpgsql security definer set search_path = public stable as $$
declare
  -- Mirrors the loader's SUBGRAPH_MAX_ROWS. Held here as well so the refusal happens before the jsonb is built.
  v_max constant integer := 5000;
  v_group jsonb; v_conn uuid; v_total integer;
  v_identity_ids uuid[]; v_app_ids uuid[];
begin
  if not public.has_tenant_role(p_tenant_id, array['owner', 'admin']) then return null; end if;

  -- ANCHOR. Tenant-scoped and supersession-gated. Missing / foreign-tenant / superseded all return the same null.
  select g.connection_id, to_jsonb(t) into v_conn, v_group
    from public.directory_groups g
    join lateral (
      select g.id, g.connection_id, g.provider, g.sync_status, g.stale_since, g.last_seen_at,
             g.name, g.description, g.group_type_category, g.provider_created_at, g.provider_last_updated_at
    ) t on true
   where g.id = p_group_id and g.tenant_id = p_tenant_id
     and not exists (select 1 from public.connectors sc where sc.id = g.connection_id and (sc.superseded_by is not null or sc.disconnected_at is not null));
  if v_group is null then return null; end if;

  -- Members and granted applications, both scoped to the anchor's own connector.
  select coalesce(array_agg(distinct m.identity_account_id), '{}') into v_identity_ids
    from public.directory_group_memberships m
   where m.tenant_id = p_tenant_id and m.connection_id = v_conn and m.directory_group_id = p_group_id
     and (p_include_stale or m.sync_status = 'current');
  select coalesce(array_agg(distinct ga.directory_application_id), '{}') into v_app_ids
    from public.directory_application_group_assignments ga
   where ga.tenant_id = p_tenant_id and ga.connection_id = v_conn and ga.directory_group_id = p_group_id
     and (p_include_stale or ga.sync_status = 'current');

  -- BOUND before building anything. Counted across every array the response would carry.
  select 1
       + coalesce(array_length(v_identity_ids, 1), 0)
       + coalesce(array_length(v_app_ids, 1), 0)
       + (select count(*) from public.directory_group_memberships m
           where m.tenant_id = p_tenant_id and m.connection_id = v_conn and m.directory_group_id = p_group_id
             and (p_include_stale or m.sync_status = 'current'))
       + (select count(*) from public.directory_application_group_assignments ga
           where ga.tenant_id = p_tenant_id and ga.connection_id = v_conn and ga.directory_group_id = p_group_id
             and (p_include_stale or ga.sync_status = 'current'))
       + (select count(*) from public.directory_application_user_assignments ua
           where ua.tenant_id = p_tenant_id and ua.connection_id = v_conn
             and ua.identity_account_id = any(v_identity_ids) and ua.directory_application_id = any(v_app_ids)
             and (p_include_stale or ua.sync_status = 'current'))
    into v_total;

  if v_total > v_max then
    -- The summary is still true and still useful; the neighbourhood is refused rather than truncated.
    return jsonb_build_object('group', v_group, 'bounded', true,
      'memberships', '[]'::jsonb, 'identities', '[]'::jsonb, 'groupAssignments', '[]'::jsonb,
      'applications', '[]'::jsonb, 'userAssignments', '[]'::jsonb);
  end if;

  return jsonb_build_object(
    'group', v_group,
    'bounded', false,
    'memberships', (select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb) from (
      select connection_id, provider, directory_group_id, identity_account_id, sync_status, stale_since
        from public.directory_group_memberships
       where tenant_id = p_tenant_id and connection_id = v_conn and directory_group_id = p_group_id
         and (p_include_stale or sync_status = 'current') order by identity_account_id) t),
    'identities', (select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb) from (
      select id, connection_id, provider, sync_status, stale_since, display_name, login, email, is_active, status
        from public.identity_accounts
       where tenant_id = p_tenant_id and connection_id = v_conn and id = any(v_identity_ids) order by id) t),
    'groupAssignments', (select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb) from (
      select connection_id, provider, directory_application_id, directory_group_id, sync_status, stale_since
        from public.directory_application_group_assignments
       where tenant_id = p_tenant_id and connection_id = v_conn and directory_group_id = p_group_id
         and (p_include_stale or sync_status = 'current') order by directory_application_id) t),
    'applications', (select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb) from (
      select id, connection_id, provider, sync_status, stale_since, label, name, status_category, sign_on_category, catalog_match_status
        from public.directory_applications
       where tenant_id = p_tenant_id and connection_id = v_conn and id = any(v_app_ids) order by id) t),
    -- Only the members' direct holdings of the applications THIS group grants. Anything wider would be a different question and
    -- would make the response grow with the tenant rather than with the group.
    'userAssignments', (select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb) from (
      select connection_id, provider, directory_application_id, identity_account_id, sync_status, stale_since
        from public.directory_application_user_assignments
       where tenant_id = p_tenant_id and connection_id = v_conn
         and identity_account_id = any(v_identity_ids) and directory_application_id = any(v_app_ids)
         and (p_include_stale or sync_status = 'current') order by directory_application_id, identity_account_id) t)
  );
end $$;

-- ══ 3. MANAGEMENT READS ══════════════════════════════════════════════════════════════════════════════════════════════════
-- One row per connector for the management page. Counts are computed per CONNECTOR, never summed across them — two Okta
-- organizations in one workspace are two directories, and adding their people together would be a fiction.
--
-- Inactive connectors are INCLUDED here and labelled, unlike every other product read. This is the one surface whose job is to
-- show what exists, including what was disconnected or replaced; hiding them would make disconnect look like deletion.
create or replace function public.product_connector_inventory(p_tenant_id uuid)
  returns table (
    id uuid, provider text, display_name text, organization text,
    connection_state text, status text, lifecycle text,
    superseded_by uuid, disconnected_at timestamptz, disconnected_reason text,
    last_verified_at timestamptz, last_discovery_at timestamptz, last_run_status text, last_run_failure_code text,
    created_at timestamptz,
    identities integer, groups integer, applications integer, memberships integer, user_assignments integer, group_assignments integer
  ) language plpgsql security definer set search_path = public stable as $$
begin
  if not public.has_tenant_role(p_tenant_id, array['owner', 'admin']) then return; end if;
  return query
    select c.id, c.provider, c.display_name,
           -- The organization this connector reads. Okta records it on its config row; other providers have none yet, and a
           -- fabricated label would be worse than an absent one.
           k.normalized_org_host as organization,
           c.connection_state, c.status,
           -- One lifecycle word for the management list. Retirement outranks everything: a disconnected connector's last
           -- connection_state is history, not its current condition.
           case
             when c.disconnected_at is not null then 'disconnected'
             when c.superseded_by is not null    then 'superseded'
             when k.validation_status = 'failed' or c.connection_state in ('error', 'partial_failure') then 'failed'
             when c.connection_state = 'discovered' then 'discovered'
             when c.connection_state in ('discovering', 'discovery_pending') then 'discovering'
             when k.validation_status = 'succeeded' or c.connection_state = 'verified' then 'verified'
             when c.connection_state is not null then 'configured'
             else 'configured'
           end as lifecycle,
           c.superseded_by, c.disconnected_at, c.disconnected_reason,
           k.last_validated_at as last_verified_at,
           r.started_at as last_discovery_at, r.status as last_run_status, r.failure_code as last_run_failure_code,
           c.created_at,
           (select count(*)::integer from public.identity_accounts x where x.tenant_id = p_tenant_id and x.connection_id = c.id and x.sync_status = 'current'),
           (select count(*)::integer from public.directory_groups x where x.tenant_id = p_tenant_id and x.connection_id = c.id and x.sync_status = 'current'),
           (select count(*)::integer from public.directory_applications x where x.tenant_id = p_tenant_id and x.connection_id = c.id and x.sync_status = 'current'),
           (select count(*)::integer from public.directory_group_memberships x where x.tenant_id = p_tenant_id and x.connection_id = c.id and x.sync_status = 'current'),
           (select count(*)::integer from public.directory_application_user_assignments x where x.tenant_id = p_tenant_id and x.connection_id = c.id and x.sync_status = 'current'),
           (select count(*)::integer from public.directory_application_group_assignments x where x.tenant_id = p_tenant_id and x.connection_id = c.id and x.sync_status = 'current')
      from public.connectors c
      left join public.okta_connector_configs k on k.connector_id = c.id and k.disabled_at is null
      -- Most recent run, resolved once per connector rather than by a correlated subquery per column.
      left join lateral (
        select cr.started_at, cr.status, cr.failure_code from public.connector_runs cr
         where cr.connector_id = c.id and cr.tenant_id = p_tenant_id
         order by cr.started_at desc limit 1
      ) r on true
     where c.tenant_id = p_tenant_id
     order by (c.disconnected_at is not null or c.superseded_by is not null), c.created_at, c.id;
end $$;

-- A connector's discovery history. Bounded and keyset-paginated on started_at desc; no fact payload, no provider error text.
create or replace function public.product_connector_runs(
  p_tenant_id uuid, p_connector_id uuid, p_before timestamptz default null, p_limit integer default 50
) returns table (
  id uuid, started_at timestamptz, completed_at timestamptz, status text,
  failure_code text, records_seen integer, records_imported integer, records_failed integer,
  completeness boolean, termination_reason text, review_required boolean
) language plpgsql security definer set search_path = public stable as $$
declare v_limit integer := least(greatest(coalesce(p_limit, 50), 1), 100);
begin
  if not public.has_tenant_role(p_tenant_id, array['owner', 'admin']) then return; end if;
  -- The connector must belong to the tenant. A foreign id returns nothing rather than an error, matching every other product read.
  if not exists (select 1 from public.connectors c where c.id = p_connector_id and c.tenant_id = p_tenant_id) then return; end if;
  return query
    select cr.id, cr.started_at, cr.completed_at, cr.status,
           cr.failure_code, cr.records_seen, cr.records_imported, cr.records_failed,
           d.completeness, d.termination_reason, d.review_required
      from public.connector_runs cr
      left join public.connector_run_discovery d on d.run_id = cr.id and d.tenant_id = p_tenant_id
     where cr.tenant_id = p_tenant_id and cr.connector_id = p_connector_id
       and (p_before is null or cr.started_at < p_before)
     order by cr.started_at desc, cr.id desc
     limit v_limit;
end $$;

-- ══ 4. LEAST PRIVILEGE ═══════════════════════════════════════════════════════════════════════════════════════════════════
-- CREATE OR REPLACE preserves the ACL, but hosted Supabase's ALTER DEFAULT PRIVILEGES grants EXECUTE on new public functions
-- straight to anon/authenticated (0045), and `revoke from public` alone does not remove that. Every role is named.
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
    'public.product_application_access_subgraph(uuid, uuid, boolean)',
    'public.product_group_access_subgraph(uuid, uuid, boolean)',
    'public.product_connector_inventory(uuid)',
    'public.product_connector_runs(uuid, uuid, timestamptz, integer)'
  ] loop
    execute format('revoke execute on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end $$;

-- ══ 5. THE WRITE PATH ════════════════════════════════════════════════════════════════════════════════════════════════════
-- Disconnect, reconnect and replace are the three operator actions this phase adds. All three are owner/admin-only, tenant-scoped,
-- audited, and touch NOTHING but the connector row's three retirement columns.
--
-- Deliberately NOT expressed as `connection_state` transitions. That column is the DISCOVERY lifecycle and 0067 governs its
-- transition table tightly; pushing retirement through it would mean a connector's discovery history reads as if a sweep had
-- happened. Retirement is orthogonal — a verified connector and a discovered one are both retirable, and both keep the state they
-- had so reconnecting resumes exactly where it left off.

create or replace function public.product_disconnect_connector(p_tenant_id uuid, p_connector_id uuid, p_reason text)
  returns jsonb language plpgsql security definer set search_path = public as $$
declare v_before jsonb; v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
begin
  if not public.has_tenant_role(p_tenant_id, array['owner', 'admin']) then
    raise exception 'not authorized';
  end if;
  -- A reason is mandatory. This is a decision someone will have to explain months later.
  if v_reason is null then raise exception 'a disconnect reason is required'; end if;
  if length(v_reason) > 500 then raise exception 'disconnect reason is too long'; end if;

  select to_jsonb(t) into v_before from (
    select id, provider, connection_state, superseded_by, disconnected_at from public.connectors
     where id = p_connector_id and tenant_id = p_tenant_id for update
  ) t;
  if v_before is null then return jsonb_build_object('ok', false, 'reason', 'not_found'); end if;
  if (v_before ->> 'disconnected_at') is not null then return jsonb_build_object('ok', true, 'reason', 'already_disconnected'); end if;
  -- A superseded connector is already excluded; disconnecting it too would record a second, redundant retirement.
  if (v_before ->> 'superseded_by') is not null then return jsonb_build_object('ok', false, 'reason', 'superseded'); end if;

  update public.connectors
     set disconnected_at = now(), disconnected_reason = v_reason, updated_at = now()
   where id = p_connector_id and tenant_id = p_tenant_id;

  insert into public.audit_logs (tenant_id, actor_user_id, action, resource_type, resource_id, before_json, after_json)
  values (p_tenant_id, auth.uid(), 'connector.disconnected', 'connector', p_connector_id,
          v_before, jsonb_build_object('disconnected', true, 'reason', v_reason));
  return jsonb_build_object('ok', true, 'reason', 'disconnected');
end $$;

-- Reconnect restores the connector to active views. Its rows, runs and history were never removed, so nothing is rebuilt — the
-- exclusion simply stops applying. This is what makes disconnect safe to use.
create or replace function public.product_reconnect_connector(p_tenant_id uuid, p_connector_id uuid)
  returns jsonb language plpgsql security definer set search_path = public as $$
declare v_before jsonb;
begin
  if not public.has_tenant_role(p_tenant_id, array['owner', 'admin']) then raise exception 'not authorized'; end if;
  select to_jsonb(t) into v_before from (
    select id, provider, connection_state, superseded_by, disconnected_at, disconnected_reason from public.connectors
     where id = p_connector_id and tenant_id = p_tenant_id for update
  ) t;
  if v_before is null then return jsonb_build_object('ok', false, 'reason', 'not_found'); end if;
  -- Supersession is checked FIRST. A superseded connector is excluded whether or not it was also disconnected, so reporting it as
  -- "already active" would be false — and reconnecting it would put two connectors for the same organization back into active
  -- views, the exact double-count the P0 fix closed. The supersession must be undone deliberately and separately.
  if (v_before ->> 'superseded_by') is not null then return jsonb_build_object('ok', false, 'reason', 'superseded'); end if;
  if (v_before ->> 'disconnected_at') is null then return jsonb_build_object('ok', true, 'reason', 'already_active'); end if;

  update public.connectors set disconnected_at = null, disconnected_reason = null, updated_at = now()
   where id = p_connector_id and tenant_id = p_tenant_id;
  insert into public.audit_logs (tenant_id, actor_user_id, action, resource_type, resource_id, before_json, after_json)
  values (p_tenant_id, auth.uid(), 'connector.reconnected', 'connector', p_connector_id, v_before, jsonb_build_object('disconnected', false));
  return jsonb_build_object('ok', true, 'reason', 'reconnected');
end $$;

-- Replace: record that a successor connector has taken over the same organization. This is 0071's supersession, exposed as an
-- operator action rather than a migration statement.
--
-- The preconditions are the same ones 0071's data statement enforced, re-proved here because a connector replaced by hand is
-- exactly as capable of being the wrong one: same tenant, same provider, both real, not each other, and the successor must not
-- itself be retired. What is NOT re-proved is external-id overlap — at replace time the successor has usually discovered nothing
-- yet, so requiring it would make the action unusable precisely when it is needed. The operator's reason carries that judgement,
-- which is why it is mandatory and audited.
create or replace function public.product_replace_connector(p_tenant_id uuid, p_old_connector_id uuid, p_new_connector_id uuid, p_reason text)
  returns jsonb language plpgsql security definer set search_path = public as $$
declare v_before jsonb; v_new jsonb; v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
begin
  if not public.has_tenant_role(p_tenant_id, array['owner', 'admin']) then raise exception 'not authorized'; end if;
  if v_reason is null then raise exception 'a replacement reason is required'; end if;
  if length(v_reason) > 500 then raise exception 'replacement reason is too long'; end if;
  if p_old_connector_id = p_new_connector_id then return jsonb_build_object('ok', false, 'reason', 'same_connector'); end if;

  select to_jsonb(t) into v_before from (
    select id, provider, connection_state, superseded_by, disconnected_at from public.connectors
     where id = p_old_connector_id and tenant_id = p_tenant_id for update
  ) t;
  select to_jsonb(t) into v_new from (
    select id, provider, superseded_by, disconnected_at from public.connectors
     where id = p_new_connector_id and tenant_id = p_tenant_id for update
  ) t;
  if v_before is null or v_new is null then return jsonb_build_object('ok', false, 'reason', 'not_found'); end if;
  if (v_before ->> 'provider') is distinct from (v_new ->> 'provider') then return jsonb_build_object('ok', false, 'reason', 'provider_mismatch'); end if;
  if (v_before ->> 'superseded_by') is not null then return jsonb_build_object('ok', true, 'reason', 'already_superseded'); end if;
  -- Pointing at a retired successor would exclude both and leave the organization with no active connector at all.
  if (v_new ->> 'superseded_by') is not null or (v_new ->> 'disconnected_at') is not null then
    return jsonb_build_object('ok', false, 'reason', 'successor_inactive');
  end if;

  update public.connectors
     set superseded_by = p_new_connector_id, superseded_at = now(), superseded_reason = v_reason, updated_at = now()
   where id = p_old_connector_id and tenant_id = p_tenant_id;
  insert into public.audit_logs (tenant_id, actor_user_id, action, resource_type, resource_id, before_json, after_json)
  values (p_tenant_id, auth.uid(), 'connector.replaced', 'connector', p_old_connector_id,
          v_before, jsonb_build_object('superseded_by', p_new_connector_id, 'reason', v_reason));
  return jsonb_build_object('ok', true, 'reason', 'replaced');
end $$;

do $$
declare f text;
begin
  foreach f in array array[
    'public.product_disconnect_connector(uuid, uuid, text)',
    'public.product_reconnect_connector(uuid, uuid)',
    'public.product_replace_connector(uuid, uuid, uuid, text)'
  ] loop
    execute format('revoke execute on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end $$;
