-- application_match_candidate_contract_test.sql — migration 0090.
--
-- Two contracts under test. The METHOD DOMAIN must admit `canonical_product` without loosening anything else, and the
-- CANDIDATE READ must hand a future matcher facts it can act on without ever disclosing the identifier it joined on.
--
-- The load-bearing case is E-series: paging bounds PARENTS, never the exploded join. A many-instance group split across a
-- page boundary would let a matcher propose half an ambiguity and call the run complete — deciding by truncation.
--
-- Seeds its own e0……… id space and truncates nothing.

\set ON_ERROR_STOP on
reset role;

insert into auth.users (id, email) values
  ('e0000000-0000-4000-8000-0000000000f1','cc_owner@t1.test'),
  ('e0000000-0000-4000-8000-0000000000f2','cc_admin@t1.test'),
  ('e0000000-0000-4000-8000-0000000000f3','cc_editor@t1.test'),
  ('e0000000-0000-4000-8000-0000000000f4','cc_viewer@t1.test'),
  ('e0000000-0000-4000-8000-0000000000f9','cc_owner@t2.test');
insert into public.profiles (id, email) select id, email from auth.users where id::text like 'e0000000-%';
insert into public.tenants (id, name, slug) values
  ('e0000000-0000-4000-8000-00000000000a','CC T1','cc-t1'),
  ('e0000000-0000-4000-8000-00000000000b','CC T2','cc-t2');
insert into public.tenant_memberships (tenant_id, user_id, role, status) values
  ('e0000000-0000-4000-8000-00000000000a','e0000000-0000-4000-8000-0000000000f1','owner','active'),
  ('e0000000-0000-4000-8000-00000000000a','e0000000-0000-4000-8000-0000000000f2','admin','active'),
  ('e0000000-0000-4000-8000-00000000000a','e0000000-0000-4000-8000-0000000000f3','editor','active'),
  ('e0000000-0000-4000-8000-00000000000a','e0000000-0000-4000-8000-0000000000f4','viewer','active'),
  ('e0000000-0000-4000-8000-00000000000b','e0000000-0000-4000-8000-0000000000f9','owner','active');

-- Connectors: c1 healthy, c8 superseded, c9 disconnected. T2 gets its own.
insert into public.connectors (id, tenant_id, provider, status, connection_state) values
  ('e0000000-0000-4000-8000-0000000000c1','e0000000-0000-4000-8000-00000000000a','okta','pending','discovered'),
  ('e0000000-0000-4000-8000-0000000000c8','e0000000-0000-4000-8000-00000000000a','okta','pending','discovered'),
  ('e0000000-0000-4000-8000-0000000000c9','e0000000-0000-4000-8000-00000000000a','okta','pending','discovered'),
  ('e0000000-0000-4000-8000-0000000000c2','e0000000-0000-4000-8000-00000000000b','okta','pending','discovered');
update public.connectors set superseded_by = 'e0000000-0000-4000-8000-0000000000c1', superseded_at = now(), superseded_reason = 'test'
 where id = 'e0000000-0000-4000-8000-0000000000c8';
update public.connectors set disconnected_at = now(), disconnected_reason = 'test'
 where id = 'e0000000-0000-4000-8000-0000000000c9';

-- Products: MANY owns two instances, ONE owns one, ZERO owns none.
insert into public.app_products (id, tenant_id, name, normalized_name) values
  ('e0000000-0000-4000-8000-0000000000b1','e0000000-0000-4000-8000-00000000000a','Salesforce','salesforce'),
  ('e0000000-0000-4000-8000-0000000000b2','e0000000-0000-4000-8000-00000000000a','Jira','jira'),
  ('e0000000-0000-4000-8000-0000000000b3','e0000000-0000-4000-8000-00000000000a','Notion','notion'),
  ('e0000000-0000-4000-8000-0000000000b9','e0000000-0000-4000-8000-00000000000b','Foreign','foreign');
