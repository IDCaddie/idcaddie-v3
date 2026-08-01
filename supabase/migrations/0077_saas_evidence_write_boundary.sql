-- 0077_saas_evidence_write_boundary.sql
--
-- Phase 8D — the runner-only write path for canonical SaaS evidence (0076), and per-resource completeness accounting.
--
-- SHAPE, deliberately identical to the proven Okta path: the sink inserts NORMALIZED facts through the existing
-- `runner_insert_discovery_fact` (whose allowlist already contains `app_user_account` and `group`), and a promote RPC reads
-- those facts and upserts canonical rows. No promote takes a JSON array of records, so there is no arbitrary-writer parameter
-- and no raw payload can reach a canonical table.
--
-- ══ WHY A NEW COMPLETENESS TABLE ═════════════════════════════════════════════════════════════════════════════════════════
-- `connector_run_discovery` is PRIMARY KEY (run_id): ONE completeness row per run. Okta lives with that by opening one run per
-- resource sweep (O2D), so its run id IS the discriminator. The generic executor does not work that way — it runs a whole
-- manifest in one pass and already tracks metrics PER ENDPOINT in memory (`RunMetrics.endpoints`).
--
-- Persisting those into one shared row would let a complete `usergroups.list` authorize staling accounts that `users.list`
-- never finished reading. That is the precise failure the GO forbids, and it is how a partial sweep deletes a directory.
--
-- So this adds a per-resource table rather than altering `connector_run_discovery`. Additive, and it leaves the Okta gate —
-- proven across five hosted sweeps — completely untouched.
create table if not exists public.connector_run_resource_discovery (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  run_id uuid not null references public.connector_runs (id) on delete cascade,
  -- The resource this row accounts for. Bounded: an unrecognised resource must not be able to authorize a stale sweep.
  resource text not null,
  -- `resource` IS the emitted fact type, not an endpoint id or a table name. The gate has to answer "were ACCOUNTS fully
  -- read", and two endpoints could emit the same resource; naming it after the fact type also means the runner never has
  -- to maintain an endpoint->resource mapping that could drift from the manifest.
  constraint crrd_resource_chk check (resource in ('app_user_account', 'group', 'group_membership')),

  pages integer not null default 0,
  records_seen integer not null default 0,
  records_accepted integer not null default 0,
  records_rejected integer not null default 0,
  retries integer not null default 0,
  rate_limited integer not null default 0,
  termination_reason text,
  constraint crrd_termination_chk check (termination_reason is null or termination_reason in
    ('last_page', 'page_budget', 'item_budget', 'time_budget', 'rate_limited', 'error', 'cursor_cycle', 'schema_rejected')),
  completeness boolean not null default false,
  review_required boolean not null default false,
  created_at timestamptz not null default now(),

  -- One accounting row per (run, resource). This IS the discriminator.
  constraint crrd_run_resource_key unique (run_id, resource)
);
create index if not exists crrd_tenant_idx on public.connector_run_resource_discovery (tenant_id, run_id);

-- ══ 1. RECORD PER-RESOURCE METRICS ═══════════════════════════════════════════════════════════════════════════════════════
create or replace function public.runner_record_saas_resource_discovery(
  p_run_id uuid, p_tenant_id uuid, p_resource text,
  p_pages integer, p_records_seen integer, p_records_accepted integer, p_records_rejected integer,
  p_retries integer, p_rate_limited integer, p_termination_reason text, p_completeness boolean, p_review_required boolean
) returns void language plpgsql security definer set search_path = '' as $$
begin
  if not exists (select 1 from public.connector_runs r where r.id = p_run_id and r.tenant_id = p_tenant_id) then
    raise exception 'run % does not belong to tenant %', p_run_id, p_tenant_id;
  end if;
  insert into public.connector_run_resource_discovery
    (tenant_id, run_id, resource, pages, records_seen, records_accepted, records_rejected, retries, rate_limited, termination_reason, completeness, review_required)
  values (p_tenant_id, p_run_id, p_resource, coalesce(p_pages,0), coalesce(p_records_seen,0), coalesce(p_records_accepted,0),
          coalesce(p_records_rejected,0), coalesce(p_retries,0), coalesce(p_rate_limited,0), p_termination_reason,
          coalesce(p_completeness,false), coalesce(p_review_required,false))
  on conflict (run_id, resource) do update set
    pages = excluded.pages, records_seen = excluded.records_seen, records_accepted = excluded.records_accepted,
    records_rejected = excluded.records_rejected, retries = excluded.retries, rate_limited = excluded.rate_limited,
    termination_reason = excluded.termination_reason, completeness = excluded.completeness, review_required = excluded.review_required;
