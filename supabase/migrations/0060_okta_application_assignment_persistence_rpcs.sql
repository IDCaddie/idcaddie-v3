-- 0060_okta_application_assignment_persistence_rpcs.sql
--
-- Phase 12 (Migration B) — the write boundary for the two 0059 application-assignment edges. All ADDITIVE (CREATE OR REPLACE FUNCTION /
-- GRANT / REVOKE only). (C) adds the two assignment fact_types + minimal positive-key allowlists to runner_insert_discovery_fact
-- (carrying ALL prior types verbatim); (D/D2) two complete-run-only promotion RPCs (facts -> the two edges) each with DUAL-ENDPOINT
-- in-DB resolution that FAILS CLOSED (counts only) if any endpoint does not resolve to a unique canonical row — no dangling edge can
-- persist (the 0056 pattern, endpoint retargeted app<->identity and app<->group); (E/E2) two stale RPCs (the 0056 evidence-based ladder
-- + circuit breaker over each edge). All granted ONLY to connector_runner; NO direct table write grant. Keeps connection_state =
-- discovered (no advance). Does NOT compute effective access, infer inheritance, expand memberships, or touch apps / app_products /
-- app_aliases / app_users / identity_accounts / directory_groups / directory_applications / memberships. Staging only; RISK-007 OPEN.
--
-- METRICS NOTE: a Phase-12 assignment run emits BOTH fact types, so BOTH promote RPCs run against the SAME run's
-- connector_run_discovery row. To avoid one clobbering the other's facts_inserted/facts_updated (and because a single aggregate column
-- is ambiguous across two edge types), the assignment promotes DO NOT write those columns — the authoritative per-type counts are the
-- returned jsonb (captured by the runner). Nothing gates on connector_run_discovery.facts_inserted for assignment runs.

begin;

-- ══ C. add 'application_user_assignment' + 'application_group_assignment' fact_types + minimal positive-key allowlists ════════════════
-- CREATE OR REPLACE with the SAME 11-arg signature preserves the grant. ALL prior fact types + positive-key blocks (identity_account /
-- directory_group / directory_group_membership / directory_application) are carried forward VERBATIM from 0057.
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
  -- fact_type allowlist — app_user_account/group (Phase 2) + identity_account (Phase 4) + directory_group (Phase 6) +
  -- directory_group_membership (Phase 8) + directory_application (Phase 10) + the two application-assignment edges (Phase 12).
  if p_fact_type not in ('app_user_account', 'group', 'identity_account', 'directory_group', 'directory_group_membership',
                         'directory_application', 'application_user_assignment', 'application_group_assignment') then
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
  -- directory_group_membership: MINIMAL positive key ALLOWLIST (from 0056) — unchanged.
  if p_fact_type = 'directory_group_membership' and exists (
    select 1 from jsonb_object_keys(p_fact_json) k
     where k not in ('fact_type','connection_id','group_external_id','user_external_id')
  ) then
    raise exception 'directory_group_membership fact_json contains a non-approved key';
  end if;
  -- directory_application: POSITIVE top-level key ALLOWLIST (from 0057) — unchanged.
  if p_fact_type = 'directory_application' and exists (
    select 1 from jsonb_object_keys(p_fact_json) k
     where k not in ('fact_type','external_id','connection_id','name','normalized_name','label','status_category','sign_on_category',
                     'provider_created_at','provider_last_updated_at')
  ) then
    raise exception 'directory_application fact_json contains a non-approved key';
  end if;
  -- application_user_assignment: MINIMAL positive key ALLOWLIST — ONLY the immutable relationship evidence (app id + user id). Deliberately
  -- EXCLUDES any app label / user login / email / display_name / scope / status / assignment id / _links / _embedded / credentials / raw
  -- payload (source_endpoint + *_version live in provenance_json).
  if p_fact_type = 'application_user_assignment' and exists (
    select 1 from jsonb_object_keys(p_fact_json) k
     where k not in ('fact_type','connection_id','application_external_id','user_external_id')
  ) then
    raise exception 'application_user_assignment fact_json contains a non-approved key';
  end if;
  -- application_group_assignment: MINIMAL positive key ALLOWLIST — ONLY the immutable relationship evidence (app id + group id). Same
  -- exclusions as above (no group name / priority / _links / _embedded / raw payload).
  if p_fact_type = 'application_group_assignment' and exists (
    select 1 from jsonb_object_keys(p_fact_json) k
     where k not in ('fact_type','connection_id','application_external_id','group_external_id')
  ) then
    raise exception 'application_group_assignment fact_json contains a non-approved key';
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

