-- 0065 — per-capability validation evidence.
--
-- The properties that matter are all about ISOLATION and NON-ERASURE: one capability's failure must not touch another's
-- evidence, a browser role must not be able to claim any capability, and the historical users_read proof must survive
-- everything. Each is proven by doing the thing and checking, not by reading a grant table.

begin;

-- ── Fixtures ────────────────────────────────────────────────────────────────────────────────────────────────────────
insert into public.tenants (id, name, slug) values
  ('e0a70000-0000-4000-8000-00000000e001', 'Capability Tenant A', 'capability-tenant-a'),
  ('e0a70000-0000-4000-8000-00000000e002', 'Capability Tenant B', 'capability-tenant-b')
on conflict (id) do nothing;

insert into auth.users (id, email) values
  ('e0a70000-0000-4000-8000-0000000000a1', 'c-owner-a@example.test'),
  ('e0a70000-0000-4000-8000-0000000000a2', 'c-viewer-a@example.test')
on conflict (id) do nothing;
insert into public.profiles (id, email) values
  ('e0a70000-0000-4000-8000-0000000000a1', 'c-owner-a@example.test'),
  ('e0a70000-0000-4000-8000-0000000000a2', 'c-viewer-a@example.test')
on conflict (id) do nothing;
insert into public.tenant_memberships (tenant_id, user_id, role) values
  ('e0a70000-0000-4000-8000-00000000e001', 'e0a70000-0000-4000-8000-0000000000a1', 'owner'),
  ('e0a70000-0000-4000-8000-00000000e001', 'e0a70000-0000-4000-8000-0000000000a2', 'viewer')
on conflict do nothing;

select set_config('request.jwt.claims', '{"sub":"e0a70000-0000-4000-8000-0000000000a1"}', false);
set role authenticated;
select public.create_okta_connector_configuration(
  'e0a70000-0000-4000-8000-00000000e001'::uuid, 'trial-5294016.okta.com', '0oa15fcokefFqDREa698',
  'fe118591fa7bee3d662f3c5ddbac31a8b11968c7b5c4a8fbbf196cb974c7238a',
  '07c3712380ccf1b82150ebaab0757131d4091441bd450e04c5c9265c310dcac0',
  'e0a70000-0000-4000-8000-00000000f001'::uuid, 'Capability Fixture');
reset role;

-- ── K0: grant shape — runner only ───────────────────────────────────────────────────────────────────────────────────
do $$
declare f constant text := 'public.runner_record_okta_capability_evidence(uuid,uuid,uuid,text,text,text,text,text)';
begin
  assert has_function_privilege('connector_runner', f, 'EXECUTE'), 'K0 connector_runner must hold EXECUTE';
  assert not has_function_privilege('authenticated', f, 'EXECUTE'), 'K0 authenticated must NOT hold EXECUTE';
  assert not has_function_privilege('anon', f, 'EXECUTE'), 'K0 anon must NOT hold EXECUTE';
  assert not has_function_privilege('service_role', f, 'EXECUTE'), 'K0 service_role must NOT hold EXECUTE';
  -- 0064's pin moved with the contract; a stale pin would silently reject every future submission.
  assert pg_get_functiondef((select oid from pg_proc where proname = 'runner_record_okta_connector_validation'))
    like '%1.2.0%', 'K0 the 0064 contract pin must have moved to 1.2.0';
end $$;

