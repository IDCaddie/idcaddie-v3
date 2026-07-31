-- 0072_group_access_subgraph.sql
--
-- Phase 3 — `product_group_access_subgraph`, the read contract behind the Group detail route.
--
-- Groups were the one directory object with no home. People and applications each had an entity subgraph since 0061; a group could
-- only be listed. Group membership is one of the two ways a person reaches an application, so "who is in this group and what does
-- it grant" is a first-order question the product could not answer.
--
-- HOW THIS DIFFERS FROM THE TWO EXISTING SUBGRAPHS, deliberately:
--
--   1. CONNECTOR-SCOPED EDGES. The 0061 identity and application subgraphs scope their edges by tenant + anchor id. This one also
--      scopes every edge and every neighbour row by the ANCHOR GROUP'S `connection_id`. Composite foreign keys already make a
--      cross-connector edge structurally impossible, so this is defence in depth — but it is the property that keeps two connectors
--      reading the same Okta organization from bleeding into each other, which is exactly the P0 that 0071 closed.
--
--   2. BOUNDED INSIDE THE FUNCTION. A group is the fan-in case: "Everyone" in a large organization is one row pointing at every
--      identity in the tenant. The other two subgraphs let the loader cap the result AFTER the RPC has built it; for a group that
--      means materializing the whole membership list as jsonb before anything can reject it. This one counts first and returns
--      `bounded: true` with the summary and NO arrays. It fails closed rather than truncating — a half-populated member list that
--      looks complete is worse than an honest refusal.
--
-- SUPERSESSION. The anchor is gated on the 0071 pointer, so a group owned by a superseded connector returns null — the same answer
-- as a group that does not exist, and as one belonging to another tenant. Three different causes, one indistinguishable response.
--
-- WHAT IT RETURNS AND WHY. Members and the applications the group grants are the two direct questions. `userAssignments` is scoped
-- to (this group's members × the applications this group grants) so the access engine can tell whether a person ALSO holds the same
-- application directly — the difference between "this group is how they get in" and "this group is one of two ways". That is
-- derived by the existing Phase-13 engine from these rows, never computed here.
--
-- Read-only, definer, pinned search_path, no raw payload column exists on any of these tables, no provider secret, no tenant id
-- accepted from a caller. Staging only.

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
     and not exists (select 1 from public.connectors sc where sc.id = g.connection_id and sc.superseded_by is not null);
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

-- ══ least privilege: EXECUTE to authenticated ONLY; public + anon denied. Mirrors 0061:252-268. ═══════════════════════════
revoke execute on function public.product_group_access_subgraph(uuid, uuid, boolean) from public, anon, authenticated;
grant execute on function public.product_group_access_subgraph(uuid, uuid, boolean) to authenticated;
