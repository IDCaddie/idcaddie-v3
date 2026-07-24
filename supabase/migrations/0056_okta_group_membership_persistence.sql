-- 0056_okta_group_membership_persistence.sql
--
-- Phase 8 — durable, tenant/connection-scoped Okta directory-group MEMBERSHIP persistence: the canonical provider-neutral EDGE
-- directory_group_memberships (identity_accounts <-> directory_groups). All ADDITIVE. (A) adds a FULL unique constraint on each parent
-- so the edge can composite-FK BOTH endpoints (id + the 3 scope columns) — DB-enforcing that a membership's group AND identity both
-- belong to the SAME tenant+connection+provider; (B) creates the edge (canonical ROW-id references only — NO raw_payload, NO
-- email/login/name/member_count) with the immutable relationship key + the 0053/0054 freshness/sync_status shape; (C) adds the
-- 'directory_group_membership' fact type + a minimal positive-key allowlist to the write boundary; (D) a complete-run-only promotion
-- RPC with DUAL-ENDPOINT in-DB resolution that FAILS CLOSED (counts only) if any endpoint does not resolve to a unique canonical row
-- (stronger than the runner's advisory unmatched count — no dangling edge can persist); (E) a stale RPC (the 0054 evidence-based
-- ladder retargeted at edges). All runner writes go through SECURITY DEFINER functions granted ONLY to connector_runner; NO direct
-- table write grant. There is NO raw_payload column. Reuses connector_run_discovery + connector_discovery_policy (run_id + fact_type
-- disambiguate a membership run). Keeps connection_state = discovered (no advance). ACTIVATES nothing. Staging only; RISK-007 OPEN;
-- Phase C BLOCKED; no schedule, no active, no registry, no apps, no assignments.

begin;

-- ══ A. FULL (non-partial) unique constraints on each parent = the composite-FK targets. Additive-safe: `id` is each table's PK, so
-- these 4-tuples are already unique for every existing/future row (the parents' own provider-identity indexes are PARTIAL + on the
-- external_id tuple, so they cannot serve as FK targets). ══════════════════════════════════════════════════════════════════════════
alter table public.directory_groups drop constraint if exists directory_groups_id_scope_key;
alter table public.directory_groups add constraint directory_groups_id_scope_key unique (id, tenant_id, connection_id, provider);
alter table public.identity_accounts drop constraint if exists identity_accounts_id_scope_key;
alter table public.identity_accounts add constraint identity_accounts_id_scope_key unique (id, tenant_id, connection_id, provider);

-- ══ B. CREATE the canonical provider-neutral membership EDGE (identity_accounts <-> directory_groups) ═══════════════════════════════
create table if not exists public.directory_group_memberships (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  connection_id uuid not null,
  provider text not null,
  directory_group_id uuid not null,   -- canonical ROW ref = directory_groups.id (resolved from the group external_id at promotion)
  identity_account_id uuid not null,  -- canonical ROW ref = identity_accounts.id (resolved from the user external_id at promotion)
  first_seen_at timestamptz,
  last_seen_at timestamptz,
  stale_since timestamptz,
  sync_status text not null default 'current',
  last_discovery_run_id uuid,
  schema_version text,
  sanitizer_version text,
  normalizer_version text,
  source_endpoint text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- sync_status vocabulary (identical to directory_groups / identity_accounts).
  constraint directory_group_memberships_sync_status_chk check (sync_status in ('current', 'stale', 'review_required', 'disconnected')),
  -- IMMUTABLE relationship key (the ON CONFLICT target). All five columns are NOT NULL -> a PLAIN (non-partial) unique constraint.
  constraint dgm_edge_key unique (tenant_id, connection_id, provider, directory_group_id, identity_account_id),
  -- same-tenant connection binding (reuses connectors_id_tenant_key, 0017:59).
  constraint dgm_connection_same_tenant foreign key (connection_id, tenant_id) references public.connectors (id, tenant_id) on delete cascade,
  -- GROUP endpoint: DB-enforces the group belongs to this exact tenant+connection+provider.
  constraint dgm_group_fk foreign key (directory_group_id, tenant_id, connection_id, provider)
    references public.directory_groups (id, tenant_id, connection_id, provider) on delete cascade,
  -- IDENTITY endpoint: DB-enforces the identity belongs to this exact tenant+connection+provider (all four cols NOT NULL -> always checked).
  constraint dgm_identity_fk foreign key (identity_account_id, tenant_id, connection_id, provider)
    references public.identity_accounts (id, tenant_id, connection_id, provider) on delete cascade
);
create index if not exists dgm_connection_idx on public.directory_group_memberships (tenant_id, connection_id);
create index if not exists dgm_group_idx on public.directory_group_memberships (tenant_id, connection_id, directory_group_id);
create index if not exists dgm_identity_idx on public.directory_group_memberships (tenant_id, connection_id, identity_account_id);
create index if not exists dgm_sync_status_idx on public.directory_group_memberships (tenant_id, connection_id, sync_status);

