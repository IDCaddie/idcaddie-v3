-- Phase 18C — the RPC contracts the deterministic matcher depends on, proven against a REAL database.
--
-- The matcher's unit tests drive a mocked `rpc`, which proves its decisions and proves nothing about whether the calls it
-- makes exist, are permitted, or mean what it assumes. Phase 18A shipped a server action that read a deny-all table and
-- seventeen green mocked tests never noticed. So every call shape the matcher issues is exercised here, verbatim:
--
--   product_start_application_matcher_run(p_tenant_id)
--   product_list_directory_applications(p_tenant_id, p_connection_id, p_provider, p_include_stale, p_after_id, p_limit)
--   product_application_match_candidates(p_tenant_id, p_after_directory_application_id, p_limit)
--   product_propose_application_match(p_tenant_id, p_directory_application_id, p_app_id, p_method, p_confidence)
--   product_complete_application_matcher_run(p_tenant_id) / product_fail_application_matcher_run(p_tenant_id)
--
-- A signature drift, a revoked grant or a changed status literal breaks this file rather than a customer's run.

reset role;

insert into auth.users (id, email) values
  ('1c8c0000-0000-4000-8000-0000000000f1','mrun_owner@t.test'),
  ('1c8c0000-0000-4000-8000-0000000000f2','mrun_editor@t.test');
insert into public.profiles (id, email) values
  ('1c8c0000-0000-4000-8000-0000000000f1','mrun_owner@t.test'),
  ('1c8c0000-0000-4000-8000-0000000000f2','mrun_editor@t.test');
insert into public.tenants (id, name, slug) values
  ('1c8c0000-0000-4000-8000-00000000000a','Matcher Run A','matcher-run-a');
insert into public.tenant_memberships (tenant_id, user_id, role, status) values
  ('1c8c0000-0000-4000-8000-00000000000a','1c8c0000-0000-4000-8000-0000000000f1','owner','active'),
  ('1c8c0000-0000-4000-8000-00000000000a','1c8c0000-0000-4000-8000-0000000000f2','editor','active');
insert into public.connectors (id, tenant_id, provider, display_name, status, connection_state) values
  ('1c8c0000-0000-4000-8000-0000000000c1','1c8c0000-0000-4000-8000-00000000000a','okta','Dir','pending','discovered');

-- The estate the matcher must classify: d1 -> many (2 instances), d2 -> one, d3 -> resolved/zero, d4 -> unresolved
-- (no confirmed alias at all), d5 -> stale so neither feed may see it.
insert into public.app_products (id, tenant_id, name, normalized_name) values
  ('1c8c0000-0000-4000-8000-0000000000b1','1c8c0000-0000-4000-8000-00000000000a','Many','many'),
  ('1c8c0000-0000-4000-8000-0000000000b2','1c8c0000-0000-4000-8000-00000000000a','One','one'),
  ('1c8c0000-0000-4000-8000-0000000000b3','1c8c0000-0000-4000-8000-00000000000a','Zero','zero');
insert into public.apps (id, tenant_id, name, canonical_app_id) values
  ('1c8c0000-0000-4000-8000-0000000000a1','1c8c0000-0000-4000-8000-00000000000a','Many Prod','1c8c0000-0000-4000-8000-0000000000b1'),
  ('1c8c0000-0000-4000-8000-0000000000a2','1c8c0000-0000-4000-8000-00000000000a','Many Sandbox','1c8c0000-0000-4000-8000-0000000000b1'),
  ('1c8c0000-0000-4000-8000-0000000000a3','1c8c0000-0000-4000-8000-00000000000a','One Prod','1c8c0000-0000-4000-8000-0000000000b2');
