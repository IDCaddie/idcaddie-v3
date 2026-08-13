-- contract_entitlement_test.sql — runnable verification for 0084_contract_entitlements.sql
--
-- ENVIRONMENT CONTRACT (provided by scripts/test-rls.sh, not by this file): Postgres with every migration applied, a
-- Supabase-style auth.uid() reading current_setting('request.jwt.claims'), roles `authenticated` / `service_role`, and
-- table privileges granted (RLS does the filtering).
--
-- WHAT THIS PROVES. 0084 makes two authorization claims that are worth nothing unasserted:
--   (a) READ is exactly the visibility of the parent contract — including for org-only users who are not tenant members;
--   (b) WRITE is exactly the two authorities that may write the contract itself (tenant editor+, or manager of the
--       PROCUREMENT org) — and the PAYING org, which can read, still cannot write.
-- Plus the constraints that stop a wrong number reaching a customer: a price with no currency or cadence, a minimum above
-- the purchase, a negative quantity, a reversed term, and a cross-tenant reference.
--
-- NOTE ON NEGATIVE TESTS: `raise exception` in PL/pgSQL is SQLSTATE P0001, which a `when others` handler swallows. Every
-- negative case below asserts on a flag evaluated OUTSIDE the handler, never on the handler having run.
--
-- Fixtures live in the ce……… id space and this file TRUNCATES NOTHING, so it cannot disturb a neighbouring suite.

\set ON_ERROR_STOP on

reset role;

-- ── Fixtures ────────────────────────────────────────────────────────────────────────────────────────────────────────
-- Tenant 1 holds one contract, procured by org P and paid by org Y. Tenant 2 exists only to be excluded.
insert into auth.users (id, email) values
  ('ce000000-0000-4000-8000-00000000e001','ce_editor@t1.test'),
  ('ce000000-0000-4000-8000-00000000e002','ce_viewer@t1.test'),
  ('ce000000-0000-4000-8000-00000000e003','ce_procmgr@t1.test'),
  ('ce000000-0000-4000-8000-00000000e004','ce_paymgr@t1.test'),
  ('ce000000-0000-4000-8000-00000000e005','ce_outsider@t1.test'),
  ('ce000000-0000-4000-8000-00000000e006','ce_owner@t2.test');

insert into public.profiles (id, email) values
  ('ce000000-0000-4000-8000-00000000e001','ce_editor@t1.test'),
  ('ce000000-0000-4000-8000-00000000e002','ce_viewer@t1.test'),
  ('ce000000-0000-4000-8000-00000000e003','ce_procmgr@t1.test'),
  ('ce000000-0000-4000-8000-00000000e004','ce_paymgr@t1.test'),
  ('ce000000-0000-4000-8000-00000000e005','ce_outsider@t1.test'),
  ('ce000000-0000-4000-8000-00000000e006','ce_owner@t2.test');

insert into public.tenants (id, name, slug) values
  ('ce000000-0000-4000-8000-000000000011','CE Tenant 1','ce-t1'),
  ('ce000000-0000-4000-8000-000000000012','CE Tenant 2','ce-t2');

insert into public.organizations (id, tenant_id, name) values
  ('ce000000-0000-4000-8000-0000000000a1','ce000000-0000-4000-8000-000000000011','CE Procurement'),
  ('ce000000-0000-4000-8000-0000000000a2','ce000000-0000-4000-8000-000000000011','CE Paying');

insert into public.tenant_memberships (tenant_id, user_id, role, status) values
  ('ce000000-0000-4000-8000-000000000011','ce000000-0000-4000-8000-00000000e001','editor','active'),
  ('ce000000-0000-4000-8000-000000000011','ce000000-0000-4000-8000-00000000e002','viewer','active'),
  ('ce000000-0000-4000-8000-000000000012','ce000000-0000-4000-8000-00000000e006','owner','active');

-- Org-only users: members of an organization, NOT of the tenant. This is the population 0003/0006 exist for.
insert into public.organization_memberships (organization_id, user_id, role) values
  ('ce000000-0000-4000-8000-0000000000a1','ce000000-0000-4000-8000-00000000e003','manager'),
  ('ce000000-0000-4000-8000-0000000000a2','ce000000-0000-4000-8000-00000000e004','manager');

