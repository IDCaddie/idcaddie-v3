-- okta_application_assignment_persistence_test.sql — verifies migrations 0059 + 0060 (the two application-assignment EDGE tables
-- directory_application_user_assignments + directory_application_group_assignments, composite-FK integrity, the two assignment fact
-- types, the two DUAL-ENDPOINT-resolution promotion RPCs, and the two stale/circuit-breaker RPCs). Runs against the SHARED harness DB,
-- so fixtures use UUIDs + external_ids DISTINCT from every other test (S-suffixed ids; a2/b2 tenants; ca2/cb2/cc2 connectors). NEVER
-- touches hosted Supabase. staging only.

reset role;

-- ── Fixtures: tenant A2 (okta conns CA2, CB2); tenant B2 (okta conn CC2). Each connection seeds its OWN canonical endpoints:
--    directory_applications (0oaS*), identity_accounts (00uS*), directory_groups (00gS*). The edges composite-FK to these. ──
insert into public.tenants (id, name, slug) values
  ('a2a20000-0000-4000-8000-0000000000a2', 'Okta A2', 'okta-a2'),
  ('b2b20000-0000-4000-8000-0000000000b2', 'Okta B2', 'okta-b2');
insert into public.connectors (id, tenant_id, provider, status, connection_state) values
  ('ca2a0000-0000-4000-8000-0000000000ca', 'a2a20000-0000-4000-8000-0000000000a2', 'okta', 'pending', 'discovered'),
  ('cb2b0000-0000-4000-8000-0000000000cb', 'a2a20000-0000-4000-8000-0000000000a2', 'okta', 'pending', 'discovered'),
  ('cc2c0000-0000-4000-8000-0000000000cc', 'b2b20000-0000-4000-8000-0000000000b2', 'okta', 'pending', 'discovered');
-- APPLICATION endpoints (0oaS1 on CA2/CB2/CC2; 0oaS2 on CA2 only).
insert into public.directory_applications (tenant_id, connection_id, provider, external_id, sync_status) values
  ('a2a20000-0000-4000-8000-0000000000a2', 'ca2a0000-0000-4000-8000-0000000000ca', 'okta', '0oaS1', 'current'),
  ('a2a20000-0000-4000-8000-0000000000a2', 'ca2a0000-0000-4000-8000-0000000000ca', 'okta', '0oaS2', 'current'),
  ('a2a20000-0000-4000-8000-0000000000a2', 'cb2b0000-0000-4000-8000-0000000000cb', 'okta', '0oaS1', 'current'),
  ('b2b20000-0000-4000-8000-0000000000b2', 'cc2c0000-0000-4000-8000-0000000000cc', 'okta', '0oaS1', 'current');
-- IDENTITY endpoints (00uS1/00uS2 on CA2; 00uS1 on CB2; 00uS1 on CC2).
insert into public.identity_accounts (tenant_id, connection_id, provider, external_id, sync_status) values
  ('a2a20000-0000-4000-8000-0000000000a2', 'ca2a0000-0000-4000-8000-0000000000ca', 'okta', '00uS1', 'current'),
  ('a2a20000-0000-4000-8000-0000000000a2', 'ca2a0000-0000-4000-8000-0000000000ca', 'okta', '00uS2', 'current'),
  ('a2a20000-0000-4000-8000-0000000000a2', 'cb2b0000-0000-4000-8000-0000000000cb', 'okta', '00uS1', 'current'),
  ('b2b20000-0000-4000-8000-0000000000b2', 'cc2c0000-0000-4000-8000-0000000000cc', 'okta', '00uS1', 'current');
-- GROUP endpoints (00gS1 on CA2/CB2/CC2).
insert into public.directory_groups (tenant_id, connection_id, provider, external_id, sync_status) values
  ('a2a20000-0000-4000-8000-0000000000a2', 'ca2a0000-0000-4000-8000-0000000000ca', 'okta', '00gS1', 'current'),
  ('a2a20000-0000-4000-8000-0000000000a2', 'cb2b0000-0000-4000-8000-0000000000cb', 'okta', '00gS1', 'current'),
  ('b2b20000-0000-4000-8000-0000000000b2', 'cc2c0000-0000-4000-8000-0000000000cc', 'okta', '00gS1', 'current');

