-- okta_directory_group_persistence_test.sql — verifies migration 0054 (directory_groups table, 'directory_group' fact type +
-- positive-key allowlist, group promotion RPC, group stale/circuit-breaker RPC) reusing the 0053 metrics + policy infra. All
-- migrations applied, connector_runner present (0021). Runs against the SHARED harness DB, so fixtures use UUIDs distinct from the
-- identity test. Run with psql -v ON_ERROR_STOP=1. NEVER touches hosted Supabase. certificationOnly; staging only; NO memberships.

reset role;

-- ── Fixtures: two tenants; GT1 has TWO okta connections (C3, C3B) for cross-connection isolation; GT2 has one (C4). ──────────
insert into public.tenants (id, name, slug) values
  ('33333333-0000-4000-8000-000000000003', 'Okta GT1', 'okta-gt1'),
  ('44444444-0000-4000-8000-000000000004', 'Okta GT2', 'okta-gt2');
insert into public.connectors (id, tenant_id, provider, status, connection_state) values
  ('c3c3c3c3-0000-4000-8000-000000000003', '33333333-0000-4000-8000-000000000003', 'okta', 'pending', 'discovered'),
  ('c3b3c3b3-0000-4000-8000-00000000003b', '33333333-0000-4000-8000-000000000003', 'okta', 'pending', 'discovered'),
  ('c4c4c4c4-0000-4000-8000-000000000004', '44444444-0000-4000-8000-000000000004', 'okta', 'pending', 'discovered');

-- helper: seed a directory_group fact + metrics for a run (exercises the write boundary). Connection-qualified signal_id.
create or replace function pg_temp.seed_group_run(p_tenant uuid, p_conn uuid, p_run uuid, p_ext text, p_name text, p_cat text, p_complete boolean, p_rejected integer, p_term text)
  returns void language plpgsql as $$
begin
  insert into public.connector_runs (id, tenant_id, connector_id, status, started_at) values (p_run, p_tenant, p_conn, 'running', clock_timestamp());
  perform public.runner_insert_discovery_fact(
    p_tenant, p_run, 'directory_group', 'identity_provider_discovery', 'okta', 'okta:'||p_conn||':groups:'||p_ext, p_ext, now(), 1.0,
    jsonb_build_object('fact_type','directory_group','external_id',p_ext,'connection_id',p_conn::text,'name',p_name,'normalized_name',lower(p_name),
                       'description','desc-'||p_ext,'group_type_category',p_cat,'provider_created_at','2020-01-01T00:00:00Z','provider_last_updated_at','2021-01-01T00:00:00Z'),
    jsonb_build_object('provider','okta','source_endpoint','groups','schema_version','1','sanitizer_version','1','normalizer_version','1'));
  perform public.runner_record_okta_discovery_metrics(p_run, p_tenant, 1, 1, 1, 1, p_rejected, p_term, p_complete, '1','1','1', null);
end $$;

