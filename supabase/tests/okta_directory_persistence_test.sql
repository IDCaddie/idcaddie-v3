-- okta_directory_persistence_test.sql — verifies migrations 0052 (lifecycle transition RPC) + 0053 (identity_accounts extension,
-- discovery-run metrics, stale policy, identity_account fact type, promotion RPC, stale/circuit-breaker RPC). All migrations applied,
-- connector_runner present (0021). Run with psql -v ON_ERROR_STOP=1. NEVER touches hosted Supabase. certificationOnly; staging only.

reset role;

-- ── Fixtures: two tenants; T1 has TWO okta connections (C1, C1B) for cross-connection isolation; T2 has one (C2). ─────────
insert into public.tenants (id, name, slug) values
  ('11111111-0000-4000-8000-000000000001', 'Okta T1', 'okta-t1'),
  ('22222222-0000-4000-8000-000000000002', 'Okta T2', 'okta-t2');
insert into public.connectors (id, tenant_id, provider, status, connection_state) values
  ('c1c1c1c1-0000-4000-8000-000000000001', '11111111-0000-4000-8000-000000000001', 'okta', 'pending', 'verified'),
  ('c1b1c1b1-0000-4000-8000-00000000001b', '11111111-0000-4000-8000-000000000001', 'okta', 'pending', 'verified'),
  ('c2c2c2c2-0000-4000-8000-000000000002', '22222222-0000-4000-8000-000000000002', 'okta', 'pending', 'verified');

-- helper: seed a fact + metrics for a run (privileged), so promotion tests have data. Uses the runner RPCs (exercises the boundary).
create or replace function pg_temp.seed_run(p_tenant uuid, p_conn uuid, p_run uuid, p_ext text, p_email text, p_complete boolean, p_rejected integer, p_term text)
  returns void language plpgsql as $$
begin
  insert into public.connector_runs (id, tenant_id, connector_id, status, started_at) values (p_run, p_tenant, p_conn, 'running', now());
  perform public.runner_insert_discovery_fact(
    p_tenant, p_run, 'identity_account', 'identity_provider_discovery', 'okta', 'okta:users:'||p_ext, p_ext, now(), 1.0,
    jsonb_build_object('fact_type','identity_account','external_id',p_ext,'login',p_ext,'normalized_login',lower(p_ext),
                       'email',p_email,'normalized_email',lower(p_email),'first_name','F','last_name','L','status','ACTIVE','is_active',true),
    jsonb_build_object('provider','okta','source_endpoint','users','schema_version','1','sanitizer_version','1','normalizer_version','1'));
  perform public.runner_record_okta_discovery_metrics(p_run, p_tenant, 1, 1, 1, 1, p_rejected, p_term, p_complete, '1','1','1', null);
end $$;

-- ════ G1: grant shape (EXECUTE to connector_runner; PUBLIC denied; NO direct table access) ════════════════════════════
do $$ begin
  assert     has_function_privilege('connector_runner', 'public.runner_advance_connection_state(uuid,uuid,text,text)', 'EXECUTE'), 'G1 runner EXECUTE advance_state';
  assert     has_function_privilege('connector_runner', 'public.runner_promote_okta_directory_users(uuid,uuid)', 'EXECUTE'), 'G1 runner EXECUTE promote';
  assert     has_function_privilege('connector_runner', 'public.runner_mark_absent_okta_identities_stale(uuid,uuid)', 'EXECUTE'), 'G1 runner EXECUTE stale';
  assert not has_function_privilege('public', 'public.runner_advance_connection_state(uuid,uuid,text,text)', 'EXECUTE'), 'G1 PUBLIC denied advance_state';
  assert not has_function_privilege('public', 'public.runner_promote_okta_directory_users(uuid,uuid)', 'EXECUTE'), 'G1 PUBLIC denied promote';
  assert not has_function_privilege('public', 'public.runner_mark_absent_okta_identities_stale(uuid,uuid)', 'EXECUTE'), 'G1 PUBLIC denied stale';
  assert not has_table_privilege('connector_runner', 'public.identity_accounts', 'INSERT'), 'G1 runner NO direct identity_accounts INSERT';
  assert not has_table_privilege('connector_runner', 'public.identity_accounts', 'UPDATE'), 'G1 runner NO direct identity_accounts UPDATE';
  assert not has_table_privilege('connector_runner', 'public.identity_accounts', 'DELETE'), 'G1 runner NO direct identity_accounts DELETE';
  assert not has_table_privilege('connector_runner', 'public.connector_run_discovery', 'INSERT'), 'G1 runner NO direct metrics INSERT';
  -- search_path pinned on every new definer fn
  assert (select array_to_string(proconfig,',') from pg_proc where proname='runner_promote_okta_directory_users') like 'search_path=%', 'G1 promote search_path pinned';
  assert (select array_to_string(proconfig,',') from pg_proc where proname='runner_mark_absent_okta_identities_stale') like 'search_path=%', 'G1 stale search_path pinned';
  assert (select array_to_string(proconfig,',') from pg_proc where proname='runner_advance_connection_state') like 'search_path=%', 'G1 advance search_path pinned';