-- ── K1: an OWNER cannot claim a capability ──────────────────────────────────────────────────────────────────────────
select set_config('request.jwt.claims', '{"sub":"e0a70000-0000-4000-8000-0000000000a1"}', false);
set role authenticated;
do $$ declare v_connector uuid; begin
  select connector_id into v_connector from public.okta_connector_configs
    where tenant_id = 'e0a70000-0000-4000-8000-00000000e001';
  begin
    perform public.runner_record_okta_capability_evidence(
      'e0a70000-0000-4000-8000-00000000e001', v_connector, gen_random_uuid(), 'apps_read', 'verified',
      'p7AyvDK0yI95_HdQBxdhBSOTt9mMYPczGL-4USxaMto', '1.2.0', null);
    raise exception 'K1 an OWNER must not be able to claim a capability';
  exception when insufficient_privilege then null;
  end;
  -- ...nor write the table directly.
  begin
    insert into public.okta_connector_capability_evidence (tenant_id, connector_id, capability, status)
      values ('e0a70000-0000-4000-8000-00000000e001', v_connector, 'apps_read', 'verified');
    raise exception 'K1 an OWNER must not be able to INSERT capability evidence';
  exception when insufficient_privilege then null; when check_violation then null;
  end;
end $$;
reset role;

-- ── K2–K8: behaviour, exercised as the owner of the function ────────────────────────────────────────────────────────
do $$
declare
  v_connector uuid; v_run1 uuid; v_run2 uuid; v_run3 uuid; v_res jsonb; v_n int; v_status text; v_ts timestamptz;
  KID constant text := 'p7AyvDK0yI95_HdQBxdhBSOTt9mMYPczGL-4USxaMto';
  TA  constant uuid := 'e0a70000-0000-4000-8000-00000000e001';
  TB  constant uuid := 'e0a70000-0000-4000-8000-00000000e002';