insert into public.apps (id, tenant_id, name, canonical_app_id) values
  ('e0000000-0000-4000-8000-0000000000a1','e0000000-0000-4000-8000-00000000000a','SFDC Prod',    'e0000000-0000-4000-8000-0000000000b1'),
  ('e0000000-0000-4000-8000-0000000000a2','e0000000-0000-4000-8000-00000000000a','SFDC Sandbox', 'e0000000-0000-4000-8000-0000000000b1'),
  ('e0000000-0000-4000-8000-0000000000a3','e0000000-0000-4000-8000-00000000000a','Jira Cloud',   'e0000000-0000-4000-8000-0000000000b2'),
  ('e0000000-0000-4000-8000-0000000000a9','e0000000-0000-4000-8000-00000000000b','Foreign app',  'e0000000-0000-4000-8000-0000000000b9');

-- Directory applications. d1 -> MANY, d2 -> ONE, d3 -> ZERO; then the ineligible ones.
insert into public.directory_applications (id, tenant_id, connection_id, provider, external_id, label, sync_status) values
  ('e0000000-0000-4000-8000-0000000000d1','e0000000-0000-4000-8000-00000000000a','e0000000-0000-4000-8000-0000000000c1','okta','0oaMANY0001','Salesforce','current'),
  ('e0000000-0000-4000-8000-0000000000d2','e0000000-0000-4000-8000-00000000000a','e0000000-0000-4000-8000-0000000000c1','okta','0oaONE00002','Jira','current'),
  ('e0000000-0000-4000-8000-0000000000d3','e0000000-0000-4000-8000-00000000000a','e0000000-0000-4000-8000-0000000000c1','okta','0oaZERO0003','Notion','current'),
  ('e0000000-0000-4000-8000-0000000000d4','e0000000-0000-4000-8000-00000000000a','e0000000-0000-4000-8000-0000000000c1','okta','0oaPEND0004','Pending','current'),
  ('e0000000-0000-4000-8000-0000000000d5','e0000000-0000-4000-8000-00000000000a','e0000000-0000-4000-8000-0000000000c1','okta','0oaREJ00005','Rejected','current'),
  ('e0000000-0000-4000-8000-0000000000d6','e0000000-0000-4000-8000-00000000000a','e0000000-0000-4000-8000-0000000000c1','okta','0oaAUTO0006','Auto','current'),
  ('e0000000-0000-4000-8000-0000000000d7','e0000000-0000-4000-8000-00000000000a','e0000000-0000-4000-8000-0000000000c1','okta','0oaNAME0007','NameAlias','current'),
  ('e0000000-0000-4000-8000-0000000000d8','e0000000-0000-4000-8000-00000000000a','e0000000-0000-4000-8000-0000000000c1','okta','0oaSTALE008','Stale','stale'),
  ('e0000000-0000-4000-8000-0000000000da','e0000000-0000-4000-8000-00000000000a','e0000000-0000-4000-8000-0000000000c1','okta','0oaREVRQ009','ReviewReq','review_required'),
  ('e0000000-0000-4000-8000-0000000000db','e0000000-0000-4000-8000-00000000000a','e0000000-0000-4000-8000-0000000000c8','okta','0oaSUPER010','Superseded','current'),
  ('e0000000-0000-4000-8000-0000000000dc','e0000000-0000-4000-8000-00000000000a','e0000000-0000-4000-8000-0000000000c9','okta','0oaDISC0011','Disconnected','current'),
  ('e0000000-0000-4000-8000-0000000000d9','e0000000-0000-4000-8000-00000000000b','e0000000-0000-4000-8000-0000000000c2','okta','0oaFOREIGN1','Foreign','current');

