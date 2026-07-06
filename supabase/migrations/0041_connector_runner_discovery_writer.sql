-- 0041_connector_runner_discovery_writer.sql
--
-- The Phase 2 DB WRITE BOUNDARY for connector-runner live sync: connector_runner writes discovery_facts + connector_runs
-- ONLY through three SECURITY DEFINER functions that validate the write. connector_runner gets EXECUTE on those functions
-- and NOTHING else — no direct INSERT/UPDATE/SELECT on either table.
--
-- WHY functions (not an RLS policy): connector_runner is `nologin BYPASSRLS` (0021), so an RLS policy would be ignored for
-- it; making one effective would mean removing BYPASSRLS / FORCE RLS — a larger blast radius that could regress the
-- staging-proven oauth_pending (0021) / lifecycle-events (0032/0033) write paths. Raw column grants suit append-only audit
-- tables, but discovery_facts is a DATA table warranting DB-boundary validation (tenant/connector/run ownership, a
-- fact_type allowlist, fact_json shape + forbidden-key scan) a raw grant cannot give. Decision: connector-runner
-- docs/CONNECTOR_SYNC_PHASE_2_RUNBOOK.md §5.
--
-- SCOPE — discovery_facts + connector_runs ONLY, via the 3 functions. connector_secrets is UNTOUCHED. No RLS change, no
-- BYPASSRLS change, no FORCE RLS, no unrelated grant. Each function is SECURITY DEFINER with a pinned empty search_path
-- (schema-qualified refs); pg_catalog stays implicitly first, so built-ins resolve. EXECUTE revoked from PUBLIC, granted
-- to connector_runner. Migration-safety: CREATE FUNCTION / CREATE INDEX / GRANT / REVOKE only — no teardown, no row purge.
-- RISK-007 remains OPEN; Phase C remains BLOCKED; staging only (never applied here). Proven under `set role
-- connector_runner` in supabase/tests/connector_runner_writer_test.sql.

-- ── Idempotency: one fact per (tenant, provider, fact_type, signal_id) when signal_id is present ───────────────────────
create unique index if not exists discovery_facts_runner_idem_idx
  on public.discovery_facts (tenant_id, source_provider, fact_type, signal_id)
  where signal_id is not null;

-- ── 1. open a run: validate the connector belongs to the tenant, then append a 'running' connector_runs row ────────────
create or replace function public.runner_open_connector_run(p_tenant_id uuid, p_connector_id uuid)
  returns uuid
  language plpgsql
  security definer
  set search_path = ''
as $$
declare
  v_run_id uuid;
begin
  if not exists (
    select 1 from public.connectors c where c.id = p_connector_id and c.tenant_id = p_tenant_id
  ) then
    raise exception 'connector % does not belong to tenant %', p_connector_id, p_tenant_id;
  end if;

  insert into public.connector_runs (tenant_id, connector_id, status, started_at)
    values (p_tenant_id, p_connector_id, 'running', now())
    returning id into v_run_id;
  return v_run_id;
end;
$$;

-- ── 2. finish a run: validate the run belongs to the tenant, then set terminal status/metrics only ────────────────────
create or replace function public.runner_finish_connector_run(
  p_run_id uuid, p_tenant_id uuid, p_status text, p_items_seen integer, p_error_class text
) returns void
  language plpgsql
  security definer
  set search_path = ''
as $$
begin
  -- terminal states per the 0019 six-state lifecycle
  if p_status not in ('succeeded', 'failed') then
    raise exception 'invalid terminal status %', p_status;
  end if;

  -- columns are the 0019 lifecycle names (completed_at / records_seen / failure_code)
  update public.connector_runs
     set status = p_status, completed_at = now(), records_seen = p_items_seen, failure_code = p_error_class
   where id = p_run_id and tenant_id = p_tenant_id;
  if not found then
    raise exception 'run % does not belong to tenant %', p_run_id, p_tenant_id;
  end if;
end;
$$;