alter table public.directory_group_memberships enable row level security; -- deny-all to anon/authenticated; only SECURITY DEFINER reads/writes

-- ══ C. add the 'directory_group_membership' fact_type + a minimal positive-key allowlist to the write boundary (0041/0053/0054) ══════
-- CREATE OR REPLACE with the SAME 11-arg signature preserves the existing grant. This is the conscious Phase-8 reversal of 0054's
-- "no memberships" lever — but as the DISTINCT provider-neutral 'directory_group_membership' type (NOT the app-scoped 'group_membership').
create or replace function public.runner_insert_discovery_fact(
  p_tenant_id uuid, p_source_run_id uuid, p_fact_type text, p_source_type text, p_source_provider text,
  p_signal_id text, p_natural_key text, p_observed_at timestamptz, p_confidence numeric,
  p_fact_json jsonb, p_provenance_json jsonb
) returns void
  language plpgsql security definer set search_path = ''
as $$
begin
  if not exists (select 1 from public.connector_runs r where r.id = p_source_run_id and r.tenant_id = p_tenant_id) then
    raise exception 'source_run_id % does not belong to tenant %', p_source_run_id, p_tenant_id;
  end if;
  -- fact_type allowlist — Phase 2 (app_user_account, group) + Phase 4 (identity_account) + Phase 6 (directory_group) + Phase 8
  -- (directory_group_membership). The bare 'group_membership' stays ABSENT (that was the app-group no-memberships lever).
  if p_fact_type not in ('app_user_account', 'group', 'identity_account', 'directory_group', 'directory_group_membership') then
    raise exception 'fact_type % is not in the allowlist', p_fact_type;
  end if;
  if p_source_type not in (
    'identity_provider_discovery', 'deep_provider_sync', 'contract_intelligence', 'invoice_spend_import',
    'browser_extension_discovery', 'manual_csv_import', 'unknown_source'
  ) then
    raise exception 'source_type % is not a known discovery source type', p_source_type;
  end if;
  if p_fact_json is null or jsonb_typeof(p_fact_json) <> 'object' then
    raise exception 'fact_json must be a json object';
  end if;
  if p_fact_json ->> 'fact_type' is distinct from p_fact_type then
    raise exception 'fact_json.fact_type must match p_fact_type';
  end if;
  -- identity_account: POSITIVE top-level key ALLOWLIST (from 0053) — unchanged.
  if p_fact_type = 'identity_account' and exists (
    select 1 from jsonb_object_keys(p_fact_json) k
     where k not in ('fact_type','external_id','connection_id','login','normalized_login','email','normalized_email',
                     'first_name','last_name','display_name','status','is_active','department','title','employee_number',
                     'provider_created_at','provider_activated_at','provider_last_login_at','provider_last_updated_at','provider_status_changed_at')
  ) then
    raise exception 'identity_account fact_json contains a non-approved key';
  end if;
  -- directory_group: POSITIVE top-level key ALLOWLIST (from 0054) — unchanged.
  if p_fact_type = 'directory_group' and exists (
    select 1 from jsonb_object_keys(p_fact_json) k
     where k not in ('fact_type','external_id','connection_id','name','normalized_name','description','group_type_category',
                     'provider_created_at','provider_last_updated_at')
  ) then
    raise exception 'directory_group fact_json contains a non-approved key';
  end if;
  -- directory_group_membership: MINIMAL POSITIVE key ALLOWLIST — ONLY the immutable relationship evidence. Deliberately EXCLUDES any
  -- name/login/email/display_name/description/member_count/_links/_embedded/raw payload (source_endpoint + *_version live in provenance_json).
  if p_fact_type = 'directory_group_membership' and exists (
    select 1 from jsonb_object_keys(p_fact_json) k
     where k not in ('fact_type','connection_id','group_external_id','user_external_id')
  ) then
    raise exception 'directory_group_membership fact_json contains a non-approved key';
  end if;
  -- recursive forbidden-key scan (keys only; a value never trips it).
  if exists (
    with recursive walk(v) as (
      select x from (values (p_fact_json), (coalesce(p_provenance_json, '{}'::jsonb))) as t(x)
      union all
      select child.v from walk w cross join lateral (
        select e.value as v from jsonb_each(w.v) e where jsonb_typeof(w.v) = 'object'
        union all
        select a.value as v from jsonb_array_elements(w.v) a where jsonb_typeof(w.v) = 'array'
      ) child
    )
    select 1 from walk w cross join lateral jsonb_object_keys(w.v) k
      where jsonb_typeof(w.v) = 'object' and lower(k) ~ '(token|secret|ciphertext|dek_wrapped|aead_|credential|_embedded|password|assertion)'
  ) then
    raise exception 'fact contains a forbidden secret-like key';
  end if;

  insert into public.discovery_facts (
    tenant_id, schema_version, fact_type, source_type, source_provider, source_run_id,
    signal_id, natural_key, observed_at, confidence, fact_json, provenance_json
  ) values (
    p_tenant_id, '1', p_fact_type, p_source_type, p_source_provider, p_source_run_id,
    p_signal_id, p_natural_key, p_observed_at, p_confidence, p_fact_json, p_provenance_json
  )
  on conflict (tenant_id, source_provider, fact_type, signal_id) where signal_id is not null
  do update set source_run_id = excluded.source_run_id, fact_json = excluded.fact_json,
                provenance_json = excluded.provenance_json, observed_at = excluded.observed_at,
                natural_key = excluded.natural_key, confidence = excluded.confidence;
