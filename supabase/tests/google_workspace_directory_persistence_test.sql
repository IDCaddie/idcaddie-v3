-- google_workspace_directory_persistence_test.sql — verifies migration 0083: the 'license' fact type at the write
-- boundary, the provider allowlist that keeps the parameterized path away from Okta, and the promote/stale semantics for
-- identities, groups and group memberships. All migrations applied, connector_runner present (0021).
-- Run with psql -v ON_ERROR_STOP=1. NEVER touches hosted Supabase. certificationOnly; staging only.

reset role;

-- ── Fixtures: two tenants. T1 has TWO google connections (C1, C1B) for cross-connection isolation; T2 has one (C2).
--    T1 also has an OKTA connection (CO) so the "must not touch Okta" assertions have a real target. ─────────────────
insert into public.tenants (id, name, slug) values
  ('a1111111-0000-4000-8000-000000000001', 'GWS T1', 'gws-t1'),
  ('a2222222-0000-4000-8000-000000000002', 'GWS T2', 'gws-t2');
insert into public.connectors (id, tenant_id, provider, status, connection_state) values
  ('9c000001-0000-4000-8000-000000000001', 'a1111111-0000-4000-8000-000000000001', 'google_workspace', 'pending', 'verified'),
  ('9c00001b-0000-4000-8000-00000000001b', 'a1111111-0000-4000-8000-000000000001', 'google_workspace', 'pending', 'verified'),
  ('9c000002-0000-4000-8000-000000000002', 'a2222222-0000-4000-8000-000000000002', 'google_workspace', 'pending', 'verified'),
  -- A DEDICATED connection for the failure-path cases. They must not share a connection with the happy path, because a
  -- failed run still lands a connector_run_discovery row and the latest-run guard reads those (see G5b).
  ('9c00000f-0000-4000-8000-00000000000f', 'a1111111-0000-4000-8000-000000000001', 'google_workspace', 'pending', 'verified'),
  ('90c00001-0000-4000-8000-0000000000c0', 'a1111111-0000-4000-8000-000000000001', 'okta', 'pending', 'verified');

-- helper: open a run and record metrics with the given completeness shape.
create or replace function pg_temp.open_run(p_tenant uuid, p_conn uuid, p_run uuid, p_complete boolean, p_rejected integer, p_term text)
  returns void language plpgsql as $$
begin
  insert into public.connector_runs (id, tenant_id, connector_id, status, started_at)
    values (p_run, p_tenant, p_conn, 'running', clock_timestamp());
  perform public.runner_record_directory_discovery_metrics(p_run, p_tenant, 'google_workspace', 1, 1, 1, 1, p_rejected, p_term, p_complete, '1','1','1', null);
end $$;

-- helper: one identity_account fact. signal_id is CONNECTION-QUALIFIED so sibling connections never share a fact row,
-- and fact_json carries connection_id so promotion can verify the fact belongs to the run's connection.
create or replace function pg_temp.seed_user(p_tenant uuid, p_conn uuid, p_run uuid, p_ext text, p_email text)
  returns void language plpgsql as $$
begin
  perform public.runner_insert_discovery_fact(
    p_tenant, p_run, 'identity_account', 'identity_provider_discovery', 'google_workspace',
    'google_workspace:'||p_conn||':user:'||p_ext, p_ext, now(), 1.0,
    jsonb_build_object('fact_type','identity_account','external_id',p_ext,'connection_id',p_conn::text,
                       'email',p_email,'normalized_email',lower(p_email),'first_name','F','last_name','L',
                       'display_name','F L','status','active','is_active',true),
    jsonb_build_object('provider','google_workspace','source_endpoint','users','schema_version','1','sanitizer_version','1','normalizer_version','1'));
end $$;

create or replace function pg_temp.seed_group(p_tenant uuid, p_conn uuid, p_run uuid, p_ext text, p_name text)
  returns void language plpgsql as $$
begin
  perform public.runner_insert_discovery_fact(
    p_tenant, p_run, 'directory_group', 'identity_provider_discovery', 'google_workspace',
    'google_workspace:'||p_conn||':group:'||p_ext, p_ext, now(), 1.0,
    jsonb_build_object('fact_type','directory_group','external_id',p_ext,'connection_id',p_conn::text,
                       'name',p_name,'normalized_name',lower(p_name),'group_type_category','other'),
    jsonb_build_object('provider','google_workspace','source_endpoint','groups','schema_version','1','sanitizer_version','1','normalizer_version','1'));
end $$;

create or replace function pg_temp.seed_membership(p_tenant uuid, p_conn uuid, p_run uuid, p_g text, p_u text)
  returns void language plpgsql as $$
begin
  perform public.runner_insert_discovery_fact(
    p_tenant, p_run, 'directory_group_membership', 'identity_provider_discovery', 'google_workspace',
    'google_workspace:'||p_conn||':membership:'||p_g||':'||p_u, p_g||':'||p_u, now(), 1.0,
    jsonb_build_object('fact_type','directory_group_membership','connection_id',p_conn::text,
                       'group_external_id',p_g,'user_external_id',p_u),
    jsonb_build_object('provider','google_workspace','source_endpoint','members','schema_version','1','sanitizer_version','1','normalizer_version','1'));
end $$;

