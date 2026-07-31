-- 0071_connector_supersession.sql
--
-- P0 — one Okta organization, one active connector.
--
-- THE DEFECT. A tenant can hold two connector rows that read the SAME Okta organization. Staging tenant
-- aaaa1111-…-111111111111 has exactly that: `Okta (A1 Procurement)` (created 2026-07-21, 5 runs, last 2026-07-24, no
-- okta_connector_configs row — it predates 0063) and `Okta Staging (O2C.2 verification)` (created 2026-07-30, 24 runs, last
-- 2026-07-31, validated config for trial-5294016.okta.com).
--
-- Both discovered the same directory, so every product surface double-counts. Home reported 2 people where the organization has
-- one, 9 groups where it has 7, and 4 applications where it has 2.
--
-- THE PROOF THAT IT IS ONE ORGANIZATION. Not names, not emails, not row similarity — Okta external ids. They are opaque,
-- globally unique, provider-issued identifiers. Measured on staging before this migration:
--
--     table                    legacy rows   controlled rows   external_ids present under BOTH
--     identity_accounts                  1                 1                                 1
--     directory_groups                   2                 7                                 2
--     directory_applications             2                 2                                 2
--
-- Every legacy external_id also exists under the controlled connector, and none is unique to the legacy one. The legacy row set
-- is a strict subset of the controlled row set: the same organization, read twice, the second time more completely.
--
-- THE RULE. Supersession is DECLARED, not inferred. A connector may carry a pointer to the connector that replaced it; product
-- reads then exclude it. Nothing guesses at read time, because a rule like "prefer the newest" or "prefer the one with a config
-- row" silently changes which data a customer sees whenever the underlying facts shift. The decision is made once, recorded with
-- its reason, and is visible in the row.
--
-- Deliberately NOT how this is solved: no DISTINCT, no dedup on name/label/login/email, no "pick one row per external_id". Those
-- pick a winner per ROW; the duplication is per CONNECTOR, and only connector-level ownership can resolve it without inventing a
-- preference between two equally real records.
--
-- WHAT IS PRESERVED. Every legacy row stays exactly as it is — no delete, no rewrite, no status change. `connector_runs`,
-- `connector_run_discovery`, `discovery_facts` and `audit_logs` are untouched. The legacy connector row itself remains, now
-- carrying an explicit pointer to what replaced it. The history stays queryable; it just stops being presented as live.
--
-- DISTINCT ORGANIZATIONS STAY SUPPORTED. The filter keys on `superseded_by`, which is set per connector by an operator decision.
-- Two Okta connectors for two genuinely different organizations are both unsuperseded and both remain fully visible.
--
-- Staging only. No production apply.

-- ══ 1. THE SUPERSESSION POINTER ══════════════════════════════════════════════════════════════════════════════════════════
alter table public.connectors
  add column if not exists superseded_by uuid references public.connectors (id),
  add column if not exists superseded_at timestamptz,
  add column if not exists superseded_reason text;

-- All three move together, or none does: a pointer with no timestamp/reason is an undocumented decision, and a reason with no
-- pointer excludes nothing. A connector may never supersede itself.
alter table public.connectors
  add constraint connectors_supersession_complete_chk
  check ((superseded_by is null and superseded_at is null and superseded_reason is null)
      or (superseded_by is not null and superseded_at is not null and superseded_reason is not null)) not valid;
alter table public.connectors validate constraint connectors_supersession_complete_chk;

alter table public.connectors
  add constraint connectors_no_self_supersession_chk check (superseded_by is distinct from id) not valid;
alter table public.connectors validate constraint connectors_no_self_supersession_chk;

comment on column public.connectors.superseded_by is
  'The connector that replaced this one for the same upstream organization. When set, this connector is excluded from every product read surface; its rows and history are retained unchanged.';

-- Partial index: the predicate below runs once per candidate row on every product read, and only superseded connectors matter.
create index if not exists connectors_superseded_idx on public.connectors (id) where superseded_by is not null;

-- ══ 2. PRODUCT READS EXCLUDE SUPERSEDED CONNECTORS ═══════════════════════════════════════════════════════════════════════
-- All nine migration-0061 read RPCs, reissued with one added predicate:
--
--     and not exists (select 1 from public.connectors sc where sc.id = <row>.connection_id and sc.superseded_by is not null)
--
-- Every body below un-patches to byte-identical 0061; the predicate is the only addition. Enforcing here rather than in the
-- application is what makes Home, People, Groups, Directory applications, Access, Findings and both detail pages agree by
-- construction — there is no second scope for a caller to forget.
--
-- The two subgraph functions gate their ANCHOR select. A record owned by a superseded connector yields a null anchor, which
-- makes the whole function return null, which the repository already maps to the uniform not_found. A superseded record has no
-- detail page, and it is indistinguishable from one that never existed.

