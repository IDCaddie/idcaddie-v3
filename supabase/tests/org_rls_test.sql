-- org_rls_test.sql — runnable RLS verification for 0002_org_scoped_rls.sql
--
-- ENVIRONMENT CONTRACT (provided by the test harness, NOT by this file):
--   * Postgres with migrations 0001 + 0002 applied.
--   * A Supabase-style auth.uid() reading current_setting('request.jwt.claims').
--   * Roles `authenticated` and `service_role` exist; `service_role` has BYPASSRLS;
--     both are GRANTed table privileges on public.* (RLS does the filtering).
--   * Test users exist in auth.users (the local harness inserts them; on hosted
--     Supabase you would create them via the admin API).
-- Run with psql -v ON_ERROR_STOP=1 so any failed assertion aborts non-zero.
-- Acting user is switched via: select set_config('request.jwt.claims', ...) + SET ROLE.
--
-- Covers: cross-tenant isolation, viewer-no-edit, exact-org manager edit,
-- no cross-org / cross-tenant manager edit, no reassignment/self-grant escalation,
-- org-viewer read-not-edit, and audit-log append-only (incl. service_role).

\set ON_ERROR_STOP on

-- ── Fixtures (seeded as the privileged/superuser role; RLS bypassed for setup) ─
reset role;
truncate table
  public.invoices, public.files, public.license_evaluations, public.license_rules,
  public.app_user_identity_matches, public.identity_accounts,
  public.audit_logs, public.app_contracts, public.app_users, public.people,
  public.apps, public.contracts,
  public.organization_memberships, public.tenant_memberships,
  public.organizations, public.profiles, public.tenants
restart identity cascade;
delete from auth.users;

insert into auth.users (id, email) values
  ('0a000000-0000-0000-0000-000000000001','owner_a@a.test'),
  ('0a000000-0000-0000-0000-000000000002','viewer_a@a.test'),
  ('0a000000-0000-0000-0000-0000000000ad','admin_a@a.test'),
  ('0a000000-0000-0000-0000-0000000000a1','mgr_a1@a.test'),
  ('0a000000-0000-0000-0000-0000000000a2','viewer_a1@a.test'),
  ('0a000000-0000-0000-0000-0000000000a3','mgr_a2@a.test'),
  ('0a000000-0000-0000-0000-0000000000c1','agency_u@a.test'),
  ('0a000000-0000-0000-0000-0000000000e0','member_x@a.test'),
  ('0a000000-0000-0000-0000-0000000000ed','editor_a@a.test'),
  ('0a000000-0000-0000-0000-0000000000ff','nobody@a.test'),
  ('0b000000-0000-0000-0000-000000000001','owner_b@b.test');

insert into public.profiles (id, email) values
  ('0a000000-0000-0000-0000-000000000001','owner_a@a.test'),
  ('0a000000-0000-0000-0000-000000000002','viewer_a@a.test'),
  ('0a000000-0000-0000-0000-0000000000ad','admin_a@a.test'),
  ('0a000000-0000-0000-0000-0000000000a1','mgr_a1@a.test'),
  ('0a000000-0000-0000-0000-0000000000a2','viewer_a1@a.test'),
  ('0a000000-0000-0000-0000-0000000000a3','mgr_a2@a.test'),
  ('0a000000-0000-0000-0000-0000000000c1','agency_u@a.test'),
  ('0a000000-0000-0000-0000-0000000000e0','member_x@a.test'),
  ('0a000000-0000-0000-0000-0000000000ed','editor_a@a.test'),
  ('0a000000-0000-0000-0000-0000000000ff','nobody@a.test'),
  ('0b000000-0000-0000-0000-000000000001','owner_b@b.test');

insert into public.tenants (id, name, slug) values
  ('11111111-1111-1111-1111-111111111111','Tenant A','tenant-a'),
  ('22222222-2222-2222-2222-222222222222','Tenant B','tenant-b');

insert into public.organizations (id, tenant_id, name) values
  ('1a1a1a1a-0000-0000-0000-000000000001','11111111-1111-1111-1111-111111111111','Org A1'),
  ('1a1a1a1a-0000-0000-0000-000000000002','11111111-1111-1111-1111-111111111111','Org A2'),
  ('1a1a1a1a-0000-0000-0000-000000000003','11111111-1111-1111-1111-111111111111','Org A3 (agency)'),
  ('1a1a1a1a-0000-0000-0000-0000000000cc','11111111-1111-1111-1111-111111111111','Central Procurement'),
  ('2b2b2b2b-0000-0000-0000-000000000001','22222222-2222-2222-2222-222222222222','Org B1');

-- Tenant-wide roles (owner_a, admin_a, viewer_a, owner_b). org-only users get NO tenant_membership.
-- member_x has NO membership of any kind (target for admin add-member test).
insert into public.tenant_memberships (tenant_id, user_id, role) values
  ('11111111-1111-1111-1111-111111111111','0a000000-0000-0000-0000-000000000001','owner'),
  ('11111111-1111-1111-1111-111111111111','0a000000-0000-0000-0000-0000000000ad','admin'),
  ('11111111-1111-1111-1111-111111111111','0a000000-0000-0000-0000-0000000000ed','editor'),
  ('11111111-1111-1111-1111-111111111111','0a000000-0000-0000-0000-000000000002','viewer'),
  ('22222222-2222-2222-2222-222222222222','0b000000-0000-0000-0000-000000000001','owner');

-- Org-scoped roles. owner_b also manages org B1 (used to prove the tenant binding,
-- not just plain non-membership, is what blocks the cross-tenant org-pointer leak).
insert into public.organization_memberships (organization_id, user_id, role) values
  ('1a1a1a1a-0000-0000-0000-000000000001','0a000000-0000-0000-0000-0000000000a1','manager'),
  ('1a1a1a1a-0000-0000-0000-000000000001','0a000000-0000-0000-0000-0000000000a2','viewer'),
  ('1a1a1a1a-0000-0000-0000-000000000002','0a000000-0000-0000-0000-0000000000a3','manager'),
  ('1a1a1a1a-0000-0000-0000-000000000003','0a000000-0000-0000-0000-0000000000c1','manager'), -- agency_u manages Org A3 only
  ('2b2b2b2b-0000-0000-0000-000000000001','0b000000-0000-0000-0000-000000000001','manager');

-- Apps: A1->orgA1, A2->orgA2, A_none->NULL org (tenant-wide only), B1->orgB1.
-- A_pay/A_proc are stewarded by A2 but related to agency A3 via paying / procurement
-- columns (used to prove related-org READ without granting A3 write).
insert into public.apps (id, tenant_id, name, responsible_org_id, paying_org_id, procurement_owner_org_id) values
  ('a9900000-0000-0000-0000-0000000000a1','11111111-1111-1111-1111-111111111111','App A1','1a1a1a1a-0000-0000-0000-000000000001',null,null),
  ('a9900000-0000-0000-0000-0000000000a2','11111111-1111-1111-1111-111111111111','App A2','1a1a1a1a-0000-0000-0000-000000000002',null,null),
  ('a9900000-0000-0000-0000-0000000000a0','11111111-1111-1111-1111-111111111111','App A-none',null,null,null),
  ('a9900000-0000-0000-0000-0000000000af','11111111-1111-1111-1111-111111111111','App A-pay','1a1a1a1a-0000-0000-0000-000000000002','1a1a1a1a-0000-0000-0000-000000000003',null),
  ('a9900000-0000-0000-0000-0000000000bf','11111111-1111-1111-1111-111111111111','App A-proc','1a1a1a1a-0000-0000-0000-000000000002',null,'1a1a1a1a-0000-0000-0000-000000000003'),
  ('b9900000-0000-0000-0000-0000000000b1','22222222-2222-2222-2222-222222222222','App B1','2b2b2b2b-0000-0000-0000-000000000001',null,null);

-- Contract A1 stewarded by org A1. Contract A-central models CENTRALIZED procurement:
-- procurement_org_id = Central Procurement (which agency_u is NOT in), paying_org_id = agency A3.
insert into public.contracts (id, tenant_id, contract_name, procurement_org_id, paying_org_id) values
  ('c0000000-0000-0000-0000-0000000000a1','11111111-1111-1111-1111-111111111111','Contract A1','1a1a1a1a-0000-0000-0000-000000000001',null),
  ('c0000000-0000-0000-0000-0000000000cc','11111111-1111-1111-1111-111111111111','Contract A-central','1a1a1a1a-0000-0000-0000-0000000000cc','1a1a1a1a-0000-0000-0000-000000000003');

insert into public.audit_logs (id, tenant_id, action, resource_type) values
  ('ad000000-0000-0000-0000-0000000000a1','11111111-1111-1111-1111-111111111111','app.create','apps');

-- Evidence rows in the remaining protected tables, so the destructive-delete tests (T24/T25)
-- act on rows that actually exist and are visible to the acting user.
insert into public.people (id, tenant_id, primary_email) values
  ('7e000000-0000-0000-0000-0000000000a1','11111111-1111-1111-1111-111111111111','person_a1@a.test');
insert into public.app_users (id, tenant_id, app_id, email) values
  ('a5000000-0000-0000-0000-0000000000a1','11111111-1111-1111-1111-111111111111',
   'a9900000-0000-0000-0000-0000000000a1','appuser_a1@a.test');
insert into public.app_contracts (app_id, contract_id, tenant_id) values
  ('a9900000-0000-0000-0000-0000000000a1','c0000000-0000-0000-0000-0000000000a1',
   '11111111-1111-1111-1111-111111111111');

-- ── Test 1: Tenant A user cannot read Tenant B; sees all of its own tenant ─────
select set_config('request.jwt.claims','{"sub":"0a000000-0000-0000-0000-000000000001"}',false);
set role authenticated;
do $$ declare v int; begin
  select count(*) into v from public.apps where tenant_id='22222222-2222-2222-2222-222222222222';
  assert v = 0, format('T1 cross-tenant read: tenant A owner saw %s tenant B apps', v);
  select count(*) into v from public.apps where tenant_id='11111111-1111-1111-1111-111111111111';
  assert v = 5, format('T1 tenant A owner should see 5 own apps, saw %s', v);
end $$;
reset role;

-- ── Test 2: Viewer can read but cannot edit ───────────────────────────────────
select set_config('request.jwt.claims','{"sub":"0a000000-0000-0000-0000-000000000002"}',false);
set role authenticated;
do $$ declare v int; begin
  select count(*) into v from public.apps where tenant_id='11111111-1111-1111-1111-111111111111';
  assert v = 5, format('T2 tenant viewer should read 5 apps, saw %s', v);
  update public.apps set notes='nope' where id='a9900000-0000-0000-0000-0000000000a1';
  get diagnostics v = row_count;
  assert v = 0, format('T2 tenant viewer edited an app (%s rows)', v);
end $$;
reset role;

-- ── Test 3+4: Org manager A1 edits ONLY org A1; no cross-org / cross-tenant ────
select set_config('request.jwt.claims','{"sub":"0a000000-0000-0000-0000-0000000000a1"}',false);
set role authenticated;
do $$ declare v int; begin
  -- exact-org edit succeeds
  update public.apps set notes='by-mgr-a1' where id='a9900000-0000-0000-0000-0000000000a1';
  get diagnostics v = row_count;
  assert v = 1, format('T3 org manager A1 should edit appA1 (%s rows)', v);
  -- sibling org (A2) edit blocked
  update public.apps set notes='x' where id='a9900000-0000-0000-0000-0000000000a2';
  get diagnostics v = row_count;
  assert v = 0, format('T4 org manager A1 edited org A2 app (%s rows)', v);
  -- other tenant (B1) edit blocked
  update public.apps set notes='x' where id='b9900000-0000-0000-0000-0000000000b1';
  get diagnostics v = row_count;
  assert v = 0, format('T4 org manager A1 edited tenant B app (%s rows)', v);
  -- org-only user does NOT inherit tenant-wide read: sees exactly its 1 org app
  select count(*) into v from public.apps;
  assert v = 1, format('T3 org manager A1 should see exactly 1 app, saw %s', v);
  -- ...and cannot see the NULL-org (tenant-wide) app
  select count(*) into v from public.apps where id='a9900000-0000-0000-0000-0000000000a0';
  assert v = 0, format('T3 org-only manager saw NULL-org app (%s rows)', v);
  -- can edit its org contract (contracts has no `notes` column; touch `status`)
  update public.contracts set status='active' where id='c0000000-0000-0000-0000-0000000000a1';
  get diagnostics v = row_count;
  assert v = 1, format('T3 org manager A1 should edit own org contract (%s rows)', v);
end $$;
-- escalation A: reassign appA1 into org A2 (unmanaged) must be blocked by WITH CHECK
do $$ declare v int; ok boolean := false; begin
  begin
    update public.apps set responsible_org_id='1a1a1a1a-0000-0000-0000-000000000002'
      where id='a9900000-0000-0000-0000-0000000000a1';
    get diagnostics v = row_count;
    ok := (v = 0);
  exception when insufficient_privilege or check_violation then ok := true;
  end;
  assert ok, 'T4 ESCALATION: org manager A1 reassigned appA1 into org A2';
end $$;
-- escalation B: manager A1 cannot self-grant a membership in org A2
do $$ declare ok boolean := false; begin
  begin
    insert into public.organization_memberships(organization_id,user_id,role)
      values ('1a1a1a1a-0000-0000-0000-000000000002','0a000000-0000-0000-0000-0000000000a1','manager');
    ok := false;
  exception when insufficient_privilege then ok := true;
  end;
  assert ok, 'T4 ESCALATION: org manager A1 self-granted membership in org A2';
end $$;
reset role;

-- ── Test 5: Org viewer reads its org resources but cannot edit ────────────────
select set_config('request.jwt.claims','{"sub":"0a000000-0000-0000-0000-0000000000a2"}',false);
set role authenticated;
do $$ declare v int; begin
  select count(*) into v from public.apps;
  assert v = 1, format('T5 org viewer A1 should see exactly 1 app, saw %s', v);
  select count(*) into v from public.apps where id='a9900000-0000-0000-0000-0000000000a1';
  assert v = 1, 'T5 org viewer A1 should read appA1';
  update public.apps set notes='x' where id='a9900000-0000-0000-0000-0000000000a1';
  get diagnostics v = row_count;
  assert v = 0, format('T5 org viewer A1 edited appA1 (%s rows)', v);
end $$;
reset role;

-- ── Test 6: Audit logs are append-only ────────────────────────────────────────
-- 6a: a normal tenant member cannot UPDATE or DELETE (RLS: no write policy).
select set_config('request.jwt.claims','{"sub":"0a000000-0000-0000-0000-000000000001"}',false);
set role authenticated;
do $$ declare v int; begin
  update public.audit_logs set action='tamper' where id='ad000000-0000-0000-0000-0000000000a1';
  get diagnostics v = row_count;
  assert v = 0, format('T6 normal user updated audit_logs (%s rows)', v);
  delete from public.audit_logs where id='ad000000-0000-0000-0000-0000000000a1';
  get diagnostics v = row_count;
  assert v = 0, format('T6 normal user deleted audit_logs (%s rows)', v);
end $$;
reset role;
-- 6b: even a BYPASSRLS service_role is blocked from UPDATE/DELETE by the trigger,
--     but CAN still INSERT (append-only, not write-only).
select set_config('request.jwt.claims','',false);
set role service_role;
do $$ declare ok boolean := false; begin
  begin
    delete from public.audit_logs where id='ad000000-0000-0000-0000-0000000000a1';
    ok := false;
  exception when insufficient_privilege then ok := true;
  end;
  assert ok, 'T6 service_role deleted append-only audit_logs';
end $$;
do $$ declare ok boolean := false; begin
  begin
    update public.audit_logs set action='tamper' where id='ad000000-0000-0000-0000-0000000000a1';
    ok := false;
  exception when insufficient_privilege then ok := true;
  end;
  assert ok, 'T6 service_role updated append-only audit_logs';
end $$;
do $$ begin
  insert into public.audit_logs(tenant_id, action, resource_type)
    values ('11111111-1111-1111-1111-111111111111','test.append','test');
  -- success expected (no exception)
end $$;
reset role;

-- ── Test 7: cross-tenant org-pointer leak is closed (Bug 1 regression) ─────────
-- 7a: an owner cannot stamp a foreign-tenant org onto a row (integrity trigger).
select set_config('request.jwt.claims','{"sub":"0b000000-0000-0000-0000-000000000001"}',false);
set role authenticated;
do $$ declare ok boolean := false; begin
  begin
    update public.apps set responsible_org_id='1a1a1a1a-0000-0000-0000-000000000001' -- org A1 (tenant A)
      where id='b9900000-0000-0000-0000-0000000000b1';                                -- app B1 (tenant B)
    ok := false;
  exception when check_violation then ok := true; end;
  assert ok, 'T7a tenant B owner stamped a tenant-A org onto a tenant-B app';
end $$;
reset role;
select set_config('request.jwt.claims','{"sub":"0a000000-0000-0000-0000-000000000001"}',false);
set role authenticated;
do $$ declare ok boolean := false; begin
  begin
    update public.contracts set procurement_org_id='2b2b2b2b-0000-0000-0000-000000000001' -- org B1 (tenant B)
      where id='c0000000-0000-0000-0000-0000000000a1';                                    -- contract A1 (tenant A)
    ok := false;
  exception when check_violation then ok := true; end;
  assert ok, 'T7b tenant A owner stamped a tenant-B org onto a tenant-A contract';
end $$;
reset role;
-- 7c: defense-in-depth — even if a corrupt cross-tenant pointer is planted (triggers
-- disabled to simulate), the READ policy's tenant binding still denies the leak. The
-- reader (owner_b) IS a member of org B1, so only the tenant binding — not plain
-- non-membership — can be what blocks it.
reset role;
set session_replication_role = replica;  -- bypass triggers to plant a corrupt row
insert into public.apps (id, tenant_id, name, responsible_org_id)
  values ('a9900000-0000-0000-0000-00000000beef','11111111-1111-1111-1111-111111111111','App leak','2b2b2b2b-0000-0000-0000-000000000001');
set session_replication_role = origin;
select set_config('request.jwt.claims','{"sub":"0b000000-0000-0000-0000-000000000001"}',false);
set role authenticated;
do $$ declare v int; begin
  select count(*) into v from public.apps where id='a9900000-0000-0000-0000-00000000beef';
  assert v = 0, format('T7c LEAK: org B1 member read a cross-tenant-pointed tenant-A app (%s)', v);
end $$;
reset role;
delete from public.apps where id='a9900000-0000-0000-0000-00000000beef';

-- ── Test 8: a normal user cannot forge (INSERT) an audit_logs row ─────────────
select set_config('request.jwt.claims','{"sub":"0a000000-0000-0000-0000-000000000001"}',false);
set role authenticated;
do $$ declare ok boolean := false; v int; begin
  begin
    insert into public.audit_logs(tenant_id, action, resource_type)
      values ('11111111-1111-1111-1111-111111111111','forged.entry','apps');
    get diagnostics v = row_count; ok := (v = 0);
  exception when insufficient_privilege then ok := true; end;
  assert ok, 'T8 normal user forged an audit_logs row';
end $$;
reset role;

-- ── Test 9: org-manager INSERT — own-org allowed; sibling/cross-tenant/spoof denied ─
select set_config('request.jwt.claims','{"sub":"0a000000-0000-0000-0000-0000000000a1"}',false);
set role authenticated;
do $$ declare v int; ok boolean; begin
  -- own org A1, correct tenant => allowed
  insert into public.apps(tenant_id,name,responsible_org_id)
    values ('11111111-1111-1111-1111-111111111111','mgr-a1-new','1a1a1a1a-0000-0000-0000-000000000001');
  get diagnostics v = row_count;
  assert v = 1, format('T9 org manager A1 should create an app in own org (%s rows)', v);
  -- sibling org A2 (unmanaged) => denied
  ok := false;
  begin insert into public.apps(tenant_id,name,responsible_org_id)
    values ('11111111-1111-1111-1111-111111111111','x','1a1a1a1a-0000-0000-0000-000000000002');
  exception when insufficient_privilege or check_violation then ok := true; end;
  assert ok, 'T9 ESCALATION: mgr A1 inserted app into sibling org A2';
  -- other tenant org B1 => denied
  ok := false;
  begin insert into public.apps(tenant_id,name,responsible_org_id)
    values ('22222222-2222-2222-2222-222222222222','x','2b2b2b2b-0000-0000-0000-000000000001');
  exception when insufficient_privilege or check_violation then ok := true; end;
  assert ok, 'T9 ESCALATION: mgr A1 inserted app into tenant B';
  -- tenant_id spoof: own org A1 but claim tenant B => denied (trigger + WITH CHECK)
  ok := false;
  begin insert into public.apps(tenant_id,name,responsible_org_id)
    values ('22222222-2222-2222-2222-222222222222','x','1a1a1a1a-0000-0000-0000-000000000001');
  exception when insufficient_privilege or check_violation then ok := true; end;
  assert ok, 'T9 ESCALATION: mgr A1 spoofed tenant_id on own-org insert';
end $$;
reset role;

-- ── Test 10: contracts org matrix (mirror of apps) ───────────────────────────
-- 10a: mgr A2 (other org) cannot read or edit org A1 contract.
select set_config('request.jwt.claims','{"sub":"0a000000-0000-0000-0000-0000000000a3"}',false);
set role authenticated;
do $$ declare v int; begin
  select count(*) into v from public.contracts where id='c0000000-0000-0000-0000-0000000000a1';
  assert v = 0, format('T10 cross-org: mgr A2 read org A1 contract (%s)', v);
  update public.contracts set status='hijacked' where id='c0000000-0000-0000-0000-0000000000a1';
  get diagnostics v = row_count;
  assert v = 0, format('T10 cross-org: mgr A2 edited org A1 contract (%s rows)', v);
end $$;
reset role;
-- 10b: org viewer A1 reads but cannot edit the contract.
select set_config('request.jwt.claims','{"sub":"0a000000-0000-0000-0000-0000000000a2"}',false);
set role authenticated;
do $$ declare v int; begin
  select count(*) into v from public.contracts where id='c0000000-0000-0000-0000-0000000000a1';
  assert v = 1, format('T10 org viewer A1 should read org A1 contract (%s)', v);
  update public.contracts set status='x' where id='c0000000-0000-0000-0000-0000000000a1';
  get diagnostics v = row_count;
  assert v = 0, format('T10 org viewer A1 edited contract (%s rows)', v);
end $$;
reset role;
-- 10c: mgr A1 cannot reassign its contract into unmanaged org A2.
select set_config('request.jwt.claims','{"sub":"0a000000-0000-0000-0000-0000000000a1"}',false);
set role authenticated;
do $$ declare ok boolean := false; v int; begin
  begin
    update public.contracts set procurement_org_id='1a1a1a1a-0000-0000-0000-000000000002'
      where id='c0000000-0000-0000-0000-0000000000a1';
    get diagnostics v = row_count; ok := (v = 0);
  exception when insufficient_privilege or check_violation then ok := true; end;
  assert ok, 'T10 ESCALATION: mgr A1 reassigned contract into org A2';
end $$;
reset role;

-- ── Test 11: org-only user baseline isolation (tenants + organizations) ───────
select set_config('request.jwt.claims','{"sub":"0a000000-0000-0000-0000-0000000000a1"}',false);
set role authenticated;
do $$ declare v int; begin
  select count(*) into v from public.tenants where id='11111111-1111-1111-1111-111111111111';
  assert v = 1, format('T11 org-only mgr A1 should read tenant A row (%s)', v);
  select count(*) into v from public.tenants where id='22222222-2222-2222-2222-222222222222';
  assert v = 0, format('T11 LEAK: org-only mgr A1 read tenant B row (%s)', v);
  select count(*) into v from public.organizations where id='1a1a1a1a-0000-0000-0000-000000000001';
  assert v = 1, format('T11 org-only mgr A1 should read own org A1 (%s)', v);
  select count(*) into v from public.organizations where id='1a1a1a1a-0000-0000-0000-000000000002';
  assert v = 0, format('T11 LEAK: org-only mgr A1 read sibling org A2 (%s)', v);
  select count(*) into v from public.organizations where id='2b2b2b2b-0000-0000-0000-000000000001';
  assert v = 0, format('T11 LEAK: org-only mgr A1 read cross-tenant org B1 (%s)', v);
end $$;
reset role;

-- ── Test 12: org manager cannot write organization_memberships in its OWN org ─
select set_config('request.jwt.claims','{"sub":"0a000000-0000-0000-0000-0000000000a1"}',false);
set role authenticated;
do $$ declare ok boolean := false; v int; begin
  begin
    insert into public.organization_memberships(organization_id,user_id,role)
      values ('1a1a1a1a-0000-0000-0000-000000000001','0a000000-0000-0000-0000-0000000000a3','manager');
    ok := false;
  exception when insufficient_privilege then ok := true; end;
  assert ok, 'T12 ESCALATION: mgr A1 added a member to its own org A1';
  update public.organization_memberships set role='manager'
    where organization_id='1a1a1a1a-0000-0000-0000-000000000001' and user_id='0a000000-0000-0000-0000-0000000000a2';
  get diagnostics v = row_count;
  assert v = 0, format('T12 ESCALATION: mgr A1 promoted a viewer in its own org (%s rows)', v);
end $$;
reset role;

-- ── Test 13: organization_memberships read isolation ─────────────────────────
select set_config('request.jwt.claims','{"sub":"0a000000-0000-0000-0000-0000000000a1"}',false);
set role authenticated;
do $$ declare v int; begin
  select count(*) into v from public.organization_memberships;
  assert v = 1, format('T13 org mgr A1 should see only own membership row (%s)', v);
end $$;
reset role;
select set_config('request.jwt.claims','{"sub":"0b000000-0000-0000-0000-000000000001"}',false);
set role authenticated;
do $$ declare v int; begin
  select count(*) into v from public.organization_memberships
    where organization_id in ('1a1a1a1a-0000-0000-0000-000000000001','1a1a1a1a-0000-0000-0000-000000000002');
  assert v = 0, format('T13 LEAK: tenant B owner read tenant A org memberships (%s)', v);
end $$;
reset role;
select set_config('request.jwt.claims','{"sub":"0a000000-0000-0000-0000-000000000001"}',false);
set role authenticated;
do $$ declare v int; begin
  select count(*) into v from public.organization_memberships
    where organization_id='1a1a1a1a-0000-0000-0000-000000000001';
  assert v = 2, format('T13 tenant A owner should read 2 memberships in org A1 (%s)', v);
end $$;
reset role;

-- ── Test 14: cross-tenant WRITE denial for a tenant-wide role ────────────────
select set_config('request.jwt.claims','{"sub":"0a000000-0000-0000-0000-000000000001"}',false);
set role authenticated;
do $$ declare v int; begin
  update public.apps set notes='owner-a-hijack' where id='b9900000-0000-0000-0000-0000000000b1';
  get diagnostics v = row_count;
  assert v = 0, format('T14 tenant A owner updated a tenant B app (%s rows)', v);
  update public.contracts set status='x' where tenant_id='22222222-2222-2222-2222-222222222222';
  get diagnostics v = row_count;
  assert v = 0, format('T14 tenant A owner updated tenant B contracts (%s rows)', v);
end $$;
reset role;

-- ── Test 15: NULL-org policy composition (tenant editor vs org manager) ───────
select set_config('request.jwt.claims','{"sub":"0a000000-0000-0000-0000-0000000000a1"}',false);
set role authenticated;
do $$ declare v int; begin
  update public.apps set notes='x' where id='a9900000-0000-0000-0000-0000000000a0';  -- NULL-org app
  get diagnostics v = row_count;
  assert v = 0, format('T15 org-only mgr A1 wrote a NULL-org tenant-wide app (%s rows)', v);