-- ════ GG1: grant shape (EXECUTE to connector_runner; PUBLIC/anon denied; NO direct table access; search_path pinned) ══════
do $$ begin
  assert     has_function_privilege('connector_runner', 'public.runner_promote_okta_directory_groups(uuid,uuid)', 'EXECUTE'), 'GG1 runner EXECUTE promote_groups';
  assert     has_function_privilege('connector_runner', 'public.runner_mark_absent_okta_directory_groups_stale(uuid,uuid)', 'EXECUTE'), 'GG1 runner EXECUTE stale_groups';
  assert not has_function_privilege('public', 'public.runner_promote_okta_directory_groups(uuid,uuid)', 'EXECUTE'), 'GG1 PUBLIC denied promote_groups';
  assert not has_function_privilege('public', 'public.runner_mark_absent_okta_directory_groups_stale(uuid,uuid)', 'EXECUTE'), 'GG1 PUBLIC denied stale_groups';
  assert not has_function_privilege('anon', 'public.runner_promote_okta_directory_groups(uuid,uuid)', 'EXECUTE'), 'GG1 anon denied promote_groups';
  assert not has_function_privilege('anon', 'public.runner_mark_absent_okta_directory_groups_stale(uuid,uuid)', 'EXECUTE'), 'GG1 anon denied stale_groups';
  assert not has_table_privilege('connector_runner', 'public.directory_groups', 'INSERT'), 'GG1 runner NO direct directory_groups INSERT';
  assert not has_table_privilege('connector_runner', 'public.directory_groups', 'UPDATE'), 'GG1 runner NO direct directory_groups UPDATE';
  assert not has_table_privilege('connector_runner', 'public.directory_groups', 'DELETE'), 'GG1 runner NO direct directory_groups DELETE';
  assert (select relrowsecurity from pg_class where oid='public.directory_groups'::regclass)=true, 'GG1 directory_groups RLS enabled';
  assert (select count(*) from pg_policies where schemaname='public' and tablename='directory_groups')=0, 'GG1 directory_groups deny-all (no policy)';
  assert (select array_to_string(proconfig,',') from pg_proc where proname='runner_promote_okta_directory_groups') like 'search_path=%', 'GG1 promote search_path pinned';
  assert (select array_to_string(proconfig,',') from pg_proc where proname='runner_mark_absent_okta_directory_groups_stale') like 'search_path=%', 'GG1 stale search_path pinned';
  -- directory_groups has NO raw_payload column at all (stronger than 0053)
  assert not exists (select 1 from information_schema.columns where table_schema='public' and table_name='directory_groups' and column_name='raw_payload'), 'GG1 directory_groups has NO raw_payload column';
end $$;

-- ════ GG2: promotion — complete run promotes; group created with correct scoping + safe category; no raw payload ══════════
do $$ declare r jsonb; begin
  perform pg_temp.seed_group_run('33333333-0000-4000-8000-000000000003','c3c3c3c3-0000-4000-8000-000000000003','3a3a3a3a-0000-4000-8000-00000000003a','00gAAA','Everyone','built_in', true, 0, 'last_page');
  r := public.runner_promote_okta_directory_groups('3a3a3a3a-0000-4000-8000-00000000003a','33333333-0000-4000-8000-000000000003');
  assert (r->>'groupsCreated')::int = 1 and (r->>'groupsUpdated')::int = 0, 'GG2 one group created';
  assert (select count(*) from public.directory_groups where tenant_id='33333333-0000-4000-8000-000000000003' and connection_id='c3c3c3c3-0000-4000-8000-000000000003' and provider='okta' and external_id='00gAAA')=1, 'GG2 group row scoped to conn';
  assert (select name='Everyone' and normalized_name='everyone' and group_type_category='built_in' and sync_status='current' and first_seen_at is not null and last_seen_at is not null from public.directory_groups where external_id='00gAAA')=true, 'GG2 attributes + category + seen timestamps';
end $$;

-- ════ GG3: promotion gate — incomplete / rejected / cap / wrong-tenant BLOCK promotion ════════════════════════════════════
do $$ declare ok boolean; begin
  perform pg_temp.seed_group_run('33333333-0000-4000-8000-000000000003','c3c3c3c3-0000-4000-8000-000000000003','3b3b3b3b-0000-4000-8000-00000000003b','00gBAD','G','okta_group', false, 0, 'last_page');
  ok:=false; begin perform public.runner_promote_okta_directory_groups('3b3b3b3b-0000-4000-8000-00000000003b','33333333-0000-4000-8000-000000000003'); exception when others then ok:=true; end;
  assert ok, 'GG3 incomplete run promotion blocked';
  perform pg_temp.seed_group_run('33333333-0000-4000-8000-000000000003','c3c3c3c3-0000-4000-8000-000000000003','3c3c3c3c-0000-4000-8000-00000000003c','00gBAD2','G','okta_group', true, 1, 'last_page');
  ok:=false; begin perform public.runner_promote_okta_directory_groups('3c3c3c3c-0000-4000-8000-00000000003c','33333333-0000-4000-8000-000000000003'); exception when others then ok:=true; end;
  assert ok, 'GG3 rejected>0 promotion blocked';
  perform pg_temp.seed_group_run('33333333-0000-4000-8000-000000000003','c3c3c3c3-0000-4000-8000-000000000003','3d3d3d3d-0000-4000-8000-00000000003d','00gBAD3','G','okta_group', true, 0, 'budget:okta_record_cap');
  ok:=false; begin perform public.runner_promote_okta_directory_groups('3d3d3d3d-0000-4000-8000-00000000003d','33333333-0000-4000-8000-000000000003'); exception when others then ok:=true; end;
  assert ok, 'GG3 cap-terminated run promotion blocked';
  ok:=false; begin perform public.runner_promote_okta_directory_groups('3a3a3a3a-0000-4000-8000-00000000003a','44444444-0000-4000-8000-000000000004'); exception when others then ok:=true; end;
  assert ok, 'GG3 wrong-tenant promotion blocked';
  assert (select count(*) from public.directory_groups where external_id in ('00gBAD','00gBAD2','00gBAD3'))=0, 'GG3 no groups from blocked runs';