insert into public.contracts (id, tenant_id, contract_name, vendor_name, procurement_org_id, paying_org_id) values
  ('ce000000-0000-4000-8000-0000000000c1','ce000000-0000-4000-8000-000000000011','CE Slack Agreement','Slack',
   'ce000000-0000-4000-8000-0000000000a1','ce000000-0000-4000-8000-0000000000a2');
insert into public.contracts (id, tenant_id, contract_name) values
  ('ce000000-0000-4000-8000-0000000000c2','ce000000-0000-4000-8000-000000000012','CE Other Tenant Agreement');

-- A canonical vendor in the OTHER tenant, for the cross-tenant FK assertion.
insert into public.vendors (id, tenant_id, name, normalized_name) values
  ('ce000000-0000-4000-8000-0000000000d2','ce000000-0000-4000-8000-000000000012','Slack','slack');

-- ── T1 — a tenant editor may create and amend a line ────────────────────────────────────────────────────────────────
select set_config('request.jwt.claims','{"sub":"ce000000-0000-4000-8000-00000000e001"}',false);
set role authenticated;
do $$
declare v integer;
begin
  insert into public.contract_entitlements
    (id, tenant_id, contract_id, sku, purchased_quantity, quantity_unit, unit_amount, currency, billing_frequency, source, confidence)
  values
    ('ce000000-0000-4000-8000-0000000000f1','ce000000-0000-4000-8000-000000000011','ce000000-0000-4000-8000-0000000000c1',
     'SLACK-BUSINESS-PLUS', 3200, 'seat', 12.50, 'USD', 'monthly', 'order_form', 'high');
  get diagnostics v = row_count;
  assert v = 1, format('T1 tenant editor should insert an entitlement (%s rows)', v);

  update public.contract_entitlements set purchased_quantity = 3300, updated_at = now()
   where id = 'ce000000-0000-4000-8000-0000000000f1';
  get diagnostics v = row_count;
  assert v = 1, format('T1 tenant editor should update an entitlement (%s rows)', v);
end $$;
reset role;

-- ── T2 — the write was audited, with the CALLER as actor ────────────────────────────────────────────────────────────
-- The 0010 pattern under SECURITY DEFINER: auth.uid() reads the request JWT, so the actor is the writing user, never
-- the function owner and never service_role.
do $$
declare v integer;
begin
  select count(*) into v from public.audit_logs
   where resource_type = 'contract_entitlement'
     and resource_id = 'ce000000-0000-4000-8000-0000000000f1'
     and actor_user_id = 'ce000000-0000-4000-8000-00000000e001'
     and action in ('contract_entitlement.created','contract_entitlement.updated');
  assert v = 2, format('T2 expected a created + an updated audit row, saw %s', v);

  select count(*) into v from public.audit_logs
   where resource_id = 'ce000000-0000-4000-8000-0000000000f1'
     and after_json ? 'unit_amount';
  assert v = 0, format('T2 audit metadata must not carry the price (%s rows did)', v);
end $$;

-- ── T3 — a tenant viewer reads but cannot write ─────────────────────────────────────────────────────────────────────
select set_config('request.jwt.claims','{"sub":"ce000000-0000-4000-8000-00000000e002"}',false);
set role authenticated;
do $$
declare v integer; denied boolean := false;
begin
  select count(*) into v from public.contract_entitlements;
  assert v = 1, format('T3 tenant viewer should read 1 entitlement, saw %s', v);

  begin
    insert into public.contract_entitlements (tenant_id, contract_id, purchased_quantity)
    values ('ce000000-0000-4000-8000-000000000011','ce000000-0000-4000-8000-0000000000c1', 5);
  exception when others then denied := true;
  end;
  assert denied, 'T3 ESCALATION: a tenant viewer inserted a contract entitlement';

  update public.contract_entitlements set purchased_quantity = 1
   where id = 'ce000000-0000-4000-8000-0000000000f1';
  get diagnostics v = row_count;
  assert v = 0, format('T3 ESCALATION: a tenant viewer updated an entitlement (%s rows)', v);
end $$;
reset role;