end $$;
reset role;
select set_config('request.jwt.claims','{"sub":"0a000000-0000-0000-0000-000000000001"}',false);
set role authenticated;
do $$ declare v int; begin
  update public.apps set notes='by-owner' where id='a9900000-0000-0000-0000-0000000000a0';
  get diagnostics v = row_count;
  assert v = 1, format('T15 tenant owner should write NULL-org app (%s rows)', v);
  update public.apps set notes='by-owner2' where id='a9900000-0000-0000-0000-0000000000a1';
  get diagnostics v = row_count;
  assert v = 1, format('T15 tenant owner should write org-owned app A1 (%s rows)', v);
end $$;
reset role;

-- ── Test 16: tenant-membership escalation is closed (Bug 2 regression) ────────
-- 16a: admin cannot self-promote to owner, cannot demote the owner, cannot create an owner.
select set_config('request.jwt.claims','{"sub":"0a000000-0000-0000-0000-0000000000ad"}',false);
set role authenticated;
do $$ declare v int; ok boolean; begin
  -- self-promote to owner: blocked. The own row qualifies under "admins manage
  -- non-owner" USING but fails its WITH CHECK (role='owner'), so RLS RAISES rather
  -- than silently filtering — accept either an error or 0 rows.
  ok := false;
  begin
    update public.tenant_memberships set role='owner'
      where tenant_id='11111111-1111-1111-1111-111111111111' and user_id='0a000000-0000-0000-0000-0000000000ad';
    get diagnostics v = row_count; ok := (v = 0);
  exception when insufficient_privilege then ok := true; end;
  assert ok, 'T16 ESCALATION: admin self-promoted to owner';
  -- demote the owner: blocked (owner row excluded by USING => 0 rows).
  ok := false;
  begin
    update public.tenant_memberships set role='viewer'
      where tenant_id='11111111-1111-1111-1111-111111111111' and user_id='0a000000-0000-0000-0000-000000000001';
    get diagnostics v = row_count; ok := (v = 0);
  exception when insufficient_privilege then ok := true; end;
  assert ok, 'T16 ESCALATION: admin demoted the owner';
  -- create an owner membership: blocked.
  ok := false;
  begin insert into public.tenant_memberships(tenant_id,user_id,role)
    values ('11111111-1111-1111-1111-111111111111','0a000000-0000-0000-0000-0000000000e0','owner');
  exception when insufficient_privilege then ok := true; end;
  assert ok, 'T16 ESCALATION: admin created an owner membership';
  -- 16b: admin CAN add a normal (non-owner) member.
  insert into public.tenant_memberships(tenant_id,user_id,role)
    values ('11111111-1111-1111-1111-111111111111','0a000000-0000-0000-0000-0000000000e0','editor');
  get diagnostics v = row_count;
  assert v = 1, format('T16 admin should add a non-owner member (%s rows)', v);
end $$;
reset role;
-- 16c: an owner CAN promote an admin to owner (positive control).
select set_config('request.jwt.claims','{"sub":"0a000000-0000-0000-0000-000000000001"}',false);
set role authenticated;
do $$ declare v int; begin
  update public.tenant_memberships set role='owner'
    where tenant_id='11111111-1111-1111-1111-111111111111' and user_id='0a000000-0000-0000-0000-0000000000ad';
  get diagnostics v = row_count;
  assert v = 1, format('T16 owner should be able to promote an admin to owner (%s rows)', v);
end $$;
reset role;

-- ── Test 18: related-org READ via paying_org_id (0003 union) ─────────────────
-- agency_u manages only Org A3; App A-pay is stewarded by A2 but paid by A3.
select set_config('request.jwt.claims','{"sub":"0a000000-0000-0000-0000-0000000000c1"}',false);
set role authenticated;
do $$ declare v int; begin
  select count(*) into v from public.apps where id='a9900000-0000-0000-0000-0000000000af';
  assert v = 1, format('T18 agency should READ app via paying_org_id (%s)', v);
  select count(*) into v from public.apps where id='a9900000-0000-0000-0000-0000000000a1';
  assert v = 0, format('T18 agency should NOT read an unrelated app (%s)', v);
  select count(*) into v from public.apps;  -- only A-pay (paying) + A-proc (procurement)
  assert v = 2, format('T18 agency should see exactly its 2 related apps (%s)', v);
end $$;
reset role;

-- ── Test 19: related-org READ via procurement_owner_org_id (0003 union) ──────
select set_config('request.jwt.claims','{"sub":"0a000000-0000-0000-0000-0000000000c1"}',false);
set role authenticated;
do $$ declare v int; begin
  select count(*) into v from public.apps where id='a9900000-0000-0000-0000-0000000000bf';
  assert v = 1, format('T19 agency should READ app via procurement_owner_org_id (%s)', v);
end $$;
reset role;

-- ── Test 20: centralized procurement — agency reads contract via paying_org_id ─
-- Contract A-central is procured by Central Procurement (agency_u is NOT a member),
-- paid by agency A3. Single-column procurement scoping would hide it; the union shows it.
select set_config('request.jwt.claims','{"sub":"0a000000-0000-0000-0000-0000000000c1"}',false);
set role authenticated;
do $$ declare v int; begin
  select count(*) into v from public.contracts where id='c0000000-0000-0000-0000-0000000000cc';
  assert v = 1, format('T20 agency should READ contract via paying_org_id under central procurement (%s)', v);
  select count(*) into v from public.contracts where id='c0000000-0000-0000-0000-0000000000a1';
  assert v = 0, format('T20 agency should NOT read an unrelated contract (%s)', v);
  select count(*) into v from public.contracts;
  assert v = 1, format('T20 agency should see exactly its 1 related contract (%s)', v);
end $$;
reset role;

-- ── Test 21: related (paying/procurement) does NOT grant write — steward only ─
select set_config('request.jwt.claims','{"sub":"0a000000-0000-0000-0000-0000000000c1"}',false);
set role authenticated;
do $$ declare v int; begin
  update public.apps set notes='x' where id='a9900000-0000-0000-0000-0000000000af';      -- steward = A2
  get diagnostics v = row_count;
  assert v = 0, format('T21 paying-related agency wrote a non-steward app (%s rows)', v);
  update public.contracts set status='x' where id='c0000000-0000-0000-0000-0000000000cc'; -- steward = Central Proc
  get diagnostics v = row_count;
  assert v = 0, format('T21 paying-related agency wrote a non-steward contract (%s rows)', v);
end $$;
reset role;

-- ── Test 22+23: trigger tenant-binds the broadened org columns ────────────────
select set_config('request.jwt.claims','{"sub":"0a000000-0000-0000-0000-000000000001"}',false);
set role authenticated;
do $$ declare ok boolean := false; begin
  begin
    update public.apps set paying_org_id='2b2b2b2b-0000-0000-0000-000000000001' -- org B1 (tenant B)
      where id='a9900000-0000-0000-0000-0000000000a1';
    ok := false;
  exception when check_violation then ok := true; end;
  assert ok, 'T22 foreign-tenant paying_org_id was not blocked by the trigger';
end $$;
do $$ declare ok boolean := false; begin
  begin
    update public.apps set procurement_owner_org_id='2b2b2b2b-0000-0000-0000-000000000001'
      where id='a9900000-0000-0000-0000-0000000000a1';
    ok := false;
  exception when check_violation then ok := true; end;
  assert ok, 'T23 foreign-tenant procurement_owner_org_id was not blocked by the trigger';
end $$;
reset role;

-- ── Test 17 (DESTRUCTIVE, run last): org-manager DELETE scope ─────────────────
-- 0004 removed org-manager hard-delete entirely: own-org, cross-org, and cross-tenant
-- DELETE are ALL denied now (no DELETE policy on apps -> 0 rows for every authenticated role).
select set_config('request.jwt.claims','{"sub":"0a000000-0000-0000-0000-0000000000a1"}',false);
set role authenticated;
do $$ declare v int; begin
  delete from public.apps where id='a9900000-0000-0000-0000-0000000000a2';  -- org A2
  get diagnostics v = row_count;
  assert v = 0, format('T17 cross-org: mgr A1 deleted org A2 app (%s rows)', v);
  delete from public.apps where id='b9900000-0000-0000-0000-0000000000b1';  -- tenant B
  get diagnostics v = row_count;
  assert v = 0, format('T17 cross-tenant: mgr A1 deleted tenant B app (%s rows)', v);
  delete from public.apps where id='a9900000-0000-0000-0000-0000000000a1';  -- own org A1
  get diagnostics v = row_count;
  assert v = 0, format('T17 own-org delete is now removed (0004): mgr A1 deleted its org app (%s rows)', v);
end $$;
reset role;

-- ── Test 24: protected core tables reject hard-delete (0004 destructive-delete hardening) ──
-- apps/contracts/organizations/app_contracts/people/app_users have NO DELETE policy, so a
-- DELETE affects 0 rows for every authenticated role and the evidence row survives.
-- 24a: tenant OWNER (highest tenant role) cannot delete any protected row.
select set_config('request.jwt.claims','{"sub":"0a000000-0000-0000-0000-000000000001"}',false);
set role authenticated;
do $$ declare v int; begin
  delete from public.apps          where id='a9900000-0000-0000-0000-0000000000a1';
  get diagnostics v = row_count; assert v = 0, format('T24 owner deleted app (%s)', v);
  delete from public.contracts     where id='c0000000-0000-0000-0000-0000000000a1';
  get diagnostics v = row_count; assert v = 0, format('T24 owner deleted contract (%s)', v);
  delete from public.organizations where id='1a1a1a1a-0000-0000-0000-000000000001';
  get diagnostics v = row_count; assert v = 0, format('T24 owner deleted organization (%s)', v);
  delete from public.app_contracts where app_id='a9900000-0000-0000-0000-0000000000a1';
  get diagnostics v = row_count; assert v = 0, format('T24 owner deleted app_contract (%s)', v);
  delete from public.people        where id='7e000000-0000-0000-0000-0000000000a1';
  get diagnostics v = row_count; assert v = 0, format('T24 owner deleted person (%s)', v);
  delete from public.app_users     where id='a5000000-0000-0000-0000-0000000000a1';
  get diagnostics v = row_count; assert v = 0, format('T24 owner deleted app_user (%s)', v);
  -- evidence rows survived:
  assert (select count(*) from public.apps where id='a9900000-0000-0000-0000-0000000000a1') = 1, 'T24 app must survive';
  assert (select count(*) from public.people where id='7e000000-0000-0000-0000-0000000000a1') = 1, 'T24 person must survive';
  assert (select count(*) from public.app_users where id='a5000000-0000-0000-0000-0000000000a1') = 1, 'T24 app_user must survive';
end $$;
reset role;
-- 24b: tenant ADMIN is likewise denied DELETE.
select set_config('request.jwt.claims','{"sub":"0a000000-0000-0000-0000-0000000000ad"}',false);
set role authenticated;
do $$ declare v int; begin
  delete from public.apps where id='a9900000-0000-0000-0000-0000000000a1';
  get diagnostics v = row_count; assert v = 0, format('T24 admin deleted app (%s)', v);
end $$;
reset role;
-- 24c: tenant EDITOR keeps UPDATE (write access preserved) but is denied DELETE.
select set_config('request.jwt.claims','{"sub":"0a000000-0000-0000-0000-0000000000ed"}',false);
set role authenticated;
do $$ declare v int; begin
  update public.apps set notes='editor-edit' where id='a9900000-0000-0000-0000-0000000000a1';
  get diagnostics v = row_count; assert v = 1, format('T24 editor UPDATE must still work (%s)', v);
  delete from public.apps where id='a9900000-0000-0000-0000-0000000000a1';
  get diagnostics v = row_count; assert v = 0, format('T24 editor deleted app (%s)', v);
end $$;
reset role;

-- ── Test 25: reads (app inventory + detail) still valid after delete-hardening ──
-- The /apps and /apps/[id] DAL reads continue to return RLS-scoped rows (no read regression).
-- 25a: tenant member reads all 5 tenant apps (inventory) + single app/contract by id (detail).
select set_config('request.jwt.claims','{"sub":"0a000000-0000-0000-0000-000000000001"}',false);
set role authenticated;
do $$ declare v int; begin
  -- count the 5 seed apps by id (deterministic; earlier INSERT tests add apps to this tenant).
  select count(*) into v from public.apps where id in (
    'a9900000-0000-0000-0000-0000000000a1','a9900000-0000-0000-0000-0000000000a2',
    'a9900000-0000-0000-0000-0000000000a0','a9900000-0000-0000-0000-0000000000af',
    'a9900000-0000-0000-0000-0000000000bf');
  assert v = 5, format('T25 owner inventory read should see all 5 seed apps, saw %s', v);
  select count(*) into v from public.apps where id='a9900000-0000-0000-0000-0000000000a1';
  assert v = 1, format('T25 owner detail read of App A1 should be 1, saw %s', v);
  select count(*) into v from public.contracts where id='c0000000-0000-0000-0000-0000000000a1';
  assert v = 1, format('T25 owner detail read of Contract A1 should be 1, saw %s', v);
end $$;
reset role;
-- 25b: org-only manager still reads its related app by id (org-scoped detail).
select set_config('request.jwt.claims','{"sub":"0a000000-0000-0000-0000-0000000000a1"}',false);
set role authenticated;
do $$ declare v int; begin
  select count(*) into v from public.apps where id='a9900000-0000-0000-0000-0000000000a1';
  assert v = 1, format('T25 org mgr A1 detail read of own-org App A1 should be 1, saw %s', v);
end $$;
reset role;

-- ── Test 26: same-tenant child integrity (migration 0005) ────────────────────
-- Constraint layer (run as the privileged role; RLS bypassed). A child/link row may not
-- reference a parent in another tenant. TenantA=1111…, TenantB=2222… (both seeded).
reset role;

-- 26a: VALID same-tenant child rows insert. ON_ERROR_STOP aborts the run if any fails, so these
-- lines double as positive assertions that valid same-tenant links still work.
insert into public.license_rules (id, tenant_id, app_id, name) values
  ('11000000-0000-0000-0000-0000000000a1','11111111-1111-1111-1111-111111111111','a9900000-0000-0000-0000-0000000000a1','Rule A1');
insert into public.license_evaluations (id, tenant_id, app_id, app_user_id, license_rule_id) values
  ('12000000-0000-0000-0000-0000000000a1','11111111-1111-1111-1111-111111111111','a9900000-0000-0000-0000-0000000000a1','a5000000-0000-0000-0000-0000000000a1','11000000-0000-0000-0000-0000000000a1');
insert into public.files (id, tenant_id, storage_path, original_filename) values
  ('13000000-0000-0000-0000-0000000000a1','11111111-1111-1111-1111-111111111111','/demo/a1.pdf','a1.pdf');
insert into public.invoices (id, tenant_id, file_id, app_id, contract_id) values
  ('14000000-0000-0000-0000-0000000000a1','11111111-1111-1111-1111-111111111111','13000000-0000-0000-0000-0000000000a1','a9900000-0000-0000-0000-0000000000a1','c0000000-0000-0000-0000-0000000000a1');
-- nullable invoice (all parent refs NULL) — proves MATCH SIMPLE keeps nullable links valid.
insert into public.invoices (id, tenant_id) values
  ('14000000-0000-0000-0000-0000000000a2','11111111-1111-1111-1111-111111111111');
-- valid same-tenant identity_account (child of people via person_id).
insert into public.identity_accounts (id, tenant_id, person_id, provider, email) values
  ('16000000-0000-0000-0000-0000000000a1','11111111-1111-1111-1111-111111111111','7e000000-0000-0000-0000-0000000000a1','okta','ia_a1@a.test');