begin
  select connector_id into v_connector from public.okta_connector_configs where tenant_id = TA;
  v_run1 := public.runner_open_connector_run(TA, v_connector);
  v_run2 := public.runner_open_connector_run(TA, v_connector);
  v_run3 := public.runner_open_connector_run(TA, v_connector);

  -- K2: record users_read, then groups_read. Each is its own row with its own run.
  v_res := public.runner_record_okta_capability_evidence(TA, v_connector, v_run1, 'users_read', 'verified', KID, '1.2.0', null);
  assert v_res->>'outcome' = 'recorded' and v_res->>'status' = 'verified', 'K2 users_read recorded';
  v_res := public.runner_record_okta_capability_evidence(TA, v_connector, v_run2, 'groups_read', 'verified', KID, '1.2.0', null);
  assert v_res->>'outcome' = 'recorded', 'K2 groups_read recorded';

  select count(*) into v_n from public.okta_connector_capability_evidence
    where connector_id = v_connector and status = 'verified';
  assert v_n = 2, 'K2 expected two verified capabilities, saw ' || v_n;

  -- apps_read was never submitted, so it must simply not exist. A groups run cannot imply apps.
  select count(*) into v_n from public.okta_connector_capability_evidence
    where connector_id = v_connector and capability = 'apps_read';
  assert v_n = 0, 'K2 apps_read must NOT exist from a groups-only run, saw ' || v_n;

  -- K3: audit exactly once per logical result, and no credential material.
  select count(*) into v_n from public.audit_logs
    where tenant_id = TA and action = 'okta_connector_capability_verified';
  assert v_n = 2, 'K3 expected exactly two capability audits, saw ' || v_n;
  select count(*) into v_n from public.audit_logs where tenant_id = TA
    and after_json::text ~* '(bearer |eyJ|-----BEGIN|access_token|assertion|signature)';
  assert v_n = 0, 'K3 audit must carry no credential material';

  -- K4: idempotent replay — no write, no second audit, no timestamp drift.
  select last_verified_at into v_ts from public.okta_connector_capability_evidence
    where connector_id = v_connector and capability = 'groups_read';
  v_res := public.runner_record_okta_capability_evidence(TA, v_connector, v_run2, 'groups_read', 'verified', KID, '1.2.0', null);
  assert v_res->>'outcome' = 'idempotent_replay', 'K4 expected idempotent_replay, got ' || (v_res->>'outcome');
  select count(*) into v_n from public.audit_logs
    where tenant_id = TA and action = 'okta_connector_capability_verified';
  assert v_n = 2, 'K4 replay must not emit a third audit, saw ' || v_n;
  select count(*) into v_n from public.okta_connector_capability_evidence
    where connector_id = v_connector and capability = 'groups_read' and last_verified_at = v_ts;
  assert v_n = 1, 'K4 replay must not move last_verified_at';

  -- K5: A FAILED CAPABILITY MUST NOT ERASE ANOTHER. The central isolation property.
  v_res := public.runner_record_okta_capability_evidence(TA, v_connector, v_run3, 'apps_read', 'failed', KID, '1.2.0', 'permission_insufficient');
  assert v_res->>'status' = 'failed', 'K5 apps_read failure recorded';

  select status into v_status from public.okta_connector_capability_evidence
    where connector_id = v_connector and capability = 'users_read';
  assert v_status = 'verified', 'K5 users_read must survive an apps_read failure, saw ' || v_status;
  select status into v_status from public.okta_connector_capability_evidence
    where connector_id = v_connector and capability = 'groups_read';
  assert v_status = 'verified', 'K5 groups_read must survive an apps_read failure, saw ' || v_status;
  -- ...and the users validation record itself is untouched.
  select validation_status into v_status from public.okta_connector_configs where connector_id = v_connector;
  assert v_status <> 'failed', 'K5 an apps failure must not fail the connector validation, saw ' || v_status;

  -- K6: a stale failure cannot demote a verified capability.
  begin
    perform public.runner_record_okta_capability_evidence(TA, v_connector, v_run3, 'users_read', 'failed', KID, '1.2.0', 'invalid_client');
    raise exception 'K6 a failed result must not demote a verified capability';
  exception when sqlstate '22023' then null;
  end;
  -- The WHOLE evidence package must survive a rejected demotion, not merely the status field: a guard that kept `verified`
  -- while dropping the run binding or the KID would leave a row claiming proof it could no longer point at.
  select status into v_status from public.okta_connector_capability_evidence
    where connector_id = v_connector and capability = 'users_read';
  assert v_status = 'verified', 'K6 users_read must remain verified';
  select count(*) into v_n from public.okta_connector_capability_evidence
    where connector_id = v_connector and capability = 'users_read'
      and verified_kid = KID and contract_version is not null
      and validation_run_id is not null and last_verified_at is not null and first_verified_at is not null;
  assert v_n = 1, 'K6 a rejected demotion must leave the full evidence package intact';

  -- K7: pinned and bounded inputs are refused.
  begin
    perform public.runner_record_okta_capability_evidence(TA, v_connector, v_run3, 'groups_read', 'verified',
      'VDkZAQoJl_prLRU83WiPreOBGoP6Fib3qC0CG880wz0', '1.2.0', null);
    raise exception 'K7 a stale KID must be refused';
  exception when sqlstate '22023' then null; end;

  begin
    perform public.runner_record_okta_capability_evidence(TA, v_connector, v_run3, 'groups_read', 'verified', KID, '1.1.0', null);
    raise exception 'K7 a stale contract version must be refused';
  exception when sqlstate '22023' then null; end;

  begin
    perform public.runner_record_okta_capability_evidence(TA, v_connector, v_run3, 'memberships_read', 'verified', KID, '1.2.0', null);
    raise exception 'K7 an unknown capability must be refused';
  exception when sqlstate '22023' then null; end;

  begin
    perform public.runner_record_okta_capability_evidence(TA, v_connector, gen_random_uuid(), 'groups_read', 'verified', KID, '1.2.0', null);
    raise exception 'K7 a forged run must be refused';
  exception when insufficient_privilege then null; end;

  begin
    perform public.runner_record_okta_capability_evidence(TB, v_connector, v_run3, 'groups_read', 'verified', KID, '1.2.0', null);
    raise exception 'K7 a cross-tenant result must be refused';
  exception when insufficient_privilege then null; end;

  -- K7b (0066): the three ASSIGNMENT/MEMBERSHIP capabilities are accepted, each as its own row, and an undeclared one is not.
  -- They are separate rows on purpose: app-USER and app-GROUP assignments are different Okta endpoints that can fail
  -- independently, so one flag covering both could claim access that does not exist.
  v_res := public.runner_record_okta_capability_evidence(TA, v_connector, v_run1, 'group_memberships_read', 'verified', KID, '1.2.0', null);
  assert v_res->>'status' = 'verified', 'K7b group_memberships_read recorded';
  v_res := public.runner_record_okta_capability_evidence(TA, v_connector, v_run2, 'app_user_assignments_read', 'verified', KID, '1.2.0', null);
  assert v_res->>'status' = 'verified', 'K7b app_user_assignments_read recorded';

  -- Recording app-USER assignments must NOT imply app-GROUP assignments.
  select count(*) into v_n from public.okta_connector_capability_evidence
    where connector_id = v_connector and capability = 'app_group_assignments_read';
  assert v_n = 0, 'K7b app_group_assignments_read must not appear from an app-user run, saw ' || v_n;

  -- ...and the three earlier capabilities are untouched by any of it.
  select count(*) into v_n from public.okta_connector_capability_evidence
    where connector_id = v_connector and status = 'verified'
      and capability in ('users_read', 'groups_read');
  assert v_n = 2, 'K7b prior evidence must be preserved, saw ' || v_n;

  begin
    perform public.runner_record_okta_capability_evidence(TA, v_connector, v_run3, 'app_admin_write', 'verified', KID, '1.2.0', null);
    raise exception 'K7b an undeclared capability must be refused';
  exception when sqlstate '22023' then null; end;

  -- K8: the pinned-KID CHECK holds against a direct owner UPDATE, and verified evidence cannot be stripped.
  begin
    update public.okta_connector_capability_evidence set verified_kid = 'VDkZAQoJl_prLRU83WiPreOBGoP6Fib3qC0CG880wz0'
      where connector_id = v_connector and capability = 'users_read';
    raise exception 'K8 the pinned KID CHECK must reject a stale KID even for the owner';
  exception when check_violation then null; end;

  begin
    update public.okta_connector_capability_evidence set validation_run_id = null
      where connector_id = v_connector and capability = 'users_read';
    raise exception 'K8 a verified row must not survive losing its run binding';
  exception when check_violation then null; end;