-- ══ D. PROMOTION: application_user_assignment facts -> directory_application_user_assignments, ONLY after a complete+clean run, with
-- DUAL-ENDPOINT in-DB resolution (application + identity) that FAILS CLOSED if any endpoint is unresolved. ═══════════════════════════
create or replace function public.runner_promote_okta_application_user_assignments(p_run_id uuid, p_tenant_id uuid)
  returns jsonb
  language plpgsql security definer set search_path = ''
as $$
declare
  v_connector_id uuid;
  v_complete boolean; v_rejected integer; v_termination text; v_review boolean;
  v_unresolved_apps integer := 0; v_unresolved_identities integer := 0;
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

  -- DUAL-ENDPOINT RESOLUTION (counts only): every distinct (app_ext, user_ext) fact for THIS run+connection must resolve to a UNIQUE
  -- canonical application AND identity for this exact tenant+connection+provider. Unresolved -> FAIL CLOSED (roll back the whole promotion).
  select count(*) filter (where da.id is null), count(*) filter (where ia.id is null)
    into v_unresolved_apps, v_unresolved_identities
    from (
      select distinct on (f.fact_json ->> 'application_external_id', f.fact_json ->> 'user_external_id')
             f.fact_json ->> 'application_external_id' as aext, f.fact_json ->> 'user_external_id' as uext
        from public.discovery_facts f
       where f.source_run_id = p_run_id and f.tenant_id = p_tenant_id and f.source_provider = 'okta'
         and f.fact_type = 'application_user_assignment'
         and f.fact_json ->> 'application_external_id' is not null and f.fact_json ->> 'user_external_id' is not null
         and (f.fact_json ->> 'connection_id') is not distinct from v_connector_id::text
       order by f.fact_json ->> 'application_external_id', f.fact_json ->> 'user_external_id'
    ) s
    left join public.directory_applications da on da.tenant_id = p_tenant_id and da.connection_id = v_connector_id and da.provider = 'okta' and da.external_id = s.aext
    left join public.identity_accounts ia on ia.tenant_id = p_tenant_id and ia.connection_id = v_connector_id and ia.provider = 'okta' and ia.external_id = s.uext;
  if coalesce(v_unresolved_apps, 0) > 0 or coalesce(v_unresolved_identities, 0) > 0 then
    raise exception 'run % has unresolved user-assignment endpoints (unresolvedApps=%, unresolvedIdentities=%); refusing to promote', p_run_id, v_unresolved_apps, v_unresolved_identities;
  end if;

  -- upsert edges (all endpoints now provably resolve). first_seen preserved; last_seen advanced; sync_status current; stale cleared.
  with existing as (
    select a.directory_application_id as ap, a.identity_account_id as i from public.directory_application_user_assignments a
     where a.tenant_id = p_tenant_id and a.connection_id = v_connector_id and a.provider = 'okta'
  ),
  src as (
    select distinct on (f.fact_json ->> 'application_external_id', f.fact_json ->> 'user_external_id')
           f.fact_json ->> 'application_external_id' as aext, f.fact_json ->> 'user_external_id' as uext, f.provenance_json as p
      from public.discovery_facts f
     where f.source_run_id = p_run_id and f.tenant_id = p_tenant_id and f.source_provider = 'okta'
       and f.fact_type = 'application_user_assignment'
       and f.fact_json ->> 'application_external_id' is not null and f.fact_json ->> 'user_external_id' is not null
       and (f.fact_json ->> 'connection_id') is not distinct from v_connector_id::text
     order by f.fact_json ->> 'application_external_id', f.fact_json ->> 'user_external_id', f.observed_at desc
  ),
  resolved as (
    select da.id as da_id, ia.id as ia_id, s.p as p from src s
      join public.directory_applications da on da.tenant_id = p_tenant_id and da.connection_id = v_connector_id and da.provider = 'okta' and da.external_id = s.aext
      join public.identity_accounts ia on ia.tenant_id = p_tenant_id and ia.connection_id = v_connector_id and ia.provider = 'okta' and ia.external_id = s.uext
  ),
  upserted as (
    insert into public.directory_application_user_assignments (
      tenant_id, connection_id, provider, directory_application_id, identity_account_id,
      first_seen_at, last_seen_at, sync_status, last_discovery_run_id,
      schema_version, sanitizer_version, normalizer_version, source_endpoint, created_at, updated_at
    )
    select p_tenant_id, v_connector_id, 'okta', r.da_id, r.ia_id,
           now(), now(), 'current', p_run_id,
           r.p ->> 'schema_version', r.p ->> 'sanitizer_version', r.p ->> 'normalizer_version', r.p ->> 'source_endpoint', now(), now()
      from resolved r
    on conflict (tenant_id, connection_id, provider, directory_application_id, identity_account_id)
    do update set last_seen_at = now(), sync_status = 'current', last_discovery_run_id = p_run_id, stale_since = null,
                  schema_version = excluded.schema_version, sanitizer_version = excluded.sanitizer_version,
                  normalizer_version = excluded.normalizer_version, source_endpoint = excluded.source_endpoint, updated_at = now()
      -- first_seen_at intentionally NOT updated (preserved); there is no raw_payload column.
    returning directory_application_id as ap, identity_account_id as i
  )
  select count(*) filter (where not exists (select 1 from existing e where e.ap = u.ap and e.i = u.i)),
         count(*) filter (where exists (select 1 from existing e where e.ap = u.ap and e.i = u.i))
    into v_created, v_updated from upserted u;

  -- NOTE: connector_run_discovery.facts_inserted/facts_updated intentionally NOT written here (two fact types share this run's row; the
  -- group-assignment promote would clobber it). Authoritative counts are returned below.
  return jsonb_build_object('userAssignmentsCreated', v_created, 'userAssignmentsUpdated', v_updated);