end $$;

-- ══ 2. PROMOTE APP ACCOUNTS ══════════════════════════════════════════════════════════════════════════════════════════════
-- Reads THIS run's `app_user_account` facts and upserts canonical accounts. Same eligibility proof as the Okta promoters.
create or replace function public.runner_promote_saas_app_accounts(p_run_id uuid, p_tenant_id uuid)
  returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_connector_id uuid; v_provider text;
  v_complete boolean; v_rejected integer; v_termination text; v_review boolean;
  v_created integer := 0; v_updated integer := 0;
begin
  select r.connector_id into v_connector_id from public.connector_runs r where r.id = p_run_id and r.tenant_id = p_tenant_id;
  if not found then raise exception 'run % does not belong to tenant %', p_run_id, p_tenant_id; end if;
  -- The provider is PINNED to the connector, never taken from the fact. A fact claiming another provider cannot retarget a row.
  select c.provider into v_provider from public.connectors c where c.id = v_connector_id and c.tenant_id = p_tenant_id;
  if v_provider is null then raise exception 'connector for run % not found in tenant', p_run_id; end if;

  -- Per-RESOURCE eligibility. `usergroups.list` completing says nothing about whether accounts were fully read.
  select d.completeness, d.records_rejected, d.termination_reason, d.review_required
    into v_complete, v_rejected, v_termination, v_review
    from public.connector_run_resource_discovery d
   where d.run_id = p_run_id and d.tenant_id = p_tenant_id and d.resource = 'app_user_account';
  if not found then raise exception 'run % has no app_user_account metrics; cannot promote', p_run_id; end if;
  if v_complete is not true or coalesce(v_rejected, 1) <> 0 or v_termination is distinct from 'last_page' or v_review is true then
    raise exception 'run % is not eligible to promote accounts (complete=%, rejected=%, termination=%, review=%)', p_run_id, v_complete, v_rejected, v_termination, v_review;
  end if;

  -- LATEST-RUN guard, per resource — the same one 0053/0054/0060 carry, and the same one the staler below applies.
  -- Without it, replaying an older run's promote resurrects accounts a newer complete sweep legitimately retired, and
  -- SILENTLY: the audit trigger fires only on current -> stale, so a stale -> current reversal writes no event.
  if exists (
    select 1 from public.connector_runs r2 join public.connector_run_resource_discovery d2 on d2.run_id = r2.id
     where r2.connector_id = v_connector_id and r2.tenant_id = p_tenant_id and r2.id <> p_run_id
       and d2.resource = 'app_user_account' and d2.completeness is true and d2.termination_reason = 'last_page'
       and r2.started_at > (select started_at from public.connector_runs where id = p_run_id)
  ) then
    raise exception 'run % is superseded by a later complete run; refusing to promote', p_run_id;
  end if;

  with existing as (
    select a.external_id as ext from public.app_accounts a
     where a.tenant_id = p_tenant_id and a.connection_id = v_connector_id and a.provider = v_provider
  ),
  src as (
    select distinct on (f.fact_json ->> 'app_user_external_id') f.fact_json as j, f.provenance_json as p
      from public.discovery_facts f
     where f.source_run_id = p_run_id and f.tenant_id = p_tenant_id
       and f.source_provider = v_provider and f.fact_type = 'app_user_account'
       and f.fact_json ->> 'app_user_external_id' is not null
     order by f.fact_json ->> 'app_user_external_id', f.observed_at desc
  ),
  upserted as (
    insert into public.app_accounts (
      tenant_id, connection_id, provider, external_id, workspace_external_id,
      display_name, email, normalized_email, account_kind, account_status, is_admin,
      first_seen_at, last_seen_at, sync_status, stale_since, last_discovery_run_id,
      schema_version, sanitizer_version, normalizer_version, source_endpoint, created_at, updated_at)
    select
      p_tenant_id, v_connector_id, v_provider, j ->> 'app_user_external_id', j ->> 'app_instance_key',
      j ->> 'display_name', j ->> 'email', lower(nullif(btrim(coalesce(j ->> 'email', '')), '')),
      -- The FACT carries what the provider said (is_bot / is_deleted); the bounded 0076 vocabulary is derived HERE, the one
      -- place that knows it. A provider that never reported the flag yields `unknown` rather than a defaulted `human` — a
      -- misclassified bot is a bot in an access review.
      case when j ? 'is_bot' then (case when (j ->> 'is_bot')::boolean then 'bot' else 'human' end) else 'unknown' end,
      -- Two shapes reach this field and only one vocabulary leaves it. `is_deleted` is the boolean a declarative field_map
      -- can carry (Slack); `status` is the pre-bucketed string a provider normalizer can carry (Entra emits
      -- active/disabled). Neither present -> `unknown`, never a defaulted `active`.
      case
        when j ? 'is_deleted' then (case when (j ->> 'is_deleted')::boolean then 'deleted' else 'active' end)
        when (j ->> 'status') in ('active', 'inactive', 'deleted') then j ->> 'status'
        when (j ->> 'status') = 'disabled' then 'inactive'
        else 'unknown'
      end,
      case when j ? 'is_admin' then (j ->> 'is_admin')::boolean else null end,
      now(), now(), 'current', null, p_run_id,
      p ->> 'schema_version', p ->> 'sanitizer_version', p ->> 'normalizer_version', p ->> 'source_endpoint', now(), now()
    from src
    on conflict (tenant_id, connection_id, provider, external_id) do update set
      display_name = excluded.display_name, email = excluded.email, normalized_email = excluded.normalized_email,
      account_kind = excluded.account_kind, account_status = excluded.account_status, is_admin = excluded.is_admin,
      workspace_external_id = excluded.workspace_external_id,
      -- Promotion always returns the row to CURRENT and clears the stale timestamp. This is the 0070 invariant, applied here
      -- from the start rather than discovered later.
      last_seen_at = now(), sync_status = 'current', stale_since = null, last_discovery_run_id = p_run_id,
      schema_version = excluded.schema_version, sanitizer_version = excluded.sanitizer_version,
      normalizer_version = excluded.normalizer_version, source_endpoint = excluded.source_endpoint, updated_at = now()
      -- first_seen_at intentionally preserved.
    returning external_id as ext)
  select count(*) filter (where not exists (select 1 from existing e where e.ext = u.ext)),
         count(*) filter (where exists (select 1 from existing e where e.ext = u.ext))
    into v_created, v_updated from upserted u;

  return jsonb_build_object('accountsCreated', v_created, 'accountsUpdated', v_updated);
