-- okta_group_membership_persistence_test.sql — verifies migration 0056 (directory_group_memberships edge, composite-FK integrity,
-- 'directory_group_membership' fact type, dual-endpoint-resolution promotion RPC, stale/circuit-breaker RPC). Runs against the SHARED
-- harness DB, so fixtures use UUIDs distinct from the other tests. NEVER touches hosted Supabase. staging only.

reset role;

-- ── Fixtures: tenant M8A (okta conns CM7, CM7B); tenant M8B (okta conn CM8). Endpoints (groups + identities) seeded per connection. ──
insert into public.tenants (id, name, slug) values
  ('77777777-0000-4000-8000-000000000007', 'Okta M8A', 'okta-m8a'),
  ('88888888-0000-4000-8000-000000000008', 'Okta M8B', 'okta-m8b');
insert into public.connectors (id, tenant_id, provider, status, connection_state) values
  ('c7c7c7c7-0000-4000-8000-000000000007', '77777777-0000-4000-8000-000000000007', 'okta', 'pending', 'discovered'),
  ('c7b7c7b7-0000-4000-8000-00000000007b', '77777777-0000-4000-8000-000000000007', 'okta', 'pending', 'discovered'),
  ('c8c8c8c8-0000-4000-8000-000000000008', '88888888-0000-4000-8000-000000000008', 'okta', 'pending', 'discovered');
-- canonical GROUP + IDENTITY endpoints (the composite FKs bind edges to these). CM7 has group 00gM1 + identities 00uM1/00uM2.
insert into public.directory_groups (tenant_id, connection_id, provider, external_id, sync_status) values
  ('77777777-0000-4000-8000-000000000007', 'c7c7c7c7-0000-4000-8000-000000000007', 'okta', '00gM1', 'current'),
  ('77777777-0000-4000-8000-000000000007', 'c7b7c7b7-0000-4000-8000-00000000007b', 'okta', '00gM1', 'current'),
  ('88888888-0000-4000-8000-000000000008', 'c8c8c8c8-0000-4000-8000-000000000008', 'okta', '00gM1', 'current');
insert into public.identity_accounts (tenant_id, connection_id, provider, external_id, sync_status) values
  ('77777777-0000-4000-8000-000000000007', 'c7c7c7c7-0000-4000-8000-000000000007', 'okta', '00uM1', 'current'),
  ('77777777-0000-4000-8000-000000000007', 'c7c7c7c7-0000-4000-8000-000000000007', 'okta', '00uM2', 'current'),
  ('77777777-0000-4000-8000-000000000007', 'c7b7c7b7-0000-4000-8000-00000000007b', 'okta', '00uM1', 'current'),
  ('88888888-0000-4000-8000-000000000008', 'c8c8c8c8-0000-4000-8000-000000000008', 'okta', '00uM1', 'current');

-- helper: seed a membership run — one directory_group_membership fact per (g,u) pair + metrics.
create or replace function pg_temp.seed_membership_run(p_tenant uuid, p_conn uuid, p_run uuid, p_pairs jsonb, p_complete boolean, p_rejected integer, p_term text)
  returns void language plpgsql as $$
declare pair jsonb; n integer := jsonb_array_length(p_pairs);
begin
  insert into public.connector_runs (id, tenant_id, connector_id, status, started_at) values (p_run, p_tenant, p_conn, 'running', clock_timestamp());
  for pair in select * from jsonb_array_elements(p_pairs) loop
    perform public.runner_insert_discovery_fact(
      p_tenant, p_run, 'directory_group_membership', 'identity_provider_discovery', 'okta',
      'okta:'||p_conn||':group-membership:'||(pair->>'g')||':'||(pair->>'u'), (pair->>'g')||':'||(pair->>'u'), now(), 1.0,
      jsonb_build_object('fact_type','directory_group_membership','connection_id',p_conn::text,'group_external_id',pair->>'g','user_external_id',pair->>'u'),
      jsonb_build_object('provider','okta','source_endpoint','group_members','schema_version','1','sanitizer_version','1','normalizer_version','1'));
  end loop;
  perform public.runner_record_okta_discovery_metrics(p_run, p_tenant, 1, n, n, n, p_rejected, p_term, p_complete, '1','1','1', null);
