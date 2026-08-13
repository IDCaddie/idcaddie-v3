-- 0083 — Google Workspace directory PERSISTENCE: the write boundary for identities, groups, group memberships and licence
-- evidence. CREATE OR REPLACE FUNCTION / CREATE FUNCTION + GRANT/REVOKE only — additive; no table created, no table
-- teardown, no row purge, no destructive op, and NO new column on any existing table.
--
-- ══ WHY NEW FUNCTIONS AT ALL ═════════════════════════════════════════════════════════════════════════════════════════
-- The Phase 4/6/8 promote+stale RPCs are hard-scoped to Okta by LITERAL, in three separate places each: the connector
-- provider check (`c.provider = 'okta'`), the fact filter (`f.source_provider = 'okta'`), and the inserted/compared column
-- (`'okta'`). A Google run cannot reuse them — `runner_promote_okta_directory_users` raises
-- 'connector for run % is not an okta connection' before touching a row. So a second provider needs its own write path.
--
-- ══ AND WHY PROVIDER-PARAMETERIZED RATHER THAN A SECOND COPY ═════════════════════════════════════════════════════════
-- The obvious move is to copy the six Okta functions and swap the literal. That is ~420 lines of duplicated
-- security-critical SQL, and provider three would copy it again. Instead the semantics are written ONCE with the provider
-- as a parameter, and the parameter is restricted by an allowlist.
--
-- The allowlist currently contains ONLY 'google_workspace'. That is deliberate and load-bearing:
--   * Okta's functions are untouched by this migration — not one byte — and remain the only path to Okta rows. Okta has
--     run on hosted staging; re-pointing it at new code is a separate, separately-evidenced decision, not a side effect
--     of adding a provider.
--   * A caller passing 'okta' to these functions is REFUSED. So this migration cannot alter, promote, or stale a single
--     Okta row even by mistake, which is a stronger guarantee than "we were careful".
-- Migrating Okta later is then a reviewable one-line change (add 'okta' to the allowlist, drop the old functions), rather
-- than a rewrite.
--
-- ══ SEMANTICS ARE MIRRORED EXACTLY, NOT REINTERPRETED ════════════════════════════════════════════════════════════════
-- Every rule from 0053/0054/0056/0070 is reproduced: run→tenant ownership; the connector's ACTUAL provider must equal the
-- claimed one; promotion requires a metrics row proving completeness + zero rejects + termination_reason='last_page' +
-- not review_required; the latest-run guard refuses a superseded run; connection_id is server-derived and the fact must
-- ALSO carry it; DISTINCT ON de-duplicates; first_seen_at is preserved and last_seen_at advanced; raw_payload is never
-- set; promotion clears stale_since (the 0070 invariant); staling is eligibility-gated, first-run-safe, latest-run-only,
-- serialized by a FOR UPDATE on the connector row, and bounded by the configurable mass-staleness circuit breaker.
--
-- NOTE ON ORDERING: this file is 0083 because 0082 (the person identity graph) is already on main. 0082 does not touch
-- runner_insert_discovery_fact, so the CREATE OR REPLACE below — which is written from 0077's body — reverts nothing.
--
-- ACTIVATES nothing. Staging only. No connector is enabled by this migration; google_workspace remains disabled and
-- unconnectable in the provider registry, and no Google credential exists.