end;
$$;

-- ══ D2. PROMOTION: application_group_assignment facts -> directory_application_group_assignments (DUAL-ENDPOINT app + group). ═════════
create or replace function public.runner_promote_okta_application_group_assignments(p_run_id uuid, p_tenant_id uuid)
  returns jsonb
  language plpgsql security definer set search_path = ''
as $$
declare
  v_connector_id uuid;
  v_complete boolean; v_rejected integer; v_termination text; v_review boolean;
  v_unresolved_apps integer := 0; v_unresolved_groups integer := 0;
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

  if exists (
    select 1 from public.connector_runs r2 join public.connector_run_discovery d2 on d2.run_id = r2.id
     where r2.connector_id = v_connector_id and r2.tenant_id = p_tenant_id and r2.id <> p_run_id
       and d2.completeness is true and d2.termination_reason = 'last_page'
       and r2.started_at > (select started_at from public.connector_runs where id = p_run_id)
  ) then
    raise exception 'run % is superseded by a later complete run; refusing to promote', p_run_id;
  end if;

  -- DUAL-ENDPOINT RESOLUTION (counts only): app_ext -> directory_applications, group_ext -> directory_groups. Unresolved -> FAIL CLOSED.
  select count(*) filter (where da.id is null), count(*) filter (where dg.id is null)
    into v_unresolved_apps, v_unresolved_groups
    from (
      select distinct on (f.fact_json ->> 'application_external_id', f.fact_json ->> 'group_external_id')
             f.fact_json ->> 'application_external_id' as aext, f.fact_json ->> 'group_external_id' as gext
        from public.discovery_facts f
       where f.source_run_id = p_run_id and f.tenant_id = p_tenant_id and f.source_provider = 'okta'
         and f.fact_type = 'application_group_assignment'
         and f.fact_json ->> 'application_external_id' is not null and f.fact_json ->> 'group_external_id' is not null
         and (f.fact_json ->> 'connection_id') is not distinct from v_connector_id::text
       order by f.fact_json ->> 'application_external_id', f.fact_json ->> 'group_external_id'
    ) s
    left join public.directory_applications da on da.tenant_id = p_tenant_id and da.connection_id = v_connector_id and da.provider = 'okta' and da.external_id = s.aext
    left join public.directory_groups dg on dg.tenant_id = p_tenant_id and dg.connection_id = v_connector_id and dg.provider = 'okta' and dg.external_id = s.gext;
  if coalesce(v_unresolved_apps, 0) > 0 or coalesce(v_unresolved_groups, 0) > 0 then
    raise exception 'run % has unresolved group-assignment endpoints (unresolvedApps=%, unresolvedGroups=%); refusing to promote', p_run_id, v_unresolved_apps, v_unresolved_groups;
  end if;

  with existing as (
    select a.directory_application_id as ap, a.directory_group_id as g from public.directory_application_group_assignments a
     where a.tenant_id = p_tenant_id and a.connection_id = v_connector_id and a.provider = 'okta'
  ),
  src as (
    select distinct on (f.fact_json ->> 'application_external_id', f.fact_json ->> 'group_external_id')
           f.fact_json ->> 'application_external_id' as aext, f.fact_json ->> 'group_external_id' as gext, f.provenance_json as p
      from public.discovery_facts f
     where f.source_run_id = p_run_id and f.tenant_id = p_tenant_id and f.source_provider = 'okta'
       and f.fact_type = 'application_group_assignment'
       and f.fact_json ->> 'application_external_id' is not null and f.fact_json ->> 'group_external_id' is not null
       and (f.fact_json ->> 'connection_id') is not distinct from v_connector_id::text
     order by f.fact_json ->> 'application_external_id', f.fact_json ->> 'group_external_id', f.observed_at desc
  ),
  resolved as (
    select da.id as da_id, dg.id as dg_id, s.p as p from src s
      join public.directory_applications da on da.tenant_id = p_tenant_id and da.connection_id = v_connector_id and da.provider = 'okta' and da.external_id = s.aext
      join public.directory_groups dg on dg.tenant_id = p_tenant_id and dg.connection_id = v_connector_id and dg.provider = 'okta' and dg.external_id = s.gext
  ),
  upserted as (
    insert into public.directory_application_group_assignments (
      tenant_id, connection_id, provider, directory_application_id, directory_group_id,
      first_seen_at, last_seen_at, sync_status, last_discovery_run_id,
      schema_version, sanitizer_version, normalizer_version, source_endpoint, created_at, updated_at
    )
    select p_tenant_id, v_connector_id, 'okta', r.da_id, r.dg_id,
           now(), now(), 'current', p_run_id,
           r.p ->> 'schema_version', r.p ->> 'sanitizer_version', r.p ->> 'normalizer_version', r.p ->> 'source_endpoint', now(), now()
      from resolved r
    on conflict (tenant_id, connection_id, provider, directory_application_id, directory_group_id)
    do update set last_seen_at = now(), sync_status = 'current', last_discovery_run_id = p_run_id, stale_since = null,
                  schema_version = excluded.schema_version, sanitizer_version = excluded.sanitizer_version,
                  normalizer_version = excluded.normalizer_version, source_endpoint = excluded.source_endpoint, updated_at = now()
    returning directory_application_id as ap, directory_group_id as g
  )
  select count(*) filter (where not exists (select 1 from existing e where e.ap = u.ap and e.g = u.g)),
         count(*) filter (where exists (select 1 from existing e where e.ap = u.ap and e.g = u.g))
    into v_created, v_updated from upserted u;

  return jsonb_build_object('groupAssignmentsCreated', v_created, 'groupAssignmentsUpdated', v_updated);
