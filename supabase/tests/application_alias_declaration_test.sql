-- 0087 — the governed canonical application alias declaration command.
--
-- The property this suite exists to protect: the product can establish canonical identity WITHOUT ever receiving
-- directory_applications.external_id. Everything else — role vocabulary, tenant scoping, conflict semantics — is in service of
-- that, because a command that leaks the identifier would silently undo the 0061 minimum-disclosure boundary while looking like
-- a feature.
--
-- Acting user is switched via set_config('request.jwt.claims', ...) + SET ROLE, the org_rls_test.sql convention.

reset role;

-- ── fixture: two tenants, four roles in tenant A, one directory app per tenant, one product per tenant ────────────────────────
insert into public.tenants (id, name, slug) values
  ('87000000-0000-4000-8000-00000000000a', 'Alias A', 'alias-a'),
  ('87000000-0000-4000-8000-00000000000b', 'Alias B', 'alias-b');

-- profiles.id references auth.users(id), so the auth rows come first. (That chain is also why writing
-- reviewed_by = auth.uid() in the command can never violate the app_aliases.reviewed_by FK: any caller that passes
-- has_tenant_role necessarily has a tenant_memberships row, which references profiles, which references auth.users.)
insert into auth.users (id, email) values
  ('87000000-0000-4000-8000-0000000000f1', 'owner-a@example.test'),
  ('87000000-0000-4000-8000-0000000000f2', 'admin-a@example.test'),
  ('87000000-0000-4000-8000-0000000000f3', 'editor-a@example.test'),
  ('87000000-0000-4000-8000-0000000000f4', 'viewer-a@example.test'),
  ('87000000-0000-4000-8000-0000000000f5', 'owner-b@example.test');

insert into public.profiles (id, email) values
  ('87000000-0000-4000-8000-0000000000f1', 'owner-a@example.test'),
  ('87000000-0000-4000-8000-0000000000f2', 'admin-a@example.test'),
  ('87000000-0000-4000-8000-0000000000f3', 'editor-a@example.test'),
  ('87000000-0000-4000-8000-0000000000f4', 'viewer-a@example.test'),
  ('87000000-0000-4000-8000-0000000000f5', 'owner-b@example.test');

insert into public.tenant_memberships (tenant_id, user_id, role, status) values
  ('87000000-0000-4000-8000-00000000000a', '87000000-0000-4000-8000-0000000000f1', 'owner',  'active'),
  ('87000000-0000-4000-8000-00000000000a', '87000000-0000-4000-8000-0000000000f2', 'admin',  'active'),
  ('87000000-0000-4000-8000-00000000000a', '87000000-0000-4000-8000-0000000000f3', 'editor', 'active'),
  ('87000000-0000-4000-8000-00000000000a', '87000000-0000-4000-8000-0000000000f4', 'viewer', 'active'),
  ('87000000-0000-4000-8000-00000000000b', '87000000-0000-4000-8000-0000000000f5', 'owner',  'active');

insert into public.connectors (id, tenant_id, provider, display_name, status, connection_state) values
  ('87000000-0000-4000-8000-0000000000c1', '87000000-0000-4000-8000-00000000000a', 'okta', 'Dir A', 'pending', 'discovered'),
  ('87000000-0000-4000-8000-0000000000c2', '87000000-0000-4000-8000-00000000000b', 'okta', 'Dir B', 'pending', 'discovered');