-- ══ A. the 'license' fact_type at the write boundary ═════════════════════════════════════════════════════════════════
-- CREATE OR REPLACE with the SAME signature preserves 0041's grant. Every existing branch is reproduced verbatim from
-- 0077; the ONLY additions are 'license' in the fact_type allowlist and its positive top-level key allowlist.
--
-- WHY 'license' AND NOTHING ELSE. `license` is already a member of the shared discovery-fact contract
-- (vendor/connectors/discovery-facts.ts FactTypeSchema) but was absent from this allowlist, so no connector could write
-- one. Google is the first provider that reads licence assignments, so it is the first that needs it. `role_admin` and
-- `usage_activity` are also in the shared contract and are also absent here — they stay absent, because nothing persists
-- them yet and an allowlist entry with no writer is a widened boundary for free.
--
-- The licence key allowlist is MINIMAL: the assignment's identity (which SKU, which product, which holder, which
-- instance) and nothing else. Deliberately EXCLUDES any assignment timestamp (Google reports none — see
-- google-workspace-license-schemas.ts) and any cost/billing field (Google reports none; spend comes from contracts and
-- invoices, never from here). `provider_user_key` is the holder's email, which is what Google's licensing API returns as
-- `userId`; it is the join key to identity_accounts and is no more sensitive than identity_account.email, already allowed.
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
  -- directory_group_membership (Phase 8) + directory_application (Phase 10) + the two application-assignment edges
  -- (Phase 12) + license (0083, Google Workspace licence evidence).
  if p_fact_type not in ('app_user_account', 'group', 'identity_account', 'directory_group', 'directory_group_membership',
                         'directory_application', 'application_user_assignment', 'application_group_assignment',
                         'license') then
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
  -- application_user_assignment: MINIMAL positive key ALLOWLIST — unchanged.
  if p_fact_type = 'application_user_assignment' and exists (
    select 1 from jsonb_object_keys(p_fact_json) k
     where k not in ('fact_type','connection_id','application_external_id','user_external_id')
  ) then
    raise exception 'application_user_assignment fact_json contains a non-approved key';
  end if;
  -- application_group_assignment: MINIMAL positive key ALLOWLIST — unchanged.
  if p_fact_type = 'application_group_assignment' and exists (
    select 1 from jsonb_object_keys(p_fact_json) k
     where k not in ('fact_type','connection_id','application_external_id','group_external_id')
  ) then
    raise exception 'application_group_assignment fact_json contains a non-approved key';
  end if;
  -- app_user_account: POSITIVE top-level key ALLOWLIST (0077) — unchanged.
  if p_fact_type = 'app_user_account' and exists (
    select 1 from jsonb_object_keys(p_fact_json) k
     where k not in ('fact_type','app_user_external_id','app_instance_key','display_name','email',
                     'is_bot','is_deleted','is_admin','status')
  ) then
    raise exception 'app_user_account fact_json contains a non-approved key';
  end if;
  -- group: POSITIVE top-level key ALLOWLIST (0077) — unchanged.
  if p_fact_type = 'group' and exists (
    select 1 from jsonb_object_keys(p_fact_json) k
     where k not in ('fact_type','group_external_id','app_instance_key','group_name','group_handle','description',
                     'member_count','is_active')
  ) then
    raise exception 'group fact_json contains a non-approved key';
  end if;
  -- license: MINIMAL positive key ALLOWLIST (0083). ONLY the assignment's identity. No assignment timestamp and no cost
  -- field is permitted, because the source reports neither — an allowlist entry for a field the provider cannot supply
  -- is an invitation to synthesize one.
  if p_fact_type = 'license' and exists (
    select 1 from jsonb_object_keys(p_fact_json) k
     where k not in ('fact_type','connection_id','app_instance_key','product_id','license_sku','license_name',
                     'license_status','provider_user_key')
  ) then
    raise exception 'license fact_json contains a non-approved key';
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

-- ══ B. the provider allowlist for the parameterized functions below ══════════════════════════════════════════════════
-- 'okta' is ABSENT on purpose — see the header. An unknown or not-yet-migrated provider fails closed.
create or replace function public.runner_assert_parameterized_provider(p_provider text)
  returns void
  language plpgsql immutable
as $$
begin
  if p_provider is null or p_provider not in ('google_workspace') then
    raise exception 'provider % is not served by the parameterized directory write path', coalesce(p_provider, '<null>');
  end if;
end;
$$;

-- Resolve a run to its connection AND prove the connection's ACTUAL provider equals the claimed one. Every function below
-- starts here, so a caller can never operate on one provider's rows while naming another.
create or replace function public.runner_resolve_directory_run(p_run_id uuid, p_tenant_id uuid, p_provider text)
  returns uuid
  language plpgsql security definer set search_path = ''
as $$
declare
  v_connector_id uuid;
begin
  perform public.runner_assert_parameterized_provider(p_provider);
  select r.connector_id into v_connector_id
    from public.connector_runs r where r.id = p_run_id and r.tenant_id = p_tenant_id;
  if not found then raise exception 'run % does not belong to tenant %', p_run_id, p_tenant_id; end if;
  if not exists (
    select 1 from public.connectors c
     where c.id = v_connector_id and c.tenant_id = p_tenant_id and c.provider = p_provider
  ) then
    raise exception 'connector for run % is not a % connection', p_run_id, p_provider;
  end if;
  return v_connector_id;
end;
$$;

