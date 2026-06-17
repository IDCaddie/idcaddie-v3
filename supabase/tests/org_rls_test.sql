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

-- 33d: CATALOG — after `0013`, `files` is SELECT+INSERT-policied (no longer zero-policy), but keeps
-- the safe shape: 0 UPDATE (scan/extraction status transitions are a future worker, not a user
-- UPDATE), 0 DELETE, 0 FOR ALL; RLS still enabled. (The T33 "0 policies" check from `0012` is
-- intentionally superseded here — `0013` is the file RLS step.)
do $$ declare v int; begin
  select count(*) into v from pg_policies where schemaname='public' and tablename='files' and cmd='SELECT';
  assert v = 1, format('T33 files must have a SELECT policy after 0013, saw %s', v);
  select count(*) into v from pg_policies where schemaname='public' and tablename='files' and cmd='INSERT';
  assert v = 1, format('T33 files must have an INSERT policy after 0013, saw %s', v);
  select count(*) into v from pg_policies where schemaname='public' and tablename='files' and cmd='UPDATE';
  assert v = 0, format('T33 files must have 0 UPDATE policies (status updates deferred), saw %s', v);
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

-- 34c: DELETE is denied for everyone (no DELETE policy) — even a tenant owner; the row survives.
select set_config('request.jwt.claims','{"sub":"0a000000-0000-0000-0000-000000000001"}',false); -- owner_a
set role authenticated;
do $$ declare v int; begin
  delete from public.files where id='13000000-0000-0000-0000-0000000000e1';
  get diagnostics v = row_count;
  assert v = 0, format('T34 no DELETE policy — a tenant owner must not delete a file (%s rows)', v);
  assert (select count(*) from public.files where id='13000000-0000-0000-0000-0000000000e1') = 1, 'T34 the file must survive the delete attempt';
end $$;
reset role;
-- 34d: UPDATE is denied (no UPDATE policy) — even a tenant editor cannot change a file's status
-- (scan/extraction transitions are deferred to a future worker, not a user UPDATE).
select set_config('request.jwt.claims','{"sub":"0a000000-0000-0000-0000-0000000000ed"}',false); -- editor_a
set role authenticated;
do $$ declare v int; begin
  update public.files set scan_status='passed' where id='13000000-0000-0000-0000-0000000000e1';
  get diagnostics v = row_count;
  assert v = 0, format('T34 no UPDATE policy — a tenant editor must not update a file status (%s rows)', v);
end $$;
reset role;

do $$ begin raise notice 'ALL ORG-RLS ASSERTIONS PASSED'; end $$;