end $$;

-- ── K9: a viewer can READ evidence for their tenant and nothing else ────────────────────────────────────────────────
select set_config('request.jwt.claims', '{"sub":"e0a70000-0000-4000-8000-0000000000a2"}', false);
set role authenticated;
do $$ declare n int; begin
  select count(*) into n from public.okta_connector_capability_evidence
    where tenant_id = 'e0a70000-0000-4000-8000-00000000e001';
  assert n = 5, 'K9 a viewer must read their own tenant evidence, saw ' || n;
  select count(*) into n from public.okta_connector_capability_evidence
    where tenant_id = 'e0a70000-0000-4000-8000-00000000e002';
  assert n = 0, 'K9 a viewer must not read another tenant, saw ' || n;

  -- Hardened by BOTH an absent write grant and RLS with no write policy. Accept either.
  begin
    update public.okta_connector_capability_evidence set status = 'verified';
    get diagnostics n = row_count;
    assert n = 0, 'K9 direct UPDATE must affect zero rows, affected ' || n;
  exception when insufficient_privilege then null; end;
  begin
    delete from public.okta_connector_capability_evidence;
    get diagnostics n = row_count;
    assert n = 0, 'K9 direct DELETE must affect zero rows, affected ' || n;
  exception when insufficient_privilege then null; end;
end $$;
reset role;

select 'ALL O2C.3 CAPABILITY-EVIDENCE ASSERTIONS PASSED' as result;

rollback;