-- ══ C. discovery metrics ═════════════════════════════════════════════════════════════════════════════════════════════
create or replace function public.runner_record_directory_discovery_metrics(
  p_run_id uuid, p_tenant_id uuid, p_provider text,
  p_pages_fetched integer, p_records_seen integer, p_records_distinct integer, p_records_valid integer, p_records_rejected integer,
  p_termination_reason text, p_completeness boolean,
  p_schema_version text, p_sanitizer_version text, p_normalizer_version text, p_safe_error_category text
) returns void
  language plpgsql security definer set search_path = ''
as $$
declare
  v_connector_id uuid;
begin
  v_connector_id := public.runner_resolve_directory_run(p_run_id, p_tenant_id, p_provider);

  insert into public.connector_run_discovery (
    run_id, tenant_id, connection_id, provider, pages_fetched, records_seen, records_distinct, records_valid, records_rejected,
    termination_reason, completeness, schema_version, sanitizer_version, normalizer_version, safe_error_category
  ) values (
    p_run_id, p_tenant_id, v_connector_id, p_provider, p_pages_fetched, p_records_seen, p_records_distinct, p_records_valid, p_records_rejected,
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

-- ══ D. shared promotion eligibility ══════════════════════════════════════════════════════════════════════════════════
-- The complete-run proof + latest-run guard, factored out because all three promoters apply it identically. RAISES on
-- ineligibility (promotion is a demand); the stale functions ask the softer question separately and merely return.
create or replace function public.runner_assert_promotable(p_run_id uuid, p_tenant_id uuid, p_connector_id uuid)
  returns void
  language plpgsql security definer set search_path = ''
as $$
declare
  v_complete boolean; v_rejected integer; v_termination text; v_review boolean;
begin
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
     where r2.connector_id = p_connector_id and r2.tenant_id = p_tenant_id and r2.id <> p_run_id
       and d2.completeness is true and d2.termination_reason = 'last_page'
       and r2.started_at > (select started_at from public.connector_runs where id = p_run_id)
  ) then
    raise exception 'run % is superseded by a later complete run; refusing to promote', p_run_id;
  end if;
end;
$$;

-- The stale-side eligibility question. Returns true only when this run may stale absent rows. Never raises: an ineligible
-- run stales ZERO and says so, which is the difference between "nothing was absent" and "we were not allowed to look".
create or replace function public.runner_stale_eligible(p_run_id uuid, p_tenant_id uuid, p_connector_id uuid)
  returns boolean
  language plpgsql security definer set search_path = ''
as $$
declare
  v_complete boolean; v_rejected integer; v_termination text; v_review boolean;
begin
  select d.completeness, d.records_rejected, d.termination_reason, d.review_required
    into v_complete, v_rejected, v_termination, v_review
    from public.connector_run_discovery d where d.run_id = p_run_id and d.tenant_id = p_tenant_id;
  if not found or v_complete is not true or coalesce(v_rejected, 1) <> 0 or v_termination is distinct from 'last_page' or v_review is true then
    return false;
  end if;
  if exists (
    select 1 from public.connector_runs r2 join public.connector_run_discovery d2 on d2.run_id = r2.id
     where r2.connector_id = p_connector_id and r2.tenant_id = p_tenant_id and r2.id <> p_run_id
       and d2.completeness is true and d2.termination_reason = 'last_page'
       and r2.started_at > (select started_at from public.connector_runs where id = p_run_id)
  ) then
    return false;
  end if;
  return true;
end;
$$;

-- ══ E. IDENTITIES: promote + stale ═══════════════════════════════════════════════════════════════════════════════════
create or replace function public.runner_promote_directory_users(p_run_id uuid, p_tenant_id uuid, p_provider text)
  returns jsonb
  language plpgsql security definer set search_path = ''
as $$
declare
  v_connector_id uuid; v_created integer := 0; v_updated integer := 0;