-- helper: seed an assignment run — one application_user_assignment fact per (a,u) pair + one application_group_assignment fact per (a,g)
-- pair + metrics. p_user_pairs/p_group_pairs are jsonb arrays of {"a":appExt,"u":userExt} / {"a":appExt,"g":groupExt}.
create or replace function pg_temp.seed_assignment_run(p_tenant uuid, p_conn uuid, p_run uuid, p_user_pairs jsonb, p_group_pairs jsonb, p_complete boolean, p_rejected integer, p_term text)
  returns void language plpgsql as $$
declare pair jsonb; n integer := jsonb_array_length(p_user_pairs) + jsonb_array_length(p_group_pairs);
begin
  insert into public.connector_runs (id, tenant_id, connector_id, status, started_at) values (p_run, p_tenant, p_conn, 'running', clock_timestamp());
  for pair in select * from jsonb_array_elements(p_user_pairs) loop
    perform public.runner_insert_discovery_fact(
      p_tenant, p_run, 'application_user_assignment', 'identity_provider_discovery', 'okta',
      'okta:'||p_conn||':application-user-assignment:'||(pair->>'a')||':'||(pair->>'u'), (pair->>'a')||':'||(pair->>'u'), now(), 1.0,
      jsonb_build_object('fact_type','application_user_assignment','connection_id',p_conn::text,'application_external_id',pair->>'a','user_external_id',pair->>'u'),
      jsonb_build_object('provider','okta','source_endpoint','app_users','schema_version','1','sanitizer_version','1','normalizer_version','1'));
  end loop;
  for pair in select * from jsonb_array_elements(p_group_pairs) loop
    perform public.runner_insert_discovery_fact(
      p_tenant, p_run, 'application_group_assignment', 'identity_provider_discovery', 'okta',
      'okta:'||p_conn||':application-group-assignment:'||(pair->>'a')||':'||(pair->>'g'), (pair->>'a')||':'||(pair->>'g'), now(), 1.0,
      jsonb_build_object('fact_type','application_group_assignment','connection_id',p_conn::text,'application_external_id',pair->>'a','group_external_id',pair->>'g'),
      jsonb_build_object('provider','okta','source_endpoint','app_groups','schema_version','1','sanitizer_version','1','normalizer_version','1'));
  end loop;
  perform public.runner_record_okta_discovery_metrics(p_run, p_tenant, 1, n, n, n, p_rejected, p_term, p_complete, '1','1','1', null);
end $$;

-- ════ AA1: parents constraint + grants + no raw_payload + RLS deny-all + search_path pinned (both edges, all 4 RPCs) ══════════
do $$ begin
  -- the 0059 prerequisite: directory_applications got its FULL id-scope unique constraint (the app composite-FK target).
  assert exists (select 1 from pg_constraint where conname='directory_applications_id_scope_key' and conrelid='public.directory_applications'::regclass), 'AA1 directory_applications_id_scope_key exists';
  -- runner EXECUTE on all four RPCs; PUBLIC/anon denied; NO direct edge DML.
  assert     has_function_privilege('connector_runner', 'public.runner_promote_okta_application_user_assignments(uuid,uuid)', 'EXECUTE'), 'AA1 runner EXECUTE promote user';
  assert     has_function_privilege('connector_runner', 'public.runner_promote_okta_application_group_assignments(uuid,uuid)', 'EXECUTE'), 'AA1 runner EXECUTE promote group';
  assert     has_function_privilege('connector_runner', 'public.runner_mark_absent_okta_application_user_assignments_stale(uuid,uuid)', 'EXECUTE'), 'AA1 runner EXECUTE stale user';
  assert     has_function_privilege('connector_runner', 'public.runner_mark_absent_okta_application_group_assignments_stale(uuid,uuid)', 'EXECUTE'), 'AA1 runner EXECUTE stale group';
  assert not has_function_privilege('public', 'public.runner_promote_okta_application_user_assignments(uuid,uuid)', 'EXECUTE'), 'AA1 PUBLIC denied promote user';
  assert not has_function_privilege('anon', 'public.runner_promote_okta_application_group_assignments(uuid,uuid)', 'EXECUTE'), 'AA1 anon denied promote group';
  assert not has_table_privilege('connector_runner', 'public.directory_application_user_assignments', 'INSERT'), 'AA1 runner NO direct user-edge INSERT';
  assert not has_table_privilege('connector_runner', 'public.directory_application_group_assignments', 'SELECT'), 'AA1 runner NO direct group-edge SELECT';
  assert (select relrowsecurity from pg_class where oid='public.directory_application_user_assignments'::regclass)=true, 'AA1 user-edge RLS enabled';
  assert (select relrowsecurity from pg_class where oid='public.directory_application_group_assignments'::regclass)=true, 'AA1 group-edge RLS enabled';
  assert (select count(*) from pg_policies where schemaname='public' and tablename in ('directory_application_user_assignments','directory_application_group_assignments'))=0, 'AA1 deny-all (no policy) on both';
  assert not exists (select 1 from information_schema.columns where table_schema='public' and table_name in ('directory_application_user_assignments','directory_application_group_assignments') and column_name='raw_payload'), 'AA1 NO raw_payload column';
  assert (select array_to_string(proconfig,',') from pg_proc where proname='runner_promote_okta_application_user_assignments') like 'search_path=%', 'AA1 promote user search_path pinned';
  assert (select array_to_string(proconfig,',') from pg_proc where proname='runner_mark_absent_okta_application_group_assignments_stale') like 'search_path=%', 'AA1 stale group search_path pinned';