insert into public.directory_applications (id, tenant_id, connection_id, provider, external_id, label, sync_status) values
  ('1c8c0000-0000-4000-8000-0000000000d1','1c8c0000-0000-4000-8000-00000000000a','1c8c0000-0000-4000-8000-0000000000c1','okta','MRUNMANY01','Many','current'),
  ('1c8c0000-0000-4000-8000-0000000000d2','1c8c0000-0000-4000-8000-00000000000a','1c8c0000-0000-4000-8000-0000000000c1','okta','MRUNONE002','One','current'),
  ('1c8c0000-0000-4000-8000-0000000000d3','1c8c0000-0000-4000-8000-00000000000a','1c8c0000-0000-4000-8000-0000000000c1','okta','MRUNZERO03','Zero','current'),
  ('1c8c0000-0000-4000-8000-0000000000d4','1c8c0000-0000-4000-8000-00000000000a','1c8c0000-0000-4000-8000-0000000000c1','okta','MRUNUNRS04','Unresolved','current'),
  ('1c8c0000-0000-4000-8000-0000000000d5','1c8c0000-0000-4000-8000-00000000000a','1c8c0000-0000-4000-8000-0000000000c1','okta','MRUNSTAL05','Stale','stale');
insert into public.app_aliases (tenant_id, app_product_id, alias_type, alias_value, source, confidence, review_status) values
  ('1c8c0000-0000-4000-8000-00000000000a','1c8c0000-0000-4000-8000-0000000000b1','provider_app_id','MRUNMANY01','product_declaration',100,'confirmed'),
  ('1c8c0000-0000-4000-8000-00000000000a','1c8c0000-0000-4000-8000-0000000000b2','provider_app_id','MRUNONE002','product_declaration',100,'confirmed'),
  ('1c8c0000-0000-4000-8000-00000000000a','1c8c0000-0000-4000-8000-0000000000b3','provider_app_id','MRUNZERO03','product_declaration',100,'confirmed'),
  ('1c8c0000-0000-4000-8000-00000000000a','1c8c0000-0000-4000-8000-0000000000b1','provider_app_id','MRUNSTAL05','product_declaration',100,'confirmed');

create or replace function pg_temp.act(p_user uuid) returns void language plpgsql as $$
begin perform set_config('request.jwt.claims', json_build_object('sub', p_user)::text, false); end $$;

-- The matcher's own call shapes, byte-for-byte. If a signature drifts these helpers stop resolving.
create or replace function pg_temp.census(p_after uuid default null) returns setof uuid language sql as $$
  select id from public.product_list_directory_applications(
    '1c8c0000-0000-4000-8000-00000000000a', null, null, false, p_after, 100) order by id;
$$;
create or replace function pg_temp.candidates(p_after uuid default null)
  returns table (d uuid, p uuid, a uuid) language sql as $$
  select directory_application_id, app_product_id, app_id
    from public.product_application_match_candidates('1c8c0000-0000-4000-8000-00000000000a', p_after, 200);
$$;
create or replace function pg_temp.propose(p_dir uuid, p_app uuid, p_conf text default 'medium')
  returns text language sql as $$
  select public.product_propose_application_match(
    '1c8c0000-0000-4000-8000-00000000000a', p_dir, p_app, 'canonical_product', p_conf) ->> 'status';
$$;
-- `application_matches` is deny-all to `authenticated` (0075), which K7 asserts — so the suite cannot read it while
-- acting as a product user. SECURITY DEFINER scaffolding in pg_temp; nothing here grants the product anything.
create or replace function pg_temp.mid(p_dir uuid, p_app uuid) returns uuid language sql security definer as $$
  select id from public.application_matches where directory_application_id = p_dir and app_id = p_app;
$$;
create or replace function pg_temp.mstate() returns text language sql as $$
  select status from public.product_application_matcher_state('1c8c0000-0000-4000-8000-00000000000a');
$$;

