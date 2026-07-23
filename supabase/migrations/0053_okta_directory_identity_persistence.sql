-- 0053_okta_directory_identity_persistence.sql
--
-- Phase 4 (Okta directory discovery) — the durable, tenant- and connection-scoped persistence model. Per the approved corrected
-- design: the canonical Okta DIRECTORY identity store is identity_accounts (NOT app_users, which is a per-app account table). This
-- migration (all ADDITIVE): (A) extends identity_accounts with connection/freshness/provenance columns, makes email NULLABLE, adds a
-- sync_status enum + the immutable-identity unique key (tenant_id, connection_id, provider, external_id) + a same-tenant composite FK
-- to connectors; (B) adds a per-run discovery-metrics companion + a runner RPC to record it; (C) adds a stale-policy config table
-- with an okta default; (D) adds a semantically-correct 'identity_account' fact_type to the write boundary; (E) a complete-run-only
-- promotion RPC facts -> identity_accounts; (F) a stale RPC with evidence-based eligibility + a configurable mass-staleness circuit
-- breaker. All runner writes go through SECURITY DEFINER functions (fixed empty search_path, schema-qualified) granted ONLY to
-- connector_runner; NO direct table write grant is added. The raw_payload column is NEVER populated by this path.
--
-- IMMUTABLE IDENTITY = external_id. email/login are MUTABLE optional attributes + matching signals only. Provider external ID is the
-- primary provider identity key; email is never a uniqueness key. NON-DESTRUCTIVE: ADD COLUMN / ALTER COLUMN DROP NOT NULL / CREATE
-- TABLE|INDEX|FUNCTION|POLICY / GRANT|REVOKE only — no DROP TABLE, no column drop, no row purge, no data mutation. This migration
-- ACTIVATES nothing (no run happens here). Staging only; RISK-007 OPEN; Phase C BLOCKED; no schedule, no active, no registry.

begin;

-- ══ A. EXTEND identity_accounts (the canonical Okta directory identity store) ═══════════════════════════════════════════
-- email becomes nullable: a valid Okta user may lack profile.email; external_id (the immutable key) + optional login suffice.
alter table public.identity_accounts alter column email drop not null;

alter table public.identity_accounts
  add column if not exists connection_id uuid,
  add column if not exists login text,
  add column if not exists normalized_login text,
  add column if not exists normalized_email text,
  add column if not exists first_name text,
  add column if not exists last_name text,
  add column if not exists display_name text,
  add column if not exists is_active boolean,
  add column if not exists department text,
  add column if not exists title text,
  add column if not exists employee_number text,
  add column if not exists provider_created_at timestamptz,
  add column if not exists provider_activated_at timestamptz,
  add column if not exists provider_last_login_at timestamptz,
  add column if not exists provider_last_updated_at timestamptz,
  add column if not exists provider_status_changed_at timestamptz,
  add column if not exists first_seen_at timestamptz,
  add column if not exists last_seen_at timestamptz,
  add column if not exists stale_since timestamptz,
  add column if not exists sync_status text not null default 'current',
  add column if not exists last_discovery_run_id uuid,
  add column if not exists schema_version text,
  add column if not exists sanitizer_version text,
  add column if not exists normalizer_version text,
  add column if not exists source_endpoint text;

-- sync_status vocabulary. `current` = seen in the latest complete run; `stale` = absent from a complete run; `review_required` =
-- circuit breaker fired; `disconnected` = connection disconnected (future).
alter table public.identity_accounts drop constraint if exists identity_accounts_sync_status_chk;
alter table public.identity_accounts add constraint identity_accounts_sync_status_chk
  check (sync_status in ('current', 'stale', 'review_required', 'disconnected'));

-- Same-tenant connection binding: (connection_id, tenant_id) -> connectors(id, tenant_id). connection_id NULL (legacy rows) passes
-- (MATCH SIMPLE), so this only binds the new provider-scoped rows.
alter table public.identity_accounts drop constraint if exists identity_accounts_connection_same_tenant;
alter table public.identity_accounts add constraint identity_accounts_connection_same_tenant
  foreign key (connection_id, tenant_id) references public.connectors (id, tenant_id) on delete cascade;