end $$;

-- ════ G2: lifecycle transitions (allowlist + ownership + optimistic) ══════════════════════════════════════════════════
do $$ declare ok boolean; begin
  perform public.runner_advance_connection_state('c1c1c1c1-0000-4000-8000-000000000001','11111111-0000-4000-8000-000000000001','verified','discovery_pending');
  assert (select connection_state from public.connectors where id='c1c1c1c1-0000-4000-8000-000000000001')='discovery_pending', 'G2 verified->discovery_pending';
  perform public.runner_advance_connection_state('c1c1c1c1-0000-4000-8000-000000000001','11111111-0000-4000-8000-000000000001','discovery_pending','discovering');
  perform public.runner_advance_connection_state('c1c1c1c1-0000-4000-8000-000000000001','11111111-0000-4000-8000-000000000001','discovering','discovered');
  assert (select connection_state from public.connectors where id='c1c1c1c1-0000-4000-8000-000000000001')='discovered', 'G2 reached discovered';
  -- reset for later tests
  update public.connectors set connection_state='verified' where id='c1c1c1c1-0000-4000-8000-000000000001';

  -- invalid: no path to active
  ok:=false; begin perform public.runner_advance_connection_state('c1c1c1c1-0000-4000-8000-000000000001','11111111-0000-4000-8000-000000000001','verified','active'); exception when others then ok:=true; end;
  assert ok, 'G2 verified->active must be rejected (no path to active)';
  -- invalid: skipping straight to discovered
  ok:=false; begin perform public.runner_advance_connection_state('c1c1c1c1-0000-4000-8000-000000000001','11111111-0000-4000-8000-000000000001','verified','discovered'); exception when others then ok:=true; end;
  assert ok, 'G2 verified->discovered (skip) rejected';
  -- wrong tenant
  ok:=false; begin perform public.runner_advance_connection_state('c1c1c1c1-0000-4000-8000-000000000001','22222222-0000-4000-8000-000000000002','verified','discovery_pending'); exception when others then ok:=true; end;
  assert ok, 'G2 wrong tenant rejected';
  -- optimistic mismatch (claim from=discovering while actually verified)
  ok:=false; begin perform public.runner_advance_connection_state('c1c1c1c1-0000-4000-8000-000000000001','11111111-0000-4000-8000-000000000001','discovering','discovered'); exception when others then ok:=true; end;
  assert ok, 'G2 optimistic mismatch rejected';
end $$;

-- ════ G3: promotion — complete run promotes; identity created with correct scoping; raw_payload null ═══════════════════
do $$ declare r jsonb; begin
  perform pg_temp.seed_run('11111111-0000-4000-8000-000000000001','c1c1c1c1-0000-4000-8000-000000000001','a1a1a1a1-0000-4000-8000-0000000000a1','00uAAA','aaa@x.com', true, 0, 'last_page');
  r := public.runner_promote_okta_directory_users('a1a1a1a1-0000-4000-8000-0000000000a1','11111111-0000-4000-8000-000000000001');
  assert (r->>'identitiesCreated')::int = 1, 'G3 one identity created';
  assert (select count(*) from public.identity_accounts where tenant_id='11111111-0000-4000-8000-000000000001' and connection_id='c1c1c1c1-0000-4000-8000-000000000001' and provider='okta' and external_id='00uAAA')=1, 'G3 identity row exists scoped to conn';
  assert (select raw_payload is null from public.identity_accounts where external_id='00uAAA')=true, 'G3 raw_payload is NULL (never populated)';
  assert (select sync_status='current' and first_seen_at is not null and last_seen_at is not null from public.identity_accounts where external_id='00uAAA')=true, 'G3 sync_status current + seen timestamps';
