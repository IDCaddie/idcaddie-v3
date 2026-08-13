-- 0088 + 0090 — the governed propose/decide boundary over application_matches.
--
-- The property this suite exists to protect: **a proposal can never become truth by itself.** Only a human accept produces a
-- canonical relationship, only one per directory application, and a rejected candidate stays rejected however many times a
-- matcher re-runs. Everything else here — role vocabulary, tenant scoping, immutability — serves that.
--
-- ADAPTED BY 0090. 0088 authored this suite against `app_id`, the operational instance, because `apps.canonical_app_id` had no
-- writer when it was written. #420 gave it one, and 0090 moved the relationship to the canonical PRODUCT with the instance as an
-- optional refinement. Every propose call and every candidate lookup therefore keys on `app_product_id` now. The lifecycle
-- properties 0088 established are unchanged and are still asserted here block-for-block; what changed is WHAT a candidate is.
-- B14 is the one block whose MEANING changed, and it says so where it stands. B15–B18 are new: the refinement invariant, and the
-- compatibility closure over 0088's replaced objects.

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

-- The canonical side: `app_products` is what a match now relates to (0024's "CANONICAL app/product", 0090's authority).
insert into public.app_products (id, tenant_id, name, normalized_name) values
  ('88000000-0000-4000-8000-0000000000b1', '88000000-0000-4000-8000-00000000000a', 'Salesforce',    'salesforce'),
  ('88000000-0000-4000-8000-0000000000b2', '88000000-0000-4000-8000-00000000000a', 'Workday',       'workday'),
  ('88000000-0000-4000-8000-0000000000bb', '88000000-0000-4000-8000-00000000000b', 'Foreign prod',  'foreign-prod');