-- ── T4 — the PROCUREMENT-org manager (no tenant membership) reads AND writes ────────────────────────────────────────
-- This is the steward case 0003/0004 grant on `contracts`; an entitlement must inherit it or a procurement manager
-- could create a contract they then cannot describe.
select set_config('request.jwt.claims','{"sub":"ce000000-0000-4000-8000-00000000e003"}',false);
set role authenticated;
do $$
declare v integer;
begin
  select count(*) into v from public.contract_entitlements;
  assert v = 1, format('T4 procurement manager should read 1 entitlement, saw %s', v);

  insert into public.contract_entitlements
    (id, tenant_id, contract_id, plan_name, purchased_quantity, source, confidence)
  values
    ('ce000000-0000-4000-8000-0000000000f2','ce000000-0000-4000-8000-000000000011','ce000000-0000-4000-8000-0000000000c1',
     'Slack Connect add-on', 250, 'contract_document', 'medium');
  get diagnostics v = row_count;
  assert v = 1, format('T4 procurement manager should insert an entitlement (%s rows)', v);

  update public.contract_entitlements set purchased_quantity = 260, updated_at = now()
   where id = 'ce000000-0000-4000-8000-0000000000f2';
  get diagnostics v = row_count;
  assert v = 1, format('T4 procurement manager should update their entitlement (%s rows)', v);
end $$;
reset role;

-- ── T5 — the PAYING-org manager reads but never writes ──────────────────────────────────────────────────────────────
-- Paying for something is not authority over its terms; 0004 encodes that for contracts and it must not leak here.
select set_config('request.jwt.claims','{"sub":"ce000000-0000-4000-8000-00000000e004"}',false);
set role authenticated;
do $$
declare v integer; denied boolean := false;
begin
  select count(*) into v from public.contract_entitlements;
  assert v = 2, format('T5 paying manager should read 2 entitlements, saw %s', v);

  begin
    insert into public.contract_entitlements (tenant_id, contract_id, purchased_quantity)
    values ('ce000000-0000-4000-8000-000000000011','ce000000-0000-4000-8000-0000000000c1', 99);
  exception when others then denied := true;
  end;
  assert denied, 'T5 ESCALATION: the paying-org manager inserted a contract entitlement';

  update public.contract_entitlements set purchased_quantity = 1
   where id = 'ce000000-0000-4000-8000-0000000000f1';
  get diagnostics v = row_count;
  assert v = 0, format('T5 ESCALATION: the paying-org manager updated an entitlement (%s rows)', v);
end $$;
reset role;

-- ── T6 — a user with no membership at all sees nothing ──────────────────────────────────────────────────────────────
select set_config('request.jwt.claims','{"sub":"ce000000-0000-4000-8000-00000000e005"}',false);
set role authenticated;
do $$
declare v integer;
begin
  select count(*) into v from public.contract_entitlements;
  assert v = 0, format('T6 an unaffiliated user saw %s entitlements', v);
end $$;
reset role;

-- ── T7 — cross-tenant isolation ─────────────────────────────────────────────────────────────────────────────────────
select set_config('request.jwt.claims','{"sub":"ce000000-0000-4000-8000-00000000e006"}',false);
set role authenticated;
do $$
declare v integer;
begin
  select count(*) into v from public.contract_entitlements
   where tenant_id = 'ce000000-0000-4000-8000-000000000011';
  assert v = 0, format('T7 CROSS-TENANT: tenant 2 owner read %s tenant 1 entitlements', v);
end $$;
reset role;

-- ── T8 — no DELETE, for anyone ──────────────────────────────────────────────────────────────────────────────────────
-- The harness re-broadens table privileges, so this asserts the POLICY (there is no DELETE policy), which is the real
-- boundary: financial evidence is evidence (0004).
select set_config('request.jwt.claims','{"sub":"ce000000-0000-4000-8000-00000000e001"}',false);
set role authenticated;
do $$
declare v integer;
begin
  delete from public.contract_entitlements where id = 'ce000000-0000-4000-8000-0000000000f1';
  get diagnostics v = row_count;
  assert v = 0, format('T8 a tenant editor DELETED an entitlement (%s rows)', v);

  select count(*) into v from public.contract_entitlements;
  assert v = 2, format('T8 expected both entitlements to survive, saw %s', v);
end $$;
reset role;

