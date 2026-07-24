-- okta_application_assignment_read_test.sql — verifies migration 0058 (the two SELECT-only read RPCs for the Phase-11 bounded read-only
-- application-assignment aggregate). Runs against the SHARED harness DB, so fixtures use UUIDs distinct from the other tests (b1-prefix).
-- NEVER touches hosted Supabase. staging only.

reset role;

-- ── Fixtures: tenant T (okta conns C1, C2); tenant T2 (okta conn C3). directory_applications + directory_groups seeded per connection. ──
insert into public.tenants (id, name, slug) values
  ('b1000000-0000-4000-8000-000000000001', 'Okta AA A', 'okta-aa-a'),
  ('b1000000-0000-4000-8000-000000000002', 'Okta AA B', 'okta-aa-b');
insert into public.connectors (id, tenant_id, provider, status, connection_state) values
  ('b1000000-0000-4000-8000-0000000000c1', 'b1000000-0000-4000-8000-000000000001', 'okta', 'pending', 'discovered'),
  ('b1000000-0000-4000-8000-0000000000c2', 'b1000000-0000-4000-8000-000000000001', 'okta', 'pending', 'discovered'),
  ('b1000000-0000-4000-8000-0000000000c3', 'b1000000-0000-4000-8000-000000000002', 'okta', 'pending', 'discovered');
insert into public.directory_applications (tenant_id, connection_id, provider, external_id, label, sync_status) values
  ('b1000000-0000-4000-8000-000000000001', 'b1000000-0000-4000-8000-0000000000c1', 'okta', '0oaB1', 'App1', 'current'),
  ('b1000000-0000-4000-8000-000000000001', 'b1000000-0000-4000-8000-0000000000c1', 'okta', '0oaB2', 'App2', 'current'),
  ('b1000000-0000-4000-8000-000000000001', 'b1000000-0000-4000-8000-0000000000c1', 'okta', '0oaB3', 'App3', 'stale'),
  ('b1000000-0000-4000-8000-000000000001', 'b1000000-0000-4000-8000-0000000000c2', 'okta', '0oaBX', 'AppX', 'current');
insert into public.directory_groups (tenant_id, connection_id, provider, external_id, name, sync_status) values
  ('b1000000-0000-4000-8000-000000000001', 'b1000000-0000-4000-8000-0000000000c1', 'okta', '00gB1', 'G1', 'current'),
  ('b1000000-0000-4000-8000-000000000001', 'b1000000-0000-4000-8000-0000000000c1', 'okta', '00gB2', 'G2', 'stale'),
  ('b1000000-0000-4000-8000-000000000001', 'b1000000-0000-4000-8000-0000000000c2', 'okta', '00gB1', 'G1', 'current');

-- ════ AR1: grants + search_path pinned + NO direct table access (definer-only) ════════════════════════════════════════
do $$ begin
  assert     has_function_privilege('connector_runner', 'public.runner_list_okta_directory_application_refs(uuid,uuid)', 'EXECUTE'), 'AR1 runner EXECUTE list';
  assert     has_function_privilege('connector_runner', 'public.runner_resolve_okta_directory_group_refs(uuid,uuid,text[])', 'EXECUTE'), 'AR1 runner EXECUTE resolve';
  assert not has_function_privilege('public', 'public.runner_list_okta_directory_application_refs(uuid,uuid)', 'EXECUTE'), 'AR1 PUBLIC denied list';
  assert not has_function_privilege('anon', 'public.runner_resolve_okta_directory_group_refs(uuid,uuid,text[])', 'EXECUTE'), 'AR1 anon denied resolve';
  assert not has_table_privilege('connector_runner', 'public.directory_applications', 'SELECT'), 'AR1 runner NO direct app SELECT';
  assert not has_table_privilege('connector_runner', 'public.directory_groups', 'SELECT'), 'AR1 runner NO direct group SELECT';
  assert (select array_to_string(proconfig,',') from pg_proc where proname='runner_list_okta_directory_application_refs') like 'search_path=%', 'AR1 list search_path pinned';
  assert (select array_to_string(proconfig,',') from pg_proc where proname='runner_resolve_okta_directory_group_refs') like 'search_path=%', 'AR1 resolve search_path pinned';
end $$;