-- ════ G1: grant shape (EXECUTE to connector_runner; PUBLIC/anon denied; NO direct table access) ═══════════════════════
do $$ begin
  assert     has_function_privilege('connector_runner', 'public.runner_promote_directory_users(uuid,uuid,text)', 'EXECUTE'), 'G1 runner EXECUTE promote users';
  assert     has_function_privilege('connector_runner', 'public.runner_mark_absent_directory_users_stale(uuid,uuid,text)', 'EXECUTE'), 'G1 runner EXECUTE stale users';
  assert     has_function_privilege('connector_runner', 'public.runner_promote_directory_groups(uuid,uuid,text)', 'EXECUTE'), 'G1 runner EXECUTE promote groups';
  assert     has_function_privilege('connector_runner', 'public.runner_promote_directory_group_memberships(uuid,uuid,text)', 'EXECUTE'), 'G1 runner EXECUTE promote memberships';
  assert not has_function_privilege('public', 'public.runner_promote_directory_users(uuid,uuid,text)', 'EXECUTE'), 'G1 PUBLIC denied promote';
  assert not has_function_privilege('anon',   'public.runner_promote_directory_users(uuid,uuid,text)', 'EXECUTE'), 'G1 anon denied promote';
  assert not has_function_privilege('anon',   'public.runner_mark_absent_directory_users_stale(uuid,uuid,text)', 'EXECUTE'), 'G1 anon denied stale';
  -- The eligibility helpers are internal: the runner must go through a resource function, never assemble its own verdict.
  assert not has_function_privilege('connector_runner', 'public.runner_assert_promotable(uuid,uuid,uuid)', 'EXECUTE'), 'G1 runner cannot call assert_promotable directly';
  assert not has_function_privilege('connector_runner', 'public.runner_stale_eligible(uuid,uuid,uuid)', 'EXECUTE'), 'G1 runner cannot call stale_eligible directly';
  -- NO DIRECT INSERT PATH — the SECURITY DEFINER functions are the only write route.
  assert not has_table_privilege('connector_runner', 'public.identity_accounts', 'INSERT'), 'G1 no direct identity_accounts INSERT';
  assert not has_table_privilege('connector_runner', 'public.identity_accounts', 'UPDATE'), 'G1 no direct identity_accounts UPDATE';
  assert not has_table_privilege('connector_runner', 'public.directory_groups', 'INSERT'), 'G1 no direct directory_groups INSERT';
  assert not has_table_privilege('connector_runner', 'public.directory_group_memberships', 'INSERT'), 'G1 no direct memberships INSERT';
  assert not has_table_privilege('connector_runner', 'public.discovery_facts', 'INSERT'), 'G1 no direct discovery_facts INSERT';
  assert not has_table_privilege('connector_runner', 'public.connector_run_discovery', 'INSERT'), 'G1 no direct metrics INSERT';
  -- search_path pinned on every new definer fn
  assert (select array_to_string(proconfig,',') from pg_proc where proname='runner_promote_directory_users') like 'search_path=%', 'G1 promote users search_path pinned';
  assert (select array_to_string(proconfig,',') from pg_proc where proname='runner_mark_absent_directory_users_stale') like 'search_path=%', 'G1 stale users search_path pinned';
  assert (select array_to_string(proconfig,',') from pg_proc where proname='runner_resolve_directory_run') like 'search_path=%', 'G1 resolve search_path pinned';
end $$;