end $$;

-- ══ 3. PROMOTE APP GROUPS ════════════════════════════════════════════════════════════════════════════════════════════════
create or replace function public.runner_promote_saas_app_groups(p_run_id uuid, p_tenant_id uuid)
  returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_connector_id uuid; v_provider text;
  v_complete boolean; v_rejected integer; v_termination text; v_review boolean; v_n integer := 0;
begin
  select r.connector_id into v_connector_id from public.connector_runs r where r.id = p_run_id and r.tenant_id = p_tenant_id;
  if not found then raise exception 'run % does not belong to tenant %', p_run_id, p_tenant_id; end if;
  select c.provider into v_provider from public.connectors c where c.id = v_connector_id and c.tenant_id = p_tenant_id;
  if v_provider is null then raise exception 'connector for run % not found in tenant', p_run_id; end if;

  select d.completeness, d.records_rejected, d.termination_reason, d.review_required
    into v_complete, v_rejected, v_termination, v_review
    from public.connector_run_resource_discovery d
   where d.run_id = p_run_id and d.tenant_id = p_tenant_id and d.resource = 'group';
  if not found then raise exception 'run % has no group metrics; cannot promote', p_run_id; end if;
  if v_complete is not true or coalesce(v_rejected, 1) <> 0 or v_termination is distinct from 'last_page' or v_review is true then
    raise exception 'run % is not eligible to promote groups', p_run_id;
  end if;

  -- LATEST-RUN guard, scoped to THIS resource. See the accounts promoter above.
  if exists (
    select 1 from public.connector_runs r2 join public.connector_run_resource_discovery d2 on d2.run_id = r2.id
     where r2.connector_id = v_connector_id and r2.tenant_id = p_tenant_id and r2.id <> p_run_id
       and d2.resource = 'group' and d2.completeness is true and d2.termination_reason = 'last_page'
       and r2.started_at > (select started_at from public.connector_runs where id = p_run_id)
  ) then
    raise exception 'run % is superseded by a later complete run; refusing to promote', p_run_id;
  end if;

  with src as (
    select distinct on (f.fact_json ->> 'group_external_id') f.fact_json as j
      from public.discovery_facts f
     where f.source_run_id = p_run_id and f.tenant_id = p_tenant_id
       and f.source_provider = v_provider and f.fact_type = 'group'
       and f.fact_json ->> 'group_external_id' is not null
     order by f.fact_json ->> 'group_external_id', f.observed_at desc
  ), upserted as (
    insert into public.app_account_groups (
      tenant_id, connection_id, provider, external_id, workspace_external_id, name, handle, description,
      member_count, is_active, first_seen_at, last_seen_at, sync_status, stale_since, last_discovery_run_id, created_at, updated_at)
    select p_tenant_id, v_connector_id, v_provider, j ->> 'group_external_id', j ->> 'app_instance_key',
           j ->> 'group_name', j ->> 'group_handle', j ->> 'description',
           case when j ? 'member_count' then (j ->> 'member_count')::integer else null end,
           case when j ? 'is_active' then (j ->> 'is_active')::boolean else null end,
           now(), now(), 'current', null, p_run_id, now(), now()
    from src
    on conflict (tenant_id, connection_id, provider, external_id) do update set
      name = excluded.name, handle = excluded.handle, description = excluded.description,
      member_count = excluded.member_count, is_active = excluded.is_active, workspace_external_id = excluded.workspace_external_id,
      last_seen_at = now(), sync_status = 'current', stale_since = null, last_discovery_run_id = p_run_id, updated_at = now()
    returning 1 as one)
  select count(*) into v_n from upserted;
  return jsonb_build_object('groupsUpserted', v_n);