end $$;

-- ════ AA2: promotion — complete run resolves BOTH endpoint kinds; creates ONE user edge + ONE group edge, connection-scoped ════
do $$ declare r jsonb; begin
  perform pg_temp.seed_assignment_run('a2a20000-0000-4000-8000-0000000000a2','ca2a0000-0000-4000-8000-0000000000ca','d2000001-0000-4000-8000-000000000001',
    '[{"a":"0oaS1","u":"00uS1"}]'::jsonb, '[{"a":"0oaS1","g":"00gS1"}]'::jsonb, true, 0, 'last_page');
  r := public.runner_promote_okta_application_user_assignments('d2000001-0000-4000-8000-000000000001','a2a20000-0000-4000-8000-0000000000a2');
  assert (r->>'userAssignmentsCreated')::int = 1 and (r->>'userAssignmentsUpdated')::int = 0, 'AA2 one user edge created';
  r := public.runner_promote_okta_application_group_assignments('d2000001-0000-4000-8000-000000000001','a2a20000-0000-4000-8000-0000000000a2');
  assert (r->>'groupAssignmentsCreated')::int = 1 and (r->>'groupAssignmentsUpdated')::int = 0, 'AA2 one group edge created';
  assert (select count(*) from public.directory_application_user_assignments a
            join public.directory_applications da on da.id=a.directory_application_id and da.external_id='0oaS1'
            join public.identity_accounts ia on ia.id=a.identity_account_id and ia.external_id='00uS1'
           where a.connection_id='ca2a0000-0000-4000-8000-0000000000ca' and a.sync_status='current')=1, 'AA2 user edge binds resolved canonical app+identity, scoped to CA2';
  assert (select count(*) from public.directory_application_group_assignments a
            join public.directory_applications da on da.id=a.directory_application_id and da.external_id='0oaS1'
            join public.directory_groups dg on dg.id=a.directory_group_id and dg.external_id='00gS1'
           where a.connection_id='ca2a0000-0000-4000-8000-0000000000ca' and a.sync_status='current')=1, 'AA2 group edge binds resolved canonical app+group, scoped to CA2';
end $$;

