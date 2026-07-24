-- 0054_okta_directory_group_persistence.sql
--
-- Phase 6 (Okta directory GROUP discovery) — the durable, tenant- and connection-scoped group persistence model, built as the
-- structural analogue of 0053 (which did this for directory IDENTITIES). Per the approved design: the canonical Okta DIRECTORY GROUP
-- store is a NEW provider-neutral table public.directory_groups (NOT apps / app_users / identity_accounts / any assignment table — a
-- directory group is a distinct object class from a per-app usergroup or a directory identity). This migration (all ADDITIVE):
-- (A) creates directory_groups with connection/freshness/provenance columns, a sync_status enum, the immutable-identity unique key
-- (tenant_id, connection_id, provider, external_id) + a same-tenant composite FK to connectors; (B) REUSES the 0053 per-run metrics
-- companion (connector_run_discovery), its recorder RPC, and the stale-policy config (connector_discovery_policy) unchanged — a group
-- run is a SEPARATE connector_run, distinguished by the fact_type it produces; (C) adds a semantically-correct 'directory_group'
-- fact_type + a positive-key allowlist to the write boundary (0041/0053); (D) a complete-run-only promotion RPC facts ->
-- directory_groups; (E) a stale RPC with evidence-based eligibility + a configurable mass-staleness circuit breaker. All runner writes
-- go through SECURITY DEFINER functions (fixed empty search_path, schema-qualified) granted ONLY to connector_runner; NO direct table
-- write grant is added. There is NO raw_payload column at all (0053 never populated its one; omitting it here is stronger).
--
-- IMMUTABLE IDENTITY = external_id (the Okta 00g... group id). name/description are MUTABLE optional attributes (a rename is an
-- attribute update on upsert), NEVER a uniqueness key. NO MEMBERSHIPS: no member table, no member_count, no lastMembershipUpdated
-- column, and 'group_membership' is deliberately absent from the fact_type allowlist — keeping the write path closed is what enforces
-- "no memberships". NON-DESTRUCTIVE: CREATE TABLE|INDEX|FUNCTION / ALTER TABLE ADD CONSTRAINT / GRANT|REVOKE only — no table teardown,
-- no column drop, no row purge, no data mutation. This migration ACTIVATES nothing (no run happens here). Staging only; RISK-007 OPEN;
-- Phase C BLOCKED; no schedule, no active, no registry.

begin;

-- ══ A. CREATE directory_groups (the canonical, provider-neutral Okta directory GROUP store) ═════════════════════════════
create table if not exists public.directory_groups (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  connection_id uuid not null,
  provider text not null,
  external_id text not null,                                 -- Okta group id (00g...) — immutable provider identity
  name text,                                                 -- profile.name — MUTABLE (rename = attribute update)
  normalized_name text,
  description text,                                           -- profile.description — MUTABLE, optional
  group_type_category text,                                  -- SAFE bounded category (never the raw provider type value)
  provider_created_at timestamptz,
  provider_last_updated_at timestamptz,
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
  -- sync_status vocabulary (mirrors identity_accounts, 0053): current = seen in the latest complete run; stale = absent from a
  -- complete run; review_required = circuit breaker fired; disconnected = connection disconnected (future).
  constraint directory_groups_sync_status_chk check (sync_status in ('current', 'stale', 'review_required', 'disconnected')),
  -- group_type_category is a fixed SAFE aggregate bucket (categorizeOktaGroupType), never a customer-created group name-as-type.
  constraint directory_groups_type_category_chk check (group_type_category in ('okta_group', 'app_group', 'built_in', 'other')),
  -- Same-tenant connection binding: (connection_id, tenant_id) -> connectors(id, tenant_id). Greenfield: connection_id is NOT NULL
  -- (every group is always connection-bound — stronger than identity_accounts which kept it nullable for legacy rows).
  constraint directory_groups_connection_same_tenant
    foreign key (connection_id, tenant_id) references public.connectors (id, tenant_id) on delete cascade
);