-- Three source rows in tenant A: current, stale, disconnected. Plus one in tenant B for the cross-tenant proofs.
insert into public.directory_applications (id, tenant_id, connection_id, provider, external_id, label, sync_status) values
  ('87000000-0000-4000-8000-0000000000d1', '87000000-0000-4000-8000-00000000000a', '87000000-0000-4000-8000-0000000000c1', 'okta', '0oaCURRENT01', 'Salesforce',  'current'),
  ('87000000-0000-4000-8000-0000000000d2', '87000000-0000-4000-8000-00000000000a', '87000000-0000-4000-8000-0000000000c1', 'okta', '0oaSTALE0002', 'Old app',     'stale'),
  ('87000000-0000-4000-8000-0000000000d3', '87000000-0000-4000-8000-00000000000a', '87000000-0000-4000-8000-0000000000c1', 'okta', '0oaDISCONN03', 'Gone app',    'disconnected'),
  ('87000000-0000-4000-8000-0000000000d4', '87000000-0000-4000-8000-00000000000a', '87000000-0000-4000-8000-0000000000c1', 'okta', '0oaSECOND04',  'Second app',  'current'),
  ('87000000-0000-4000-8000-0000000000d7', '87000000-0000-4000-8000-00000000000a', '87000000-0000-4000-8000-0000000000c1', 'okta', '0oaFRESH0007', 'Fresh app',   'current'),
  ('87000000-0000-4000-8000-0000000000e1', '87000000-0000-4000-8000-00000000000b', '87000000-0000-4000-8000-0000000000c2', 'okta', '0oaTENANTB01', 'Foreign app', 'current');

insert into public.app_products (id, tenant_id, name, normalized_name) values
  ('87000000-0000-4000-8000-0000000000b1', '87000000-0000-4000-8000-00000000000a', 'Salesforce', 'salesforce'),
  ('87000000-0000-4000-8000-0000000000b2', '87000000-0000-4000-8000-00000000000a', 'Other',      'other'),
  ('87000000-0000-4000-8000-0000000000bb', '87000000-0000-4000-8000-00000000000b', 'Foreign',    'foreign');

create or replace function pg_temp.act(p_user uuid) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', p_user)::text, false);
end $$;

create or replace function pg_temp.declare_alias(p_tenant uuid, p_dir uuid, p_product uuid) returns text language sql as $$
  select public.product_declare_application_alias(p_tenant, p_dir, p_product) ->> 'status';
$$;

-- ════ D0: grants — authenticated only; public/anon/connector_runner denied EXECUTE ═══════════════════════════════════════════
do $$
declare fn oid := 'public.product_declare_application_alias(uuid,uuid,uuid)'::regprocedure;
begin
  assert has_function_privilege('authenticated', fn, 'EXECUTE'), 'D0 authenticated must hold EXECUTE';
  assert not has_function_privilege('anon', fn, 'EXECUTE'), 'D0 anon must NOT hold EXECUTE';
  assert not has_function_privilege('connector_runner', fn, 'EXECUTE'),
         'D0 connector_runner must NOT hold EXECUTE — canonical identity is a product-side judgement';
  -- PUBLIC must not carry it either; aclexplode with a null grantee is the PUBLIC pseudo-role.
  assert not exists (
    select 1 from pg_proc p, aclexplode(p.proacl) a
     where p.oid = fn and a.grantee = 0 and a.privilege_type = 'EXECUTE'),
    'D0 PUBLIC must NOT hold EXECUTE';
  -- SECURITY DEFINER with a pinned search_path.
  assert (select prosecdef from pg_proc where oid = fn), 'D0 must be SECURITY DEFINER';
  assert (select proconfig::text from pg_proc where oid = fn) like '%search_path=public%',
         'D0 search_path must be pinned';
end $$;

-- ════ D1: directory_applications stays deny-all to authenticated — this command adds no read path ════════════════════════════
do $$
declare fn oid := 'public.directory_applications'::regclass;
begin
  assert not has_table_privilege('authenticated', fn, 'SELECT'), 'D1 authenticated must NOT hold SELECT on directory_applications';
  assert not has_table_privilege('anon', fn, 'SELECT'), 'D1 anon must NOT hold SELECT on directory_applications';
  assert not exists (select 1 from pg_policies where schemaname='public' and tablename='directory_applications'),
         'D1 directory_applications must still have NO policy (0057 deny-all)';
  -- and connector_runner gains nothing on the canonical catalog
  assert not has_table_privilege('connector_runner', 'public.app_aliases'::regclass, 'INSERT'),
         'D1 connector_runner must NOT be able to write app_aliases';
end $$;