-- ════ K1: the census the matcher reads — current only, and it is the SUPERSET of the candidate feed ══════════════════
set role authenticated;
select pg_temp.act('1c8c0000-0000-4000-8000-0000000000f1');
do $$
declare n integer; missing integer;
begin
  select count(*) into n from pg_temp.census();
  assert n = 4, format('K1 the census must return the four CURRENT applications, got %s', n);
  assert not exists (select 1 from pg_temp.census() x(c) where x.c = '1c8c0000-0000-4000-8000-0000000000d5'),
    'K1 a stale application must not appear when p_include_stale is false';

  -- THE INVARIANT THE MATCHER'S CROSS-FEED CHECK RELIES ON. If the two feeds ever filter differently, a candidate
  -- would name an application the census never returned, and the matcher fails the run rather than proposing against
  -- something it did not examine. Proven here so a drift shows up as a contract break, not as a failed customer run.
  select count(*) into missing
    from (select distinct d from pg_temp.candidates()) f
   where f.d not in (select x.c from pg_temp.census() x(c));
  assert missing = 0, format('K1 every candidate parent must appear in the census, %s did not', missing);
end $$;

-- ════ K2: the candidate feed's 0 / 1 / many shape, exactly as the planner groups it ══════════════════════════════════
do $$
declare n integer; v uuid;
begin
  select count(*) into n from pg_temp.candidates() where d = '1c8c0000-0000-4000-8000-0000000000d1';
  assert n = 2, format('K2 the many-instance product must yield two candidate rows, got %s', n);

  select count(*) into n from pg_temp.candidates() where d = '1c8c0000-0000-4000-8000-0000000000d2';
  assert n = 1, format('K2 the one-instance product must yield exactly one row, got %s', n);

  select a into v from pg_temp.candidates() where d = '1c8c0000-0000-4000-8000-0000000000d3';
  assert v is null, 'K2 a resolved product with zero instances must yield ONE row whose app_id is NULL';

  -- The distinction the whole contract turns on: absent ≠ NULL.
  assert not exists (select 1 from pg_temp.candidates() where d = '1c8c0000-0000-4000-8000-0000000000d4'),
    'K2 an application with no confirmed alias must produce NO row — unresolved is absence, not a NULL row';
end $$;

-- ════ K3: the run lifecycle, and what each transition actually returns ═══════════════════════════════════════════════
do $$
declare v jsonb;
begin
  v := public.product_start_application_matcher_run('1c8c0000-0000-4000-8000-00000000000a');
  assert v ->> 'status' = 'running', format('K3 start must report running, got %s', v);
  assert pg_temp.mstate() = 'running', 'K3 the state must actually be running';

  -- The matcher requires updated = 1. Anything else means the row was no longer this run's to complete.
  v := public.product_complete_application_matcher_run('1c8c0000-0000-4000-8000-00000000000a');
  assert (v ->> 'updated')::int = 1, format('K3 completing a running run must move exactly one row, got %s', v);
  assert pg_temp.mstate() = 'completed', 'K3 the state must be completed — this is what licenses Rule 5';

  -- Both mutations are guarded on `status = 'running'`, so a second attempt moves nothing. That zero is precisely the
  -- signal the matcher treats as state_transition_failed rather than success.
  v := public.product_complete_application_matcher_run('1c8c0000-0000-4000-8000-00000000000a');
  assert (v ->> 'updated')::int = 0, 'K3 completing a run that is not running must move no row';
  v := public.product_fail_application_matcher_run('1c8c0000-0000-4000-8000-00000000000a');
  assert (v ->> 'updated')::int = 0, 'K3 failing a run that is not running must move no row';
  assert pg_temp.mstate() = 'completed', 'K3 and must not overwrite a completed run';

  -- A failed run leaves Rule 5 withheld: `completed` is the only status that licenses it, and 0085 keeps
  -- last_completed_at deliberately stricter than the status.
  perform public.product_start_application_matcher_run('1c8c0000-0000-4000-8000-00000000000a');
  v := public.product_fail_application_matcher_run('1c8c0000-0000-4000-8000-00000000000a');
  assert (v ->> 'updated')::int = 1 and pg_temp.mstate() = 'failed',
    'K3 a failed run must be recorded as failed';
  assert (select last_completed_at is not null from public.product_application_matcher_state('1c8c0000-0000-4000-8000-00000000000a')),
    'K3 an earlier success is not erased by a later failure — which is why status, not the timestamp, gates Rule 5';
