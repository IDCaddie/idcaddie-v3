-- okta_directory_application_persistence_test.sql — verifies migration 0057 (directory_applications, 'directory_application' fact type,
-- promotion + stale RPCs, the OPTIONAL nullable catalog link). Runs against the SHARED harness DB, so fixtures use UUIDs distinct from
-- the other tests (a9-prefix). NEVER touches hosted Supabase. staging only.

reset role;

-- ── Fixtures: tenant A (okta conns A1, A2); tenant B (okta conn B1); one catalog product in tenant A. ──
insert into public.tenants (id, name, slug) values
  ('a9000000-0000-4000-8000-000000000001', 'Okta App A', 'okta-app-a'),
  ('a9000000-0000-4000-8000-000000000002', 'Okta App B', 'okta-app-b');
insert into public.connectors (id, tenant_id, provider, status, connection_state) values
  ('a9000000-0000-4000-8000-0000000000c1', 'a9000000-0000-4000-8000-000000000001', 'okta', 'pending', 'discovered'),
  ('a9000000-0000-4000-8000-0000000000c2', 'a9000000-0000-4000-8000-000000000001', 'okta', 'pending', 'discovered'),
  ('a9000000-0000-4000-8000-0000000000c3', 'a9000000-0000-4000-8000-000000000002', 'okta', 'pending', 'discovered'),
  ('a9000000-0000-4000-8000-0000000000c4', 'a9000000-0000-4000-8000-000000000001', 'okta', 'pending', 'discovered');
insert into public.app_products (id, tenant_id, name, normalized_name) values
  ('a9000000-0000-4000-8000-0000000000d1', 'a9000000-0000-4000-8000-000000000001', 'Salesforce', 'salesforce');

-- helper: seed an application run — one directory_application fact per app + metrics.
create or replace function pg_temp.seed_app_run(p_tenant uuid, p_conn uuid, p_run uuid, p_apps jsonb, p_complete boolean, p_rejected integer, p_term text)
  returns void language plpgsql as $$
declare app jsonb; n integer := jsonb_array_length(p_apps);
begin
  insert into public.connector_runs (id, tenant_id, connector_id, status, started_at) values (p_run, p_tenant, p_conn, 'running', clock_timestamp());
  for app in select * from jsonb_array_elements(p_apps) loop
    perform public.runner_insert_discovery_fact(
      p_tenant, p_run, 'directory_application', 'identity_provider_discovery', 'okta',
      'okta:'||p_conn||':application:'||(app->>'ext'), app->>'ext', now(), 1.0,
      jsonb_build_object('fact_type','directory_application','connection_id',p_conn::text,'external_id',app->>'ext',
        'label',app->>'label','status_category',coalesce(app->>'status','active'),'sign_on_category',coalesce(app->>'signon','openid_connect')),
      jsonb_build_object('provider','okta','source_endpoint','apps','schema_version','1','sanitizer_version','1','normalizer_version','1'));
  end loop;
  perform public.runner_record_okta_discovery_metrics(p_run, p_tenant, 1, n, n, n, p_rejected, p_term, p_complete, '1','1','1', null);
end $$;

-- ════ DA1: grants + no raw_payload + RLS deny-all + search_path pinned ════════════════════════════════════════════════
do $$ begin
  assert     has_function_privilege('connector_runner', 'public.runner_promote_okta_directory_applications(uuid,uuid)', 'EXECUTE'), 'DA1 runner EXECUTE promote';
  assert     has_function_privilege('connector_runner', 'public.runner_mark_absent_okta_directory_applications_stale(uuid,uuid)', 'EXECUTE'), 'DA1 runner EXECUTE stale';
  assert not has_function_privilege('public', 'public.runner_promote_okta_directory_applications(uuid,uuid)', 'EXECUTE'), 'DA1 PUBLIC denied';
  assert not has_function_privilege('anon', 'public.runner_promote_okta_directory_applications(uuid,uuid)', 'EXECUTE'), 'DA1 anon denied';
  assert not has_table_privilege('connector_runner', 'public.directory_applications', 'INSERT'), 'DA1 runner NO direct INSERT';
  assert not has_table_privilege('anon', 'public.directory_applications', 'SELECT'), 'DA1 anon NO direct SELECT';
  assert (select relrowsecurity from pg_class where oid='public.directory_applications'::regclass)=true, 'DA1 RLS enabled';
  assert (select count(*) from pg_policies where schemaname='public' and tablename='directory_applications')=0, 'DA1 deny-all';
  assert not exists (select 1 from information_schema.columns where table_schema='public' and table_name='directory_applications' and column_name='raw_payload'), 'DA1 NO raw_payload';
  assert (select array_to_string(proconfig,',') from pg_proc where proname='runner_promote_okta_directory_applications') like 'search_path=%', 'DA1 promote search_path pinned';