-- Aliases: confirmed for the eligible ones; pending/rejected/auto/name for the ineligible ones.
insert into public.app_aliases (tenant_id, app_product_id, alias_type, alias_value, source, confidence, review_status) values
  ('e0000000-0000-4000-8000-00000000000a','e0000000-0000-4000-8000-0000000000b1','provider_app_id','0oaMANY0001','product_declaration',100,'confirmed'),
  ('e0000000-0000-4000-8000-00000000000a','e0000000-0000-4000-8000-0000000000b2','provider_app_id','0oaONE00002','product_declaration',100,'confirmed'),
  ('e0000000-0000-4000-8000-00000000000a','e0000000-0000-4000-8000-0000000000b3','provider_app_id','0oaZERO0003','product_declaration',100,'confirmed'),
  ('e0000000-0000-4000-8000-00000000000a','e0000000-0000-4000-8000-0000000000b1','provider_app_id','0oaPEND0004','product_declaration',100,'pending'),
  ('e0000000-0000-4000-8000-00000000000a','e0000000-0000-4000-8000-0000000000b1','provider_app_id','0oaREJ00005','product_declaration',100,'rejected'),
  ('e0000000-0000-4000-8000-00000000000a','e0000000-0000-4000-8000-0000000000b1','provider_app_id','0oaAUTO0006','product_declaration',100,'auto'),
  ('e0000000-0000-4000-8000-00000000000a','e0000000-0000-4000-8000-0000000000b1','name',           '0oaNAME0007','product_declaration',100,'confirmed'),
  ('e0000000-0000-4000-8000-00000000000a','e0000000-0000-4000-8000-0000000000b1','provider_app_id','0oaSTALE008','product_declaration',100,'confirmed'),
  ('e0000000-0000-4000-8000-00000000000a','e0000000-0000-4000-8000-0000000000b1','provider_app_id','0oaREVRQ009','product_declaration',100,'confirmed'),
  ('e0000000-0000-4000-8000-00000000000a','e0000000-0000-4000-8000-0000000000b1','provider_app_id','0oaSUPER010','product_declaration',100,'confirmed'),
  ('e0000000-0000-4000-8000-00000000000a','e0000000-0000-4000-8000-0000000000b1','provider_app_id','0oaDISC0011','product_declaration',100,'confirmed'),
  ('e0000000-0000-4000-8000-00000000000b','e0000000-0000-4000-8000-0000000000b9','provider_app_id','0oaFOREIGN1','product_declaration',100,'confirmed');

create or replace function pg_temp.act(p_user uuid) returns void language plpgsql as $$
begin perform set_config('request.jwt.claims', json_build_object('sub', p_user)::text, false); end $$;
create or replace function pg_temp.cand(p_tenant uuid, p_after uuid default null, p_limit integer default 200)
  returns table (directory_application_id uuid, app_product_id uuid, app_id uuid) language sql as $$
  select c.directory_application_id, c.app_product_id, c.app_id
    from public.product_application_match_candidates(p_tenant, p_after, p_limit) c;
$$;

-- ════ A: ACL / shape posture ════════════════════════════════════════════════════════════════════════════════════════
do $$
declare oid_ oid := to_regprocedure('public.product_application_match_candidates(uuid,uuid,integer)');
begin
  assert oid_ is not null, 'A0 the function must exist';
  assert (select prosecdef from pg_proc where oid = oid_), 'A0 must be SECURITY DEFINER';
  assert (select array_to_string(proconfig, ',') from pg_proc where oid = oid_) like '%search_path=public%',
    'A0 search_path must be pinned';
  assert not has_function_privilege('public',        oid_, 'execute'), 'A0 PUBLIC must NOT hold EXECUTE';
  assert not has_function_privilege('anon',          oid_, 'execute'), 'A0 anon must NOT hold EXECUTE';
  assert not has_function_privilege('connector_runner', oid_, 'execute'), 'A0 connector_runner must NOT hold EXECUTE';
  assert has_function_privilege('authenticated',     oid_, 'execute'), 'A0 authenticated must hold EXECUTE';
  -- The disclosure surface is exactly three ids.
  assert (select count(*) from unnest(string_to_array(pg_get_function_result(oid_), ',')) x
           where x ilike '%external_id%' or x ilike '%alias_value%' or x ilike '%label%' or x ilike '%name%') = 0,
    'A0 the return shape must disclose no identifier or label';
  -- directory_applications stays deny-all.
  assert not has_table_privilege('authenticated', 'public.directory_applications', 'SELECT'),
    'A0 no directory_applications table grant may be added';
  assert (select count(*) from pg_policy p join pg_class c on c.oid = p.polrelid
           where c.relname = 'directory_applications') = 0,
    'A0 directory_applications must still have NO policy';
  -- The method domain, asserted on the CONSTRAINT DEFINITION and BEFORE any write. Proving it only by inserting would
  -- surface a raw check_violation naming Postgres's constraint rather than the invariant that broke.
  assert (select pg_get_constraintdef(oid) from pg_constraint where conname = 'application_matches_method_chk')
         like '%canonical_product%',
    'A0 the method CHECK must admit canonical_product';