-- Immutable provider identity: unique per (tenant, connection, provider, external_id). name is NEVER part of the key. The partial
-- predicate is kept (though both cols are NOT NULL) so the promotion RPC's ON CONFLICT target is byte-for-byte the proven 0053 shape.
create unique index if not exists directory_groups_provider_identity_idx
  on public.directory_groups (tenant_id, connection_id, provider, external_id)
  where connection_id is not null and external_id is not null;
create index if not exists directory_groups_connection_idx on public.directory_groups (tenant_id, connection_id);
create index if not exists directory_groups_sync_status_idx on public.directory_groups (tenant_id, connection_id, sync_status);

alter table public.directory_groups enable row level security; -- deny-all to anon/authenticated; only SECURITY DEFINER reads/writes

-- ══ B. per-run metrics + stale policy — REUSED from 0053, NOT re-created ════════════════════════════════════════════════
-- connector_run_discovery (1:1 per connector_run), runner_record_okta_discovery_metrics(...), and connector_discovery_policy already
-- exist (0053) and are provider-scoped on the run (they assert provider='okta'), not object-scoped. A group run is a SEPARATE
-- connector_run and gets its OWN metrics row keyed by run_id, so promotion/stale (which scope by run_id + fact_type) never contaminate
-- the user lifecycle. No new metrics table, no new policy row, no discovery_object column needed (run_id + fact_type disambiguate).

-- ══ C. add the 'directory_group' fact_type + positive-key allowlist to the write boundary (0041/0053) ═══════════════════
-- CREATE OR REPLACE with the SAME 11-arg signature preserves the existing grant; the allowlist gains 'directory_group'.
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
  -- fact_type allowlist — Phase 2 (app_user_account, group) + Phase 4 directory identity (identity_account) + Phase 6 directory group.
  -- NOTE: 'group_membership' is deliberately ABSENT — the no-memberships guarantee is enforced by keeping it out of this allowlist.
  if p_fact_type not in ('app_user_account', 'group', 'identity_account', 'directory_group') then
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
  -- directory_group: POSITIVE top-level key ALLOWLIST — ONLY approved directory-group fields may be staged. Deliberately EXCLUDES
  -- any membership field (member_count, last_membership_updated), _links/_embedded, app_id_hint/app_instance_key (directory groups
  -- are NOT app-scoped), and the raw provider type (only the safe categorized bucket is allowed).
  if p_fact_type = 'directory_group' and exists (
    select 1 from jsonb_object_keys(p_fact_json) k
     where k not in ('fact_type','external_id','connection_id','name','normalized_name','description','group_type_category',
                     'provider_created_at','provider_last_updated_at')
  ) then
    raise exception 'directory_group fact_json contains a non-approved key';
  end if;
  -- recursive forbidden-key scan (keys only; a value like a group name never trips it).
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
  -- REFRESH on re-observation (mirrors 0053): keep ONE fact per (tenant,provider,fact_type,signal_id) pointing at the LATEST run.
  on conflict (tenant_id, source_provider, fact_type, signal_id) where signal_id is not null
  do update set source_run_id = excluded.source_run_id, fact_json = excluded.fact_json,
                provenance_json = excluded.provenance_json, observed_at = excluded.observed_at,
                natural_key = excluded.natural_key, confidence = excluded.confidence;
end;
$$;

-- ══ D. PROMOTION: facts -> directory_groups, ONLY after a complete + clean run. Derives tenant/connection from the run. ══
create or replace function public.runner_promote_okta_directory_groups(p_run_id uuid, p_tenant_id uuid)
  returns jsonb
  language plpgsql security definer set search_path = ''
as $$
declare
  v_connector_id uuid;
  v_complete boolean; v_rejected integer; v_termination text; v_review boolean;
  v_created integer := 0; v_updated integer := 0;
