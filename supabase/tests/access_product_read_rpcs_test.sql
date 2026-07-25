-- access_product_read_rpcs_test.sql — verifies migration 0061 (Phase 15 Part 1 PR A): the authenticated SECURITY DEFINER product read
-- RPCs onto the canonical directory graph. Proves: the six canonical tables stay DENY-ALL (no direct SELECT); only owner/admin members
-- can read via the RPCs; editor/viewer/non-member/anon are denied with a not-found-equivalent EMPTY result; strict tenant isolation;
-- foreign/missing ids return the same not-found; NO external_id/raw_payload leaks; pagination is capped; stale policy honored. Runs FIRST
-- (alphabetical) in the shared Docker harness; truncates its world at top AND bottom so the okta/org tests that follow start clean.

\set ON_ERROR_STOP on

reset role;
truncate table
  public.directory_application_user_assignments, public.directory_application_group_assignments,
  public.directory_group_memberships, public.directory_applications, public.directory_groups, public.identity_accounts,
  public.connectors, public.tenant_memberships, public.profiles, public.tenants
  restart identity cascade;
delete from auth.users;

-- ── users + profiles (TA: owner/admin/editor/viewer; TB: owner; plus a non-member) ──
insert into auth.users (id, email) values
  ('0aaa0000-0000-4000-8000-000000000001','owner_a@a.test'),
  ('0aaa0000-0000-4000-8000-00000000000d','admin_a@a.test'),
  ('0aaa0000-0000-4000-8000-00000000000e','editor_a@a.test'),
  ('0aaa0000-0000-4000-8000-00000000000f','viewer_a@a.test'),
  ('0bbb0000-0000-4000-8000-000000000001','owner_b@b.test'),
  ('0ccc0000-0000-4000-8000-0000000000ff','nobody@x.test');
insert into public.profiles (id, email) select id, email from auth.users;

-- ── tenants + memberships (roles) + one okta connection each ──
insert into public.tenants (id, name, slug) values
  ('7a000000-0000-4000-8000-000000000001','Tenant A','tenant-a'),
  ('7b000000-0000-4000-8000-000000000001','Tenant B','tenant-b');
insert into public.tenant_memberships (tenant_id, user_id, role, status) values
  ('7a000000-0000-4000-8000-000000000001','0aaa0000-0000-4000-8000-000000000001','owner','active'),
  ('7a000000-0000-4000-8000-000000000001','0aaa0000-0000-4000-8000-00000000000d','admin','active'),
  ('7a000000-0000-4000-8000-000000000001','0aaa0000-0000-4000-8000-00000000000e','editor','active'),
  ('7a000000-0000-4000-8000-000000000001','0aaa0000-0000-4000-8000-00000000000f','viewer','active'),
  ('7b000000-0000-4000-8000-000000000001','0bbb0000-0000-4000-8000-000000000001','owner','active');
insert into public.connectors (id, tenant_id, provider, status, connection_state) values
  ('ca000000-0000-4000-8000-000000000001','7a000000-0000-4000-8000-000000000001','okta','pending','discovered'),
  ('cb000000-0000-4000-8000-000000000001','7b000000-0000-4000-8000-000000000001','okta','pending','discovered');

-- ── TA canonical graph: i1 (BOTH access to a1: direct + via g1), i2, a stale identity, + 99 fillers (cap test); TB: ib1 (isolation) ──
insert into public.identity_accounts (id, tenant_id, connection_id, provider, external_id, sync_status, display_name, login, email, is_active, status, raw_payload) values
  ('11000000-0000-4000-8000-000000000001','7a000000-0000-4000-8000-000000000001','ca000000-0000-4000-8000-000000000001','okta','00uEXT1','current','Ada Lovelace','ada','ada@a.test',true,'ACTIVE','{"secret":"x"}'),
  ('11000000-0000-4000-8000-000000000002','7a000000-0000-4000-8000-000000000001','ca000000-0000-4000-8000-000000000001','okta','00uEXT2','current','Alan Turing','alan','alan@a.test',true,'ACTIVE',null),
  ('00000000-0000-4000-8000-0000000000ff','7a000000-0000-4000-8000-000000000001','ca000000-0000-4000-8000-000000000001','okta','00uSTALE','stale','Ghost User','ghost','ghost@a.test',false,'DEPROVISIONED',null);