begin
  v_connector_id := public.runner_resolve_directory_run(p_run_id, p_tenant_id, p_provider);
  perform public.runner_assert_promotable(p_run_id, p_tenant_id, v_connector_id);

  with existing as (
    select ia.external_id as ext from public.identity_accounts ia
     where ia.tenant_id = p_tenant_id and ia.connection_id = v_connector_id and ia.provider = p_provider and ia.external_id is not null
  ),
  src as (
    select distinct on (f.fact_json ->> 'external_id') f.fact_json as j, f.provenance_json as p
      from public.discovery_facts f
     where f.source_run_id = p_run_id and f.tenant_id = p_tenant_id
       and f.source_provider = p_provider and f.fact_type = 'identity_account'
       and f.fact_json ->> 'external_id' is not null
       and (f.fact_json ->> 'connection_id') is not distinct from v_connector_id::text
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
      p_tenant_id, v_connector_id, p_provider, j ->> 'external_id',
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
      last_seen_at = now(), sync_status = 'current', last_discovery_run_id = p_run_id, stale_since = null,
      schema_version = excluded.schema_version, sanitizer_version = excluded.sanitizer_version,
      normalizer_version = excluded.normalizer_version, source_endpoint = excluded.source_endpoint, updated_at = now()
      -- first_seen_at intentionally NOT updated (preserved); raw_payload NEVER set.
    returning external_id as ext
  )
  select count(*) filter (where not exists (select 1 from existing e where e.ext = u.ext)),
         count(*) filter (where exists (select 1 from existing e where e.ext = u.ext))
    into v_created, v_updated from upserted u;

  update public.connector_run_discovery set facts_inserted = v_created, facts_updated = v_updated where run_id = p_run_id;
  return jsonb_build_object('identitiesCreated', v_created, 'identitiesUpdated', v_updated);
end;
$$;

create or replace function public.runner_mark_absent_directory_users_stale(p_run_id uuid, p_tenant_id uuid, p_provider text)
  returns jsonb
  language plpgsql security definer set search_path = ''
as $$
declare
  v_connector_id uuid;
  v_prior_current integer; v_absent integer; v_absent_pct numeric;
  v_pct_threshold numeric; v_abs_threshold integer; v_marked integer := 0;
begin
  v_connector_id := public.runner_resolve_directory_run(p_run_id, p_tenant_id, p_provider);
  -- serialize stale/promote on this connection (TOCTOU guard).
  perform 1 from public.connectors c where c.id = v_connector_id and c.tenant_id = p_tenant_id for update;

  if not public.runner_stale_eligible(p_run_id, p_tenant_id, v_connector_id) then
    return jsonb_build_object('staleMarked', 0, 'absentCount', 0, 'priorCurrent', 0, 'circuitBreakerTriggered', false, 'eligible', false);
  end if;

  -- FIRST RUN rule: nothing was last seen by an EARLIER run -> this is the first complete promotion -> stale ZERO.
  if not exists (
    select 1 from public.identity_accounts ia
     where ia.tenant_id = p_tenant_id and ia.connection_id = v_connector_id and ia.provider = p_provider
       and ia.last_discovery_run_id is distinct from p_run_id
  ) then
    return jsonb_build_object('staleMarked', 0, 'absentCount', 0, 'priorCurrent', 0, 'circuitBreakerTriggered', false, 'eligible', true, 'firstRun', true);
  end if;

  select count(*) filter (where ia.sync_status = 'current'),
         count(*) filter (where ia.sync_status = 'current' and ia.last_discovery_run_id is distinct from p_run_id)
    into v_prior_current, v_absent
    from public.identity_accounts ia
   where ia.tenant_id = p_tenant_id and ia.connection_id = v_connector_id and ia.provider = p_provider;

  select p.stale_percent_threshold, p.stale_absolute_threshold into v_pct_threshold, v_abs_threshold
    from public.connector_discovery_policy p where p.provider = p_provider;
  v_pct_threshold := coalesce(v_pct_threshold, 30);
  v_abs_threshold := coalesce(v_abs_threshold, 100);
  v_absent_pct := case when v_prior_current > 0 then (v_absent::numeric * 100.0 / v_prior_current) else 0 end;

  if v_absent > v_abs_threshold or v_absent_pct > v_pct_threshold then
    update public.connector_run_discovery set review_required = true where run_id = p_run_id;
    return jsonb_build_object('staleMarked', 0, 'absentCount', v_absent, 'priorCurrent', v_prior_current, 'absentPct', round(v_absent_pct, 2), 'circuitBreakerTriggered', true, 'eligible', true);
  end if;

  update public.identity_accounts ia
     set sync_status = 'stale', stale_since = now(), updated_at = now()
   where ia.tenant_id = p_tenant_id and ia.connection_id = v_connector_id and ia.provider = p_provider
     and ia.sync_status = 'current' and ia.last_discovery_run_id is distinct from p_run_id;
  get diagnostics v_marked = row_count;
  return jsonb_build_object('staleMarked', v_marked, 'absentCount', v_absent, 'priorCurrent', v_prior_current, 'circuitBreakerTriggered', false, 'eligible', true);