-- ════ D2: role vocabulary — owner and admin may declare; editor and viewer may not ═══════════════════════════════════════════
set role authenticated;

select pg_temp.act('87000000-0000-4000-8000-0000000000f4');  -- viewer
do $$ begin assert pg_temp.declare_alias('87000000-0000-4000-8000-00000000000a','87000000-0000-4000-8000-0000000000d1','87000000-0000-4000-8000-0000000000b1') = 'not_allowed',
  'D2 viewer must be denied'; end $$;

select pg_temp.act('87000000-0000-4000-8000-0000000000f3');  -- editor: writes app_aliases directly under 0024, but may NOT see a directory row
do $$ begin assert pg_temp.declare_alias('87000000-0000-4000-8000-00000000000a','87000000-0000-4000-8000-0000000000d1','87000000-0000-4000-8000-0000000000b1') = 'not_allowed',
  'D2 editor must be denied — 0061 does not let them see directory applications at all'; end $$;

select pg_temp.act('87000000-0000-4000-8000-0000000000f2');  -- admin
do $$ begin assert pg_temp.declare_alias('87000000-0000-4000-8000-00000000000a','87000000-0000-4000-8000-0000000000d4','87000000-0000-4000-8000-0000000000b2') = 'created',
  'D2 admin may declare'; end $$;

select pg_temp.act('87000000-0000-4000-8000-0000000000f1');  -- owner
do $$ begin assert pg_temp.declare_alias('87000000-0000-4000-8000-00000000000a','87000000-0000-4000-8000-0000000000d1','87000000-0000-4000-8000-0000000000b1') = 'created',
  'D2 owner may declare a current source'; end $$;

-- ════ D3: the identifier is used but NEVER returned — on EVERY reachable return path ════════════════════════════════════════
-- The first version of this block only ever exercised `already_confirmed`, so a mutant that leaked external_id on the `created`
-- path passed it. The guard is only evidence if every branch is walked, so each status is produced deliberately and checked.
do $$
declare v jsonb; s text;
begin
  foreach s in array array['created', 'already_confirmed', 'conflict', 'source_not_current', 'not_allowed'] loop
    v := case s
      -- a FRESH current source + product: the insert path
      when 'created'            then public.product_declare_application_alias('87000000-0000-4000-8000-00000000000a','87000000-0000-4000-8000-0000000000d7','87000000-0000-4000-8000-0000000000b1')
      -- the same declaration again: the idempotent path
      when 'already_confirmed'  then public.product_declare_application_alias('87000000-0000-4000-8000-00000000000a','87000000-0000-4000-8000-0000000000d7','87000000-0000-4000-8000-0000000000b1')
      -- same identifier, different product: the conflict path
      when 'conflict'           then public.product_declare_application_alias('87000000-0000-4000-8000-00000000000a','87000000-0000-4000-8000-0000000000d7','87000000-0000-4000-8000-0000000000b2')
      -- a stale source: the eligibility path
      when 'source_not_current' then public.product_declare_application_alias('87000000-0000-4000-8000-00000000000a','87000000-0000-4000-8000-0000000000d2','87000000-0000-4000-8000-0000000000b2')
      -- a foreign source: the authorization path
      else                           public.product_declare_application_alias('87000000-0000-4000-8000-00000000000a','87000000-0000-4000-8000-0000000000e1','87000000-0000-4000-8000-0000000000b1')
    end;
    assert v ->> 'status' = s, format('D3 expected status %s, got %s', s, v ->> 'status');
    assert (select array_agg(k order by k) from jsonb_object_keys(v) k) = array['status'],
           format('D3 status %s must return ONLY a status key, got %s', s, v::text);
    assert v::text not like '%0oa%',
           format('D3 status %s must not carry a provider identifier, got %s', s, v::text);
  end loop;
end $$;