end $$;

-- ════ DA2: promotion — complete run creates rows with categories; catalog stays NULL/unmatched ════════════════════════
do $$ declare r jsonb; begin
  perform pg_temp.seed_app_run('a9000000-0000-4000-8000-000000000001','a9000000-0000-4000-8000-0000000000c1','a9000000-0000-4000-8000-00000000e001',
    '[{"ext":"0oa1","label":"Salesforce","status":"active","signon":"saml_2_0"},{"ext":"0oa2","label":"Widget","status":"inactive","signon":"openid_connect"}]'::jsonb, true, 0, 'last_page');
  r := public.runner_promote_okta_directory_applications('a9000000-0000-4000-8000-00000000e001','a9000000-0000-4000-8000-000000000001');
  assert (r->>'applicationsCreated')::int = 2 and (r->>'applicationsUpdated')::int = 0, 'DA2 two apps created';
  assert (select count(*) from public.directory_applications where connection_id='a9000000-0000-4000-8000-0000000000c1' and sync_status='current')=2, 'DA2 both current';
  assert (select status_category from public.directory_applications where external_id='0oa1' and connection_id='a9000000-0000-4000-8000-0000000000c1')='active', 'DA2 status_category stored';
  assert (select sign_on_category from public.directory_applications where external_id='0oa1' and connection_id='a9000000-0000-4000-8000-0000000000c1')='saml_2_0', 'DA2 sign_on_category stored';
  assert (select count(*) from public.directory_applications where connection_id='a9000000-0000-4000-8000-0000000000c1' and catalog_product_id is null and catalog_match_status='unmatched')=2, 'DA2 catalog NULL/unmatched (no matcher run)';
end $$;

-- ════ DA3: promotion gate — incomplete / rejected / wrong-tenant blocked; superseded refused ══════════════════════════
do $$ declare ok boolean; begin
  perform pg_temp.seed_app_run('a9000000-0000-4000-8000-000000000001','a9000000-0000-4000-8000-0000000000c1','a9000000-0000-4000-8000-00000000e002', '[{"ext":"0oa9"}]'::jsonb, false, 0, 'last_page');
  ok:=false; begin perform public.runner_promote_okta_directory_applications('a9000000-0000-4000-8000-00000000e002','a9000000-0000-4000-8000-000000000001'); exception when others then ok:=true; end;
  assert ok, 'DA3 incomplete blocked';
  perform pg_temp.seed_app_run('a9000000-0000-4000-8000-000000000001','a9000000-0000-4000-8000-0000000000c1','a9000000-0000-4000-8000-00000000e003', '[{"ext":"0oa9"}]'::jsonb, true, 1, 'last_page');
  ok:=false; begin perform public.runner_promote_okta_directory_applications('a9000000-0000-4000-8000-00000000e003','a9000000-0000-4000-8000-000000000001'); exception when others then ok:=true; end;
  assert ok, 'DA3 rejected>0 blocked';
  ok:=false; begin perform public.runner_promote_okta_directory_applications('a9000000-0000-4000-8000-00000000e001','a9000000-0000-4000-8000-000000000002'); exception when others then ok:=true; end;
  assert ok, 'DA3 wrong-tenant blocked';
  -- superseded refusal: promote run X, then a LATER complete run Y for the same connection makes X un-promotable + un-staleable.
  perform pg_temp.seed_app_run('a9000000-0000-4000-8000-000000000001','a9000000-0000-4000-8000-0000000000c4','a9000000-0000-4000-8000-00000000e00a', '[{"ext":"0oaX"}]'::jsonb, true, 0, 'last_page');
  perform public.runner_promote_okta_directory_applications('a9000000-0000-4000-8000-00000000e00a','a9000000-0000-4000-8000-000000000001');
  perform pg_temp.seed_app_run('a9000000-0000-4000-8000-000000000001','a9000000-0000-4000-8000-0000000000c4','a9000000-0000-4000-8000-00000000e00b', '[{"ext":"0oaX"}]'::jsonb, true, 0, 'last_page');
  ok:=false; begin perform public.runner_promote_okta_directory_applications('a9000000-0000-4000-8000-00000000e00a','a9000000-0000-4000-8000-000000000001'); exception when others then ok:=true; end;
  assert ok, 'DA3 superseded run refused (a later complete run exists)';
  assert (public.runner_mark_absent_okta_directory_applications_stale('a9000000-0000-4000-8000-00000000e00a','a9000000-0000-4000-8000-000000000001') ->> 'superseded')::boolean = true, 'DA3 superseded run stales nothing (eligible=false)';