end;
$$;

-- ══ F. GROUPS: promote + stale ═══════════════════════════════════════════════════════════════════════════════════════
create or replace function public.runner_promote_directory_groups(p_run_id uuid, p_tenant_id uuid, p_provider text)
  returns jsonb
  language plpgsql security definer set search_path = ''
as $$
declare
  v_connector_id uuid; v_created integer := 0; v_updated integer := 0;
begin
  v_connector_id := public.runner_resolve_directory_run(p_run_id, p_tenant_id, p_provider);
  perform public.runner_assert_promotable(p_run_id, p_tenant_id, v_connector_id);

  with existing as (
    select dg.external_id as ext from public.directory_groups dg
     where dg.tenant_id = p_tenant_id and dg.connection_id = v_connector_id and dg.provider = p_provider and dg.external_id is not null
  ),
  src as (
    select distinct on (f.fact_json ->> 'external_id') f.fact_json as j, f.provenance_json as p
      from public.discovery_facts f
     where f.source_run_id = p_run_id and f.tenant_id = p_tenant_id
       and f.source_provider = p_provider and f.fact_type = 'directory_group'
       and f.fact_json ->> 'external_id' is not null
       and (f.fact_json ->> 'connection_id') is not distinct from v_connector_id::text
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
      p_tenant_id, v_connector_id, p_provider, j ->> 'external_id',
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
      last_seen_at = now(), sync_status = 'current', last_discovery_run_id = p_run_id, stale_since = null,
      schema_version = excluded.schema_version, sanitizer_version = excluded.sanitizer_version,
      normalizer_version = excluded.normalizer_version, source_endpoint = excluded.source_endpoint, updated_at = now()
    returning external_id as ext
  )
  select count(*) filter (where not exists (select 1 from existing e where e.ext = u.ext)),
         count(*) filter (where exists (select 1 from existing e where e.ext = u.ext))
    into v_created, v_updated from upserted u;

  update public.connector_run_discovery set facts_inserted = v_created, facts_updated = v_updated where run_id = p_run_id;
  return jsonb_build_object('groupsCreated', v_created, 'groupsUpdated', v_updated);
end;
$$;

create or replace function public.runner_mark_absent_directory_groups_stale(p_run_id uuid, p_tenant_id uuid, p_provider text)
  returns jsonb
  language plpgsql security definer set search_path = ''
as $$
declare
  v_connector_id uuid;
  v_prior_current integer; v_absent integer; v_absent_pct numeric;
  v_pct_threshold numeric; v_abs_threshold integer; v_marked integer := 0;
begin
  v_connector_id := public.runner_resolve_directory_run(p_run_id, p_tenant_id, p_provider);
  perform 1 from public.connectors c where c.id = v_connector_id and c.tenant_id = p_tenant_id for update;

  if not public.runner_stale_eligible(p_run_id, p_tenant_id, v_connector_id) then
    return jsonb_build_object('staleMarked', 0, 'absentCount', 0, 'priorCurrent', 0, 'circuitBreakerTriggered', false, 'eligible', false);
  end if;

  if not exists (
    select 1 from public.directory_groups dg
     where dg.tenant_id = p_tenant_id and dg.connection_id = v_connector_id and dg.provider = p_provider
       and dg.last_discovery_run_id is distinct from p_run_id
  ) then
    return jsonb_build_object('staleMarked', 0, 'absentCount', 0, 'priorCurrent', 0, 'circuitBreakerTriggered', false, 'eligible', true, 'firstRun', true);
  end if;

  select count(*) filter (where dg.sync_status = 'current'),
         count(*) filter (where dg.sync_status = 'current' and dg.last_discovery_run_id is distinct from p_run_id)
    into v_prior_current, v_absent
    from public.directory_groups dg
   where dg.tenant_id = p_tenant_id and dg.connection_id = v_connector_id and dg.provider = p_provider;

  select p.stale_percent_threshold, p.stale_absolute_threshold into v_pct_threshold, v_abs_threshold
    from public.connector_discovery_policy p where p.provider = p_provider;
  v_pct_threshold := coalesce(v_pct_threshold, 30);
  v_abs_threshold := coalesce(v_abs_threshold, 100);
  v_absent_pct := case when v_prior_current > 0 then (v_absent::numeric * 100.0 / v_prior_current) else 0 end;

  if v_absent > v_abs_threshold or v_absent_pct > v_pct_threshold then
    update public.connector_run_discovery set review_required = true where run_id = p_run_id;
    return jsonb_build_object('staleMarked', 0, 'absentCount', v_absent, 'priorCurrent', v_prior_current, 'absentPct', round(v_absent_pct, 2), 'circuitBreakerTriggered', true, 'eligible', true);
  end if;

  update public.directory_groups dg
     set sync_status = 'stale', stale_since = now(), updated_at = now()
   where dg.tenant_id = p_tenant_id and dg.connection_id = v_connector_id and dg.provider = p_provider
     and dg.sync_status = 'current' and dg.last_discovery_run_id is distinct from p_run_id;
  get diagnostics v_marked = row_count;
  return jsonb_build_object('staleMarked', v_marked, 'absentCount', v_absent, 'priorCurrent', v_prior_current, 'circuitBreakerTriggered', false, 'eligible', true);