begin
  -- resolve run -> tenant -> connection; provider must be okta.
  select r.connector_id into v_connector_id
    from public.connector_runs r where r.id = p_run_id and r.tenant_id = p_tenant_id;
  if not found then raise exception 'run % does not belong to tenant %', p_run_id, p_tenant_id; end if;
  if not exists (select 1 from public.connectors c where c.id = v_connector_id and c.tenant_id = p_tenant_id and c.provider = 'okta') then
    raise exception 'connector for run % is not an okta connection', p_run_id;
  end if;

  -- complete-run proof: metrics must exist and prove a full, clean read (no rejects, terminated on last_page, not flagged).
  select d.completeness, d.records_rejected, d.termination_reason, d.review_required
    into v_complete, v_rejected, v_termination, v_review
    from public.connector_run_discovery d where d.run_id = p_run_id and d.tenant_id = p_tenant_id;
  if not found then raise exception 'run % has no recorded discovery metrics; cannot promote', p_run_id; end if;
  if v_complete is not true or coalesce(v_rejected, 1) <> 0 or v_termination is distinct from 'last_page' or v_review is true then
    raise exception 'run % is not eligible for promotion (complete=%, rejected=%, termination=%, review=%)', p_run_id, v_complete, v_rejected, v_termination, v_review;
  end if;

  -- latest-run guard: never (re)promote a SUPERSEDED run. Reject if a DIFFERENT complete run for this connection started later.
  if exists (
    select 1 from public.connector_runs r2 join public.connector_run_discovery d2 on d2.run_id = r2.id
     where r2.connector_id = v_connector_id and r2.tenant_id = p_tenant_id and r2.id <> p_run_id
       and d2.completeness is true and d2.termination_reason = 'last_page'
       and r2.started_at > (select started_at from public.connector_runs where id = p_run_id)
  ) then
    raise exception 'run % is superseded by a later complete run; refusing to promote', p_run_id;
  end if;

  -- upsert directory_groups from THIS run's directory_group facts. connection_id is server-derived (v_connector_id), not trusted from
  -- fact_json; a fact is additionally required to CARRY the matching connection_id (defense vs a cross-connection signal_id collision)
  -- and DISTINCT-ON external_id (defense vs a duplicate). first_seen preserved; last_seen advanced; sync_status=current; no raw_payload.
  with existing as (
    select dg.external_id as ext from public.directory_groups dg
     where dg.tenant_id = p_tenant_id and dg.connection_id = v_connector_id and dg.provider = 'okta' and dg.external_id is not null
  ),
  src as (
    select distinct on (f.fact_json ->> 'external_id') f.fact_json as j, f.provenance_json as p
      from public.discovery_facts f
     where f.source_run_id = p_run_id and f.tenant_id = p_tenant_id
       and f.source_provider = 'okta' and f.fact_type = 'directory_group'
       and f.fact_json ->> 'external_id' is not null
       and (f.fact_json ->> 'connection_id') is not distinct from v_connector_id::text  -- fact must belong to THIS connection
     order by f.fact_json ->> 'external_id', f.observed_at desc
  ),
  upserted as (
    insert into public.directory_groups (
      tenant_id, connection_id, provider, external_id,
      name, normalized_name, description, group_type_category,
      provider_created_at, provider_last_updated_at,
      first_seen_at, last_seen_at, sync_status, last_discovery_run_id,
      schema_version, sanitizer_version, normalizer_version, source_endpoint, created_at, updated_at
    )
    select
      p_tenant_id, v_connector_id, 'okta', j ->> 'external_id',
      j ->> 'name', j ->> 'normalized_name', j ->> 'description', j ->> 'group_type_category',
      (j ->> 'provider_created_at')::timestamptz, (j ->> 'provider_last_updated_at')::timestamptz,
      now(), now(), 'current', p_run_id,
      p ->> 'schema_version', p ->> 'sanitizer_version', p ->> 'normalizer_version', p ->> 'source_endpoint', now(), now()
    from src
    on conflict (tenant_id, connection_id, provider, external_id) where connection_id is not null and external_id is not null
    do update set
      name = excluded.name, normalized_name = excluded.normalized_name, description = excluded.description,
      group_type_category = excluded.group_type_category,
      provider_created_at = excluded.provider_created_at, provider_last_updated_at = excluded.provider_last_updated_at,
      last_seen_at = now(), sync_status = 'current', last_discovery_run_id = p_run_id,
      schema_version = excluded.schema_version, sanitizer_version = excluded.sanitizer_version,
      normalizer_version = excluded.normalizer_version, source_endpoint = excluded.source_endpoint, updated_at = now()
      -- first_seen_at intentionally NOT updated (preserved); there is no raw_payload column.
    returning external_id as ext
  )
  select count(*) filter (where not exists (select 1 from existing e where e.ext = u.ext)),
         count(*) filter (where exists (select 1 from existing e where e.ext = u.ext))
    into v_created, v_updated
    from upserted u;

  update public.connector_run_discovery set facts_inserted = v_created, facts_updated = v_updated where run_id = p_run_id;
  return jsonb_build_object('groupsCreated', v_created, 'groupsUpdated', v_updated);