end $$;

-- ════ DA4: idempotent replay + immutable key + label rename updates; first_seen preserved / last_seen advances ═════════
do $$ declare r jsonb; v_first timestamptz; v_last1 timestamptz; begin
  select first_seen_at, last_seen_at into v_first, v_last1 from public.directory_applications where external_id='0oa1' and connection_id='a9000000-0000-4000-8000-0000000000c1';
  perform pg_sleep(0.01);
  perform pg_temp.seed_app_run('a9000000-0000-4000-8000-000000000001','a9000000-0000-4000-8000-0000000000c1','a9000000-0000-4000-8000-00000000e004',
    '[{"ext":"0oa1","label":"Salesforce Renamed","status":"active","signon":"saml_2_0"},{"ext":"0oa2","label":"Widget","status":"inactive","signon":"openid_connect"}]'::jsonb, true, 0, 'last_page');
  r := public.runner_promote_okta_directory_applications('a9000000-0000-4000-8000-00000000e004','a9000000-0000-4000-8000-000000000001');
  assert (r->>'applicationsUpdated')::int = 2 and (r->>'applicationsCreated')::int = 0, 'DA4 replay updates, no new row';
  assert (select count(*) from public.directory_applications where external_id='0oa1' and connection_id='a9000000-0000-4000-8000-0000000000c1')=1, 'DA4 no duplicate (immutable key)';
  assert (select label from public.directory_applications where external_id='0oa1' and connection_id='a9000000-0000-4000-8000-0000000000c1')='Salesforce Renamed', 'DA4 label rename updated';
  assert (select first_seen_at=v_first from public.directory_applications where external_id='0oa1' and connection_id='a9000000-0000-4000-8000-0000000000c1')=true, 'DA4 first_seen preserved';
  assert (select last_seen_at>v_last1 from public.directory_applications where external_id='0oa1' and connection_id='a9000000-0000-4000-8000-0000000000c1')=true, 'DA4 last_seen advanced';
end $$;

-- ════ DA5: cross-tenant + cross-connection + cross-provider isolation of the same external_id ═════════════════════════
do $$ begin
  perform pg_temp.seed_app_run('a9000000-0000-4000-8000-000000000002','a9000000-0000-4000-8000-0000000000c3','a9000000-0000-4000-8000-00000000e005', '[{"ext":"0oa1","label":"B-app"}]'::jsonb, true, 0, 'last_page');
  perform public.runner_promote_okta_directory_applications('a9000000-0000-4000-8000-00000000e005','a9000000-0000-4000-8000-000000000002');
  perform pg_temp.seed_app_run('a9000000-0000-4000-8000-000000000001','a9000000-0000-4000-8000-0000000000c2','a9000000-0000-4000-8000-00000000e006', '[{"ext":"0oa1","label":"A2-app"}]'::jsonb, true, 0, 'last_page');
  perform public.runner_promote_okta_directory_applications('a9000000-0000-4000-8000-00000000e006','a9000000-0000-4000-8000-000000000001');
  -- external_id 0oa1 now exists in 3 distinct connections; each a separate row (immutable key includes connection_id)
  assert (select count(*) from public.directory_applications where external_id='0oa1')=3, 'DA5 same external_id in 3 connections = 3 rows';
  assert (select count(distinct connection_id) from public.directory_applications where external_id='0oa1')=3, 'DA5 per-connection isolation';
  -- cross-PROVIDER: the immutable key includes provider, so the SAME (tenant, connection, external_id) can coexist for a different
  -- provider. Direct-insert a microsoft_entra row on the SAME tenant+connection (c4)+external_id (0oaX) as the okta 0oaX row from DA3
  -- (the unique index (tenant,connection,provider,external_id) permits it because provider differs). c4/0oaX is used by no later assert.
  insert into public.directory_applications (tenant_id, connection_id, provider, external_id, label)
    values ('a9000000-0000-4000-8000-000000000001','a9000000-0000-4000-8000-0000000000c4','microsoft_entra','0oaX','entra-app');
  assert (select count(*) from public.directory_applications where external_id='0oaX' and connection_id='a9000000-0000-4000-8000-0000000000c4')=2, 'DA5 same tenant+connection+external_id, different provider -> 2 distinct rows';
  assert (select count(distinct provider) from public.directory_applications where external_id='0oaX' and connection_id='a9000000-0000-4000-8000-0000000000c4')=2, 'DA5 cross-provider isolation (okta + microsoft_entra coexist)';