-- ════ G2: the provider allowlist — this path CANNOT touch Okta ═══════════════════════════════════════════════════════
-- NOTE ON HOW THESE ARE ASSERTED. An earlier version of this block only checked that SOMETHING was raised. That is
-- too weak to be a proof: every one of these calls raises for at least two independent reasons (the allowlist, and the
-- run's connector not matching the claimed provider), so widening the allowlist to include 'okta' left the block GREEN.
-- A negative control caught it. The assertions therefore match the allowlist's OWN message, which no other guard emits.
do $$ declare raised boolean; msg text; begin
  -- An Okta run is refused by the allowlist BEFORE any ownership logic, so 0083 can never alter an Okta row.
  perform pg_temp.open_run('a1111111-0000-4000-8000-000000000001','9c000001-0000-4000-8000-000000000001','40000001-0000-4000-8000-000000000001', true, 0, 'last_page');
  raised := false; msg := '';
  begin perform public.runner_promote_directory_users('40000001-0000-4000-8000-000000000001','a1111111-0000-4000-8000-000000000001','okta');
  exception when others then raised := true; msg := SQLERRM; end;
  assert raised, 'G2 provider okta must be refused by the parameterized path';
  assert msg like '%not served by the parameterized directory write path%',
    format('G2 okta must be refused BY THE ALLOWLIST, not incidentally; got: %s', msg);

  raised := false; msg := '';
  begin perform public.runner_promote_directory_users('40000001-0000-4000-8000-000000000001','a1111111-0000-4000-8000-000000000001','microsoft_entra');
  exception when others then raised := true; msg := SQLERRM; end;
  assert raised, 'G2 an unmigrated provider must be refused';
  assert msg like '%not served by the parameterized directory write path%', 'G2 entra must be refused by the allowlist';

  raised := false; msg := '';
  begin perform public.runner_promote_directory_users('40000001-0000-4000-8000-000000000001','a1111111-0000-4000-8000-000000000001', null);
  exception when others then raised := true; msg := SQLERRM; end;
  assert raised, 'G2 a null provider must be refused';
  assert msg like '%not served by the parameterized directory write path%', 'G2 null must be refused by the allowlist';

  -- The SAME assertion for every other entrypoint: one guarded function does not prove the set is guarded.
  raised := false; msg := '';
  begin perform public.runner_mark_absent_directory_users_stale('40000001-0000-4000-8000-000000000001','a1111111-0000-4000-8000-000000000001','okta');
  exception when others then raised := true; msg := SQLERRM; end;
  assert raised and msg like '%not served by the parameterized directory write path%', 'G2 stale-users is allowlist-guarded';

  raised := false; msg := '';
  begin perform public.runner_promote_directory_groups('40000001-0000-4000-8000-000000000001','a1111111-0000-4000-8000-000000000001','okta');
  exception when others then raised := true; msg := SQLERRM; end;
  assert raised and msg like '%not served by the parameterized directory write path%', 'G2 promote-groups is allowlist-guarded';

  raised := false; msg := '';
  begin perform public.runner_promote_directory_group_memberships('40000001-0000-4000-8000-000000000001','a1111111-0000-4000-8000-000000000001','okta');
  exception when others then raised := true; msg := SQLERRM; end;
  assert raised and msg like '%not served by the parameterized directory write path%', 'G2 promote-memberships is allowlist-guarded';

  raised := false; msg := '';
  begin perform public.runner_record_directory_discovery_metrics('40000001-0000-4000-8000-000000000001','a1111111-0000-4000-8000-000000000001','okta',1,1,1,1,0,'last_page',true,'1','1','1',null);
  exception when others then raised := true; msg := SQLERRM; end;
  assert raised and msg like '%not served by the parameterized directory write path%', 'G2 metrics is allowlist-guarded';

  -- Claiming google_workspace for a run whose connector is actually Okta is refused too (the provider must MATCH).
  insert into public.connector_runs (id, tenant_id, connector_id, status, started_at)
    values ('40000009-0000-4000-8000-000000000009','a1111111-0000-4000-8000-000000000001','90c00001-0000-4000-8000-0000000000c0','running', clock_timestamp());
  raised := false;
  begin perform public.runner_promote_directory_users('40000009-0000-4000-8000-000000000009','a1111111-0000-4000-8000-000000000001','google_workspace');
  exception when others then raised := true; end;
  assert raised, 'G2 an okta connector cannot be promoted as google_workspace';
end $$;

-- ════ G3: happy path — promote creates, replay updates (idempotent) ══════════════════════════════════════════════════
-- FOUR identities, not two. The mass-staleness circuit breaker fires above 30% absent, so a two-row fixture makes a
-- single departure 50% and the breaker suppresses the very staling G7 is trying to assert. Four rows put one absence at
-- 25%, below the threshold, which is what lets G7 test staling rather than accidentally testing the breaker.
do $$ declare r jsonb; begin
  perform pg_temp.seed_user('a1111111-0000-4000-8000-000000000001','9c000001-0000-4000-8000-000000000001','40000001-0000-4000-8000-000000000001','u1','ada@t1.example');
  perform pg_temp.seed_user('a1111111-0000-4000-8000-000000000001','9c000001-0000-4000-8000-000000000001','40000001-0000-4000-8000-000000000001','u2','bob@t1.example');
  perform pg_temp.seed_user('a1111111-0000-4000-8000-000000000001','9c000001-0000-4000-8000-000000000001','40000001-0000-4000-8000-000000000001','u3','cyd@t1.example');
  perform pg_temp.seed_user('a1111111-0000-4000-8000-000000000001','9c000001-0000-4000-8000-000000000001','40000001-0000-4000-8000-000000000001','u4','dee@t1.example');
  r := public.runner_promote_directory_users('40000001-0000-4000-8000-000000000001','a1111111-0000-4000-8000-000000000001','google_workspace');
  assert (r->>'identitiesCreated')::int = 4, 'G3 four identities created';
  assert (r->>'identitiesUpdated')::int = 0, 'G3 none updated on first promote';
  assert (select count(*) from public.identity_accounts where connection_id='9c000001-0000-4000-8000-000000000001') = 4, 'G3 rows landed';
  assert (select count(*) from public.identity_accounts where connection_id='9c000001-0000-4000-8000-000000000001' and sync_status='current') = 4, 'G3 all current';
  assert (select count(*) from public.identity_accounts where connection_id='9c000001-0000-4000-8000-000000000001' and stale_since is not null) = 0, 'G3 no current row carries stale_since (0070 invariant)';
  assert (select bool_and(provider='google_workspace') from public.identity_accounts where connection_id='9c000001-0000-4000-8000-000000000001'), 'G3 provider stamped google_workspace';
  assert (select bool_and(raw_payload is null) from public.identity_accounts where connection_id='9c000001-0000-4000-8000-000000000001'), 'G3 raw_payload NEVER set';

  -- IDEMPOTENT REPLAY: promoting the SAME run again must update, never duplicate.
  r := public.runner_promote_directory_users('40000001-0000-4000-8000-000000000001','a1111111-0000-4000-8000-000000000001','google_workspace');
  assert (r->>'identitiesCreated')::int = 0, 'G3 replay creates nothing';
  assert (r->>'identitiesUpdated')::int = 4, 'G3 replay updates all four';
  assert (select count(*) from public.identity_accounts where connection_id='9c000001-0000-4000-8000-000000000001') = 4, 'G3 replay did not duplicate';
end $$;

-- ════ G4: TENANT + CONNECTION ISOLATION ══════════════════════════════════════════════════════════════════════════════
do $$ declare r jsonb; raised boolean; begin
  -- T2 promotes its own run; T1's rows are untouched and the two never mix.
  perform pg_temp.open_run('a2222222-0000-4000-8000-000000000002','9c000002-0000-4000-8000-000000000002','40000002-0000-4000-8000-000000000002', true, 0, 'last_page');
  perform pg_temp.seed_user('a2222222-0000-4000-8000-000000000002','9c000002-0000-4000-8000-000000000002','40000002-0000-4000-8000-000000000002','u1','ada@t2.example');
  r := public.runner_promote_directory_users('40000002-0000-4000-8000-000000000002','a2222222-0000-4000-8000-000000000002','google_workspace');
  assert (r->>'identitiesCreated')::int = 1, 'G4 T2 created its own identity';
  -- external_id 'u1' now exists in BOTH tenants and must be two distinct rows.
  assert (select count(*) from public.identity_accounts where external_id='u1') = 2, 'G4 same external_id in two tenants stays two rows';
  assert (select count(*) from public.identity_accounts where tenant_id='a1111111-0000-4000-8000-000000000001') = 4, 'G4 T1 untouched';

  -- CROSS-TENANT REFUSAL: T2 cannot promote T1's run.
  raised := false;
  begin perform public.runner_promote_directory_users('40000001-0000-4000-8000-000000000001','a2222222-0000-4000-8000-000000000002','google_workspace');
  exception when others then raised := true; end;
  assert raised, 'G4 cross-tenant promote refused';

  raised := false;
  begin perform public.runner_mark_absent_directory_users_stale('40000001-0000-4000-8000-000000000001','a2222222-0000-4000-8000-000000000002','google_workspace');
  exception when others then raised := true; end;
  assert raised, 'G4 cross-tenant stale refused';

  -- CROSS-CONNECTION: a fact whose connection_id names a SIBLING connection is not promoted by this run.
  perform pg_temp.open_run('a1111111-0000-4000-8000-000000000001','9c00001b-0000-4000-8000-00000000001b','4000001b-0000-4000-8000-00000000001b', true, 0, 'last_page');
  perform public.runner_insert_discovery_fact(
    'a1111111-0000-4000-8000-000000000001','4000001b-0000-4000-8000-00000000001b','identity_account','identity_provider_discovery','google_workspace',
    'google_workspace:mismatch:user:uX','uX', now(), 1.0,
    jsonb_build_object('fact_type','identity_account','external_id','uX','connection_id','9c000001-0000-4000-8000-000000000001','email','x@t1.example'),
    jsonb_build_object('provider','google_workspace'));
  r := public.runner_promote_directory_users('4000001b-0000-4000-8000-00000000001b','a1111111-0000-4000-8000-000000000001','google_workspace');
  assert (r->>'identitiesCreated')::int = 0, 'G4 a fact naming another connection is not promoted';
  assert (select count(*) from public.identity_accounts where external_id='uX') = 0, 'G4 mismatched-connection fact created no row';
end $$;

-- ════ G5: PARTIAL FAILURE — promote refuses, stale marks NOTHING ═════════════════════════════════════════════════════
do $$ declare r jsonb; raised boolean; begin
  -- incomplete run, on the DEDICATED failure-path connection
  perform pg_temp.open_run('a1111111-0000-4000-8000-000000000001','9c00000f-0000-4000-8000-00000000000f','40000003-0000-4000-8000-000000000003', false, 0, 'error');
  perform pg_temp.seed_user('a1111111-0000-4000-8000-000000000001','9c00000f-0000-4000-8000-00000000000f','40000003-0000-4000-8000-000000000003','u1','ada@t1.example');
  raised := false;
  begin perform public.runner_promote_directory_users('40000003-0000-4000-8000-000000000003','a1111111-0000-4000-8000-000000000001','google_workspace');
  exception when others then raised := true; end;
  assert raised, 'G5 incomplete run cannot promote';

  -- STALE SUPPRESSION: an incomplete run must mark NOTHING stale, and must SAY it was ineligible rather than
  -- reporting "0 absent", which would read as a clean run that found everything.
  r := public.runner_mark_absent_directory_users_stale('40000003-0000-4000-8000-000000000003','a1111111-0000-4000-8000-000000000001','google_workspace');
  assert (r->>'eligible')::boolean = false, 'G5 incomplete run is ineligible to stale';
  assert (r->>'staleMarked')::int = 0, 'G5 incomplete run staled nothing';
  assert (select count(*) from public.identity_accounts where connection_id='9c00000f-0000-4000-8000-00000000000f' and sync_status='stale') = 0, 'G5 no row went stale';
  -- and nothing was promoted either — a failed run leaves no canonical row behind
  assert (select count(*) from public.identity_accounts where connection_id='9c00000f-0000-4000-8000-00000000000f') = 0, 'G5 incomplete run promoted nothing';

  -- a run with REJECTS is likewise ineligible, even though it terminated on last_page
  perform pg_temp.open_run('a1111111-0000-4000-8000-000000000001','9c00000f-0000-4000-8000-00000000000f','40000004-0000-4000-8000-000000000004', true, 3, 'last_page');
  raised := false;
  begin perform public.runner_promote_directory_users('40000004-0000-4000-8000-000000000004','a1111111-0000-4000-8000-000000000001','google_workspace');
  exception when others then raised := true; end;
  assert raised, 'G5 a run with rejected records cannot promote';
  r := public.runner_mark_absent_directory_users_stale('40000004-0000-4000-8000-000000000004','a1111111-0000-4000-8000-000000000001','google_workspace');
  assert (r->>'eligible')::boolean = false, 'G5 rejects make a run ineligible to stale';
end $$;

-- ════ G5b: an inherited quirk, pinned deliberately ═══════════════════════════════════════════════════════════════════
-- The latest-run guard tests completeness + termination_reason and does NOT test records_rejected. So a run that is
-- complete and terminated on last_page but REJECTED records still counts as "a later complete run", and therefore
-- SUPERSEDES an earlier good run — blocking that earlier run from staling, even though the rejecting run cannot promote
-- or stale either. The net effect is that nothing is staled at all until a clean run lands.
--
-- This is faithful to the Okta functions (0053/0070), whose guard is written identically; it is NOT introduced by 0083.
-- It fails SAFE — the failure mode is "stale nothing", never "stale everything" — so it is pinned here as behaviour
-- rather than quietly fixed, because changing it would change Okta's semantics too and that is a separate decision.
do $$ declare r jsonb; begin
  perform pg_temp.open_run('a1111111-0000-4000-8000-000000000001','9c00000f-0000-4000-8000-00000000000f','4000000b-0000-4000-8000-00000000000b', true, 0, 'last_page');
  perform pg_temp.seed_user('a1111111-0000-4000-8000-000000000001','9c00000f-0000-4000-8000-00000000000f','4000000b-0000-4000-8000-00000000000b','uq','q@t1.example');
  perform public.runner_promote_directory_users('4000000b-0000-4000-8000-00000000000b','a1111111-0000-4000-8000-000000000001','google_workspace');
  -- now a LATER complete-but-rejecting run
  perform pg_temp.open_run('a1111111-0000-4000-8000-000000000001','9c00000f-0000-4000-8000-00000000000f','4000000c-0000-4000-8000-00000000000c', true, 2, 'last_page');
  r := public.runner_mark_absent_directory_users_stale('4000000b-0000-4000-8000-00000000000b','a1111111-0000-4000-8000-000000000001','google_workspace');
  assert (r->>'eligible')::boolean = false, 'G5b a complete-but-rejecting later run supersedes the earlier good run (inherited, fails safe)';
  assert (r->>'staleMarked')::int = 0, 'G5b and therefore stales nothing';
end $$;

-- ════ G6: ZERO-DATA run is still COMPLETE and promotable ═════════════════════════════════════════════════════════════
do $$ declare r jsonb; begin
  -- A tenant whose query legitimately matches nobody. This must be a successful empty promotion, NOT a failure —
  -- and it must not stale the existing directory either, because on a NEW connection there is nothing to compare to.
  perform pg_temp.open_run('a2222222-0000-4000-8000-000000000002','9c000002-0000-4000-8000-000000000002','40000005-0000-4000-8000-000000000005', true, 0, 'last_page');
  r := public.runner_promote_directory_users('40000005-0000-4000-8000-000000000005','a2222222-0000-4000-8000-000000000002','google_workspace');
  assert (r->>'identitiesCreated')::int = 0, 'G6 zero-data promote creates nothing';
  assert (r->>'identitiesUpdated')::int = 0, 'G6 zero-data promote updates nothing';
  assert r ? 'identitiesCreated', 'G6 zero-data promote still RETURNS a result (it succeeded)';
end $$;

-- ════ G7: STALE — first run stales zero; a later run stales only what is genuinely absent ════════════════════════════
do $$ declare r jsonb; begin
  -- FIRST RUN on C1 already promoted (G3). Its stale pass must mark ZERO: everything was seen by this very run.
  r := public.runner_mark_absent_directory_users_stale('40000001-0000-4000-8000-000000000001','a1111111-0000-4000-8000-000000000001','google_workspace');
  assert (r->>'eligible')::boolean = true, 'G7 complete run is eligible';
  assert (r->>'staleMarked')::int = 0, 'G7 first run stales zero';

  -- SECOND complete run that sees only u1. u2 is now genuinely absent -> exactly one row goes stale.
  perform pg_temp.open_run('a1111111-0000-4000-8000-000000000001','9c000001-0000-4000-8000-000000000001','40000006-0000-4000-8000-000000000006', true, 0, 'last_page');
  perform pg_temp.seed_user('a1111111-0000-4000-8000-000000000001','9c000001-0000-4000-8000-000000000001','40000006-0000-4000-8000-000000000006','u1','ada@t1.example');
  perform pg_temp.seed_user('a1111111-0000-4000-8000-000000000001','9c000001-0000-4000-8000-000000000001','40000006-0000-4000-8000-000000000006','u2','bob@t1.example');
  perform pg_temp.seed_user('a1111111-0000-4000-8000-000000000001','9c000001-0000-4000-8000-000000000001','40000006-0000-4000-8000-000000000006','u3','cyd@t1.example');
  perform public.runner_promote_directory_users('40000006-0000-4000-8000-000000000006','a1111111-0000-4000-8000-000000000001','google_workspace');
  r := public.runner_mark_absent_directory_users_stale('40000006-0000-4000-8000-000000000006','a1111111-0000-4000-8000-000000000001','google_workspace');
  assert (r->>'staleMarked')::int = 1, 'G7 exactly one absent identity went stale (1 of 4 = 25%, under the 30% breaker)';
  assert (select sync_status from public.identity_accounts where connection_id='9c000001-0000-4000-8000-000000000001' and external_id='u4')='stale', 'G7 u4 is the stale one';
  assert (select stale_since from public.identity_accounts where connection_id='9c000001-0000-4000-8000-000000000001' and external_id='u4') is not null, 'G7 stale row carries stale_since';
  assert (select sync_status from public.identity_accounts where connection_id='9c000001-0000-4000-8000-000000000001' and external_id='u1')='current', 'G7 u1 stays current';
  assert (select stale_since from public.identity_accounts where connection_id='9c000001-0000-4000-8000-000000000001' and external_id='u1') is null, 'G7 current row has NULL stale_since (0070 invariant)';

  -- A row that comes BACK is promoted to current and its stale_since is cleared.
  perform pg_temp.open_run('a1111111-0000-4000-8000-000000000001','9c000001-0000-4000-8000-000000000001','40000007-0000-4000-8000-000000000007', true, 0, 'last_page');
  perform pg_temp.seed_user('a1111111-0000-4000-8000-000000000001','9c000001-0000-4000-8000-000000000001','40000007-0000-4000-8000-000000000007','u1','ada@t1.example');
  perform pg_temp.seed_user('a1111111-0000-4000-8000-000000000001','9c000001-0000-4000-8000-000000000001','40000007-0000-4000-8000-000000000007','u2','bob@t1.example');
  perform pg_temp.seed_user('a1111111-0000-4000-8000-000000000001','9c000001-0000-4000-8000-000000000001','40000007-0000-4000-8000-000000000007','u3','cyd@t1.example');
  perform pg_temp.seed_user('a1111111-0000-4000-8000-000000000001','9c000001-0000-4000-8000-000000000001','40000007-0000-4000-8000-000000000007','u4','dee@t1.example');
  perform public.runner_promote_directory_users('40000007-0000-4000-8000-000000000007','a1111111-0000-4000-8000-000000000001','google_workspace');
  assert (select sync_status from public.identity_accounts where connection_id='9c000001-0000-4000-8000-000000000001' and external_id='u4')='current', 'G7 returning row is current again';
  assert (select stale_since from public.identity_accounts where connection_id='9c000001-0000-4000-8000-000000000001' and external_id='u4') is null, 'G7 returning row cleared stale_since';
end $$;

-- ════ G8: SUPERSEDED run — an older complete run may neither promote nor stale ════════════════════════════════════════
do $$ declare r jsonb; raised boolean; begin
  -- run 40000006 is complete but a LATER complete run (40000007) exists.
  raised := false;
  begin perform public.runner_promote_directory_users('40000006-0000-4000-8000-000000000006','a1111111-0000-4000-8000-000000000001','google_workspace');
  exception when others then raised := true; end;
  assert raised, 'G8 a superseded run cannot re-promote';
  r := public.runner_mark_absent_directory_users_stale('40000006-0000-4000-8000-000000000006','a1111111-0000-4000-8000-000000000001','google_workspace');
  assert (r->>'eligible')::boolean = false, 'G8 a superseded run cannot stale (mass-stale guard)';
end $$;

-- ════ G9: GROUPS + MEMBERSHIPS ═══════════════════════════════════════════════════════════════════════════════════════
do $$ declare r jsonb; raised boolean; begin
  perform pg_temp.open_run('a1111111-0000-4000-8000-000000000001','9c000001-0000-4000-8000-000000000001','40000008-0000-4000-8000-000000000008', true, 0, 'last_page');
  perform pg_temp.seed_user ('a1111111-0000-4000-8000-000000000001','9c000001-0000-4000-8000-000000000001','40000008-0000-4000-8000-000000000008','u1','ada@t1.example');
  perform pg_temp.seed_user ('a1111111-0000-4000-8000-000000000001','9c000001-0000-4000-8000-000000000001','40000008-0000-4000-8000-000000000008','u2','bob@t1.example');
  perform pg_temp.seed_group('a1111111-0000-4000-8000-000000000001','9c000001-0000-4000-8000-000000000001','40000008-0000-4000-8000-000000000008','g1','Engineering');
  perform public.runner_promote_directory_users ('40000008-0000-4000-8000-000000000008','a1111111-0000-4000-8000-000000000001','google_workspace');
  r := public.runner_promote_directory_groups('40000008-0000-4000-8000-000000000008','a1111111-0000-4000-8000-000000000001','google_workspace');
  assert (r->>'groupsCreated')::int = 1, 'G9 one group created';
  assert (select group_type_category from public.directory_groups where external_id='g1')='other', 'G9 google groups use the neutral category';

  -- MEMBERSHIP: both endpoints resolve -> the edge lands.
  perform pg_temp.seed_membership('a1111111-0000-4000-8000-000000000001','9c000001-0000-4000-8000-000000000001','40000008-0000-4000-8000-000000000008','g1','u1');
  r := public.runner_promote_directory_group_memberships('40000008-0000-4000-8000-000000000008','a1111111-0000-4000-8000-000000000001','google_workspace');
  assert (r->>'membershipsCreated')::int = 1, 'G9 one membership edge created';
  assert (select count(*) from public.directory_group_memberships where connection_id='9c000001-0000-4000-8000-000000000001')=1, 'G9 edge row landed';

  -- UNRESOLVED ENDPOINT fails the WHOLE promotion closed. This is the case a Google EXTERNAL / nested-GROUP /
  -- whole-domain member would hit: no identity_accounts row exists for it, so the runner must never emit such an edge.
  perform pg_temp.open_run('a1111111-0000-4000-8000-000000000001','9c000001-0000-4000-8000-000000000001','4000000a-0000-4000-8000-00000000000a', true, 0, 'last_page');
  perform pg_temp.seed_user ('a1111111-0000-4000-8000-000000000001','9c000001-0000-4000-8000-000000000001','4000000a-0000-4000-8000-00000000000a','u1','ada@t1.example');
  perform pg_temp.seed_group('a1111111-0000-4000-8000-000000000001','9c000001-0000-4000-8000-000000000001','4000000a-0000-4000-8000-00000000000a','g1','Engineering');
  perform public.runner_promote_directory_users ('4000000a-0000-4000-8000-00000000000a','a1111111-0000-4000-8000-000000000001','google_workspace');
  perform public.runner_promote_directory_groups('4000000a-0000-4000-8000-00000000000a','a1111111-0000-4000-8000-000000000001','google_workspace');
  perform pg_temp.seed_membership('a1111111-0000-4000-8000-000000000001','9c000001-0000-4000-8000-000000000001','4000000a-0000-4000-8000-00000000000a','g1','outsider@other.example');
  raised := false;
  begin perform public.runner_promote_directory_group_memberships('4000000a-0000-4000-8000-00000000000a','a1111111-0000-4000-8000-000000000001','google_workspace');
  exception when others then raised := true; end;
  assert raised, 'G9 an unresolvable membership endpoint fails the whole promotion closed';
end $$;

-- ════ G10: LICENCE FACTS — accepted, key-bounded, and NOT promoted to any table ══════════════════════════════════════
do $$ declare raised boolean; begin
  -- The licence fact passes the widened write boundary.
  perform public.runner_insert_discovery_fact(
    'a1111111-0000-4000-8000-000000000001','40000008-0000-4000-8000-000000000008','license','identity_provider_discovery','google_workspace',
    'google_workspace:9c000001-0000-4000-8000-000000000001:license:Google-Apps:1010020020:ada@t1.example','1010020020:ada@t1.example', now(), 1.0,
    jsonb_build_object('fact_type','license','connection_id','9c000001-0000-4000-8000-000000000001','app_instance_key','C01abcdef',
                       'product_id','Google-Apps','license_sku','1010020020','license_name','Google Workspace Enterprise Plus',
                       'license_status','assigned','provider_user_key','ada@t1.example'),
    jsonb_build_object('provider','google_workspace','cost_available',false,'assignment_time_available',false));
  assert (select count(*) from public.discovery_facts where fact_type='license')=1, 'G10 licence fact landed';

  -- IDEMPOTENT: the same signal_id upserts rather than duplicating.
  perform public.runner_insert_discovery_fact(
    'a1111111-0000-4000-8000-000000000001','40000008-0000-4000-8000-000000000008','license','identity_provider_discovery','google_workspace',
    'google_workspace:9c000001-0000-4000-8000-000000000001:license:Google-Apps:1010020020:ada@t1.example','1010020020:ada@t1.example', now(), 1.0,
    jsonb_build_object('fact_type','license','connection_id','9c000001-0000-4000-8000-000000000001','app_instance_key','C01abcdef',
                       'product_id','Google-Apps','license_sku','1010020020','license_name','Google Workspace Enterprise Plus',
                       'license_status','assigned','provider_user_key','ada@t1.example'),
    jsonb_build_object('provider','google_workspace'));
  assert (select count(*) from public.discovery_facts where fact_type='license')=1, 'G10 licence fact replay did not duplicate';

  -- A COST field is refused: Google reports none, so an allowlist entry for one would invite a synthesized number.
  raised := false;
  begin perform public.runner_insert_discovery_fact(
    'a1111111-0000-4000-8000-000000000001','40000008-0000-4000-8000-000000000008','license','identity_provider_discovery','google_workspace',
    'gws:cost','k', now(), 1.0,
    jsonb_build_object('fact_type','license','connection_id','9c000001-0000-4000-8000-000000000001','license_sku','s','license_name','n','cost_hint',42),
    null);
  exception when others then raised := true; end;
  assert raised, 'G10 a cost field on a licence fact is refused';

  -- An ASSIGNMENT TIMESTAMP is refused for the same reason.
  raised := false;
  begin perform public.runner_insert_discovery_fact(
    'a1111111-0000-4000-8000-000000000001','40000008-0000-4000-8000-000000000008','license','identity_provider_discovery','google_workspace',
    'gws:assigned','k', now(), 1.0,
    jsonb_build_object('fact_type','license','connection_id','9c000001-0000-4000-8000-000000000001','license_sku','s','license_name','n','assigned_at','2026-01-01'),
    null);
  exception when others then raised := true; end;
  assert raised, 'G10 an assignment timestamp on a licence fact is refused';

  -- NO NORMALIZED LICENCE TABLE was introduced: licences are evidence only.
  assert (select count(*) from information_schema.tables where table_schema='public' and table_name in ('licenses','license_assignments','directory_licenses'))=0,
    'G10 no normalized licence table exists';
end $$;

-- ════ G11: the write boundary still refuses everything it refused before ═════════════════════════════════════════════
do $$ declare raised boolean; begin
  -- an un-allowlisted fact type
  raised := false;
  begin perform public.runner_insert_discovery_fact(
    'a1111111-0000-4000-8000-000000000001','40000008-0000-4000-8000-000000000008','role_admin','identity_provider_discovery','google_workspace',
    'gws:role','k', now(), 1.0, jsonb_build_object('fact_type','role_admin','role_name','super'), null);
  exception when others then raised := true; end;
  assert raised, 'G11 role_admin is still refused (no writer exists for it)';

  raised := false;
  begin perform public.runner_insert_discovery_fact(
    'a1111111-0000-4000-8000-000000000001','40000008-0000-4000-8000-000000000008','usage_activity','identity_provider_discovery','google_workspace',
    'gws:usage','k', now(), 1.0, jsonb_build_object('fact_type','usage_activity','last_activity_at','2026-01-01'), null);
  exception when others then raised := true; end;
  assert raised, 'G11 usage_activity is still refused';

  -- a secret-shaped key anywhere in the fact or its provenance
  raised := false;
  begin perform public.runner_insert_discovery_fact(
    'a1111111-0000-4000-8000-000000000001','40000008-0000-4000-8000-000000000008','license','identity_provider_discovery','google_workspace',
    'gws:secret','k', now(), 1.0,
    jsonb_build_object('fact_type','license','connection_id','9c000001-0000-4000-8000-000000000001','license_sku','s','license_name','n'),
    jsonb_build_object('access_token','ya29.x'));
  exception when others then raised := true; end;
  assert raised, 'G11 a token in provenance is still refused';

  -- an identity_account fact carrying a Google-specific key must be refused: those observations belong in provenance,
  -- not in the shared canonical shape.
  raised := false;
  begin perform public.runner_insert_discovery_fact(
    'a1111111-0000-4000-8000-000000000001','40000008-0000-4000-8000-000000000008','identity_account','identity_provider_discovery','google_workspace',
    'gws:orgunit','k', now(), 1.0,
    jsonb_build_object('fact_type','identity_account','external_id','u9','connection_id','9c000001-0000-4000-8000-000000000001','org_unit_path','/Eng'),
    null);
  exception when others then raised := true; end;
  assert raised, 'G11 a Google-specific key on identity_account is refused (it belongs in provenance)';
end $$;

-- ════ G12: OKTA IS UNTOUCHED ═════════════════════════════════════════════════════════════════════════════════════════
do $$ begin
  -- 0083 must not have altered the Okta write path in any way.
  assert has_function_privilege('connector_runner', 'public.runner_promote_okta_directory_users(uuid,uuid)', 'EXECUTE'), 'G12 okta promote still granted';
  assert has_function_privilege('connector_runner', 'public.runner_mark_absent_okta_identities_stale(uuid,uuid)', 'EXECUTE'), 'G12 okta stale still granted';
  -- Scoped to THIS suite's tenants. The harness runs every *_test.sql against one database, so a repo-wide count would
  -- be asserting about other suites' fixtures rather than about 0083.
  assert (select count(*) from public.identity_accounts
           where provider='okta'
             and tenant_id in ('a1111111-0000-4000-8000-000000000001','a2222222-0000-4000-8000-000000000002')) = 0,
    'G12 this suite created no okta identity row';
  -- The okta connection in this suite's fixtures stayed completely untouched: no run of ours promoted through it.
  assert (select count(*) from public.identity_accounts where connection_id='90c00001-0000-4000-8000-0000000000c0') = 0,
    'G12 the okta connection has no promoted rows';
  -- the okta stale policy row is still there and unchanged
  assert (select stale_percent_threshold from public.connector_discovery_policy where provider='okta') = 30, 'G12 okta policy unchanged';
  assert (select stale_percent_threshold from public.connector_discovery_policy where provider='google_workspace') = 30, 'G12 google policy seeded at the same default';
end $$;

-- ── no teardown ──────────────────────────────────────────────────────────────────────────────────────────────────────
-- Fixtures are deliberately LEFT IN PLACE, as most suites do. Deleting the tenants would cascade a DELETE into
-- `audit_logs`, which is append-only and refuses it (0068 writes a stale-transition audit row, and G7 triggers exactly
-- that path). The harness gives every run a throwaway database, so leaving rows costs nothing.
--
-- The `google_workspace` row in connector_discovery_policy is likewise left: 0083 inserts it as real configuration, and
-- removing it here would undo part of the migration under test.

reset role;
do $$ begin raise notice 'ALL GOOGLE WORKSPACE DIRECTORY PERSISTENCE ASSERTIONS PASSED'; end $$;