-- Immutable provider identity: unique per (tenant, connection, provider, external_id). Partial (only the connection-scoped rows);
-- email is NEVER part of the key. ON CONFLICT in the promotion RPC targets exactly this predicate.
create unique index if not exists identity_accounts_provider_identity_idx
  on public.identity_accounts (tenant_id, connection_id, provider, external_id)
  where connection_id is not null and external_id is not null;
create index if not exists identity_accounts_connection_idx on public.identity_accounts (tenant_id, connection_id);
create index if not exists identity_accounts_sync_status_idx on public.identity_accounts (tenant_id, connection_id, sync_status);

-- ══ B. per-run discovery METRICS companion (1:1 with a connector_run) + a runner RPC to record it ══════════════════════
create table if not exists public.connector_run_discovery (
  run_id uuid primary key references public.connector_runs (id) on delete cascade,
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  connection_id uuid not null,
  provider text not null,
  pages_fetched integer,
  records_seen integer,
  records_distinct integer,
  records_valid integer,
  records_rejected integer,
  facts_inserted integer,
  facts_updated integer,
  termination_reason text,
  completeness boolean not null default false,
  review_required boolean not null default false,
  schema_version text,
  sanitizer_version text,
  normalizer_version text,
  safe_error_category text,
  created_at timestamptz not null default now(),
  constraint connector_run_discovery_conn_same_tenant
    foreign key (connection_id, tenant_id) references public.connectors (id, tenant_id) on delete cascade
);
alter table public.connector_run_discovery enable row level security; -- deny-all to anon/authenticated; only SECURITY DEFINER reads/writes

create or replace function public.runner_record_okta_discovery_metrics(
  p_run_id uuid, p_tenant_id uuid,
  p_pages_fetched integer, p_records_seen integer, p_records_distinct integer, p_records_valid integer, p_records_rejected integer,
  p_termination_reason text, p_completeness boolean,
  p_schema_version text, p_sanitizer_version text, p_normalizer_version text, p_safe_error_category text
) returns void
  language plpgsql security definer set search_path = ''
as $$
declare
  v_connector_id uuid;
begin
  -- run must belong to the tenant; derive the connection from the run (never from caller input).
  select r.connector_id into v_connector_id
    from public.connector_runs r where r.id = p_run_id and r.tenant_id = p_tenant_id;
  if not found then
    raise exception 'run % does not belong to tenant %', p_run_id, p_tenant_id;
  end if;
  -- provider must be okta.
  if not exists (select 1 from public.connectors c where c.id = v_connector_id and c.tenant_id = p_tenant_id and c.provider = 'okta') then
    raise exception 'connector for run % is not an okta connection', p_run_id;
  end if;

  insert into public.connector_run_discovery (
    run_id, tenant_id, connection_id, provider, pages_fetched, records_seen, records_distinct, records_valid, records_rejected,
    termination_reason, completeness, schema_version, sanitizer_version, normalizer_version, safe_error_category
  ) values (
    p_run_id, p_tenant_id, v_connector_id, 'okta', p_pages_fetched, p_records_seen, p_records_distinct, p_records_valid, p_records_rejected,
    p_termination_reason, coalesce(p_completeness, false), p_schema_version, p_sanitizer_version, p_normalizer_version, p_safe_error_category
  )
  on conflict (run_id) do update set
    pages_fetched = excluded.pages_fetched, records_seen = excluded.records_seen, records_distinct = excluded.records_distinct,
    records_valid = excluded.records_valid, records_rejected = excluded.records_rejected,
    termination_reason = excluded.termination_reason, completeness = excluded.completeness,
    schema_version = excluded.schema_version, sanitizer_version = excluded.sanitizer_version,
    normalizer_version = excluded.normalizer_version, safe_error_category = excluded.safe_error_category;
