-- 0057_okta_directory_application_persistence.sql
--
-- Phase 10 (Okta directory APPLICATION discovery) — the durable, tenant- and connection-scoped application persistence model, the
-- structural analogue of 0054 (directory GROUPS): a single-object promote/stale, NOT the 0056 dual-endpoint edge. Per the approved
-- design: the canonical Okta DIRECTORY APPLICATION store is a NEW provider-neutral table public.directory_applications — a distinct
-- object class from the OPERATIONAL public.apps (0001), the CUSTOMER-EDITABLE canonical catalog public.app_products (0024), and the
-- matching table public.app_aliases (0024). This migration (all ADDITIVE): (A) creates directory_applications with connection/
-- freshness/provenance columns, a sync_status enum, bounded sign-on/status CATEGORY columns (never the raw provider value), the
-- immutable-identity unique key (tenant_id, connection_id, provider, external_id), a same-tenant composite FK to connectors, AND an
-- OPTIONAL nullable catalog_product_id link (same-tenant FK -> app_products, on delete set null) that stays NULL/unmatched in this
-- phase; (B) REUSES the 0053 per-run metrics companion (connector_run_discovery), its recorder, and the stale policy unchanged — an
-- application run is a SEPARATE connector_run distinguished by fact_type; (C) adds the 'directory_application' fact_type + a positive-key
-- allowlist to the write boundary; (D) a complete-run-only promotion RPC facts -> directory_applications; (E) a stale RPC with
-- evidence-based eligibility + circuit breaker. All runner writes go through SECURITY DEFINER functions (fixed empty search_path,
-- schema-qualified) granted ONLY to connector_runner; NO direct table write grant. There is NO raw_payload column.
--
-- IMMUTABLE IDENTITY = external_id (the Okta 0oa... app id). label/name/status/sign-on are MUTABLE optional attributes (a rename is an
-- attribute update), NEVER a uniqueness key. NO ASSIGNMENTS: no app-user table, no app-group table, no assignment field, and the app
-- users/groups sub-resources are never fetched — keeping the write path closed is what enforces "no assignments yet". CATALOG MATCHING
-- IS OPTIONAL AND DEFERRED: catalog_product_id stays NULL (catalog_match_status 'unmatched') in this phase; the promote RPC NEVER writes
-- public.app_products / vendors / app_aliases (customer-editable catalog), and a missing match NEVER fails the promotion. NON-DESTRUCTIVE:
-- CREATE TABLE|INDEX|FUNCTION / GRANT|REVOKE only. ACTIVATES nothing. Staging only; RISK-007 OPEN; Phase C BLOCKED; no schedule, no
-- active, no registry.

begin;