insert into public.identity_accounts (id, tenant_id, connection_id, provider, external_id, sync_status)
  select gen_random_uuid(), '7a000000-0000-4000-8000-000000000001','ca000000-0000-4000-8000-000000000001','okta','00uFILL'||g, 'current' from generate_series(1,99) g;
insert into public.directory_groups (id, tenant_id, connection_id, provider, external_id, sync_status, name) values
  ('99000000-0000-4000-8000-000000000001','7a000000-0000-4000-8000-000000000001','ca000000-0000-4000-8000-000000000001','okta','00gEXT1','current','Engineering');
insert into public.directory_applications (id, tenant_id, connection_id, provider, external_id, sync_status, label) values
  ('aa000000-0000-4000-8000-000000000001','7a000000-0000-4000-8000-000000000001','ca000000-0000-4000-8000-000000000001','okta','0oaEXT1','current','Salesforce');
insert into public.directory_group_memberships (tenant_id, connection_id, provider, directory_group_id, identity_account_id, sync_status) values
  ('7a000000-0000-4000-8000-000000000001','ca000000-0000-4000-8000-000000000001','okta','99000000-0000-4000-8000-000000000001','11000000-0000-4000-8000-000000000001','current');
insert into public.directory_application_user_assignments (tenant_id, connection_id, provider, directory_application_id, identity_account_id, sync_status) values
  ('7a000000-0000-4000-8000-000000000001','ca000000-0000-4000-8000-000000000001','okta','aa000000-0000-4000-8000-000000000001','11000000-0000-4000-8000-000000000001','current');
insert into public.directory_application_group_assignments (tenant_id, connection_id, provider, directory_application_id, directory_group_id, sync_status) values
  ('7a000000-0000-4000-8000-000000000001','ca000000-0000-4000-8000-000000000001','okta','aa000000-0000-4000-8000-000000000001','99000000-0000-4000-8000-000000000001','current');
insert into public.identity_accounts (id, tenant_id, connection_id, provider, external_id, sync_status) values
  ('1b000000-0000-4000-8000-000000000001','7b000000-0000-4000-8000-000000000001','cb000000-0000-4000-8000-000000000001','okta','00uB1','current');

-- ════ AR0: the six canonical tables remain DENY-ALL (authenticated has NO direct SELECT privilege) ═══════════════════════════════════
select set_config('request.jwt.claims','{"sub":"0aaa0000-0000-4000-8000-000000000001"}',false); -- owner_a
set role authenticated;
do $$ declare t text; begin
  -- REAL, migration-controlled deny-all: every canonical table has RLS enabled + ZERO policies (so even a stray grant yields 0 rows).
  foreach t in array array['identity_accounts','directory_groups','directory_group_memberships','directory_applications','directory_application_user_assignments','directory_application_group_assignments'] loop
    assert (select relrowsecurity from pg_class where oid = ('public.'||t)::regclass), format('AR0 %s RLS enabled', t);
    assert (select count(*) from pg_policies where schemaname='public' and tablename=t) = 0, format('AR0 %s has ZERO policies (deny-all)', t);
  end loop;
  -- The five NEW directory_* tables have NO direct SELECT grant to authenticated (reads go only through the RPCs).
  assert not has_table_privilege('authenticated','public.directory_groups','SELECT'), 'AR0 directory_groups no authenticated SELECT';
  assert not has_table_privilege('authenticated','public.directory_applications','SELECT'), 'AR0 directory_applications no authenticated SELECT';
  assert not has_table_privilege('authenticated','public.directory_application_user_assignments','SELECT'), 'AR0 user-assignments no authenticated SELECT';
  assert not has_table_privilege('authenticated','public.directory_application_group_assignments','SELECT'), 'AR0 group-assignments no authenticated SELECT';
  assert not has_table_privilege('authenticated','public.directory_group_memberships','SELECT'), 'AR0 memberships no authenticated SELECT';
  -- RPC EXECUTE: authenticated yes, anon/public no
  assert     has_function_privilege('authenticated','public.product_list_directory_identities(uuid,uuid,text,boolean,uuid,integer)','EXECUTE'), 'AR0 authenticated EXECUTE list';
  assert not has_function_privilege('anon','public.product_list_directory_identities(uuid,uuid,text,boolean,uuid,integer)','EXECUTE'), 'AR0 anon denied EXECUTE list';
  assert not has_function_privilege('anon','public.product_identity_access_subgraph(uuid,uuid,boolean)','EXECUTE'), 'AR0 anon denied EXECUTE subgraph';