end $$;

-- ════ B: authority, on REAL memberships ═════════════════════════════════════════════════════════════════════════════
set role authenticated;
select pg_temp.act('e0000000-0000-4000-8000-0000000000f1');
do $$ declare n int; begin
  select count(*) into n from pg_temp.cand('e0000000-0000-4000-8000-00000000000a');
  assert n > 0, format('B1 an OWNER must read candidates, got %s', n);
end $$;
select pg_temp.act('e0000000-0000-4000-8000-0000000000f2');
do $$ declare n int; begin
  select count(*) into n from pg_temp.cand('e0000000-0000-4000-8000-00000000000a');
  assert n > 0, format('B2 an ADMIN must read candidates, got %s', n);
end $$;
select pg_temp.act('e0000000-0000-4000-8000-0000000000f3');
do $$ declare n int; begin
  select count(*) into n from pg_temp.cand('e0000000-0000-4000-8000-00000000000a');
  assert n = 0, format('B3 ROLE LEAK: a tenant EDITOR read %s candidate rows', n);
end $$;
select pg_temp.act('e0000000-0000-4000-8000-0000000000f4');
do $$ declare n int; begin
  select count(*) into n from pg_temp.cand('e0000000-0000-4000-8000-00000000000a');
  assert n = 0, format('B4 ROLE LEAK: a tenant VIEWER read %s candidate rows', n);
end $$;
select pg_temp.act('e0000000-0000-4000-8000-0000000000f9');
do $$ declare n int; begin
  select count(*) into n from pg_temp.cand('e0000000-0000-4000-8000-00000000000a');
  assert n = 0, format('B5 CROSS-TENANT: tenant 2 owner read %s of tenant 1 candidates', n);
  select count(*) into n from pg_temp.cand('e0000000-0000-4000-8000-00000000000b');
  assert n = 1, format('B5 tenant 2 must see exactly its own one candidate, got %s', n);
end $$;
reset role;