end;
$$;

-- ══ E. STALE: user-assignment edges — evidence-based eligibility + circuit breaker. First run stales ZERO. ════════════════════════════
create or replace function public.runner_mark_absent_okta_application_user_assignments_stale(p_run_id uuid, p_tenant_id uuid)
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

  -- FIRST RUN rule: if no user-assignment edge was last seen by a DIFFERENT run, this is the first complete promotion -> stale ZERO.
  if not exists (
    select 1 from public.directory_application_user_assignments a
     where a.tenant_id = p_tenant_id and a.connection_id = v_connector_id and a.provider = 'okta'
       and a.last_discovery_run_id is distinct from p_run_id
  ) then
    return jsonb_build_object('staleMarked', 0, 'absentCount', 0, 'priorCurrent', 0, 'circuitBreakerTriggered', false, 'eligible', true, 'firstRun', true);
  end if;

  select count(*) filter (where a.sync_status = 'current'),
         count(*) filter (where a.sync_status = 'current' and a.last_discovery_run_id is distinct from p_run_id)
    into v_prior_current, v_absent
    from public.directory_application_user_assignments a
   where a.tenant_id = p_tenant_id and a.connection_id = v_connector_id and a.provider = 'okta';

  select p.stale_percent_threshold, p.stale_absolute_threshold into v_pct_threshold, v_abs_threshold
    from public.connector_discovery_policy p where p.provider = 'okta';
  v_pct_threshold := coalesce(v_pct_threshold, 30);
  v_abs_threshold := coalesce(v_abs_threshold, 100);
  v_absent_pct := case when v_prior_current > 0 then (v_absent::numeric * 100.0 / v_prior_current) else 0 end;

  if v_absent > v_abs_threshold or v_absent_pct > v_pct_threshold then
    update public.connector_run_discovery set review_required = true where run_id = p_run_id;
    return jsonb_build_object('staleMarked', 0, 'absentCount', v_absent, 'priorCurrent', v_prior_current, 'absentPct', round(v_absent_pct, 2), 'circuitBreakerTriggered', true, 'eligible', true);
  end if;

  update public.directory_application_user_assignments a
     set sync_status = 'stale', stale_since = now(), updated_at = now()
   where a.tenant_id = p_tenant_id and a.connection_id = v_connector_id and a.provider = 'okta'
     and a.sync_status = 'current' and a.last_discovery_run_id is distinct from p_run_id;
  get diagnostics v_marked = row_count;
  return jsonb_build_object('staleMarked', v_marked, 'absentCount', v_absent, 'priorCurrent', v_prior_current, 'circuitBreakerTriggered', false, 'eligible', true);