-- ══ A. CREATE directory_applications (the canonical, provider-neutral Okta directory APPLICATION store) ═══════════════════
create table if not exists public.directory_applications (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  connection_id uuid not null,
  provider text not null,
  external_id text not null,                                 -- Okta app id (0oa...) — immutable provider identity
  name text,                                                 -- app-type key (e.g. "salesforce") — MUTABLE, optional
  normalized_name text,
  label text,                                                -- display label — MUTABLE (rename = attribute update), NEVER a key
  status_category text,                                      -- SAFE bounded status bucket (never the raw provider status value)
  sign_on_category text,                                     -- SAFE bounded sign-on-mode bucket (never the raw provider signOnMode)
  provider_created_at timestamptz,
  provider_last_updated_at timestamptz,
  -- OPTIONAL, DEFERRED catalog link — stays NULL/unmatched in Phase 10; a future human-reviewed matcher may populate it. The provider
  -- application persists fully WITHOUT a catalog match; this link is NEVER part of provider identity and NEVER mutates app_products.
  catalog_product_id uuid,
  catalog_match_status text not null default 'unmatched',
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
  -- sync_status vocabulary (mirrors directory_groups, 0054).
  constraint directory_applications_sync_status_chk check (sync_status in ('current', 'stale', 'review_required', 'disconnected')),
  -- status_category / sign_on_category are fixed SAFE aggregate buckets (categorizeOktaAppStatus / categorizeOktaSignOnMode), never a
  -- raw provider value. Nullable (a fact may omit them); when present they must be an approved bucket.
  constraint directory_applications_status_category_chk check (status_category is null or status_category in ('active', 'inactive', 'other', 'missing')),
  constraint directory_applications_sign_on_category_chk check (sign_on_category is null or sign_on_category in ('saml_2_0', 'openid_connect', 'auto_login', 'bookmark', 'secure_password_store', 'ws_federation', 'browser_plugin', 'other', 'missing')),
  -- catalog match lifecycle (advisory; unmatched by default in Phase 10).
  constraint directory_applications_catalog_match_status_chk check (catalog_match_status in ('unmatched', 'matched', 'ambiguous', 'review_required')),
  -- Same-tenant connection binding: (connection_id, tenant_id) -> connectors(id, tenant_id). connection_id is NOT NULL.
  constraint directory_applications_connection_same_tenant
    foreign key (connection_id, tenant_id) references public.connectors (id, tenant_id) on delete cascade,
  -- OPTIONAL same-tenant catalog link -> app_products(id, tenant_id) (customer-editable catalog). ON DELETE SET NULL (catalog_product_id)
  -- so a catalog product delete nulls ONLY the link, never destroys the provider-instance row and never nulls the NOT-NULL tenant_id
  -- (the PG15 column-list form is required here — a bare composite SET NULL would null tenant_id too). This is a REFERENCE only — no
  -- write grant on app_products.
  constraint directory_applications_catalog_product_same_tenant
    foreign key (catalog_product_id, tenant_id) references public.app_products (id, tenant_id) match simple on delete set null (catalog_product_id)
);

-- Immutable provider identity: unique per (tenant, connection, provider, external_id). label/name are NEVER part of the key.
create unique index if not exists directory_applications_provider_identity_idx
  on public.directory_applications (tenant_id, connection_id, provider, external_id)
  where connection_id is not null and external_id is not null;
create index if not exists directory_applications_connection_idx on public.directory_applications (tenant_id, connection_id);
create index if not exists directory_applications_sync_status_idx on public.directory_applications (tenant_id, connection_id, sync_status);
create index if not exists directory_applications_catalog_idx on public.directory_applications (tenant_id, catalog_product_id);

alter table public.directory_applications enable row level security; -- deny-all to anon/authenticated; only SECURITY DEFINER reads/writes

-- ══ B. per-run metrics + stale policy — REUSED from 0053, NOT re-created ════════════════════════════════════════════════
-- connector_run_discovery (1:1 per run), runner_record_okta_discovery_metrics(...), connector_discovery_policy already exist (0053).
-- An application run is a SEPARATE connector_run with its OWN metrics row keyed by run_id; promotion/stale scope by run_id + fact_type,
-- so they never contaminate the user/group/membership lifecycle. No new metrics table, policy row, or column needed.

-- ══ C. add the 'directory_application' fact_type + positive-key allowlist to the write boundary ═════════════════════════
-- CREATE OR REPLACE with the SAME 11-arg signature preserves the grant; the allowlist gains 'directory_application'. All prior fact
-- types + their positive-key blocks (identity_account/directory_group/directory_group_membership) are preserved verbatim.
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
  -- directory_group_membership (Phase 8) + directory_application (Phase 10). App-scoped 'group_membership'/'app_discovery' stay ABSENT.
  if p_fact_type not in ('app_user_account', 'group', 'identity_account', 'directory_group', 'directory_group_membership', 'directory_application') then
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
  -- directory_application: POSITIVE top-level key ALLOWLIST — ONLY approved provider-neutral application fields. Deliberately EXCLUDES
  -- any assignment field (users/groups), _links/_embedded/credentials/settings/profile, URLs/client-id, and the raw provider status/
  -- signOnMode value (only the safe categorized buckets are allowed).
  if p_fact_type = 'directory_application' and exists (
    select 1 from jsonb_object_keys(p_fact_json) k
     where k not in ('fact_type','external_id','connection_id','name','normalized_name','label','status_category','sign_on_category',
                     'provider_created_at','provider_last_updated_at')
  ) then
    raise exception 'directory_application fact_json contains a non-approved key';
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