end $$;

-- ════ MM1: grants + no raw_payload + RLS deny-all + search_path pinned ════════════════════════════════════════════════════
do $$ begin
  assert     has_function_privilege('connector_runner', 'public.runner_promote_okta_directory_group_memberships(uuid,uuid)', 'EXECUTE'), 'MM1 runner EXECUTE promote';
  assert     has_function_privilege('connector_runner', 'public.runner_mark_absent_okta_directory_group_memberships_stale(uuid,uuid)', 'EXECUTE'), 'MM1 runner EXECUTE stale';
  assert not has_function_privilege('public', 'public.runner_promote_okta_directory_group_memberships(uuid,uuid)', 'EXECUTE'), 'MM1 PUBLIC denied promote';
  assert not has_function_privilege('anon', 'public.runner_promote_okta_directory_group_memberships(uuid,uuid)', 'EXECUTE'), 'MM1 anon denied promote';
  assert not has_table_privilege('connector_runner', 'public.directory_group_memberships', 'INSERT'), 'MM1 runner NO direct edge INSERT';
  assert not has_table_privilege('connector_runner', 'public.directory_group_memberships', 'SELECT'), 'MM1 runner NO direct edge SELECT';
  assert (select relrowsecurity from pg_class where oid='public.directory_group_memberships'::regclass)=true, 'MM1 RLS enabled';
  assert (select count(*) from pg_policies where schemaname='public' and tablename='directory_group_memberships')=0, 'MM1 deny-all (no policy)';
  assert not exists (select 1 from information_schema.columns where table_schema='public' and table_name='directory_group_memberships' and column_name='raw_payload'), 'MM1 NO raw_payload column';
  assert (select array_to_string(proconfig,',') from pg_proc where proname='runner_promote_okta_directory_group_memberships') like 'search_path=%', 'MM1 promote search_path pinned';
end $$;

-- ════ MM2: promotion — complete run resolves both endpoints + creates ONE edge, scoped to the connection ════════════════════
do $$ declare r jsonb; begin
  perform pg_temp.seed_membership_run('77777777-0000-4000-8000-000000000007','c7c7c7c7-0000-4000-8000-000000000007','a7a7a7a7-0000-4000-8000-0000000000a7', '[{"g":"00gM1","u":"00uM1"}]'::jsonb, true, 0, 'last_page');
  r := public.runner_promote_okta_directory_group_memberships('a7a7a7a7-0000-4000-8000-0000000000a7','77777777-0000-4000-8000-000000000007');
  assert (r->>'membershipsCreated')::int = 1 and (r->>'membershipsUpdated')::int = 0, 'MM2 one edge created';
  assert (select count(*) from public.directory_group_memberships m
            join public.directory_groups dg on dg.id=m.directory_group_id and dg.external_id='00gM1'
            join public.identity_accounts ia on ia.id=m.identity_account_id and ia.external_id='00uM1'
           where m.connection_id='c7c7c7c7-0000-4000-8000-000000000007' and m.sync_status='current')=1, 'MM2 edge binds the resolved canonical endpoints, scoped to CM7';
end $$;