end $$;

-- ══ 4. STALE MARKING ═════════════════════════════════════════════════════════════════════════════════════════════════════
-- Same safety model as Okta's: complete + clean + last_page + not-flagged, latest-run guard, connector lock, circuit breaker.
-- The difference is that eligibility is read PER RESOURCE, so one endpoint can never authorize staling another's rows.
create or replace function public.runner_mark_absent_saas_app_accounts_stale(p_run_id uuid, p_tenant_id uuid)
  returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_connector_id uuid; v_provider text;
  v_complete boolean; v_rejected integer; v_termination text; v_review boolean;
  v_prior integer; v_absent integer; v_pct numeric; v_marked integer := 0;
begin
  select r.connector_id into v_connector_id from public.connector_runs r where r.id = p_run_id and r.tenant_id = p_tenant_id;
  if not found then raise exception 'run % does not belong to tenant %', p_run_id, p_tenant_id; end if;
  select c.provider into v_provider from public.connectors c where c.id = v_connector_id and c.tenant_id = p_tenant_id;
  -- Serialize promote/stale on this connector (TOCTOU guard), mirroring the Okta staler.
  perform 1 from public.connectors c where c.id = v_connector_id and c.tenant_id = p_tenant_id for update;

  select d.completeness, d.records_rejected, d.termination_reason, d.review_required
    into v_complete, v_rejected, v_termination, v_review
    from public.connector_run_resource_discovery d
   where d.run_id = p_run_id and d.tenant_id = p_tenant_id and d.resource = 'app_user_account';
  if not found or v_complete is not true or coalesce(v_rejected, 1) <> 0 or v_termination is distinct from 'last_page' or v_review is true then
    return jsonb_build_object('staleMarked', 0, 'eligible', false);
  end if;

  -- LATEST-RUN guard: staling on a superseded sweep would treat the live workspace as absent.
  if exists (
    select 1 from public.connector_runs r2 join public.connector_run_resource_discovery d2 on d2.run_id = r2.id
     where r2.connector_id = v_connector_id and r2.tenant_id = p_tenant_id and r2.id <> p_run_id
       and d2.resource = 'app_user_account' and d2.completeness is true and d2.termination_reason = 'last_page'
       and r2.started_at > (select started_at from public.connector_runs where id = p_run_id)
  ) then return jsonb_build_object('staleMarked', 0, 'eligible', false, 'superseded', true); end if;

  -- FIRST RUN rule: nothing was seen by an earlier run, so nothing can be absent.
  if not exists (
    select 1 from public.app_accounts a
     where a.tenant_id = p_tenant_id and a.connection_id = v_connector_id and a.provider = v_provider
       and a.last_discovery_run_id is distinct from p_run_id
  ) then return jsonb_build_object('staleMarked', 0, 'eligible', true, 'firstRun', true); end if;

  select count(*) filter (where a.sync_status = 'current'),
         count(*) filter (where a.sync_status = 'current' and a.last_discovery_run_id is distinct from p_run_id)
    into v_prior, v_absent
    from public.app_accounts a
   where a.tenant_id = p_tenant_id and a.connection_id = v_connector_id and a.provider = v_provider;

  v_pct := case when v_prior > 0 then (v_absent::numeric * 100.0 / v_prior) else 0 end;
  -- Circuit breaker, same 30% / 100-row default as the Okta policy. A sweep that would retire a third of a workspace is far
  -- more likely to be a bad read than a real event.
  if v_absent > 100 or v_pct > 30 then
    update public.connector_run_resource_discovery set review_required = true
     where run_id = p_run_id and resource = 'app_user_account';
    return jsonb_build_object('staleMarked', 0, 'absentCount', v_absent, 'priorCurrent', v_prior, 'circuitBreakerTriggered', true, 'eligible', true);
  end if;

  update public.app_accounts a
     set sync_status = 'stale', stale_since = now(), updated_at = now()
   where a.tenant_id = p_tenant_id and a.connection_id = v_connector_id and a.provider = v_provider
     and a.sync_status = 'current' and a.last_discovery_run_id is distinct from p_run_id;
  get diagnostics v_marked = row_count;
  return jsonb_build_object('staleMarked', v_marked, 'absentCount', v_absent, 'priorCurrent', v_prior, 'circuitBreakerTriggered', false, 'eligible', true);