-- The operational side: `apps` instances, each declaring the product it is an instance OF (#420 writes `canonical_app_id`).
-- a1/a2 are TWO instances of ONE product — the shape that makes product-level candidate identity load-bearing. a9 is deliberately
-- un-canonicalized: an instance whose own product is unknown, which B17 proves cannot refine anything.
insert into public.apps (id, tenant_id, name, canonical_app_id) values
  ('88000000-0000-4000-8000-0000000000a1', '88000000-0000-4000-8000-00000000000a', 'Salesforce Prod',    '88000000-0000-4000-8000-0000000000b1'),
  ('88000000-0000-4000-8000-0000000000a2', '88000000-0000-4000-8000-00000000000a', 'Salesforce Sandbox', '88000000-0000-4000-8000-0000000000b1'),
  ('88000000-0000-4000-8000-0000000000a3', '88000000-0000-4000-8000-00000000000a', 'Workday Prod',       '88000000-0000-4000-8000-0000000000b2'),
  ('88000000-0000-4000-8000-0000000000a9', '88000000-0000-4000-8000-00000000000a', 'Unmapped app',       null),
  ('88000000-0000-4000-8000-0000000000ab', '88000000-0000-4000-8000-00000000000b', 'Foreign app',        '88000000-0000-4000-8000-0000000000bb');

create or replace function pg_temp.act(p_user uuid) returns void language plpgsql as $$
begin perform set_config('request.jwt.claims', json_build_object('sub', p_user)::text, false); end $$;

-- `p_app` last, mirroring the RPC: the required endpoint is the PRODUCT and the instance is an optional trailing refinement.
create or replace function pg_temp.propose(
  p_tenant uuid, p_dir uuid, p_product uuid,
  p_method text default 'exact_external_id', p_conf text default 'high', p_app uuid default null)
  returns text language sql as $$
  select public.product_propose_application_match(p_tenant, p_dir, p_product, p_method, p_conf, p_app) ->> 'status';
$$;
create or replace function pg_temp.decide(p_tenant uuid, p_match uuid, p_decision text) returns text language sql as $$
  select public.product_decide_application_match(p_tenant, p_match, p_decision) ->> 'status';
$$;

-- application_matches is deny-all to `authenticated` (0075), which is exactly what B0 asserts — so the suite cannot read it while
-- acting as a product user. These read-only helpers are SECURITY DEFINER purely so the assertions can inspect the resulting rows
-- without leaving the acting role. They are harness scaffolding in pg_temp; nothing here grants the product anything.
-- They key on the PRODUCT, because that is what identifies a candidate under 0090.
create or replace function pg_temp.mrow(p_dir uuid, p_product uuid) returns public.application_matches language sql security definer as $$
  select * from public.application_matches where directory_application_id = p_dir and app_product_id = p_product;
$$;
create or replace function pg_temp.mid(p_dir uuid, p_product uuid) returns uuid language sql security definer as $$
  select id from public.application_matches where directory_application_id = p_dir and app_product_id = p_product;
$$;
create or replace function pg_temp.mstatus(p_id uuid) returns text language sql security definer as $$
  select status from public.application_matches where id = p_id;
$$;
-- Scoped to this suite's two tenants so an unfiltered count means "rows THIS suite caused", not "rows in the database" — other
-- suites in the same run populate application_matches too.
create or replace function pg_temp.ncount(p_dir uuid default null, p_product uuid default null, p_status text default null)
  returns integer language sql security definer as $$
  select count(*)::int from public.application_matches
   where tenant_id in ('88000000-0000-4000-8000-00000000000a', '88000000-0000-4000-8000-00000000000b')
     and (p_dir is null or directory_application_id = p_dir)
     and (p_product is null or app_product_id = p_product)
     and (p_status is null or status = p_status);
$$;

-- ════ B0: privilege closure — RPCs only; the table itself stays unreachable ═══════════════════════════════════════════════════
do $$
declare pr oid := 'public.product_propose_application_match(uuid,uuid,uuid,text,text,uuid)'::regprocedure;
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
do $$ begin assert pg_temp.propose('88000000-0000-4000-8000-00000000000a','88000000-0000-4000-8000-0000000000d1','88000000-0000-4000-8000-0000000000b1') = 'not_allowed',
  'B1 viewer must not propose'; end $$;
select pg_temp.act('88000000-0000-4000-8000-0000000000f3');  -- editor
do $$ begin assert pg_temp.propose('88000000-0000-4000-8000-00000000000a','88000000-0000-4000-8000-0000000000d1','88000000-0000-4000-8000-0000000000b1') = 'not_allowed',
  'B1 editor must not propose'; end $$;
do $$ begin assert pg_temp.ncount() = 0, 'B1 no row may exist yet'; end $$;

-- ════ B2: propose → proposed, carrying NO decision and NO invented instance ══════════════════════════════════════════════════
select pg_temp.act('88000000-0000-4000-8000-0000000000f1');  -- owner
do $$ begin assert pg_temp.propose('88000000-0000-4000-8000-00000000000a','88000000-0000-4000-8000-0000000000d1','88000000-0000-4000-8000-0000000000b1') = 'proposed',
  'B2 owner may propose a product-level match'; end $$;
do $$
declare r public.application_matches%rowtype;
begin
  r := pg_temp.mrow('88000000-0000-4000-8000-0000000000d1','88000000-0000-4000-8000-0000000000b1');
  assert r.status = 'proposed', 'B2 status must be proposed';
  assert r.decided_by is null and r.decided_at is null, 'B2 a proposal must carry no decision';
  assert r.method = 'exact_external_id' and r.confidence = 'high', 'B2 method/confidence must be recorded as given';
  -- THE POINT OF 0090: the product is known, the instance is not, and the row says exactly that instead of picking one.
  assert r.app_id is null, 'B2 a product-level proposal must leave the operational instance NULL, not guess one';
end $$;

-- Auto-accept is structurally impossible, not merely un-implemented: 0075's decided_chk refuses any row whose status is accepted
-- or rejected without a decided_at, so a propose path that tried to write 'accepted' would be rejected by the database itself.
-- Pinned here because that CHECK — not this suite — is what actually stops it.
do $$
begin
  assert exists (select 1 from pg_constraint where conname = 'application_matches_decided_chk'),
         'B2 the decided_chk that makes auto-accept impossible must exist (0075)';
  assert exists (select 1 from pg_constraint where conname = 'application_matches_dir_tenant_fk'),
         'B2 the same-tenant directory FK must exist (0075)';
  assert exists (select 1 from pg_constraint where conname = 'application_matches_product_tenant_fk'),
         'B2 the same-tenant PRODUCT FK — the cross-tenant backstop for the new authority — must exist (0090)';
  assert exists (select 1 from pg_indexes where indexname = 'application_matches_one_accepted_dir_idx'),
         'B2 the one-accepted-per-directory-application index must exist (0075)';
  assert exists (select 1 from pg_indexes where indexname = 'application_matches_candidate_idx'),
         'B2 the candidate identity index must exist (0088, re-aimed by 0090)';
end $$;

-- ════ B3: idempotency — re-proposing the same candidate changes nothing, including its refinement ════════════════════════════
do $$
declare n_before integer; n_after integer;
begin
  n_before := pg_temp.ncount();
  assert pg_temp.propose('88000000-0000-4000-8000-00000000000a','88000000-0000-4000-8000-0000000000d1','88000000-0000-4000-8000-0000000000b1') = 'already_proposed',
    'B3 re-proposing must be an idempotent no-op';
  -- a different METHOD for the same candidate is the same candidate, not a second one
  assert pg_temp.propose('88000000-0000-4000-8000-00000000000a','88000000-0000-4000-8000-0000000000d1','88000000-0000-4000-8000-0000000000b1','vendor_catalog','low') = 'already_proposed',
    'B3 the same candidate via another method is still one candidate';
  n_after := pg_temp.ncount();
  assert n_before = n_after, 'B3 no duplicate row may be created';
  assert (pg_temp.mrow('88000000-0000-4000-8000-0000000000d1','88000000-0000-4000-8000-0000000000b1')).confidence = 'high',
    'B3 an existing candidate must not be re-scored by a repeat proposal';
end $$;

-- NO SILENT ENRICHMENT (0090's Phase-10 decision, asserted rather than described). A later call that carries an instance the
-- stored candidate lacks is still the same candidate, and it does NOT quietly acquire that instance. Nothing in the architecture
-- ranks two pieces of instance evidence against each other, so "fill it in if it was NULL" is last-write-wins in disguise: the
-- first caller to guess would win and a reviewer would see a refinement nobody proposed. Attaching an instance to a live candidate
-- is a distinct reviewed operation and is deliberately not part of this command.
do $$
declare n_before integer;
begin
  n_before := pg_temp.ncount();
  assert pg_temp.propose('88000000-0000-4000-8000-00000000000a','88000000-0000-4000-8000-0000000000d1','88000000-0000-4000-8000-0000000000b1',
                         p_app => '88000000-0000-4000-8000-0000000000a1') = 'already_proposed',
    'B3 a repeat proposal that adds an instance is still the same candidate';
  assert (pg_temp.mrow('88000000-0000-4000-8000-0000000000d1','88000000-0000-4000-8000-0000000000b1')).app_id is null,
    'B3 an existing candidate must NOT be silently enriched with a newly-supplied instance';
  assert pg_temp.ncount() = n_before, 'B3 nor may the refined form become a second candidate';
end $$;

-- ════ B4: AMBIGUITY — one directory application may carry several competing PRODUCT proposals ════════════════════════════════
do $$ begin
  assert pg_temp.propose('88000000-0000-4000-8000-00000000000a','88000000-0000-4000-8000-0000000000d1','88000000-0000-4000-8000-0000000000b2') = 'proposed',
    'B4 a second candidate PRODUCT for the same directory application must be representable';
  assert pg_temp.ncount('88000000-0000-4000-8000-0000000000d1', null, 'proposed') = 2,
    'B4 ambiguity is TWO live proposals — nothing auto-resolves it';
  assert pg_temp.ncount(null, null, 'accepted') = 0,
    'B4 ambiguity must not auto-accept anything';
end $$;

-- ════ B5: method / confidence vocabulary ═════════════════════════════════════════════════════════════════════════════════════
do $$ begin
  assert pg_temp.propose('88000000-0000-4000-8000-00000000000a','88000000-0000-4000-8000-0000000000d2','88000000-0000-4000-8000-0000000000b1','suggested','high') = 'invalid_method',
    'B5 `suggested` is not proposable — nothing produces it and it is the weak-evidence bucket';
  assert pg_temp.propose('88000000-0000-4000-8000-00000000000a','88000000-0000-4000-8000-0000000000d2','88000000-0000-4000-8000-0000000000b1','exact_domain','high') = 'invalid_method',
    'B5 `exact_domain` is not proposable — the directory side has no domain column';
  assert pg_temp.propose('88000000-0000-4000-8000-00000000000a','88000000-0000-4000-8000-0000000000d2','88000000-0000-4000-8000-0000000000b1','name','high') = 'invalid_method',
    'B5 a name method does not exist and must never be invented here';
  assert pg_temp.propose('88000000-0000-4000-8000-00000000000a','88000000-0000-4000-8000-0000000000d2','88000000-0000-4000-8000-0000000000b1','manual','certain') = 'invalid_confidence',
    'B5 confidence is bounded to high/medium/low';
  assert pg_temp.ncount('88000000-0000-4000-8000-0000000000d2') = 0,
    'B5 a refused proposal must write nothing';
end $$;

-- ════ B6: cross-tenant — source, target, refinement, tenant id and decision all refused ══════════════════════════════════════
do $$ begin
  assert pg_temp.propose('88000000-0000-4000-8000-00000000000a','88000000-0000-4000-8000-0000000000e1','88000000-0000-4000-8000-0000000000b1') = 'not_allowed',
    'B6 a foreign directory application must be refused';
  assert pg_temp.propose('88000000-0000-4000-8000-00000000000a','88000000-0000-4000-8000-0000000000d2','88000000-0000-4000-8000-0000000000bb') = 'not_allowed',
    'B6 a foreign target PRODUCT must be refused';
  assert pg_temp.propose('88000000-0000-4000-8000-00000000000b','88000000-0000-4000-8000-0000000000e1','88000000-0000-4000-8000-0000000000bb') = 'not_allowed',
    'B6 a caller-supplied foreign tenant must not grant authority';
  assert pg_temp.propose('88000000-0000-4000-8000-00000000000a','88000000-0000-4000-8000-0000000000d2','88000000-0000-4000-8000-00000000dead') = 'not_allowed',
    'B6 a guessed/nonexistent target must not disclose anything beyond not_allowed';
  -- A foreign INSTANCE is an authorization fact too, and must be indistinguishable from any other — not reported as a semantic
  -- mismatch, which would confirm the row exists somewhere.
  assert pg_temp.propose('88000000-0000-4000-8000-00000000000a','88000000-0000-4000-8000-0000000000d2','88000000-0000-4000-8000-0000000000b1',
                         p_app => '88000000-0000-4000-8000-0000000000ab') = 'not_allowed',
    'B6 a foreign refinement instance must be refused as not_allowed, disclosing nothing';
  assert pg_temp.ncount('88000000-0000-4000-8000-0000000000e1') = 0
     and pg_temp.ncount(null, '88000000-0000-4000-8000-0000000000bb') = 0
     and pg_temp.ncount('88000000-0000-4000-8000-0000000000d2') = 0,
    'B6 no cross-tenant row may exist';
end $$;

-- tenant B's owner may not decide tenant A's match
do $$
declare mid uuid := pg_temp.mid('88000000-0000-4000-8000-0000000000d1','88000000-0000-4000-8000-0000000000b1');
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
declare mid uuid := pg_temp.mid('88000000-0000-4000-8000-0000000000d1','88000000-0000-4000-8000-0000000000b1');
begin
  assert pg_temp.decide('88000000-0000-4000-8000-00000000000a', mid, 'accepted') = 'not_allowed', 'B7 viewer must not decide';
end $$;
-- An EDITOR is the role that CAN write app_products and app_aliases (0024), so it is the plausible mistake — extending decide
-- authority to it would let the party who proposes canonical identity also ratify the match that consumes it. Reviewing a
-- match is owner/admin, exactly as proposing is.
select pg_temp.act('88000000-0000-4000-8000-0000000000f3');  -- editor may not decide either
do $$
declare mid uuid := pg_temp.mid('88000000-0000-4000-8000-0000000000d1','88000000-0000-4000-8000-0000000000b1');
begin
  assert pg_temp.decide('88000000-0000-4000-8000-00000000000a', mid, 'accepted') = 'not_allowed', 'B7 editor must not decide';
  assert pg_temp.mstatus(mid) = 'proposed', 'B7 a refused decision leaves the candidate untouched';
end $$;
select pg_temp.act('88000000-0000-4000-8000-0000000000f2');  -- admin decides
do $$
declare mid uuid := pg_temp.mid('88000000-0000-4000-8000-0000000000d1','88000000-0000-4000-8000-0000000000b1');
begin
  assert pg_temp.decide('88000000-0000-4000-8000-00000000000a', mid, 'sideways') = 'invalid_decision', 'B7 the decision vocabulary is bounded';
  assert pg_temp.decide('88000000-0000-4000-8000-00000000000a', mid, 'accepted') = 'accepted', 'B7 admin may accept a proposal';
end $$;
do $$
declare r public.application_matches%rowtype;
begin
  r := pg_temp.mrow('88000000-0000-4000-8000-0000000000d1','88000000-0000-4000-8000-0000000000b1');
  assert r.status = 'accepted', 'B7 status must be accepted';
  assert r.decided_by = '88000000-0000-4000-8000-0000000000f2', 'B7 decided_by must be the acting admin, not a parameter';
  assert r.decided_at is not null, 'B7 decided_at must be set by the database';
end $$;

-- ════ B8: accepted cardinality — the competing proposal cannot also be accepted ══════════════════════════════════════════════
select pg_temp.act('88000000-0000-4000-8000-0000000000f1');
do $$
declare other uuid := pg_temp.mid('88000000-0000-4000-8000-0000000000d1','88000000-0000-4000-8000-0000000000b2');
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
declare acc uuid := pg_temp.mid('88000000-0000-4000-8000-0000000000d1','88000000-0000-4000-8000-0000000000b1');
        rej uuid := pg_temp.mid('88000000-0000-4000-8000-0000000000d1','88000000-0000-4000-8000-0000000000b2');
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
  assert pg_temp.propose('88000000-0000-4000-8000-00000000000a','88000000-0000-4000-8000-0000000000d1','88000000-0000-4000-8000-0000000000b2') = 'already_rejected',
    'B10 re-proposing a REJECTED candidate must report it, not resurrect it';
  assert pg_temp.propose('88000000-0000-4000-8000-00000000000a','88000000-0000-4000-8000-0000000000d1','88000000-0000-4000-8000-0000000000b1') = 'already_accepted',
    'B10 re-proposing an ACCEPTED candidate must not duplicate it';

  -- THE REASON CANDIDATE IDENTITY MOVED TO THE PRODUCT. Under 0088's instance key, presenting a different `app_id` produced a
  -- brand-new candidate — so a rejected product could be re-offered indefinitely by naming another instance of it, and an accepted
  -- one could be duplicated the same way. Review history attaches to the PRODUCT decision, and an optional refinement cannot
  -- launder its way around it.
  assert pg_temp.propose('88000000-0000-4000-8000-00000000000a','88000000-0000-4000-8000-0000000000d1','88000000-0000-4000-8000-0000000000b2',
                         p_app => '88000000-0000-4000-8000-0000000000a3') = 'already_rejected',
    'B10 a REJECTED product must not be resurrected by presenting an instance of it';
  assert pg_temp.propose('88000000-0000-4000-8000-00000000000a','88000000-0000-4000-8000-0000000000d1','88000000-0000-4000-8000-0000000000b1',
                         p_app => '88000000-0000-4000-8000-0000000000a2') = 'already_accepted',
    'B10 an ACCEPTED product must not be duplicated by presenting another instance of it';

  assert pg_temp.ncount() = n, 'B10 replay must add no rows';
  assert (pg_temp.mrow('88000000-0000-4000-8000-0000000000d1','88000000-0000-4000-8000-0000000000b2')).status = 'rejected', 'B10 the rejection still stands';
  assert (pg_temp.mrow('88000000-0000-4000-8000-0000000000d1','88000000-0000-4000-8000-0000000000b1')).app_id is null,
    'B10 nor may replay enrich a decided candidate';
end $$;

-- ════ B11: many-to-one is legitimate — a second directory application may accept the SAME product ═══════════════════════════
do $$
declare mid uuid;
begin
  assert pg_temp.propose('88000000-0000-4000-8000-00000000000a','88000000-0000-4000-8000-0000000000d2','88000000-0000-4000-8000-0000000000b1','manual','high') = 'proposed',
    'B11 a different directory application is a different candidate';
  mid := pg_temp.mid('88000000-0000-4000-8000-0000000000d2','88000000-0000-4000-8000-0000000000b1');
  assert pg_temp.decide('88000000-0000-4000-8000-00000000000a', mid, 'accepted') = 'accepted',
    'B11 two directory applications may both accept one product (0075 is deliberately not unique on the canonical side)';
  assert pg_temp.ncount(null, '88000000-0000-4000-8000-0000000000b1', 'accepted') = 2, 'B11 many-to-one holds';
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
  -- 0085's read contract stays FOUR bounded columns — no method/confidence/rationale/decider leakage. 0090 swapped the endpoint
  -- for the authority rather than widening it: the optional instance is deliberately absent, because no consumer needs it and a
  -- bounded read does not carry a column merely because the table has one.
  assert pg_get_function_result('public.product_application_matches(uuid,uuid,integer)'::regprocedure)
         = 'TABLE(id uuid, directory_application_id uuid, app_product_id uuid, status text)',
         'B12 the 0085 read must expose the canonical endpoint, and must not have widened';
  -- The whole product surface over application matching, named rather than counted, so an accidental extra path is visible.
  assert (select array_agg(p.proname::text order by p.proname) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.proname like 'product_%application_match%')
         = array['product_application_matcher_state','product_application_matches','product_complete_application_matcher_run',
                 'product_decide_application_match','product_fail_application_matcher_run','product_propose_application_match',
                 'product_start_application_matcher_run'],
         'B12 the product application-match surface is 0085 (read + state + start/complete/fail) plus exactly propose/decide';
end $$;

-- ════ B13: matcher execution state stays decoupled from human decisions ═════════════════════════════════════════════════════
do $$ begin
  -- 0085's state RPC always returns exactly one row; `has_ever_run` is how absence is expressed. After a full propose/accept/
  -- reject cycle it must still say the matcher has never run: human decisions and matcher execution are separate facts.
  assert (select has_ever_run from public.product_application_matcher_state('88000000-0000-4000-8000-00000000000a')) = false,
    'B13 proposing and deciding must not create or advance matcher run state — they are separate facts';
end $$;

reset role;
select set_config('request.jwt.claims', '', false);

-- ════ B14: ONE PRODUCT, SEVERAL INSTANCES — the case 0090 exists to record honestly ═════════════════════════════════════════
-- THIS BLOCK'S MEANING CHANGED. 0088 asserted here that "we know the product, not the instance" should be recorded as N competing
-- instance candidates, because `app_id` was the only endpoint available. That produced a review queue full of rows a matcher had
-- no evidence for: it knew the product and was forced to enumerate guesses about the instance.
--
-- Under 0090 the same evidence is ONE candidate — the product, with the instance left NULL. The reviewer sees exactly what was
-- proven and nothing that wasn't. The instance question does not disappear; it stops being answered by fabrication.
reset role;
insert into public.app_products (id, tenant_id, name, normalized_name) values
  ('88000000-0000-4000-8000-0000000000b7', '88000000-0000-4000-8000-00000000000a', 'Salesforce CRM', 'salesforce-crm');
insert into public.apps (id, tenant_id, name, canonical_app_id) values
  ('88000000-0000-4000-8000-0000000000a7', '88000000-0000-4000-8000-00000000000a', 'SFDC Production', '88000000-0000-4000-8000-0000000000b7'),
  ('88000000-0000-4000-8000-0000000000a8', '88000000-0000-4000-8000-00000000000a', 'SFDC Sandbox',    '88000000-0000-4000-8000-0000000000b7');
insert into public.directory_applications (id, tenant_id, connection_id, provider, external_id, label, sync_status) values
  ('88000000-0000-4000-8000-0000000000d7', '88000000-0000-4000-8000-00000000000a', '88000000-0000-4000-8000-0000000000c1',
   'okta', '0oaMATCH0007', 'Salesforce', 'current'),
  ('88000000-0000-4000-8000-0000000000d8', '88000000-0000-4000-8000-00000000000a', '88000000-0000-4000-8000-0000000000c1',
   'okta', '0oaMATCH0008', 'Salesforce 2', 'current'),
  ('88000000-0000-4000-8000-0000000000d9', '88000000-0000-4000-8000-00000000000a', '88000000-0000-4000-8000-0000000000c1',
   'okta', '0oaMATCH0009', 'Salesforce 3', 'current');

set role authenticated;
select pg_temp.act('88000000-0000-4000-8000-0000000000f1');   -- owner
do $$
declare v integer; v_match uuid;
begin
  -- PRECONDITION: the product genuinely owns two instances. This is #420's link being consumed, not a name comparison — the two
  -- apps are found by canonical_app_id, and their NAMES ("SFDC Production"/"SFDC Sandbox") match neither each other nor the
  -- directory application's label ("Salesforce").
  select count(*) into v from public.apps where canonical_app_id = '88000000-0000-4000-8000-0000000000b7';
  assert v = 2, format('B14 precondition: one product must own two operational instances, saw %s', v);

  assert pg_temp.propose('88000000-0000-4000-8000-00000000000a','88000000-0000-4000-8000-0000000000d7','88000000-0000-4000-8000-0000000000b7') = 'proposed',
    'B14 the resolved product must be proposable on its own';
  assert pg_temp.ncount('88000000-0000-4000-8000-0000000000d7', null, 'proposed') = 1,
    'B14 "we know the product, not the instance" is ONE candidate — not one per instance';
  assert (pg_temp.mrow('88000000-0000-4000-8000-0000000000d7','88000000-0000-4000-8000-0000000000b7')).app_id is null,
    'B14 and it names no instance, because none was proven';
  assert pg_temp.ncount('88000000-0000-4000-8000-0000000000d7', null, 'accepted') = 0,
    'B14 NOTHING may auto-accept';

  -- Re-running against either instance is still that one candidate. Under 0088 each of these produced a new row.
  assert pg_temp.propose('88000000-0000-4000-8000-00000000000a','88000000-0000-4000-8000-0000000000d7','88000000-0000-4000-8000-0000000000b7',
                         p_app => '88000000-0000-4000-8000-0000000000a7') = 'already_proposed', 'B14 an instance does not fork the candidate';
  assert pg_temp.propose('88000000-0000-4000-8000-00000000000a','88000000-0000-4000-8000-0000000000d7','88000000-0000-4000-8000-0000000000b7',
                         p_app => '88000000-0000-4000-8000-0000000000a8') = 'already_proposed', 'B14 nor does the other one';
  assert pg_temp.ncount('88000000-0000-4000-8000-0000000000d7') = 1,
    'B14 a matcher enumerating every instance under the product must still leave ONE candidate';

  -- A human settles it. The product relationship is what gets accepted; which instance it is remains a separate, unanswered
  -- question — and 0090 deliberately ships NO command that answers it by inference.
  v_match := pg_temp.mid('88000000-0000-4000-8000-0000000000d7','88000000-0000-4000-8000-0000000000b7');
  assert pg_temp.decide('88000000-0000-4000-8000-00000000000a', v_match, 'accepted') = 'accepted',
    'B14 a human may accept the product relationship';
  assert (pg_temp.mrow('88000000-0000-4000-8000-0000000000d7','88000000-0000-4000-8000-0000000000b7')).app_id is null,
    'B14 accepting the product must not select an instance as a side effect';
end $$;

-- ════ B15: an instance-refined proposal, when the instance IS known ═════════════════════════════════════════════════════════
do $$
declare r public.application_matches%rowtype;
begin
  assert pg_temp.propose('88000000-0000-4000-8000-00000000000a','88000000-0000-4000-8000-0000000000d8','88000000-0000-4000-8000-0000000000b7',
                         p_app => '88000000-0000-4000-8000-0000000000a7') = 'proposed',
    'B15 a caller that genuinely knows the instance may record it';
  r := pg_temp.mrow('88000000-0000-4000-8000-0000000000d8','88000000-0000-4000-8000-0000000000b7');
  assert r.app_id = '88000000-0000-4000-8000-0000000000a7', 'B15 the refinement must be stored';
  assert r.app_product_id = '88000000-0000-4000-8000-0000000000b7', 'B15 the product is still the relationship';
end $$;

-- ════ B16 / B17: a refinement that contradicts the product, and one that refines nothing ════════════════════════════════════
do $$
declare n_before integer;
begin
  n_before := pg_temp.ncount('88000000-0000-4000-8000-0000000000d9');
  -- a3 is an instance of Workday (b2); claiming it refines Salesforce CRM (b7) is two contradictory claims in one row
  assert pg_temp.propose('88000000-0000-4000-8000-00000000000a','88000000-0000-4000-8000-0000000000d9','88000000-0000-4000-8000-0000000000b7',
                         p_app => '88000000-0000-4000-8000-0000000000a3') = 'invalid_refinement',
    'B16 an instance of a DIFFERENT product cannot refine this match';
  -- a9 has no canonical product of its own, so it refines nothing — the remedy is to canonicalize it, never to relax this
  assert pg_temp.propose('88000000-0000-4000-8000-00000000000a','88000000-0000-4000-8000-0000000000d9','88000000-0000-4000-8000-0000000000b7',
                         p_app => '88000000-0000-4000-8000-0000000000a9') = 'invalid_refinement',
    'B17 an instance whose own canonical product is unknown cannot refine a product claim';
  assert pg_temp.ncount('88000000-0000-4000-8000-0000000000d9') = n_before,
    'B16/B17 a refused refinement must write nothing at all — not even the product-level part of it';
end $$;
reset role;

-- ════ B18: COMPATIBILITY CLOSURE over the objects 0090 replaced ═════════════════════════════════════════════════════════════
-- The chain applied here is 0001 → 0087 → 0088 → 0089 (#421, unrelated app_account pagination) → 0090, so this asserts the FINAL
-- state after a real successor migration, not 0090 in isolation.
--
-- That 0088's objects existed at all is proved by 0090 itself: it drops the index and the old function WITHOUT `if exists`, so a
-- chain in which 0088 had not created them fails to apply and this suite never runs. What is left to assert is that the
-- replacements are the only survivors.
do $$
declare v_args text; v_n integer;
begin
  -- The candidate index is 0088's NAME with 0090's COLUMNS. `create unique index if not exists` under the existing name would
  -- have emitted a NOTICE and silently left 0088's app_id definition in place — the migration would have reported success and
  -- shipped the wrong key. Asserting the definition, not the name, is what catches that.
  assert (select pg_get_indexdef('public.application_matches_candidate_idx'::regclass))
         = 'CREATE UNIQUE INDEX application_matches_candidate_idx ON public.application_matches '
           'USING btree (tenant_id, directory_application_id, app_product_id)',
         format('B18 candidate identity must be keyed on the PRODUCT, got: %s',
                (select pg_get_indexdef('public.application_matches_candidate_idx'::regclass)));

  -- Exactly ONE propose command. A stale (uuid,uuid,uuid,text,text) overload would be an alternate authorization path with its own
  -- grant, still writing an instance as if it were the relationship — and with the new function's trailing default, a five-argument
  -- call could resolve against either. Counted by name so a leftover of ANY signature is caught, then pinned by argument types.
  select count(*), max(pg_get_function_identity_arguments(p.oid)) into v_n, v_args
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'product_propose_application_match';
  assert v_n = 1, format('B18 exactly one propose command must exist, found %s', v_n);
  assert v_args = 'p_tenant_id uuid, p_directory_application_id uuid, p_app_product_id uuid, p_method text, p_confidence text, p_app_id uuid',
         format('B18 the surviving propose signature must be the product-authoritative one, got: %s', v_args);

  -- The decide command is untouched by 0090 — it is keyed on (match id, decision) and never referenced either endpoint. Pinned so
  -- that "unchanged" is a checked claim rather than an assumption.
  select count(*), max(pg_get_function_identity_arguments(p.oid)) into v_n, v_args
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'product_decide_application_match';
  assert v_n = 1 and v_args = 'p_tenant_id uuid, p_match_id uuid, p_decision text',
         format('B18 decide must remain exactly 0088''s single endpoint-agnostic signature, got %s / %s', v_n, v_args);

  -- 0089 sits between 0088 and 0090 and shares no object with either.
  assert exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                  where n.nspname = 'public' and p.proname = 'product_app_accounts_for_governance'),
         'B18 0089 (#421) must have applied in the same chain, proving the two migrations coexist';
end $$;

-- ════ B19: the ZERO-instance case — kept from #422, and answered differently ════════════════════════════════════════════════
-- #422 added this leg to prove `app_id` was the right endpoint: a canonical product may be RECOGNISED while the tenant holds no
-- operational/contract record for it, 0075 is explicit that this is not an error, and so — under 0088 — no proposal could be made
-- at all, because there was no `app_id` to propose.
--
-- 0090 does not weaken that argument; it answers the same case with more truth. The relationship "this directory application IS
-- Salesforce" is exactly what the evidence supports, and it is now recordable with the instance left NULL. What #422 was actually
-- protecting — that nothing may be FABRICATED to fill the instance gap — is preserved verbatim and asserted below: the product
-- match exists and still names no instance.
reset role;
insert into public.app_products (id, tenant_id, name, normalized_name) values
  ('88000000-0000-4000-8000-0000000000e9', '88000000-0000-4000-8000-00000000000a', 'Jira', 'jira');
insert into public.directory_applications (id, tenant_id, connection_id, provider, external_id, label, sync_status) values
  ('88000000-0000-4000-8000-0000000000da', '88000000-0000-4000-8000-00000000000a', '88000000-0000-4000-8000-0000000000c1',
   'okta', '0oaMATCH000a', 'Jira', 'current');
set role authenticated;
select pg_temp.act('88000000-0000-4000-8000-0000000000f1');
do $$
declare v_instances integer; r public.application_matches%rowtype;
begin
  select count(*) into v_instances from public.apps a
   where a.tenant_id = '88000000-0000-4000-8000-00000000000a'
     and a.canonical_app_id = '88000000-0000-4000-8000-0000000000e9';
  assert v_instances = 0, 'B19 a recognised canonical product may legitimately own zero operational instances';

  -- Under 0088 this was unrecordable: no instance existed, so the deterministically-known product fact was simply lost.
  assert pg_temp.propose('88000000-0000-4000-8000-00000000000a','88000000-0000-4000-8000-0000000000da','88000000-0000-4000-8000-0000000000e9') = 'proposed',
    'B19 a product with no operational instance must still be matchable — that is the fact the evidence supports';

  r := pg_temp.mrow('88000000-0000-4000-8000-0000000000da','88000000-0000-4000-8000-0000000000e9');
  assert r.app_id is null,
    'B19 #422''s property survives unchanged: nothing may be fabricated to fill the instance gap';
  assert r.status = 'proposed',
    'B19 and it is still only a proposal — recording the product does not make it truth';
end $$;
reset role;
do $$ begin
  assert not exists (select 1 from public.application_matches m
                     where m.app_product_id = '88000000-0000-4000-8000-0000000000e9' and m.app_id is not null),
         'B19 zero instances still means zero INSTANCE claims — the refinement stays empty, not guessed';
end $$;