end;
$$;

-- ══ D. PROMOTION: membership facts -> directory_group_memberships, ONLY after a complete+clean run, with DUAL-ENDPOINT in-DB
-- resolution that FAILS CLOSED if any endpoint is unresolved (no dangling edge can persist). ═══════════════════════════════════════
create or replace function public.runner_promote_okta_directory_group_memberships(p_run_id uuid, p_tenant_id uuid)
  returns jsonb
  language plpgsql security definer set search_path = ''
as $$
declare
  v_connector_id uuid;
  v_complete boolean; v_rejected integer; v_termination text; v_review boolean;
  v_unresolved_groups integer := 0; v_unresolved_identities integer := 0;
  v_created integer := 0; v_updated integer := 0;
begin
  select r.connector_id into v_connector_id from public.connector_runs r where r.id = p_run_id and r.tenant_id = p_tenant_id;
  if not found then raise exception 'run % does not belong to tenant %', p_run_id, p_tenant_id; end if;
  if not exists (select 1 from public.connectors c where c.id = v_connector_id and c.tenant_id = p_tenant_id and c.provider = 'okta') then
    raise exception 'connector for run % is not an okta connection', p_run_id;
  end if;

  select d.completeness, d.records_rejected, d.termination_reason, d.review_required
    into v_complete, v_rejected, v_termination, v_review
    from public.connector_run_discovery d where d.run_id = p_run_id and d.tenant_id = p_tenant_id;
  if not found then raise exception 'run % has no recorded discovery metrics; cannot promote', p_run_id; end if;
  if v_complete is not true or coalesce(v_rejected, 1) <> 0 or v_termination is distinct from 'last_page' or v_review is true then
    raise exception 'run % is not eligible for promotion (complete=%, rejected=%, termination=%, review=%)', p_run_id, v_complete, v_rejected, v_termination, v_review;
  end if;

  -- latest-run guard: never (re)promote a SUPERSEDED run.
  if exists (
    select 1 from public.connector_runs r2 join public.connector_run_discovery d2 on d2.run_id = r2.id
     where r2.connector_id = v_connector_id and r2.tenant_id = p_tenant_id and r2.id <> p_run_id
       and d2.completeness is true and d2.termination_reason = 'last_page'
       and r2.started_at > (select started_at from public.connector_runs where id = p_run_id)
  ) then
    raise exception 'run % is superseded by a later complete run; refusing to promote', p_run_id;
  end if;

  -- DUAL-ENDPOINT RESOLUTION check (counts only): every distinct (group_ext, user_ext) fact for THIS run+connection must resolve to a
  -- UNIQUE canonical group AND identity for this exact tenant+connection+provider. Unresolved -> FAIL CLOSED (roll back the whole promotion).
  select count(*) filter (where dg.id is null), count(*) filter (where ia.id is null)
    into v_unresolved_groups, v_unresolved_identities
    from (
      select distinct on (f.fact_json ->> 'group_external_id', f.fact_json ->> 'user_external_id')
             f.fact_json ->> 'group_external_id' as gext, f.fact_json ->> 'user_external_id' as uext
        from public.discovery_facts f
       where f.source_run_id = p_run_id and f.tenant_id = p_tenant_id and f.source_provider = 'okta'
         and f.fact_type = 'directory_group_membership'
         and f.fact_json ->> 'group_external_id' is not null and f.fact_json ->> 'user_external_id' is not null
         and (f.fact_json ->> 'connection_id') is not distinct from v_connector_id::text
       order by f.fact_json ->> 'group_external_id', f.fact_json ->> 'user_external_id'
    ) s
    left join public.directory_groups dg on dg.tenant_id = p_tenant_id and dg.connection_id = v_connector_id and dg.provider = 'okta' and dg.external_id = s.gext
    left join public.identity_accounts ia on ia.tenant_id = p_tenant_id and ia.connection_id = v_connector_id and ia.provider = 'okta' and ia.external_id = s.uext;
  if coalesce(v_unresolved_groups, 0) > 0 or coalesce(v_unresolved_identities, 0) > 0 then
    raise exception 'run % has unresolved membership endpoints (unresolvedGroups=%, unresolvedIdentities=%); refusing to promote', p_run_id, v_unresolved_groups, v_unresolved_identities;
  end if;

  -- upsert edges (all endpoints now provably resolve). first_seen preserved; last_seen advanced; sync_status current; stale cleared.
  with existing as (
    select m.directory_group_id as g, m.identity_account_id as i from public.directory_group_memberships m
     where m.tenant_id = p_tenant_id and m.connection_id = v_connector_id and m.provider = 'okta'
  ),
  src as (
    select distinct on (f.fact_json ->> 'group_external_id', f.fact_json ->> 'user_external_id')
           f.fact_json ->> 'group_external_id' as gext, f.fact_json ->> 'user_external_id' as uext, f.provenance_json as p
      from public.discovery_facts f
     where f.source_run_id = p_run_id and f.tenant_id = p_tenant_id and f.source_provider = 'okta'
       and f.fact_type = 'directory_group_membership'
       and f.fact_json ->> 'group_external_id' is not null and f.fact_json ->> 'user_external_id' is not null
       and (f.fact_json ->> 'connection_id') is not distinct from v_connector_id::text
     order by f.fact_json ->> 'group_external_id', f.fact_json ->> 'user_external_id', f.observed_at desc
  ),
  resolved as (
    select dg.id as dg_id, ia.id as ia_id, s.p as p from src s
      join public.directory_groups dg on dg.tenant_id = p_tenant_id and dg.connection_id = v_connector_id and dg.provider = 'okta' and dg.external_id = s.gext
      join public.identity_accounts ia on ia.tenant_id = p_tenant_id and ia.connection_id = v_connector_id and ia.provider = 'okta' and ia.external_id = s.uext
  ),
  upserted as (
    insert into public.directory_group_memberships (
      tenant_id, connection_id, provider, directory_group_id, identity_account_id,
      first_seen_at, last_seen_at, sync_status, last_discovery_run_id,
      schema_version, sanitizer_version, normalizer_version, source_endpoint, created_at, updated_at
    )
    select p_tenant_id, v_connector_id, 'okta', r.dg_id, r.ia_id,
           now(), now(), 'current', p_run_id,
           r.p ->> 'schema_version', r.p ->> 'sanitizer_version', r.p ->> 'normalizer_version', r.p ->> 'source_endpoint', now(), now()
      from resolved r
    on conflict (tenant_id, connection_id, provider, directory_group_id, identity_account_id)
    do update set last_seen_at = now(), sync_status = 'current', last_discovery_run_id = p_run_id, stale_since = null,
                  schema_version = excluded.schema_version, sanitizer_version = excluded.sanitizer_version,
                  normalizer_version = excluded.normalizer_version, source_endpoint = excluded.source_endpoint, updated_at = now()
      -- first_seen_at intentionally NOT updated (preserved); there is no raw_payload column.
    returning directory_group_id as g, identity_account_id as i
  )
  select count(*) filter (where not exists (select 1 from existing e where e.g = u.g and e.i = u.i)),
         count(*) filter (where exists (select 1 from existing e where e.g = u.g and e.i = u.i))
    into v_created, v_updated from upserted u;

  update public.connector_run_discovery set facts_inserted = v_created, facts_updated = v_updated where run_id = p_run_id;
  return jsonb_build_object('membershipsCreated', v_created, 'membershipsUpdated', v_updated);