-- valid same-tenant org parent (Org A1's parent = Org A2, both tenant A).
update public.organizations set parent_org_id = '1a1a1a1a-0000-0000-0000-000000000002'
  where id = '1a1a1a1a-0000-0000-0000-000000000001';
-- valid tenant-B app_user (child of App B1) — exists only to isolate the license_rule_id
-- cross-tenant FK below: its app_id+app_user_id are valid tenant-B, so license_rule_id is the sole violation.
insert into public.app_users (id, tenant_id, app_id) values
  ('a5000000-0000-0000-0000-0000000000b1','22222222-2222-2222-2222-222222222222','b9900000-0000-0000-0000-0000000000b1');

-- 26b: CROSS-TENANT links must each fail with foreign_key_violation (11 of them).
do $$ declare n int := 0; begin
  begin
    insert into public.app_contracts (app_id, contract_id, tenant_id) values
      ('a9900000-0000-0000-0000-0000000000a2','c0000000-0000-0000-0000-0000000000cc','22222222-2222-2222-2222-222222222222');
    raise exception 'T26 app_contracts cross-tenant link was allowed';
  exception when foreign_key_violation then n := n + 1; end;
  begin
    insert into public.app_users (id, tenant_id, app_id) values
      ('a5000000-0000-0000-0000-0000000000b9','22222222-2222-2222-2222-222222222222','a9900000-0000-0000-0000-0000000000a1');
    raise exception 'T26 app_users cross-tenant link was allowed';
  exception when foreign_key_violation then n := n + 1; end;
  begin
    insert into public.app_user_identity_matches (id, tenant_id, app_user_id, person_id, match_method) values
      ('15000000-0000-0000-0000-0000000000b9','22222222-2222-2222-2222-222222222222','a5000000-0000-0000-0000-0000000000a1','7e000000-0000-0000-0000-0000000000a1','email');
    raise exception 'T26 auim cross-tenant link was allowed';
  exception when foreign_key_violation then n := n + 1; end;
  begin
    insert into public.license_rules (id, tenant_id, app_id, name) values
      ('11000000-0000-0000-0000-0000000000b9','22222222-2222-2222-2222-222222222222','a9900000-0000-0000-0000-0000000000a1','Bad');
    raise exception 'T26 license_rules cross-tenant link was allowed';
  exception when foreign_key_violation then n := n + 1; end;
  begin
    insert into public.license_evaluations (id, tenant_id, app_id, app_user_id) values
      ('12000000-0000-0000-0000-0000000000b9','22222222-2222-2222-2222-222222222222','a9900000-0000-0000-0000-0000000000a1','a5000000-0000-0000-0000-0000000000a1');
    raise exception 'T26 license_evaluations cross-tenant link was allowed';
  exception when foreign_key_violation then n := n + 1; end;
  begin
    -- license_rule_id path isolated: tenant-B eval, valid tenant-B app_id+app_user_id, tenant-A rule.
    insert into public.license_evaluations (id, tenant_id, app_id, app_user_id, license_rule_id) values
      ('12000000-0000-0000-0000-0000000000ba','22222222-2222-2222-2222-222222222222','b9900000-0000-0000-0000-0000000000b1','a5000000-0000-0000-0000-0000000000b1','11000000-0000-0000-0000-0000000000a1');
    raise exception 'T26 license_evaluations.license_rule cross-tenant link was allowed';
  exception when foreign_key_violation then n := n + 1; end;
  begin
    insert into public.invoices (id, tenant_id, file_id) values
      ('14000000-0000-0000-0000-0000000000b9','22222222-2222-2222-2222-222222222222','13000000-0000-0000-0000-0000000000a1');
    raise exception 'T26 invoices.file cross-tenant link was allowed';
  exception when foreign_key_violation then n := n + 1; end;
  begin
    insert into public.invoices (id, tenant_id, app_id) values
      ('14000000-0000-0000-0000-0000000000ba','22222222-2222-2222-2222-222222222222','a9900000-0000-0000-0000-0000000000a1');
    raise exception 'T26 invoices.app cross-tenant link was allowed';
  exception when foreign_key_violation then n := n + 1; end;
  begin
    insert into public.invoices (id, tenant_id, contract_id) values
      ('14000000-0000-0000-0000-0000000000bb','22222222-2222-2222-2222-222222222222','c0000000-0000-0000-0000-0000000000a1');
    raise exception 'T26 invoices.contract cross-tenant link was allowed';
  exception when foreign_key_violation then n := n + 1; end;
  begin
    insert into public.identity_accounts (id, tenant_id, person_id, provider, email) values
      ('16000000-0000-0000-0000-0000000000b9','22222222-2222-2222-2222-222222222222','7e000000-0000-0000-0000-0000000000a1','okta','bad@b.test');
    raise exception 'T26 identity_accounts cross-tenant link was allowed';
  exception when foreign_key_violation then n := n + 1; end;
  begin
    update public.organizations set parent_org_id = '2b2b2b2b-0000-0000-0000-000000000001'  -- Org B1 (tenant B)
      where id = '1a1a1a1a-0000-0000-0000-000000000001';                                     -- Org A1 (tenant A)
    raise exception 'T26 organizations cross-tenant parent link was allowed';
  exception when foreign_key_violation then n := n + 1; end;
  assert n = 11, format('T26 expected 11 cross-tenant FK rejections, got %s', n);
end $$;

-- 26c: a valid same-tenant identity match still inserts (after the cross-tenant attempt failed).
insert into public.app_user_identity_matches (id, tenant_id, app_user_id, person_id, match_method) values
  ('15000000-0000-0000-0000-0000000000a1','11111111-1111-1111-1111-111111111111','a5000000-0000-0000-0000-0000000000a1','7e000000-0000-0000-0000-0000000000a1','email');
reset role;

-- ── Test 27: child/link READ-scope truth pass (PR #18) ───────────────────────
-- Asserts the CURRENT read reality — adds NO policy and broadens NO access. Guards against a
-- future change silently making a default-deny table readable or surfacing a tenant-only child
-- table as if it were org-scoped. Canonical inventory: docs/02_SECURITY_AND_RLS.md §8.
-- By now every default-deny table has ≥1 tenant-A row (seeded in fixtures / T26), so a 0 count
-- proves the *policy* hides it, not an empty table.

-- 27a: DEFAULT-DENY tables (RLS on, NO policy) are unreadable even by a tenant OWNER.
select set_config('request.jwt.claims','{"sub":"0a000000-0000-0000-0000-000000000001"}',false); -- owner_a (tenant A owner)
set role authenticated;
do $$ declare v int; begin
  select count(*) into v from public.identity_accounts;         assert v = 0, format('T27 owner_a saw %s identity_accounts (default-deny)', v);
  -- NOTE: app_user_identity_matches is NO LONGER default-deny — PR #23 / 0008 made it org-scoped read
  -- (a tenant member reads it transitively via reading all tenant app_users). Its read behavior is
  -- proven in T30 below; identity_accounts stays default-deny (asserted above).
  select count(*) into v from public.license_rules;             assert v = 0, format('T27 owner_a saw %s license_rules (default-deny)', v);
  select count(*) into v from public.license_evaluations;       assert v = 0, format('T27 owner_a saw %s license_evaluations (default-deny)', v);
  -- NOTE: `files` is NO LONGER default-deny — PR #35 / 0013 added a tenant-member SELECT policy, so a
  -- tenant member now reads their tenant's files (proven below + in T34). identity_accounts / invoices
  -- / license_* stay default-deny (asserted here).
  select count(*) into v from public.invoices;                  assert v = 0, format('T27 owner_a saw %s invoices (default-deny)', v);
  -- positive control: the SAME owner DOES read the tenant-readable child tables (so the 0s above are policy, not empty tables)
  select count(*) into v from public.people        where tenant_id='11111111-1111-1111-1111-111111111111'; assert v >= 1, format('T27 owner_a should read tenant people, saw %s', v);
  select count(*) into v from public.app_users     where tenant_id='11111111-1111-1111-1111-111111111111'; assert v >= 1, format('T27 owner_a should read tenant app_users, saw %s', v);
  select count(*) into v from public.app_contracts where tenant_id='11111111-1111-1111-1111-111111111111'; assert v >= 1, format('T27 owner_a should read tenant app_contracts, saw %s', v);
  select count(*) into v from public.files         where tenant_id='11111111-1111-1111-1111-111111111111'; assert v >= 1, format('T27 owner_a should read tenant files (0013 tenant-member read), saw %s', v);
end $$;
reset role;

-- 27b: TENANT-READ-NOT-ORG-SCOPED tables (people) are is_tenant_member-gated, so an ORG-ONLY user
-- (mgr_a1, no tenant membership) reads ZERO from them — they are NOT org-scoped and must not be
-- surfaced to org-only users until org-scoped read policies exist (RISK-002).
-- NOTE: app_contracts (PR #20 / 0006) and app_users (PR #21 / 0007) are NO LONGER in this list —
-- both are org-scoped for READ; their org-only read behavior is proven in T28 / T29 below.
select set_config('request.jwt.claims','{"sub":"0a000000-0000-0000-0000-0000000000a1"}',false); -- mgr_a1 (org-only, manages Org A1)
set role authenticated;
do $$ declare v int; begin
  select count(*) into v from public.people;        assert v = 0, format('T27 org-only mgr_a1 saw %s people (not org-scoped)', v);
  select count(*) into v from public.files;         assert v = 0, format('T27 org-only mgr_a1 saw %s files (tenant-member read; org-only excluded — 0013)', v);
  select count(*) into v from public.invoices;      assert v = 0, format('T27 org-only mgr_a1 saw %s invoices (default-deny)', v);
  -- positive control: mgr_a1 CAN read its own-org App A1 (proves a valid org session, not always-0)
  select count(*) into v from public.apps where id='a9900000-0000-0000-0000-0000000000a1'; assert v = 1, format('T27 org-only mgr_a1 should read own-org App A1, saw %s', v);
end $$;
reset role;

-- ── Test 28: org-scoped READ for app_contracts (migration 0006, PR #20) ──────────────────────
-- app_contracts gains ONE org-scoped SELECT policy: an org-only user may read a link row iff they
-- can already read the linked APP or the linked CONTRACT under their related-org RLS. Existing
-- tenant-member read + editor insert/update are unchanged; NO delete policy added.
-- Links (privileged seed; L1 already in fixtures): tenant A.
--   L1 = App A1 (resp OrgA1)      + Contract A1 (proc OrgA1)         -> mgr_a1 via BOTH; agency_u NEITHER
--   L2 = App A-pay (paying OrgA3) + Contract A-central (paying OrgA3)-> agency_u via BOTH; mgr_a1 NEITHER
--   L3 = App A1 (resp OrgA1)      + Contract A-central (paying OrgA3)-> mgr_a1 via APP side; agency_u via CONTRACT side
reset role;
insert into public.app_contracts (app_id, contract_id, tenant_id) values
  ('a9900000-0000-0000-0000-0000000000af','c0000000-0000-0000-0000-0000000000cc','11111111-1111-1111-1111-111111111111'),  -- L2
  ('a9900000-0000-0000-0000-0000000000a1','c0000000-0000-0000-0000-0000000000cc','11111111-1111-1111-1111-111111111111');  -- L3

-- 28a: tenant owner reads ALL 3 tenant links (via the existing tenant-member policy).
select set_config('request.jwt.claims','{"sub":"0a000000-0000-0000-0000-000000000001"}',false); -- owner_a
set role authenticated;
do $$ declare v int; begin
  select count(*) into v from public.app_contracts where tenant_id='11111111-1111-1111-1111-111111111111';
  assert v = 3, format('T28 owner_a should read all 3 tenant app_contract links, saw %s', v);
end $$;
reset role;

-- 28b: org-only mgr_a1 (Org A1) reads ONLY links tied to apps/contracts it can read: L1 (both sides)
-- + L3 (app side, App A1). NOT L2 (related to neither App A-pay nor Contract A-central).
select set_config('request.jwt.claims','{"sub":"0a000000-0000-0000-0000-0000000000a1"}',false); -- mgr_a1
set role authenticated;
do $$ declare v int; begin
  select count(*) into v from public.app_contracts; assert v = 2, format('T28 mgr_a1 should read 2 related links, saw %s', v);
  select count(*) into v from public.app_contracts where app_id='a9900000-0000-0000-0000-0000000000a1' and contract_id='c0000000-0000-0000-0000-0000000000a1'; assert v = 1, format('T28 mgr_a1 should read L1 (App A1+Contract A1), saw %s', v);
  select count(*) into v from public.app_contracts where app_id='a9900000-0000-0000-0000-0000000000a1' and contract_id='c0000000-0000-0000-0000-0000000000cc'; assert v = 1, format('T28 mgr_a1 should read L3 via App A1 side, saw %s', v);
  select count(*) into v from public.app_contracts where app_id='a9900000-0000-0000-0000-0000000000af' and contract_id='c0000000-0000-0000-0000-0000000000cc'; assert v = 0, format('T28 mgr_a1 must NOT read unrelated L2, saw %s', v);
end $$;
reset role;

-- 28c: org-only agency_u (Org A3) reads ONLY its related links: L2 (both sides) + L3 (contract side,
-- Contract A-central). NOT L1 (related to neither App A1 nor Contract A1). Proves the CONTRACT-side branch.
select set_config('request.jwt.claims','{"sub":"0a000000-0000-0000-0000-0000000000c1"}',false); -- agency_u
set role authenticated;
do $$ declare v int; begin
  select count(*) into v from public.app_contracts; assert v = 2, format('T28 agency_u should read 2 related links, saw %s', v);
  select count(*) into v from public.app_contracts where app_id='a9900000-0000-0000-0000-0000000000af' and contract_id='c0000000-0000-0000-0000-0000000000cc'; assert v = 1, format('T28 agency_u should read L2, saw %s', v);
  select count(*) into v from public.app_contracts where app_id='a9900000-0000-0000-0000-0000000000a1' and contract_id='c0000000-0000-0000-0000-0000000000cc'; assert v = 1, format('T28 agency_u should read L3 via Contract A-central side, saw %s', v);
  select count(*) into v from public.app_contracts where app_id='a9900000-0000-0000-0000-0000000000a1' and contract_id='c0000000-0000-0000-0000-0000000000a1'; assert v = 0, format('T28 agency_u must NOT read unrelated L1, saw %s', v);
end $$;
reset role;

-- 28d: owner_b (other tenant) and nobody (no membership of any kind) read ZERO links — no cross-tenant
-- leak, and the new policy grants nothing to a pure non-member. (member_x is NOT used here — the T16
-- admin-add-member test promotes it to a tenant editor, so it is a member by now.)
select set_config('request.jwt.claims','{"sub":"0b000000-0000-0000-0000-000000000001"}',false); -- owner_b (tenant B)
set role authenticated;
do $$ declare v int; begin
  select count(*) into v from public.app_contracts; assert v = 0, format('T28 owner_b (tenant B) must read 0 tenant-A links, saw %s', v);
end $$;
reset role;
select set_config('request.jwt.claims','{"sub":"0a000000-0000-0000-0000-0000000000ff"}',false); -- nobody (no membership)
set role authenticated;
do $$ declare v int; begin
  select count(*) into v from public.app_contracts; assert v = 0, format('T28 nobody (non-member) must read 0 links, saw %s', v);
end $$;
reset role;

-- 28e: app_contracts is READ-only org-scoped — the OTHER default-deny child tables are unchanged. An
-- org-only user still reads ZERO from them (no broadening leaked out of 0006). (app_users is covered by
-- T29 below — it becomes org-scoped in 0007, so it is intentionally NOT asserted 0 here.)
select set_config('request.jwt.claims','{"sub":"0a000000-0000-0000-0000-0000000000a1"}',false); -- mgr_a1
set role authenticated;
do $$ declare v int; begin
  select count(*) into v from public.identity_accounts;    assert v = 0, format('T28 mgr_a1 identity_accounts still default-deny, saw %s', v);
  select count(*) into v from public.license_rules;        assert v = 0, format('T28 mgr_a1 license_rules still default-deny, saw %s', v);
  select count(*) into v from public.license_evaluations;  assert v = 0, format('T28 mgr_a1 license_evaluations still default-deny, saw %s', v);
  select count(*) into v from public.invoices;             assert v = 0, format('T28 mgr_a1 invoices still default-deny, saw %s', v);
  select count(*) into v from public.files;                assert v = 0, format('T28 mgr_a1 files: tenant-member read, org-only sees 0 (0013), saw %s', v);
end $$;
reset role;

-- 28h: DEFENSE-IN-DEPTH (migration 0009) — the org policy now pins app/contract tenant explicitly
-- (mirrors 0007/0008), so it is self-sufficient for tenant isolation rather than relying solely on the
-- 0005 same-tenant FKs. Plant a normally-IMPOSSIBLE corrupt cross-tenant link by bypassing the FK
-- (session_replication_role=replica, superuser only): tenant_id = tenant B, but (app_id, contract_id)
-- point at a tenant-A App A1 + a tenant-A contract that mgr_a1 CAN read. Without the explicit tenant-bind
-- (the old 0006 policy) mgr_a1 would leak this row via BOTH branches; the 0009 bind hides it because
-- App A1.tenant_id (A) != the link's tenant_id (B) and the contract's tenant_id (A) != B.
reset role;
-- a tenant-A contract stewarded by Org A1 (mgr_a1-readable), not otherwise linked to App A1.
insert into public.contracts (id, tenant_id, contract_name, procurement_org_id) values
  ('c0000000-0000-0000-0000-0000000000c9','11111111-1111-1111-1111-111111111111','Contract A-h (T28h)','1a1a1a1a-0000-0000-0000-000000000001');
set session_replication_role = replica;  -- superuser: bypass FK/triggers to plant the corrupt link
insert into public.app_contracts (app_id, contract_id, tenant_id) values
  ('a9900000-0000-0000-0000-0000000000a1','c0000000-0000-0000-0000-0000000000c9','22222222-2222-2222-2222-222222222222');
set session_replication_role = default;
select set_config('request.jwt.claims','{"sub":"0a000000-0000-0000-0000-0000000000a1"}',false); -- mgr_a1 (reads App A1 + Contract A-h)
set role authenticated;
do $$ declare v int; begin
  select count(*) into v from public.app_contracts where tenant_id='22222222-2222-2222-2222-222222222222';
  assert v = 0, format('T28h org policy must pin tenant — corrupt cross-tenant app_contracts link must stay hidden, saw %s', v);
end $$;
reset role;
-- clean up the planted link + helper contract (superuser; no DELETE policy needed — RLS bypassed).
delete from public.app_contracts where app_id='a9900000-0000-0000-0000-0000000000a1' and contract_id='c0000000-0000-0000-0000-0000000000c9';
delete from public.contracts where id='c0000000-0000-0000-0000-0000000000c9';

-- ── Test 29: org-scoped READ for app_users (migration 0007, PR #21) ──────────────────────────
-- app_users gains ONE org-scoped SELECT policy: an org-only user may read an app_user row iff they
-- can already read the linked APP under their related-org RLS. Existing tenant-member read + editor
-- insert/update are unchanged; NO delete policy added.
-- Seed (privileged): tenant A app_users across three apps (fixture a5..a1 already in App A1).
--   App A1    (resp OrgA1)              -> readable by mgr_a1 (OrgA1)
--   App A-pay (resp OrgA2, paying OrgA3)-> readable by mgr_a2 (OrgA2, responsible) AND agency_u (OrgA3, paying)
--   App A2    (resp OrgA2)              -> readable by mgr_a2 (OrgA2)
reset role;
insert into public.app_users (id, tenant_id, app_id, email) values
  ('a5000000-0000-0000-0000-0000000000c1','11111111-1111-1111-1111-111111111111','a9900000-0000-0000-0000-0000000000a1','u_a1_2@a.test'),  -- App A1 (2nd user)
  ('a5000000-0000-0000-0000-0000000000cf','11111111-1111-1111-1111-111111111111','a9900000-0000-0000-0000-0000000000af','u_apay@a.test'),  -- App A-pay
  ('a5000000-0000-0000-0000-0000000000c2','11111111-1111-1111-1111-111111111111','a9900000-0000-0000-0000-0000000000a2','u_a2@a.test');    -- App A2
-- App A1 now has a5..a1 (fixture) + a5..c1 = 2 users; App A-pay 1; App A2 1; App B1 has a5..b1 (tenant B).

-- 29a: tenant owner reads ALL tenant-A app_users (4), and none of tenant B's.
select set_config('request.jwt.claims','{"sub":"0a000000-0000-0000-0000-000000000001"}',false); -- owner_a
set role authenticated;
do $$ declare v int; begin
  select count(*) into v from public.app_users where tenant_id='11111111-1111-1111-1111-111111111111'; assert v = 4, format('T29 owner_a should read 4 tenant-A app_users, saw %s', v);
  select count(*) into v from public.app_users where app_id='b9900000-0000-0000-0000-0000000000b1';      assert v = 0, format('T29 owner_a must not read tenant-B App B1 users, saw %s', v);
end $$;
reset role;

-- 29b: org-only mgr_a1 (Org A1) reads ONLY App A1's users (2); zero for apps it cannot read.
select set_config('request.jwt.claims','{"sub":"0a000000-0000-0000-0000-0000000000a1"}',false); -- mgr_a1
set role authenticated;
do $$ declare v int; begin
  select count(*) into v from public.app_users; assert v = 2, format('T29 mgr_a1 should read 2 app_users (App A1 only), saw %s', v);
  select count(*) into v from public.app_users where app_id='a9900000-0000-0000-0000-0000000000a1'; assert v = 2, format('T29 mgr_a1 should read App A1 users, saw %s', v);
  select count(*) into v from public.app_users where app_id='a9900000-0000-0000-0000-0000000000af'; assert v = 0, format('T29 mgr_a1 must NOT read App A-pay users, saw %s', v);
  select count(*) into v from public.app_users where app_id='a9900000-0000-0000-0000-0000000000a2'; assert v = 0, format('T29 mgr_a1 must NOT read App A2 users, saw %s', v);
end $$;
reset role;

-- 29c: org-only mgr_a2 (Org A2) reads App A-pay (responsible) + App A2 (responsible) users (2); not App A1.
select set_config('request.jwt.claims','{"sub":"0a000000-0000-0000-0000-0000000000a3"}',false); -- mgr_a2
set role authenticated;
do $$ declare v int; begin
  select count(*) into v from public.app_users; assert v = 2, format('T29 mgr_a2 should read 2 app_users (App A-pay + App A2), saw %s', v);
  select count(*) into v from public.app_users where app_id='a9900000-0000-0000-0000-0000000000a1'; assert v = 0, format('T29 mgr_a2 must NOT read App A1 users, saw %s', v);
end $$;
reset role;

-- 29d: org-only agency_u (Org A3) reads ONLY App A-pay (via paying org A3) users (1); not App A1/A2.
select set_config('request.jwt.claims','{"sub":"0a000000-0000-0000-0000-0000000000c1"}',false); -- agency_u
set role authenticated;
do $$ declare v int; begin
  select count(*) into v from public.app_users; assert v = 1, format('T29 agency_u should read 1 app_user (App A-pay), saw %s', v);
  select count(*) into v from public.app_users where app_id='a9900000-0000-0000-0000-0000000000af'; assert v = 1, format('T29 agency_u should read App A-pay user, saw %s', v);
  select count(*) into v from public.app_users where app_id='a9900000-0000-0000-0000-0000000000a1'; assert v = 0, format('T29 agency_u must NOT read App A1 users, saw %s', v);
end $$;
reset role;

-- 29e: other-tenant owner_b reads only tenant-B users (1), zero tenant-A; pure non-member nobody reads 0.
select set_config('request.jwt.claims','{"sub":"0b000000-0000-0000-0000-000000000001"}',false); -- owner_b (tenant B)
set role authenticated;
do $$ declare v int; begin
  select count(*) into v from public.app_users where tenant_id='11111111-1111-1111-1111-111111111111'; assert v = 0, format('T29 owner_b must read 0 tenant-A app_users, saw %s', v);
  select count(*) into v from public.app_users; assert v = 1, format('T29 owner_b should read only its own tenant-B app_user, saw %s', v);
end $$;
reset role;
select set_config('request.jwt.claims','{"sub":"0a000000-0000-0000-0000-0000000000ff"}',false); -- nobody (non-member)
set role authenticated;
do $$ declare v int; begin
  select count(*) into v from public.app_users; assert v = 0, format('T29 nobody (non-member) must read 0 app_users, saw %s', v);
end $$;
reset role;

-- 29f: NO DELETE policy was introduced — even an org-only reader (and the tenant owner) cannot delete an
-- app_user; the row survives. And the OTHER child tables are NOT broadened by 0007.
select set_config('request.jwt.claims','{"sub":"0a000000-0000-0000-0000-0000000000a1"}',false); -- mgr_a1 (can READ App A1 users)
set role authenticated;
do $$ declare v int; begin
  delete from public.app_users where id='a5000000-0000-0000-0000-0000000000a1';  -- App A1 user mgr_a1 can read
  select count(*) into v from public.app_users where id='a5000000-0000-0000-0000-0000000000a1'; assert v = 1, format('T29 app_user must survive org-only delete (no DELETE policy), saw %s', v);
  -- 0007 broadened ONLY app_users (and 0008 later adds app_user_identity_matches — proven in T30).
  -- people / identity_accounts / license_* / invoices / files are still default-deny / tenant-only here.
  select count(*) into v from public.people;                  assert v = 0, format('T29 mgr_a1 people still tenant-only, saw %s', v);
  select count(*) into v from public.identity_accounts;       assert v = 0, format('T29 mgr_a1 identity_accounts still default-deny, saw %s', v);
  select count(*) into v from public.license_rules;           assert v = 0, format('T29 mgr_a1 license_rules still default-deny, saw %s', v);
  select count(*) into v from public.license_evaluations;     assert v = 0, format('T29 mgr_a1 license_evaluations still default-deny, saw %s', v);
  select count(*) into v from public.invoices;                assert v = 0, format('T29 mgr_a1 invoices still default-deny, saw %s', v);
  select count(*) into v from public.files;                   assert v = 0, format('T29 mgr_a1 files: tenant-member read, org-only sees 0 (0013), saw %s', v);
end $$;
reset role;

-- 29g: app_contracts org-scoped read (T28, 0006) still holds after 0007 — mgr_a1 still reads its 2 links.
select set_config('request.jwt.claims','{"sub":"0a000000-0000-0000-0000-0000000000a1"}',false); -- mgr_a1
set role authenticated;
do $$ declare v int; begin
  select count(*) into v from public.app_contracts; assert v = 2, format('T29 app_contracts T28 behavior should still hold (mgr_a1 reads 2), saw %s', v);
end $$;
reset role;

-- 29h: DEFENSE-IN-DEPTH — the 0007 policy pins `a.tenant_id = app_users.tenant_id` explicitly, so it is
-- self-sufficient for tenant isolation (not relying solely on the 0005 FK). Plant a normally-IMPOSSIBLE
-- corrupt cross-tenant row by bypassing the FK (session_replication_role=replica, superuser only): a
-- tenant-B app_user pointing at tenant-A App A1. mgr_a1 CAN read App A1, but must NOT read this row
-- because its tenant_id (B) != App A1's tenant_id (A). (Without the explicit tenant-bind this would leak.)
reset role;
set session_replication_role = replica;  -- superuser: disable FK/triggers to plant the corrupt row
insert into public.app_users (id, tenant_id, app_id) values
  ('a5000000-0000-0000-0000-0000000000ee','22222222-2222-2222-2222-222222222222','a9900000-0000-0000-0000-0000000000a1');
set session_replication_role = default;
select set_config('request.jwt.claims','{"sub":"0a000000-0000-0000-0000-0000000000a1"}',false); -- mgr_a1 (can read App A1)
set role authenticated;
do $$ declare v int; begin
  select count(*) into v from public.app_users where id='a5000000-0000-0000-0000-0000000000ee';
  assert v = 0, format('T29 org policy must pin tenant — corrupt cross-tenant app_user must stay hidden, saw %s', v);
end $$;
reset role;
delete from public.app_users where id='a5000000-0000-0000-0000-0000000000ee';  -- clean up planted row (superuser)

-- ── Test 30: org-scoped READ for app_user_identity_matches (migration 0008, PR #23) ──────────
-- app_user_identity_matches gains ONE org-scoped SELECT policy (doc 12 §5): read a match row iff you
-- can read the linked app_user (which is itself org-scoped by 0007), with an explicit tenant-bind. It
-- exposes match STATUS, not PII: people stays tenant-only, identity_accounts stays default-deny.
-- Existing matches: M1 = 15..a1 (app_user a5..a1 in App A1) from T26. Seed M2 (App A-pay) + M3 (App A2).
reset role;
insert into public.app_user_identity_matches (id, tenant_id, app_user_id, person_id, match_method) values
  ('15000000-0000-0000-0000-0000000000cf','11111111-1111-1111-1111-111111111111','a5000000-0000-0000-0000-0000000000cf','7e000000-0000-0000-0000-0000000000a1','email'),  -- M2 App A-pay
  ('15000000-0000-0000-0000-0000000000c2','11111111-1111-1111-1111-111111111111','a5000000-0000-0000-0000-0000000000c2','7e000000-0000-0000-0000-0000000000a1','email');  -- M3 App A2

-- 30a: tenant owner reads ALL 3 tenant match rows (transitively — owner reads all tenant app_users).
select set_config('request.jwt.claims','{"sub":"0a000000-0000-0000-0000-000000000001"}',false); -- owner_a
set role authenticated;
do $$ declare v int; begin
  select count(*) into v from public.app_user_identity_matches where tenant_id='11111111-1111-1111-1111-111111111111';
  assert v = 3, format('T30 owner_a should read all 3 tenant match rows, saw %s', v);
  -- owner still reads 0 identity_accounts (default-deny, untouched by 0008)
  select count(*) into v from public.identity_accounts; assert v = 0, format('T30 owner_a identity_accounts still default-deny, saw %s', v);
end $$;
reset role;

-- 30b: org-only mgr_a1 (Org A1) reads ONLY App A1's match (M1); 0 for unreadable apps' matches.
select set_config('request.jwt.claims','{"sub":"0a000000-0000-0000-0000-0000000000a1"}',false); -- mgr_a1
set role authenticated;
do $$ declare v int; begin
  select count(*) into v from public.app_user_identity_matches; assert v = 1, format('T30 mgr_a1 should read 1 match (App A1), saw %s', v);
  select count(*) into v from public.app_user_identity_matches where id='15000000-0000-0000-0000-0000000000a1'; assert v = 1, format('T30 mgr_a1 should read M1 (App A1), saw %s', v);
  select count(*) into v from public.app_user_identity_matches where id='15000000-0000-0000-0000-0000000000cf'; assert v = 0, format('T30 mgr_a1 must NOT read M2 (App A-pay), saw %s', v);
  -- match read grants NO collateral read: people + identity_accounts still 0 for the org-only user.
  select count(*) into v from public.people;            assert v = 0, format('T30 mgr_a1 people still tenant-only, saw %s', v);
  select count(*) into v from public.identity_accounts; assert v = 0, format('T30 mgr_a1 identity_accounts still default-deny, saw %s', v);
end $$;
reset role;

-- 30c: org-only mgr_a2 (Org A2) reads App A-pay (responsible) + App A2 (responsible) matches (M2, M3); not M1.
select set_config('request.jwt.claims','{"sub":"0a000000-0000-0000-0000-0000000000a3"}',false); -- mgr_a2
set role authenticated;
do $$ declare v int; begin
  select count(*) into v from public.app_user_identity_matches; assert v = 2, format('T30 mgr_a2 should read 2 matches (App A-pay + App A2), saw %s', v);
  select count(*) into v from public.app_user_identity_matches where id='15000000-0000-0000-0000-0000000000a1'; assert v = 0, format('T30 mgr_a2 must NOT read M1 (App A1), saw %s', v);
end $$;
reset role;

-- 30d: org-only agency_u (Org A3) reads ONLY App A-pay (paying org A3) match (M2); not M1/M3.
select set_config('request.jwt.claims','{"sub":"0a000000-0000-0000-0000-0000000000c1"}',false); -- agency_u
set role authenticated;
do $$ declare v int; begin
  select count(*) into v from public.app_user_identity_matches; assert v = 1, format('T30 agency_u should read 1 match (App A-pay), saw %s', v);
  select count(*) into v from public.app_user_identity_matches where id='15000000-0000-0000-0000-0000000000cf'; assert v = 1, format('T30 agency_u should read M2 (App A-pay), saw %s', v);
  select count(*) into v from public.app_user_identity_matches where id='15000000-0000-0000-0000-0000000000a1'; assert v = 0, format('T30 agency_u must NOT read M1 (App A1), saw %s', v);
end $$;
reset role;

-- 30e: other-tenant owner_b and pure non-member nobody read ZERO match rows (no cross-tenant leak).
select set_config('request.jwt.claims','{"sub":"0b000000-0000-0000-0000-000000000001"}',false); -- owner_b (tenant B)
set role authenticated;
do $$ declare v int; begin
  select count(*) into v from public.app_user_identity_matches; assert v = 0, format('T30 owner_b (tenant B) must read 0 tenant-A matches, saw %s', v);
end $$;
reset role;
select set_config('request.jwt.claims','{"sub":"0a000000-0000-0000-0000-0000000000ff"}',false); -- nobody
set role authenticated;
do $$ declare v int; begin
  select count(*) into v from public.app_user_identity_matches; assert v = 0, format('T30 nobody (non-member) must read 0 matches, saw %s', v);
end $$;
reset role;

-- 30f: NO DELETE policy — an org-only user who CAN read M1 still cannot delete it (row survives).
select set_config('request.jwt.claims','{"sub":"0a000000-0000-0000-0000-0000000000a1"}',false); -- mgr_a1
set role authenticated;
do $$ declare v int; begin
  delete from public.app_user_identity_matches where id='15000000-0000-0000-0000-0000000000a1';
  select count(*) into v from public.app_user_identity_matches where id='15000000-0000-0000-0000-0000000000a1';
  assert v = 1, format('T30 match must survive org-only delete (no DELETE policy), saw %s', v);
end $$;
reset role;

-- 30g: app_users (T29, 0007) and app_contracts (T28, 0006) org-read still hold after 0008.
select set_config('request.jwt.claims','{"sub":"0a000000-0000-0000-0000-0000000000a1"}',false); -- mgr_a1
set role authenticated;
do $$ declare v int; begin
  select count(*) into v from public.app_users;     assert v = 2, format('T30 app_users T29 still holds (mgr_a1 reads App A1 users = 2), saw %s', v);
  select count(*) into v from public.app_contracts; assert v = 2, format('T30 app_contracts T28 still holds (mgr_a1 reads 2 links), saw %s', v);
end $$;
reset role;

-- 30h: DEFENSE-IN-DEPTH — the explicit tenant-bind hides a normally-impossible FK-bypassed corrupt
-- cross-tenant match (tenant B, app_user a5..a1 which is tenant A). mgr_a1 CAN read App A1's a5..a1 but
-- must NOT read this match because its tenant_id (B) != the app_user's tenant_id (A).
reset role;
set session_replication_role = replica;  -- superuser: bypass FK to plant the corrupt row
-- distinct person_id (FK bypassed) so the unique(app_user_id, person_id) doesn't collide with M1.
insert into public.app_user_identity_matches (id, tenant_id, app_user_id, person_id, match_method) values
  ('15000000-0000-0000-0000-0000000000ee','22222222-2222-2222-2222-222222222222','a5000000-0000-0000-0000-0000000000a1','7e000000-0000-0000-0000-0000000000ee','email');
set session_replication_role = default;
select set_config('request.jwt.claims','{"sub":"0a000000-0000-0000-0000-0000000000a1"}',false); -- mgr_a1
set role authenticated;
do $$ declare v int; begin
  select count(*) into v from public.app_user_identity_matches where id='15000000-0000-0000-0000-0000000000ee';
  assert v = 0, format('T30 match policy must pin tenant — corrupt cross-tenant match must stay hidden, saw %s', v);
end $$;
reset role;
delete from public.app_user_identity_matches where id='15000000-0000-0000-0000-0000000000ee';  -- clean up (superuser)

-- ── Test 31: contract audit-on-write (migration 0010) ────────────────────────
-- The AFTER INSERT/UPDATE trigger on contracts appends one audit_logs row per ACCEPTED
-- write, capturing actor = auth.uid() from the caller's JWT (even though the function is
-- SECURITY DEFINER). It does NOT change who may write — existing RLS (0004) still decides.
-- Proven below: allowed writes audit exactly once with the correct actor; denied/no-op and
-- failed writes do NOT audit; paying-org read never becomes write. The audit insert never
-- goes through a direct `authenticated` path (T6/T8 already prove that is blocked).

-- 31a: tenant editor INSERT → exactly ONE 'contract.created' row; actor = editor (NOT null,
-- not a fixed admin, not service_role — it is the writing user's JWT sub).
select set_config('request.jwt.claims','{"sub":"0a000000-0000-0000-0000-0000000000ed"}',false); -- editor_a (tenant editor)
set role authenticated;
insert into public.contracts (id, tenant_id, contract_name) values
  ('c0000000-0000-0000-0000-0000000000d1','11111111-1111-1111-1111-111111111111','Contract Audit Editor');
reset role;
do $$ declare v int; a uuid; act text; res text; tn uuid; begin
  select count(*) into v from public.audit_logs where resource_id='c0000000-0000-0000-0000-0000000000d1';
  assert v = 1, format('T31 editor INSERT must write exactly 1 audit row, saw %s', v);
  select actor_user_id, action, resource_type, tenant_id into a, act, res, tn
    from public.audit_logs where resource_id='c0000000-0000-0000-0000-0000000000d1';
  assert act = 'contract.created', format('T31 INSERT action should be contract.created, got %s', act);
  assert res = 'contract', format('T31 audit resource_type should be contract, got %s', res);
  assert tn = '11111111-1111-1111-1111-111111111111', format('T31 audit tenant must be NEW.tenant_id, got %s', tn);
  assert a is not null, 'T31 audit actor must NOT be null';
  assert a = '0a000000-0000-0000-0000-0000000000ed', format('T31 audit actor must be the writing editor (auth.uid from JWT), got %s', a);
end $$;

-- 31b: org procurement-manager INSERT (Org A1 contract) also audits once — and the actor is a
-- DIFFERENT user than 31a, proving the actor is read live from the JWT, not hardcoded.
select set_config('request.jwt.claims','{"sub":"0a000000-0000-0000-0000-0000000000a1"}',false); -- mgr_a1 (manager of Org A1)
set role authenticated;
insert into public.contracts (id, tenant_id, contract_name, procurement_org_id) values
  ('c0000000-0000-0000-0000-0000000000d2','11111111-1111-1111-1111-111111111111','Contract Audit Mgr','1a1a1a1a-0000-0000-0000-000000000001');
reset role;
do $$ declare v int; a uuid; begin
  select count(*) into v from public.audit_logs where resource_id='c0000000-0000-0000-0000-0000000000d2' and action='contract.created';
  assert v = 1, format('T31 org-manager INSERT must write exactly 1 created audit row, saw %s', v);
  select actor_user_id into a from public.audit_logs where resource_id='c0000000-0000-0000-0000-0000000000d2' and action='contract.created';
  assert a = '0a000000-0000-0000-0000-0000000000a1', format('T31 audit actor must be the writing org-manager, got %s', a);
end $$;

-- 31c: an allowed UPDATE writes exactly one 'contract.updated' row (and does not duplicate the create row).
select set_config('request.jwt.claims','{"sub":"0a000000-0000-0000-0000-0000000000a1"}',false); -- mgr_a1
set role authenticated;
do $$ declare v int; begin
  update public.contracts set status='renewed' where id='c0000000-0000-0000-0000-0000000000d2';
  get diagnostics v = row_count; assert v = 1, format('T31 mgr_a1 should update its own-org contract (%s rows)', v);
end $$;
reset role;
do $$ declare v int; a uuid; begin
  select count(*) into v from public.audit_logs where resource_id='c0000000-0000-0000-0000-0000000000d2' and action='contract.updated';
  assert v = 1, format('T31 allowed UPDATE must write exactly 1 updated audit row, saw %s', v);
  select count(*) into v from public.audit_logs where resource_id='c0000000-0000-0000-0000-0000000000d2' and action='contract.created';
  assert v = 1, format('T31 UPDATE must not duplicate the create row (created still 1, saw %s)', v);
  select actor_user_id into a from public.audit_logs where resource_id='c0000000-0000-0000-0000-0000000000d2' and action='contract.updated';
  assert a = '0a000000-0000-0000-0000-0000000000a1', format('T31 update audit actor must be the writer, got %s', a);
end $$;

-- 31d: paying-org READ does not become WRITE. agency_u relates to Contract A-central ONLY via
-- paying_org_id (it can read it, T20), but cannot UPDATE it (steward = Central Proc) and cannot
-- INSERT a contract into an org it does not manage. Neither denied write audits anything.
select set_config('request.jwt.claims','{"sub":"0a000000-0000-0000-0000-0000000000c1"}',false); -- agency_u (Org A3, paying-related reader)
set role authenticated;
do $$ declare v int; begin
  update public.contracts set status='hijacked' where id='c0000000-0000-0000-0000-0000000000cc'; -- Contract A-central
  get diagnostics v = row_count; assert v = 0, format('T31 paying-org reader must NOT update a non-steward contract (%s rows)', v);
  begin
    insert into public.contracts (id, tenant_id, contract_name, procurement_org_id) values
      ('c0000000-0000-0000-0000-0000000000d3','11111111-1111-1111-1111-111111111111','Contract Audit Agency','1a1a1a1a-0000-0000-0000-0000000000cc'); -- Central Proc (agency_u not a manager)
  exception when insufficient_privilege or check_violation then null; -- denied: for this INSERT the BEFORE enforce_owning_org_tenant trigger sees Central Proc as RLS-hidden to agency_u → NULL org → check_violation (before the contract-write WITH CHECK is reached); either way the write is rejected and never audited — expected
  end;
end $$;
reset role;
do $$ declare v int; begin
  select count(*) into v from public.audit_logs where resource_id='c0000000-0000-0000-0000-0000000000cc' and action='contract.updated';
  assert v = 0, format('T31 denied UPDATE must NOT audit (A-central updated rows=%s)', v);
  select count(*) into v from public.audit_logs where resource_id='c0000000-0000-0000-0000-0000000000d3';
  assert v = 0, format('T31 denied INSERT must NOT audit (saw %s rows for d3)', v);
end $$;

-- 31e: an unrelated org member (mgr_a2, Org A2) cannot UPDATE an Org A1 contract → 0 rows, and the
-- denied update adds NO audit row (the d2 'updated' count stays at the single row from 31c).
select set_config('request.jwt.claims','{"sub":"0a000000-0000-0000-0000-0000000000a3"}',false); -- mgr_a2 (Org A2)
set role authenticated;
do $$ declare v int; begin
  update public.contracts set status='hijacked' where id='c0000000-0000-0000-0000-0000000000d2'; -- Org A1 contract (31b)
  get diagnostics v = row_count; assert v = 0, format('T31 unrelated org member must NOT update Org A1 contract (%s rows)', v);
end $$;
reset role;
do $$ declare v int; begin
  select count(*) into v from public.audit_logs where resource_id='c0000000-0000-0000-0000-0000000000d2' and action='contract.updated';
  assert v = 1, format('T31 denied cross-org UPDATE must NOT add an audit row (updated still 1, saw %s)', v);
end $$;

-- 31f: a write REJECTED by enforce_owning_org_tenant (cross-tenant org pointer) raises BEFORE the
-- AFTER trigger fires → the failed write is NOT audited.
select set_config('request.jwt.claims','{"sub":"0a000000-0000-0000-0000-000000000001"}',false); -- owner_a (tenant editor)
set role authenticated;
do $$ declare ok boolean := false; begin
  begin
    insert into public.contracts (id, tenant_id, contract_name, procurement_org_id) values
      ('c0000000-0000-0000-0000-0000000000df','11111111-1111-1111-1111-111111111111','Contract Audit XT','2b2b2b2b-0000-0000-0000-000000000001'); -- Org B1 (tenant B)
    ok := false;
  exception when check_violation then ok := true; end;
  assert ok, 'T31 cross-tenant procurement_org_id must be rejected by the integrity trigger';
end $$;
reset role;
do $$ declare v int; begin
  select count(*) into v from public.audit_logs where resource_id='c0000000-0000-0000-0000-0000000000df';
  assert v = 0, format('T31 a rejected (failed) write must NOT audit, saw %s rows for df', v);
end $$;

-- ── Test 32: structural guarantees (policy catalog + trigger shape) ───────────
-- Assert the security SHAPE straight from the catalog, not only behaviorally: contracts keeps NO
-- destructive policy; audit_logs grants NO direct write; the audit trigger is the expected
-- SECURITY DEFINER AFTER INSERT/UPDATE trigger.
reset role;
do $$ declare v int; begin
  select count(*) into v from pg_policies where schemaname='public' and tablename='contracts' and cmd='DELETE';
  assert v = 0, format('T32 contracts must have 0 DELETE policies, saw %s', v);
  select count(*) into v from pg_policies where schemaname='public' and tablename='contracts' and cmd='ALL';
  assert v = 0, format('T32 contracts must have 0 FOR ALL policies, saw %s', v);
  -- audit_logs: no INSERT/UPDATE/DELETE/ALL policy → no `authenticated` direct-write path (append happens
  -- only via the SECURITY DEFINER trigger); UPDATE/DELETE also blocked by reject_audit_mutation (T6).
  select count(*) into v from pg_policies where schemaname='public' and tablename='audit_logs' and cmd in ('INSERT','UPDATE','DELETE','ALL');
  assert v = 0, format('T32 audit_logs must have no INSERT/UPDATE/DELETE/ALL policy, saw %s', v);
  select count(*) into v from pg_proc where proname='audit_contract_write' and prosecdef;
  assert v = 1, format('T32 audit_contract_write must be SECURITY DEFINER, saw %s', v);
  -- trigger exists, is per-ROW (bit 1; the fn dereferences NEW.*), AFTER (bit 2 unset), fires on INSERT (bit 4) and UPDATE (bit 16).
  select count(*) into v from pg_trigger
    where tgrelid='public.contracts'::regclass and tgname='contracts_audit_on_write'
      and not tgisinternal and (tgtype & 1) <> 0 and (tgtype & 2) = 0 and (tgtype & 4) <> 0 and (tgtype & 16) <> 0;
  assert v = 1, format('T32 contracts_audit_on_write must be an AFTER INSERT OR UPDATE FOR EACH ROW trigger, saw %s', v);
end $$;

-- ── Test 33: files metadata foundation (migration 0012) ──────────────────────
-- 0012 adds metadata columns to `files` for the FUTURE contract PDF/AI workflow (docs/16) WITHOUT
-- surfacing the table. These assertions pin: (a) the same-tenant contract-attachment FK (cross-tenant
-- rejected, same-tenant accepted), (b) the status/value CHECK constraints (tight, but not over-tight),
-- and (c) that `files` stays DEFAULT-DENY / not surfaced — 0012 adds NO policy, so 0 DELETE, 0 FOR ALL,
-- 0 policies total, and a tenant member reads 0 rows even when files exist (RISK-002 stays OPEN).
reset role;

-- 33a: a VALID same-tenant file attached to a tenant-A contract inserts (positive control); the status
-- columns take their 0012 defaults; the composite (contract_id, tenant_id) matches a real tenant-A contract.
insert into public.files (id, tenant_id, storage_path, original_filename, document_type, contract_id)
  values ('13000000-0000-0000-0000-0000000000f1','11111111-1111-1111-1111-111111111111',
          'contracts/11111111-1111-1111-1111-111111111111/13000000-0000-0000-0000-0000000000f1.pdf',
          'contract_a1.pdf','contract','c0000000-0000-0000-0000-0000000000a1');
do $$ declare us text; ss text; es text; begin
  select upload_status, scan_status, extraction_status into us, ss, es
    from public.files where id='13000000-0000-0000-0000-0000000000f1';
  assert us = 'pending', format('T33 new file upload_status should default to pending, got %s', us);
  assert ss = 'pending', format('T33 new file scan_status should default to pending, got %s', ss);
  assert es = 'not_started', format('T33 new file extraction_status should default to not_started, got %s', es);
end $$;

-- 33b: a CROSS-TENANT contract attachment is rejected by the composite same-tenant FK, and each CHECK
-- constraint rejects an out-of-range value. Counted so a missing/loosened constraint fails the run.
do $$ declare n int := 0; begin
  -- cross-tenant: a tenant-B file pointing at a tenant-A contract → composite (contract_id, tenant_id)
  -- has no matching (id, tenant_id) pair in contracts → foreign_key_violation.
  begin
    insert into public.files (id, tenant_id, storage_path, original_filename, contract_id) values
      ('13000000-0000-0000-0000-0000000000fb','22222222-2222-2222-2222-222222222222','x/fb.pdf','fb.pdf',
       'c0000000-0000-0000-0000-0000000000a1');
    raise exception 'T33 cross-tenant file→contract attachment was allowed';
  exception when foreign_key_violation then n := n + 1; end;
  begin -- invalid upload_status
    insert into public.files (id, tenant_id, storage_path, original_filename, upload_status) values
      ('13000000-0000-0000-0000-0000000000c1','11111111-1111-1111-1111-111111111111','x/c1.pdf','c1.pdf','bogus');
    raise exception 'T33 invalid upload_status was allowed';
  exception when check_violation then n := n + 1; end;
  begin -- invalid scan_status (legacy-style value not in the v3 enum)
    insert into public.files (id, tenant_id, storage_path, original_filename, scan_status) values
      ('13000000-0000-0000-0000-0000000000c2','11111111-1111-1111-1111-111111111111','x/c2.pdf','c2.pdf','infected');
    raise exception 'T33 invalid scan_status was allowed';
  exception when check_violation then n := n + 1; end;
  begin -- invalid extraction_status
    insert into public.files (id, tenant_id, storage_path, original_filename, extraction_status) values
      ('13000000-0000-0000-0000-0000000000c3','11111111-1111-1111-1111-111111111111','x/c3.pdf','c3.pdf','running');
    raise exception 'T33 invalid extraction_status was allowed';
  exception when check_violation then n := n + 1; end;
  begin -- negative byte_size
    insert into public.files (id, tenant_id, storage_path, original_filename, byte_size) values
      ('13000000-0000-0000-0000-0000000000c4','11111111-1111-1111-1111-111111111111','x/c4.pdf','c4.pdf',-1);
    raise exception 'T33 negative byte_size was allowed';
  exception when check_violation then n := n + 1; end;
  begin -- malformed sha256 (not 64 lowercase hex)
    insert into public.files (id, tenant_id, storage_path, original_filename, sha256) values
      ('13000000-0000-0000-0000-0000000000c5','11111111-1111-1111-1111-111111111111','x/c5.pdf','c5.pdf','NOTHEX');
    raise exception 'T33 malformed sha256 was allowed';
  exception when check_violation then n := n + 1; end;
  assert n = 6, format('T33 expected 6 constraint rejections (1 cross-tenant FK + 5 CHECK), got %s', n);
end $$;

-- 33c: well-formed metadata is ACCEPTED (the checks are tight, not over-tight): a 64-hex sha256, a
-- non-negative byte_size, and a valid scan_status. NULL metadata stays valid (nullable columns).
insert into public.files (id, tenant_id, storage_path, original_filename, byte_size, sha256, scan_status) values
  ('13000000-0000-0000-0000-0000000000c6','11111111-1111-1111-1111-111111111111','x/c6.pdf','c6.pdf',
   1024, repeat('a',64), 'passed');

-- 33d: CATALOG — after `0013`, `files` is SELECT+INSERT-policied (no longer zero-policy); after `0016`
-- it also has exactly ONE narrow UPDATE policy (the uploader-finalize, T36) — still 0 DELETE, 0 FOR
-- ALL; RLS still enabled. (The T33 "0 policies" check from `0012` is intentionally superseded here —
-- `0013` is the file RLS step; `0016` adds only the scoped uploader-finalize UPDATE.)
do $$ declare v int; begin
  select count(*) into v from pg_policies where schemaname='public' and tablename='files' and cmd='SELECT';
  assert v = 1, format('T33 files must have a SELECT policy after 0013, saw %s', v);
  select count(*) into v from pg_policies where schemaname='public' and tablename='files' and cmd='INSERT';
  assert v = 1, format('T33 files must have an INSERT policy after 0013, saw %s', v);
  select count(*) into v from pg_policies where schemaname='public' and tablename='files' and cmd='UPDATE';
  assert v = 1, format('T33 files must have exactly 1 UPDATE policy after 0016 (uploader-finalize), saw %s', v);
  select count(*) into v from pg_policies where schemaname='public' and tablename='files' and cmd='DELETE';
  assert v = 0, format('T33 files must have 0 DELETE policies, saw %s', v);
  select count(*) into v from pg_policies where schemaname='public' and tablename='files' and cmd='ALL';
  assert v = 0, format('T33 files must have 0 FOR ALL policies, saw %s', v);
  select count(*) into v from pg_class where relname='files' and relnamespace='public'::regnamespace and relrowsecurity;
  assert v = 1, 'T33 files must keep RLS enabled';
end $$;

-- 33e: BEHAVIORAL — after `0013` a tenant member READS their tenant's files (the SELECT policy), so
-- the tenant-A file rows inserted above are now visible to owner_a (tenant A). Cross-tenant isolation
-- + write authority + delete/update absence are pinned in T34.
select set_config('request.jwt.claims','{"sub":"0a000000-0000-0000-0000-000000000001"}',false); -- owner_a (tenant A)
set role authenticated;
do $$ declare v int; begin
  select count(*) into v from public.files where id='13000000-0000-0000-0000-0000000000f1';
  assert v = 1, format('T33 tenant member must read their own tenant file after 0013, saw %s', v);
end $$;
reset role;

-- ── Test 34: files RLS policies (migration 0013) ─────────────────────────────
-- 0013 adds the FIRST `files` policies: SELECT = tenant-member-only; INSERT = the 0004 contract-write
-- authority (tenant editor+ OR procurement-org manager of the linked contract; `paying_org_id` grants
-- NO write; `uploaded_by = auth.uid()`). NO UPDATE / DELETE / FOR ALL. `files` is policied but still
-- not surfaced in the app (no DAL/route/UI). RISK-002 narrows for `files` READ, stays OPEN overall.
reset role;
-- Fixtures: a tenant-B contract (for the tenant-B positive INSERT + the cross-tenant attach test) and
-- a tenant-B file (for the cross-tenant READ test; privileged insert bypasses RLS).
insert into public.contracts (id, tenant_id, contract_name, procurement_org_id) values
  ('c0000000-0000-0000-0000-0000000000b1','22222222-2222-2222-2222-222222222222','Contract B1','2b2b2b2b-0000-0000-0000-000000000001');
insert into public.files (id, tenant_id, storage_path, original_filename, contract_id, uploaded_by) values
  ('13000000-0000-0000-0000-0000000000b9','22222222-2222-2222-2222-222222222222','b/b9.pdf','b9.pdf',
   'c0000000-0000-0000-0000-0000000000b1','0b000000-0000-0000-0000-000000000001');

-- 34a: SELECT isolation — a tenant member reads ONLY their tenant's files; cross-tenant, non-member,
-- and org-only (no tenant membership) all read 0 (file read is tenant-member-only for now).
select set_config('request.jwt.claims','{"sub":"0a000000-0000-0000-0000-000000000001"}',false); -- owner_a (tenant A)
set role authenticated;
do $$ declare v int; begin
  select count(*) into v from public.files where tenant_id='11111111-1111-1111-1111-111111111111';
  assert v >= 1, format('T34 owner_a should read tenant-A files, saw %s', v);
  select count(*) into v from public.files where id='13000000-0000-0000-0000-0000000000b9';
  assert v = 0, format('T34 owner_a must NOT read a tenant-B file, saw %s', v);
end $$;
reset role;
select set_config('request.jwt.claims','{"sub":"0b000000-0000-0000-0000-000000000001"}',false); -- owner_b (tenant B)
set role authenticated;
do $$ declare v int; begin
  select count(*) into v from public.files where id='13000000-0000-0000-0000-0000000000b9';
  assert v = 1, format('T34 owner_b should read their tenant-B file, saw %s', v);
  select count(*) into v from public.files where tenant_id='11111111-1111-1111-1111-111111111111';
  assert v = 0, format('T34 owner_b must NOT read tenant-A files, saw %s', v);
end $$;
reset role;
select set_config('request.jwt.claims','{"sub":"0a000000-0000-0000-0000-0000000000ff"}',false); -- nobody (no membership)
set role authenticated;
do $$ declare v int; begin
  select count(*) into v from public.files;
  assert v = 0, format('T34 a non-member must read 0 files, saw %s', v);
end $$;
reset role;
select set_config('request.jwt.claims','{"sub":"0a000000-0000-0000-0000-0000000000a1"}',false); -- mgr_a1 (org-only, no tenant membership)
set role authenticated;
do $$ declare v int; begin
  select count(*) into v from public.files;
  assert v = 0, format('T34 an org-only user reads 0 files (file read is tenant-member-only; org-scoped read deferred), saw %s', v);
end $$;
reset role;

-- 34b: INSERT authority = contract-write authority (0004). A denied INSERT raises insufficient_privilege
-- (RLS WITH CHECK). Tenant editor allowed; org procurement-manager of the contract allowed; tenant
-- viewer / cross-org manager / paying-org manager DENIED; uploaded_by spoof DENIED; cross-tenant attach
-- rejected by the 0012 FK.
select set_config('request.jwt.claims','{"sub":"0a000000-0000-0000-0000-0000000000ed"}',false); -- editor_a (tenant editor)
set role authenticated;
do $$ declare v int; begin
  insert into public.files (id, tenant_id, storage_path, original_filename, contract_id, uploaded_by) values
    ('13000000-0000-0000-0000-0000000000e1','11111111-1111-1111-1111-111111111111','t/e1.pdf','e1.pdf',
     'c0000000-0000-0000-0000-0000000000a1','0a000000-0000-0000-0000-0000000000ed');
  get diagnostics v = row_count;
  assert v = 1, format('T34 tenant editor should insert a file for a tenant contract (%s rows)', v);
end $$;
do $$ declare ok boolean := false; begin  -- uploaded_by spoof (uploaded_by != caller) → denied
  begin
    insert into public.files (id, tenant_id, storage_path, original_filename, contract_id, uploaded_by) values
      ('13000000-0000-0000-0000-0000000000e2','11111111-1111-1111-1111-111111111111','t/e2.pdf','e2.pdf',
       'c0000000-0000-0000-0000-0000000000a1','0a000000-0000-0000-0000-000000000001'); -- uploaded_by = owner_a, not self
    ok := false;
  exception when insufficient_privilege then ok := true; end;
  assert ok, 'T34 uploaded_by spoofing (uploaded_by != auth.uid()) must be rejected';
end $$;
-- cross-tenant attach: even a tenant editor cannot attach a tenant-B contract (0012 composite FK).
do $$ declare ok boolean := false; begin
  begin
    insert into public.files (id, tenant_id, storage_path, original_filename, contract_id, uploaded_by) values
      ('13000000-0000-0000-0000-0000000000e3','11111111-1111-1111-1111-111111111111','t/e3.pdf','e3.pdf',
       'c0000000-0000-0000-0000-0000000000b1','0a000000-0000-0000-0000-0000000000ed'); -- tenant A file, tenant-B contract
    ok := false;
  exception when foreign_key_violation then ok := true; end;
  assert ok, 'T34 cross-tenant contract attachment must be rejected by the same-tenant FK';
end $$;
reset role;
-- mgr_a1 (procurement-org manager of OrgA1 = Contract A1's procurement org) → allowed.
select set_config('request.jwt.claims','{"sub":"0a000000-0000-0000-0000-0000000000a1"}',false);
set role authenticated;
do $$ declare v int; begin
  insert into public.files (id, tenant_id, storage_path, original_filename, contract_id, uploaded_by) values
    ('13000000-0000-0000-0000-0000000000a7','11111111-1111-1111-1111-111111111111','t/a7.pdf','a7.pdf',
     'c0000000-0000-0000-0000-0000000000a1','0a000000-0000-0000-0000-0000000000a1');
  get diagnostics v = row_count;
  assert v = 1, format('T34 procurement-org manager should insert a file for their contract (%s rows)', v);
end $$;
reset role;
-- viewer_a (tenant viewer) → DENIED (no editor role, not an org manager).
select set_config('request.jwt.claims','{"sub":"0a000000-0000-0000-0000-000000000002"}',false);
set role authenticated;
do $$ declare ok boolean := false; begin
  begin
    insert into public.files (id, tenant_id, storage_path, original_filename, contract_id, uploaded_by) values
      ('13000000-0000-0000-0000-0000000000d2','11111111-1111-1111-1111-111111111111','t/d2.pdf','d2.pdf',
       'c0000000-0000-0000-0000-0000000000a1','0a000000-0000-0000-0000-000000000002');
    ok := false;
  exception when insufficient_privilege then ok := true; end;
  assert ok, 'T34 tenant viewer must NOT insert a file (no contract-write authority)';
end $$;
reset role;
-- mgr_a2 (manages OrgA2, NOT Contract A1's org OrgA1) → DENIED (cross-org).
select set_config('request.jwt.claims','{"sub":"0a000000-0000-0000-0000-0000000000a3"}',false);
set role authenticated;
do $$ declare ok boolean := false; begin
  begin
    insert into public.files (id, tenant_id, storage_path, original_filename, contract_id, uploaded_by) values
      ('13000000-0000-0000-0000-0000000000a8','11111111-1111-1111-1111-111111111111','t/a8.pdf','a8.pdf',
       'c0000000-0000-0000-0000-0000000000a1','0a000000-0000-0000-0000-0000000000a3');
    ok := false;
  exception when insufficient_privilege then ok := true; end;
  assert ok, 'T34 a manager of a DIFFERENT org must NOT insert a file for this contract';
end $$;
reset role;
-- agency_u (manages OrgA3 = the PAYING org of Contract A-central, NOT its procurement org) → DENIED.
-- This is the key paying-org write-denial check: paying never grants file write.
select set_config('request.jwt.claims','{"sub":"0a000000-0000-0000-0000-0000000000c1"}',false);
set role authenticated;
do $$ declare ok boolean := false; begin
  begin
    insert into public.files (id, tenant_id, storage_path, original_filename, contract_id, uploaded_by) values
      ('13000000-0000-0000-0000-0000000000a9','11111111-1111-1111-1111-111111111111','t/a9.pdf','a9.pdf',
       'c0000000-0000-0000-0000-0000000000cc','0a000000-0000-0000-0000-0000000000c1'); -- A-central: agency_u is the paying org
    ok := false;
  exception when insufficient_privilege then ok := true; end;
  assert ok, 'T34 PAYING-ORG manager must NOT insert a file (paying_org_id grants no write)';
end $$;
reset role;
-- owner_b (tenant-B owner) inserts a file for tenant-B Contract B1 → allowed (positive control in tenant B).
select set_config('request.jwt.claims','{"sub":"0b000000-0000-0000-0000-000000000001"}',false);
set role authenticated;
do $$ declare v int; begin
  insert into public.files (id, tenant_id, storage_path, original_filename, contract_id, uploaded_by) values
    ('13000000-0000-0000-0000-0000000000ba','22222222-2222-2222-2222-222222222222','t/ba.pdf','ba.pdf',
     'c0000000-0000-0000-0000-0000000000b1','0b000000-0000-0000-0000-000000000001');
  get diagnostics v = row_count;
  assert v = 1, format('T34 tenant-B owner should insert a file for a tenant-B contract (%s rows)', v);
end $$;
reset role;

-- 34c: DELETE is denied for everyone — even a tenant owner; the row survives. After `0016` this is
-- denied at the PRIVILEGE layer (`authenticated` has NO DELETE on `public.files` — the privilege check
-- fires before RLS), a strictly stronger guarantee than the prior no-DELETE-policy 0-rows; T37 proves the
-- privilege surface directly.
select set_config('request.jwt.claims','{"sub":"0a000000-0000-0000-0000-000000000001"}',false); -- owner_a
set role authenticated;
do $$ declare ok boolean := false; begin
  begin
    delete from public.files where id='13000000-0000-0000-0000-0000000000e1';
    ok := false;
  exception when insufficient_privilege then ok := true; end;
  assert ok, 'T34 DELETE on files must be denied (no DELETE privilege after 0016, and no DELETE policy)';
  assert (select count(*) from public.files where id='13000000-0000-0000-0000-0000000000e1') = 1, 'T34 the file must survive the delete attempt';
end $$;
reset role;
-- 34d: SUPERSEDED by `0016`. `0013` had NO UPDATE policy; `0016` adds a NARROW one (the uploader-
-- finalize) plus a column grant of `update (upload_status)` ONLY — so a user can change ONLY
-- upload_status on their OWN row, never scan_status / extraction / storage_path / etc. The uploader-
-- finalize ROW scoping (uploader-only, cross-tenant/cross-user denial, no-reassign WITH CHECK) is proven
-- by T36. The COLUMN-grant narrowing (scan/extraction NOT user-updatable) is enforced at the HOSTED
-- privilege layer and is MASKED locally by test-rls.sh's blanket `grant ... to authenticated` (the same
-- gap class as `0015`), so it is intentionally NOT asserted here.

-- ── Test 35: contract-file Storage authorization helpers (0014) ──────────────
-- can_write_contract_file / can_read_contract_file are the SECURITY DEFINER predicates the staging
-- storage.objects policies call (docs/22 §5). Both require a matching files row for (file_id, tenant);
-- write mirrors 0013 contract-write authority (never paying_org), read mirrors 0013 files SELECT
-- (tenant member). Definer => an org-only manager who can WRITE but not SELECT the files row still passes
-- the write helper. Fixtures inserted privileged (bypass files RLS) so the helper is what is under test.
reset role;
insert into public.files (id, tenant_id, storage_path, original_filename, contract_id, uploaded_by) values
  ('15000000-0000-0000-0000-0000000000a1','11111111-1111-1111-1111-111111111111','contracts/a/a1.pdf','a1.pdf',
   'c0000000-0000-0000-0000-0000000000a1', null),                       -- F_A1: tenant A, Contract A1 (proc OrgA1)
  ('15000000-0000-0000-0000-0000000000cc','11111111-1111-1111-1111-111111111111','contracts/a/cc.pdf','cc.pdf',
   'c0000000-0000-0000-0000-0000000000cc', null),                       -- F_CENTRAL: tenant A, Contract A-central (paying OrgA3)
  ('15000000-0000-0000-0000-0000000000b1','22222222-2222-2222-2222-222222222222','contracts/b/b1.pdf','b1.pdf',
   null, null);                                                         -- F_B: tenant B, no contract

-- 35a: WRITE helper — tenant owner/admin/editor with contract-write authority PASS.
select set_config('request.jwt.claims','{"sub":"0a000000-0000-0000-0000-000000000001"}',false); set role authenticated; -- owner_a
do $$ begin assert public.can_write_contract_file('15000000-0000-0000-0000-0000000000a1','11111111-1111-1111-1111-111111111111'), 'T35 tenant owner with contract-write authority must pass write helper'; end $$;
reset role;
select set_config('request.jwt.claims','{"sub":"0a000000-0000-0000-0000-0000000000ad"}',false); set role authenticated; -- admin_a
do $$ begin assert public.can_write_contract_file('15000000-0000-0000-0000-0000000000a1','11111111-1111-1111-1111-111111111111'), 'T35 tenant admin must pass write helper'; end $$;
reset role;
select set_config('request.jwt.claims','{"sub":"0a000000-0000-0000-0000-0000000000ed"}',false); set role authenticated; -- editor_a
do $$ begin assert public.can_write_contract_file('15000000-0000-0000-0000-0000000000a1','11111111-1111-1111-1111-111111111111'), 'T35 tenant editor must pass write helper'; end $$;
reset role;

-- 35b: WRITE helper — procurement-org manager of the contract's org PASSES (org-only, not a tenant member).
select set_config('request.jwt.claims','{"sub":"0a000000-0000-0000-0000-0000000000a1"}',false); set role authenticated; -- mgr_a1 (manages OrgA1 = A1's proc org)
do $$ begin assert public.can_write_contract_file('15000000-0000-0000-0000-0000000000a1','11111111-1111-1111-1111-111111111111'), 'T35 procurement-org manager must pass write helper when contract-write authority allows'; end $$;
reset role;

-- 35c: WRITE helper DENIALS — paying-org-only manager, tenant viewer, cross-org manager, cross-tenant user.
select set_config('request.jwt.claims','{"sub":"0a000000-0000-0000-0000-0000000000c1"}',false); set role authenticated; -- agency_u (manages OrgA3 = A-central's PAYING org only)
do $$ begin assert not public.can_write_contract_file('15000000-0000-0000-0000-0000000000cc','11111111-1111-1111-1111-111111111111'), 'T35 paying-org-only manager must NOT pass write helper (read != write)'; end $$;
reset role;
select set_config('request.jwt.claims','{"sub":"0a000000-0000-0000-0000-000000000002"}',false); set role authenticated; -- viewer_a
do $$ begin assert not public.can_write_contract_file('15000000-0000-0000-0000-0000000000a1','11111111-1111-1111-1111-111111111111'), 'T35 tenant viewer must NOT pass write helper'; end $$;
reset role;
select set_config('request.jwt.claims','{"sub":"0a000000-0000-0000-0000-0000000000a3"}',false); set role authenticated; -- mgr_a2 (manages OrgA2, not A1's org)
do $$ begin assert not public.can_write_contract_file('15000000-0000-0000-0000-0000000000a1','11111111-1111-1111-1111-111111111111'), 'T35 cross-org manager must NOT pass write helper'; end $$;
reset role;
select set_config('request.jwt.claims','{"sub":"0b000000-0000-0000-0000-000000000001"}',false); set role authenticated; -- owner_b (tenant B)
do $$ begin assert not public.can_write_contract_file('15000000-0000-0000-0000-0000000000a1','11111111-1111-1111-1111-111111111111'), 'T35 cross-tenant user must NOT pass write helper for a tenant-A file'; end $$;
reset role;

-- 35d: WRITE helper FAIL-CLOSED — nonexistent file id, and right file with wrong tenant id.
select set_config('request.jwt.claims','{"sub":"0a000000-0000-0000-0000-0000000000ed"}',false); set role authenticated; -- editor_a
do $$ begin assert not public.can_write_contract_file('15000000-0000-0000-0000-00000000dead','11111111-1111-1111-1111-111111111111'), 'T35 nonexistent file id must fail closed (write)'; end $$;
do $$ begin assert not public.can_write_contract_file('15000000-0000-0000-0000-0000000000a1','22222222-2222-2222-2222-222222222222'), 'T35 wrong tenant id must fail closed (write)'; end $$;
reset role;

-- 35e: READ helper — a tenant member passes (owner and viewer both; read != write); org-only manager and
-- cross-tenant/non-member do NOT.
select set_config('request.jwt.claims','{"sub":"0a000000-0000-0000-0000-000000000001"}',false); set role authenticated; -- owner_a
do $$ begin assert public.can_read_contract_file('15000000-0000-0000-0000-0000000000a1','11111111-1111-1111-1111-111111111111'), 'T35 tenant member (owner) must pass read helper'; end $$;
reset role;
select set_config('request.jwt.claims','{"sub":"0a000000-0000-0000-0000-000000000002"}',false); set role authenticated; -- viewer_a
do $$ begin assert public.can_read_contract_file('15000000-0000-0000-0000-0000000000a1','11111111-1111-1111-1111-111111111111'), 'T35 tenant viewer (a member) must pass read helper'; end $$;
reset role;
select set_config('request.jwt.claims','{"sub":"0a000000-0000-0000-0000-0000000000a1"}',false); set role authenticated; -- mgr_a1 (org-only, NOT a tenant member)
do $$ begin assert not public.can_read_contract_file('15000000-0000-0000-0000-0000000000a1','11111111-1111-1111-1111-111111111111'), 'T35 org-only manager (not a tenant member) must NOT pass read helper (the 0013 asymmetry)'; end $$;
reset role;
select set_config('request.jwt.claims','{"sub":"0b000000-0000-0000-0000-000000000001"}',false); set role authenticated; -- owner_b (tenant B)
do $$ begin assert not public.can_read_contract_file('15000000-0000-0000-0000-0000000000a1','11111111-1111-1111-1111-111111111111'), 'T35 cross-tenant user must NOT pass read helper for a tenant-A file'; end $$;
reset role;
select set_config('request.jwt.claims','{"sub":"0a000000-0000-0000-0000-0000000000ff"}',false); set role authenticated; -- nobody (no membership)
do $$ begin assert not public.can_read_contract_file('15000000-0000-0000-0000-0000000000a1','11111111-1111-1111-1111-111111111111'), 'T35 non-tenant user must NOT pass read helper'; end $$;
reset role;

-- 35f: READ helper FAIL-CLOSED — nonexistent file id, and right file with wrong tenant id.
select set_config('request.jwt.claims','{"sub":"0a000000-0000-0000-0000-000000000001"}',false); set role authenticated; -- owner_a
do $$ begin assert not public.can_read_contract_file('15000000-0000-0000-0000-00000000dead','11111111-1111-1111-1111-111111111111'), 'T35 nonexistent file id must fail closed (read)'; end $$;
do $$ begin assert not public.can_read_contract_file('15000000-0000-0000-0000-0000000000a1','22222222-2222-2222-2222-222222222222'), 'T35 wrong tenant id must fail closed (read)'; end $$;
reset role;

-- ── Test 36: files UPDATE finalize policy (migration 0016) ───────────────────
-- 0016 adds a NARROW UPDATE policy: the UPLOADER (uploaded_by = auth.uid()) may update their OWN file
-- row for a contract they may write (can_write_contract). WITH CHECK repeats it, so uploaded_by /
-- tenant_id / contract_id cannot be reassigned; the column grant is update (upload_status) only. The app
-- uses it to FINALIZE a successful upload ('uploaded') or DISPOSITION a failed one ('failed'). Uses the
-- tenant-A file 13000000-…e1 that editor_a (0a…ed) inserted in T34b (contract A1, tenant A).
reset role;
-- 36a: the UPLOADER (editor_a) may finalize their OWN file → 'uploaded'.
select set_config('request.jwt.claims','{"sub":"0a000000-0000-0000-0000-0000000000ed"}',false); set role authenticated; -- editor_a (uploader)
do $$ declare v int; begin
  update public.files set upload_status='uploaded' where id='13000000-0000-0000-0000-0000000000e1';
  get diagnostics v = row_count;
  assert v = 1, format('T36 uploader should finalize their own file to uploaded (%s rows)', v);
end $$;
-- 36b: the UPLOADER may also disposition their OWN file → 'failed'.
do $$ declare v int; begin
  update public.files set upload_status='failed' where id='13000000-0000-0000-0000-0000000000e1';
  get diagnostics v = row_count;
  assert v = 1, format('T36 uploader should disposition their own file failed (%s rows)', v);
end $$;
-- 36c: WITH CHECK / column grant — the uploader cannot REASSIGN ownership (uploaded_by) of their own row.
do $$ declare ok boolean := false; begin
  begin
    update public.files set uploaded_by='0a000000-0000-0000-0000-000000000001'
      where id='13000000-0000-0000-0000-0000000000e1';
    ok := false;
  exception when insufficient_privilege then ok := true; end;
  assert ok, 'T36 uploader must NOT reassign uploaded_by (WITH CHECK / column grant)';
end $$;
-- 36d: WITH CHECK / FK — the uploader cannot MOVE their row cross-tenant.
do $$ declare ok boolean := false; begin
  begin
    update public.files set tenant_id='22222222-2222-2222-2222-222222222222'
      where id='13000000-0000-0000-0000-0000000000e1';
    ok := false;
  exception
    when insufficient_privilege then ok := true;
    when foreign_key_violation then ok := true;
    when check_violation then ok := true;
  end;
  assert ok, 'T36 uploader must NOT move their file cross-tenant';
end $$;
reset role;
-- 36e: a same-tenant NON-uploader (owner_a) updates 0 of editor_a's files (USING: uploaded_by != self).
select set_config('request.jwt.claims','{"sub":"0a000000-0000-0000-0000-000000000001"}',false); set role authenticated; -- owner_a (NOT the uploader)
do $$ declare v int; begin
  update public.files set upload_status='uploaded' where id='13000000-0000-0000-0000-0000000000e1';
  get diagnostics v = row_count;
  assert v = 0, format('T36 a same-tenant non-uploader must update 0 of another user files, saw %s', v);
end $$;
reset role;
-- 36f: a DIFFERENT tenant (owner_b) updates 0 tenant-A files (USING; cross-tenant).
select set_config('request.jwt.claims','{"sub":"0b000000-0000-0000-0000-000000000001"}',false); set role authenticated; -- owner_b (tenant B)
do $$ declare v int; begin
  update public.files set upload_status='uploaded' where id='13000000-0000-0000-0000-0000000000e1';
  get diagnostics v = row_count;
  assert v = 0, format('T36 a cross-tenant user must update 0 files, saw %s', v);
end $$;
reset role;

-- ── Test 37: `public.files` PRIVILEGE surface for `authenticated` (migration 0016) ───────────────────
-- `0016` REVOKEs the broad request-path mutations and grants ONLY `update (upload_status)`. Staging
-- verification caught `authenticated` holding BROAD DELETE/TRUNCATE/UPDATE on `public.files` (a
-- `grant update (col)` is additive and never revoked them; TRUNCATE especially bypasses row-level logic).
-- This proves the corrected surface: `authenticated` keeps SELECT + INSERT, has NO DELETE / NO TRUNCATE,
-- and may UPDATE ONLY `upload_status` — never any immutable column. (The harness re-asserts the migration-
-- intended files grants after its blanket crutch, so this reflects the REAL hosted privilege surface; the
-- catalog functions read any role's grants and are role-independent, run here as the reset superuser.)
reset role;
do $$ begin
  assert     has_table_privilege('authenticated','public.files','SELECT'),   'T37 authenticated must keep SELECT on files';
  assert     has_table_privilege('authenticated','public.files','INSERT'),   'T37 authenticated must keep INSERT on files';
  assert not has_table_privilege('authenticated','public.files','DELETE'),   'T37 authenticated must NOT have DELETE on files';
  assert not has_table_privilege('authenticated','public.files','TRUNCATE'), 'T37 authenticated must NOT have TRUNCATE on files';
  -- UPDATE is column-scoped to upload_status ONLY (immutable columns are NOT user-updatable).
  assert     has_column_privilege('authenticated','public.files','upload_status','UPDATE'),      'T37 authenticated must update upload_status';
  assert not has_column_privilege('authenticated','public.files','tenant_id','UPDATE'),          'T37 must NOT update tenant_id';
  assert not has_column_privilege('authenticated','public.files','contract_id','UPDATE'),        'T37 must NOT update contract_id';
  assert not has_column_privilege('authenticated','public.files','uploaded_by','UPDATE'),        'T37 must NOT update uploaded_by';
  assert not has_column_privilege('authenticated','public.files','storage_path','UPDATE'),       'T37 must NOT update storage_path';
  assert not has_column_privilege('authenticated','public.files','storage_bucket','UPDATE'),     'T37 must NOT update storage_bucket';
  assert not has_column_privilege('authenticated','public.files','original_filename','UPDATE'),  'T37 must NOT update original_filename';
  assert not has_column_privilege('authenticated','public.files','byte_size','UPDATE'),          'T37 must NOT update byte_size';
  assert not has_column_privilege('authenticated','public.files','content_type','UPDATE'),       'T37 must NOT update content_type';
  assert not has_column_privilege('authenticated','public.files','sha256','UPDATE'),             'T37 must NOT update sha256';
  -- the worker/AI-pipeline state columns the design most wants out of the request-path role's reach.
  assert not has_column_privilege('authenticated','public.files','scan_status','UPDATE'),            'T37 must NOT update scan_status';
  assert not has_column_privilege('authenticated','public.files','extraction_status','UPDATE'),      'T37 must NOT update extraction_status';
  assert not has_column_privilege('authenticated','public.files','extraction_result_json','UPDATE'), 'T37 must NOT update extraction_result_json';
  assert not has_column_privilege('authenticated','public.files','extraction_error','UPDATE'),       'T37 must NOT update extraction_error';
  assert not has_column_privilege('authenticated','public.files','document_type','UPDATE'),          'T37 must NOT update document_type';
  assert not has_column_privilege('authenticated','public.files','updated_at','UPDATE'),             'T37 must NOT update updated_at';
  -- EXACT invariant (robust to schema growth / hosted drift): authenticated holds UPDATE on EXACTLY one
  -- column, and it is upload_status — so any future column or stray column grant is caught, not just the
  -- ones enumerated above. (Run as the reset superuser, which sees all grants in column_privileges.)
  assert (
    select coalesce(array_agg(column_name::text order by column_name::text), array[]::text[])
    from information_schema.column_privileges
    where grantee = 'authenticated' and table_schema = 'public'
      and table_name = 'files' and privilege_type = 'UPDATE'
  ) = array['upload_status'], 'T37 authenticated must hold UPDATE on EXACTLY [upload_status] on files';
end $$;
reset role;

-- ── Test 38: connector vault Tier-1 metadata RLS (migration 0017) ────────────
-- public.connectors + public.connector_runs are tenant-member READ-only (is_tenant_member), hold NO
-- secret, and have NO INSERT/UPDATE/DELETE policy or grant (writes are a later server-only gated PR —
-- docs/42 §20). Fixtures inserted privileged (bypass RLS) so the policy/grant surface is what is tested.
reset role;
insert into public.connectors (id, tenant_id, provider, display_name, status, connected_by) values
  ('17000000-0000-0000-0000-0000000000a1','11111111-1111-1111-1111-111111111111','slack','Slack A','active','0a000000-0000-0000-0000-000000000001'),
  ('17000000-0000-0000-0000-0000000000b1','22222222-2222-2222-2222-222222222222','slack','Slack B','active','0b000000-0000-0000-0000-000000000001');
insert into public.connector_runs (id, tenant_id, connector_id, status) values
  ('17a00000-0000-0000-0000-0000000000a1','11111111-1111-1111-1111-111111111111','17000000-0000-0000-0000-0000000000a1','succeeded'),
  ('17a00000-0000-0000-0000-0000000000b1','22222222-2222-2222-2222-222222222222','17000000-0000-0000-0000-0000000000b1','succeeded');
-- A FAKE secret fixture (2 dummy bytes — NOT a real credential) so T39 can prove it is unreadable.
insert into public.connector_secrets (id, tenant_id, connector_id, secret_kind, ciphertext) values
  ('17b00000-0000-0000-0000-0000000000a1','11111111-1111-1111-1111-111111111111','17000000-0000-0000-0000-0000000000a1','oauth_access','\xdead'::bytea);

-- 38a: a tenant-A member reads ONLY tenant-A metadata.
select set_config('request.jwt.claims','{"sub":"0a000000-0000-0000-0000-000000000001"}',false); set role authenticated; -- owner_a
do $$ begin
  assert (select count(*) from public.connectors) = 1, 'T38 tenant-A member sees exactly its own 1 connector';
  assert (select count(*) from public.connectors where id='17000000-0000-0000-0000-0000000000b1') = 0, 'T38 tenant-A member must NOT see the tenant-B connector';
  assert (select count(*) from public.connector_runs) = 1, 'T38 tenant-A member sees exactly its own 1 connector run';
  assert (select count(*) from public.connector_runs where tenant_id='22222222-2222-2222-2222-222222222222') = 0, 'T38 tenant-A member must NOT see the tenant-B run';
end $$;
reset role;
-- 38b: cross-tenant — owner_b sees ONLY tenant-B metadata, never tenant A's.
select set_config('request.jwt.claims','{"sub":"0b000000-0000-0000-0000-000000000001"}',false); set role authenticated; -- owner_b
do $$ begin
  assert (select count(*) from public.connectors) = 1, 'T38 tenant-B member sees exactly its own 1 connector';
  assert (select count(*) from public.connectors where id='17000000-0000-0000-0000-0000000000a1') = 0, 'T38 cross-tenant: tenant-B must NOT see the tenant-A connector';
  assert (select count(*) from public.connector_runs where id='17a00000-0000-0000-0000-0000000000a1') = 0, 'T38 cross-tenant: tenant-B must NOT see the tenant-A run';
end $$;
reset role;
-- 38c: a non-member and an org-only manager (NOT a tenant member) read 0 (the is_tenant_member asymmetry).
select set_config('request.jwt.claims','{"sub":"0a000000-0000-0000-0000-0000000000ff"}',false); set role authenticated; -- nobody (no membership)
do $$ begin
  assert (select count(*) from public.connectors) = 0, 'T38 non-member sees 0 connectors';
  assert (select count(*) from public.connector_runs) = 0, 'T38 non-member sees 0 connector runs';
end $$;
reset role;
select set_config('request.jwt.claims','{"sub":"0a000000-0000-0000-0000-0000000000a1"}',false); set role authenticated; -- mgr_a1 (org-only, not a tenant member)
do $$ begin
  assert (select count(*) from public.connectors) = 0, 'T38 org-only manager (not a tenant member) sees 0 connectors';
end $$;
reset role;
-- 38d: anon has NO privilege to read any vault metadata.
set role anon;
do $$ declare ok boolean := false; begin
  begin perform 1 from public.connectors; ok := false; exception when insufficient_privilege then ok := true; end;
  assert ok, 'T38 anon must have NO privilege to read connectors';
end $$;
do $$ declare ok boolean := false; begin
  begin perform 1 from public.connector_runs; ok := false; exception when insufficient_privilege then ok := true; end;
  assert ok, 'T38 anon must have NO privilege to read connector_runs';
end $$;
reset role;
-- 38e: the request-path role cannot WRITE Tier-1 metadata (no INSERT/UPDATE/DELETE grant or policy yet).
select set_config('request.jwt.claims','{"sub":"0a000000-0000-0000-0000-000000000001"}',false); set role authenticated; -- owner_a (a tenant-A member)
do $$ declare ok boolean := false; begin
  begin insert into public.connectors (tenant_id, provider) values ('11111111-1111-1111-1111-111111111111','evil'); ok := false;
  exception when insufficient_privilege then ok := true; end;
  assert ok, 'T38 authenticated must NOT insert connectors (writes are a later server-only PR)';
end $$;
do $$ declare ok boolean := false; begin
  begin update public.connectors set status='active' where id='17000000-0000-0000-0000-0000000000a1'; ok := false;
  exception when insufficient_privilege then ok := true; end;
  assert ok, 'T38 authenticated must NOT update connectors';
end $$;
do $$ declare ok boolean := false; begin
  begin delete from public.connectors where id='17000000-0000-0000-0000-0000000000a1'; ok := false;
  exception when insufficient_privilege then ok := true; end;
  assert ok, 'T38 authenticated must NOT delete connectors';
end $$;
do $$ declare ok boolean := false; begin
  begin insert into public.connector_runs (tenant_id, connector_id, status) values ('11111111-1111-1111-1111-111111111111','17000000-0000-0000-0000-0000000000a1','queued'); ok := false;
  exception when insufficient_privilege then ok := true; end;
  assert ok, 'T38 authenticated must NOT insert connector_runs (server-only writes later)';
end $$;
reset role;
-- 38f: CONSTRAINT-LAYER tenant isolation (defense-in-depth, not merely RLS). Even the privileged role
-- cannot bind a tenant-B secret/run onto a tenant-A connector — the composite (connector_id, tenant_id) FK
-- to connectors(id, tenant_id) fails with foreign_key_violation (the 0005 pattern; analog of T26).
reset role;
do $$ declare ok boolean := false; begin
  begin
    insert into public.connector_secrets (tenant_id, connector_id, secret_kind)
      values ('22222222-2222-2222-2222-222222222222','17000000-0000-0000-0000-0000000000a1','api_key'); -- tenant-B row, tenant-A connector
    ok := false;
  exception when foreign_key_violation then ok := true; end;
  assert ok, 'T38 a tenant-B connector_secrets row must NOT bind a tenant-A connector (composite FK)';
end $$;
do $$ declare ok boolean := false; begin
  begin
    insert into public.connector_runs (tenant_id, connector_id, status)
      values ('22222222-2222-2222-2222-222222222222','17000000-0000-0000-0000-0000000000a1','queued'); -- tenant-B row, tenant-A connector
    ok := false;
  exception when foreign_key_violation then ok := true; end;
  assert ok, 'T38 a tenant-B connector_runs row must NOT bind a tenant-A connector (composite FK)';
end $$;
reset role;

-- ── Test 39: connector_secrets DENY-ALL + privilege surface (migration 0017) ─────────────────────────
-- The secret tier must have NO request-path access: RLS-enabled with ZERO policies (default deny-all) AND
-- the request-path roles hold NO base privilege. No SQL a logged-in user runs can read/write/delete a
-- secret. Proven at BOTH the runtime layer (39a/39b) and the catalog/privilege layer (39c — the 0016/T37
-- lesson, role-independent, run as the reset superuser) + structural no-secret-leak (39d).
-- 39a: a tenant-A member who CAN see the connector still CANNOT touch its secret material.
select set_config('request.jwt.claims','{"sub":"0a000000-0000-0000-0000-000000000001"}',false); set role authenticated; -- owner_a
do $$ declare ok boolean := false; begin
  begin perform 1 from public.connector_secrets; ok := false; exception when insufficient_privilege then ok := true; end;
  assert ok, 'T39 authenticated (even a tenant member) must NOT read connector_secrets (deny-all, no grant)';
end $$;
do $$ declare ok boolean := false; begin
  begin insert into public.connector_secrets (tenant_id, connector_id, secret_kind) values ('11111111-1111-1111-1111-111111111111','17000000-0000-0000-0000-0000000000a1','api_key'); ok := false;
  exception when insufficient_privilege then ok := true; end;
  assert ok, 'T39 authenticated must NOT insert connector_secrets';
end $$;
do $$ declare ok boolean := false; begin
  begin update public.connector_secrets set status='revoked'; ok := false; exception when insufficient_privilege then ok := true; end;
  assert ok, 'T39 authenticated must NOT update connector_secrets';
end $$;
do $$ declare ok boolean := false; begin
  begin delete from public.connector_secrets; ok := false; exception when insufficient_privilege then ok := true; end;
  assert ok, 'T39 authenticated must NOT delete connector_secrets';
end $$;
reset role;
-- 39b: anon is denied too.
set role anon;
do $$ declare ok boolean := false; begin
  begin perform 1 from public.connector_secrets; ok := false; exception when insufficient_privilege then ok := true; end;
  assert ok, 'T39 anon must NOT read connector_secrets';
end $$;
reset role;
-- 39c: PRIVILEGE SURFACE (catalog; role-independent; run as the reset superuser).
reset role;
do $$ begin
  assert not has_table_privilege('authenticated','public.connector_secrets','SELECT'),   'T39 authenticated must NOT have SELECT on connector_secrets';
  assert not has_table_privilege('authenticated','public.connector_secrets','INSERT'),   'T39 authenticated must NOT have INSERT on connector_secrets';
  assert not has_table_privilege('authenticated','public.connector_secrets','UPDATE'),   'T39 authenticated must NOT have UPDATE on connector_secrets';
  assert not has_table_privilege('authenticated','public.connector_secrets','DELETE'),   'T39 authenticated must NOT have DELETE on connector_secrets';
  assert not has_table_privilege('authenticated','public.connector_secrets','TRUNCATE'), 'T39 authenticated must NOT have TRUNCATE on connector_secrets';
  assert not has_table_privilege('anon','public.connector_secrets','SELECT'),            'T39 anon must NOT have SELECT on connector_secrets';
  -- EXACT invariant: authenticated holds ZERO privilege types on connector_secrets (robust to drift).
  assert (
    select coalesce(array_agg(distinct privilege_type::text order by privilege_type::text), array[]::text[])
    from information_schema.role_table_grants
    where grantee = 'authenticated' and table_schema = 'public' and table_name = 'connector_secrets'
  ) = array[]::text[], 'T39 authenticated must hold EXACTLY zero privileges on connector_secrets';
  -- Tier-1 metadata: authenticated keeps SELECT but NOT write (writes are a later gated PR).
  assert     has_table_privilege('authenticated','public.connectors','SELECT'),     'T39 authenticated keeps SELECT on connectors';
  assert not has_table_privilege('authenticated','public.connectors','INSERT'),     'T39 authenticated must NOT INSERT connectors';
  assert not has_table_privilege('authenticated','public.connectors','UPDATE'),     'T39 authenticated must NOT UPDATE connectors';
  assert not has_table_privilege('authenticated','public.connectors','DELETE'),     'T39 authenticated must NOT DELETE connectors';
  assert     has_table_privilege('authenticated','public.connector_runs','SELECT'), 'T39 authenticated keeps SELECT on connector_runs';
  assert not has_table_privilege('authenticated','public.connector_runs','INSERT'), 'T39 authenticated must NOT INSERT connector_runs';
  assert not has_table_privilege('authenticated','public.connector_runs','DELETE'), 'T39 authenticated must NOT DELETE connector_runs';
  -- EXACT invariant on the Tier-1 tables (the T37 files pattern): authenticated holds EXACTLY [SELECT] —
  -- catches any future stray grant (e.g. a hosted-default TRUNCATE/UPDATE) the per-privilege checks miss.
  assert (
    select coalesce(array_agg(distinct privilege_type::text order by privilege_type::text), array[]::text[])
    from information_schema.role_table_grants
    where grantee='authenticated' and table_schema='public' and table_name='connectors'
  ) = array['SELECT'], 'T39 authenticated must hold EXACTLY [SELECT] on connectors';
  assert (
    select coalesce(array_agg(distinct privilege_type::text order by privilege_type::text), array[]::text[])
    from information_schema.role_table_grants
    where grantee='authenticated' and table_schema='public' and table_name='connector_runs'
  ) = array['SELECT'], 'T39 authenticated must hold EXACTLY [SELECT] on connector_runs';
end $$;
-- 39d: RLS enabled on all three vault tables; secret table has ZERO policies; readable tables leak NO secret column.
do $$ begin
  assert (select relrowsecurity from pg_class where oid='public.connectors'::regclass),       'T39 connectors must have RLS enabled';
  assert (select relrowsecurity from pg_class where oid='public.connector_secrets'::regclass), 'T39 connector_secrets must have RLS enabled';
  assert (select relrowsecurity from pg_class where oid='public.connector_runs'::regclass),    'T39 connector_runs must have RLS enabled';
  assert (select count(*) from pg_policies where schemaname='public' and tablename='connector_secrets') = 0, 'T39 connector_secrets must have ZERO RLS policies (deny-all)';
  assert (select count(*) from information_schema.columns where table_schema='public' and table_name='connectors'     and column_name in ('ciphertext','dek_wrapped','aead_nonce','aad_digest','key_id')) = 0, 'T39 connectors (readable) must expose NO secret column';
  assert (select count(*) from information_schema.columns where table_schema='public' and table_name='connector_runs' and column_name in ('ciphertext','dek_wrapped','aead_nonce','aad_digest','key_id')) = 0, 'T39 connector_runs (readable) must expose NO secret column';
end $$;
reset role;

-- ── Test 40: connector vault HARDENED grant surface (migration 0018) ─────────────────────────────────
-- Staging verification of 0017 found anon/authenticated holding broad INSERT/UPDATE/DELETE/TRUNCATE/
-- REFERENCES/TRIGGER on connectors + connector_runs (0017 granted SELECT but never REVOKEd the hosted
-- default grants; the harness re-assert masked it). 0018 REVOKEs ALL from anon+authenticated on all three
-- vault tables, then GRANTs back ONLY SELECT to authenticated on the two Tier-1 tables; anon gets nothing.
-- This pins the EXACT per-role privilege surface (the catalog functions are role-independent; run as the
-- reset superuser). The harness re-assert mirrors 0018, so this reflects the REAL hosted surface.
reset role;
do $$
  declare priv_authenticated_connectors      text[];
          priv_authenticated_connector_runs  text[];
          priv_authenticated_connector_secrets text[];
          priv_anon_connectors               text[];
          priv_anon_connector_runs           text[];
          priv_anon_connector_secrets        text[];
begin
  select coalesce(array_agg(distinct privilege_type::text order by privilege_type::text), array[]::text[]) into priv_authenticated_connectors       from information_schema.role_table_grants where grantee='authenticated' and table_schema='public' and table_name='connectors';
  select coalesce(array_agg(distinct privilege_type::text order by privilege_type::text), array[]::text[]) into priv_authenticated_connector_runs   from information_schema.role_table_grants where grantee='authenticated' and table_schema='public' and table_name='connector_runs';
  select coalesce(array_agg(distinct privilege_type::text order by privilege_type::text), array[]::text[]) into priv_authenticated_connector_secrets from information_schema.role_table_grants where grantee='authenticated' and table_schema='public' and table_name='connector_secrets';
  select coalesce(array_agg(distinct privilege_type::text order by privilege_type::text), array[]::text[]) into priv_anon_connectors                from information_schema.role_table_grants where grantee='anon' and table_schema='public' and table_name='connectors';
  select coalesce(array_agg(distinct privilege_type::text order by privilege_type::text), array[]::text[]) into priv_anon_connector_runs            from information_schema.role_table_grants where grantee='anon' and table_schema='public' and table_name='connector_runs';
  select coalesce(array_agg(distinct privilege_type::text order by privilege_type::text), array[]::text[]) into priv_anon_connector_secrets         from information_schema.role_table_grants where grantee='anon' and table_schema='public' and table_name='connector_secrets';

  -- connector_secrets: ZERO privileges for BOTH request-path roles (deny-all intact).
  assert priv_authenticated_connector_secrets = array[]::text[], format('T40 authenticated must hold ZERO privileges on connector_secrets, saw %s', priv_authenticated_connector_secrets);
  assert priv_anon_connector_secrets          = array[]::text[], format('T40 anon must hold ZERO privileges on connector_secrets, saw %s', priv_anon_connector_secrets);
  -- connectors / connector_runs: authenticated EXACTLY [SELECT]; anon ZERO.
  assert priv_authenticated_connectors      = array['SELECT'], format('T40 authenticated must hold EXACTLY [SELECT] on connectors, saw %s', priv_authenticated_connectors);
  assert priv_authenticated_connector_runs  = array['SELECT'], format('T40 authenticated must hold EXACTLY [SELECT] on connector_runs, saw %s', priv_authenticated_connector_runs);
  assert priv_anon_connectors               = array[]::text[], format('T40 anon must hold ZERO privileges on connectors, saw %s', priv_anon_connectors);
  assert priv_anon_connector_runs           = array[]::text[], format('T40 anon must hold ZERO privileges on connector_runs, saw %s', priv_anon_connector_runs);

  -- Explicit negatives for the precise privileges staging found over-granted (TRUNCATE/REFERENCES/TRIGGER
  -- are NOT covered by the per-DML harness crutch, so a regression would otherwise slip through unnoticed).
  assert not has_table_privilege('authenticated','public.connectors','INSERT'),     'T40 authenticated must NOT have INSERT on connectors';
  assert not has_table_privilege('authenticated','public.connectors','UPDATE'),     'T40 authenticated must NOT have UPDATE on connectors';
  assert not has_table_privilege('authenticated','public.connectors','DELETE'),     'T40 authenticated must NOT have DELETE on connectors';
  assert not has_table_privilege('authenticated','public.connectors','TRUNCATE'),   'T40 authenticated must NOT have TRUNCATE on connectors';
  assert not has_table_privilege('authenticated','public.connectors','REFERENCES'), 'T40 authenticated must NOT have REFERENCES on connectors';
  assert not has_table_privilege('authenticated','public.connectors','TRIGGER'),    'T40 authenticated must NOT have TRIGGER on connectors';
  assert not has_table_privilege('authenticated','public.connector_runs','INSERT'),     'T40 authenticated must NOT have INSERT on connector_runs';
  assert not has_table_privilege('authenticated','public.connector_runs','UPDATE'),     'T40 authenticated must NOT have UPDATE on connector_runs';
  assert not has_table_privilege('authenticated','public.connector_runs','DELETE'),     'T40 authenticated must NOT have DELETE on connector_runs';
  assert not has_table_privilege('authenticated','public.connector_runs','TRUNCATE'),   'T40 authenticated must NOT have TRUNCATE on connector_runs';
  assert not has_table_privilege('authenticated','public.connector_runs','REFERENCES'), 'T40 authenticated must NOT have REFERENCES on connector_runs';
  assert not has_table_privilege('authenticated','public.connector_runs','TRIGGER'),    'T40 authenticated must NOT have TRIGGER on connector_runs';
  -- connector_secrets still has ZERO policies (deny-all) and the secret stays inaccessible to anon/authenticated.
  assert (select count(*) from pg_policies where schemaname='public' and tablename='connector_secrets') = 0, 'T40 connector_secrets must still have ZERO RLS policies';
  assert not has_table_privilege('authenticated','public.connector_secrets','SELECT'), 'T40 authenticated must NOT read connector_secrets';
  assert not has_table_privilege('anon','public.connector_secrets','SELECT'),          'T40 anon must NOT read connector_secrets';
end $$;
reset role;
-- 40b: tenant-scoped SELECT still works for the Tier-1 tables after 0018; cross-tenant still RLS-denied.
select set_config('request.jwt.claims','{"sub":"0a000000-0000-0000-0000-000000000001"}',false); set role authenticated; -- owner_a
do $$ begin
  assert (select count(*) from public.connectors) = 1, 'T40 tenant-A member still reads its own connector after 0018';
  assert (select count(*) from public.connector_runs) = 1, 'T40 tenant-A member still reads its own run after 0018';
  assert (select count(*) from public.connectors where id='17000000-0000-0000-0000-0000000000b1') = 0, 'T40 cross-tenant connector still denied by RLS after 0018';
end $$;
reset role;
-- 40c: anon cannot read any Tier-1 vault metadata (no privilege).
set role anon;
do $$ declare ok boolean := false; begin
  begin perform 1 from public.connectors; ok := false; exception when insufficient_privilege then ok := true; end;
  assert ok, 'T40 anon must have NO privilege to read connectors after 0018';
end $$;
do $$ declare ok boolean := false; begin
  begin perform 1 from public.connector_runs; ok := false; exception when insufficient_privilege then ok := true; end;
  assert ok, 'T40 anon must have NO privilege to read connector_runs after 0018';
end $$;
reset role;

-- ── Test 41: connector_runs LIFECYCLE schema (migration 0019) ─────────────────────────────────────────
-- 0019 widens connector_runs to the safe run-lifecycle shape: the six states (queued/running/succeeded/
-- failed/canceled/timed_out), the renamed completion/counter/failure-code columns, and the added safe
-- counter + failure-label columns. It adds NO grant and NO write policy (writes stay future server-only),
-- so the 0018 surface is unchanged: authenticated = [SELECT], anon = [], connector_runs holds NO secret
-- column, and audit reuses the append-only audit_logs (no new connector audit table).
reset role;
-- 41a: the six lifecycle states are accepted (privileged set-based insert; row visibility is RLS, T38/T40).
insert into public.connector_runs (id, tenant_id, connector_id, status)
select gen_random_uuid(), '11111111-1111-1111-1111-111111111111', '17000000-0000-0000-0000-0000000000a1', s
from unnest(array['queued','running','succeeded','failed','canceled','timed_out']) as s;
-- 41b: an out-of-set status is rejected by the check (the old 'success' value is no longer valid).
do $$ declare ok boolean := false; begin
  begin
    insert into public.connector_runs (id, tenant_id, connector_id, status)
      values (gen_random_uuid(),'11111111-1111-1111-1111-111111111111','17000000-0000-0000-0000-0000000000a1','success');
    ok := false;
  exception when check_violation then ok := true; end;
  assert ok, 'T41 connector_runs.status must reject an out-of-lifecycle value (e.g. the old success)';
end $$;
-- 41c: the renamed + added safe lifecycle columns exist; the old names are gone.
do $$ begin
  assert (select count(*) from information_schema.columns where table_schema='public' and table_name='connector_runs'
          and column_name in ('completed_at','records_seen','records_imported','records_failed','failure_code','failure_label')) = 6,
         'T41 connector_runs must have the 6 lifecycle columns (completed_at, records_*, failure_code, failure_label)';
  assert (select count(*) from information_schema.columns where table_schema='public' and table_name='connector_runs'
          and column_name in ('finished_at','items_seen','error_class')) = 0,
         'T41 the old connector_runs column names (finished_at/items_seen/error_class) must be gone';
  -- still NO secret column on the readable run table.
  assert (select count(*) from information_schema.columns where table_schema='public' and table_name='connector_runs'
          and column_name in ('ciphertext','dek_wrapped','aead_nonce','aad_digest','key_id','token','secret','api_key')) = 0,
         'T41 connector_runs (readable) must expose NO secret column';
end $$;
-- 41d: grant shape unchanged by 0019 — authenticated EXACTLY [SELECT], anon NOTHING, still no write policy.
do $$ begin
  assert (select coalesce(array_agg(distinct privilege_type::text order by privilege_type::text), array[]::text[])
          from information_schema.role_table_grants
          where grantee='authenticated' and table_schema='public' and table_name='connector_runs') = array['SELECT'],
         'T41 authenticated must still hold EXACTLY [SELECT] on connector_runs after 0019';
  assert (select coalesce(array_agg(distinct privilege_type::text order by privilege_type::text), array[]::text[])
          from information_schema.role_table_grants
          where grantee='anon' and table_schema='public' and table_name='connector_runs') = array[]::text[],
         'T41 anon must still hold ZERO privileges on connector_runs after 0019';
  assert (select count(*) from pg_policies where schemaname='public' and tablename='connector_runs' and cmd <> 'SELECT') = 0,
         'T41 connector_runs must have NO non-SELECT (write) policy';
  -- audit reuses the existing append-only audit_logs — 0019 created NO new connector audit table.
  assert (select count(*) from information_schema.tables where table_schema='public' and table_name like 'connector_audit%') = 0,
         'T41 no separate connector audit table exists (audit reuses append-only audit_logs)';
end $$;
-- 41e: the request-path role still cannot WRITE a run after 0019 (server-only writes remain a later PR).
select set_config('request.jwt.claims','{"sub":"0a000000-0000-0000-0000-000000000001"}',false); set role authenticated; -- owner_a (tenant-A member)
do $$ declare ok boolean := false; begin
  begin insert into public.connector_runs (tenant_id, connector_id, status)
    values ('11111111-1111-1111-1111-111111111111','17000000-0000-0000-0000-0000000000a1','queued'); ok := false;
  exception when insufficient_privilege then ok := true; end;
  assert ok, 'T41 authenticated must still NOT insert connector_runs after 0019 (server-only writes later)';
end $$;
reset role;

-- ── Test 42: oauth_pending single-use replay store DENY-ALL + posture (migration 0020) ───────────────
-- The OAuth replay store is near-Tier-2: RLS-enabled with ZERO policies (default deny-all) AND the
-- request-path roles hold NO base privilege — no SQL a logged-in user runs can read/write it (server-only
-- consume in a later PR). Proven at the runtime layer (42a/42b) + the catalog/privilege layer (42c) +
-- structural posture (42d: composite-FK cross-tenant block, UNIQUE single-use, no secret column).
reset role;
-- 42a: a tenant-A member cannot read/insert/update/delete oauth_pending (deny-all, no grant).
select set_config('request.jwt.claims','{"sub":"0a000000-0000-0000-0000-000000000001"}',false); set role authenticated; -- owner_a
do $$ declare ok boolean := false; begin
  begin perform 1 from public.oauth_pending; ok := false; exception when insufficient_privilege then ok := true; end;
  assert ok, 'T42 authenticated must NOT read oauth_pending (deny-all, no grant)';
end $$;
do $$ declare ok boolean := false; begin
  begin insert into public.oauth_pending (tenant_id, provider, state_jti, nonce_hash, intent, expires_at)
    values ('11111111-1111-1111-1111-111111111111','github','jti-x','hash-x','connect', now() + interval '10 min'); ok := false;
  exception when insufficient_privilege then ok := true; end;
  assert ok, 'T42 authenticated must NOT insert oauth_pending';
end $$;
do $$ declare ok boolean := false; begin
  begin update public.oauth_pending set consumed_at = now(); ok := false; exception when insufficient_privilege then ok := true; end;
  assert ok, 'T42 authenticated must NOT update oauth_pending';
end $$;
do $$ declare ok boolean := false; begin
  begin delete from public.oauth_pending; ok := false; exception when insufficient_privilege then ok := true; end;
  assert ok, 'T42 authenticated must NOT delete oauth_pending';
end $$;
reset role;
-- 42b: anon is denied too.
set role anon;
do $$ declare ok boolean := false; begin
  begin perform 1 from public.oauth_pending; ok := false; exception when insufficient_privilege then ok := true; end;
  assert ok, 'T42 anon must NOT read oauth_pending';
end $$;
reset role;
-- 42c: PRIVILEGE SURFACE (catalog; role-independent; run as the reset superuser) — EXACTLY zero privileges.
reset role;
do $$ begin
  assert not has_table_privilege('authenticated','public.oauth_pending','SELECT'),   'T42 authenticated must NOT have SELECT on oauth_pending';
  assert not has_table_privilege('authenticated','public.oauth_pending','INSERT'),   'T42 authenticated must NOT have INSERT on oauth_pending';
  assert not has_table_privilege('authenticated','public.oauth_pending','UPDATE'),   'T42 authenticated must NOT have UPDATE on oauth_pending';
  assert not has_table_privilege('authenticated','public.oauth_pending','DELETE'),   'T42 authenticated must NOT have DELETE on oauth_pending';
  assert not has_table_privilege('authenticated','public.oauth_pending','TRUNCATE'), 'T42 authenticated must NOT have TRUNCATE on oauth_pending';
  assert not has_table_privilege('anon','public.oauth_pending','SELECT'),            'T42 anon must NOT have SELECT on oauth_pending';
  -- EXACT invariant: authenticated holds ZERO privilege types on oauth_pending (robust to drift).
  assert (
    select coalesce(array_agg(distinct privilege_type::text order by privilege_type::text), array[]::text[])
    from information_schema.role_table_grants
    where grantee = 'authenticated' and table_schema = 'public' and table_name = 'oauth_pending'
  ) = array[]::text[], 'T42 authenticated must hold EXACTLY zero privileges on oauth_pending';
  assert (
    select coalesce(array_agg(distinct privilege_type::text order by privilege_type::text), array[]::text[])
    from information_schema.role_table_grants
    where grantee = 'anon' and table_schema = 'public' and table_name = 'oauth_pending'
  ) = array[]::text[], 'T42 anon must hold EXACTLY zero privileges on oauth_pending';
end $$;
-- 42d: structural — RLS enabled, ZERO policies, no secret column; UNIQUE single-use; composite-FK cross-tenant block.
do $$ begin
  assert (select relrowsecurity from pg_class where oid='public.oauth_pending'::regclass), 'T42 oauth_pending must have RLS enabled';
  assert (select count(*) from pg_policies where schemaname='public' and tablename='oauth_pending') = 0, 'T42 oauth_pending must have ZERO RLS policies (deny-all)';
  -- NO secret/token/code column ever (only hashes + safe metadata).
  assert (select count(*) from information_schema.columns where table_schema='public' and table_name='oauth_pending'
          and column_name in ('nonce','raw_nonce','state','state_payload','code','authorization_code','access_token','refresh_token','api_key','webhook_secret','ciphertext','pkce_verifier','code_verifier')) = 0,
         'T42 oauth_pending must expose NO raw nonce / state / code / token / secret column';
  -- expires_at is required (NOT NULL).
  assert (select is_nullable from information_schema.columns where table_schema='public' and table_name='oauth_pending' and column_name='expires_at') = 'NO',
         'T42 oauth_pending.expires_at must be NOT NULL (a pending row always expires)';
  -- single-use: UNIQUE on state_jti and nonce_hash.
  assert (select count(*) from pg_constraint where conrelid='public.oauth_pending'::regclass and contype='u' and conname in ('oauth_pending_state_jti_key','oauth_pending_nonce_hash_key')) = 2,
         'T42 oauth_pending must UNIQUE-constrain state_jti and nonce_hash (single-use)';
end $$;
-- 42e: a UNIQUE state_jti / nonce_hash blocks a duplicate (single-use) — privileged inserts (run as superuser).
insert into public.oauth_pending (id, tenant_id, connector_id, provider, state_jti, nonce_hash, intent, expires_at)
  values ('42a00000-0000-0000-0000-0000000000a1','11111111-1111-1111-1111-111111111111','17000000-0000-0000-0000-0000000000a1','github','jti-A','hash-A','connect', now() + interval '10 min');
do $$ declare ok boolean := false; begin
  begin -- same state_jti again → unique violation
    insert into public.oauth_pending (tenant_id, provider, state_jti, nonce_hash, intent, expires_at)
      values ('11111111-1111-1111-1111-111111111111','github','jti-A','hash-B','connect', now() + interval '10 min'); ok := false;
  exception when unique_violation then ok := true; end;
  assert ok, 'T42 duplicate state_jti must be rejected (single-use UNIQUE)';
end $$;
do $$ declare ok boolean := false; begin
  begin -- same nonce_hash again → unique violation
    insert into public.oauth_pending (tenant_id, provider, state_jti, nonce_hash, intent, expires_at)
      values ('11111111-1111-1111-1111-111111111111','github','jti-C','hash-A','connect', now() + interval '10 min'); ok := false;
  exception when unique_violation then ok := true; end;
  assert ok, 'T42 duplicate nonce_hash must be rejected (single-use UNIQUE)';
end $$;
-- 42f: a tenant-B row binding a tenant-A connector is blocked structurally by the composite FK.
do $$ declare ok boolean := false; begin
  begin
    insert into public.oauth_pending (tenant_id, connector_id, provider, state_jti, nonce_hash, intent, expires_at)
      values ('22222222-2222-2222-2222-222222222222','17000000-0000-0000-0000-0000000000a1','github','jti-D','hash-D','connect', now() + interval '10 min'); ok := false;
  exception when foreign_key_violation then ok := true; end;
  assert ok, 'T42 a tenant-B oauth_pending row must NOT bind a tenant-A connector (composite FK)';
end $$;
-- 42g: connector_secrets remains untouched by 0020 (still deny-all, zero authenticated privilege).
do $$ begin
  assert (select coalesce(array_agg(distinct privilege_type::text order by privilege_type::text), array[]::text[])
          from information_schema.role_table_grants
          where grantee='authenticated' and table_schema='public' and table_name='connector_secrets') = array[]::text[],
         'T42 connector_secrets must STILL hold zero authenticated privilege after 0020';
  assert (select count(*) from pg_policies where schemaname='public' and tablename='connector_secrets') = 0,
         'T42 connector_secrets must STILL have zero policies after 0020';
  -- connector metadata grants unchanged: authenticated EXACTLY [SELECT] on connectors/connector_runs.
  assert (select coalesce(array_agg(distinct privilege_type::text order by privilege_type::text), array[]::text[])
          from information_schema.role_table_grants
          where grantee='authenticated' and table_schema='public' and table_name='connectors') = array['SELECT'],
         'T42 authenticated must STILL hold EXACTLY [SELECT] on connectors after 0020';
  assert (select coalesce(array_agg(distinct privilege_type::text order by privilege_type::text), array[]::text[])
          from information_schema.role_table_grants
          where grantee='authenticated' and table_schema='public' and table_name='connector_runs') = array['SELECT'],
         'T42 authenticated must STILL hold EXACTLY [SELECT] on connector_runs after 0020';
end $$;
reset role;

-- ── Test 43: connector_runner DB grant foundation (migration 0021) ───────────────────────────────────
-- The dedicated server-side runner role gets a NARROW least-privilege grant: ONLY oauth_pending SELECT +
-- a 3-column UPDATE. It is BYPASSRLS (a trusted server principal constrained by its grants + a tenant-bound
-- query contract — docs/42 §39.1/§39.2), NOT the broad service_role, and is granted NOTHING on
-- connector_secrets/connectors/connector_runs (deferred). anon/authenticated keep their deny-all surface.
reset role;
-- 43a: the role exists and is BYPASSRLS + NOLOGIN (a privilege role, not a login).
do $$ begin
  assert exists (select 1 from pg_roles where rolname='connector_runner'), 'T43 connector_runner role must exist (0021)';
  assert (select rolbypassrls from pg_roles where rolname='connector_runner'), 'T43 connector_runner must be BYPASSRLS (trusted server principal — docs/42 §39.1)';
  assert not (select rolcanlogin from pg_roles where rolname='connector_runner'), 'T43 connector_runner must be NOLOGIN';
end $$;
-- 43b: EXACT privilege surface on oauth_pending — SELECT (table) + UPDATE on EXACTLY 3 columns; nothing else.
do $$ begin
  assert has_table_privilege('connector_runner','public.oauth_pending','SELECT'), 'T43 runner must have SELECT on oauth_pending';
  -- the UPDATE column grant is EXACTLY {consumed_at, attempt_count, last_rejected_code}.
  assert (select coalesce(array_agg(distinct column_name::text order by column_name::text), array[]::text[])
          from information_schema.role_column_grants
          where grantee='connector_runner' and table_schema='public' and table_name='oauth_pending' and privilege_type='UPDATE')
         = array['attempt_count','consumed_at','last_rejected_code'],
         'T43 runner UPDATE columns on oauth_pending must be EXACTLY {consumed_at, attempt_count, last_rejected_code}';
  assert     has_column_privilege('connector_runner','public.oauth_pending','consumed_at','UPDATE'),      'T43 runner updates consumed_at';
  assert     has_column_privilege('connector_runner','public.oauth_pending','attempt_count','UPDATE'),    'T43 runner updates attempt_count';
  assert     has_column_privilege('connector_runner','public.oauth_pending','last_rejected_code','UPDATE'),'T43 runner updates last_rejected_code';
  -- the IMMUTABLE identity columns are NOT updatable by the runner.
  assert not has_column_privilege('connector_runner','public.oauth_pending','tenant_id','UPDATE'),  'T43 runner must NOT update tenant_id';
  assert not has_column_privilege('connector_runner','public.oauth_pending','state_jti','UPDATE'),  'T43 runner must NOT update state_jti';
  assert not has_column_privilege('connector_runner','public.oauth_pending','nonce_hash','UPDATE'), 'T43 runner must NOT update nonce_hash';
  assert not has_column_privilege('connector_runner','public.oauth_pending','provider','UPDATE'),   'T43 runner must NOT update provider';
  assert not has_column_privilege('connector_runner','public.oauth_pending','expires_at','UPDATE'), 'T43 runner must NOT update expires_at';
  -- INSERT is now granted COLUMN-scoped by 0022 (has_table_privilege stays false for a column grant — proved
  -- in detail by T44 via has_column_privilege + role_column_grants).
  assert     has_column_privilege('connector_runner','public.oauth_pending','tenant_id','INSERT'), 'T43 runner now HAS column-scoped INSERT on oauth_pending (0022 — see T44)';
  assert not has_table_privilege('connector_runner','public.oauth_pending','DELETE'),    'T43 runner must NOT DELETE oauth_pending (later PR)';
  assert not has_table_privilege('connector_runner','public.oauth_pending','TRUNCATE'),  'T43 runner must NOT have row-purge on oauth_pending';
  assert not has_table_privilege('connector_runner','public.oauth_pending','REFERENCES'),'T43 runner must NOT REFERENCES oauth_pending';
  assert not has_table_privilege('connector_runner','public.oauth_pending','TRIGGER'),   'T43 runner must NOT TRIGGER oauth_pending';
end $$;
-- 43c: connectors/connector_runs grants are STILL deferred (zero). connector_secrets has NO TABLE-LEVEL grant —
-- 0029's secret-store grant is COLUMN-scoped (full surface in T50), so role_table_grants stays empty here.
do $$ begin
  assert (select coalesce(array_agg(distinct privilege_type::text order by privilege_type::text), array[]::text[]) from information_schema.role_table_grants
          where grantee='connector_runner' and table_schema='public' and table_name='connector_secrets') = array[]::text[],
         'T43 runner holds ZERO TABLE-LEVEL privilege on connector_secrets (0029 grants are COLUMN-scoped — see T50)';
  assert (select coalesce(array_agg(distinct privilege_type::text), array[]::text[]) from information_schema.role_table_grants
          where grantee='connector_runner' and table_schema='public' and table_name='connectors') = array[]::text[],
         'T43 runner must hold ZERO privilege on connectors (deferred)';
  assert (select coalesce(array_agg(distinct privilege_type::text), array[]::text[]) from information_schema.role_table_grants
          where grantee='connector_runner' and table_schema='public' and table_name='connector_runs') = array[]::text[],
         'T43 runner must hold ZERO privilege on connector_runs (deferred)';
end $$;
-- 43d: FUNCTIONAL — the runner can consume (SELECT + UPDATE consumed_at, the §38 shape) but nothing else.
insert into public.oauth_pending (id, tenant_id, connector_id, provider, state_jti, nonce_hash, intent, expires_at)
  values ('43a00000-0000-0000-0000-0000000000a1','11111111-1111-1111-1111-111111111111','17000000-0000-0000-0000-0000000000a1','github','jti-runner','hash-runner','connect', now() + interval '10 min');
set role connector_runner;
do $$ begin
  -- can read (BYPASSRLS skips the deny-all RLS; the SELECT grant applies).
  assert (select count(*) from public.oauth_pending where state_jti='jti-runner') = 1, 'T43 runner can SELECT oauth_pending';
  -- can perform the atomic consume update shape (set consumed_at).
  update public.oauth_pending set consumed_at = now() where state_jti='jti-runner' and consumed_at is null and expires_at > now();
  assert (select consumed_at is not null from public.oauth_pending where state_jti='jti-runner'), 'T43 runner can set consumed_at (consume)';
end $$;
do $$ declare ok boolean := false; begin
  begin update public.oauth_pending set tenant_id='22222222-2222-2222-2222-222222222222' where state_jti='jti-runner'; ok := false;
  exception when insufficient_privilege then ok := true; end;
  assert ok, 'T43 runner must NOT update an immutable identity column (tenant_id)';
end $$;
do $$ declare ok boolean := false; begin
  begin delete from public.oauth_pending where state_jti='jti-runner'; ok := false;
  exception when insufficient_privilege then ok := true; end;
  assert ok, 'T43 runner must NOT DELETE oauth_pending';
end $$;
-- (43d INSERT coverage moved to T44 — the runner now HAS column-scoped INSERT via 0022.)
do $$ begin
  -- 0029: the runner now HAS COLUMN-scoped SELECT on connector_secrets — it can read a granted column (id);
  -- decrypt still needs the separate KMS Decrypt grant (ciphertext alone is useless). Full surface in T50.
  perform id from public.connector_secrets limit 1;
end $$;
reset role;
-- 43e: anon/authenticated deny-all surface UNCHANGED after 0021.
do $$ begin
  assert (select coalesce(array_agg(distinct privilege_type::text), array[]::text[]) from information_schema.role_table_grants
          where grantee='authenticated' and table_schema='public' and table_name='oauth_pending') = array[]::text[],
         'T43 authenticated must STILL hold zero privilege on oauth_pending after 0021';
  assert (select coalesce(array_agg(distinct privilege_type::text), array[]::text[]) from information_schema.role_table_grants
          where grantee='authenticated' and table_schema='public' and table_name='connector_secrets') = array[]::text[],
         'T43 authenticated must STILL hold zero privilege on connector_secrets after 0021';
  assert (select coalesce(array_agg(distinct privilege_type::text), array[]::text[]) from information_schema.role_table_grants
          where grantee='anon' and table_schema='public' and table_name='oauth_pending') = array[]::text[],
         'T43 anon must STILL hold zero privilege on oauth_pending after 0021';
  assert (select coalesce(array_agg(distinct privilege_type::text order by privilege_type::text), array[]::text[]) from information_schema.role_table_grants
          where grantee='authenticated' and table_schema='public' and table_name='connectors') = array['SELECT'],
         'T43 authenticated must STILL hold EXACTLY [SELECT] on connectors after 0021';
  assert (select count(*) from pg_policies where schemaname='public' and tablename='oauth_pending') = 0,
         'T43 oauth_pending must STILL have ZERO policies after 0021 (no browser-role policy added)';
end $$;
-- 43f: a normal authenticated user STILL cannot consume oauth_pending or touch connector_secrets.
select set_config('request.jwt.claims','{"sub":"0a000000-0000-0000-0000-000000000001"}',false); set role authenticated; -- owner_a
do $$ declare ok boolean := false; begin
  begin update public.oauth_pending set consumed_at = now(); ok := false; exception when insufficient_privilege then ok := true; end;
  assert ok, 'T43 authenticated must STILL NOT consume oauth_pending after 0021';
end $$;
do $$ declare ok boolean := false; begin
  begin perform 1 from public.connector_secrets; ok := false; exception when insufficient_privilege then ok := true; end;
  assert ok, 'T43 authenticated must STILL NOT read connector_secrets after 0021';
end $$;
reset role;

-- ── Test 44: connector_runner authorize-time oauth_pending INSERT grant (migration 0022) ─────────────
-- 0022 grants connector_runner a COLUMN-LEVEL INSERT on oauth_pending — ONLY the 9 §50 authorize-time
-- columns. It can create a replay row but cannot supply consumed_at/attempt_count/last_rejected_code on
-- INSERT, cannot DELETE/row-purge, and gains NOTHING on connector_secrets/connectors/connector_runs. anon/
-- authenticated stay deny-all; no policy is added.
reset role;
-- 44a: the runner's INSERT column grant on oauth_pending is EXACTLY the 9 authorize-time columns.
do $$ begin
  assert (select coalesce(array_agg(distinct column_name::text order by column_name::text), array[]::text[])
          from information_schema.role_column_grants
          where grantee='connector_runner' and table_schema='public' and table_name='oauth_pending' and privilege_type='INSERT')
         = array['connector_id','expires_at','intent','nonce_hash','organization_id','provider','state_jti','subject','tenant_id'],
         'T44 runner INSERT columns on oauth_pending must be EXACTLY the 9 authorize-time columns (0022)';
  -- the runner can INSERT the allowed columns, but NOT the consume/counter columns.
  assert     has_column_privilege('connector_runner','public.oauth_pending','tenant_id','INSERT'),   'T44 runner can INSERT tenant_id';
  assert     has_column_privilege('connector_runner','public.oauth_pending','state_jti','INSERT'),   'T44 runner can INSERT state_jti';
  assert     has_column_privilege('connector_runner','public.oauth_pending','nonce_hash','INSERT'),  'T44 runner can INSERT nonce_hash';
  assert     has_column_privilege('connector_runner','public.oauth_pending','expires_at','INSERT'),  'T44 runner can INSERT expires_at';
  -- the grant is COLUMN-level only: the runner holds NO table-level INSERT (catches a future over-grant).
  assert not has_table_privilege('connector_runner','public.oauth_pending','INSERT'), 'T44 runner must NOT hold table-level INSERT on oauth_pending (column grant only)';
  assert not has_column_privilege('connector_runner','public.oauth_pending','consumed_at','INSERT'),       'T44 runner must NOT INSERT consumed_at';
  assert not has_column_privilege('connector_runner','public.oauth_pending','attempt_count','INSERT'),     'T44 runner must NOT INSERT attempt_count';
  assert not has_column_privilege('connector_runner','public.oauth_pending','last_rejected_code','INSERT'),'T44 runner must NOT INSERT last_rejected_code';
  -- the existing surface is unchanged: SELECT kept; UPDATE columns still EXACTLY the 3 consume columns.
  assert has_table_privilege('connector_runner','public.oauth_pending','SELECT'), 'T44 runner keeps SELECT on oauth_pending';
  assert (select coalesce(array_agg(distinct column_name::text order by column_name::text), array[]::text[])
          from information_schema.role_column_grants
          where grantee='connector_runner' and table_schema='public' and table_name='oauth_pending' and privilege_type='UPDATE')
         = array['attempt_count','consumed_at','last_rejected_code'],
         'T44 runner UPDATE columns on oauth_pending stay EXACTLY {consumed_at, attempt_count, last_rejected_code}';
  -- still no broad verbs.
  assert not has_table_privilege('connector_runner','public.oauth_pending','DELETE'),    'T44 runner must NOT DELETE oauth_pending';
  assert not has_table_privilege('connector_runner','public.oauth_pending','TRUNCATE'),  'T44 runner must NOT row-purge oauth_pending';
  assert not has_table_privilege('connector_runner','public.oauth_pending','REFERENCES'),'T44 runner must NOT REFERENCES oauth_pending';
  assert not has_table_privilege('connector_runner','public.oauth_pending','TRIGGER'),   'T44 runner must NOT TRIGGER oauth_pending';
end $$;
-- 44b: FUNCTIONAL — the runner can INSERT a row supplying only the allowed columns, but NOT a disallowed one.
set role connector_runner;
do $$ begin
  insert into public.oauth_pending (tenant_id, organization_id, connector_id, provider, subject, state_jti, nonce_hash, intent, expires_at)
    values ('11111111-1111-1111-1111-111111111111', null, null, 'slack', null, 'jti-0022-insert', 'hash-0022-insert', 'connect', now() + interval '10 min');
  assert (select count(*) from public.oauth_pending where state_jti='jti-0022-insert') = 1, 'T44 runner can INSERT an authorize-time row';
end $$;
do $$ declare ok boolean := false; begin
  -- supplying a NON-granted column (consumed_at) on INSERT is permission-denied.
  begin
    insert into public.oauth_pending (tenant_id, provider, state_jti, nonce_hash, intent, expires_at, consumed_at)
      values ('11111111-1111-1111-1111-111111111111','slack','jti-0022-bad','hash-0022-bad','connect', now() + interval '10 min', now());
    ok := false;
  exception when insufficient_privilege then ok := true; end;
  assert ok, 'T44 runner must NOT INSERT a non-granted column (consumed_at)';
end $$;
reset role;
-- 44c: connectors/connector_runs runner grants are STILL deferred (zero); connector_secrets has NO TABLE-LEVEL
-- grant — 0029's secret-store grant is COLUMN-scoped (full surface in T50). 0022 itself adds nothing here.
do $$ begin
  assert (select coalesce(array_agg(distinct privilege_type::text order by privilege_type::text), array[]::text[]) from information_schema.role_table_grants
          where grantee='connector_runner' and table_schema='public' and table_name='connector_secrets') = array[]::text[],
         'T44 runner holds ZERO TABLE-LEVEL privilege on connector_secrets (0029 grants are COLUMN-scoped — see T50)';
  assert (select coalesce(array_agg(distinct privilege_type::text), array[]::text[]) from information_schema.role_table_grants
          where grantee='connector_runner' and table_schema='public' and table_name='connectors') = array[]::text[],
         'T44 runner must STILL hold ZERO privilege on connectors';
  assert (select coalesce(array_agg(distinct privilege_type::text), array[]::text[]) from information_schema.role_table_grants
          where grantee='connector_runner' and table_schema='public' and table_name='connector_runs') = array[]::text[],
         'T44 runner must STILL hold ZERO privilege on connector_runs';
end $$;
-- 44d: anon/authenticated deny-all + zero-policy posture UNCHANGED after 0022.
do $$ begin
  assert (select coalesce(array_agg(distinct privilege_type::text), array[]::text[]) from information_schema.role_table_grants
          where grantee='authenticated' and table_schema='public' and table_name='oauth_pending') = array[]::text[],
         'T44 authenticated must STILL hold zero privilege on oauth_pending after 0022';
  assert (select coalesce(array_agg(distinct privilege_type::text), array[]::text[]) from information_schema.role_table_grants
          where grantee='anon' and table_schema='public' and table_name='oauth_pending') = array[]::text[],
         'T44 anon must STILL hold zero privilege on oauth_pending after 0022';
  assert (select coalesce(array_agg(distinct privilege_type::text), array[]::text[]) from information_schema.role_table_grants
          where grantee='authenticated' and table_schema='public' and table_name='connector_secrets') = array[]::text[],
         'T44 authenticated must STILL hold zero privilege on connector_secrets after 0022';
  assert (select coalesce(array_agg(distinct privilege_type::text), array[]::text[]) from information_schema.role_table_grants
          where grantee='anon' and table_schema='public' and table_name='connector_secrets') = array[]::text[],
         'T44 anon must STILL hold zero privilege on connector_secrets after 0022';
  assert (select count(*) from pg_policies where schemaname='public' and tablename='oauth_pending') = 0,
         'T44 oauth_pending must STILL have ZERO policies after 0022';
  assert (select count(*) from pg_policies where schemaname='public' and tablename='connector_secrets') = 0,
         'T44 connector_secrets must STILL have ZERO policies after 0022';
end $$;

-- ── Test 45: graph-scale discovery indexes (migration 0023) ──────────────────────────────────────────
-- 0023 adds schema-grounded indexes for discovery / matching / RLS hot paths / app-graph normalization.
-- This re-asserts a representative sample exists (incl. the lower(email)/lower(name) functional indexes and
-- the person_id match indexes), plus the schema-grounding guards (no identity_account_id column; the match
-- graph is app_user → person). Index-only — no grant/policy/RLS-behavior change.
reset role;
do $$
  declare want text;
  declare missing text[] := array[]::text[];
begin
  -- a representative sample across the key shapes: RLS hot path, discovery volume, matching, functional
  -- case-insensitive email/name, and owning-org joins.
  foreach want in array array[
    'tenant_memberships_user_tenant_status_idx',
    'app_users_tenant_app_idx', 'app_users_email_lower_idx', 'app_users_external_user_id_idx',
    'identity_accounts_person_idx', 'identity_accounts_email_lower_idx',
    'people_primary_email_lower_idx',
    'app_user_identity_matches_person_idx', 'app_user_identity_matches_tenant_idx',
    'apps_tenant_status_idx', 'apps_vendor_name_lower_idx', 'apps_name_lower_idx', 'apps_paying_org_idx',
    'contracts_vendor_name_lower_idx', 'contracts_renewal_date_idx',
    'invoices_tenant_invoice_date_idx', 'app_contracts_contract_idx',
    'license_evaluations_app_user_idx', 'license_rules_app_active_idx'
  ]
  loop
    if not exists (select 1 from pg_indexes where schemaname = 'public' and indexname = want) then
      missing := missing || want;
    end if;
  end loop;
  assert missing = array[]::text[], 'T45 expected graph-scale indexes are missing: ' || array_to_string(missing, ', ');
end $$;
-- the lower(email)/lower(name) indexes are FUNCTIONAL (expression) indexes — confirm via pg_indexes defs.
do $$ begin
  assert (select indexdef ilike '%lower(email)%' from pg_indexes where indexname = 'app_users_email_lower_idx'),
         'T45 app_users_email_lower_idx must be a lower(email) functional index';
  assert (select indexdef ilike '%lower(name)%' from pg_indexes where indexname = 'apps_name_lower_idx'),
         'T45 apps_name_lower_idx must be a lower(name) functional index';
  assert (select indexdef ilike '%lower(primary_email)%' from pg_indexes where indexname = 'people_primary_email_lower_idx'),
         'T45 people_primary_email_lower_idx must be a lower(primary_email) functional index';
end $$;
-- schema-grounding guards: NO identity_account_id column is introduced; the match graph is app_user → person.
do $$ begin
  assert not exists (select 1 from information_schema.columns
                     where table_schema = 'public' and table_name = 'app_user_identity_matches' and column_name = 'identity_account_id'),
         'T45 app_user_identity_matches must NOT have an identity_account_id column';
  assert exists (select 1 from information_schema.columns
                 where table_schema = 'public' and table_name = 'app_user_identity_matches' and column_name = 'app_user_id'),
         'T45 app_user_identity_matches must link app_user_id';
  assert exists (select 1 from information_schema.columns
                 where table_schema = 'public' and table_name = 'app_user_identity_matches' and column_name = 'person_id'),
         'T45 app_user_identity_matches must link person_id (app_user → person)';
  assert exists (select 1 from information_schema.columns
                 where table_schema = 'public' and table_name = 'identity_accounts' and column_name = 'person_id'),
         'T45 identity_accounts must link to person via person_id';
  -- the graph tables must NOT have invented an `organization_id` column (the owning-org columns differ per
  -- table: apps use procurement_owner_org_id/paying_org_id/responsible_org_id; contracts use
  -- procurement_org_id/paying_org_id). 0023 indexes those real columns; it never introduces organization_id.
  assert not exists (select 1 from information_schema.columns
                     where table_schema = 'public' and table_name = 'apps' and column_name = 'organization_id'),
         'T45 apps must NOT have an organization_id column (use procurement_owner_org_id/paying_org_id/responsible_org_id)';
  assert not exists (select 1 from information_schema.columns
                     where table_schema = 'public' and table_name = 'contracts' and column_name = 'organization_id'),
         'T45 contracts must NOT have an organization_id column (use procurement_org_id/paying_org_id)';
  assert not exists (select 1 from information_schema.columns
                     where table_schema = 'public' and table_name = 'app_users' and column_name = 'organization_id'),
         'T45 app_users must NOT have an organization_id column';
end $$;

-- ── Test 46: canonical vendor/product/app-instance graph (migration 0024) ────────────────────────────
-- 0024 adds tenant-scoped vendors / app_products / app_aliases + nullable apps.canonical_app_id + instance
-- identity fields. This proves: the new tables are RLS-enabled with the members-read + editors-insert/update
-- (NO DELETE) hardened pattern; tenant isolation holds; the apps columns exist; app_contracts is unchanged;
-- NO identity_account_id is introduced; connector_secrets is untouched.
reset role;
-- 46a: the 3 new tables are RLS-enabled with EXACTLY {SELECT, INSERT, UPDATE} policies — no DELETE, no ALL.
do $$
  declare t text;
begin
  foreach t in array array['vendors','app_products','app_aliases'] loop
    assert (select relrowsecurity from pg_class where relname = t and relnamespace = 'public'::regnamespace),
           format('T46 %s must have RLS enabled', t);
    assert (select coalesce(array_agg(distinct cmd::text order by cmd::text), array[]::text[])
            from pg_policies where schemaname = 'public' and tablename = t) = array['INSERT','SELECT','UPDATE'],
           format('T46 %s must have EXACTLY {SELECT, INSERT, UPDATE} policies (no DELETE/ALL — 0004-hardened)', t);
  end loop;
end $$;
-- 46b: apps gains the nullable canonical link + the 3 instance-identity discriminators; app_contracts is
-- unchanged (same composite PK, no canonical/instance columns).
do $$ begin
  assert exists (select 1 from information_schema.columns where table_schema='public' and table_name='apps' and column_name='canonical_app_id'), 'T46 apps must have canonical_app_id';
  assert exists (select 1 from information_schema.columns where table_schema='public' and table_name='apps' and column_name='instance_domain'), 'T46 apps must have instance_domain';
  assert exists (select 1 from information_schema.columns where table_schema='public' and table_name='apps' and column_name='external_instance_id'), 'T46 apps must have external_instance_id';
  assert exists (select 1 from information_schema.columns where table_schema='public' and table_name='apps' and column_name='instance_url'), 'T46 apps must have instance_url';
  -- app_contracts unchanged: composite PK (app_id, contract_id), no canonical/instance columns added.
  assert (select count(*) from information_schema.table_constraints tc join information_schema.key_column_usage k
            on tc.constraint_name = k.constraint_name
          where tc.table_schema='public' and tc.table_name='app_contracts' and tc.constraint_type='PRIMARY KEY') = 2,
         'T46 app_contracts PK must STILL be the (app_id, contract_id) composite';
  assert not exists (select 1 from information_schema.columns where table_schema='public' and table_name='app_contracts' and column_name in ('canonical_app_id','instance_domain')),
         'T46 app_contracts must be unchanged (no canonical/instance columns)';
  -- NO identity_account_id is introduced anywhere by 0024.
  assert not exists (select 1 from information_schema.columns where table_schema='public'
                     and table_name in ('vendors','app_products','app_aliases','apps') and column_name='identity_account_id'),
         'T46 0024 must NOT introduce an identity_account_id column';
  -- the audit/review fields reuse the app_user_identity_matches pattern on app_aliases.
  assert exists (select 1 from information_schema.columns where table_schema='public' and table_name='app_aliases' and column_name='confidence'), 'T46 app_aliases must have confidence';
  assert exists (select 1 from information_schema.columns where table_schema='public' and table_name='app_aliases' and column_name='reviewed_by'), 'T46 app_aliases must have reviewed_by';
  assert exists (select 1 from information_schema.columns where table_schema='public' and table_name='app_aliases' and column_name='review_status'), 'T46 app_aliases must have review_status';
end $$;
-- 46c: connector_secrets is untouched by 0024 (still zero policies — deny-all preserved).
do $$ begin
  assert (select count(*) from pg_policies where schemaname='public' and tablename='connector_secrets') = 0,
         'T46 connector_secrets must STILL have zero policies after 0024';
end $$;
-- 46d: FUNCTIONAL tenant isolation — seed a Tenant A vendor (superuser), then prove RLS scopes reads/writes.
insert into public.vendors (id, tenant_id, name, normalized_name, source)
  values ('da240000-0000-0000-0000-0000000000a1','11111111-1111-1111-1111-111111111111','Atlassian','atlassian','manual');
insert into public.app_products (id, tenant_id, vendor_id, name, normalized_name)
  values ('da240000-0000-0000-0000-0000000000b1','11111111-1111-1111-1111-111111111111','da240000-0000-0000-0000-0000000000a1','Jira','jira');
-- a Tenant A member (owner_a) can read the Tenant A vendor/product.
select set_config('request.jwt.claims','{"sub":"0a000000-0000-0000-0000-000000000001"}',false); set role authenticated;
do $$ begin
  assert (select count(*) from public.vendors where id='da240000-0000-0000-0000-0000000000a1') = 1, 'T46 Tenant A member reads Tenant A vendor';
  assert (select count(*) from public.app_products where id='da240000-0000-0000-0000-0000000000b1') = 1, 'T46 Tenant A member reads Tenant A product';
end $$;
-- an editor/owner of Tenant A can INSERT a canonical row; a cross-tenant write is denied.
do $$ declare ok boolean := false; begin
  insert into public.vendors (tenant_id, name, normalized_name) values ('11111111-1111-1111-1111-111111111111','Zoom','zoom');
  ok := true;
  exception when others then ok := false;
  assert ok, 'T46 Tenant A editor can INSERT a Tenant A vendor';
end $$;
do $$ declare ok boolean := false; begin
  begin insert into public.vendors (tenant_id, name, normalized_name) values ('22222222-2222-2222-2222-222222222222','Sneaky','sneaky'); ok := false;
  exception when others then ok := true; end;
  assert ok, 'T46 Tenant A member must NOT INSERT a Tenant B vendor (RLS with check)';
end $$;
reset role;
-- a Tenant B member (owner_b) cannot read the Tenant A vendor/product (tenant isolation).
select set_config('request.jwt.claims','{"sub":"0b000000-0000-0000-0000-000000000001"}',false); set role authenticated;
do $$ begin
  assert (select count(*) from public.vendors where id='da240000-0000-0000-0000-0000000000a1') = 0, 'T46 Tenant B member must NOT read Tenant A vendor';
  assert (select count(*) from public.app_products where id='da240000-0000-0000-0000-0000000000b1') = 0, 'T46 Tenant B member must NOT read Tenant A product';
end $$;
reset role;
-- 46e: the same-tenant composite FK actually REJECTS a cross-tenant link (functional, mirrors T26/T38), and
-- app_aliases isolation holds functionally. Seed a Tenant B vendor, then point a Tenant A product at it.
insert into public.vendors (id, tenant_id, name, normalized_name)
  values ('da240000-0000-0000-0000-0000000000b9','22222222-2222-2222-2222-222222222222','Atlassian','atlassian');
do $$ declare blocked boolean := false; begin
  begin
    insert into public.app_products (tenant_id, vendor_id, name, normalized_name)
      values ('11111111-1111-1111-1111-111111111111','da240000-0000-0000-0000-0000000000b9','Jira','jira'); -- Tenant A product → Tenant B vendor
  exception when foreign_key_violation then blocked := true; end;
  assert blocked, 'T46 cross-tenant app_products.vendor_id must be rejected by the same-tenant composite FK';
end $$;
-- app_aliases functional isolation: seed a Tenant A alias, then prove RLS scopes the read.
insert into public.app_aliases (id, tenant_id, app_product_id, alias_type, alias_value)
  values ('da240000-0000-0000-0000-0000000000c1','11111111-1111-1111-1111-111111111111','da240000-0000-0000-0000-0000000000b1','instance_domain','flywheel.atlassian.net');
select set_config('request.jwt.claims','{"sub":"0a000000-0000-0000-0000-000000000001"}',false); set role authenticated;
do $$ begin assert (select count(*) from public.app_aliases where id='da240000-0000-0000-0000-0000000000c1') = 1, 'T46 Tenant A member reads Tenant A app_alias'; end $$;
reset role;
select set_config('request.jwt.claims','{"sub":"0b000000-0000-0000-0000-000000000001"}',false); set role authenticated;
do $$ begin assert (select count(*) from public.app_aliases where id='da240000-0000-0000-0000-0000000000c1') = 0, 'T46 Tenant B member must NOT read Tenant A app_alias'; end $$;
reset role;

-- ── Test 47: discovery_facts ingestion staging boundary (migration 0025) ─────────────────────────────
-- 0025 adds the tenant-scoped, RLS-protected staging table for validated discovery facts. This proves: the
-- table is RLS-enabled with the members-read + editors-insert/update (NO DELETE — durable review records)
-- pattern; tenant isolation holds for read/insert/update; the structural shape (review_status default + check,
-- the staging columns); connector_secrets is untouched and NO connector_runner privilege was added.
reset role;
-- 47a: structural — RLS enabled, EXACTLY {SELECT, INSERT, UPDATE} policies (no DELETE/ALL), columns + default.
do $$ declare v_col text; begin
  assert (select relrowsecurity from pg_class where relname = 'discovery_facts' and relnamespace = 'public'::regnamespace),
         'T47 discovery_facts must have RLS enabled';
  assert (select coalesce(array_agg(distinct cmd::text order by cmd::text), array[]::text[])
          from pg_policies where schemaname = 'public' and tablename = 'discovery_facts') = array['INSERT','SELECT','UPDATE'],
         'T47 discovery_facts must have EXACTLY {SELECT, INSERT, UPDATE} policies (no DELETE/ALL — durable records)';
  foreach v_col in array array['tenant_id','schema_version','fact_type','source_type','source_provider','observed_at','review_status','fact_json','provenance_json','natural_key','source_run_id','reviewed_by','reviewed_at','rejected_reason']
  loop
    assert exists (select 1 from information_schema.columns where table_schema='public' and table_name='discovery_facts' and column_name = v_col),
           format('T47 discovery_facts must have column %s', v_col);
  end loop;
  assert (select column_default from information_schema.columns where table_schema='public' and table_name='discovery_facts' and column_name='review_status') like '%pending%',
         'T47 discovery_facts.review_status must default to pending';
  -- fact_json is NOT NULL (a staged fact always carries its validated payload).
  assert (select is_nullable from information_schema.columns where table_schema='public' and table_name='discovery_facts' and column_name='fact_json') = 'NO',
         'T47 discovery_facts.fact_json must be NOT NULL';
end $$;
-- 47b: connector_secrets untouched + NO connector_runner privilege was granted on discovery_facts by 0025.
do $$ begin
  assert (select count(*) from pg_policies where schemaname='public' and tablename='connector_secrets') = 0,
         'T47 connector_secrets must STILL have zero policies after 0025';
  assert not exists (
    select 1 from information_schema.role_table_grants
    where table_schema='public' and table_name='discovery_facts' and grantee='connector_runner'),
         'T47 connector_runner must have NO grant on discovery_facts';
end $$;
-- 47c: FUNCTIONAL tenant isolation — seed a Tenant A fact (superuser), then prove RLS scopes read/insert/update.
insert into public.discovery_facts (id, tenant_id, schema_version, fact_type, source_type, source_provider, observed_at, fact_json)
  values ('df250000-0000-0000-0000-0000000000a1','11111111-1111-1111-1111-111111111111','1','app_discovery','identity_provider_discovery','okta', now(), '{"fact_type":"app_discovery"}'::jsonb);
-- a Tenant A member reads its fact; a Tenant B member reads zero (tenant A cannot read tenant B, and vice versa).
select set_config('request.jwt.claims','{"sub":"0a000000-0000-0000-0000-000000000001"}',false); set role authenticated;
do $$ begin assert (select count(*) from public.discovery_facts where id='df250000-0000-0000-0000-0000000000a1') = 1, 'T47 Tenant A member reads Tenant A fact'; end $$;
-- a Tenant A editor cannot INSERT a Tenant B fact (cross-tenant insert denied by RLS with check).
do $$ declare blocked boolean := false; begin
  begin
    insert into public.discovery_facts (tenant_id, schema_version, fact_type, source_type, source_provider, observed_at, fact_json)
      values ('22222222-2222-2222-2222-222222222222','1','app_discovery','identity_provider_discovery','okta', now(), '{}'::jsonb);
    blocked := false;
  exception when others then blocked := true; end;
  assert blocked, 'T47 Tenant A member must NOT INSERT a Tenant B discovery_fact (RLS with check)';
end $$;
reset role;
-- a Tenant B member cannot read the Tenant A fact, and cannot UPDATE it (cross-tenant update affects 0 rows).
select set_config('request.jwt.claims','{"sub":"0b000000-0000-0000-0000-000000000001"}',false); set role authenticated;
do $$ begin
  assert (select count(*) from public.discovery_facts where id='df250000-0000-0000-0000-0000000000a1') = 0, 'T47 Tenant B member must NOT read Tenant A fact';
  update public.discovery_facts set review_status='confirmed' where id='df250000-0000-0000-0000-0000000000a1';
  assert not found, 'T47 Tenant B member must NOT UPDATE a Tenant A fact (RLS scopes the update to zero rows)';
end $$;
reset role;
-- the Tenant A fact is still pending (the cross-tenant update touched nothing).
do $$ begin assert (select review_status from public.discovery_facts where id='df250000-0000-0000-0000-0000000000a1') = 'pending',
       'T47 the Tenant A fact must be untouched by the cross-tenant update'; end $$;

-- ── Test 48: deterministic resolver write — persisted-state idempotency (migration 0026) ─────────────
-- The first canonical-graph mutation path upserts app_aliases / canonical_app_id on NATURAL KEYS. This proves
-- at the PERSISTED-STATE layer (real Postgres): the alias natural-key UNIQUE exists (0026); re-running the
-- exact same deterministic write does NOT increase app_alias / app_products / vendors row counts (ON CONFLICT
-- DO NOTHING); distinct instance_domain values stay separate aliases under ONE product (Flywheel ≠ Perpetua);
-- and unmerge/repoint is NON-destructive (clearing canonical_app_id / repointing an alias never deletes the
-- apps row or its app_users / contracts / invoices). Fixtures are T48-namespaced to stay isolated from T46.
reset role;
-- 48a: the alias natural-key UNIQUE(tenant_id, alias_type, alias_value) exists (0026).
do $$ begin
  assert exists (select 1 from pg_constraint where conname = 'app_aliases_tenant_type_value_key'),
         'T48 app_aliases natural-key UNIQUE(tenant_id, alias_type, alias_value) must exist (0026)';
end $$;
-- seed a Tenant A canonical graph + two instances + historical evidence (app_user / contract / invoice).
insert into public.vendors (id, tenant_id, name, normalized_name)
  values ('48000000-0000-0000-0000-0000000a0001','11111111-1111-1111-1111-111111111111','Atlassian (T48)','atlassian48');
insert into public.app_products (id, tenant_id, vendor_id, name, normalized_name)
  values ('48000000-0000-0000-0000-0000000b0001','11111111-1111-1111-1111-111111111111','48000000-0000-0000-0000-0000000a0001','Jira','jira48'),
         ('48000000-0000-0000-0000-0000000b0002','11111111-1111-1111-1111-111111111111','48000000-0000-0000-0000-0000000a0001','Jira (alt)','jira48-alt');
insert into public.apps (id, tenant_id, name, instance_domain)
  values ('48000000-0000-0000-0000-0000000c0001','11111111-1111-1111-1111-111111111111','Jira Flywheel','flywheel48.atlassian.net'),
         ('48000000-0000-0000-0000-0000000c0002','11111111-1111-1111-1111-111111111111','Jira Perpetua','perpetua48.atlassian.net');
insert into public.app_users (id, tenant_id, app_id, email)
  values ('48000000-0000-0000-0000-0000000d0001','11111111-1111-1111-1111-111111111111','48000000-0000-0000-0000-0000000c0001','u@flywheel48.test');
insert into public.contracts (id, tenant_id, contract_name)
  values ('48000000-0000-0000-0000-0000000e0001','11111111-1111-1111-1111-111111111111','Atlassian Master Agreement (T48)');
insert into public.app_contracts (app_id, contract_id, tenant_id)
  values ('48000000-0000-0000-0000-0000000c0001','48000000-0000-0000-0000-0000000e0001','11111111-1111-1111-1111-111111111111');
insert into public.invoices (id, tenant_id, app_id, vendor_name, amount)
  values ('48000000-0000-0000-0000-0000000f0001','11111111-1111-1111-1111-111111111111','48000000-0000-0000-0000-0000000c0001','Atlassian',1000.00);

-- the deterministic write, expressed as natural-key upserts (what the RLS-scoped helper does), re-runnable.
create or replace function pg_temp.t48_write() returns void language plpgsql as $f$
begin
  insert into public.vendors (tenant_id, name, normalized_name)
    values ('11111111-1111-1111-1111-111111111111','Atlassian (T48)','atlassian48')
    on conflict (tenant_id, normalized_name) do nothing;
  insert into public.app_products (tenant_id, vendor_id, name, normalized_name)
    values ('11111111-1111-1111-1111-111111111111','48000000-0000-0000-0000-0000000a0001','Jira','jira48')
    on conflict (tenant_id, vendor_id, normalized_name) do nothing;
  insert into public.app_aliases (tenant_id, app_product_id, alias_type, alias_value) values
    ('11111111-1111-1111-1111-111111111111','48000000-0000-0000-0000-0000000b0001','instance_domain','flywheel48.atlassian.net'),
    ('11111111-1111-1111-1111-111111111111','48000000-0000-0000-0000-0000000b0001','instance_domain','perpetua48.atlassian.net')
    on conflict (tenant_id, alias_type, alias_value) do nothing;
  update public.apps set canonical_app_id = '48000000-0000-0000-0000-0000000b0001'
    where id in ('48000000-0000-0000-0000-0000000c0001','48000000-0000-0000-0000-0000000c0002');
end $f$;

-- 48b: idempotency — run the deterministic write TWICE; T48's persisted counts must be unchanged.
do $$ declare a1 int; p1 int; v1 int; begin
  perform pg_temp.t48_write();
  select count(*) into a1 from public.app_aliases where alias_value in ('flywheel48.atlassian.net','perpetua48.atlassian.net');
  select count(*) into p1 from public.app_products where vendor_id = '48000000-0000-0000-0000-0000000a0001';
  select count(*) into v1 from public.vendors where normalized_name = 'atlassian48';
  perform pg_temp.t48_write(); -- re-run the EXACT same write
  assert (select count(*) from public.app_aliases where alias_value in ('flywheel48.atlassian.net','perpetua48.atlassian.net')) = a1,
         'T48 re-running the same staged fact set must NOT increase the app_alias row count';
  assert (select count(*) from public.app_products where vendor_id = '48000000-0000-0000-0000-0000000a0001') = p1,
         'T48 re-run must NOT create duplicate app_product rows';
  assert (select count(*) from public.vendors where normalized_name = 'atlassian48') = v1,
         'T48 re-run must NOT create duplicate vendor rows';
  assert a1 = 2, 'T48 the two distinct instance_domain values (Flywheel + Perpetua) are two aliases, not collapsed';
  assert v1 = 1, 'T48 exactly one Atlassian vendor (idempotent)';
end $$;
-- 48c: multi-instance — distinct apps rows group under the SAME product but stay separate.
do $$ begin
  assert (select canonical_app_id from public.apps where id = '48000000-0000-0000-0000-0000000c0001') = '48000000-0000-0000-0000-0000000b0001',
         'T48 Jira Flywheel groups under the Jira product';
  assert (select canonical_app_id from public.apps where id = '48000000-0000-0000-0000-0000000c0002') = '48000000-0000-0000-0000-0000000b0001',
         'T48 Jira Perpetua groups under the Jira product';
  assert (select count(*) from public.apps where id in ('48000000-0000-0000-0000-0000000c0001','48000000-0000-0000-0000-0000000c0002')) = 2,
         'T48 Jira Flywheel and Jira Perpetua remain SEPARATE apps rows';
end $$;
-- 48d: unmerge — clearing canonical_app_id is NON-destructive (apps + app_users/contracts/invoices survive).
update public.apps set canonical_app_id = null where id = '48000000-0000-0000-0000-0000000c0001';
do $$ begin
  assert (select canonical_app_id from public.apps where id = '48000000-0000-0000-0000-0000000c0001') is null,
         'T48 revert clears canonical_app_id';
  assert exists (select 1 from public.apps where id = '48000000-0000-0000-0000-0000000c0001'), 'T48 revert must NOT delete the apps row';
  assert exists (select 1 from public.app_users where id = '48000000-0000-0000-0000-0000000d0001'), 'T48 revert must NOT delete app_users';
  assert exists (select 1 from public.contracts where id = '48000000-0000-0000-0000-0000000e0001'), 'T48 revert must NOT delete contracts';
  assert exists (select 1 from public.invoices where id = '48000000-0000-0000-0000-0000000f0001'), 'T48 revert must NOT delete invoices';
end $$;
-- 48e: repoint — changing an alias's product is an UPDATE (no count change) and non-destructive.
do $$ declare a_before int; begin
  select count(*) into a_before from public.app_aliases where alias_value in ('flywheel48.atlassian.net','perpetua48.atlassian.net');
  update public.app_aliases set app_product_id = '48000000-0000-0000-0000-0000000b0002'
    where tenant_id = '11111111-1111-1111-1111-111111111111' and alias_type = 'instance_domain' and alias_value = 'flywheel48.atlassian.net';
  assert (select count(*) from public.app_aliases where alias_value in ('flywheel48.atlassian.net','perpetua48.atlassian.net')) = a_before,
         'T48 repoint is an UPDATE — it must NOT change the alias row count';
  assert (select app_product_id from public.app_aliases where tenant_id='11111111-1111-1111-1111-111111111111' and alias_type='instance_domain' and alias_value='flywheel48.atlassian.net') = '48000000-0000-0000-0000-0000000b0002',
         'T48 repoint changes the alias target product';
  assert exists (select 1 from public.app_users where id = '48000000-0000-0000-0000-0000000d0001'), 'T48 repoint must NOT delete app_users';
end $$;
-- 48g: conflict — an alias natural key that already resolves to a DIFFERENT product is NOT overwritten at the
-- persisted layer (ON CONFLICT DO NOTHING preserves the original target → the resolver routes to review). This
-- is the load-bearing FALSE-MERGE guard proven on real Postgres.
insert into public.app_aliases (tenant_id, app_product_id, alias_type, alias_value)
  values ('11111111-1111-1111-1111-111111111111','48000000-0000-0000-0000-0000000b0002','instance_domain','conflict48.atlassian.net');
do $$ declare a_before int; begin
  select count(*) into a_before from public.app_aliases where alias_value = 'conflict48.atlassian.net';
  -- a second deterministic write tries to map the SAME key to a DIFFERENT product (0b0001) — must NOT overwrite
  insert into public.app_aliases (tenant_id, app_product_id, alias_type, alias_value)
    values ('11111111-1111-1111-1111-111111111111','48000000-0000-0000-0000-0000000b0001','instance_domain','conflict48.atlassian.net')
    on conflict (tenant_id, alias_type, alias_value) do nothing;
  assert (select count(*) from public.app_aliases where alias_value = 'conflict48.atlassian.net') = a_before,
         'T48 a conflicting alias key must NOT create a second row (ON CONFLICT DO NOTHING)';
  assert (select app_product_id from public.app_aliases where tenant_id='11111111-1111-1111-1111-111111111111' and alias_type='instance_domain' and alias_value='conflict48.atlassian.net') = '48000000-0000-0000-0000-0000000b0002',
         'T48 a conflicting alias key must KEEP its original product (no false-merge overwrite)';
end $$;
-- 48f: tenant isolation — a Tenant B member cannot read Tenant A's resolver-written aliases.
select set_config('request.jwt.claims','{"sub":"0b000000-0000-0000-0000-000000000001"}',false); set role authenticated;
do $$ begin
  assert (select count(*) from public.app_aliases where alias_value in ('flywheel48.atlassian.net','perpetua48.atlassian.net')) = 0,
         'T48 Tenant B member must NOT read Tenant A resolver-written aliases';
end $$;
reset role;

-- ── Test 49: deterministic app_user → person identity-match write (migration 0027) ──────────────────
-- 0027 adds the write surface (editors INSERT + editors UPDATE, NO DELETE) so the deterministic identity-match
-- helper can write `app_user_identity_matches` through the authenticated RLS path. This proves at the
-- persisted-state (real-Postgres) layer: the policy set is EXACTLY {SELECT, INSERT, UPDATE} (no DELETE/ALL —
-- the 0004 directive); re-inserting the SAME (app_user_id, person_id) match does NOT increase the row count
-- (the 0001 UNIQUE); repoint is an UPDATE that changes person_id WITHOUT deleting the app_user/person/match;
-- and a Tenant B member cannot read or insert a Tenant A match. Fixtures are T49-namespaced.
reset role;
-- 49a: exactly {SELECT, INSERT, UPDATE} policies on app_user_identity_matches — NO DELETE, NO ALL (0027 + 0004)
-- AND the tenant-scoped app_user uniqueness constraint UNIQUE(tenant_id, app_user_id) exists (0028).
do $$ begin
  assert (select coalesce(array_agg(distinct cmd::text order by cmd::text), array[]::text[])
          from pg_policies where schemaname='public' and tablename='app_user_identity_matches') = array['INSERT','SELECT','UPDATE'],
         'T49 app_user_identity_matches must have EXACTLY {SELECT, INSERT, UPDATE} policies (no DELETE/ALL — 0004 directive)';
  assert exists (select 1 from pg_constraint where conname = 'app_user_identity_matches_tenant_app_user_key'),
         'T49 app_user_identity_matches must have UNIQUE(tenant_id, app_user_id) (0028 — the false-double-match guard)';
end $$;
-- seed a Tenant A app instance + two people + an app_user (historical evidence that repoint must preserve).
insert into public.apps (id, tenant_id, name)
  values ('49000000-0000-0000-0000-0000000a0001','11111111-1111-1111-1111-111111111111','Acme SSO (T49)');
insert into public.people (id, tenant_id, primary_email)
  values ('49000000-0000-0000-0000-0000000b0001','11111111-1111-1111-1111-111111111111','jane49@acme.test'),
         ('49000000-0000-0000-0000-0000000b0002','11111111-1111-1111-1111-111111111111','jane49.correct@acme.test');
insert into public.app_users (id, tenant_id, app_id, email)
  values ('49000000-0000-0000-0000-0000000c0001','11111111-1111-1111-1111-111111111111','49000000-0000-0000-0000-0000000a0001','jane49@acme.test');

-- 49b: idempotency — insert the SAME deterministic match twice on the (tenant_id, app_user_id) natural key.
do $$ declare n1 int; begin
  insert into public.app_user_identity_matches (tenant_id, app_user_id, person_id, match_method)
    values ('11111111-1111-1111-1111-111111111111','49000000-0000-0000-0000-0000000c0001','49000000-0000-0000-0000-0000000b0001','auto_exact_email')
    on conflict (tenant_id, app_user_id) do nothing;
  select count(*) into n1 from public.app_user_identity_matches where app_user_id = '49000000-0000-0000-0000-0000000c0001';
  insert into public.app_user_identity_matches (tenant_id, app_user_id, person_id, match_method)
    values ('11111111-1111-1111-1111-111111111111','49000000-0000-0000-0000-0000000c0001','49000000-0000-0000-0000-0000000b0001','auto_exact_email')
    on conflict (tenant_id, app_user_id) do nothing; -- re-run the EXACT same match
  assert (select count(*) from public.app_user_identity_matches where app_user_id = '49000000-0000-0000-0000-0000000c0001') = n1,
         'T49 re-running the same deterministic match must NOT increase app_user_identity_matches row count';
  assert n1 = 1, 'T49 exactly one match row for the app_user (deterministic 1:1)';
end $$;
-- 49b2: a SECOND match for the same (tenant, app_user) to a DIFFERENT person is BLOCKED at the DB layer (the
-- false-double-match guard — UNIQUE(tenant_id, app_user_id), 0028). This is the invariant the editor INSERT
-- policy (0027) MUST NOT be able to violate. The existing match (→ b0001) is kept; no second row is created.
do $$ declare blocked boolean := false; begin
  begin
    insert into public.app_user_identity_matches (tenant_id, app_user_id, person_id, match_method)
      values ('11111111-1111-1111-1111-111111111111','49000000-0000-0000-0000-0000000c0001','49000000-0000-0000-0000-0000000b0002','auto_exact_email');
    blocked := false;
  exception when unique_violation then blocked := true; end;
  assert blocked, 'T49 a second match for the same (tenant, app_user) to a DIFFERENT person must be REJECTED (unique_violation)';
  assert (select count(*) from public.app_user_identity_matches where app_user_id = '49000000-0000-0000-0000-0000000c0001') = 1,
         'T49 the blocked second match must NOT create a row — still exactly one match for the app_user';
  assert (select person_id from public.app_user_identity_matches where app_user_id = '49000000-0000-0000-0000-0000000c0001') = '49000000-0000-0000-0000-0000000b0001',
         'T49 the original deterministic match (→ b0001) is preserved — no false double-match';
end $$;
-- 49c: repoint — UPDATE person_id to the correct person; row count unchanged; app_users/people/app NOT deleted.
do $$ declare c_before int; begin
  select count(*) into c_before from public.app_user_identity_matches where app_user_id = '49000000-0000-0000-0000-0000000c0001';
  update public.app_user_identity_matches set person_id = '49000000-0000-0000-0000-0000000b0002'
    where app_user_id = '49000000-0000-0000-0000-0000000c0001' and person_id = '49000000-0000-0000-0000-0000000b0001';
  assert (select count(*) from public.app_user_identity_matches where app_user_id = '49000000-0000-0000-0000-0000000c0001') = c_before,
         'T49 repoint is an UPDATE — it must NOT change the match row count';
  assert (select person_id from public.app_user_identity_matches where app_user_id = '49000000-0000-0000-0000-0000000c0001') = '49000000-0000-0000-0000-0000000b0002',
         'T49 repoint changes person_id to the correct person';
  assert exists (select 1 from public.app_users where id = '49000000-0000-0000-0000-0000000c0001'), 'T49 repoint must NOT delete the app_user';
  assert exists (select 1 from public.people where id = '49000000-0000-0000-0000-0000000b0001'), 'T49 repoint must NOT delete the (old) person';
  assert exists (select 1 from public.apps where id = '49000000-0000-0000-0000-0000000a0001'), 'T49 repoint must NOT delete the app';
end $$;
-- 49d: tenant isolation — a Tenant B member cannot read Tenant A's match, and cannot INSERT one for Tenant A.
select set_config('request.jwt.claims','{"sub":"0b000000-0000-0000-0000-000000000001"}',false); set role authenticated;
do $$ begin
  assert (select count(*) from public.app_user_identity_matches where app_user_id = '49000000-0000-0000-0000-0000000c0001') = 0,
         'T49 Tenant B member must NOT read a Tenant A identity match';
end $$;
do $$ declare blocked boolean := false; begin
  begin
    insert into public.app_user_identity_matches (tenant_id, app_user_id, person_id, match_method)
      values ('11111111-1111-1111-1111-111111111111','49000000-0000-0000-0000-0000000c0001','49000000-0000-0000-0000-0000000b0001','auto_exact_email');
    blocked := false;
  exception when others then blocked := true; end;
  assert blocked, 'T49 Tenant B member must NOT INSERT a Tenant A identity match (RLS with check)';
end $$;
reset role;

-- ── Test 50: connector_runner connector_secrets COLUMN-SCOPED storage grant (migration 0029) ─────────
-- 0029 grants the runner ONLY the exact COLUMN-scoped SELECT/INSERT the vault save/load boundary needs — NOT
-- table-level (the runner is BYPASSRLS, so a table grant would expose every column of every row + any future
-- column). This proves at the catalog + functional layer: there is NO table-level SELECT/INSERT; the column
-- grants are EXACTLY the documented identity/envelope sets; no UPDATE/DELETE/TRUNCATE/REFERENCES/TRIGGER; the
-- request-path deny-all is PRESERVED (authenticated/anon EXACTLY zero table+column privilege; RLS on, ZERO
-- policies — no DELETE policy, no ALL policy); and FUNCTIONALLY the runner can insert/select ONLY granted
-- columns and cannot update/delete or read a non-granted column.
reset role;
-- 50a: NO table-level grant; the COLUMN-scoped SELECT/INSERT sets are EXACTLY the documented columns.
do $$ begin
  -- no table-level SELECT/INSERT (column-only) — role_table_grants is empty; has_table_privilege is false.
  assert (select coalesce(array_agg(distinct privilege_type::text order by privilege_type::text), array[]::text[])
          from information_schema.role_table_grants
          where grantee='connector_runner' and table_schema='public' and table_name='connector_secrets') = array[]::text[],
         'T50 connector_runner must have NO table-level privilege on connector_secrets (column-scoped only)';
  assert not has_table_privilege('connector_runner','public.connector_secrets','SELECT'),    'T50 runner has NO table-level SELECT (column-scoped only)';
  assert not has_table_privilege('connector_runner','public.connector_secrets','INSERT'),    'T50 runner has NO table-level INSERT (column-scoped only)';
  assert not has_table_privilege('connector_runner','public.connector_secrets','UPDATE'),    'T50 runner must NOT UPDATE connector_secrets (revocation/rotation deferred)';
  assert not has_table_privilege('connector_runner','public.connector_secrets','DELETE'),    'T50 runner must NOT DELETE connector_secrets (no row delete)';
  assert not has_table_privilege('connector_runner','public.connector_secrets','TRUNCATE'),  'T50 runner must NOT TRUNCATE connector_secrets';
  assert not has_table_privilege('connector_runner','public.connector_secrets','REFERENCES'),'T50 runner must NOT REFERENCES connector_secrets';
  assert not has_table_privilege('connector_runner','public.connector_secrets','TRIGGER'),   'T50 runner must NOT TRIGGER connector_secrets';
  -- EXACT column-level SELECT set (identity/query + active/expiry filter + the COMPLETE encrypted envelope
  -- columns, incl. the 0030 aead_tag/envelope_version/aead_alg).
  assert (select coalesce(array_agg(distinct column_name::text order by column_name::text), array[]::text[])
          from information_schema.role_column_grants
          where grantee='connector_runner' and table_schema='public' and table_name='connector_secrets' and privilege_type='SELECT')
         = array['aad_digest','aead_alg','aead_nonce','aead_tag','ciphertext','connector_id','dek_wrapped','envelope_version','expires_at','id','key_id','secret_kind','status','tenant_id','version'],
         'T50 runner SELECT columns must be EXACTLY the identity/active/complete-envelope set (incl. 0030 columns)';
  -- EXACT column-level INSERT set (identity/write + the COMPLETE encrypted envelope columns; id/is_active/status default).
  assert (select coalesce(array_agg(distinct column_name::text order by column_name::text), array[]::text[])
          from information_schema.role_column_grants
          where grantee='connector_runner' and table_schema='public' and table_name='connector_secrets' and privilege_type='INSERT')
         = array['aad_digest','aead_alg','aead_nonce','aead_tag','ciphertext','connector_id','dek_wrapped','envelope_version','key_id','secret_kind','tenant_id','version'],
         'T50 runner INSERT columns must be EXACTLY the identity/complete-envelope write set (incl. 0030 columns)';
  -- NO column-level privilege beyond SELECT/INSERT (no UPDATE/DELETE/REFERENCES columns).
  assert (select count(*) from information_schema.role_column_grants
          where grantee='connector_runner' and table_schema='public' and table_name='connector_secrets'
            and privilege_type not in ('SELECT','INSERT')) = 0,
         'T50 runner must have NO column privilege beyond SELECT/INSERT on connector_secrets';
  -- representative column checks: granted envelope columns (incl. the 0030 tag) yes; a non-granted column no.
  assert     has_column_privilege('connector_runner','public.connector_secrets','ciphertext','SELECT'), 'T50 runner can SELECT ciphertext';
  assert     has_column_privilege('connector_runner','public.connector_secrets','ciphertext','INSERT'), 'T50 runner can INSERT ciphertext';
  assert     has_column_privilege('connector_runner','public.connector_secrets','aead_tag','SELECT'),   'T50 runner can SELECT aead_tag (0030 — needed to decrypt)';
  assert     has_column_privilege('connector_runner','public.connector_secrets','aead_tag','INSERT'),   'T50 runner can INSERT aead_tag (0030)';
  assert     has_column_privilege('connector_runner','public.connector_secrets','envelope_version','INSERT'), 'T50 runner can INSERT envelope_version (0030)';
  assert not has_column_privilege('connector_runner','public.connector_secrets','created_at','SELECT'), 'T50 runner must NOT SELECT created_at (non-granted column)';
  assert not has_column_privilege('connector_runner','public.connector_secrets','id','INSERT'),         'T50 runner must NOT INSERT id (server default only)';
  assert not has_column_privilege('connector_runner','public.connector_secrets','ciphertext','UPDATE'), 'T50 runner must NOT UPDATE ciphertext';
end $$;
-- 50b: request-path DENY-ALL preserved — authenticated/anon EXACTLY zero TABLE + COLUMN privilege; RLS on; ZERO policies.
do $$ begin
  assert (select coalesce(array_agg(distinct privilege_type::text), array[]::text[]) from information_schema.role_table_grants
          where grantee='authenticated' and table_schema='public' and table_name='connector_secrets') = array[]::text[],
         'T50 authenticated must STILL hold zero table privilege on connector_secrets after 0029';
  assert (select count(*) from information_schema.role_column_grants
          where grantee='authenticated' and table_schema='public' and table_name='connector_secrets') = 0,
         'T50 authenticated must hold zero COLUMN privilege on connector_secrets (the 0029 grant is runner-only)';
  assert (select coalesce(array_agg(distinct privilege_type::text), array[]::text[]) from information_schema.role_table_grants
          where grantee='anon' and table_schema='public' and table_name='connector_secrets') = array[]::text[],
         'T50 anon must STILL hold zero table privilege on connector_secrets after 0029';
  assert (select count(*) from information_schema.role_column_grants
          where grantee='anon' and table_schema='public' and table_name='connector_secrets') = 0,
         'T50 anon must hold zero COLUMN privilege on connector_secrets';
  assert (select relrowsecurity from pg_class where oid='public.connector_secrets'::regclass),
         'T50 connector_secrets must STILL have RLS enabled';
  assert (select count(*) from pg_policies where schemaname='public' and tablename='connector_secrets') = 0,
         'T50 connector_secrets must STILL have ZERO RLS policies (no DELETE policy, no ALL policy)';
end $$;
-- 50c: FUNCTIONAL as the runner — INSERT the granted columns (NOT id) + SELECT them back; a non-granted column
-- read, and any UPDATE/DELETE, fail closed.
set role connector_runner;
-- the runner writes the COMPLETE envelope (incl. the 0030 aead_tag[16 bytes]/envelope_version/aead_alg columns).
insert into public.connector_secrets (tenant_id, connector_id, secret_kind, version, ciphertext, dek_wrapped, aead_nonce, aad_digest, key_id, aead_tag, envelope_version, aead_alg)
  values ('11111111-1111-1111-1111-111111111111','17000000-0000-0000-0000-0000000000a1','api_key', 50, '\xdead'::bytea, '\xbeef'::bytea, '\x000102'::bytea, 'digest50', 'kek-50', '\x000102030405060708090a0b0c0d0e0f'::bytea, 1, 'AES-256-GCM');
do $$ begin
  assert (select count(*) from public.connector_secrets
          where tenant_id='11111111-1111-1111-1111-111111111111' and connector_id='17000000-0000-0000-0000-0000000000a1' and secret_kind='api_key' and version=50) = 1,
         'T50 runner can INSERT + SELECT the granted connector_secrets columns';
end $$;
do $$ declare ok boolean := false; begin
  begin perform created_at from public.connector_secrets where version=50; ok := false;
  exception when insufficient_privilege then ok := true; end;
  assert ok, 'T50 runner must NOT read a non-granted column (created_at)';
end $$;
do $$ declare ok boolean := false; begin
  begin update public.connector_secrets set status='revoked' where version=50; ok := false;
  exception when insufficient_privilege then ok := true; end;
  assert ok, 'T50 runner must NOT UPDATE connector_secrets (revocation/rotation deferred)';
end $$;
do $$ declare ok boolean := false; begin
  begin delete from public.connector_secrets where version=50; ok := false;
  exception when insufficient_privilege then ok := true; end;
  assert ok, 'T50 runner must NOT DELETE connector_secrets (no row delete)';
end $$;
reset role;
-- 50d: request-path role STILL fully denied (the deny-all is not weakened by the runner column grant).
select set_config('request.jwt.claims','{"sub":"0a000000-0000-0000-0000-000000000001"}',false); set role authenticated;
do $$ declare ok boolean; begin
  ok := false; begin perform 1 from public.connector_secrets; exception when insufficient_privilege then ok := true; end;
  assert ok, 'T50 authenticated must STILL NOT read connector_secrets';
  ok := false; begin insert into public.connector_secrets (tenant_id, connector_id, secret_kind) values ('11111111-1111-1111-1111-111111111111','17000000-0000-0000-0000-0000000000a1','api_key'); exception when insufficient_privilege then ok := true; end;
  assert ok, 'T50 authenticated must STILL NOT insert connector_secrets';
  ok := false; begin update public.connector_secrets set status='revoked'; exception when insufficient_privilege then ok := true; end;
  assert ok, 'T50 authenticated must STILL NOT update connector_secrets';
  ok := false; begin delete from public.connector_secrets; exception when insufficient_privilege then ok := true; end;
  assert ok, 'T50 authenticated must STILL NOT delete connector_secrets';
end $$;
reset role;

do $$ begin raise notice 'ALL ORG-RLS ASSERTIONS PASSED'; end $$;