-- ════ C: zero / one / many, and what may NOT bridge ═════════════════════════════════════════════════════════════════
set role authenticated;
select pg_temp.act('e0000000-0000-4000-8000-0000000000f1');
do $$
declare n int; v_prod uuid; v_app uuid;
begin
  -- MANY: both instances, neither chosen.
  select count(*) into n from pg_temp.cand('e0000000-0000-4000-8000-00000000000a')
   where directory_application_id = 'e0000000-0000-4000-8000-0000000000d1';
  assert n = 2, format('C1 a product with two instances must yield TWO candidate rows, got %s', n);
  assert (select count(*) from pg_temp.cand('e0000000-0000-4000-8000-00000000000a')
           where directory_application_id = 'e0000000-0000-4000-8000-0000000000d1' and app_id is null) = 0,
    'C1 a many-instance parent must not also emit a NULL row';

  -- ONE.
  select count(*) into n from pg_temp.cand('e0000000-0000-4000-8000-00000000000a')
   where directory_application_id = 'e0000000-0000-4000-8000-0000000000d2';
  select app_product_id, app_id into v_prod, v_app
    from pg_temp.cand('e0000000-0000-4000-8000-00000000000a')
   where directory_application_id = 'e0000000-0000-4000-8000-0000000000d2';
  assert n = 1, format('C2 a single-instance product must yield ONE row, got %s', n);
  assert v_prod = 'e0000000-0000-4000-8000-0000000000b2' and v_app = 'e0000000-0000-4000-8000-0000000000a3',
    'C2 the concrete instance must be returned';

  -- ZERO: resolved product, no instance, app_id NULL. NOT the absence of a row.
  select count(*) into n from pg_temp.cand('e0000000-0000-4000-8000-00000000000a')
   where directory_application_id = 'e0000000-0000-4000-8000-0000000000d3' and app_id is null;
  assert n = 1, format('C3 a resolved product with zero instances must yield ONE NULL-instance row, got %s', n);
  assert (select app_product_id from pg_temp.cand('e0000000-0000-4000-8000-00000000000a')
           where directory_application_id = 'e0000000-0000-4000-8000-0000000000d3')
         = 'e0000000-0000-4000-8000-0000000000b3',
    'C3 PRODUCT RESOLVED, ZERO INSTANCES — the product must still be reported';

  -- Nothing unsettled may bridge.
  for n in select 1 loop end loop;
  assert (select count(*) from pg_temp.cand('e0000000-0000-4000-8000-00000000000a')
           where directory_application_id in ('e0000000-0000-4000-8000-0000000000d4','e0000000-0000-4000-8000-0000000000d5',
                                              'e0000000-0000-4000-8000-0000000000d6','e0000000-0000-4000-8000-0000000000d7')) = 0,
    'C4 pending / rejected / auto / name aliases must never bridge';

  -- Ineligible source rows.
  assert (select count(*) from pg_temp.cand('e0000000-0000-4000-8000-00000000000a')
           where directory_application_id in ('e0000000-0000-4000-8000-0000000000d8','e0000000-0000-4000-8000-0000000000da',
                                              'e0000000-0000-4000-8000-0000000000db','e0000000-0000-4000-8000-0000000000dc')) = 0,
    'C5 stale / review_required / superseded / disconnected sources must not produce candidates';

  -- Cross-tenant bridging is impossible in every direction.
  assert (select count(*) from pg_temp.cand('e0000000-0000-4000-8000-00000000000a')
           where app_product_id = 'e0000000-0000-4000-8000-0000000000b9'
              or app_id = 'e0000000-0000-4000-8000-0000000000a9') = 0,
    'C6 CROSS-TENANT: a foreign product or app must never appear';
end $$;

-- ════ D: disclosure — the identifier that was joined on never comes back ════════════════════════════════════════════
do $$
declare blob text;
begin
  select coalesce(string_agg(directory_application_id::text || app_product_id::text || coalesce(app_id::text, ''), '|'), '')
    into blob from pg_temp.cand('e0000000-0000-4000-8000-00000000000a');
  assert blob not like '%0oa%', 'D1 no provider external_id may appear anywhere in the result';
  assert blob not like '%Salesforce%' and blob not like '%SFDC%' and blob not like '%Jira%',
    'D1 no label or name may appear anywhere in the result';
end $$;
reset role;

-- ════ E: PARENT-FIRST PAGING — the load-bearing contract ════════════════════════════════════════════════════════════
set role authenticated;
select pg_temp.act('e0000000-0000-4000-8000-0000000000f1');
do $$
declare n int; last_parent uuid; parents int;
begin
  -- Three eligible parents (d1 many, d2 one, d3 zero) -> 4 rows total.
  select count(distinct directory_application_id), count(*) into parents, n
    from pg_temp.cand('e0000000-0000-4000-8000-00000000000a');
  assert parents = 3, format('E1 exactly three parents are eligible, got %s', parents);
  assert n = 4, format('E1 the complete candidate set is four rows, got %s', n);

  -- A ONE-PARENT page must still return d1's COMPLETE group of two. The limit bounds parents, not rows.
  select count(*) into n from pg_temp.cand('e0000000-0000-4000-8000-00000000000a', null, 1);
  assert n = 2, format('E2 a one-parent page must return the WHOLE many-instance group, got %s rows', n);
  assert (select count(distinct directory_application_id) from pg_temp.cand('e0000000-0000-4000-8000-00000000000a', null, 1)) = 1,
    'E2 a one-parent page must contain exactly one parent';

  -- Walk it a parent at a time: no split group, no duplicate, no skip.
  last_parent := null; parents := 0; n := 0;
  loop
    declare page_rows int; page_last uuid;
    begin
      select count(*) into page_rows from pg_temp.cand('e0000000-0000-4000-8000-00000000000a', last_parent, 1);
      select directory_application_id into page_last
        from pg_temp.cand('e0000000-0000-4000-8000-00000000000a', last_parent, 1)
       order by directory_application_id desc limit 1;
      exit when page_rows = 0;
      parents := parents + 1; n := n + page_rows; last_parent := page_last;
      assert parents <= 10, 'E3 the walk must terminate';
    end;
  end loop;
  assert parents = 3, format('E3 the walk must visit three parents, got %s', parents);
  assert n = 4, format('E3 the walk must see every candidate exactly once, got %s', n);
