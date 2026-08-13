-- 0088 — the governed propose/decide boundary over application_matches.
--
-- The property this suite exists to protect: **a proposal can never become truth by itself.** Only a human accept produces a
-- canonical relationship, only one per directory application, and a rejected candidate stays rejected however many times a
-- matcher re-runs. Everything else here — role vocabulary, tenant scoping, immutability — serves that.

reset role;

insert into auth.users (id, email) values
  ('88000000-0000-4000-8000-0000000000f1', 'own-a@example.test'),
  ('88000000-0000-4000-8000-0000000000f2', 'adm-a@example.test'),
  ('88000000-0000-4000-8000-0000000000f3', 'edt-a@example.test'),
  ('88000000-0000-4000-8000-0000000000f4', 'viw-a@example.test'),
  ('88000000-0000-4000-8000-0000000000f5', 'own-b@example.test');
insert into public.profiles (id, email) values
  ('88000000-0000-4000-8000-0000000000f1', 'own-a@example.test'),
  ('88000000-0000-4000-8000-0000000000f2', 'adm-a@example.test'),
  ('88000000-0000-4000-8000-0000000000f3', 'edt-a@example.test'),
  ('88000000-0000-4000-8000-0000000000f4', 'viw-a@example.test'),
  ('88000000-0000-4000-8000-0000000000f5', 'own-b@example.test');

insert into public.tenants (id, name, slug) values
  ('88000000-0000-4000-8000-00000000000a', 'Match A', 'match-a'),
  ('88000000-0000-4000-8000-00000000000b', 'Match B', 'match-b');
insert into public.tenant_memberships (tenant_id, user_id, role, status) values
  ('88000000-0000-4000-8000-00000000000a', '88000000-0000-4000-8000-0000000000f1', 'owner',  'active'),
  ('88000000-0000-4000-8000-00000000000a', '88000000-0000-4000-8000-0000000000f2', 'admin',  'active'),
  ('88000000-0000-4000-8000-00000000000a', '88000000-0000-4000-8000-0000000000f3', 'editor', 'active'),
  ('88000000-0000-4000-8000-00000000000a', '88000000-0000-4000-8000-0000000000f4', 'viewer', 'active'),
  ('88000000-0000-4000-8000-00000000000b', '88000000-0000-4000-8000-0000000000f5', 'owner',  'active');

insert into public.connectors (id, tenant_id, provider, display_name, status, connection_state) values
  ('88000000-0000-4000-8000-0000000000c1', '88000000-0000-4000-8000-00000000000a', 'okta', 'Dir A', 'pending', 'discovered'),
  ('88000000-0000-4000-8000-0000000000c2', '88000000-0000-4000-8000-00000000000b', 'okta', 'Dir B', 'pending', 'discovered');

-- two directory applications in A (d1 carries the ambiguity), one in B
insert into public.directory_applications (id, tenant_id, connection_id, provider, external_id, label, sync_status) values
  ('88000000-0000-4000-8000-0000000000d1', '88000000-0000-4000-8000-00000000000a', '88000000-0000-4000-8000-0000000000c1', 'okta', '0oaMATCH0001', 'Salesforce', 'current'),
  ('88000000-0000-4000-8000-0000000000d2', '88000000-0000-4000-8000-00000000000a', '88000000-0000-4000-8000-0000000000c1', 'okta', '0oaMATCH0002', 'Second',     'current'),
  ('88000000-0000-4000-8000-0000000000e1', '88000000-0000-4000-8000-00000000000b', '88000000-0000-4000-8000-0000000000c2', 'okta', '0oaMATCHB001', 'Foreign',    'current');