end $$;

-- ════ GG4: idempotent replay + immutable external_id + RENAME (name mutable) + first_seen stable / last_seen advances ═════
do $$ declare r jsonb; v_first timestamptz; v_last1 timestamptz; begin
  select first_seen_at, last_seen_at into v_first, v_last1 from public.directory_groups where external_id='00gAAA';
  perform pg_sleep(0.01);
  -- new run for the SAME group with a CHANGED name -> same row (external_id immutable), name updated, first_seen preserved
  perform pg_temp.seed_group_run('33333333-0000-4000-8000-000000000003','c3c3c3c3-0000-4000-8000-000000000003','3e3e3e3e-0000-4000-8000-00000000003e','00gAAA','All Employees','built_in', true, 0, 'last_page');
  r := public.runner_promote_okta_directory_groups('3e3e3e3e-0000-4000-8000-00000000003e','33333333-0000-4000-8000-000000000003');
  assert (r->>'groupsUpdated')::int = 1 and (r->>'groupsCreated')::int = 0, 'GG4 replay updates, no new row';
  assert (select count(*) from public.directory_groups where external_id='00gAAA')=1, 'GG4 no duplicate row (immutable external_id)';
  assert (select name='All Employees' and normalized_name='all employees' from public.directory_groups where external_id='00gAAA')=true, 'GG4 mutable name updated (rename)';
  assert (select first_seen_at=v_first from public.directory_groups where external_id='00gAAA')=true, 'GG4 first_seen_at preserved';
  assert (select last_seen_at>v_last1 from public.directory_groups where external_id='00gAAA')=true, 'GG4 last_seen_at advanced';
  -- promoting the SAME run twice is idempotent
  r := public.runner_promote_okta_directory_groups('3e3e3e3e-0000-4000-8000-00000000003e','33333333-0000-4000-8000-000000000003');
  assert (select count(*) from public.directory_groups where external_id='00gAAA')=1, 'GG4 double-promote same run stays 1 row';
end $$;

-- ════ GG5: cross-tenant + cross-connection isolation of external_id ══════════════════════════════════════════════════════
do $$ begin
  perform pg_temp.seed_group_run('44444444-0000-4000-8000-000000000004','c4c4c4c4-0000-4000-8000-000000000004','4a4a4a4a-0000-4000-8000-00000000004a','00gAAA','T2 group','okta_group', true, 0, 'last_page');
  perform public.runner_promote_okta_directory_groups('4a4a4a4a-0000-4000-8000-00000000004a','44444444-0000-4000-8000-000000000004');
  perform pg_temp.seed_group_run('33333333-0000-4000-8000-000000000003','c3b3c3b3-0000-4000-8000-00000000003b','3f3f3f3f-0000-4000-8000-00000000003f','00gAAA','ConnB group','okta_group', true, 0, 'last_page');
  perform public.runner_promote_okta_directory_groups('3f3f3f3f-0000-4000-8000-00000000003f','33333333-0000-4000-8000-000000000003');
  assert (select count(*) from public.directory_groups where external_id='00gAAA')=3, 'GG5 external_id 00gAAA has 3 rows across 2 tenants + 2 connections';
  assert (select count(*) from public.directory_groups where external_id='00gAAA' and tenant_id='44444444-0000-4000-8000-000000000004')=1, 'GG5 GT2 has its own row';