-- ── 3. insert a validated discovery fact: run ownership + fact_type/source_type allowlist + fact_json shape +
--       forbidden-key scan, then INSERT the allowed columns only (schema_version pinned to '1'), idempotent ────────────
create or replace function public.runner_insert_discovery_fact(
  p_tenant_id uuid, p_source_run_id uuid, p_fact_type text, p_source_type text, p_source_provider text,
  p_signal_id text, p_natural_key text, p_observed_at timestamptz, p_confidence numeric,
  p_fact_json jsonb, p_provenance_json jsonb
) returns void
  language plpgsql
  security definer
  set search_path = ''
as $$
begin
  -- run ownership (source_run_id has no FK on discovery_facts; enforce it here)
  if not exists (
    select 1 from public.connector_runs r where r.id = p_source_run_id and r.tenant_id = p_tenant_id
  ) then
    raise exception 'source_run_id % does not belong to tenant %', p_source_run_id, p_tenant_id;
  end if;

  -- fact_type allowlist — constrains the free-text column at the write boundary (Phase 2: users + groups only)
  if p_fact_type not in ('app_user_account', 'group') then
    raise exception 'fact_type % is not in the Phase 2 allowlist', p_fact_type;
  end if;

  -- source_type allowlist — must match discovery-facts SourceTypeSchema
  if p_source_type not in (
    'identity_provider_discovery', 'deep_provider_sync', 'contract_intelligence', 'invoice_spend_import',
    'browser_extension_discovery', 'manual_csv_import', 'unknown_source'
  ) then
    raise exception 'source_type % is not a known discovery source type', p_source_type;
  end if;

  -- fact_json must be an object whose fact_type matches the parameter
  if p_fact_json is null or jsonb_typeof(p_fact_json) <> 'object' then
    raise exception 'fact_json must be a json object';
  end if;
  if p_fact_json ->> 'fact_type' is distinct from p_fact_type then
    raise exception 'fact_json.fact_type must match p_fact_type';
  end if;

  -- forbidden-key scan (defense in depth over the runner's own validation): reject any credential-shaped KEY at any
  -- depth in fact_json or provenance_json. Keys only, so a value like a display name never trips it.
  if exists (
    with recursive walk(v) as (
      select x from (values (p_fact_json), (coalesce(p_provenance_json, '{}'::jsonb))) as t(x)
      union all
      select child.v
        from walk w
        cross join lateral (
          select e.value as v from jsonb_each(w.v) e where jsonb_typeof(w.v) = 'object'
          union all
          select a.value as v from jsonb_array_elements(w.v) a where jsonb_typeof(w.v) = 'array'
        ) child
    )
    select 1 from walk w
      cross join lateral jsonb_object_keys(w.v) k
      where jsonb_typeof(w.v) = 'object'
        and lower(k) ~ '(token|secret|ciphertext|dek_wrapped|aead_)'
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
  on conflict (tenant_id, source_provider, fact_type, signal_id) where signal_id is not null do nothing;
end;
$$;

-- ── Least privilege: EXECUTE revoked from PUBLIC, granted only to connector_runner; NO direct table access ─────────────
revoke all on function public.runner_open_connector_run(uuid, uuid) from public;
revoke all on function public.runner_finish_connector_run(uuid, uuid, text, integer, text) from public;
revoke all on function public.runner_insert_discovery_fact(uuid, uuid, text, text, text, text, text, timestamptz, numeric, jsonb, jsonb) from public;

grant execute on function public.runner_open_connector_run(uuid, uuid) to connector_runner;
grant execute on function public.runner_finish_connector_run(uuid, uuid, text, integer, text) to connector_runner;
grant execute on function public.runner_insert_discovery_fact(uuid, uuid, text, text, text, text, text, timestamptz, numeric, jsonb, jsonb) to connector_runner;

-- Belt-and-suspenders: connector_runner must reach these tables ONLY through the functions above.
revoke all on public.discovery_facts from connector_runner;
revoke all on public.connector_runs from connector_runner;