end;
$$;

-- ══ E. STALE: evidence-based eligibility + configurable mass-staleness circuit breaker over the edges. First run stales ZERO. ══════
create or replace function public.runner_mark_absent_okta_directory_group_memberships_stale(p_run_id uuid, p_tenant_id uuid)
  returns jsonb
  language plpgsql security definer set search_path = ''
as $$
declare
  v_connector_id uuid;
  v_complete boolean; v_rejected integer; v_termination text; v_review boolean;
  v_prior_current integer; v_absent integer; v_absent_pct numeric;
  v_pct_threshold numeric; v_abs_threshold integer; v_marked integer := 0;
begin
  select r.connector_id into v_connector_id from public.connector_runs r where r.id = p_run_id and r.tenant_id = p_tenant_id;
  if not found then raise exception 'run % does not belong to tenant %', p_run_id, p_tenant_id; end if;
  if not exists (select 1 from public.connectors c where c.id = v_connector_id and c.tenant_id = p_tenant_id and c.provider = 'okta') then
    raise exception 'connector for run % is not an okta connection', p_run_id;
  end if;
  perform 1 from public.connectors c where c.id = v_connector_id and c.tenant_id = p_tenant_id for update; -- serialize promote/stale

  select d.completeness, d.records_rejected, d.termination_reason, d.review_required into v_complete, v_rejected, v_termination, v_review
    from public.connector_run_discovery d where d.run_id = p_run_id and d.tenant_id = p_tenant_id;
  if not found or v_complete is not true or coalesce(v_rejected, 1) <> 0 or v_termination is distinct from 'last_page' or v_review is true then
    return jsonb_build_object('staleMarked', 0, 'absentCount', 0, 'priorCurrent', 0, 'circuitBreakerTriggered', false, 'eligible', false);
  end if;

  if exists (
    select 1 from public.connector_runs r2 join public.connector_run_discovery d2 on d2.run_id = r2.id
     where r2.connector_id = v_connector_id and r2.tenant_id = p_tenant_id and r2.id <> p_run_id
       and d2.completeness is true and d2.termination_reason = 'last_page'
       and r2.started_at > (select started_at from public.connector_runs where id = p_run_id)
  ) then
    return jsonb_build_object('staleMarked', 0, 'absentCount', 0, 'priorCurrent', 0, 'circuitBreakerTriggered', false, 'eligible', false, 'superseded', true);
  end if;

  -- FIRST RUN rule: if no edge for this connection was last seen by a DIFFERENT run, this is the first complete promotion -> stale ZERO.
  if not exists (
    select 1 from public.directory_group_memberships m
     where m.tenant_id = p_tenant_id and m.connection_id = v_connector_id and m.provider = 'okta'
       and m.last_discovery_run_id is distinct from p_run_id
  ) then
    return jsonb_build_object('staleMarked', 0, 'absentCount', 0, 'priorCurrent', 0, 'circuitBreakerTriggered', false, 'eligible', true, 'firstRun', true);
  end if;

  select count(*) filter (where m.sync_status = 'current'),
         count(*) filter (where m.sync_status = 'current' and m.last_discovery_run_id is distinct from p_run_id)
    into v_prior_current, v_absent
    from public.directory_group_memberships m
   where m.tenant_id = p_tenant_id and m.connection_id = v_connector_id and m.provider = 'okta';

  select p.stale_percent_threshold, p.stale_absolute_threshold into v_pct_threshold, v_abs_threshold
    from public.connector_discovery_policy p where p.provider = 'okta';
  v_pct_threshold := coalesce(v_pct_threshold, 30);
  v_abs_threshold := coalesce(v_abs_threshold, 100);
  v_absent_pct := case when v_prior_current > 0 then (v_absent::numeric * 100.0 / v_prior_current) else 0 end;

  if v_absent > v_abs_threshold or v_absent_pct > v_pct_threshold then
    update public.connector_run_discovery set review_required = true where run_id = p_run_id;
    return jsonb_build_object('staleMarked', 0, 'absentCount', v_absent, 'priorCurrent', v_prior_current, 'absentPct', round(v_absent_pct, 2), 'circuitBreakerTriggered', true, 'eligible', true);
  end if;

  update public.directory_group_memberships m
     set sync_status = 'stale', stale_since = now(), updated_at = now()
   where m.tenant_id = p_tenant_id and m.connection_id = v_connector_id and m.provider = 'okta'
     and m.sync_status = 'current' and m.last_discovery_run_id is distinct from p_run_id;
  get diagnostics v_marked = row_count;
  return jsonb_build_object('staleMarked', v_marked, 'absentCount', v_absent, 'priorCurrent', v_prior_current, 'circuitBreakerTriggered', false, 'eligible', true);