end $$;
reset role;

-- ════ AR1: owner (and admin) CAN read TA — counts, list, subgraph ════════════════════════════════════════════════════════════════════
select set_config('request.jwt.claims','{"sub":"0aaa0000-0000-4000-8000-000000000001"}',false); set role authenticated;
do $$ declare c jsonb; n int; sg jsonb; begin
  c := public.product_directory_access_counts('7a000000-0000-4000-8000-000000000001');
  assert (c->>'identities')::int = 102, 'AR1 owner counts identities (2 named + 99 filler + 1 stale... current-agnostic count)';
  assert (c->>'applications')::int = 1 and (c->>'groups')::int = 1 and (c->>'userAssignments')::int = 1 and (c->>'groupAssignments')::int = 1, 'AR1 owner counts graph';
  select count(*) into n from public.product_list_directory_identities('7a000000-0000-4000-8000-000000000001'); -- current-only default
  assert n = 100, 'AR1 list caps at 100 (101 current identities present)';
  sg := public.product_identity_access_subgraph('7a000000-0000-4000-8000-000000000001','11000000-0000-4000-8000-000000000001');
  assert sg is not null and (sg->'identity'->>'display_name') = 'Ada Lovelace', 'AR1 subgraph returns the identity';
  assert jsonb_array_length(sg->'applications') = 1 and jsonb_array_length(sg->'groups') = 1, 'AR1 subgraph carries the reachable app + group';
end $$;
reset role;
select set_config('request.jwt.claims','{"sub":"0aaa0000-0000-4000-8000-00000000000d"}',false); set role authenticated; -- admin_a
do $$ begin assert public.product_directory_access_counts('7a000000-0000-4000-8000-000000000001') is not null, 'AR1 admin can read'; end $$;
reset role;

-- ════ AR2: editor + viewer are DENIED (role gate = owner/admin only) — not-found-equivalent empty/null ══════════════════════════════
select set_config('request.jwt.claims','{"sub":"0aaa0000-0000-4000-8000-00000000000e"}',false); set role authenticated; -- editor_a
do $$ declare n int; begin
  assert public.product_directory_access_counts('7a000000-0000-4000-8000-000000000001') is null, 'AR2 editor denied counts';
  select count(*) into n from public.product_list_directory_identities('7a000000-0000-4000-8000-000000000001'); assert n = 0, 'AR2 editor denied list';
  assert public.product_identity_access_subgraph('7a000000-0000-4000-8000-000000000001','11000000-0000-4000-8000-000000000001') is null, 'AR2 editor denied subgraph';
end $$;
reset role;
select set_config('request.jwt.claims','{"sub":"0aaa0000-0000-4000-8000-00000000000f"}',false); set role authenticated; -- viewer_a
do $$ declare n int; begin
  assert public.product_directory_access_counts('7a000000-0000-4000-8000-000000000001') is null, 'AR2 viewer denied counts';
  select count(*) into n from public.product_list_directory_applications('7a000000-0000-4000-8000-000000000001'); assert n = 0, 'AR2 viewer denied list';
end $$;
reset role;

-- ════ AR3: cross-tenant — owner_b passing TA's tenant_id (verify-not-trust) gets NOTHING; and TA owner never sees TB rows ════════════
select set_config('request.jwt.claims','{"sub":"0bbb0000-0000-4000-8000-000000000001"}',false); set role authenticated; -- owner_b
do $$ declare n int; begin
  assert public.product_directory_access_counts('7a000000-0000-4000-8000-000000000001') is null, 'AR3 owner_b cannot read TA counts';
  select count(*) into n from public.product_list_directory_identities('7a000000-0000-4000-8000-000000000001'); assert n = 0, 'AR3 owner_b cannot list TA';
  assert public.product_identity_access_subgraph('7a000000-0000-4000-8000-000000000001','11000000-0000-4000-8000-000000000001') is null, 'AR3 owner_b cannot read a TA identity';