end;
$$;

-- ══ G. GROUP MEMBERSHIPS: promote + stale ════════════════════════════════════════════════════════════════════════════
-- DUAL-ENDPOINT RESOLUTION is fail-closed, exactly as in 0056: every distinct edge for this run must resolve to a unique
-- canonical group AND identity for this exact tenant+connection+provider, or the whole promotion rolls back.
--
-- A Google-specific consequence worth stating: a Google group may contain members that are NOT directory users — a nested
-- GROUP, the whole CUSTOMER domain, or an EXTERNAL address. Those have no identity_accounts row and can never satisfy the
-- FK. The runner therefore emits an edge FACT only for USER-type members it resolved, and records the others as evidence
-- only. That is a real coverage limit, and it is recorded in the run's provenance rather than hidden by a filter here.
create or replace function public.runner_promote_directory_group_memberships(p_run_id uuid, p_tenant_id uuid, p_provider text)
  returns jsonb
  language plpgsql security definer set search_path = ''
as $$
declare
  v_connector_id uuid; v_unresolved_groups integer := 0; v_unresolved_identities integer := 0;
  v_created integer := 0; v_updated integer := 0;
begin
  v_connector_id := public.runner_resolve_directory_run(p_run_id, p_tenant_id, p_provider);
  perform public.runner_assert_promotable(p_run_id, p_tenant_id, v_connector_id);

  select count(*) filter (where dg.id is null), count(*) filter (where ia.id is null)
    into v_unresolved_groups, v_unresolved_identities
    from (
      select distinct on (f.fact_json ->> 'group_external_id', f.fact_json ->> 'user_external_id')
             f.fact_json ->> 'group_external_id' as gext, f.fact_json ->> 'user_external_id' as uext
        from public.discovery_facts f
       where f.source_run_id = p_run_id and f.tenant_id = p_tenant_id and f.source_provider = p_provider
         and f.fact_type = 'directory_group_membership'
         and f.fact_json ->> 'group_external_id' is not null and f.fact_json ->> 'user_external_id' is not null
         and (f.fact_json ->> 'connection_id') is not distinct from v_connector_id::text
       order by f.fact_json ->> 'group_external_id', f.fact_json ->> 'user_external_id'
    ) s
    left join public.directory_groups dg on dg.tenant_id = p_tenant_id and dg.connection_id = v_connector_id and dg.provider = p_provider and dg.external_id = s.gext
    left join public.identity_accounts ia on ia.tenant_id = p_tenant_id and ia.connection_id = v_connector_id and ia.provider = p_provider and ia.external_id = s.uext;
  if coalesce(v_unresolved_groups, 0) > 0 or coalesce(v_unresolved_identities, 0) > 0 then
    raise exception 'run % has unresolved membership endpoints (unresolvedGroups=%, unresolvedIdentities=%); refusing to promote', p_run_id, v_unresolved_groups, v_unresolved_identities;
  end if;

  with existing as (
    select m.directory_group_id as g, m.identity_account_id as i from public.directory_group_memberships m
     where m.tenant_id = p_tenant_id and m.connection_id = v_connector_id and m.provider = p_provider
  ),
  src as (
    select distinct on (f.fact_json ->> 'group_external_id', f.fact_json ->> 'user_external_id')
           f.fact_json ->> 'group_external_id' as gext, f.fact_json ->> 'user_external_id' as uext, f.provenance_json as p
      from public.discovery_facts f
     where f.source_run_id = p_run_id and f.tenant_id = p_tenant_id and f.source_provider = p_provider
       and f.fact_type = 'directory_group_membership'
       and f.fact_json ->> 'group_external_id' is not null and f.fact_json ->> 'user_external_id' is not null
       and (f.fact_json ->> 'connection_id') is not distinct from v_connector_id::text
     order by f.fact_json ->> 'group_external_id', f.fact_json ->> 'user_external_id', f.observed_at desc
  ),
  resolved as (
    select dg.id as dg_id, ia.id as ia_id, s.p as p from src s
      join public.directory_groups dg on dg.tenant_id = p_tenant_id and dg.connection_id = v_connector_id and dg.provider = p_provider and dg.external_id = s.gext
      join public.identity_accounts ia on ia.tenant_id = p_tenant_id and ia.connection_id = v_connector_id and ia.provider = p_provider and ia.external_id = s.uext
  ),
  upserted as (
    insert into public.directory_group_memberships (
      tenant_id, connection_id, provider, directory_group_id, identity_account_id,
      first_seen_at, last_seen_at, sync_status, last_discovery_run_id,
      schema_version, sanitizer_version, normalizer_version, source_endpoint, created_at, updated_at
    )
    select p_tenant_id, v_connector_id, p_provider, r.dg_id, r.ia_id,
           now(), now(), 'current', p_run_id,
           r.p ->> 'schema_version', r.p ->> 'sanitizer_version', r.p ->> 'normalizer_version', r.p ->> 'source_endpoint', now(), now()
      from resolved r
    on conflict (tenant_id, connection_id, provider, directory_group_id, identity_account_id)
    do update set last_seen_at = now(), sync_status = 'current', last_discovery_run_id = p_run_id, stale_since = null,
                  schema_version = excluded.schema_version, sanitizer_version = excluded.sanitizer_version,
                  normalizer_version = excluded.normalizer_version, source_endpoint = excluded.source_endpoint, updated_at = now()
    returning directory_group_id as g, identity_account_id as i
  )
  select count(*) filter (where not exists (select 1 from existing e where e.g = u.g and e.i = u.i)),
         count(*) filter (where exists (select 1 from existing e where e.g = u.g and e.i = u.i))
    into v_created, v_updated from upserted u;

  update public.connector_run_discovery set facts_inserted = v_created, facts_updated = v_updated where run_id = p_run_id;
  return jsonb_build_object('membershipsCreated', v_created, 'membershipsUpdated', v_updated);