-- ════ MM3: DUAL-ENDPOINT fail-closed — an unresolved group OR user aborts the WHOLE promotion; no edge persists ══════════════
do $$ declare ok boolean; begin
  perform pg_temp.seed_membership_run('77777777-0000-4000-8000-000000000007','c7c7c7c7-0000-4000-8000-000000000007','b7b7b7b7-0000-4000-8000-0000000000b7', '[{"g":"00gM1","u":"00uMISSING"}]'::jsonb, true, 0, 'last_page');
  ok:=false; begin perform public.runner_promote_okta_directory_group_memberships('b7b7b7b7-0000-4000-8000-0000000000b7','77777777-0000-4000-8000-000000000007'); exception when others then ok:=true; end;
  assert ok, 'MM3 unresolved identity -> promotion fails closed';
  perform pg_temp.seed_membership_run('77777777-0000-4000-8000-000000000007','c7c7c7c7-0000-4000-8000-000000000007','b8b8b8b8-0000-4000-8000-0000000000b8', '[{"g":"00gMISSING","u":"00uM1"}]'::jsonb, true, 0, 'last_page');
  ok:=false; begin perform public.runner_promote_okta_directory_group_memberships('b8b8b8b8-0000-4000-8000-0000000000b8','77777777-0000-4000-8000-000000000007'); exception when others then ok:=true; end;
  assert ok, 'MM3 unresolved group -> promotion fails closed';
  -- a MIX (one resolvable, one not) aborts the WHOLE run — no partial edge
  perform pg_temp.seed_membership_run('77777777-0000-4000-8000-000000000007','c7c7c7c7-0000-4000-8000-000000000007','b9b9b9b9-0000-4000-8000-0000000000b9', '[{"g":"00gM1","u":"00uM2"},{"g":"00gM1","u":"00uMISSING"}]'::jsonb, true, 0, 'last_page');
  ok:=false; begin perform public.runner_promote_okta_directory_group_memberships('b9b9b9b9-0000-4000-8000-0000000000b9','77777777-0000-4000-8000-000000000007'); exception when others then ok:=true; end;
  assert ok, 'MM3 mixed run fails closed (all-or-nothing)';
  assert (select count(*) from public.directory_group_memberships m join public.identity_accounts ia on ia.id=m.identity_account_id where ia.external_id='00uM2')=0, 'MM3 no partial edge from the mixed run';
end $$;

-- ════ MM4: promotion gate — incomplete / rejected / wrong-tenant blocked ═════════════════════════════════════════════════════
do $$ declare ok boolean; begin
  perform pg_temp.seed_membership_run('77777777-0000-4000-8000-000000000007','c7c7c7c7-0000-4000-8000-000000000007','c7000001-0000-4000-8000-000000000001', '[{"g":"00gM1","u":"00uM2"}]'::jsonb, false, 0, 'last_page');
  ok:=false; begin perform public.runner_promote_okta_directory_group_memberships('c7000001-0000-4000-8000-000000000001','77777777-0000-4000-8000-000000000007'); exception when others then ok:=true; end;
  assert ok, 'MM4 incomplete run blocked';
  perform pg_temp.seed_membership_run('77777777-0000-4000-8000-000000000007','c7c7c7c7-0000-4000-8000-000000000007','c7000002-0000-4000-8000-000000000002', '[{"g":"00gM1","u":"00uM2"}]'::jsonb, true, 1, 'last_page');
  ok:=false; begin perform public.runner_promote_okta_directory_group_memberships('c7000002-0000-4000-8000-000000000002','77777777-0000-4000-8000-000000000007'); exception when others then ok:=true; end;
  assert ok, 'MM4 rejected>0 blocked';
  ok:=false; begin perform public.runner_promote_okta_directory_group_memberships('a7a7a7a7-0000-4000-8000-0000000000a7','88888888-0000-4000-8000-000000000008'); exception when others then ok:=true; end;
  assert ok, 'MM4 wrong-tenant blocked';
end $$;