end;
$$;

-- ══ E. STALE: evidence-based eligibility + configurable mass-staleness circuit breaker. First run stales ZERO. ═════════
create or replace function public.runner_mark_absent_okta_directory_groups_stale(p_run_id uuid, p_tenant_id uuid)
  returns jsonb
  language plpgsql security definer set search_path = ''
as $$
declare
  v_connector_id uuid;
  v_complete boolean; v_rejected integer; v_termination text; v_review boolean;
  v_prior_current integer; v_absent integer; v_absent_pct numeric;
  v_pct_threshold numeric; v_abs_threshold integer; v_marked integer := 0;
begin
  select r.connector_id into v_connector_id
    from public.connector_runs r where r.id = p_run_id and r.tenant_id = p_tenant_id;
  if not found then raise exception 'run % does not belong to tenant %', p_run_id, p_tenant_id; end if;
  if not exists (select 1 from public.connectors c where c.id = v_connector_id and c.tenant_id = p_tenant_id and c.provider = 'okta') then
    raise exception 'connector for run % is not an okta connection', p_run_id;
  end if;
  -- serialize stale/promote on this connection (TOCTOU guard) — lock the connector row (mirrors advance_state's FOR UPDATE).
  perform 1 from public.connectors c where c.id = v_connector_id and c.tenant_id = p_tenant_id for update;

  -- eligibility: only a complete, clean, last_page, non-quarantined run may EVER stale absent rows.
  select d.completeness, d.records_rejected, d.termination_reason, d.review_required into v_complete, v_rejected, v_termination, v_review
    from public.connector_run_discovery d where d.run_id = p_run_id and d.tenant_id = p_tenant_id;
  if not found or v_complete is not true or coalesce(v_rejected, 1) <> 0 or v_termination is distinct from 'last_page' or v_review is true then
    return jsonb_build_object('staleMarked', 0, 'absentCount', 0, 'priorCurrent', 0, 'circuitBreakerTriggered', false, 'eligible', false);
  end if;

  -- LATEST-RUN guard: only the most-recent complete run for the connection may stale (staling on a superseded run would mass-stale).
  if exists (
    select 1 from public.connector_runs r2 join public.connector_run_discovery d2 on d2.run_id = r2.id
     where r2.connector_id = v_connector_id and r2.tenant_id = p_tenant_id and r2.id <> p_run_id
       and d2.completeness is true and d2.termination_reason = 'last_page'
       and r2.started_at > (select started_at from public.connector_runs where id = p_run_id)
  ) then
    return jsonb_build_object('staleMarked', 0, 'absentCount', 0, 'priorCurrent', 0, 'circuitBreakerTriggered', false, 'eligible', false, 'superseded', true);
  end if;

  -- FIRST RUN rule: if no group for this connection was last seen by a DIFFERENT (earlier) run, this is the first complete promotion
  -- for the connection -> stale ZERO.
  if not exists (
    select 1 from public.directory_groups dg
     where dg.tenant_id = p_tenant_id and dg.connection_id = v_connector_id and dg.provider = 'okta'
       and dg.last_discovery_run_id is distinct from p_run_id
  ) then
    return jsonb_build_object('staleMarked', 0, 'absentCount', 0, 'priorCurrent', 0, 'circuitBreakerTriggered', false, 'eligible', true, 'firstRun', true);
  end if;

  -- absent = currently-'current' rows for this exact connection NOT touched by this run.
  select count(*) filter (where dg.sync_status = 'current'),
         count(*) filter (where dg.sync_status = 'current' and dg.last_discovery_run_id is distinct from p_run_id)
    into v_prior_current, v_absent
    from public.directory_groups dg
   where dg.tenant_id = p_tenant_id and dg.connection_id = v_connector_id and dg.provider = 'okta';

  -- REUSE the shared okta thresholds (provider-keyed policy from 0053); evidence gates are primary, thresholds secondary.
  select p.stale_percent_threshold, p.stale_absolute_threshold into v_pct_threshold, v_abs_threshold
    from public.connector_discovery_policy p where p.provider = 'okta';
  v_pct_threshold := coalesce(v_pct_threshold, 30);
  v_abs_threshold := coalesce(v_abs_threshold, 100);
  v_absent_pct := case when v_prior_current > 0 then (v_absent::numeric * 100.0 / v_prior_current) else 0 end;

  -- circuit breaker: too much would go stale -> mark ZERO, flag review.
  if v_absent > v_abs_threshold or v_absent_pct > v_pct_threshold then
    update public.connector_run_discovery set review_required = true where run_id = p_run_id;
    return jsonb_build_object('staleMarked', 0, 'absentCount', v_absent, 'priorCurrent', v_prior_current, 'absentPct', round(v_absent_pct, 2), 'circuitBreakerTriggered', true, 'eligible', true);
  end if;

  -- below thresholds: mark ONLY absent rows for THIS exact tenant+connection+provider stale. Never hard-delete.
  update public.directory_groups dg
     set sync_status = 'stale', stale_since = now(), updated_at = now()
   where dg.tenant_id = p_tenant_id and dg.connection_id = v_connector_id and dg.provider = 'okta'
     and dg.sync_status = 'current' and dg.last_discovery_run_id is distinct from p_run_id;
  get diagnostics v_marked = row_count;
  return jsonb_build_object('staleMarked', v_marked, 'absentCount', v_absent, 'priorCurrent', v_prior_current, 'circuitBreakerTriggered', false, 'eligible', true);
end;
$$;

-- ══ F. least privilege (0045 hosted-Supabase pattern: revoke from public + anon + authenticated, not public alone) ══════
revoke execute on function public.runner_promote_okta_directory_groups(uuid, uuid) from public, anon, authenticated;
revoke execute on function public.runner_mark_absent_okta_directory_groups_stale(uuid, uuid) from public, anon, authenticated;
grant execute on function public.runner_promote_okta_directory_groups(uuid, uuid) to connector_runner;
grant execute on function public.runner_mark_absent_okta_directory_groups_stale(uuid, uuid) to connector_runner;
-- runner_insert_discovery_fact keeps its existing grant (CREATE OR REPLACE preserves privileges); re-assert least privilege anyway.
revoke execute on function public.runner_insert_discovery_fact(uuid, uuid, text, text, text, text, text, timestamptz, numeric, jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.runner_insert_discovery_fact(uuid, uuid, text, text, text, text, text, timestamptz, numeric, jsonb, jsonb) to connector_runner;

-- directory_groups is runner-internal: reachable ONLY through the SECURITY DEFINER functions. Deny every request role + the runner
-- direct access (RLS is enabled with no policy; revoke belt-and-suspenders since connector_runner is BYPASSRLS). A future authorized
-- UI list view would add a members-read SELECT policy + grant select to authenticated — deferred until such a consumer exists.
revoke all on public.directory_groups from public, anon, authenticated, connector_runner;

commit;