end $$;

-- ════ K4: the proposal the matcher issues, with its exact method and confidence ══════════════════════════════════════
do $$
begin
  assert pg_temp.propose('1c8c0000-0000-4000-8000-0000000000d2','1c8c0000-0000-4000-8000-0000000000a3','medium') = 'proposed',
    'K4 canonical_product at medium must be an accepted proposal';

  -- Replay is the second run of an unchanged estate: idempotent, never a duplicate, never re-scored.
  assert pg_temp.propose('1c8c0000-0000-4000-8000-0000000000d2','1c8c0000-0000-4000-8000-0000000000a3','medium') = 'already_proposed',
    'K4 a replayed proposal must be an idempotent no-op';
  assert pg_temp.propose('1c8c0000-0000-4000-8000-0000000000d2','1c8c0000-0000-4000-8000-0000000000a3','low') = 'already_proposed',
    'K4 nor may a replay at another confidence re-score it';

  -- Both instances of the ambiguous product are proposed. Neither is chosen.
  assert pg_temp.propose('1c8c0000-0000-4000-8000-0000000000d1','1c8c0000-0000-4000-8000-0000000000a1','low') = 'proposed'
     and pg_temp.propose('1c8c0000-0000-4000-8000-0000000000d1','1c8c0000-0000-4000-8000-0000000000a2','low') = 'proposed',
    'K4 every instance under an ambiguous product must be proposable';
end $$;
reset role;
do $$
declare r public.application_matches%rowtype;
begin
  select * into r from public.application_matches
   where directory_application_id = '1c8c0000-0000-4000-8000-0000000000d2';
  assert r.method = 'canonical_product', format('K4 the recorded provenance must be canonical_product, got %s', r.method);
  assert r.confidence = 'medium', 'K4 one candidate is MEDIUM — never high, however unambiguous';
  assert r.status = 'proposed' and r.decided_by is null and r.decided_at is null,
    'K4 the matcher may only ever write a proposal carrying no decision';
  assert (select count(*) from public.application_matches
           where directory_application_id = '1c8c0000-0000-4000-8000-0000000000d1' and confidence = 'low') = 2,
    'K4 every ambiguous candidate is LOW';
end $$;

-- ════ K5: replay against SETTLED human decisions — the matcher must not fight them ══════════════════════════════════
set role authenticated;
select pg_temp.act('1c8c0000-0000-4000-8000-0000000000f1');
do $$
declare acc uuid := pg_temp.mid('1c8c0000-0000-4000-8000-0000000000d1','1c8c0000-0000-4000-8000-0000000000a1');
        rej uuid := pg_temp.mid('1c8c0000-0000-4000-8000-0000000000d1','1c8c0000-0000-4000-8000-0000000000a2');
begin
  assert public.product_decide_application_match('1c8c0000-0000-4000-8000-00000000000a', acc, 'accepted') ->> 'status' = 'accepted',
    'K5 a human may accept one candidate';
  assert public.product_decide_application_match('1c8c0000-0000-4000-8000-00000000000a', rej, 'rejected') ->> 'status' = 'rejected',
    'K5 and reject the other';

  -- The next matcher run re-proposes both, because the estate still says both are candidates. These two statuses are
  -- what the matcher counts as SUCCESSES: the candidate was legitimate and a person had already answered it.
  assert pg_temp.propose('1c8c0000-0000-4000-8000-0000000000d1','1c8c0000-0000-4000-8000-0000000000a1','low') = 'already_accepted',
    'K5 replaying an accepted candidate must report it, not duplicate it';
  assert pg_temp.propose('1c8c0000-0000-4000-8000-0000000000d1','1c8c0000-0000-4000-8000-0000000000a2','low') = 'already_rejected',
    'K5 replaying a rejected candidate must report it, not resurrect it';