end $$;

-- ════ GG6: STALE safety — first run zero; complete second run stales absent; partial zero; scoped; no hard delete ════════
do $$ declare r jsonb; begin
  -- FIRST-RUN rule: GT2 connection C4 had exactly one run (4a). Re-stale-eval it: no prior run -> zero.
  r := public.runner_mark_absent_okta_directory_groups_stale('4a4a4a4a-0000-4000-8000-00000000004a','44444444-0000-4000-8000-000000000004');
  assert (r->>'staleMarked')::int = 0 and (r->>'firstRun')::boolean = true, 'GG6 first run stales zero';

  -- C3B currently has 00gAAA (from GG5, run 3f). A SECOND complete run with a DIFFERENT group -> 00gAAA becomes absent -> stale.
  perform pg_temp.seed_group_run('33333333-0000-4000-8000-000000000003','c3b3c3b3-0000-4000-8000-00000000003b','30f10000-0000-4000-8000-0000000000f1','00gNEW','New','okta_group', true, 0, 'last_page');
  perform public.runner_promote_okta_directory_groups('30f10000-0000-4000-8000-0000000000f1','33333333-0000-4000-8000-000000000003');
  update public.connector_discovery_policy set stale_percent_threshold=90 where provider='okta'; -- 1/2 absent = 50% > 30% default; raise for THIS eligibility case
  r := public.runner_mark_absent_okta_directory_groups_stale('30f10000-0000-4000-8000-0000000000f1','33333333-0000-4000-8000-000000000003');
  update public.connector_discovery_policy set stale_percent_threshold=30 where provider='okta';
  assert (r->>'staleMarked')::int = 1, 'GG6 absent prior group (00gAAA on C3B) marked stale';
  assert (select sync_status='stale' and stale_since is not null from public.directory_groups where external_id='00gAAA' and connection_id='c3b3c3b3-0000-4000-8000-00000000003b')=true, 'GG6 absent row stale (not deleted)';
  assert (select sync_status='current' from public.directory_groups where external_id='00gAAA' and connection_id='c3c3c3c3-0000-4000-8000-000000000003')=true, 'GG6 stale scoped to exact connection';
  assert (select count(*) from public.directory_groups where external_id='00gAAA')=3, 'GG6 no hard delete (still 3 rows)';

  -- PARTIAL run stales zero
  perform pg_temp.seed_group_run('33333333-0000-4000-8000-000000000003','c3b3c3b3-0000-4000-8000-00000000003b','30f20000-0000-4000-8000-0000000000f2','00gNEW','New','okta_group', false, 0, 'error:transient/okta_network_error');
  r := public.runner_mark_absent_okta_directory_groups_stale('30f20000-0000-4000-8000-0000000000f2','33333333-0000-4000-8000-000000000003');
  assert (r->>'staleMarked')::int = 0 and (r->>'eligible')::boolean = false, 'GG6 partial run stales zero';
end $$;

-- ════ GG7: circuit breaker — absolute threshold 0 so any absence triggers review, stales zero ════════════════════════════
do $$ declare r jsonb; begin
  update public.connector_discovery_policy set stale_absolute_threshold=0, stale_percent_threshold=0 where provider='okta';
  perform pg_temp.seed_group_run('33333333-0000-4000-8000-000000000003','c3c3c3c3-0000-4000-8000-000000000003','30f30000-0000-4000-8000-0000000000f3','00gOTHER','Other','okta_group', true, 0, 'last_page');
  perform public.runner_promote_okta_directory_groups('30f30000-0000-4000-8000-0000000000f3','33333333-0000-4000-8000-000000000003');
  r := public.runner_mark_absent_okta_directory_groups_stale('30f30000-0000-4000-8000-0000000000f3','33333333-0000-4000-8000-000000000003');
  assert (r->>'circuitBreakerTriggered')::boolean = true and (r->>'staleMarked')::int = 0, 'GG7 circuit breaker fires, stales zero';
  assert (select review_required from public.connector_run_discovery where run_id='30f30000-0000-4000-8000-0000000000f3')=true, 'GG7 run flagged review_required';
  assert (select sync_status='current' from public.directory_groups where external_id='00gAAA' and connection_id='c3c3c3c3-0000-4000-8000-000000000003')=true, 'GG7 nothing staled under breaker';
  update public.connector_discovery_policy set stale_absolute_threshold=100, stale_percent_threshold=30 where provider='okta';