end;
$$;

-- ══ C. stale-policy CONFIG (thresholds are configuration, not hardcoded business logic) ═══════════════════════════════
create table if not exists public.connector_discovery_policy (
  provider text primary key,
  stale_percent_threshold numeric not null default 30,
  stale_absolute_threshold integer not null default 100,
  updated_at timestamptz not null default now(),
  constraint connector_discovery_policy_pct_range check (stale_percent_threshold >= 0 and stale_percent_threshold <= 100),
  constraint connector_discovery_policy_abs_nonneg check (stale_absolute_threshold >= 0)
);
alter table public.connector_discovery_policy enable row level security; -- config: only SECURITY DEFINER reads it
insert into public.connector_discovery_policy (provider) values ('okta') on conflict (provider) do nothing;

-- ══ D. add the semantically-correct 'identity_account' fact_type to the write boundary (0041) ═════════════════════════
-- CREATE OR REPLACE with the SAME signature preserves 0041's grant; only the fact_type allowlist gains 'identity_account'.
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
  -- fact_type allowlist — Phase 2 (app_user_account, group) + Phase 4 directory identity (identity_account).
  if p_fact_type not in ('app_user_account', 'group', 'identity_account') then
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
  -- identity_account: POSITIVE top-level key ALLOWLIST (stronger than the denylist). Only approved directory fields may be staged;
  -- any unknown/unexpected key is rejected so a stray or secret-shaped field can never be persisted into a directory-identity fact.
  if p_fact_type = 'identity_account' and exists (
    select 1 from jsonb_object_keys(p_fact_json) k
     where k not in ('fact_type','external_id','connection_id','login','normalized_login','email','normalized_email',
                     'first_name','last_name','display_name','status','is_active','department','title','employee_number',
                     'provider_created_at','provider_activated_at','provider_last_login_at','provider_last_updated_at','provider_status_changed_at')
  ) then
    raise exception 'identity_account fact_json contains a non-approved key';
  end if;
  -- recursive forbidden-key scan (keys only; a value like a display name never trips it).
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
  -- REFRESH on re-observation (was DO NOTHING in 0041): keep ONE fact per (tenant,provider,fact_type,signal_id) but point it at
  -- the LATEST run and latest attributes, so promotion-by-source_run_id sees every user seen THIS run and attribute changes
  -- propagate. A retried page in the same run is a same-data no-op (still one row); no duplicate is ever created.
  on conflict (tenant_id, source_provider, fact_type, signal_id) where signal_id is not null
  do update set source_run_id = excluded.source_run_id, fact_json = excluded.fact_json,
                provenance_json = excluded.provenance_json, observed_at = excluded.observed_at,
                natural_key = excluded.natural_key, confidence = excluded.confidence;
end;
$$;

-- ══ E. PROMOTION: facts -> identity_accounts, ONLY after a complete + clean run. Derives tenant/connection from the run. ═
create or replace function public.runner_promote_okta_directory_users(p_run_id uuid, p_tenant_id uuid)
  returns jsonb
  language plpgsql security definer set search_path = ''
as $$
declare
  v_connector_id uuid;
  v_complete boolean; v_rejected integer; v_termination text; v_review boolean;
  v_created integer := 0; v_updated integer := 0;