end $$;
reset role;
do $$ begin
  assert (select count(*) from public.application_matches
           where directory_application_id = '1c8c0000-0000-4000-8000-0000000000d1') = 2,
    'K5 replay must add no rows';
  assert (select status from public.application_matches
           where directory_application_id = '1c8c0000-0000-4000-8000-0000000000d1'
             and app_id = '1c8c0000-0000-4000-8000-0000000000a2') = 'rejected',
    'K5 the rejection still stands after replay';
end $$;

-- ════ K6: authority — every call the matcher makes is owner/admin, on REAL memberships ══════════════════════════════
-- The editor below is a member in good standing. The gate must still refuse all five, or a matcher run would be
-- executable by somebody who may not review its output.
set role authenticated;
select pg_temp.act('1c8c0000-0000-4000-8000-0000000000f2');
do $$
declare n integer;
begin
  select count(*) into n from pg_temp.census();
  assert n = 0, format('K6 an editor must read no census, got %s', n);
  select count(*) into n from pg_temp.candidates();
  assert n = 0, format('K6 an editor must read no candidates, got %s', n);
  assert pg_temp.propose('1c8c0000-0000-4000-8000-0000000000d2','1c8c0000-0000-4000-8000-0000000000a3') = 'not_allowed',
    'K6 an editor must not propose';
  begin
    perform public.product_start_application_matcher_run('1c8c0000-0000-4000-8000-00000000000a');
    assert false, 'K6 an editor must not start a matcher run';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.product_complete_application_matcher_run('1c8c0000-0000-4000-8000-00000000000a');
    assert false, 'K6 an editor must not complete a matcher run';
  exception when insufficient_privilege then null;
  end;
end $$;
reset role;

-- ════ K7: privilege closure over the five functions the matcher calls ═══════════════════════════════════════════════
do $$
declare f oid;
begin
  foreach f in array array[
    'public.product_start_application_matcher_run(uuid)'::regprocedure,
    'public.product_complete_application_matcher_run(uuid)'::regprocedure,
    'public.product_fail_application_matcher_run(uuid)'::regprocedure,
    'public.product_application_match_candidates(uuid,uuid,integer)'::regprocedure,
    'public.product_propose_application_match(uuid,uuid,uuid,text,text)'::regprocedure
  ] loop
    assert has_function_privilege('authenticated', f, 'EXECUTE'), 'K7 authenticated must hold EXECUTE';
    assert not has_function_privilege('anon', f, 'EXECUTE'), 'K7 anon must NOT hold EXECUTE';
    assert not has_function_privilege('connector_runner', f, 'EXECUTE'),
           'K7 connector_runner gains nothing — the matcher is product-side authority';
    assert not exists (select 1 from pg_proc p, aclexplode(p.proacl) a
                        where p.oid = f and a.grantee = 0 and a.privilege_type = 'EXECUTE'),
           'K7 PUBLIC must NOT hold EXECUTE';
    assert (select prosecdef from pg_proc where oid = f), 'K7 must be SECURITY DEFINER';
    assert (select proconfig::text from pg_proc where oid = f) like '%search_path=public%',
           'K7 search_path must be pinned';
  end loop;

  -- The identifier the candidate feed joins on stays where it was: the matcher never gains a path to it.
  assert (select relrowsecurity from pg_class where oid = 'public.directory_applications'::regclass),
         'K7 directory_applications must keep RLS enabled';
  assert not exists (select 1 from pg_policies where schemaname='public' and tablename='directory_applications'),
         'K7 directory_applications must still have NO policy — deny-all is what forces the join inside the RPC';
  assert not has_table_privilege('authenticated', 'public.directory_applications', 'SELECT'),
         'K7 no browser role may select directory_applications';