end $$;

-- ════ F: a page of ONLY zero-instance parents still advances ════════════════════════════════════════════════════════
-- The NULL-instance row is what carries the cursor. Without it such a page would return nothing and the walk would stall
-- on a parent it had already passed.
do $$
declare page_last uuid; n int;
begin
  select directory_application_id into page_last
    from pg_temp.cand('e0000000-0000-4000-8000-00000000000a', 'e0000000-0000-4000-8000-0000000000d2', 1)
   order by directory_application_id desc limit 1;
  assert page_last = 'e0000000-0000-4000-8000-0000000000d3',
    'F1 the zero-instance parent must appear and be able to advance the cursor';
  select count(*) into n from pg_temp.cand('e0000000-0000-4000-8000-00000000000a', page_last, 1);
  assert n = 0, format('F1 the walk must terminate after the last parent, got %s', n);
end $$;

-- ════ F2: a resolved parent ABOVE a long unresolved run ════════════════════════════════════════════════════════════
-- The feed's parents are RESOLVED applications only, so the walk must step straight over an arbitrarily long block of
-- unresolved ids to reach the next resolved one. Without this case the fixture only ever proved the easy shape, where
-- every resolved parent sorts below every unresolved one.
reset role;
insert into public.directory_applications (id, tenant_id, connection_id, provider, external_id, label, sync_status) values
  ('e0000000-0000-4000-8000-0000000000df','e0000000-0000-4000-8000-00000000000a','e0000000-0000-4000-8000-0000000000c1',
   'okta','0oaTAIL0099','Tail','current');
insert into public.app_aliases (tenant_id, app_product_id, alias_type, alias_value, source, confidence, review_status) values
  ('e0000000-0000-4000-8000-00000000000a','e0000000-0000-4000-8000-0000000000b2','provider_app_id','0oaTAIL0099','product_declaration',100,'confirmed');
set role authenticated;
select pg_temp.act('e0000000-0000-4000-8000-0000000000f1');
do $$
declare v uuid; n int;
begin
  -- Cursor parked on d3, the last resolved id below the unresolved block d4..dc. The next page must be `df`.
  select directory_application_id into v
    from pg_temp.cand('e0000000-0000-4000-8000-00000000000a', 'e0000000-0000-4000-8000-0000000000d3', 1)
   order by directory_application_id desc limit 1;
  assert v = 'e0000000-0000-4000-8000-0000000000df',
    format('F2 the walk must step over the whole unresolved run and land on the next RESOLVED parent, got %s', v);
  select count(*) into n from pg_temp.cand('e0000000-0000-4000-8000-00000000000a', v, 1);
  assert n = 0, format('F2 the unresolved tail must terminate the walk, got %s', n);

  -- And the complement is NOT knowable from this feed: four parents now, but twelve current applications exist.
  select count(distinct directory_application_id) into n from pg_temp.cand('e0000000-0000-4000-8000-00000000000a');
  assert n = 4, format('F2 the feed reports only RESOLVED applications, got %s', n);
end $$;
reset role;
set role authenticated;
select pg_temp.act('e0000000-0000-4000-8000-0000000000f1');