end;
$$;

create or replace function public.runner_mark_absent_directory_group_memberships_stale(p_run_id uuid, p_tenant_id uuid, p_provider text)
  returns jsonb
  language plpgsql security definer set search_path = ''
as $$
declare
  v_connector_id uuid;
  v_prior_current integer; v_absent integer; v_absent_pct numeric;
  v_pct_threshold numeric; v_abs_threshold integer; v_marked integer := 0;
begin
  v_connector_id := public.runner_resolve_directory_run(p_run_id, p_tenant_id, p_provider);
  perform 1 from public.connectors c where c.id = v_connector_id and c.tenant_id = p_tenant_id for update;

  if not public.runner_stale_eligible(p_run_id, p_tenant_id, v_connector_id) then
    return jsonb_build_object('staleMarked', 0, 'absentCount', 0, 'priorCurrent', 0, 'circuitBreakerTriggered', false, 'eligible', false);
  end if;

  if not exists (
    select 1 from public.directory_group_memberships m
     where m.tenant_id = p_tenant_id and m.connection_id = v_connector_id and m.provider = p_provider
       and m.last_discovery_run_id is distinct from p_run_id
  ) then
    return jsonb_build_object('staleMarked', 0, 'absentCount', 0, 'priorCurrent', 0, 'circuitBreakerTriggered', false, 'eligible', true, 'firstRun', true);
  end if;

  select count(*) filter (where m.sync_status = 'current'),
         count(*) filter (where m.sync_status = 'current' and m.last_discovery_run_id is distinct from p_run_id)
    into v_prior_current, v_absent
    from public.directory_group_memberships m
   where m.tenant_id = p_tenant_id and m.connection_id = v_connector_id and m.provider = p_provider;

  select p.stale_percent_threshold, p.stale_absolute_threshold into v_pct_threshold, v_abs_threshold
    from public.connector_discovery_policy p where p.provider = p_provider;
  v_pct_threshold := coalesce(v_pct_threshold, 30);
  v_abs_threshold := coalesce(v_abs_threshold, 100);
  v_absent_pct := case when v_prior_current > 0 then (v_absent::numeric * 100.0 / v_prior_current) else 0 end;

  if v_absent > v_abs_threshold or v_absent_pct > v_pct_threshold then
    update public.connector_run_discovery set review_required = true where run_id = p_run_id;
    return jsonb_build_object('staleMarked', 0, 'absentCount', v_absent, 'priorCurrent', v_prior_current, 'absentPct', round(v_absent_pct, 2), 'circuitBreakerTriggered', true, 'eligible', true);
  end if;

  update public.directory_group_memberships m
     set sync_status = 'stale', stale_since = now(), updated_at = now()
   where m.tenant_id = p_tenant_id and m.connection_id = v_connector_id and m.provider = p_provider
     and m.sync_status = 'current' and m.last_discovery_run_id is distinct from p_run_id;
  get diagnostics v_marked = row_count;
  return jsonb_build_object('staleMarked', v_marked, 'absentCount', v_absent, 'priorCurrent', v_prior_current, 'circuitBreakerTriggered', false, 'eligible', true);