-- ══ D. PROMOTION: facts -> directory_applications, ONLY after a complete + clean run. Catalog link stays NULL (unmatched). ══
create or replace function public.runner_promote_okta_directory_applications(p_run_id uuid, p_tenant_id uuid)
  returns jsonb
  language plpgsql security definer set search_path = ''
as $$
declare
  v_connector_id uuid;
  v_complete boolean; v_rejected integer; v_termination text; v_review boolean;
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

  -- upsert directory_applications from THIS run's directory_application facts. connection_id server-derived; fact must CARRY the
  -- matching connection_id; DISTINCT-ON external_id (dup defense). first_seen preserved; last_seen advanced; sync_status=current.
  -- catalog_product_id / catalog_match_status are DELIBERATELY NOT written here (INSERT takes the NULL/'unmatched' defaults; DO UPDATE
  -- leaves them untouched) — catalog matching is a separate, deferred, human-reviewable concern and NEVER mutates app_products.
  with existing as (
    select da.external_id as ext from public.directory_applications da
     where da.tenant_id = p_tenant_id and da.connection_id = v_connector_id and da.provider = 'okta' and da.external_id is not null
  ),
  src as (
    select distinct on (f.fact_json ->> 'external_id') f.fact_json as j, f.provenance_json as p
      from public.discovery_facts f
     where f.source_run_id = p_run_id and f.tenant_id = p_tenant_id
       and f.source_provider = 'okta' and f.fact_type = 'directory_application'
       and f.fact_json ->> 'external_id' is not null
       and (f.fact_json ->> 'connection_id') is not distinct from v_connector_id::text
     order by f.fact_json ->> 'external_id', f.observed_at desc
  ),
  upserted as (
    insert into public.directory_applications (
      tenant_id, connection_id, provider, external_id,
      name, normalized_name, label, status_category, sign_on_category,
      provider_created_at, provider_last_updated_at,
      first_seen_at, last_seen_at, sync_status, last_discovery_run_id,
      schema_version, sanitizer_version, normalizer_version, source_endpoint, created_at, updated_at
    )
    select
      p_tenant_id, v_connector_id, 'okta', j ->> 'external_id',
      j ->> 'name', j ->> 'normalized_name', j ->> 'label', j ->> 'status_category', j ->> 'sign_on_category',
      (j ->> 'provider_created_at')::timestamptz, (j ->> 'provider_last_updated_at')::timestamptz,
      now(), now(), 'current', p_run_id,
      p ->> 'schema_version', p ->> 'sanitizer_version', p ->> 'normalizer_version', p ->> 'source_endpoint', now(), now()
    from src
    on conflict (tenant_id, connection_id, provider, external_id) where connection_id is not null and external_id is not null
    do update set
      name = excluded.name, normalized_name = excluded.normalized_name, label = excluded.label,
      status_category = excluded.status_category, sign_on_category = excluded.sign_on_category,
      provider_created_at = excluded.provider_created_at, provider_last_updated_at = excluded.provider_last_updated_at,
      last_seen_at = now(), sync_status = 'current', last_discovery_run_id = p_run_id, stale_since = null,
      schema_version = excluded.schema_version, sanitizer_version = excluded.sanitizer_version,
      normalizer_version = excluded.normalizer_version, source_endpoint = excluded.source_endpoint, updated_at = now()
      -- first_seen_at preserved; catalog_product_id / catalog_match_status intentionally untouched; no raw_payload column.
    returning external_id as ext
  )
  select count(*) filter (where not exists (select 1 from existing e where e.ext = u.ext)),
         count(*) filter (where exists (select 1 from existing e where e.ext = u.ext))
    into v_created, v_updated
    from upserted u;

  update public.connector_run_discovery set facts_inserted = v_created, facts_updated = v_updated where run_id = p_run_id;
  return jsonb_build_object('applicationsCreated', v_created, 'applicationsUpdated', v_updated);