end $$;

-- ════ G4: promotion gate — incomplete / rejected / wrong-termination BLOCK promotion ══════════════════════════════════
do $$ declare ok boolean; begin
  perform pg_temp.seed_run('11111111-0000-4000-8000-000000000001','c1c1c1c1-0000-4000-8000-000000000001','b2b2b2b2-0000-4000-8000-0000000000b2','00uBAD','bad@x.com', false, 0, 'last_page'); -- incomplete
  ok:=false; begin perform public.runner_promote_okta_directory_users('b2b2b2b2-0000-4000-8000-0000000000b2','11111111-0000-4000-8000-000000000001'); exception when others then ok:=true; end;
  assert ok, 'G4 incomplete run promotion blocked';
  perform pg_temp.seed_run('11111111-0000-4000-8000-000000000001','c1c1c1c1-0000-4000-8000-000000000001','b3b3b3b3-0000-4000-8000-0000000000b3','00uBAD2','bad2@x.com', true, 1, 'last_page'); -- rejected>0
  ok:=false; begin perform public.runner_promote_okta_directory_users('b3b3b3b3-0000-4000-8000-0000000000b3','11111111-0000-4000-8000-000000000001'); exception when others then ok:=true; end;
  assert ok, 'G4 rejected>0 promotion blocked';
  perform pg_temp.seed_run('11111111-0000-4000-8000-000000000001','c1c1c1c1-0000-4000-8000-000000000001','b4b4b4b4-0000-4000-8000-0000000000b4','00uBAD3','bad3@x.com', true, 0, 'budget:okta_record_cap'); -- cap
  ok:=false; begin perform public.runner_promote_okta_directory_users('b4b4b4b4-0000-4000-8000-0000000000b4','11111111-0000-4000-8000-000000000001'); exception when others then ok:=true; end;
  assert ok, 'G4 cap-terminated run promotion blocked';
  -- wrong tenant
  ok:=false; begin perform public.runner_promote_okta_directory_users('a1a1a1a1-0000-4000-8000-0000000000a1','22222222-0000-4000-8000-000000000002'); exception when others then ok:=true; end;
  assert ok, 'G4 wrong-tenant promotion blocked';
  assert (select count(*) from public.identity_accounts where external_id in ('00uBAD','00uBAD2','00uBAD3'))=0, 'G4 no identities from blocked runs';
end $$;

-- ════ G5: idempotent replay + provider-ID immutability + first_seen stable / last_seen advances + cross-run isolation ══
do $$ declare r jsonb; v_first timestamptz; v_last1 timestamptz; begin
  select first_seen_at, last_seen_at into v_first, v_last1 from public.identity_accounts where external_id='00uAAA';
  perform pg_sleep(0.01);
  -- new run for the SAME user with a CHANGED email -> same row (external_id immutable), email updated, first_seen preserved
  perform pg_temp.seed_run('11111111-0000-4000-8000-000000000001','c1c1c1c1-0000-4000-8000-000000000001','a2a2a2a2-0000-4000-8000-0000000000a2','00uAAA','CHANGED@x.com', true, 0, 'last_page');
  r := public.runner_promote_okta_directory_users('a2a2a2a2-0000-4000-8000-0000000000a2','11111111-0000-4000-8000-000000000001');
  assert (r->>'identitiesUpdated')::int = 1 and (r->>'identitiesCreated')::int = 0, 'G5 replay updates, no new row';
  assert (select count(*) from public.identity_accounts where external_id='00uAAA')=1, 'G5 no duplicate row (immutable external_id)';
  assert (select email='CHANGED@x.com' from public.identity_accounts where external_id='00uAAA')=true, 'G5 mutable email updated';
  assert (select first_seen_at=v_first from public.identity_accounts where external_id='00uAAA')=true, 'G5 first_seen_at preserved';
  assert (select last_seen_at>v_last1 from public.identity_accounts where external_id='00uAAA')=true, 'G5 last_seen_at advanced';
  -- promoting the SAME run twice is idempotent
  r := public.runner_promote_okta_directory_users('a2a2a2a2-0000-4000-8000-0000000000a2','11111111-0000-4000-8000-000000000001');
  assert (select count(*) from public.identity_accounts where external_id='00uAAA')=1, 'G5 double-promote same run stays 1 row';
