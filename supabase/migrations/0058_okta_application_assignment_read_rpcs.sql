-- 0058_okta_application_assignment_read_rpcs.sql
--
-- Phase 11 (bounded READ-ONLY Okta application-ASSIGNMENT discovery aggregate). ADD two narrow SECURITY DEFINER *READ* RPCs so the
-- runner can (a) obtain the bounded set of already-persisted Okta directory-APPLICATION external_ids for a verified tenant+connection
-- (the appIds to iterate), and (b) resolve a bounded set of app-GROUP-assignment provider group-ids to COUNTS (matched/unmatched)
-- against directory_groups — WITHOUT any table grant, WITHOUT returning a single application/group value (no label, name, description),
-- and WITHOUT any write. The app-USER-assignment resolver is the EXISTING runner_resolve_okta_identity_refs (0055) reused unchanged.
-- This phase PERSISTS NOTHING: NO assignment table, NO assignment fact type, NO INSERT/UPDATE/DELETE — only these two SELECT-only RPCs
-- (+ the reused identity resolver).
--
-- directory_applications + directory_groups stay runner-INTERNAL (revoke-all-from-connector_runner, 0054/0057); the ONLY way
-- connector_runner reads them is through these definer functions (owned by the migration owner). Ownership gate = tenant + connection +
-- provider='okta' (mirrors the 0053/0054/0055/0057 RPCs; deliberately NOT gated on connection_state). Bounded by construction (LIMIT on
-- output, cardinality guard on input). fixed empty search_path, schema-qualified. ADDITIVE; ACTIVATES nothing; no table, no write, no
-- grant on any data table. Staging only; RISK-007 OPEN; Phase C BLOCKED.

begin;

-- ══ RPC #1: list the bounded set of CURRENT directory-application external_ids for a verified okta connection (the appIds to iterate).
-- external_id ONLY — the projection structurally never carries label/name. Returns a jsonb array (empty array if none). ═══════════════
create or replace function public.runner_list_okta_directory_application_refs(p_tenant_id uuid, p_connector_id uuid)
  returns jsonb
  language plpgsql security definer set search_path = ''
as $$
begin
  -- ownership: a tenant-owned okta connection must exist (no name/id echoed on miss).
  if not exists (select 1 from public.connectors c where c.id = p_connector_id and c.tenant_id = p_tenant_id and c.provider = 'okta') then
    raise exception 'no matching okta connection';
  end if;
  -- Only CURRENT (live) applications; bounded LIMIT. external_id ONLY (the Okta 0oa... app id — never the label).
  return (
    select coalesce(jsonb_agg(t.external_id order by t.external_id), '[]'::jsonb)
      from (
        select da.external_id
          from public.directory_applications da
         where da.tenant_id = p_tenant_id and da.connection_id = p_connector_id and da.provider = 'okta'
           and da.external_id is not null and da.sync_status = 'current'
         order by da.external_id
         limit 1000
      ) t
  );
end;
$$;

-- ══ RPC #2: resolve a bounded set of app-group-assignment provider group-ids to COUNTS ONLY (requested/matched/unmatched) against
-- directory_groups. Matches on external_id EQUALITY ONLY (never name/description). Never returns a group id/name value. ══════════════
create or replace function public.runner_resolve_okta_directory_group_refs(p_tenant_id uuid, p_connector_id uuid, p_external_ids text[])
  returns jsonb
  language plpgsql security definer set search_path = ''
as $$
declare
  v_requested integer;
  v_matched integer;
begin
  if p_external_ids is null then raise exception 'external ids required'; end if;
  if cardinality(p_external_ids) > 1000 then raise exception 'too many external ids'; end if; -- bounded input
  if not exists (select 1 from public.connectors c where c.id = p_connector_id and c.tenant_id = p_tenant_id and c.provider = 'okta') then
    raise exception 'no matching okta connection';
  end if;
  select count(distinct e) into v_requested from unnest(p_external_ids) e where e is not null;
  -- matched = distinct requested external_ids that EXIST in directory_groups for this exact tenant+connection+provider (any sync_status
  -- — a stale group is still a KNOWN group; only a NEVER-persisted group is unmatched/dangling). external_id equality only.
  select count(distinct dg.external_id) into v_matched
    from public.directory_groups dg
   where dg.tenant_id = p_tenant_id and dg.connection_id = p_connector_id and dg.provider = 'okta'
     and dg.external_id = any (p_external_ids);
  return jsonb_build_object('requested', coalesce(v_requested, 0), 'matched', coalesce(v_matched, 0), 'unmatched', coalesce(v_requested, 0) - coalesce(v_matched, 0));
end;
$$;

-- ══ least privilege (revoke from public + anon + authenticated; grant only to connector_runner). NO grant on any data table — the
-- definer functions are the only read path; connector_runner stays without direct SELECT. ════════════════════════════════════════════
revoke execute on function public.runner_list_okta_directory_application_refs(uuid, uuid) from public, anon, authenticated;
revoke execute on function public.runner_resolve_okta_directory_group_refs(uuid, uuid, text[]) from public, anon, authenticated;
grant execute on function public.runner_list_okta_directory_application_refs(uuid, uuid) to connector_runner;
grant execute on function public.runner_resolve_okta_directory_group_refs(uuid, uuid, text[]) to connector_runner;

commit;