end;
$$;

-- ══ E2. STALE: group-assignment edges (identical ladder over the group edge). ═══════════════════════════════════════════════════════
create or replace function public.runner_mark_absent_okta_application_group_assignments_stale(p_run_id uuid, p_tenant_id uuid)
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

  if not exists (
    select 1 from public.directory_application_group_assignments a
     where a.tenant_id = p_tenant_id and a.connection_id = v_connector_id and a.provider = 'okta'
       and a.last_discovery_run_id is distinct from p_run_id
  ) then
    return jsonb_build_object('staleMarked', 0, 'absentCount', 0, 'priorCurrent', 0, 'circuitBreakerTriggered', false, 'eligible', true, 'firstRun', true);
  end if;

  select count(*) filter (where a.sync_status = 'current'),
         count(*) filter (where a.sync_status = 'current' and a.last_discovery_run_id is distinct from p_run_id)
    into v_prior_current, v_absent
    from public.directory_application_group_assignments a
   where a.tenant_id = p_tenant_id and a.connection_id = v_connector_id and a.provider = 'okta';

  select p.stale_percent_threshold, p.stale_absolute_threshold into v_pct_threshold, v_abs_threshold
    from public.connector_discovery_policy p where p.provider = 'okta';
  v_pct_threshold := coalesce(v_pct_threshold, 30);
  v_abs_threshold := coalesce(v_abs_threshold, 100);
  v_absent_pct := case when v_prior_current > 0 then (v_absent::numeric * 100.0 / v_prior_current) else 0 end;

  if v_absent > v_abs_threshold or v_absent_pct > v_pct_threshold then
    update public.connector_run_discovery set review_required = true where run_id = p_run_id;
    return jsonb_build_object('staleMarked', 0, 'absentCount', v_absent, 'priorCurrent', v_prior_current, 'absentPct', round(v_absent_pct, 2), 'circuitBreakerTriggered', true, 'eligible', true);
  end if;

  update public.directory_application_group_assignments a
     set sync_status = 'stale', stale_since = now(), updated_at = now()
   where a.tenant_id = p_tenant_id and a.connection_id = v_connector_id and a.provider = 'okta'
     and a.sync_status = 'current' and a.last_discovery_run_id is distinct from p_run_id;
  get diagnostics v_marked = row_count;
  return jsonb_build_object('staleMarked', v_marked, 'absentCount', v_absent, 'priorCurrent', v_prior_current, 'circuitBreakerTriggered', false, 'eligible', true);
end;
$$;

-- ══ F. least privilege (revoke from public + anon + authenticated; grant only to connector_runner) ═══════════════════════════════════
revoke execute on function public.runner_promote_okta_application_user_assignments(uuid, uuid) from public, anon, authenticated;
revoke execute on function public.runner_promote_okta_application_group_assignments(uuid, uuid) from public, anon, authenticated;
revoke execute on function public.runner_mark_absent_okta_application_user_assignments_stale(uuid, uuid) from public, anon, authenticated;
revoke execute on function public.runner_mark_absent_okta_application_group_assignments_stale(uuid, uuid) from public, anon, authenticated;
grant execute on function public.runner_promote_okta_application_user_assignments(uuid, uuid) to connector_runner;
grant execute on function public.runner_promote_okta_application_group_assignments(uuid, uuid) to connector_runner;
grant execute on function public.runner_mark_absent_okta_application_user_assignments_stale(uuid, uuid) to connector_runner;
grant execute on function public.runner_mark_absent_okta_application_group_assignments_stale(uuid, uuid) to connector_runner;
-- runner_insert_discovery_fact keeps its existing grant (CREATE OR REPLACE preserves privileges); re-assert least privilege.
revoke execute on function public.runner_insert_discovery_fact(uuid, uuid, text, text, text, text, text, timestamptz, numeric, jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.runner_insert_discovery_fact(uuid, uuid, text, text, text, text, text, timestamptz, numeric, jsonb, jsonb) to connector_runner;

commit;
