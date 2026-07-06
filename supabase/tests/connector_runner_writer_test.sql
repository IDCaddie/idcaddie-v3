-- connector_runner_writer_test.sql — verifies migration 0041 (the connector_runner SECURITY DEFINER write boundary).
--
-- ENVIRONMENT CONTRACT (provided by scripts/test-rls.sh, NOT this file): a local throwaway Postgres with ALL migrations
-- applied and the connector_runner role present (0021). Run with psql -v ON_ERROR_STOP=1. NEVER touches hosted Supabase.
-- Acting principal is switched via SET LOCAL ROLE connector_runner inside each DO block (auto-reset at block/txn end).

\set ON_ERROR_STOP on
reset role;

-- ── Fixtures (seeded as the privileged role; two tenants + a connector each; distinct UUIDs so they don't collide) ─────
insert into public.tenants (id, name, slug) values
  ('a0000000-0000-4000-8000-000000000001', 'Writer Test Tenant A', 'writer-test-a'),
  ('b0000000-0000-4000-8000-000000000002', 'Writer Test Tenant B', 'writer-test-b')
on conflict (id) do nothing;
insert into public.connectors (id, tenant_id, provider, status) values
  ('a1000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000001', 'slack', 'active'),
  ('b1000000-0000-4000-8000-000000000002', 'b0000000-0000-4000-8000-000000000002', 'slack', 'active')
on conflict (id) do nothing;

-- ── W1: grant shape — EXECUTE to connector_runner on the 3 functions, revoked from PUBLIC, NO direct table access ──────
do $$
begin
  assert     has_function_privilege('connector_runner', 'public.runner_open_connector_run(uuid,uuid)', 'EXECUTE'),                                                        'W1 runner EXECUTE runner_open_connector_run';
  assert     has_function_privilege('connector_runner', 'public.runner_finish_connector_run(uuid,uuid,text,integer,text)', 'EXECUTE'),                                    'W1 runner EXECUTE runner_finish_connector_run';
  assert     has_function_privilege('connector_runner', 'public.runner_insert_discovery_fact(uuid,uuid,text,text,text,text,text,timestamptz,numeric,jsonb,jsonb)', 'EXECUTE'), 'W1 runner EXECUTE runner_insert_discovery_fact';
  -- EXECUTE revoked from PUBLIC (no ambient caller)
  assert not has_function_privilege('public', 'public.runner_open_connector_run(uuid,uuid)', 'EXECUTE'),                                                                  'W1 PUBLIC must NOT execute runner_open_connector_run';
  assert not has_function_privilege('public', 'public.runner_finish_connector_run(uuid,uuid,text,integer,text)', 'EXECUTE'),                                              'W1 PUBLIC must NOT execute runner_finish_connector_run';
  assert not has_function_privilege('public', 'public.runner_insert_discovery_fact(uuid,uuid,text,text,text,text,text,timestamptz,numeric,jsonb,jsonb)', 'EXECUTE'),      'W1 PUBLIC must NOT execute runner_insert_discovery_fact';
  -- NO direct table privileges for connector_runner (writes go only through the functions)
  assert not has_table_privilege('connector_runner', 'public.discovery_facts', 'INSERT'), 'W1 runner must NOT INSERT discovery_facts directly';
  assert not has_table_privilege('connector_runner', 'public.discovery_facts', 'UPDATE'), 'W1 runner must NOT UPDATE discovery_facts directly';
  assert not has_table_privilege('connector_runner', 'public.discovery_facts', 'SELECT'), 'W1 runner must NOT SELECT discovery_facts directly';
  assert not has_table_privilege('connector_runner', 'public.discovery_facts', 'DELETE'), 'W1 runner must NOT DELETE discovery_facts directly';
  assert not has_table_privilege('connector_runner', 'public.connector_runs',  'INSERT'), 'W1 runner must NOT INSERT connector_runs directly';
  assert not has_table_privilege('connector_runner', 'public.connector_runs',  'UPDATE'), 'W1 runner must NOT UPDATE connector_runs directly';
  assert not has_table_privilege('connector_runner', 'public.connector_runs',  'SELECT'), 'W1 runner must NOT SELECT connector_runs directly';
end $$;

-- ── W2: search_path is pinned on all three functions (SECURITY DEFINER hardening) ─────────────────────────────────────
do $$
begin
  assert (select array_to_string(proconfig, ',') from pg_proc where proname = 'runner_open_connector_run')   like 'search_path=%', 'W2 runner_open_connector_run search_path pinned';
  assert (select array_to_string(proconfig, ',') from pg_proc where proname = 'runner_finish_connector_run') like 'search_path=%', 'W2 runner_finish_connector_run search_path pinned';
  assert (select array_to_string(proconfig, ',') from pg_proc where proname = 'runner_insert_discovery_fact') like 'search_path=%', 'W2 runner_insert_discovery_fact search_path pinned';
  assert (select prosecdef from pg_proc where proname = 'runner_insert_discovery_fact'), 'W2 runner_insert_discovery_fact must be SECURITY DEFINER';
end $$;

-- ── W3: happy path — open run → insert fact → finish run (all via the functions) ──────────────────────────────────────
do $$
declare v_run uuid;
begin
  set local role connector_runner;
  v_run := public.runner_open_connector_run('a0000000-0000-4000-8000-000000000001', 'a1000000-0000-4000-8000-000000000001');
  perform public.runner_insert_discovery_fact(
    'a0000000-0000-4000-8000-000000000001', v_run, 'app_user_account', 'identity_provider_discovery', 'slack',
    'U1', 'slack:U1', now(), 0.9,
    jsonb_build_object('fact_type', 'app_user_account', 'app_user_external_id', 'U1', 'email', 'user1@example.test'), null);
  perform public.runner_finish_connector_run(v_run, 'a0000000-0000-4000-8000-000000000001', 'succeeded', 1, null);
  reset role;
  assert (select count(*) from public.discovery_facts where source_run_id = v_run) = 1,        'W3 happy-path fact inserted';
  assert (select review_status from public.discovery_facts where source_run_id = v_run) = 'pending', 'W3 fact defaults to pending review';
  assert (select schema_version from public.discovery_facts where source_run_id = v_run) = '1',  'W3 schema_version pinned to 1';
  assert (select status from public.connector_runs where id = v_run) = 'succeeded',              'W3 run finished (succeeded)';
  assert (select records_seen from public.connector_runs where id = v_run) = 1,                  'W3 run records_seen recorded';
end $$;

-- ── W4: cross-tenant connector open is rejected ───────────────────────────────────────────────────────────────────────
do $$
declare ok boolean := false;
begin
  set local role connector_runner;
  begin
    perform public.runner_open_connector_run('a0000000-0000-4000-8000-000000000001', 'b1000000-0000-4000-8000-000000000002'); -- B's connector, A's tenant
  exception when others then ok := true; end;
  reset role;
  assert ok, 'W4 opening another tenant''s connector must be rejected';
end $$;

-- ── W5: a source_run_id from another tenant is rejected ───────────────────────────────────────────────────────────────
do $$
declare v_run_b uuid; ok boolean := false;
begin
  set local role connector_runner;
  v_run_b := public.runner_open_connector_run('b0000000-0000-4000-8000-000000000002', 'b1000000-0000-4000-8000-000000000002');
  begin
    perform public.runner_insert_discovery_fact(
      'a0000000-0000-4000-8000-000000000001', v_run_b, 'app_user_account', 'identity_provider_discovery', 'slack',
      'U9', 'slack:U9', now(), 0.9, jsonb_build_object('fact_type', 'app_user_account'), null);       -- A's tenant, B's run
  exception when others then ok := true; end;
  reset role;
  assert ok, 'W5 a source_run_id from another tenant must be rejected';
end $$;

-- ── W6-W9: fact validation rejects (each opens a valid run in tenant A first, so we reach the fact checks) ─────────────
do $$
declare v_run uuid; ok_type boolean := false; ok_obj boolean := false; ok_mismatch boolean := false; ok_key boolean := false;
begin
  set local role connector_runner;
  v_run := public.runner_open_connector_run('a0000000-0000-4000-8000-000000000001', 'a1000000-0000-4000-8000-000000000001');

  -- W6 invalid fact_type
  begin perform public.runner_insert_discovery_fact('a0000000-0000-4000-8000-000000000001', v_run, 'evil_type', 'identity_provider_discovery', 'slack', 'X1', null, now(), 0.9, jsonb_build_object('fact_type', 'evil_type'), null);
  exception when others then ok_type := true; end;

  -- W7 fact_json not an object
  begin perform public.runner_insert_discovery_fact('a0000000-0000-4000-8000-000000000001', v_run, 'group', 'identity_provider_discovery', 'slack', 'X2', null, now(), 0.9, '"not-an-object"'::jsonb, null);
  exception when others then ok_obj := true; end;

  -- W8 fact_json.fact_type mismatch
  begin perform public.runner_insert_discovery_fact('a0000000-0000-4000-8000-000000000001', v_run, 'app_user_account', 'identity_provider_discovery', 'slack', 'X3', null, now(), 0.9, jsonb_build_object('fact_type', 'group'), null);
  exception when others then ok_mismatch := true; end;

  -- W9 forbidden secret-like key
  begin perform public.runner_insert_discovery_fact('a0000000-0000-4000-8000-000000000001', v_run, 'app_user_account', 'identity_provider_discovery', 'slack', 'X4', null, now(), 0.9, jsonb_build_object('fact_type', 'app_user_account', 'access_token', 'EXAMPLE-not-a-real-token'), null);
  exception when others then ok_key := true; end;

  reset role;
  assert ok_type,     'W6 invalid fact_type must be rejected';
  assert ok_obj,      'W7 non-object fact_json must be rejected';
  assert ok_mismatch, 'W8 fact_json.fact_type mismatch must be rejected';
  assert ok_key,      'W9 forbidden secret-like key must be rejected';
  -- none of the four rejected inserts landed
  assert (select count(*) from public.discovery_facts where source_run_id = v_run) = 0, 'W6-W9 no rejected fact was written';
end $$;

-- ── W10: duplicate signal_id is idempotent (one row) ──────────────────────────────────────────────────────────────────
do $$
declare v_run uuid;
begin
  set local role connector_runner;
  v_run := public.runner_open_connector_run('a0000000-0000-4000-8000-000000000001', 'a1000000-0000-4000-8000-000000000001');
  perform public.runner_insert_discovery_fact('a0000000-0000-4000-8000-000000000001', v_run, 'group', 'identity_provider_discovery', 'slack', 'DUP', 'slack:DUP', now(), 0.9, jsonb_build_object('fact_type', 'group', 'group_external_id', 'G', 'group_name', 'G'), null);
  perform public.runner_insert_discovery_fact('a0000000-0000-4000-8000-000000000001', v_run, 'group', 'identity_provider_discovery', 'slack', 'DUP', 'slack:DUP', now(), 0.9, jsonb_build_object('fact_type', 'group', 'group_external_id', 'G', 'group_name', 'G'), null);
  reset role;
  assert (select count(*) from public.discovery_facts
            where tenant_id = 'a0000000-0000-4000-8000-000000000001' and source_provider = 'slack'
              and fact_type = 'group' and signal_id = 'DUP') = 1, 'W10 duplicate signal_id must be idempotent';
end $$;

-- ── W11: connector_runner cannot UPDATE/DELETE discovery_facts directly ───────────────────────────────────────────────
do $$
declare ok_upd boolean := false; ok_del boolean := false;
begin
  set local role connector_runner;
  begin update public.discovery_facts set review_status = 'confirmed'; exception when insufficient_privilege then ok_upd := true; end;
  begin delete from public.discovery_facts;                            exception when insufficient_privilege then ok_del := true; end;
  reset role;
  assert ok_upd, 'W11 connector_runner must NOT UPDATE discovery_facts directly';
  assert ok_del, 'W11 connector_runner must NOT DELETE discovery_facts directly';
end $$;

-- ── W12: connector_secrets grants unchanged (0041 must not touch them) ────────────────────────────────────────────────
do $$
begin
  assert not has_table_privilege('connector_runner', 'public.connector_secrets', 'SELECT'), 'W12 runner must NOT SELECT connector_secrets';
  assert not has_table_privilege('connector_runner', 'public.connector_secrets', 'INSERT'), 'W12 runner must NOT INSERT connector_secrets';
  assert not has_table_privilege('connector_runner', 'public.connector_secrets', 'UPDATE'), 'W12 runner must NOT UPDATE connector_secrets';
  assert not has_table_privilege('connector_runner', 'public.connector_secrets', 'DELETE'), 'W12 runner must NOT DELETE connector_secrets';
end $$;

-- clean up this suite's rows so later *_test.sql files start from their own fixtures (tenant cascade removes children)
reset role;
delete from public.tenants where id in ('a0000000-0000-4000-8000-000000000001', 'b0000000-0000-4000-8000-000000000002');