end;
$$;

-- ══ E. STALE: evidence-based eligibility + configurable mass-staleness circuit breaker. First run stales ZERO. ═══════════
create or replace function public.runner_mark_absent_okta_directory_applications_stale(p_run_id uuid, p_tenant_id uuid)
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

  -- FIRST RUN rule: if no application for this connection was last seen by a DIFFERENT run, this is the first complete promotion -> stale ZERO.
  if not exists (
    select 1 from public.directory_applications da
     where da.tenant_id = p_tenant_id and da.connection_id = v_connector_id and da.provider = 'okta'
       and da.last_discovery_run_id is distinct from p_run_id
  ) then
    return jsonb_build_object('staleMarked', 0, 'absentCount', 0, 'priorCurrent', 0, 'circuitBreakerTriggered', false, 'eligible', true, 'firstRun', true);
  end if;

  select count(*) filter (where da.sync_status = 'current'),
         count(*) filter (where da.sync_status = 'current' and da.last_discovery_run_id is distinct from p_run_id)
    into v_prior_current, v_absent
    from public.directory_applications da
   where da.tenant_id = p_tenant_id and da.connection_id = v_connector_id and da.provider = 'okta';

  select p.stale_percent_threshold, p.stale_absolute_threshold into v_pct_threshold, v_abs_threshold
    from public.connector_discovery_policy p where p.provider = 'okta';
  v_pct_threshold := coalesce(v_pct_threshold, 30);
  v_abs_threshold := coalesce(v_abs_threshold, 100);
  v_absent_pct := case when v_prior_current > 0 then (v_absent::numeric * 100.0 / v_prior_current) else 0 end;

  if v_absent > v_abs_threshold or v_absent_pct > v_pct_threshold then
    update public.connector_run_discovery set review_required = true where run_id = p_run_id;
    return jsonb_build_object('staleMarked', 0, 'absentCount', v_absent, 'priorCurrent', v_prior_current, 'absentPct', round(v_absent_pct, 2), 'circuitBreakerTriggered', true, 'eligible', true);
  end if;

  update public.directory_applications da
     set sync_status = 'stale', stale_since = now(), updated_at = now()
   where da.tenant_id = p_tenant_id and da.connection_id = v_connector_id and da.provider = 'okta'
     and da.sync_status = 'current' and da.last_discovery_run_id is distinct from p_run_id;
  get diagnostics v_marked = row_count;
  return jsonb_build_object('staleMarked', v_marked, 'absentCount', v_absent, 'priorCurrent', v_prior_current, 'circuitBreakerTriggered', false, 'eligible', true);
end;
$$;

-- ══ F. least privilege (revoke from public + anon + authenticated; grant only to connector_runner) ═════════════════════
revoke execute on function public.runner_promote_okta_directory_applications(uuid, uuid) from public, anon, authenticated;
revoke execute on function public.runner_mark_absent_okta_directory_applications_stale(uuid, uuid) from public, anon, authenticated;
grant execute on function public.runner_promote_okta_directory_applications(uuid, uuid) to connector_runner;
grant execute on function public.runner_mark_absent_okta_directory_applications_stale(uuid, uuid) to connector_runner;
-- runner_insert_discovery_fact keeps its existing grant (CREATE OR REPLACE preserves privileges); re-assert least privilege.
revoke execute on function public.runner_insert_discovery_fact(uuid, uuid, text, text, text, text, text, timestamptz, numeric, jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.runner_insert_discovery_fact(uuid, uuid, text, text, text, text, text, timestamptz, numeric, jsonb, jsonb) to connector_runner;

-- directory_applications is runner-internal: reachable ONLY through the SECURITY DEFINER functions. Deny every request role + the
-- runner direct access (RLS enabled with no policy; revoke belt-and-suspenders since connector_runner is BYPASSRLS). A future
-- authorized UI list view would add a members-read SELECT policy + grant — deferred until such a consumer exists.
revoke all on public.directory_applications from public, anon, authenticated, connector_runner;

commit;
