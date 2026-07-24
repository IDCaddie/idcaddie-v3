-- okta_group_membership_read_test.sql — verifies migration 0055 (the two READ-ONLY SECURITY DEFINER RPCs for the Phase 7 bounded
-- group-membership aggregate): runner_list_okta_directory_group_refs + runner_resolve_okta_identity_refs. Grants, ownership gates,
-- external_id-ONLY matching, cross-tenant/connection/provider isolation, current-only group filter, and input/output bounds. Runs
-- against the SHARED harness DB, so fixtures use UUIDs distinct from the other tests. NEVER touches hosted Supabase. staging only.

reset role;

-- ── Fixtures: tenant T7A (okta conns C5, C5B + a slack conn C5S); tenant T7B (okta conn C6). ─────────────────────────────────
insert into public.tenants (id, name, slug) values
  ('55555555-0000-4000-8000-000000000005', 'Okta T7A', 'okta-t7a'),
  ('66666666-0000-4000-8000-000000000006', 'Okta T7B', 'okta-t7b');
insert into public.connectors (id, tenant_id, provider, status, connection_state) values
  ('c5c5c5c5-0000-4000-8000-000000000005', '55555555-0000-4000-8000-000000000005', 'okta',  'pending', 'discovered'),
  ('c5b5c5b5-0000-4000-8000-00000000005b', '55555555-0000-4000-8000-000000000005', 'okta',  'pending', 'discovered'),
  ('c5555555-0000-4000-8000-00000000055e', '55555555-0000-4000-8000-000000000005', 'slack', 'pending', 'discovered'),
  ('c6c6c6c6-0000-4000-8000-000000000006', '66666666-0000-4000-8000-000000000006', 'okta',  'pending', 'discovered');

-- directory_groups: C5 has 2 CURRENT + 1 STALE; C5B has 1 CURRENT with the SAME external_id (cross-connection).
insert into public.directory_groups (tenant_id, connection_id, provider, external_id, sync_status) values
  ('55555555-0000-4000-8000-000000000005', 'c5c5c5c5-0000-4000-8000-000000000005', 'okta', '00gX', 'current'),
  ('55555555-0000-4000-8000-000000000005', 'c5c5c5c5-0000-4000-8000-000000000005', 'okta', '00gY', 'current'),
  ('55555555-0000-4000-8000-000000000005', 'c5c5c5c5-0000-4000-8000-000000000005', 'okta', '00gZ', 'stale'),
  ('55555555-0000-4000-8000-000000000005', 'c5b5c5b5-0000-4000-8000-00000000005b', 'okta', '00gX', 'current');

-- identity_accounts: C5 has 00uA (current) + 00uB (stale) + 00uEMAIL (has email); C6 has 00uA (same external_id, other tenant).
insert into public.identity_accounts (tenant_id, connection_id, provider, external_id, sync_status, email) values
  ('55555555-0000-4000-8000-000000000005', 'c5c5c5c5-0000-4000-8000-000000000005', 'okta', '00uA', 'current', null),
  ('55555555-0000-4000-8000-000000000005', 'c5c5c5c5-0000-4000-8000-000000000005', 'okta', '00uB', 'stale',   null),
  ('55555555-0000-4000-8000-000000000005', 'c5c5c5c5-0000-4000-8000-000000000005', 'okta', '00uEMAIL', 'current', 'match@x.com'),
  ('66666666-0000-4000-8000-000000000006', 'c6c6c6c6-0000-4000-8000-000000000006', 'okta', '00uA', 'current', null);

-- ════ MG1: grant shape (EXECUTE to connector_runner; PUBLIC/anon denied; search_path pinned; SELECT-only) ══════════════════
do $$ begin
  assert     has_function_privilege('connector_runner', 'public.runner_list_okta_directory_group_refs(uuid,uuid)', 'EXECUTE'), 'MG1 runner EXECUTE list_refs';
  assert     has_function_privilege('connector_runner', 'public.runner_resolve_okta_identity_refs(uuid,uuid,text[])', 'EXECUTE'), 'MG1 runner EXECUTE resolve_refs';
  assert not has_function_privilege('public', 'public.runner_list_okta_directory_group_refs(uuid,uuid)', 'EXECUTE'), 'MG1 PUBLIC denied list_refs';
  assert not has_function_privilege('public', 'public.runner_resolve_okta_identity_refs(uuid,uuid,text[])', 'EXECUTE'), 'MG1 PUBLIC denied resolve_refs';
  assert not has_function_privilege('anon', 'public.runner_list_okta_directory_group_refs(uuid,uuid)', 'EXECUTE'), 'MG1 anon denied list_refs';
  assert not has_function_privilege('anon', 'public.runner_resolve_okta_identity_refs(uuid,uuid,text[])', 'EXECUTE'), 'MG1 anon denied resolve_refs';
  assert (select array_to_string(proconfig,',') from pg_proc where proname='runner_list_okta_directory_group_refs') like 'search_path=%', 'MG1 list search_path pinned';
  assert (select array_to_string(proconfig,',') from pg_proc where proname='runner_resolve_okta_identity_refs') like 'search_path=%', 'MG1 resolve search_path pinned';
  -- connector_runner still has NO direct SELECT on the data tables (the RPCs are the only read path)
  assert not has_table_privilege('connector_runner', 'public.directory_groups', 'SELECT'), 'MG1 runner NO direct directory_groups SELECT';
  assert not has_table_privilege('connector_runner', 'public.identity_accounts', 'SELECT'), 'MG1 runner NO direct identity_accounts SELECT';