end $$;
reset role;
select set_config('request.jwt.claims','{"sub":"0aaa0000-0000-4000-8000-000000000001"}',false); set role authenticated; -- owner_a
do $$ declare has_tb boolean; begin
  select exists(select 1 from public.product_list_directory_identities('7a000000-0000-4000-8000-000000000001', null, null, true, null, 100) where id = '1b000000-0000-4000-8000-000000000001') into has_tb;
  assert not has_tb, 'AR3 TA owner list never contains a TB identity';
  -- a foreign (TB) identity id via TA subgraph -> not found; a random missing id -> SAME not found
  assert public.product_identity_access_subgraph('7a000000-0000-4000-8000-000000000001','1b000000-0000-4000-8000-000000000001') is null, 'AR3 foreign id -> not found';
  assert public.product_identity_access_subgraph('7a000000-0000-4000-8000-000000000001','deadbeef-0000-4000-8000-000000000000') is null, 'AR3 missing id -> SAME not found';
end $$;
reset role;

-- ════ AR4: non-member (no membership at all) denied ═════════════════════════════════════════════════════════════════════════════════
select set_config('request.jwt.claims','{"sub":"0ccc0000-0000-4000-8000-0000000000ff"}',false); set role authenticated; -- nobody
do $$ begin assert public.product_directory_access_counts('7a000000-0000-4000-8000-000000000001') is null, 'AR4 non-member denied'; end $$;
reset role;

-- ════ AR5: NO external_id / raw_payload leaks in any RPC output ═════════════════════════════════════════════════════════════════════
select set_config('request.jwt.claims','{"sub":"0aaa0000-0000-4000-8000-000000000001"}',false); set role authenticated;
do $$ declare j jsonb; sg jsonb; begin
  select to_jsonb(t) into j from public.product_list_directory_identities('7a000000-0000-4000-8000-000000000001','ca000000-0000-4000-8000-000000000001','okta',false,null,1) t limit 1;
  assert j is not null and not (j ? 'external_id') and not (j ? 'raw_payload') and not (j ? 'tenant_id'), 'AR5 identity list omits external_id/raw_payload/tenant_id';
  sg := public.product_identity_access_subgraph('7a000000-0000-4000-8000-000000000001','11000000-0000-4000-8000-000000000001');
  assert not ((sg->'identity') ? 'external_id') and not ((sg->'identity') ? 'raw_payload'), 'AR5 subgraph identity omits external_id/raw_payload';
  assert not (jsonb_path_exists(sg, '$.**.external_id')), 'AR5 no external_id anywhere in the subgraph';
end $$;
reset role;

-- ════ AR6: stale policy — default current-only; include_stale surfaces the stale identity ═══════════════════════════════════════════
select set_config('request.jwt.claims','{"sub":"0aaa0000-0000-4000-8000-000000000001"}',false); set role authenticated;
do $$ declare cur boolean; stale boolean; begin
  select exists(select 1 from public.product_list_directory_identities('7a000000-0000-4000-8000-000000000001', null, null, false, null, 100) where display_name = 'Ghost User') into cur;
  assert not cur, 'AR6 stale identity excluded by default';
  select exists(select 1 from public.product_list_directory_identities('7a000000-0000-4000-8000-000000000001', null, null, true, null, 100) where display_name = 'Ghost User') into stale;
  assert stale, 'AR6 include_stale surfaces the stale identity (id 00..ff sorts first, within page)';
end $$;
reset role;

-- cleanup: leave the canonical/fixture tables empty for the okta/org tests that follow.
reset role;
truncate table
  public.directory_application_user_assignments, public.directory_application_group_assignments,
  public.directory_group_memberships, public.directory_applications, public.directory_groups, public.identity_accounts,
  public.connectors, public.tenant_memberships, public.profiles, public.tenants
  restart identity cascade;
delete from auth.users;

do $$ begin raise notice 'ALL ACCESS PRODUCT READ RPC ASSERTIONS PASSED'; end $$;