-- ════ AA3: DUAL-ENDPOINT fail-closed — an unresolved app / user / group aborts the WHOLE promotion; no edge persists ══════════
do $$ declare ok boolean; begin
  -- unresolved USER
  perform pg_temp.seed_assignment_run('a2a20000-0000-4000-8000-0000000000a2','ca2a0000-0000-4000-8000-0000000000ca','d2000002-0000-4000-8000-000000000002',
    '[{"a":"0oaS1","u":"00uMISS"}]'::jsonb, '[]'::jsonb, true, 0, 'last_page');
  ok:=false; begin perform public.runner_promote_okta_application_user_assignments('d2000002-0000-4000-8000-000000000002','a2a20000-0000-4000-8000-0000000000a2'); exception when others then ok:=true; end;
  assert ok, 'AA3 unresolved identity -> user promotion fails closed';
  -- unresolved APP (user edge)
  perform pg_temp.seed_assignment_run('a2a20000-0000-4000-8000-0000000000a2','ca2a0000-0000-4000-8000-0000000000ca','d2000003-0000-4000-8000-000000000003',
    '[{"a":"0oaMISS","u":"00uS1"}]'::jsonb, '[]'::jsonb, true, 0, 'last_page');
  ok:=false; begin perform public.runner_promote_okta_application_user_assignments('d2000003-0000-4000-8000-000000000003','a2a20000-0000-4000-8000-0000000000a2'); exception when others then ok:=true; end;
  assert ok, 'AA3 unresolved application -> user promotion fails closed';
  -- unresolved GROUP
  perform pg_temp.seed_assignment_run('a2a20000-0000-4000-8000-0000000000a2','ca2a0000-0000-4000-8000-0000000000ca','d2000004-0000-4000-8000-000000000004',
    '[]'::jsonb, '[{"a":"0oaS1","g":"00gMISS"}]'::jsonb, true, 0, 'last_page');
  ok:=false; begin perform public.runner_promote_okta_application_group_assignments('d2000004-0000-4000-8000-000000000004','a2a20000-0000-4000-8000-0000000000a2'); exception when others then ok:=true; end;
  assert ok, 'AA3 unresolved group -> group promotion fails closed';
  -- a MIXED user run (one resolvable, one not) aborts the WHOLE run — no partial edge
  perform pg_temp.seed_assignment_run('a2a20000-0000-4000-8000-0000000000a2','ca2a0000-0000-4000-8000-0000000000ca','d2000005-0000-4000-8000-000000000005',
    '[{"a":"0oaS1","u":"00uS2"},{"a":"0oaS1","u":"00uMISS"}]'::jsonb, '[]'::jsonb, true, 0, 'last_page');
  ok:=false; begin perform public.runner_promote_okta_application_user_assignments('d2000005-0000-4000-8000-000000000005','a2a20000-0000-4000-8000-0000000000a2'); exception when others then ok:=true; end;
  assert ok, 'AA3 mixed user run fails closed (all-or-nothing)';
  assert (select count(*) from public.directory_application_user_assignments a join public.identity_accounts ia on ia.id=a.identity_account_id where ia.external_id='00uS2')=0, 'AA3 no partial edge from the mixed run';
end $$;

-- ════ AA4: promotion gate — incomplete / rejected / wrong-tenant blocked (both edges) ════════════════════════════════════════
do $$ declare ok boolean; begin
  perform pg_temp.seed_assignment_run('a2a20000-0000-4000-8000-0000000000a2','ca2a0000-0000-4000-8000-0000000000ca','d2000006-0000-4000-8000-000000000006',
    '[{"a":"0oaS1","u":"00uS2"}]'::jsonb, '[]'::jsonb, false, 0, 'last_page');
  ok:=false; begin perform public.runner_promote_okta_application_user_assignments('d2000006-0000-4000-8000-000000000006','a2a20000-0000-4000-8000-0000000000a2'); exception when others then ok:=true; end;
  assert ok, 'AA4 incomplete run blocked (user)';
  perform pg_temp.seed_assignment_run('a2a20000-0000-4000-8000-0000000000a2','ca2a0000-0000-4000-8000-0000000000ca','d2000007-0000-4000-8000-000000000007',
    '[]'::jsonb, '[{"a":"0oaS1","g":"00gS1"}]'::jsonb, true, 1, 'last_page');
  ok:=false; begin perform public.runner_promote_okta_application_group_assignments('d2000007-0000-4000-8000-000000000007','a2a20000-0000-4000-8000-0000000000a2'); exception when others then ok:=true; end;
  assert ok, 'AA4 rejected>0 blocked (group)';
  -- wrong-tenant: run d2000001 belongs to tenant A2; promoting under tenant B2 must fail
  ok:=false; begin perform public.runner_promote_okta_application_user_assignments('d2000001-0000-4000-8000-000000000001','b2b20000-0000-4000-8000-0000000000b2'); exception when others then ok:=true; end;
  assert ok, 'AA4 wrong-tenant blocked';