begin
  -- 1-5: resolve run -> tenant -> connection; provider must be okta.
  select r.connector_id into v_connector_id
    from public.connector_runs r where r.id = p_run_id and r.tenant_id = p_tenant_id;
  if not found then raise exception 'run % does not belong to tenant %', p_run_id, p_tenant_id; end if;
  if not exists (select 1 from public.connectors c where c.id = v_connector_id and c.tenant_id = p_tenant_id and c.provider = 'okta') then
    raise exception 'connector for run % is not an okta connection', p_run_id;
  end if;

  -- 6-10: complete-run proof. metrics must exist and prove a full, clean read (no rejects, terminated on last_page, not flagged).
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

  -- 11-19: upsert identity_accounts from THIS run's identity_account facts. connection_id is server-derived (v_connector_id), not
  -- trusted from fact_json; a fact is additionally required to CARRY the matching connection_id (defense vs a cross-connection
  -- signal_id collision) and DISTINCT-ON external_id (defense vs a duplicate). first_seen preserved; last_seen advanced; raw_payload
  -- NEVER set; sync_status=current.
  with existing as (
    -- snapshot of external_ids already promoted for THIS connection (evaluated pre-upsert) -> reliable created-vs-updated split.
    select ia.external_id as ext from public.identity_accounts ia
     where ia.tenant_id = p_tenant_id and ia.connection_id = v_connector_id and ia.provider = 'okta' and ia.external_id is not null
  ),
  src as (
    select distinct on (f.fact_json ->> 'external_id') f.fact_json as j, f.provenance_json as p
      from public.discovery_facts f
     where f.source_run_id = p_run_id and f.tenant_id = p_tenant_id
       and f.source_provider = 'okta' and f.fact_type = 'identity_account'
       and f.fact_json ->> 'external_id' is not null
       and (f.fact_json ->> 'connection_id') is not distinct from v_connector_id::text  -- fact must belong to THIS connection
     order by f.fact_json ->> 'external_id', f.observed_at desc
  ),
  upserted as (
    insert into public.identity_accounts (
      tenant_id, connection_id, provider, external_id,
      login, normalized_login, email, normalized_email, first_name, last_name, display_name, status, is_active,
      department, title, employee_number,
      provider_created_at, provider_activated_at, provider_last_login_at, provider_last_updated_at, provider_status_changed_at,
      first_seen_at, last_seen_at, sync_status, last_discovery_run_id,
      schema_version, sanitizer_version, normalizer_version, source_endpoint, created_at, updated_at
    )
    select
      p_tenant_id, v_connector_id, 'okta', j ->> 'external_id',
      j ->> 'login', j ->> 'normalized_login', j ->> 'email', j ->> 'normalized_email', j ->> 'first_name', j ->> 'last_name',
      j ->> 'display_name', j ->> 'status', (j ->> 'is_active')::boolean,
      j ->> 'department', j ->> 'title', j ->> 'employee_number',
      (j ->> 'provider_created_at')::timestamptz, (j ->> 'provider_activated_at')::timestamptz, (j ->> 'provider_last_login_at')::timestamptz,
      (j ->> 'provider_last_updated_at')::timestamptz, (j ->> 'provider_status_changed_at')::timestamptz,
      now(), now(), 'current', p_run_id,
      p ->> 'schema_version', p ->> 'sanitizer_version', p ->> 'normalizer_version', p ->> 'source_endpoint', now(), now()
    from src
    on conflict (tenant_id, connection_id, provider, external_id) where connection_id is not null and external_id is not null
    do update set
      login = excluded.login, normalized_login = excluded.normalized_login, email = excluded.email,
      normalized_email = excluded.normalized_email, first_name = excluded.first_name, last_name = excluded.last_name,
      display_name = excluded.display_name, status = excluded.status, is_active = excluded.is_active,
      department = excluded.department, title = excluded.title, employee_number = excluded.employee_number,
      provider_created_at = excluded.provider_created_at, provider_activated_at = excluded.provider_activated_at,
      provider_last_login_at = excluded.provider_last_login_at, provider_last_updated_at = excluded.provider_last_updated_at,
      provider_status_changed_at = excluded.provider_status_changed_at,
      last_seen_at = now(), sync_status = 'current', last_discovery_run_id = p_run_id,
      schema_version = excluded.schema_version, sanitizer_version = excluded.sanitizer_version,
      normalizer_version = excluded.normalizer_version, source_endpoint = excluded.source_endpoint, updated_at = now()
      -- first_seen_at intentionally NOT updated (preserved); raw_payload intentionally NEVER referenced (stays null).
    returning external_id as ext
  )
  select count(*) filter (where not exists (select 1 from existing e where e.ext = u.ext)),
         count(*) filter (where exists (select 1 from existing e where e.ext = u.ext))
    into v_created, v_updated
    from upserted u;

  update public.connector_run_discovery set facts_inserted = v_created, facts_updated = v_updated where run_id = p_run_id;
  return jsonb_build_object('identitiesCreated', v_created, 'identitiesUpdated', v_updated);