-- ── T9 — the constraints that stop a wrong number ───────────────────────────────────────────────────────────────────
-- Run privileged: these are CHECK/FK guarantees, which hold regardless of who is writing. Separating them from the RLS
-- cases keeps a constraint failure from being misread as an authorization failure.
do $$
declare ok boolean;
begin
  -- A price with no currency cannot be compared, and with no cadence cannot be annualized. Both are refused.
  ok := false;
  begin
    insert into public.contract_entitlements (tenant_id, contract_id, unit_amount, billing_frequency)
    values ('ce000000-0000-4000-8000-000000000011','ce000000-0000-4000-8000-0000000000c1', 10.00, 'monthly');
  exception when others then ok := true;
  end;
  assert ok, 'T9 a unit_amount was accepted with no currency';

  ok := false;
  begin
    insert into public.contract_entitlements (tenant_id, contract_id, unit_amount, currency)
    values ('ce000000-0000-4000-8000-000000000011','ce000000-0000-4000-8000-0000000000c1', 10.00, 'USD');
  exception when others then ok := true;
  end;
  assert ok, 'T9 a unit_amount was accepted with no billing frequency';

  -- A floor above the purchase is incoherent, and it would make a savings estimate negative.
  ok := false;
  begin
    insert into public.contract_entitlements (tenant_id, contract_id, purchased_quantity, minimum_quantity)
    values ('ce000000-0000-4000-8000-000000000011','ce000000-0000-4000-8000-0000000000c1', 100, 200);
  exception when others then ok := true;
  end;
  assert ok, 'T9 a minimum_quantity above purchased_quantity was accepted';

  ok := false;
  begin
    insert into public.contract_entitlements (tenant_id, contract_id, purchased_quantity)
    values ('ce000000-0000-4000-8000-000000000011','ce000000-0000-4000-8000-0000000000c1', -1);
  exception when others then ok := true;
  end;
  assert ok, 'T9 a negative purchased_quantity was accepted';

  ok := false;
  begin
    insert into public.contract_entitlements (tenant_id, contract_id, term_start, term_end)
    values ('ce000000-0000-4000-8000-000000000011','ce000000-0000-4000-8000-0000000000c1', '2026-06-01', '2026-01-01');
  exception when others then ok := true;
  end;
  assert ok, 'T9 a term ending before it starts was accepted';

  ok := false;
  begin
    insert into public.contract_entitlements (tenant_id, contract_id, quantity_unit)
    values ('ce000000-0000-4000-8000-000000000011','ce000000-0000-4000-8000-0000000000c1', 'gigabytes');
  exception when others then ok := true;
  end;
  assert ok, 'T9 an unbounded quantity_unit was accepted';

  ok := false;
  begin
    insert into public.contract_entitlements (tenant_id, contract_id, source)
    values ('ce000000-0000-4000-8000-000000000011','ce000000-0000-4000-8000-0000000000c1', 'a_guess');
  exception when others then ok := true;
  end;
  assert ok, 'T9 an unbounded provenance source was accepted';
end $$;

-- ── T10 — every reference is same-tenant, enforced by the database ──────────────────────────────────────────────────
do $$
declare ok boolean;
begin
  ok := false;
  begin
    insert into public.contract_entitlements (tenant_id, contract_id)
    values ('ce000000-0000-4000-8000-000000000011','ce000000-0000-4000-8000-0000000000c2');   -- tenant 2's contract
  exception when others then ok := true;
  end;
  assert ok, 'T10 CROSS-TENANT: an entitlement referenced another tenant''s contract';

  ok := false;
  begin
    insert into public.contract_entitlements (tenant_id, contract_id, vendor_id)
    values ('ce000000-0000-4000-8000-000000000011','ce000000-0000-4000-8000-0000000000c1',
            'ce000000-0000-4000-8000-0000000000d2');                                          -- tenant 2's vendor
  exception when others then ok := true;
  end;
  assert ok, 'T10 CROSS-TENANT: an entitlement referenced another tenant''s vendor';
end $$;

-- ── T11 — an unrecorded quantity is NULL, never 0 ───────────────────────────────────────────────────────────────────
-- The whole reconciliation layer depends on this: "nobody told us" and "they bought none" must not arrive as the same
-- value. A column default of 0 anywhere above would silently break every downstream finding.
do $$
declare v integer;
begin
  insert into public.contract_entitlements (id, tenant_id, contract_id)
  values ('ce000000-0000-4000-8000-0000000000f3','ce000000-0000-4000-8000-000000000011','ce000000-0000-4000-8000-0000000000c1');

  select count(*) into v from public.contract_entitlements
   where id = 'ce000000-0000-4000-8000-0000000000f3' and purchased_quantity is null;
  assert v = 1, 'T11 an entitlement with no recorded quantity did not read as NULL';

  select count(*) into v from public.contract_entitlements
   where id = 'ce000000-0000-4000-8000-0000000000f3' and source = 'manual_entry' and confidence = 'low';
  assert v = 1, 'T11 provenance did not default to the conservative reading';