end $$;

-- ══ 5. CAPABILITY FRESHNESS ══════════════════════════════════════════════════════════════════════════════════════════════
create or replace function public.runner_record_capability_state(
  p_tenant_id uuid, p_connector_id uuid, p_capability text, p_state text, p_reason_code text, p_run_id uuid, p_observed_count integer
) returns void language plpgsql security definer set search_path = '' as $$
begin
  if not exists (select 1 from public.connectors c where c.id = p_connector_id and c.tenant_id = p_tenant_id) then
    raise exception 'connector % does not belong to tenant %', p_connector_id, p_tenant_id;
  end if;
  insert into public.connector_capability_state
    (tenant_id, connection_id, capability, state, reason_code, last_success_at, last_attempt_at, last_run_id, observed_count)
  values (p_tenant_id, p_connector_id, p_capability, p_state, p_reason_code,
          case when p_state = 'available' then now() else null end, now(), p_run_id, p_observed_count)
  on conflict (tenant_id, connection_id, capability) do update set
    state = excluded.state, reason_code = excluded.reason_code,
    -- last_success_at is only ADVANCED, never cleared: a later failure must not erase the record of when it last worked.
    last_success_at = coalesce(excluded.last_success_at, public.connector_capability_state.last_success_at),
    last_attempt_at = excluded.last_attempt_at, last_run_id = excluded.last_run_id,
    observed_count = excluded.observed_count, updated_at = now();
end $$;

-- ══ 6. STALE-TRANSITION AUDIT ════════════════════════════════════════════════════════════════════════════════════════════
-- Bounded metadata only. The WHEN clause is load-bearing: a status-preserving update or a replay never reaches the body, so
-- no duplicate event can be written. Mirrors 0068.
create or replace function public.audit_saas_stale_transition()
  returns trigger language plpgsql security definer set search_path = '' as $$
begin
  insert into public.audit_logs (tenant_id, actor_user_id, action, resource_type, resource_id, before_json, after_json)
  values (new.tenant_id, null, 'saas_evidence.staled', tg_argv[0], new.id,
          jsonb_build_object('sync_status', old.sync_status, 'last_discovery_run_id', old.last_discovery_run_id),
          -- No name, email, raw provider data, token, secret reference or exception text.
          jsonb_build_object('sync_status', new.sync_status, 'stale_since', new.stale_since,
                             'connector_id', new.connection_id, 'provider', new.provider, 'reason_code', 'absent_from_complete_sweep'));
  return null;
end $$;

-- Least privilege for the audit writer itself, mirroring 0068:64-67 exactly. `create function` alone is NOT enough on
-- hosted Supabase: 0045's ALTER DEFAULT PRIVILEGES grants EXECUTE on every new public function to anon/authenticated/
-- service_role, and `scripts/test-rls.sh` re-revokes every trigger-returning function, so a local run cannot see the gap.
-- A trigger return type keeps this off the PostgREST RPC surface, but EXECUTE + TRIGGER on a table carrying the columns
-- the body reads is a forgery surface into audit_logs as the definer. That is the hole 0068 exists to close.
revoke all on function public.audit_saas_stale_transition() from public;
revoke all on function public.audit_saas_stale_transition() from anon;
revoke all on function public.audit_saas_stale_transition() from authenticated;
revoke all on function public.audit_saas_stale_transition() from service_role;