-- ════ MM5: idempotent replay + immutable edge (rename group / change email does not duplicate) + first_seen stable ════════════
do $$ declare r jsonb; v_first timestamptz; v_last1 timestamptz; begin
  select m.first_seen_at, m.last_seen_at into v_first, v_last1 from public.directory_group_memberships m
    join public.identity_accounts ia on ia.id=m.identity_account_id and ia.external_id='00uM1'
   where m.connection_id='c7c7c7c7-0000-4000-8000-000000000007';
  perform pg_sleep(0.01);
  -- change the group NAME + the identity EMAIL — the edge must still resolve to the same canonical rows (external_ids immutable)
  update public.directory_groups set name='Renamed' where external_id='00gM1' and connection_id='c7c7c7c7-0000-4000-8000-000000000007';
  update public.identity_accounts set email='changed@x.com' where external_id='00uM1' and connection_id='c7c7c7c7-0000-4000-8000-000000000007';
  perform pg_temp.seed_membership_run('77777777-0000-4000-8000-000000000007','c7c7c7c7-0000-4000-8000-000000000007','a8a8a8a8-0000-4000-8000-0000000000a8', '[{"g":"00gM1","u":"00uM1"}]'::jsonb, true, 0, 'last_page');
  r := public.runner_promote_okta_directory_group_memberships('a8a8a8a8-0000-4000-8000-0000000000a8','77777777-0000-4000-8000-000000000007');
  assert (r->>'membershipsUpdated')::int = 1 and (r->>'membershipsCreated')::int = 0, 'MM5 replay updates, no new edge';
  assert (select count(*) from public.directory_group_memberships m join public.identity_accounts ia on ia.id=m.identity_account_id and ia.external_id='00uM1' where m.connection_id='c7c7c7c7-0000-4000-8000-000000000007')=1, 'MM5 no duplicate edge (immutable key)';
  assert (select m.first_seen_at=v_first from public.directory_group_memberships m join public.identity_accounts ia on ia.id=m.identity_account_id and ia.external_id='00uM1' where m.connection_id='c7c7c7c7-0000-4000-8000-000000000007')=true, 'MM5 first_seen preserved';
  assert (select m.last_seen_at>v_last1 from public.directory_group_memberships m join public.identity_accounts ia on ia.id=m.identity_account_id and ia.external_id='00uM1' where m.connection_id='c7c7c7c7-0000-4000-8000-000000000007')=true, 'MM5 last_seen advanced';
end $$;

-- ════ MM6: cross-tenant + cross-connection isolation of the (group,user) pair (separate canonical endpoints -> separate edges) ══
do $$ begin
  perform pg_temp.seed_membership_run('88888888-0000-4000-8000-000000000008','c8c8c8c8-0000-4000-8000-000000000008','d8d8d8d8-0000-4000-8000-0000000000d8', '[{"g":"00gM1","u":"00uM1"}]'::jsonb, true, 0, 'last_page');
  perform public.runner_promote_okta_directory_group_memberships('d8d8d8d8-0000-4000-8000-0000000000d8','88888888-0000-4000-8000-000000000008');
  perform pg_temp.seed_membership_run('77777777-0000-4000-8000-000000000007','c7b7c7b7-0000-4000-8000-00000000007b','d7d7d7d7-0000-4000-8000-0000000000d7', '[{"g":"00gM1","u":"00uM1"}]'::jsonb, true, 0, 'last_page');
  perform public.runner_promote_okta_directory_group_memberships('d7d7d7d7-0000-4000-8000-0000000000d7','77777777-0000-4000-8000-000000000007');
  -- edges exist per connection; each references its OWN connection's canonical group+identity rows (composite FK enforced).
  assert (select count(*) from public.directory_group_memberships where connection_id='c8c8c8c8-0000-4000-8000-000000000008')=1, 'MM6 M8B has its own edge';
  assert (select count(*) from public.directory_group_memberships where connection_id='c7b7c7b7-0000-4000-8000-00000000007b')=1, 'MM6 CM7B has its own edge';
  assert (select count(distinct connection_id) from public.directory_group_memberships)=3, 'MM6 edges are per-connection (3 connections)';
end $$;