end;
$$;

-- ══ F. least privilege (0045/0053/0054 hosted form: revoke from public + anon + authenticated; grant only to connector_runner). ═════
revoke execute on function public.runner_promote_okta_directory_group_memberships(uuid, uuid) from public, anon, authenticated;
revoke execute on function public.runner_mark_absent_okta_directory_group_memberships_stale(uuid, uuid) from public, anon, authenticated;
grant execute on function public.runner_promote_okta_directory_group_memberships(uuid, uuid) to connector_runner;
grant execute on function public.runner_mark_absent_okta_directory_group_memberships_stale(uuid, uuid) to connector_runner;
-- runner_insert_discovery_fact keeps its existing grant (CREATE OR REPLACE preserves privileges); re-assert least privilege.
revoke execute on function public.runner_insert_discovery_fact(uuid, uuid, text, text, text, text, text, timestamptz, numeric, jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.runner_insert_discovery_fact(uuid, uuid, text, text, text, text, text, timestamptz, numeric, jsonb, jsonb) to connector_runner;

-- The edge table is runner-internal: reachable ONLY through the SECURITY DEFINER functions. Deny every request role + the runner
-- direct access (RLS enabled with no policy; revoke belt-and-suspenders since connector_runner is BYPASSRLS). A future authorized UI
-- members-read SELECT policy + grant would be added when a reviewed consumer exists — deferred.
revoke all on public.directory_group_memberships from public, anon, authenticated, connector_runner;

commit;