create trigger saas_stale_audit_app_accounts after update on public.app_accounts
  for each row when (old.sync_status = 'current' and new.sync_status = 'stale')
  execute function public.audit_saas_stale_transition('app_account');
create trigger saas_stale_audit_app_groups after update on public.app_account_groups
  for each row when (old.sync_status = 'current' and new.sync_status = 'stale')
  execute function public.audit_saas_stale_transition('app_account_group');

-- ══ 7. LEAST PRIVILEGE ═══════════════════════════════════════════════════════════════════════════════════════════════════
-- connector_runner ONLY. On hosted Supabase, ALTER DEFAULT PRIVILEGES grants EXECUTE on new public functions straight to
-- anon/authenticated (0045) and `revoke from public` alone does not remove it — every role is named.
--
-- The runner has NO direct table grant on any 0076 table (revoked there): it can only write through these functions, so the
-- eligibility gate, the connector scope and the circuit breaker cannot be bypassed.
do $$
declare f text;
begin
  foreach f in array array[
    'public.runner_record_saas_resource_discovery(uuid, uuid, text, integer, integer, integer, integer, integer, integer, text, boolean, boolean)',
    'public.runner_promote_saas_app_accounts(uuid, uuid)',
    'public.runner_promote_saas_app_groups(uuid, uuid)',
    'public.runner_mark_absent_saas_app_accounts_stale(uuid, uuid)',
    'public.runner_record_capability_state(uuid, uuid, text, text, text, uuid, integer)'
  ] loop
    execute format('revoke execute on function %s from public, anon, authenticated, service_role', f);
    execute format('grant execute on function %s to connector_runner', f);
  end loop;
end $$;

revoke all on public.connector_run_resource_discovery from public, anon, authenticated, connector_runner;
alter table public.connector_run_resource_discovery enable row level security;

-- ══ 8. FACT-TYPE KEY ALLOWLISTS FOR THE TWO SAAS FACT TYPES ══════════════════════════════════════════════════════════════
-- Copied verbatim from 0060 with two blocks added (marked 0077). The promoters read only NAMED fields, so an extra key
-- could never reach a column — but it WOULD be persisted in discovery_facts, which is the same problem one table earlier.
-- Fail closed at the front door instead.
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
  -- app_user_account: POSITIVE top-level key ALLOWLIST (0077). Until now app_user_account and `group` were the only two
  -- allowlisted fact types with NO key allowlist — they had no promoter, so nothing read them. Now that they do, an
  -- un-allowlisted key would be a raw-payload smuggling path straight into canonical evidence. EXCLUDES everything Slack
  -- returns that ID Caddie has no reason to hold: profile blobs, avatars, phone, tz, title, real_name variants, team
  -- membership lists, `_links`, and anything the promoters do not read.
  if p_fact_type = 'app_user_account' and exists (
    select 1 from jsonb_object_keys(p_fact_json) k
     where k not in ('fact_type','app_user_external_id','app_instance_key','display_name','email',
                     'is_bot','is_deleted','is_admin','status')
  ) then
    raise exception 'app_user_account fact_json contains a non-approved key';
  end if;
  -- group: POSITIVE top-level key ALLOWLIST (0077). Same reasoning. Channel/message/conversation fields are absent by
  -- construction, not by filtering — no scope requests them.
  if p_fact_type = 'group' and exists (
    select 1 from jsonb_object_keys(p_fact_json) k
     where k not in ('fact_type','group_external_id','app_instance_key','group_name','group_handle','description',
                     'member_count','is_active')
  ) then
    raise exception 'group fact_json contains a non-approved key';
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

-- CREATE OR REPLACE preserves privileges; re-assert least privilege anyway (0056/0060 precedent).
revoke execute on function public.runner_insert_discovery_fact(uuid, uuid, text, text, text, text, text, timestamptz, numeric, jsonb, jsonb) from public, anon, authenticated, service_role;
grant execute on function public.runner_insert_discovery_fact(uuid, uuid, text, text, text, text, text, timestamptz, numeric, jsonb, jsonb) to connector_runner;
