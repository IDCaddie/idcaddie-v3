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
  public.audit_logs, public.app_contracts, public.apps, public.contracts,
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
  ('0a000000-0000-0000-0000-0000000000e0','member_x@a.test'),
  ('0b000000-0000-0000-0000-000000000001','owner_b@b.test');

insert into public.profiles (id, email) values
  ('0a000000-0000-0000-0000-000000000001','owner_a@a.test'),
  ('0a000000-0000-0000-0000-000000000002','viewer_a@a.test'),
  ('0a000000-0000-0000-0000-0000000000ad','admin_a@a.test'),
  ('0a000000-0000-0000-0000-0000000000a1','mgr_a1@a.test'),
  ('0a000000-0000-0000-0000-0000000000a2','viewer_a1@a.test'),
  ('0a000000-0000-0000-0000-0000000000a3','mgr_a2@a.test'),
  ('0a000000-0000-0000-0000-0000000000e0','member_x@a.test'),
  ('0b000000-0000-0000-0000-000000000001','owner_b@b.test');

insert into public.tenants (id, name, slug) values
  ('11111111-1111-1111-1111-111111111111','Tenant A','tenant-a'),
  ('22222222-2222-2222-2222-222222222222','Tenant B','tenant-b');

insert into public.organizations (id, tenant_id, name) values
  ('1a1a1a1a-0000-0000-0000-000000000001','11111111-1111-1111-1111-111111111111','Org A1'),
  ('1a1a1a1a-0000-0000-0000-000000000002','11111111-1111-1111-1111-111111111111','Org A2'),
  ('2b2b2b2b-0000-0000-0000-000000000001','22222222-2222-2222-2222-222222222222','Org B1');

-- Tenant-wide roles (owner_a, admin_a, viewer_a, owner_b). org-only users get NO tenant_membership.
-- member_x has NO membership of any kind (target for admin add-member test).
insert into public.tenant_memberships (tenant_id, user_id, role) values
  ('11111111-1111-1111-1111-111111111111','0a000000-0000-0000-0000-000000000001','owner'),
  ('11111111-1111-1111-1111-111111111111','0a000000-0000-0000-0000-0000000000ad','admin'),
  ('11111111-1111-1111-1111-111111111111','0a000000-0000-0000-0000-000000000002','viewer'),
  ('22222222-2222-2222-2222-222222222222','0b000000-0000-0000-0000-000000000001','owner');

-- Org-scoped roles. owner_b also manages org B1 (used to prove the tenant binding,
-- not just plain non-membership, is what blocks the cross-tenant org-pointer leak).
insert into public.organization_memberships (organization_id, user_id, role) values
  ('1a1a1a1a-0000-0000-0000-000000000001','0a000000-0000-0000-0000-0000000000a1','manager'),
  ('1a1a1a1a-0000-0000-0000-000000000001','0a000000-0000-0000-0000-0000000000a2','viewer'),
  ('1a1a1a1a-0000-0000-0000-000000000002','0a000000-0000-0000-0000-0000000000a3','manager'),
  ('2b2b2b2b-0000-0000-0000-000000000001','0b000000-0000-0000-0000-000000000001','manager');

-- Apps: A1->orgA1, A2->orgA2, A_none->NULL org (tenant-wide only), B1->orgB1.
insert into public.apps (id, tenant_id, name, responsible_org_id) values
  ('a9900000-0000-0000-0000-0000000000a1','11111111-1111-1111-1111-111111111111','App A1','1a1a1a1a-0000-0000-0000-000000000001'),
  ('a9900000-0000-0000-0000-0000000000a2','11111111-1111-1111-1111-111111111111','App A2','1a1a1a1a-0000-0000-0000-000000000002'),
  ('a9900000-0000-0000-0000-0000000000a0','11111111-1111-1111-1111-111111111111','App A-none',null),
  ('b9900000-0000-0000-0000-0000000000b1','22222222-2222-2222-2222-222222222222','App B1','2b2b2b2b-0000-0000-0000-000000000001');

insert into public.contracts (id, tenant_id, contract_name, procurement_org_id) values
  ('c0000000-0000-0000-0000-0000000000a1','11111111-1111-1111-1111-111111111111','Contract A1','1a1a1a1a-0000-0000-0000-000000000001');

insert into public.audit_logs (id, tenant_id, action, resource_type) values
  ('ad000000-0000-0000-0000-0000000000a1','11111111-1111-1111-1111-111111111111','app.create','apps');

-- ── Test 1: Tenant A user cannot read Tenant B; sees all of its own tenant ─────
select set_config('request.jwt.claims','{"sub":"0a000000-0000-0000-0000-000000000001"}',false);
set role authenticated;
do $$ declare v int; begin
  select count(*) into v from public.apps where tenant_id='22222222-2222-2222-2222-222222222222';
  assert v = 0, format('T1 cross-tenant read: tenant A owner saw %s tenant B apps', v);
  select count(*) into v from public.apps where tenant_id='11111111-1111-1111-1111-111111111111';
  assert v = 3, format('T1 tenant A owner should see 3 own apps, saw %s', v);
end $$;
reset role;

-- ── Test 2: Viewer can read but cannot edit ───────────────────────────────────
select set_config('request.jwt.claims','{"sub":"0a000000-0000-0000-0000-000000000002"}',false);
set role authenticated;
do $$ declare v int; begin
  select count(*) into v from public.apps where tenant_id='11111111-1111-1111-1111-111111111111';
  assert v = 3, format('T2 tenant viewer should read 3 apps, saw %s', v);
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

-- ── Test 17 (DESTRUCTIVE, run last): org-manager DELETE scope ─────────────────
-- own-org delete allowed; cross-org and cross-tenant denied.
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
  assert v = 1, format('T17 own-org: mgr A1 should delete its org app (%s rows)', v);
end $$;
reset role;

do $$ begin raise notice 'ALL ORG-RLS ASSERTIONS PASSED'; end $$;