end $$;

-- ════ G6: cross-tenant + cross-connection isolation of external_id ════════════════════════════════════════════════════
do $$ begin
  -- same external_id under a DIFFERENT tenant -> separate row
  perform pg_temp.seed_run('22222222-0000-4000-8000-000000000002','c2c2c2c2-0000-4000-8000-000000000002','d1d1d1d1-0000-4000-8000-0000000000d1','00uAAA','t2@x.com', true, 0, 'last_page');
  perform public.runner_promote_okta_directory_users('d1d1d1d1-0000-4000-8000-0000000000d1','22222222-0000-4000-8000-000000000002');
  -- same external_id under a DIFFERENT connection (same tenant) -> separate row
  perform pg_temp.seed_run('11111111-0000-4000-8000-000000000001','c1b1c1b1-0000-4000-8000-00000000001b','d2d2d2d2-0000-4000-8000-0000000000d2','00uAAA','connb@x.com', true, 0, 'last_page');
  perform public.runner_promote_okta_directory_users('d2d2d2d2-0000-4000-8000-0000000000d2','11111111-0000-4000-8000-000000000001');
  assert (select count(*) from public.identity_accounts where external_id='00uAAA')=3, 'G6 external_id 00uAAA has 3 rows across 2 tenants + 2 connections';
  assert (select count(*) from public.identity_accounts where external_id='00uAAA' and tenant_id='22222222-0000-4000-8000-000000000002')=1, 'G6 T2 has its own row';
end $$;

-- ════ G7: email may be NULL (valid user without email) ════════════════════════════════════════════════════════════════
do $$ begin
  insert into public.connector_runs (id, tenant_id, connector_id, status, started_at) values ('e1e1e1e1-0000-4000-8000-0000000000e1','11111111-0000-4000-8000-000000000001','c1c1c1c1-0000-4000-8000-000000000001','running',now());
  perform public.runner_insert_discovery_fact('11111111-0000-4000-8000-000000000001','e1e1e1e1-0000-4000-8000-0000000000e1','identity_account','identity_provider_discovery','okta','okta:users:00uNOEMAIL','00uNOEMAIL',now(),1.0,
    jsonb_build_object('fact_type','identity_account','external_id','00uNOEMAIL','login','svc-account','normalized_login','svc-account','status','ACTIVE','is_active',true), jsonb_build_object('provider','okta','source_endpoint','users'));
  perform public.runner_record_okta_discovery_metrics('e1e1e1e1-0000-4000-8000-0000000000e1','11111111-0000-4000-8000-000000000001',1,1,1,1,0,'last_page',true,'1','1','1',null);
  perform public.runner_promote_okta_directory_users('e1e1e1e1-0000-4000-8000-0000000000e1','11111111-0000-4000-8000-000000000001');
  assert (select email is null and login='svc-account' from public.identity_accounts where external_id='00uNOEMAIL')=true, 'G7 emailless user promoted (login present)';
end $$;