-- ════ MM7: stale — first run zero; complete second run stales an absent edge; scoped; no hard delete ═════════════════════════
do $$ declare r jsonb; begin
  -- first-run rule on CM8 (only run d8): re-stale-eval -> zero
  r := public.runner_mark_absent_okta_directory_group_memberships_stale('d8d8d8d8-0000-4000-8000-0000000000d8','88888888-0000-4000-8000-000000000008');
  assert (r->>'staleMarked')::int = 0 and (r->>'firstRun')::boolean = true, 'MM7 first run stales zero';
  -- CM7 currently has edge (00gM1,00uM1). A SECOND complete run with a DIFFERENT pair (00gM1,00uM2) -> (00gM1,00uM1) becomes absent -> stale.
  perform pg_temp.seed_membership_run('77777777-0000-4000-8000-000000000007','c7c7c7c7-0000-4000-8000-000000000007','e7000001-0000-4000-8000-0000000000e1', '[{"g":"00gM1","u":"00uM2"}]'::jsonb, true, 0, 'last_page');
  perform public.runner_promote_okta_directory_group_memberships('e7000001-0000-4000-8000-0000000000e1','77777777-0000-4000-8000-000000000007');
  update public.connector_discovery_policy set stale_percent_threshold=90 where provider='okta'; -- 1/2 absent = 50% > 30% default
  r := public.runner_mark_absent_okta_directory_group_memberships_stale('e7000001-0000-4000-8000-0000000000e1','77777777-0000-4000-8000-000000000007');
  update public.connector_discovery_policy set stale_percent_threshold=30 where provider='okta';
  assert (r->>'staleMarked')::int = 1, 'MM7 absent prior edge (00gM1,00uM1 on CM7) marked stale';
  assert (select m.sync_status='stale' and m.stale_since is not null from public.directory_group_memberships m join public.identity_accounts ia on ia.id=m.identity_account_id and ia.external_id='00uM1' where m.connection_id='c7c7c7c7-0000-4000-8000-000000000007')=true, 'MM7 absent edge stale (not deleted)';
  assert (select count(*) from public.directory_group_memberships where connection_id='c7c7c7c7-0000-4000-8000-000000000007')=2, 'MM7 no hard delete (2 edges: one stale, one current)';
  -- PARTIAL run stales zero
  perform pg_temp.seed_membership_run('77777777-0000-4000-8000-000000000007','c7c7c7c7-0000-4000-8000-000000000007','e7000002-0000-4000-8000-0000000000e2', '[{"g":"00gM1","u":"00uM2"}]'::jsonb, false, 0, 'error:transient/okta_network_error');
  r := public.runner_mark_absent_okta_directory_group_memberships_stale('e7000002-0000-4000-8000-0000000000e2','77777777-0000-4000-8000-000000000007');
  assert (r->>'staleMarked')::int = 0 and (r->>'eligible')::boolean = false, 'MM7 partial run stales zero';
end $$;

-- ════ MM8: write-boundary guards — fact key allowlist + circuit breaker + composite-FK provider agreement ═══════════════════
do $$ declare r jsonb; ok boolean; begin
  insert into public.connector_runs (id, tenant_id, connector_id, status, started_at) values ('f7000000-0000-4000-8000-00000000000f','77777777-0000-4000-8000-000000000007','c7c7c7c7-0000-4000-8000-000000000007','running',now());
  -- directory_group_membership fact key ALLOWLIST rejects a non-approved key (e.g. a member email/name)
  ok:=false; begin perform public.runner_insert_discovery_fact('77777777-0000-4000-8000-000000000007','f7000000-0000-4000-8000-00000000000f','directory_group_membership','identity_provider_discovery','okta','okta:c7:gm:x:y','x:y',now(),1.0,
    jsonb_build_object('fact_type','directory_group_membership','connection_id','c7c7c7c7-0000-4000-8000-000000000007','group_external_id','00gM1','user_external_id','00uM1','email','leak@x.com'), null); exception when others then ok:=true; end;
  assert ok, 'MM8 directory_group_membership non-approved key rejected';
  -- circuit breaker: abs threshold 0 -> any absence triggers review, stales zero
  update public.connector_discovery_policy set stale_absolute_threshold=0, stale_percent_threshold=0 where provider='okta';
  perform pg_temp.seed_membership_run('77777777-0000-4000-8000-000000000007','c7c7c7c7-0000-4000-8000-000000000007','f7000003-0000-4000-8000-000000000003', '[]'::jsonb, true, 0, 'last_page');
  perform public.runner_promote_okta_directory_group_memberships('f7000003-0000-4000-8000-000000000003','77777777-0000-4000-8000-000000000007');
  r := public.runner_mark_absent_okta_directory_group_memberships_stale('f7000003-0000-4000-8000-000000000003','77777777-0000-4000-8000-000000000007');
  assert (r->>'circuitBreakerTriggered')::boolean = true and (r->>'staleMarked')::int = 0, 'MM8 circuit breaker fires, stales zero';
  update public.connector_discovery_policy set stale_absolute_threshold=100, stale_percent_threshold=30 where provider='okta';
end $$;

reset role;
do $$ begin raise notice 'ALL OKTA GROUP MEMBERSHIP PERSISTENCE ASSERTIONS PASSED'; end $$;