end $$;

-- ════ MG2: list_group_refs — current external_ids only, scoped, ordered; wrong tenant/connection/provider rejected ══════════
do $$ declare r jsonb; ok boolean; begin
  r := public.runner_list_okta_directory_group_refs('55555555-0000-4000-8000-000000000005', 'c5c5c5c5-0000-4000-8000-000000000005');
  assert r = '["00gX","00gY"]'::jsonb, 'MG2 C5 returns the 2 CURRENT external_ids (stale 00gZ excluded), ordered';
  r := public.runner_list_okta_directory_group_refs('55555555-0000-4000-8000-000000000005', 'c5b5c5b5-0000-4000-8000-00000000005b');
  assert r = '["00gX"]'::jsonb, 'MG2 C5B scoped to its own connection';
  r := public.runner_list_okta_directory_group_refs('66666666-0000-4000-8000-000000000006', 'c6c6c6c6-0000-4000-8000-000000000006');
  assert r = '[]'::jsonb, 'MG2 C6 (no groups) returns empty array';
  -- wrong tenant for C5 (C5 belongs to T7A) → rejected
  ok:=false; begin perform public.runner_list_okta_directory_group_refs('66666666-0000-4000-8000-000000000006', 'c5c5c5c5-0000-4000-8000-000000000005'); exception when others then ok:=true; end;
  assert ok, 'MG2 wrong-tenant connection rejected';
  -- non-okta (slack) connection → rejected
  ok:=false; begin perform public.runner_list_okta_directory_group_refs('55555555-0000-4000-8000-000000000005', 'c5555555-0000-4000-8000-00000000055e'); exception when others then ok:=true; end;
  assert ok, 'MG2 non-okta connection rejected';
end $$;

-- ════ MG3: resolve_identity_refs — counts only; external_id EQUALITY only; cross-tenant/connection isolation; bounds ═════════
do $$ declare r jsonb; ok boolean; begin
  -- 00uA (current) + 00uB (stale) both matched (any sync_status); 00uMISSING unmatched
  r := public.runner_resolve_okta_identity_refs('55555555-0000-4000-8000-000000000005', 'c5c5c5c5-0000-4000-8000-000000000005', array['00uA','00uB','00uMISSING']);
  assert r = '{"requested":3,"matched":2,"unmatched":1}'::jsonb, 'MG3 matched=2 (current+stale), unmatched=1';
  -- cross-tenant: C6 (T7B) also has 00uA, but resolving under C5 (T7A) matches only C5's 00uA
  r := public.runner_resolve_okta_identity_refs('55555555-0000-4000-8000-000000000005', 'c5c5c5c5-0000-4000-8000-000000000005', array['00uA']);
  assert (r->>'matched')::int = 1, 'MG3 00uA matches within C5';
  -- cross-connection: 00uB is C5''s; resolving under C6 (T7B) → unmatched
  r := public.runner_resolve_okta_identity_refs('66666666-0000-4000-8000-000000000006', 'c6c6c6c6-0000-4000-8000-000000000006', array['00uB']);
  assert r = '{"requested":1,"matched":0,"unmatched":1}'::jsonb, 'MG3 cross-connection member unmatched';
  -- external_id EQUALITY only: a value that matches an EMAIL (not an external_id) is unmatched
  r := public.runner_resolve_okta_identity_refs('55555555-0000-4000-8000-000000000005', 'c5c5c5c5-0000-4000-8000-000000000005', array['match@x.com']);
  assert (r->>'matched')::int = 0, 'MG3 email value never matches (external_id equality only)';
  -- empty array → zeros
  r := public.runner_resolve_okta_identity_refs('55555555-0000-4000-8000-000000000005', 'c5c5c5c5-0000-4000-8000-000000000005', array[]::text[]);
  assert r = '{"requested":0,"matched":0,"unmatched":0}'::jsonb, 'MG3 empty array → zeros';
  -- null input → rejected
  ok:=false; begin perform public.runner_resolve_okta_identity_refs('55555555-0000-4000-8000-000000000005', 'c5c5c5c5-0000-4000-8000-000000000005', null); exception when others then ok:=true; end;
  assert ok, 'MG3 null external_ids rejected';
  -- cardinality guard: > 1000 ids → rejected
  ok:=false; begin perform public.runner_resolve_okta_identity_refs('55555555-0000-4000-8000-000000000005', 'c5c5c5c5-0000-4000-8000-000000000005', (select array_agg('x'||g) from generate_series(1,1001) g)); exception when others then ok:=true; end;
  assert ok, 'MG3 cardinality guard rejects > 1000 ids';
  -- non-okta connection → rejected
  ok:=false; begin perform public.runner_resolve_okta_identity_refs('55555555-0000-4000-8000-000000000005', 'c5555555-0000-4000-8000-00000000055e', array['00uA']); exception when others then ok:=true; end;
  assert ok, 'MG3 non-okta connection rejected';
end $$;

reset role;
do $$ begin raise notice 'ALL OKTA GROUP MEMBERSHIP READ ASSERTIONS PASSED'; end $$;