end;
$$;

-- ══ H. stale policy row ══════════════════════════════════════════════════════════════════════════════════════════════
-- The thresholds equal the coalesce defaults, so this row changes no behaviour today. It exists so the policy is VISIBLE
-- and tunable per provider without a code change, which is what the table is for.
insert into public.connector_discovery_policy (provider) values ('google_workspace') on conflict (provider) do nothing;

-- ══ I. grants — EXECUTE only, to connector_runner only ═══════════════════════════════════════════════════════════════
-- Direct table INSERT/UPDATE stays revoked; these SECURITY DEFINER functions are the ONLY write path.
revoke execute on function public.runner_assert_parameterized_provider(text) from public, anon, authenticated;
revoke execute on function public.runner_resolve_directory_run(uuid, uuid, text) from public, anon, authenticated;
revoke execute on function public.runner_assert_promotable(uuid, uuid, uuid) from public, anon, authenticated;
revoke execute on function public.runner_stale_eligible(uuid, uuid, uuid) from public, anon, authenticated;
revoke execute on function public.runner_record_directory_discovery_metrics(uuid, uuid, text, integer, integer, integer, integer, integer, text, boolean, text, text, text, text) from public, anon, authenticated;
revoke execute on function public.runner_promote_directory_users(uuid, uuid, text) from public, anon, authenticated;
revoke execute on function public.runner_mark_absent_directory_users_stale(uuid, uuid, text) from public, anon, authenticated;
revoke execute on function public.runner_promote_directory_groups(uuid, uuid, text) from public, anon, authenticated;
revoke execute on function public.runner_mark_absent_directory_groups_stale(uuid, uuid, text) from public, anon, authenticated;
revoke execute on function public.runner_promote_directory_group_memberships(uuid, uuid, text) from public, anon, authenticated;
revoke execute on function public.runner_mark_absent_directory_group_memberships_stale(uuid, uuid, text) from public, anon, authenticated;

grant execute on function public.runner_record_directory_discovery_metrics(uuid, uuid, text, integer, integer, integer, integer, integer, text, boolean, text, text, text, text) to connector_runner;
grant execute on function public.runner_promote_directory_users(uuid, uuid, text) to connector_runner;
grant execute on function public.runner_mark_absent_directory_users_stale(uuid, uuid, text) to connector_runner;
grant execute on function public.runner_promote_directory_groups(uuid, uuid, text) to connector_runner;
grant execute on function public.runner_mark_absent_directory_groups_stale(uuid, uuid, text) to connector_runner;
grant execute on function public.runner_promote_directory_group_memberships(uuid, uuid, text) to connector_runner;
grant execute on function public.runner_mark_absent_directory_group_memberships_stale(uuid, uuid, text) to connector_runner;
-- The helpers are called INTERNALLY by the SECURITY DEFINER functions above (which run as owner), so connector_runner
-- needs no direct grant on them. Left revoked deliberately: a caller must go through a resource function, never assemble
-- its own eligibility decision.