-- the SaaS side: `apps` rows (the operational/contract instance — 0075's endpoint)
insert into public.apps (id, tenant_id, name) values
  ('88000000-0000-4000-8000-0000000000a1', '88000000-0000-4000-8000-00000000000a', 'Salesforce Prod'),
  ('88000000-0000-4000-8000-0000000000a2', '88000000-0000-4000-8000-00000000000a', 'Salesforce Sandbox'),
  ('88000000-0000-4000-8000-0000000000ab', '88000000-0000-4000-8000-00000000000b', 'Foreign app');

create or replace function pg_temp.act(p_user uuid) returns void language plpgsql as $$
begin perform set_config('request.jwt.claims', json_build_object('sub', p_user)::text, false); end $$;

create or replace function pg_temp.propose(p_tenant uuid, p_dir uuid, p_app uuid, p_method text default 'exact_external_id', p_conf text default 'high')
  returns text language sql as $$
  select public.product_propose_application_match(p_tenant, p_dir, p_app, p_method, p_conf) ->> 'status';
$$;
create or replace function pg_temp.decide(p_tenant uuid, p_match uuid, p_decision text) returns text language sql as $$
  select public.product_decide_application_match(p_tenant, p_match, p_decision) ->> 'status';
$$;

-- application_matches is deny-all to `authenticated` (0075), which is exactly what B0 asserts — so the suite cannot read it while
-- acting as a product user. These read-only helpers are SECURITY DEFINER purely so the assertions can inspect the resulting rows
-- without leaving the acting role. They are harness scaffolding in pg_temp; nothing here grants the product anything.
create or replace function pg_temp.mrow(p_dir uuid, p_app uuid) returns public.application_matches language sql security definer as $$
  select * from public.application_matches where directory_application_id = p_dir and app_id = p_app;
$$;
create or replace function pg_temp.mid(p_dir uuid, p_app uuid) returns uuid language sql security definer as $$
  select id from public.application_matches where directory_application_id = p_dir and app_id = p_app;
$$;
create or replace function pg_temp.mstatus(p_id uuid) returns text language sql security definer as $$
  select status from public.application_matches where id = p_id;
$$;
create or replace function pg_temp.ncount(p_dir uuid default null, p_app uuid default null, p_status text default null)
  returns integer language sql security definer as $$
  select count(*)::int from public.application_matches
   where (p_dir is null or directory_application_id = p_dir)
     and (p_app is null or app_id = p_app)
     and (p_status is null or status = p_status);
$$;

-- ════ B0: privilege closure — RPCs only; the table itself stays unreachable ═══════════════════════════════════════════════════
do $$
declare pr oid := 'public.product_propose_application_match(uuid,uuid,uuid,text,text)'::regprocedure;
        de oid := 'public.product_decide_application_match(uuid,uuid,text)'::regprocedure;
        tb oid := 'public.application_matches'::regclass;
        f  oid;
begin
  foreach f in array array[pr, de] loop
    assert has_function_privilege('authenticated', f, 'EXECUTE'), 'B0 authenticated must hold EXECUTE';
    assert not has_function_privilege('anon', f, 'EXECUTE'), 'B0 anon must NOT hold EXECUTE';
    assert not has_function_privilege('connector_runner', f, 'EXECUTE'), 'B0 connector_runner must NOT hold EXECUTE';
    assert not exists (select 1 from pg_proc p, aclexplode(p.proacl) a
                        where p.oid = f and a.grantee = 0 and a.privilege_type = 'EXECUTE'), 'B0 PUBLIC must NOT hold EXECUTE';
    assert (select prosecdef from pg_proc where oid = f), 'B0 must be SECURITY DEFINER';
    assert (select proconfig::text from pg_proc where oid = f) like '%search_path=public%', 'B0 search_path must be pinned';
  end loop;

  -- the table keeps 0075's deny-all posture: RLS on, no policy, no grant to any browser role
  assert (select relrowsecurity from pg_class where oid = tb), 'B0 RLS must remain enabled on application_matches';
  assert not exists (select 1 from pg_policies where schemaname='public' and tablename='application_matches'),
         'B0 application_matches must still have NO policy';
  foreach f in array array[tb] loop
    assert not has_table_privilege('authenticated', f, 'SELECT'), 'B0 authenticated must NOT hold SELECT';
    assert not has_table_privilege('authenticated', f, 'INSERT'), 'B0 authenticated must NOT hold INSERT';
    assert not has_table_privilege('authenticated', f, 'UPDATE'), 'B0 authenticated must NOT hold UPDATE';
    assert not has_table_privilege('anon', f, 'SELECT'), 'B0 anon must NOT hold SELECT';
    assert not has_table_privilege('connector_runner', f, 'SELECT'), 'B0 connector_runner must NOT hold SELECT';
    assert not has_table_privilege('connector_runner', f, 'INSERT'), 'B0 connector_runner must NOT hold INSERT';
  end loop;
end $$;

-- ════ B1: role vocabulary — owner/admin propose and decide; editor and viewer do neither ═════════════════════════════════════
set role authenticated;
select pg_temp.act('88000000-0000-4000-8000-0000000000f4');  -- viewer
do $$ begin assert pg_temp.propose('88000000-0000-4000-8000-00000000000a','88000000-0000-4000-8000-0000000000d1','88000000-0000-4000-8000-0000000000a1') = 'not_allowed',
  'B1 viewer must not propose'; end $$;
select pg_temp.act('88000000-0000-4000-8000-0000000000f3');  -- editor
do $$ begin assert pg_temp.propose('88000000-0000-4000-8000-00000000000a','88000000-0000-4000-8000-0000000000d1','88000000-0000-4000-8000-0000000000a1') = 'not_allowed',
  'B1 editor must not propose'; end $$;
do $$ begin assert pg_temp.ncount() = 0, 'B1 no row may exist yet'; end $$;

-- ════ B2: propose → proposed, carrying NO decision ════════════════════════════════════════════════════════════════════════════
select pg_temp.act('88000000-0000-4000-8000-0000000000f1');  -- owner
do $$ begin assert pg_temp.propose('88000000-0000-4000-8000-00000000000a','88000000-0000-4000-8000-0000000000d1','88000000-0000-4000-8000-0000000000a1') = 'proposed',
  'B2 owner may propose'; end $$;
do $$
declare r public.application_matches%rowtype;
begin
  r := pg_temp.mrow('88000000-0000-4000-8000-0000000000d1','88000000-0000-4000-8000-0000000000a1');
  assert r.status = 'proposed', 'B2 status must be proposed';
  assert r.decided_by is null and r.decided_at is null, 'B2 a proposal must carry no decision';
  assert r.method = 'exact_external_id' and r.confidence = 'high', 'B2 method/confidence must be recorded as given';
end $$;

-- Auto-accept is structurally impossible, not merely un-implemented: 0075's decided_chk refuses any row whose status is accepted
-- or rejected without a decided_at, so a propose path that tried to write 'accepted' would be rejected by the database itself.
-- Pinned here because that CHECK — not this suite — is what actually stops it.
do $$
begin
  assert exists (select 1 from pg_constraint where conname = 'application_matches_decided_chk'),
         'B2 the decided_chk that makes auto-accept impossible must exist (0075)';
  assert exists (select 1 from pg_constraint where conname = 'application_matches_dir_tenant_fk')
     and exists (select 1 from pg_constraint where conname = 'application_matches_app_tenant_fk'),
         'B2 the same-tenant composite FKs — the real cross-tenant backstop — must exist (0075)';
  assert exists (select 1 from pg_indexes where indexname = 'application_matches_one_accepted_dir_idx'),
         'B2 the one-accepted-per-directory-application index must exist (0075)';
  assert exists (select 1 from pg_indexes where indexname = 'application_matches_candidate_idx'),
         'B2 the candidate identity index this phase adds must exist (0088)';
end $$;

-- ════ B3: idempotency — re-proposing the same pair changes nothing ═══════════════════════════════════════════════════════════
do $$
declare n_before integer; n_after integer;
begin
  n_before := pg_temp.ncount();
  assert pg_temp.propose('88000000-0000-4000-8000-00000000000a','88000000-0000-4000-8000-0000000000d1','88000000-0000-4000-8000-0000000000a1') = 'already_proposed',
    'B3 re-proposing must be an idempotent no-op';
  -- a different METHOD for the same pair is the same candidate, not a second one
  assert pg_temp.propose('88000000-0000-4000-8000-00000000000a','88000000-0000-4000-8000-0000000000d1','88000000-0000-4000-8000-0000000000a1','vendor_catalog','low') = 'already_proposed',
    'B3 the same pair via another method is still one candidate';
  n_after := pg_temp.ncount();
  assert n_before = n_after, 'B3 no duplicate row may be created';
  assert (pg_temp.mrow('88000000-0000-4000-8000-0000000000d1','88000000-0000-4000-8000-0000000000a1')).confidence = 'high',
    'B3 an existing candidate must not be re-scored by a repeat proposal';
end $$;

-- ════ B4: AMBIGUITY — one directory application may carry several competing proposals ════════════════════════════════════════
do $$ begin
  assert pg_temp.propose('88000000-0000-4000-8000-00000000000a','88000000-0000-4000-8000-0000000000d1','88000000-0000-4000-8000-0000000000a2') = 'proposed',
    'B4 a second candidate for the same directory application must be representable';
  assert pg_temp.ncount('88000000-0000-4000-8000-0000000000d1', null, 'proposed') = 2,
    'B4 ambiguity is TWO live proposals — nothing auto-resolves it';
  assert pg_temp.ncount(null, null, 'accepted') = 0,
    'B4 ambiguity must not auto-accept anything';
end $$;

-- ════ B5: method / confidence vocabulary ═════════════════════════════════════════════════════════════════════════════════════
do $$ begin
  assert pg_temp.propose('88000000-0000-4000-8000-00000000000a','88000000-0000-4000-8000-0000000000d2','88000000-0000-4000-8000-0000000000a1','suggested','high') = 'invalid_method',
    'B5 `suggested` is not proposable — nothing produces it and it is the weak-evidence bucket';
  assert pg_temp.propose('88000000-0000-4000-8000-00000000000a','88000000-0000-4000-8000-0000000000d2','88000000-0000-4000-8000-0000000000a1','exact_domain','high') = 'invalid_method',
    'B5 `exact_domain` is not proposable — the directory side has no domain column';
  assert pg_temp.propose('88000000-0000-4000-8000-00000000000a','88000000-0000-4000-8000-0000000000d2','88000000-0000-4000-8000-0000000000a1','name','high') = 'invalid_method',
    'B5 a name method does not exist and must never be invented here';
  assert pg_temp.propose('88000000-0000-4000-8000-00000000000a','88000000-0000-4000-8000-0000000000d2','88000000-0000-4000-8000-0000000000a1','manual','certain') = 'invalid_confidence',
    'B5 confidence is bounded to high/medium/low';
  assert pg_temp.ncount('88000000-0000-4000-8000-0000000000d2') = 0,
    'B5 a refused proposal must write nothing';
end $$;

-- ════ B6: cross-tenant — source, target, tenant id and decision all refused ══════════════════════════════════════════════════
do $$ begin
  assert pg_temp.propose('88000000-0000-4000-8000-00000000000a','88000000-0000-4000-8000-0000000000e1','88000000-0000-4000-8000-0000000000a1') = 'not_allowed',
    'B6 a foreign directory application must be refused';
  assert pg_temp.propose('88000000-0000-4000-8000-00000000000a','88000000-0000-4000-8000-0000000000d2','88000000-0000-4000-8000-0000000000ab') = 'not_allowed',
    'B6 a foreign target app must be refused';
  assert pg_temp.propose('88000000-0000-4000-8000-00000000000b','88000000-0000-4000-8000-0000000000e1','88000000-0000-4000-8000-0000000000ab') = 'not_allowed',
    'B6 a caller-supplied foreign tenant must not grant authority';
  assert pg_temp.propose('88000000-0000-4000-8000-00000000000a','88000000-0000-4000-8000-0000000000d2','88000000-0000-4000-8000-00000000dead') = 'not_allowed',
    'B6 a guessed/nonexistent target must not disclose anything beyond not_allowed';
  assert pg_temp.ncount('88000000-0000-4000-8000-0000000000e1') = 0
     and pg_temp.ncount(null, '88000000-0000-4000-8000-0000000000ab') = 0,
    'B6 no cross-tenant row may exist';
end $$;

-- tenant B's owner may not decide tenant A's match
do $$
declare mid uuid := pg_temp.mid('88000000-0000-4000-8000-0000000000d1','88000000-0000-4000-8000-0000000000a1');
begin
  perform pg_temp.act('88000000-0000-4000-8000-0000000000f5');
  assert pg_temp.decide('88000000-0000-4000-8000-00000000000b', mid, 'accepted') = 'not_allowed',
    'B6 a foreign tenant must not decide this match';
  assert pg_temp.decide('88000000-0000-4000-8000-00000000000a', mid, 'accepted') = 'not_allowed',
    'B6 naming the OWNING tenant does not help a non-member either';
  assert pg_temp.mstatus(mid) = 'proposed', 'B6 the match must be untouched';
end $$;

-- ════ B7: decide — proposed → accepted, with the decider and clock from the database ═════════════════════════════════════════
select pg_temp.act('88000000-0000-4000-8000-0000000000f4');  -- viewer may not decide
do $$
declare mid uuid := pg_temp.mid('88000000-0000-4000-8000-0000000000d1','88000000-0000-4000-8000-0000000000a1');
begin
  assert pg_temp.decide('88000000-0000-4000-8000-00000000000a', mid, 'accepted') = 'not_allowed', 'B7 viewer must not decide';
end $$;
select pg_temp.act('88000000-0000-4000-8000-0000000000f2');  -- admin decides
do $$
declare mid uuid := pg_temp.mid('88000000-0000-4000-8000-0000000000d1','88000000-0000-4000-8000-0000000000a1');
begin
  assert pg_temp.decide('88000000-0000-4000-8000-00000000000a', mid, 'sideways') = 'invalid_decision', 'B7 the decision vocabulary is bounded';
  assert pg_temp.decide('88000000-0000-4000-8000-00000000000a', mid, 'accepted') = 'accepted', 'B7 admin may accept a proposal';
end $$;
do $$
declare r public.application_matches%rowtype;
begin
  r := pg_temp.mrow('88000000-0000-4000-8000-0000000000d1','88000000-0000-4000-8000-0000000000a1');
  assert r.status = 'accepted', 'B7 status must be accepted';
  assert r.decided_by = '88000000-0000-4000-8000-0000000000f2', 'B7 decided_by must be the acting admin, not a parameter';
  assert r.decided_at is not null, 'B7 decided_at must be set by the database';
end $$;

-- ════ B8: accepted cardinality — the competing proposal cannot also be accepted ══════════════════════════════════════════════
select pg_temp.act('88000000-0000-4000-8000-0000000000f1');
do $$
declare other uuid := pg_temp.mid('88000000-0000-4000-8000-0000000000d1','88000000-0000-4000-8000-0000000000a2');
begin
  assert pg_temp.decide('88000000-0000-4000-8000-00000000000a', other, 'accepted') = 'accepted_exists',
    'B8 a second accepted match for one directory application must be refused';
  assert pg_temp.ncount('88000000-0000-4000-8000-0000000000d1', null, 'accepted') = 1,
    'B8 exactly one accepted match may exist per directory application';
  -- the loser stays proposed and can still be rejected
  assert pg_temp.mstatus(other) = 'proposed', 'B8 the losing candidate stays proposed';
  assert pg_temp.decide('88000000-0000-4000-8000-00000000000a', other, 'rejected') = 'rejected', 'B8 it may be rejected instead';
end $$;

-- ════ B9: decided rows are immutable through this command ════════════════════════════════════════════════════════════════════
do $$
declare acc uuid := pg_temp.mid('88000000-0000-4000-8000-0000000000d1','88000000-0000-4000-8000-0000000000a1');
        rej uuid := pg_temp.mid('88000000-0000-4000-8000-0000000000d1','88000000-0000-4000-8000-0000000000a2');
begin
  assert pg_temp.decide('88000000-0000-4000-8000-00000000000a', acc, 'rejected') = 'already_decided', 'B9 an accepted match cannot be flipped';
  assert pg_temp.decide('88000000-0000-4000-8000-00000000000a', rej, 'accepted') = 'already_decided', 'B9 a rejected match cannot be flipped';
  assert pg_temp.mstatus(acc) = 'accepted', 'B9 the acceptance survives';
  assert pg_temp.mstatus(rej) = 'rejected', 'B9 the rejection survives';
end $$;

-- ════ B10: replay — a re-running matcher resurrects nothing and duplicates nothing ══════════════════════════════════════════
do $$
declare n integer;
begin
  n := pg_temp.ncount();
  assert pg_temp.propose('88000000-0000-4000-8000-00000000000a','88000000-0000-4000-8000-0000000000d1','88000000-0000-4000-8000-0000000000a2') = 'already_rejected',
    'B10 re-proposing a REJECTED candidate must report it, not resurrect it';
  assert pg_temp.propose('88000000-0000-4000-8000-00000000000a','88000000-0000-4000-8000-0000000000d1','88000000-0000-4000-8000-0000000000a1') = 'already_accepted',
    'B10 re-proposing an ACCEPTED candidate must not duplicate it';
  assert pg_temp.ncount() = n, 'B10 replay must add no rows';
  assert (pg_temp.mrow('88000000-0000-4000-8000-0000000000d1','88000000-0000-4000-8000-0000000000a2')).status = 'rejected', 'B10 the rejection still stands';
end $$;

-- ════ B11: many-to-one is legitimate — a second directory application may accept the SAME app ═══════════════════════════════
do $$
declare mid uuid;
begin
  assert pg_temp.propose('88000000-0000-4000-8000-00000000000a','88000000-0000-4000-8000-0000000000d2','88000000-0000-4000-8000-0000000000a1','manual','high') = 'proposed',
    'B11 a different directory application is a different candidate';
  mid := pg_temp.mid('88000000-0000-4000-8000-0000000000d2','88000000-0000-4000-8000-0000000000a1');
  assert pg_temp.decide('88000000-0000-4000-8000-00000000000a', mid, 'accepted') = 'accepted',
    'B11 two directory applications may both accept one apps row (0075 is deliberately not unique on the SaaS side)';
  assert pg_temp.ncount(null, '88000000-0000-4000-8000-0000000000a1', 'accepted') = 2, 'B11 many-to-one holds';
end $$;

-- ════ B12: Rule 5 compatibility — only ACCEPTED rows are governance truth ════════════════════════════════════════════════════
-- 0085's bounded read is the contract Rule 5 consumes. Proposed and rejected rows must be visible to it as non-accepted; nothing
-- here changes its shape or turns a proposal into a managed application.
do $$
declare n_accepted integer; n_other integer;
begin
  select count(*) filter (where status = 'accepted'), count(*) filter (where status <> 'accepted')
    into n_accepted, n_other
    from public.product_application_matches('88000000-0000-4000-8000-00000000000a');
  assert n_accepted = 2, 'B12 exactly the accepted rows are accepted';
  assert n_other >= 1, 'B12 proposed/rejected rows remain visible as NOT accepted';
  -- and 0085's read contract is UNCHANGED — four bounded columns, no method/confidence/rationale/decider leakage. This phase
  -- adds no second read path, so anything Rule 5 consumes it still consumes in exactly the same shape.
  assert pg_get_function_result('public.product_application_matches(uuid,uuid,integer)'::regprocedure)
         = 'TABLE(id uuid, directory_application_id uuid, app_id uuid, status text)',
         'B12 the 0085 read contract must not have widened';
  -- The whole product surface over application matching, named rather than counted, so an accidental extra path is visible.
  assert (select array_agg(p.proname::text order by p.proname) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.proname like 'product_%application_match%')
         = array['product_application_matcher_state','product_application_matches','product_complete_application_matcher_run',
                 'product_decide_application_match','product_fail_application_matcher_run','product_propose_application_match',
                 'product_start_application_matcher_run'],
         'B12 the product application-match surface is 0085 (read + state + start/complete/fail) plus exactly 0088 propose/decide';
end $$;

-- ════ B13: matcher execution state stays decoupled from human decisions ═════════════════════════════════════════════════════
do $$ begin
  -- 0085's state RPC always returns exactly one row; `has_ever_run` is how absence is expressed. After a full propose/accept/
  -- reject cycle it must still say the matcher has never run: human decisions and matcher execution are separate facts.
  assert (select has_ever_run from public.product_application_matcher_state('88000000-0000-4000-8000-00000000000a')) = false,
    'B13 proposing and deciding must not create or advance matcher run state — they are separate facts';
end $$;

-- ════ B14: the 0 / 1 / MANY operational-instance test — the decisive architecture question ══════════════════════════════════
-- `application_matches` is an INSTANCE relationship, not a product-level one. 0075 says so outright: `apps` is "what do we pay
-- for, and under what contract", and "a directory application with NO SaaS record is not an error (nobody has recorded a
-- contract)". Phase 18B0 (#420) makes the product layer real — apps.canonical_app_id now has a writer — so the chain
--
--     directory_application.external_id → confirmed alias → app_product → apps WHERE canonical_app_id = product → app_id
--
-- is deterministic at last. What it CANNOT do is choose between instances, and that is the property proven here.
reset role;
insert into public.app_products (id, tenant_id, name, normalized_name) values
  ('88000000-0000-4000-8000-0000000000e5', '88000000-0000-4000-8000-00000000000a', 'Salesforce', 'salesforce'),
  ('88000000-0000-4000-8000-0000000000e6', '88000000-0000-4000-8000-00000000000a', 'Jira',       'jira');
-- MANY: two operational instances of one canonical product. ZERO: Jira is a known product with no instance at all.
update public.apps set canonical_app_id = '88000000-0000-4000-8000-0000000000e5'
 where id in ('88000000-0000-4000-8000-0000000000a1','88000000-0000-4000-8000-0000000000a2');

do $$
declare n_for_product integer; n_for_jira integer;
begin
  select count(*) into n_for_product from public.apps where canonical_app_id = '88000000-0000-4000-8000-0000000000e5';
  select count(*) into n_for_jira    from public.apps where canonical_app_id = '88000000-0000-4000-8000-0000000000e6';

  -- CASE MANY: the product resolves to two instances. Evidence proves the PRODUCT; it cannot distinguish Prod from Sandbox.
  assert n_for_product = 2, 'B14 the many-instance case must be representable';
  -- Both candidates already exist as rows from B4/B8 — one accepted, one rejected — proving the boundary let a human choose
  -- between them rather than the model picking. Neither confidence nor arrival order selected a winner.
  assert pg_temp.ncount('88000000-0000-4000-8000-0000000000d1', null, 'accepted') = 1
     and pg_temp.ncount('88000000-0000-4000-8000-0000000000d1', null, 'rejected') = 1,
     'B14 MANY: a human resolved the ambiguity — exactly one accepted, the other rejected, none auto-picked';

  -- CASE ZERO: a confirmed canonical product with no operational instance. There is no app_id to propose, and per 0075 that is
  -- explicitly NOT an error — it means nobody has recorded a contract for it yet. The product-level truth still lives in
  -- app_products/app_aliases; application_matches simply has nothing to say.
  assert n_for_jira = 0, 'B14 ZERO: a known product may legitimately have no operational instance';
end $$;

-- CASE ONE is the ordinary path and is already covered end to end by B2 (propose) and B7 (accept).

reset role;
select set_config('request.jwt.claims', '', false);