end $$;

-- ════ K8: a CROSS-TENANT identifier collision — salvaged from the rejected 18C0 narrowing branch ════════════════════
-- Tenant B confirms the SAME provider identifier value that tenant A's many-instance application carries. This is the
-- only fixture that makes the tenant predicates on the alias and product legs testable at all: without a colliding
-- VALUE no bridge is possible, so a mutant deleting `al.tenant_id = da.tenant_id` would pass every other assertion here.
--
-- The matcher runs per tenant and its cross-feed validation trusts that scoping completely — a candidate that bridged
-- would name an application tenant A's census never returned, and the run would fail on evidence that should never
-- have existed. Proven at the source instead.
reset role;
insert into auth.users (id, email) values ('1c8c0000-0000-4000-8000-0000000000f9','mrun_owner_b@t.test');
insert into public.profiles (id, email) values ('1c8c0000-0000-4000-8000-0000000000f9','mrun_owner_b@t.test');
insert into public.tenants (id, name, slug) values
  ('1c8c0000-0000-4000-8000-00000000000b','Matcher Run B','matcher-run-b');
insert into public.tenant_memberships (tenant_id, user_id, role, status) values
  ('1c8c0000-0000-4000-8000-00000000000b','1c8c0000-0000-4000-8000-0000000000f9','owner','active');
insert into public.connectors (id, tenant_id, provider, display_name, status, connection_state) values
  ('1c8c0000-0000-4000-8000-0000000000c9','1c8c0000-0000-4000-8000-00000000000b','okta','Dir B','pending','discovered');
insert into public.app_products (id, tenant_id, name, normalized_name) values
  ('1c8c0000-0000-4000-8000-0000000000b9','1c8c0000-0000-4000-8000-00000000000b','Foreign','foreign');
insert into public.apps (id, tenant_id, name, canonical_app_id) values
  ('1c8c0000-0000-4000-8000-0000000000a9','1c8c0000-0000-4000-8000-00000000000b','Foreign app','1c8c0000-0000-4000-8000-0000000000b9');
insert into public.directory_applications (id, tenant_id, connection_id, provider, external_id, label, sync_status) values
  ('1c8c0000-0000-4000-8000-0000000000d9','1c8c0000-0000-4000-8000-00000000000b','1c8c0000-0000-4000-8000-0000000000c9',
   'okta','MRUNMANY01','Colliding','current');
-- The SAME alias_value as tenant A's MRUNMANY01, confirmed, pointing at a DIFFERENT product.
insert into public.app_aliases (tenant_id, app_product_id, alias_type, alias_value, source, confidence, review_status) values
  ('1c8c0000-0000-4000-8000-00000000000b','1c8c0000-0000-4000-8000-0000000000b9','provider_app_id','MRUNMANY01','product_declaration',100,'confirmed');

set role authenticated;
select pg_temp.act('1c8c0000-0000-4000-8000-0000000000f1');
do $$
declare v uuid[];
begin
  select array_agg(distinct p) into v from pg_temp.candidates()
   where d = '1c8c0000-0000-4000-8000-0000000000d1';
  assert v = array['1c8c0000-0000-4000-8000-0000000000b1']::uuid[],
    format('K8 a colliding foreign identifier must not bridge into this tenant, saw %s', v);
  assert not exists (select 1 from pg_temp.candidates() where d = '1c8c0000-0000-4000-8000-0000000000d9'),
    'K8 tenant B''s application must never appear in tenant A''s feed';
  -- And the census the matcher validates against is scoped the same way, so neither feed can see the other tenant.
  assert not exists (select 1 from pg_temp.census() x(c) where x.c = '1c8c0000-0000-4000-8000-0000000000d9'),
    'K8 nor in tenant A''s census';
end $$;
reset role;

reset role;
select set_config('request.jwt.claims', '', false);