-- ════ G: ordering is a total order the caller can cursor on ═════════════════════════════════════════════════════════
do $$
declare prev uuid := null; r record; ok boolean := true;
begin
  for r in select directory_application_id from pg_temp.cand('e0000000-0000-4000-8000-00000000000a') loop
    if prev is not null and r.directory_application_id < prev then ok := false; end if;
    prev := r.directory_application_id;
  end loop;
  assert ok, 'G1 rows must arrive in ascending parent order so the last row is a safe cursor';
end $$;

-- ════ H: limit clamping ═════════════════════════════════════════════════════════════════════════════════════════════
do $$ begin
  assert (select count(distinct directory_application_id) from pg_temp.cand('e0000000-0000-4000-8000-00000000000a', null, 0)) = 1,
    'H1 a zero limit clamps to one parent';
  assert (select count(distinct directory_application_id) from pg_temp.cand('e0000000-0000-4000-8000-00000000000a', null, -5)) = 1,
    'H1 a negative limit clamps to one parent';
  assert (select count(distinct directory_application_id) from pg_temp.cand('e0000000-0000-4000-8000-00000000000a', null, 9999)) = 4,
    'H1 an oversized limit returns only what exists (four resolved parents after F2)';
end $$;
reset role;

-- ════ J: METHOD DOMAIN ══════════════════════════════════════════════════════════════════════════════════════════════
insert into public.application_matches (tenant_id, directory_application_id, app_id, method, confidence, status) values
  ('e0000000-0000-4000-8000-00000000000a','e0000000-0000-4000-8000-0000000000d1','e0000000-0000-4000-8000-0000000000a1',
   'canonical_product','low','proposed');
do $$
declare ok boolean := false;
begin
  assert (select count(*) from public.application_matches where method = 'canonical_product') = 1,
    'J1 canonical_product must be an accepted method';
  -- every pre-existing value still accepted
  insert into public.application_matches (tenant_id, directory_application_id, app_id, method, confidence, status) values
    ('e0000000-0000-4000-8000-00000000000a','e0000000-0000-4000-8000-0000000000d2','e0000000-0000-4000-8000-0000000000a3',
     'manual','high','proposed');
  assert (select count(*) from public.application_matches where method = 'manual') = 1,
    'J2 existing method values must remain accepted';
  begin
    insert into public.application_matches (tenant_id, directory_application_id, app_id, method, confidence, status) values
      ('e0000000-0000-4000-8000-00000000000a','e0000000-0000-4000-8000-0000000000d3','e0000000-0000-4000-8000-0000000000a1',
       'guessed','high','proposed');
  exception when check_violation then ok := true; end;
  assert ok, 'J3 an unknown method must still be refused';
end $$;

-- The propose command must admit the new literal, or it would be legal in the table and unreachable through the writer.
set role authenticated;
select pg_temp.act('e0000000-0000-4000-8000-0000000000f1');
do $$
declare s text;
begin
  s := public.product_propose_application_match(
         'e0000000-0000-4000-8000-00000000000a','e0000000-0000-4000-8000-0000000000d3',
         'e0000000-0000-4000-8000-0000000000a2','canonical_product','low') ->> 'status';
  assert s = 'proposed', format('J4 propose must admit canonical_product, got %s', s);
  s := public.product_propose_application_match(
         'e0000000-0000-4000-8000-00000000000a','e0000000-0000-4000-8000-0000000000d3',
         'e0000000-0000-4000-8000-0000000000a1','suggested','low') ->> 'status';
  assert s = 'invalid_method', format('J5 propose must still refuse suggested, got %s', s);
end $$;
reset role;

-- ════ CLEANUP ═══════════════════════════════════════════════════════════════════════════════════════════════════════
-- The J-series wrote real rows to prove the method domain. `application_matches` is a shared table and the 0088 suite
-- asserts a GLOBAL `ncount() = 0` before it proposes anything, so this file removes exactly what it added rather than
-- leaving a neighbouring suite to discover it. Scoped to this file's own tenant.
reset role;
delete from public.application_matches where tenant_id = 'e0000000-0000-4000-8000-00000000000a';