end $$;

-- ════ GG8: write-boundary guards — key allowlist, NO memberships, bounded category CHECK, superseded-run block ════════════
do $$ declare ok boolean; begin
  insert into public.connector_runs (id, tenant_id, connector_id, status, started_at) values ('300a0000-0000-4000-8000-00000000000a','33333333-0000-4000-8000-000000000003','c3c3c3c3-0000-4000-8000-000000000003','running',now());
  -- directory_group fact_json key ALLOWLIST rejects a non-approved key
  ok:=false; begin perform public.runner_insert_discovery_fact('33333333-0000-4000-8000-000000000003','300a0000-0000-4000-8000-00000000000a','directory_group','identity_provider_discovery','okta','okta:c3:groups:00gKEY','00gKEY',now(),1.0,
    jsonb_build_object('fact_type','directory_group','external_id','00gKEY','surprise_field','x'), null); exception when others then ok:=true; end;
  assert ok, 'GG8 directory_group non-approved key rejected';
  -- a membership field is a non-approved key -> rejected (no-memberships enforcement at the fact allowlist)
  ok:=false; begin perform public.runner_insert_discovery_fact('33333333-0000-4000-8000-000000000003','300a0000-0000-4000-8000-00000000000a','directory_group','identity_provider_discovery','okta','okta:c3:groups:00gMEM','00gMEM',now(),1.0,
    jsonb_build_object('fact_type','directory_group','external_id','00gMEM','member_count',5), null); exception when others then ok:=true; end;
  assert ok, 'GG8 directory_group member_count (membership) key rejected';
  -- fact_type 'group_membership' is NOT in the allowlist -> rejected (the write path for memberships is closed)
  ok:=false; begin perform public.runner_insert_discovery_fact('33333333-0000-4000-8000-000000000003','300a0000-0000-4000-8000-00000000000a','group_membership','identity_provider_discovery','okta','okta:c3:mem:x','x',now(),1.0,
    jsonb_build_object('fact_type','group_membership','external_id','x'), null); exception when others then ok:=true; end;
  assert ok, 'GG8 group_membership fact_type rejected (no memberships)';
  -- bounded group_type_category: a fact with an out-of-set category fails the table CHECK at promotion
  perform pg_temp.seed_group_run('33333333-0000-4000-8000-000000000003','c3c3c3c3-0000-4000-8000-000000000003','30ca0000-0000-4000-8000-0000000000ca','00gCAT','Bad','not_a_category', true, 0, 'last_page');
  ok:=false; begin perform public.runner_promote_okta_directory_groups('30ca0000-0000-4000-8000-0000000000ca','33333333-0000-4000-8000-000000000003'); exception when others then ok:=true; end;
  assert ok, 'GG8 out-of-set group_type_category rejected by CHECK at promotion';
  assert (select count(*) from public.directory_groups where external_id='00gCAT')=0, 'GG8 no group row from the bad-category run';

  -- SUPERSEDED-run guard: C3 has run 3g0000f3 (GG7, latest complete). Re-promoting the older 3e must be refused.
  ok:=false; begin perform public.runner_promote_okta_directory_groups('3e3e3e3e-0000-4000-8000-00000000003e','33333333-0000-4000-8000-000000000003'); exception when others then ok:=true; end;
  assert ok, 'GG8 superseded (older) run promotion refused';
  assert (public.runner_mark_absent_okta_directory_groups_stale('3e3e3e3e-0000-4000-8000-00000000003e','33333333-0000-4000-8000-000000000003') ->> 'staleMarked')::int = 0, 'GG8 superseded run stales zero';
end $$;

reset role;
do $$ begin raise notice 'ALL OKTA DIRECTORY GROUP PERSISTENCE ASSERTIONS PASSED'; end $$;