-- ════ AR2: list application refs — CURRENT only (stale excluded), per-connection, empty when none, gated ════════════════
do $$ declare r jsonb; ok boolean; begin
  r := public.runner_list_okta_directory_application_refs('b1000000-0000-4000-8000-000000000001','b1000000-0000-4000-8000-0000000000c1');
  assert jsonb_array_length(r) = 2, 'AR2 C1 returns 2 current apps (stale 0oaB3 excluded)';
  assert r @> '["0oaB1","0oaB2"]'::jsonb and not (r @> '["0oaB3"]'::jsonb), 'AR2 current external_ids only, stale absent';
  assert jsonb_array_length(public.runner_list_okta_directory_application_refs('b1000000-0000-4000-8000-000000000001','b1000000-0000-4000-8000-0000000000c2')) = 1, 'AR2 C2 returns its own 1 app';
  -- an okta connection with no apps -> empty array
  assert public.runner_list_okta_directory_application_refs('b1000000-0000-4000-8000-000000000002','b1000000-0000-4000-8000-0000000000c3') = '[]'::jsonb, 'AR2 no apps -> empty array';
  -- wrong tenant for the connection -> raises (no cross-tenant read)
  ok:=false; begin perform public.runner_list_okta_directory_application_refs('b1000000-0000-4000-8000-000000000002','b1000000-0000-4000-8000-0000000000c1'); exception when others then ok:=true; end;
  assert ok, 'AR2 wrong-tenant connection rejected';
end $$;

-- ════ AR3: resolve group refs — counts only, external_id equality, stale=known, cross-tenant/connection isolation, guards ═
do $$ declare r jsonb; ok boolean; begin
  -- 00gB1 (current) + 00gB2 (stale, still KNOWN) matched; 00gBMISS unmatched
  r := public.runner_resolve_okta_directory_group_refs('b1000000-0000-4000-8000-000000000001','b1000000-0000-4000-8000-0000000000c1', array['00gB1','00gB2','00gBMISS']);
  assert (r->>'requested')::int = 3 and (r->>'matched')::int = 2 and (r->>'unmatched')::int = 1, 'AR3 counts: 3 requested, 2 matched (incl stale), 1 unmatched';
  -- the REAL seeded group NAME ('G1', the name of external_id 00gB1) never matches — equality is on external_id only, never name
  assert (public.runner_resolve_okta_directory_group_refs('b1000000-0000-4000-8000-000000000001','b1000000-0000-4000-8000-0000000000c1', array['G1']) ->> 'matched')::int = 0, 'AR3 group name value never matches';
  -- cross-connection isolation: C1 group 00gB2 is NOT visible from C2 (C2 only has 00gB1)
  r := public.runner_resolve_okta_directory_group_refs('b1000000-0000-4000-8000-000000000001','b1000000-0000-4000-8000-0000000000c2', array['00gB1','00gB2']);
  assert (r->>'matched')::int = 1, 'AR3 cross-connection isolation (C2 sees only its own 00g1)';
  -- cross-tenant isolation: T2/C3 has no groups
  assert (public.runner_resolve_okta_directory_group_refs('b1000000-0000-4000-8000-000000000002','b1000000-0000-4000-8000-0000000000c3', array['00gB1']) ->> 'matched')::int = 0, 'AR3 cross-tenant isolation';
  -- null input rejected
  ok:=false; begin perform public.runner_resolve_okta_directory_group_refs('b1000000-0000-4000-8000-000000000001','b1000000-0000-4000-8000-0000000000c1', null); exception when others then ok:=true; end;
  assert ok, 'AR3 null external_ids rejected';
  -- cardinality guard (>1000) rejected
  ok:=false; begin perform public.runner_resolve_okta_directory_group_refs('b1000000-0000-4000-8000-000000000001','b1000000-0000-4000-8000-0000000000c1', (select array_agg('g'||g) from generate_series(1,1001) g)); exception when others then ok:=true; end;
  assert ok, 'AR3 cardinality >1000 rejected';
  -- wrong-provider/tenant connection rejected
  ok:=false; begin perform public.runner_resolve_okta_directory_group_refs('b1000000-0000-4000-8000-000000000002','b1000000-0000-4000-8000-0000000000c1', array['00gB1']); exception when others then ok:=true; end;
  assert ok, 'AR3 wrong-tenant connection rejected';
end $$;

reset role;
do $$ begin raise notice 'ALL OKTA APPLICATION ASSIGNMENT READ ASSERTIONS PASSED'; end $$;