end $$;

-- ════ AA5: idempotent replay + immutable edge (rename app label / group name doesn't dup) + first_seen stable ════════════════
do $$ declare r jsonb; v_first timestamptz; v_last1 timestamptz; begin
  select a.first_seen_at, a.last_seen_at into v_first, v_last1 from public.directory_application_user_assignments a
    join public.identity_accounts ia on ia.id=a.identity_account_id and ia.external_id='00uS1'
   where a.connection_id='ca2a0000-0000-4000-8000-0000000000ca';
  perform pg_sleep(0.01);
  -- change the app LABEL + the group NAME — the edges must still resolve to the same canonical rows (external_ids immutable)
  update public.directory_applications set label='Renamed App' where external_id='0oaS1' and connection_id='ca2a0000-0000-4000-8000-0000000000ca';
  update public.directory_groups set name='Renamed Group' where external_id='00gS1' and connection_id='ca2a0000-0000-4000-8000-0000000000ca';
  perform pg_temp.seed_assignment_run('a2a20000-0000-4000-8000-0000000000a2','ca2a0000-0000-4000-8000-0000000000ca','d2000008-0000-4000-8000-000000000008',
    '[{"a":"0oaS1","u":"00uS1"}]'::jsonb, '[{"a":"0oaS1","g":"00gS1"}]'::jsonb, true, 0, 'last_page');
  r := public.runner_promote_okta_application_user_assignments('d2000008-0000-4000-8000-000000000008','a2a20000-0000-4000-8000-0000000000a2');
  assert (r->>'userAssignmentsUpdated')::int = 1 and (r->>'userAssignmentsCreated')::int = 0, 'AA5 user replay updates, no new edge';
  r := public.runner_promote_okta_application_group_assignments('d2000008-0000-4000-8000-000000000008','a2a20000-0000-4000-8000-0000000000a2');
  assert (r->>'groupAssignmentsUpdated')::int = 1 and (r->>'groupAssignmentsCreated')::int = 0, 'AA5 group replay updates, no new edge';
  assert (select count(*) from public.directory_application_user_assignments a join public.identity_accounts ia on ia.id=a.identity_account_id and ia.external_id='00uS1' where a.connection_id='ca2a0000-0000-4000-8000-0000000000ca')=1, 'AA5 no duplicate user edge (immutable key)';
  assert (select a.first_seen_at=v_first from public.directory_application_user_assignments a join public.identity_accounts ia on ia.id=a.identity_account_id and ia.external_id='00uS1' where a.connection_id='ca2a0000-0000-4000-8000-0000000000ca')=true, 'AA5 first_seen preserved';
  assert (select a.last_seen_at>v_last1 from public.directory_application_user_assignments a join public.identity_accounts ia on ia.id=a.identity_account_id and ia.external_id='00uS1' where a.connection_id='ca2a0000-0000-4000-8000-0000000000ca')=true, 'AA5 last_seen advanced';
end $$;

-- ════ AA6: cross-tenant + cross-connection isolation (same (app,user) external ids -> separate canonical endpoints -> separate edges) ══
do $$ begin
  perform pg_temp.seed_assignment_run('b2b20000-0000-4000-8000-0000000000b2','cc2c0000-0000-4000-8000-0000000000cc','d2000009-0000-4000-8000-000000000009',
    '[{"a":"0oaS1","u":"00uS1"}]'::jsonb, '[]'::jsonb, true, 0, 'last_page');
  perform public.runner_promote_okta_application_user_assignments('d2000009-0000-4000-8000-000000000009','b2b20000-0000-4000-8000-0000000000b2');
  perform pg_temp.seed_assignment_run('a2a20000-0000-4000-8000-0000000000a2','cb2b0000-0000-4000-8000-0000000000cb','d2000010-0000-4000-8000-000000000010',
    '[{"a":"0oaS1","u":"00uS1"}]'::jsonb, '[]'::jsonb, true, 0, 'last_page');
  perform public.runner_promote_okta_application_user_assignments('d2000010-0000-4000-8000-000000000010','a2a20000-0000-4000-8000-0000000000a2');
  assert (select count(*) from public.directory_application_user_assignments where connection_id='cc2c0000-0000-4000-8000-0000000000cc')=1, 'AA6 B2/CC2 has its own user edge';
  assert (select count(*) from public.directory_application_user_assignments where connection_id='cb2b0000-0000-4000-8000-0000000000cb')=1, 'AA6 CB2 has its own user edge';
  assert (select count(distinct connection_id) from public.directory_application_user_assignments)=3, 'AA6 user edges are per-connection (CA2, CB2, CC2)';
end $$;

-- ════ AA7: stale — first run zero; complete second run stales an absent user edge; scoped; no hard delete ════════════════════
do $$ declare r jsonb; begin
  -- first-run rule on CC2 (only run d9): re-stale-eval -> zero
  r := public.runner_mark_absent_okta_application_user_assignments_stale('d2000009-0000-4000-8000-000000000009','b2b20000-0000-4000-8000-0000000000b2');
  assert (r->>'staleMarked')::int = 0 and (r->>'firstRun')::boolean = true, 'AA7 first run stales zero';
  -- CA2 currently has user edge (0oaS1,00uS1). A SECOND complete run with a DIFFERENT pair (0oaS2,00uS2) -> (0oaS1,00uS1) becomes absent -> stale.
  perform pg_temp.seed_assignment_run('a2a20000-0000-4000-8000-0000000000a2','ca2a0000-0000-4000-8000-0000000000ca','d2000011-0000-4000-8000-000000000011',
    '[{"a":"0oaS2","u":"00uS2"}]'::jsonb, '[]'::jsonb, true, 0, 'last_page');
  perform public.runner_promote_okta_application_user_assignments('d2000011-0000-4000-8000-000000000011','a2a20000-0000-4000-8000-0000000000a2');
  update public.connector_discovery_policy set stale_percent_threshold=90 where provider='okta'; -- 1/2 absent = 50% > 30% default
  r := public.runner_mark_absent_okta_application_user_assignments_stale('d2000011-0000-4000-8000-000000000011','a2a20000-0000-4000-8000-0000000000a2');
  update public.connector_discovery_policy set stale_percent_threshold=30 where provider='okta';
  assert (r->>'staleMarked')::int = 1, 'AA7 absent prior user edge (0oaS1,00uS1 on CA2) marked stale';
  assert (select a.sync_status='stale' and a.stale_since is not null from public.directory_application_user_assignments a join public.identity_accounts ia on ia.id=a.identity_account_id and ia.external_id='00uS1' where a.connection_id='ca2a0000-0000-4000-8000-0000000000ca')=true, 'AA7 absent user edge stale (not deleted)';
  assert (select count(*) from public.directory_application_user_assignments where connection_id='ca2a0000-0000-4000-8000-0000000000ca')=2, 'AA7 no hard delete (2 user edges: one stale, one current)';
  -- PARTIAL run stales zero
  perform pg_temp.seed_assignment_run('a2a20000-0000-4000-8000-0000000000a2','ca2a0000-0000-4000-8000-0000000000ca','d2000012-0000-4000-8000-000000000012',
    '[{"a":"0oaS2","u":"00uS2"}]'::jsonb, '[]'::jsonb, false, 0, 'error:transient/okta_network_error');
  r := public.runner_mark_absent_okta_application_user_assignments_stale('d2000012-0000-4000-8000-000000000012','a2a20000-0000-4000-8000-0000000000a2');
  assert (r->>'staleMarked')::int = 0 and (r->>'eligible')::boolean = false, 'AA7 partial run stales zero';
end $$;

-- ════ AA8: write-boundary guards — fact key allowlist (both types) + circuit breaker ═════════════════════════════════════════
do $$ declare r jsonb; ok boolean; begin
  insert into public.connector_runs (id, tenant_id, connector_id, status, started_at) values ('d2f00000-0000-4000-8000-00000000000f','a2a20000-0000-4000-8000-0000000000a2','ca2a0000-0000-4000-8000-0000000000ca','running',now());
  -- application_user_assignment fact key ALLOWLIST rejects a non-approved key (e.g. a scope/login leak)
  ok:=false; begin perform public.runner_insert_discovery_fact('a2a20000-0000-4000-8000-0000000000a2','d2f00000-0000-4000-8000-00000000000f','application_user_assignment','identity_provider_discovery','okta','okta:x:aua:a:u','a:u',now(),1.0,
    jsonb_build_object('fact_type','application_user_assignment','connection_id','ca2a0000-0000-4000-8000-0000000000ca','application_external_id','0oaS1','user_external_id','00uS1','scope','USER'), null); exception when others then ok:=true; end;
  assert ok, 'AA8 application_user_assignment non-approved key rejected';
  -- application_group_assignment fact key ALLOWLIST rejects a non-approved key (e.g. a group name leak)
  ok:=false; begin perform public.runner_insert_discovery_fact('a2a20000-0000-4000-8000-0000000000a2','d2f00000-0000-4000-8000-00000000000f','application_group_assignment','identity_provider_discovery','okta','okta:x:aga:a:g','a:g',now(),1.0,
    jsonb_build_object('fact_type','application_group_assignment','connection_id','ca2a0000-0000-4000-8000-0000000000ca','application_external_id','0oaS1','group_external_id','00gS1','name','Engineering'), null); exception when others then ok:=true; end;
  assert ok, 'AA8 application_group_assignment non-approved key rejected';
  -- circuit breaker: abs threshold 0 -> any absence triggers review, stales zero
  update public.connector_discovery_policy set stale_absolute_threshold=0, stale_percent_threshold=0 where provider='okta';
  perform pg_temp.seed_assignment_run('a2a20000-0000-4000-8000-0000000000a2','ca2a0000-0000-4000-8000-0000000000ca','d2f00003-0000-4000-8000-000000000003', '[]'::jsonb, '[]'::jsonb, true, 0, 'last_page');
  perform public.runner_promote_okta_application_user_assignments('d2f00003-0000-4000-8000-000000000003','a2a20000-0000-4000-8000-0000000000a2');
  r := public.runner_mark_absent_okta_application_user_assignments_stale('d2f00003-0000-4000-8000-000000000003','a2a20000-0000-4000-8000-0000000000a2');
  assert (r->>'circuitBreakerTriggered')::boolean = true and (r->>'staleMarked')::int = 0, 'AA8 circuit breaker fires, stales zero';
  update public.connector_discovery_policy set stale_absolute_threshold=100, stale_percent_threshold=30 where provider='okta';
end $$;

-- ════ AA9: the two edges are SEPARATE — a group-to-app assignment is NEVER expanded to member user edges (no effective access) ══
do $$ declare r jsonb; begin
  -- a run with ONLY a group assignment must create ONLY a group edge and ZERO user edges (even though 00gS1 conceptually has members).
  perform pg_temp.seed_assignment_run('a2a20000-0000-4000-8000-0000000000a2','cb2b0000-0000-4000-8000-0000000000cb','d2f00009-0000-4000-8000-000000000009',
    '[]'::jsonb, '[{"a":"0oaS1","g":"00gS1"}]'::jsonb, true, 0, 'last_page');
  r := public.runner_promote_okta_application_group_assignments('d2f00009-0000-4000-8000-000000000009','a2a20000-0000-4000-8000-0000000000a2');
  assert (r->>'groupAssignmentsCreated')::int = 1, 'AA9 group-only run creates one group edge';
  -- the group-only run advanced the group edge, and left the user-edge count on CB2 UNCHANGED (still exactly the one from AA6).
  assert (select count(*) from public.directory_application_group_assignments where connection_id='cb2b0000-0000-4000-8000-0000000000cb')=1, 'AA9 one group edge on CB2';
  assert (select count(*) from public.directory_application_user_assignments where connection_id='cb2b0000-0000-4000-8000-0000000000cb')=1, 'AA9 group assignment did NOT fan out to user edges (no effective access)';
end $$;

reset role;
do $$ begin raise notice 'ALL OKTA APPLICATION ASSIGNMENT PERSISTENCE ASSERTIONS PASSED'; end $$;
