-- 0055_okta_group_membership_read_rpcs.sql
--
-- Phase 7 (bounded READ-ONLY Okta group-membership discovery aggregate). ADD two narrow SECURITY DEFINER *READ* RPCs so the runner can
-- (a) obtain the bounded set of already-persisted Okta directory-group external_ids for a verified tenant+connection, and (b) resolve a
-- bounded set of member provider user-ids to COUNTS (matched/unmatched) against identity_accounts — WITHOUT any table grant, WITHOUT
-- returning a single group/identity value (no name, description, email, or login), and WITHOUT any write. This phase PERSISTS NOTHING:
-- there is NO membership table, NO membership fact type, NO INSERT/UPDATE/DELETE — only these two SELECT-only RPCs.
--
-- Both tables stay runner-INTERNAL (identity_accounts + directory_groups are revoke-all-from-connector_runner, 0053/0054); the ONLY way
-- connector_runner can read them is through these definer functions (owned by the migration owner). Ownership gate = tenant + connection
-- + provider='okta' (mirrors the 0053/0054 promote/stale RPCs; deliberately NOT gated on a specific connection_state — a connection that
-- has completed discovery is 'discovered', not 'verified', and an unowned/wrong-provider connection is rejected regardless). Bounded by
-- construction (LIMIT on output, cardinality guard on input). fixed empty search_path, schema-qualified. ADDITIVE; ACTIVATES nothing;
-- no table, no write, no grant on any data table. Staging only; RISK-007 OPEN; Phase C BLOCKED.

begin;

-- ══ RPC #1: list the bounded set of CURRENT directory-group external_ids for a verified okta connection. external_id ONLY — the
-- projection structurally never carries name/description. Returns a jsonb array (empty array if none). ══════════════════════════════
create or replace function public.runner_list_okta_directory_group_refs(p_tenant_id uuid, p_connector_id uuid)
  returns jsonb
  language plpgsql security definer set search_path = ''
as $$
begin
  -- ownership: a tenant-owned okta connection must exist (no name/id echoed on miss).
  if not exists (select 1 from public.connectors c where c.id = p_connector_id and c.tenant_id = p_tenant_id and c.provider = 'okta') then
    raise exception 'no matching okta connection';
  end if;
  -- connection_id COLUMN holds the connector id (0054:199). Only CURRENT (live) groups; bounded LIMIT. external_id ONLY.
  return (
    select coalesce(jsonb_agg(t.external_id order by t.external_id), '[]'::jsonb)
      from (
        select dg.external_id
          from public.directory_groups dg
         where dg.tenant_id = p_tenant_id and dg.connection_id = p_connector_id and dg.provider = 'okta'
           and dg.external_id is not null and dg.sync_status = 'current'
         order by dg.external_id
         limit 1000
      ) t
  );
end;
$$;

-- ══ RPC #2: resolve a bounded set of member provider user-ids to COUNTS ONLY (requested/matched/unmatched) against identity_accounts.
-- Matches on external_id EQUALITY ONLY (never email/login/name). Never returns an id/email/login value. ══════════════════════════════
create or replace function public.runner_resolve_okta_identity_refs(p_tenant_id uuid, p_connector_id uuid, p_external_ids text[])
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
  -- matched = distinct requested external_ids that EXIST in identity_accounts for this exact tenant+connection+provider (any sync_status
  -- — a stale identity is still a KNOWN identity; only a NEVER-persisted member is unmatched/dangling). external_id equality only.
  select count(distinct ia.external_id) into v_matched
    from public.identity_accounts ia
   where ia.tenant_id = p_tenant_id and ia.connection_id = p_connector_id and ia.provider = 'okta'
     and ia.external_id = any (p_external_ids);
  return jsonb_build_object('requested', coalesce(v_requested, 0), 'matched', coalesce(v_matched, 0), 'unmatched', coalesce(v_requested, 0) - coalesce(v_matched, 0));
end;
$$;

-- ══ least privilege (0045/0053/0054 hosted-Supabase form: revoke from public + anon + authenticated; grant only to connector_runner).
-- NO grant on any data table — the definer functions are the only read path; connector_runner stays without direct SELECT. ══════════
revoke execute on function public.runner_list_okta_directory_group_refs(uuid, uuid) from public, anon, authenticated;
revoke execute on function public.runner_resolve_okta_identity_refs(uuid, uuid, text[]) from public, anon, authenticated;
grant execute on function public.runner_list_okta_directory_group_refs(uuid, uuid) to connector_runner;
grant execute on function public.runner_resolve_okta_identity_refs(uuid, uuid, text[]) to connector_runner;

commit;