end $$;

-- ════ DA6: catalog link safety — optional, valid FK settable, invalid rejected, on-delete-set-null, promotion untouched ═
do $$ declare ok boolean; begin
  -- a valid same-tenant catalog match can be set (a FUTURE matcher would; here we set it directly to prove the FK works)
  update public.directory_applications set catalog_product_id='a9000000-0000-4000-8000-0000000000d1', catalog_match_status='matched'
   where external_id='0oa1' and connection_id='a9000000-0000-4000-8000-0000000000c1';
  assert (select catalog_product_id from public.directory_applications where external_id='0oa1' and connection_id='a9000000-0000-4000-8000-0000000000c1')='a9000000-0000-4000-8000-0000000000d1', 'DA6 valid catalog FK set';
  -- a CROSS-TENANT catalog product is rejected by the same-tenant composite FK
  ok:=false; begin update public.directory_applications set catalog_product_id='a9000000-0000-4000-8000-0000000000d1' where connection_id='a9000000-0000-4000-8000-0000000000c3'; exception when others then ok:=true; end;
  assert ok, 'DA6 cross-tenant catalog FK rejected';
  -- deleting the catalog product SETS NULL (never deletes the provider app row)
  delete from public.app_products where id='a9000000-0000-4000-8000-0000000000d1';
  assert (select count(*) from public.directory_applications where external_id='0oa1' and connection_id='a9000000-0000-4000-8000-0000000000c1')=1, 'DA6 provider app survives catalog delete';
  assert (select catalog_product_id from public.directory_applications where external_id='0oa1' and connection_id='a9000000-0000-4000-8000-0000000000c1') is null, 'DA6 catalog delete -> set null';
  -- a re-promotion does NOT touch catalog columns (leaves them as-is)
  update public.directory_applications set catalog_match_status='review_required' where external_id='0oa2' and connection_id='a9000000-0000-4000-8000-0000000000c1';
  perform pg_temp.seed_app_run('a9000000-0000-4000-8000-000000000001','a9000000-0000-4000-8000-0000000000c1','a9000000-0000-4000-8000-00000000e007',
    '[{"ext":"0oa1","label":"S"},{"ext":"0oa2","label":"W"}]'::jsonb, true, 0, 'last_page');
  perform public.runner_promote_okta_directory_applications('a9000000-0000-4000-8000-00000000e007','a9000000-0000-4000-8000-000000000001');
  assert (select catalog_match_status from public.directory_applications where external_id='0oa2' and connection_id='a9000000-0000-4000-8000-0000000000c1')='review_required', 'DA6 promotion leaves catalog_match_status untouched';
  -- promotion did NOT create/mutate app_products (customer catalog): still zero products in tenant A (we deleted d1)
  assert (select count(*) from public.app_products where tenant_id='a9000000-0000-4000-8000-000000000001')=0, 'DA6 promotion never wrote app_products';
end $$;