end $$;

reset role;

-- ── T12 — an org manager of a DIFFERENT org in the SAME tenant reads none of another org's purchased lines ──────────
-- Review of PR #409 found this untested. T6 covers an unaffiliated user and T7 covers another tenant, but the sharpest
-- case is the one in between: an org-only steward who legitimately reads their OWN contract in this tenant must not
-- inherit the commercial detail of a contract procured by a different org.
insert into public.organizations (id, tenant_id, name) values
  ('ce000000-0000-4000-8000-0000000000a3','ce000000-0000-4000-8000-000000000011','CE Other Procurement');
insert into auth.users (id, email) values ('ce000000-0000-4000-8000-00000000e007','ce_othermgr@t1.test');
insert into public.profiles (id, email) values ('ce000000-0000-4000-8000-00000000e007','ce_othermgr@t1.test');
insert into public.organization_memberships (organization_id, user_id, role) values
  ('ce000000-0000-4000-8000-0000000000a3','ce000000-0000-4000-8000-00000000e007','manager');
insert into public.contracts (id, tenant_id, contract_name, procurement_org_id) values
  ('ce000000-0000-4000-8000-0000000000c3','ce000000-0000-4000-8000-000000000011','CE Other Org Agreement',
   'ce000000-0000-4000-8000-0000000000a3');

select set_config('request.jwt.claims','{"sub":"ce000000-0000-4000-8000-00000000e007"}',false);
set role authenticated;
do $$
declare v integer;
begin
  select count(*) into v from public.contracts;
  assert v = 1, format('T12 precondition: this manager should read exactly their own contract, saw %s', v);
  select count(*) into v from public.contract_entitlements;
  assert v = 0, format('T12 CROSS-ORG LEAK: an unrelated org manager read %s purchased lines', v);
end $$;
reset role;

-- ── T13 — a procurement manager cannot MOVE a line onto a contract they do not manage ───────────────────────────────
-- USING passes (they manage the OLD row's contract) and WITH CHECK rejects the NEW row, so the correct outcome is a
-- 42501 refusal — NOT a silent 0-row update. Asserting the refusal AND that nothing moved pins both halves.
select set_config('request.jwt.claims','{"sub":"ce000000-0000-4000-8000-00000000e003"}',false);   -- manager of CE Procurement
set role authenticated;
do $$
declare refused boolean := false; c uuid;
begin
  begin
    update public.contract_entitlements
       set contract_id = 'ce000000-0000-4000-8000-0000000000c3'      -- another org's contract
     where id = 'ce000000-0000-4000-8000-0000000000f2';
  exception when insufficient_privilege then refused := true;
  end;
  assert refused, 'T13 ESCALATION: a procurement manager moved a line onto a contract they do not manage';
  select contract_id into c from public.contract_entitlements where id = 'ce000000-0000-4000-8000-0000000000f2';
  assert c = 'ce000000-0000-4000-8000-0000000000c1', 'T13 ESCALATION: the line moved anyway';
end $$;
reset role;

-- ── T14 — the audit writer cannot be invoked directly to forge a row ────────────────────────────────────────────────
-- The 0084 revoke (inheriting 0081's posture) removes EXECUTE from every browser role; Postgres additionally refuses a
-- direct call to a trigger-returning function. Both belts are asserted here, plus that the append-only log did not grow.
select set_config('request.jwt.claims','{"sub":"ce000000-0000-4000-8000-00000000e001"}',false);
set role authenticated;
do $$
declare refused boolean := false; before_n integer; after_n integer;
begin
  select count(*) into before_n from public.audit_logs;
  begin
    perform public.audit_contract_entitlement_write();
  exception when others then refused := true;
  end;
  assert refused, 'T14 FORGERY: the audit writer was directly invocable';
  select count(*) into after_n from public.audit_logs;
  assert before_n = after_n, 'T14 FORGERY: a direct call appended an audit row';
end $$;
reset role;