end;
$$;

-- ══ F. STALE: evidence-based eligibility + configurable mass-staleness circuit breaker. First run stales ZERO. ═════════
create or replace function public.runner_mark_absent_okta_identities_stale(p_run_id uuid, p_tenant_id uuid)
  returns jsonb
  language plpgsql security definer set search_path = ''
as $$
declare
  v_connector_id uuid;
  v_complete boolean; v_rejected integer; v_termination text; v_review boolean;
  v_prior_current integer; v_absent integer; v_absent_pct numeric;
  v_pct_threshold numeric; v_abs_threshold integer; v_marked integer := 0; v_breaker boolean := false;
begin
  select r.connector_id into v_connector_id
    from public.connector_runs r where r.id = p_run_id and r.tenant_id = p_tenant_id;
  if not found then raise exception 'run % does not belong to tenant %', p_run_id, p_tenant_id; end if;
  if not exists (select 1 from public.connectors c where c.id = v_connector_id and c.tenant_id = p_tenant_id and c.provider = 'okta') then
    raise exception 'connector for run % is not an okta connection', p_run_id;
  end if;
  -- serialize stale/promote on this connection (TOCTOU guard) — lock the connector row (mirrors advance_state's FOR UPDATE).
  perform 1 from public.connectors c where c.id = v_connector_id and c.tenant_id = p_tenant_id for update;

  -- eligibility: only a complete, clean, last_page, non-quarantined run may EVER stale absent rows (stale runs BEFORE the run is
  -- finalized, so connector_runs.status is still 'running' here — the metrics row is the completeness evidence).
  select d.completeness, d.records_rejected, d.termination_reason, d.review_required into v_complete, v_rejected, v_termination, v_review
    from public.connector_run_discovery d where d.run_id = p_run_id and d.tenant_id = p_tenant_id;
  if not found or v_complete is not true or coalesce(v_rejected, 1) <> 0 or v_termination is distinct from 'last_page' or v_review is true then
    return jsonb_build_object('staleMarked', 0, 'absentCount', 0, 'priorCurrent', 0, 'circuitBreakerTriggered', false, 'eligible', false);
  end if;

  -- LATEST-RUN guard: staling on a SUPERSEDED (older) complete run would treat the whole live directory as absent -> mass stale.
  -- Only the most-recent complete run for the connection may stale. Reject (stale zero) if a later complete run exists.
  if exists (
    select 1 from public.connector_runs r2 join public.connector_run_discovery d2 on d2.run_id = r2.id
     where r2.connector_id = v_connector_id and r2.tenant_id = p_tenant_id and r2.id <> p_run_id
       and d2.completeness is true and d2.termination_reason = 'last_page'
       and r2.started_at > (select started_at from public.connector_runs where id = p_run_id)
  ) then
    return jsonb_build_object('staleMarked', 0, 'absentCount', 0, 'priorCurrent', 0, 'circuitBreakerTriggered', false, 'eligible', false, 'superseded', true);
  end if;

  -- FIRST RUN rule: if no identity for this connection was last seen by a DIFFERENT (earlier) run, this is the first complete
  -- promotion for the connection -> stale ZERO.
  if not exists (
    select 1 from public.identity_accounts ia
     where ia.tenant_id = p_tenant_id and ia.connection_id = v_connector_id and ia.provider = 'okta'
       and ia.last_discovery_run_id is distinct from p_run_id
  ) then
    return jsonb_build_object('staleMarked', 0, 'absentCount', 0, 'priorCurrent', 0, 'circuitBreakerTriggered', false, 'eligible', true, 'firstRun', true);
  end if;

  -- absent = currently-'current' rows for this exact connection NOT touched by this run.
  select count(*) filter (where ia.sync_status = 'current'),
         count(*) filter (where ia.sync_status = 'current' and ia.last_discovery_run_id is distinct from p_run_id)
    into v_prior_current, v_absent
    from public.identity_accounts ia
   where ia.tenant_id = p_tenant_id and ia.connection_id = v_connector_id and ia.provider = 'okta';

  select p.stale_percent_threshold, p.stale_absolute_threshold into v_pct_threshold, v_abs_threshold
    from public.connector_discovery_policy p where p.provider = 'okta';
  v_pct_threshold := coalesce(v_pct_threshold, 30);
  v_abs_threshold := coalesce(v_abs_threshold, 100);
  v_absent_pct := case when v_prior_current > 0 then (v_absent::numeric * 100.0 / v_prior_current) else 0 end;

  -- circuit breaker: too much would go stale -> mark ZERO, flag review, finish review-required.
  if v_absent > v_abs_threshold or v_absent_pct > v_pct_threshold then
    update public.connector_run_discovery set review_required = true where run_id = p_run_id;
    return jsonb_build_object('staleMarked', 0, 'absentCount', v_absent, 'priorCurrent', v_prior_current, 'absentPct', round(v_absent_pct, 2), 'circuitBreakerTriggered', true, 'eligible', true);
  end if;

  -- below thresholds: mark ONLY absent rows for THIS exact tenant+connection+provider stale. Never hard-delete, never unlink people.
  update public.identity_accounts ia
     set sync_status = 'stale', stale_since = now(), updated_at = now()
   where ia.tenant_id = p_tenant_id and ia.connection_id = v_connector_id and ia.provider = 'okta'
     and ia.sync_status = 'current' and ia.last_discovery_run_id is distinct from p_run_id;
  get diagnostics v_marked = row_count;
  return jsonb_build_object('staleMarked', v_marked, 'absentCount', v_absent, 'priorCurrent', v_prior_current, 'circuitBreakerTriggered', false, 'eligible', true);
end;
$$;

-- ══ G. least privilege. On hosted Supabase, ALTER DEFAULT PRIVILEGES grants EXECUTE on every new public function DIRECTLY to
-- anon/authenticated; `revoke from public` alone leaves those intact (see 0045). Revoke from public + anon + authenticated so
-- ONLY connector_runner (trusted backend) can invoke these SECURITY DEFINER RPCs — never a PostgREST request role. ═══════════
revoke execute on function public.runner_record_okta_discovery_metrics(uuid, uuid, integer, integer, integer, integer, integer, text, boolean, text, text, text, text) from public, anon, authenticated;
revoke execute on function public.runner_promote_okta_directory_users(uuid, uuid) from public, anon, authenticated;
revoke execute on function public.runner_mark_absent_okta_identities_stale(uuid, uuid) from public, anon, authenticated;
grant execute on function public.runner_record_okta_discovery_metrics(uuid, uuid, integer, integer, integer, integer, integer, text, boolean, text, text, text, text) to connector_runner;
grant execute on function public.runner_promote_okta_directory_users(uuid, uuid) to connector_runner;
grant execute on function public.runner_mark_absent_okta_identities_stale(uuid, uuid) to connector_runner;

-- The new tables are runner-internal: reachable ONLY through the SECURITY DEFINER functions. Deny every request role + the runner
-- direct access (RLS is enabled with no policy; revoke belt-and-suspenders since connector_runner is BYPASSRLS).
revoke all on public.connector_run_discovery from public, anon, authenticated, connector_runner;
revoke all on public.connector_discovery_policy from public, anon, authenticated, connector_runner;
-- identity_accounts: connector_runner gets NO direct grant (promotion/stale run as definer). Authenticated read stays via 0001 RLS.
revoke all on public.identity_accounts from connector_runner;

commit;