-- ════ DA7: stale — first run zero; complete run stales absent; partial zero; circuit breaker ═══════════════════════════
do $$ declare r jsonb; begin
  -- conn A2 has exactly one run (e006) so far -> first-run rule -> zero
  r := public.runner_mark_absent_okta_directory_applications_stale('a9000000-0000-4000-8000-00000000e006','a9000000-0000-4000-8000-000000000001');
  assert (r->>'staleMarked')::int = 0 and (r->>'firstRun')::boolean = true, 'DA7 first run stales zero';
  -- conn A1 currently has 0oa1 + 0oa2 current (last run e007). A newer complete run with ONLY 0oa1 -> 0oa2 absent -> stale.
  perform pg_temp.seed_app_run('a9000000-0000-4000-8000-000000000001','a9000000-0000-4000-8000-0000000000c1','a9000000-0000-4000-8000-00000000e008', '[{"ext":"0oa1","label":"S"}]'::jsonb, true, 0, 'last_page');
  perform public.runner_promote_okta_directory_applications('a9000000-0000-4000-8000-00000000e008','a9000000-0000-4000-8000-000000000001');
  update public.connector_discovery_policy set stale_percent_threshold=90 where provider='okta'; -- 1/2 absent = 50% <= 90 -> no breaker
  r := public.runner_mark_absent_okta_directory_applications_stale('a9000000-0000-4000-8000-00000000e008','a9000000-0000-4000-8000-000000000001');
  update public.connector_discovery_policy set stale_percent_threshold=30 where provider='okta';
  assert (r->>'staleMarked')::int = 1, 'DA7 absent app (0oa2) marked stale';
  assert (select sync_status from public.directory_applications where external_id='0oa2' and connection_id='a9000000-0000-4000-8000-0000000000c1')='stale', 'DA7 0oa2 stale (not deleted)';
  assert (select count(*) from public.directory_applications where connection_id='a9000000-0000-4000-8000-0000000000c1')=2, 'DA7 no hard delete';
  -- partial run stales zero
  perform pg_temp.seed_app_run('a9000000-0000-4000-8000-000000000001','a9000000-0000-4000-8000-0000000000c1','a9000000-0000-4000-8000-00000000e009', '[{"ext":"0oa1","label":"S"}]'::jsonb, false, 0, 'error:transient/okta_network_error');
  r := public.runner_mark_absent_okta_directory_applications_stale('a9000000-0000-4000-8000-00000000e009','a9000000-0000-4000-8000-000000000001');
  assert (r->>'staleMarked')::int = 0 and (r->>'eligible')::boolean = false, 'DA7 partial run stales zero';
end $$;

-- ════ DA8: write-boundary guards — fact key allowlist + circuit breaker + category CHECK ═══════════════════════════════
do $$ declare r jsonb; ok boolean; begin
  insert into public.connector_runs (id, tenant_id, connector_id, status, started_at) values ('a9000000-0000-4000-8000-00000000ef01','a9000000-0000-4000-8000-000000000001','a9000000-0000-4000-8000-0000000000c1','running',now());
  -- a directory_application fact with a non-approved key (e.g. a settings/url leak) is rejected
  ok:=false; begin perform public.runner_insert_discovery_fact('a9000000-0000-4000-8000-000000000001','a9000000-0000-4000-8000-00000000ef01','directory_application','identity_provider_discovery','okta','okta:x:application:z','z',now(),1.0,
    jsonb_build_object('fact_type','directory_application','connection_id','a9000000-0000-4000-8000-0000000000c1','external_id','0oaZ','settings',jsonb_build_object('url','https://x')), null); exception when others then ok:=true; end;
  assert ok, 'DA8 directory_application non-approved key rejected';
  -- an out-of-range category is rejected by the CHECK constraint (defense beyond the runner categorizer)
  ok:=false; begin insert into public.directory_applications (tenant_id, connection_id, provider, external_id, status_category) values ('a9000000-0000-4000-8000-000000000001','a9000000-0000-4000-8000-0000000000c1','okta','0oaBAD','WEIRD'); exception when others then ok:=true; end;
  assert ok, 'DA8 out-of-set status_category rejected by CHECK';
  -- circuit breaker: abs threshold 0 -> any absence trips review, stales zero
  update public.connector_discovery_policy set stale_absolute_threshold=0, stale_percent_threshold=0 where provider='okta';
  perform pg_temp.seed_app_run('a9000000-0000-4000-8000-000000000001','a9000000-0000-4000-8000-0000000000c1','a9000000-0000-4000-8000-00000000ef02', '[]'::jsonb, true, 0, 'last_page');
  perform public.runner_promote_okta_directory_applications('a9000000-0000-4000-8000-00000000ef02','a9000000-0000-4000-8000-000000000001');
  r := public.runner_mark_absent_okta_directory_applications_stale('a9000000-0000-4000-8000-00000000ef02','a9000000-0000-4000-8000-000000000001');
  assert (r->>'circuitBreakerTriggered')::boolean = true and (r->>'staleMarked')::int = 0, 'DA8 circuit breaker fires, stales zero';
  update public.connector_discovery_policy set stale_absolute_threshold=100, stale_percent_threshold=30 where provider='okta';
end $$;

reset role;
do $$ begin raise notice 'ALL OKTA DIRECTORY APPLICATION PERSISTENCE ASSERTIONS PASSED'; end $$;