-- but the write DID key on the real identifier, read internally
do $$
begin
  assert exists (select 1 from public.app_aliases
                  where tenant_id = '87000000-0000-4000-8000-00000000000a'
                    and alias_type = 'provider_app_id' and alias_value = '0oaCURRENT01'
                    and app_product_id = '87000000-0000-4000-8000-0000000000b1'
                    and review_status = 'confirmed'
                    and reviewed_by = '87000000-0000-4000-8000-0000000000f1'
                    and reviewed_at is not null),
         'D3 the alias must be keyed on the internally-read external_id and confirmed to the acting user';
end $$;

-- ════ D4: source eligibility — stale and disconnected sources cannot mint NEW identity ═══════════════════════════════════════
do $$ begin
  assert pg_temp.declare_alias('87000000-0000-4000-8000-00000000000a','87000000-0000-4000-8000-0000000000d2','87000000-0000-4000-8000-0000000000b2') = 'source_not_current',
    'D4 a stale source must not mint a new alias';
  assert pg_temp.declare_alias('87000000-0000-4000-8000-00000000000a','87000000-0000-4000-8000-0000000000d3','87000000-0000-4000-8000-0000000000b2') = 'source_not_current',
    'D4 a disconnected source must not mint a new alias';
  assert not exists (select 1 from public.app_aliases where alias_value in ('0oaSTALE0002','0oaDISCONN03')),
    'D4 no alias row may exist for an ineligible source';
end $$;

-- ════ D5: cross-tenant — foreign directory application and foreign product are both refused, indistinguishably ═══════════════
do $$ begin
  assert pg_temp.declare_alias('87000000-0000-4000-8000-00000000000a','87000000-0000-4000-8000-0000000000e1','87000000-0000-4000-8000-0000000000b1') = 'not_allowed',
    'D5 a foreign-tenant directory application must be refused';
  assert pg_temp.declare_alias('87000000-0000-4000-8000-00000000000a','87000000-0000-4000-8000-0000000000d4','87000000-0000-4000-8000-0000000000bb') = 'not_allowed',
    'D5 a foreign-tenant app_product must be refused';
  -- passing ANOTHER tenant's id does not grant authority: p_tenant_id is verified, never trusted
  assert pg_temp.declare_alias('87000000-0000-4000-8000-00000000000b','87000000-0000-4000-8000-0000000000e1','87000000-0000-4000-8000-0000000000bb') = 'not_allowed',
    'D5 a caller-supplied foreign tenant must not grant authority';
  assert not exists (select 1 from public.app_aliases where alias_value = '0oaTENANTB01'),
    'D5 no cross-tenant alias may exist';
end $$;

-- ════ D6: conflict semantics — idempotent, never overwriting a human judgement ═══════════════════════════════════════════════
do $$
declare n_before integer; n_after integer;
begin
  select count(*) into n_before from public.app_aliases where alias_value = '0oaCURRENT01';
  assert pg_temp.declare_alias('87000000-0000-4000-8000-00000000000a','87000000-0000-4000-8000-0000000000d1','87000000-0000-4000-8000-0000000000b1') = 'already_confirmed',
    'D6 the same declaration twice is idempotent success';
  assert pg_temp.declare_alias('87000000-0000-4000-8000-00000000000a','87000000-0000-4000-8000-0000000000d1','87000000-0000-4000-8000-0000000000b2') = 'conflict',
    'D6 a DIFFERENT product must conflict';
  select count(*) into n_after from public.app_aliases where alias_value = '0oaCURRENT01';
  assert n_before = n_after, 'D6 no extra row may be written';
  assert (select app_product_id from public.app_aliases where alias_value = '0oaCURRENT01') = '87000000-0000-4000-8000-0000000000b1',
    'D6 the existing mapping must NOT be overwritten';
end $$;

-- a rejected judgement is never silently resurrected, and a pending one is never silently promoted
reset role;
insert into public.app_aliases (tenant_id, app_product_id, alias_type, alias_value, review_status) values
  ('87000000-0000-4000-8000-00000000000a', '87000000-0000-4000-8000-0000000000b1', 'provider_app_id', '0oaREJECT005', 'rejected'),
  ('87000000-0000-4000-8000-00000000000a', '87000000-0000-4000-8000-0000000000b1', 'provider_app_id', '0oaPENDING06', 'pending');