-- ── product_directory_access_counts
create or replace function public.product_directory_access_counts(
  p_tenant_id uuid, p_connection_id uuid default null, p_provider text default null
) returns jsonb language plpgsql security definer set search_path = public stable as $$
begin
  if not public.has_tenant_role(p_tenant_id, array['owner', 'admin']) then return null; end if; -- verify, never trust; non-owner/admin -> not-found
  return jsonb_build_object(
    'identities',       (select count(*) from public.identity_accounts x where x.tenant_id = p_tenant_id and (p_connection_id is null or x.connection_id = p_connection_id) and (p_provider is null or x.provider = p_provider) and not exists (select 1 from public.connectors sc where sc.id = x.connection_id and sc.superseded_by is not null)),
    'groups',           (select count(*) from public.directory_groups x where x.tenant_id = p_tenant_id and (p_connection_id is null or x.connection_id = p_connection_id) and (p_provider is null or x.provider = p_provider) and not exists (select 1 from public.connectors sc where sc.id = x.connection_id and sc.superseded_by is not null)),
    'applications',     (select count(*) from public.directory_applications x where x.tenant_id = p_tenant_id and (p_connection_id is null or x.connection_id = p_connection_id) and (p_provider is null or x.provider = p_provider) and not exists (select 1 from public.connectors sc where sc.id = x.connection_id and sc.superseded_by is not null)),
    'memberships',      (select count(*) from public.directory_group_memberships x where x.tenant_id = p_tenant_id and (p_connection_id is null or x.connection_id = p_connection_id) and (p_provider is null or x.provider = p_provider) and not exists (select 1 from public.connectors sc where sc.id = x.connection_id and sc.superseded_by is not null)),
    'userAssignments',  (select count(*) from public.directory_application_user_assignments x where x.tenant_id = p_tenant_id and (p_connection_id is null or x.connection_id = p_connection_id) and (p_provider is null or x.provider = p_provider) and not exists (select 1 from public.connectors sc where sc.id = x.connection_id and sc.superseded_by is not null)),
    'groupAssignments', (select count(*) from public.directory_application_group_assignments x where x.tenant_id = p_tenant_id and (p_connection_id is null or x.connection_id = p_connection_id) and (p_provider is null or x.provider = p_provider) and not exists (select 1 from public.connectors sc where sc.id = x.connection_id and sc.superseded_by is not null))
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
       and not exists (select 1 from public.connectors sc where sc.id = x.connection_id and sc.superseded_by is not null)
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
       and not exists (select 1 from public.connectors sc where sc.id = x.connection_id and sc.superseded_by is not null)
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
       and not exists (select 1 from public.connectors sc where sc.id = x.connection_id and sc.superseded_by is not null)
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
       and not exists (select 1 from public.connectors sc where sc.id = x.connection_id and sc.superseded_by is not null)
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
       and not exists (select 1 from public.connectors sc where sc.id = x.connection_id and sc.superseded_by is not null)
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
       and not exists (select 1 from public.connectors sc where sc.id = x.connection_id and sc.superseded_by is not null)
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
        and not exists (select 1 from public.connectors sc where sc.id = a.connection_id and sc.superseded_by is not null)
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
        and not exists (select 1 from public.connectors sc where sc.id = a.connection_id and sc.superseded_by is not null)
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

-- ══ 3. LEAST PRIVILEGE (re-asserted) ═════════════════════════════════════════════════════════════════════════════════════
-- CREATE OR REPLACE preserves the ACL, but on hosted Supabase ALTER DEFAULT PRIVILEGES grants EXECUTE on new public functions
-- directly to anon/authenticated (0045), and `revoke from public` alone does not remove those. Mirrors 0061:252-268 exactly.
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

-- ══ 4. RECORD THE STAGING SUPERSESSION ═══════════════════════════════════════════════════════════════════════════════════
-- Declares the one decision this migration exists to enact. Guarded so it is a NO-OP anywhere the preconditions do not hold —
-- the ids are named, but the migration does not trust them: it re-proves the relationship before writing.
--
--   * both connectors exist, are okta, and are in the SAME tenant
--   * the survivor has a validated okta_connector_configs row; the superseded one has none
--   * EVERY external_id under the superseded connector also exists under the survivor, on all three node tables
--
-- The third condition is the same external-id proof described at the top. If a single legacy record were unique to the legacy
-- connector, this writes nothing and the duplication stays visible rather than being quietly resolved the wrong way.
do $$
declare
  v_legacy   constant uuid := 'c8d098d4-13ea-4f82-af3c-78cf8a1407a4';
  v_survivor constant uuid := 'cdf19b61-6f22-4e61-8784-99a453396805';
  v_tenant uuid; v_orphans int;
begin
  select l.tenant_id into v_tenant
    from public.connectors l join public.connectors s on s.id = v_survivor
   where l.id = v_legacy and l.provider = 'okta' and s.provider = 'okta' and l.tenant_id = s.tenant_id
     and l.superseded_by is null
     and exists (select 1 from public.okta_connector_configs k where k.connector_id = v_survivor and k.validation_status = 'succeeded' and k.disabled_at is null)
     and not exists (select 1 from public.okta_connector_configs k where k.connector_id = v_legacy);
  if v_tenant is null then
    raise notice '0071: supersession preconditions not met; nothing recorded';
    return;
  end if;

  select
    (select count(*) from public.identity_accounts a where a.connection_id = v_legacy
       and not exists (select 1 from public.identity_accounts b where b.connection_id = v_survivor and b.external_id = a.external_id))
  + (select count(*) from public.directory_groups a where a.connection_id = v_legacy
       and not exists (select 1 from public.directory_groups b where b.connection_id = v_survivor and b.external_id = a.external_id))
  + (select count(*) from public.directory_applications a where a.connection_id = v_legacy
       and not exists (select 1 from public.directory_applications b where b.connection_id = v_survivor and b.external_id = a.external_id))
  into v_orphans;

  if v_orphans <> 0 then
    raise notice '0071: % legacy record(s) have no counterpart under the survivor; NOT superseding', v_orphans;
    return;
  end if;

  update public.connectors
     set superseded_by = v_survivor,
         superseded_at = now(),
         superseded_reason = 'Same Okta organization as the surviving connector: every external_id under this connector is also present under it, and none is unique to it. Superseded during the P0 duplicate-ownership fix. Rows and run history retained unchanged.',
         updated_at = now()
   where id = v_legacy;
  raise notice '0071: recorded supersession of % by %', v_legacy, v_survivor;
end $$;