-- ════ G8: STALE safety — first run stales zero; complete second run stales absent; partial/breaker stale zero; scoped ══
do $$ declare r jsonb; begin
  -- Fresh connection C1B currently has one identity (00uAAA from G6, run d2). A SECOND complete run that does NOT include it
  -- should mark it stale. First seed a NEW run for C1B with a DIFFERENT user (00uNEW), promote, then stale-eval.
  perform pg_temp.seed_run('11111111-0000-4000-8000-000000000001','c1b1c1b1-0000-4000-8000-00000000001b','f1f1f1f1-0000-4000-8000-0000000000f1','00uNEW','new@x.com', true, 0, 'last_page');
  perform public.runner_promote_okta_directory_users('f1f1f1f1-0000-4000-8000-0000000000f1','11111111-0000-4000-8000-000000000001');
  update public.connector_discovery_policy set stale_percent_threshold=90 where provider='okta'; -- 1/2 absent = 50% would trip the 30% default; raise it for THIS eligibility case
  r := public.runner_mark_absent_okta_identities_stale('f1f1f1f1-0000-4000-8000-0000000000f1','11111111-0000-4000-8000-000000000001');
  update public.connector_discovery_policy set stale_percent_threshold=30 where provider='okta'; -- restore default
  assert (r->>'staleMarked')::int = 1, 'G8 absent prior identity (00uAAA on C1B) marked stale';
  assert (select sync_status='stale' and stale_since is not null from public.identity_accounts where external_id='00uAAA' and connection_id='c1b1c1b1-0000-4000-8000-00000000001b')=true, 'G8 the absent row is stale (not deleted)';
  -- scoping: 00uAAA on C1 (a DIFFERENT connection) is untouched (still current)
  assert (select sync_status='current' from public.identity_accounts where external_id='00uAAA' and connection_id='c1c1c1c1-0000-4000-8000-000000000001')=true, 'G8 stale scoped to exact connection';
  -- no hard delete
  assert (select count(*) from public.identity_accounts where external_id='00uAAA')=3, 'G8 no hard delete (still 3 rows)';

  -- FIRST-RUN rule: connection C2 (T2) had exactly one run (d1). A brand-new connection with only its first run stales zero.
  -- Re-run the SAME run's stale-eval: since every identity's last_discovery_run_id = this run, there is no prior -> zero.
  r := public.runner_mark_absent_okta_identities_stale('d1d1d1d1-0000-4000-8000-0000000000d1','22222222-0000-4000-8000-000000000002');
  assert (r->>'staleMarked')::int = 0 and (r->>'firstRun')::boolean = true, 'G8 first run stales zero';

  -- PARTIAL run stales zero: an incomplete run must never stale
  perform pg_temp.seed_run('11111111-0000-4000-8000-000000000001','c1b1c1b1-0000-4000-8000-00000000001b','f2f2f2f2-0000-4000-8000-0000000000f2','00uNEW','new@x.com', false, 0, 'error:infrastructure/okta_network_error');
  r := public.runner_mark_absent_okta_identities_stale('f2f2f2f2-0000-4000-8000-0000000000f2','11111111-0000-4000-8000-000000000001');
  assert (r->>'staleMarked')::int = 0 and (r->>'eligible')::boolean = false, 'G8 partial run stales zero';
end $$;

-- ════ G9: circuit breaker — set absolute threshold to 0 so any absence triggers review, stales zero ════════════════════
do $$ declare r jsonb; begin
  update public.connector_discovery_policy set stale_absolute_threshold=0, stale_percent_threshold=0 where provider='okta';
  -- New complete run on C1 (which has 00uAAA current) with a different user -> 00uAAA would be absent -> breaker fires.
  perform pg_temp.seed_run('11111111-0000-4000-8000-000000000001','c1c1c1c1-0000-4000-8000-000000000001','f3f3f3f3-0000-4000-8000-0000000000f3','00uOTHER','other@x.com', true, 0, 'last_page');
  perform public.runner_promote_okta_directory_users('f3f3f3f3-0000-4000-8000-0000000000f3','11111111-0000-4000-8000-000000000001');
  r := public.runner_mark_absent_okta_identities_stale('f3f3f3f3-0000-4000-8000-0000000000f3','11111111-0000-4000-8000-000000000001');
  assert (r->>'circuitBreakerTriggered')::boolean = true and (r->>'staleMarked')::int = 0, 'G9 circuit breaker fires, stales zero';
  assert (select review_required from public.connector_run_discovery where run_id='f3f3f3f3-0000-4000-8000-0000000000f3')=true, 'G9 run flagged review_required';
  assert (select sync_status='current' from public.identity_accounts where external_id='00uAAA' and connection_id='c1c1c1c1-0000-4000-8000-000000000001')=true, 'G9 nothing staled under breaker';
  update public.connector_discovery_policy set stale_absolute_threshold=100, stale_percent_threshold=30 where provider='okta'; -- restore
end $$;

reset role;
do $$ begin raise notice 'ALL OKTA DIRECTORY PERSISTENCE ASSERTIONS PASSED'; end $$;