insert into public.directory_applications (id, tenant_id, connection_id, provider, external_id, sync_status) values
  ('87000000-0000-4000-8000-0000000000d5', '87000000-0000-4000-8000-00000000000a', '87000000-0000-4000-8000-0000000000c1', 'okta', '0oaREJECT005', 'current'),
  ('87000000-0000-4000-8000-0000000000d6', '87000000-0000-4000-8000-00000000000a', '87000000-0000-4000-8000-0000000000c1', 'okta', '0oaPENDING06', 'current');
set role authenticated;
select pg_temp.act('87000000-0000-4000-8000-0000000000f1');
do $$ begin
  assert pg_temp.declare_alias('87000000-0000-4000-8000-00000000000a','87000000-0000-4000-8000-0000000000d5','87000000-0000-4000-8000-0000000000b1') = 'conflict',
    'D6 a rejected judgement must not be silently resurrected';
  assert (select review_status from public.app_aliases where alias_value = '0oaREJECT005') = 'rejected',
    'D6 the rejection must survive';
  assert pg_temp.declare_alias('87000000-0000-4000-8000-00000000000a','87000000-0000-4000-8000-0000000000d6','87000000-0000-4000-8000-0000000000b1') = 'conflict',
    'D6 a pending proposal must not be silently promoted';
  assert (select review_status from public.app_aliases where alias_value = '0oaPENDING06') = 'pending',
    'D6 the pending state must survive';
end $$;

-- ════ D7: the Phase 18A1 resolver can read what this command wrote ═══════════════════════════════════════════════════════════
-- The resolver's query, exactly: tenant + alias_type + alias_value, taking only confirmed rows. It runs as an ordinary tenant
-- MEMBER under the 0024 "members read app_aliases" policy — a lower bar than declaring, which is the intended asymmetry.
select pg_temp.act('87000000-0000-4000-8000-0000000000f4');  -- viewer: may READ the canonical judgement it may not create
do $$
begin
  assert (select app_product_id from public.app_aliases
           where tenant_id = '87000000-0000-4000-8000-00000000000a'
             and alias_type = 'provider_app_id' and alias_value = '0oaCURRENT01'
             and review_status = 'confirmed') = '87000000-0000-4000-8000-0000000000b1',
         'D7 a confirmed declaration must be resolvable by the Phase 18A1 resolver';
  -- and a member of the OTHER tenant still cannot see it
end $$;
select pg_temp.act('87000000-0000-4000-8000-0000000000f5');  -- tenant B owner
do $$ begin
  assert not exists (select 1 from public.app_aliases where alias_value = '0oaCURRENT01'),
    'D7 a foreign tenant must not read the alias — the composite FK and RLS are both in force';
end $$;

-- ════ D8: name is never a declarable identity ═══════════════════════════════════════════════════════════════════════════════
-- The command derives alias_type itself and takes no alias_type parameter, so 'name' is unreachable by construction. Prove the
-- signature admits no such argument, and that nothing it wrote carries a name-typed alias.
--
-- Runs unrestricted: D7 deliberately left the session acting as the OTHER tenant, where RLS correctly hides every row written
-- here. Asserting over the whole table needs the RLS-exempt role — the isolation itself is what D5/D7 already proved.
reset role;
select set_config('request.jwt.claims', '', false);
do $$
begin
  assert (select count(*) from pg_proc where proname = 'product_declare_application_alias' and pronargs = 3) = 1,
         'D8 the command must take exactly three arguments — no alias_type, no alias_value';
  assert not exists (select 1 from public.app_aliases where alias_type = 'name' and source = 'product_declaration'),
         'D8 the command must never write a name alias';
  assert (select count(distinct alias_type) from public.app_aliases where source = 'product_declaration') = 1
     and (select distinct alias_type from public.app_aliases where source = 'product_declaration') = 'provider_app_id',
         'D8 every declared alias must be provider_app_id';
end $$;

reset role;
select set_config('request.jwt.claims', '', false);
