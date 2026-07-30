-- 0064 — the validation-result write path.
--
-- The load-bearing property is NEGATIVE: no browser role, at any privilege level, can assert that validation succeeded. That is
-- proven by CALLING the function as each of those roles and requiring a privilege error — not by reading a grant table.
--
-- The POSITIVE side is asserted by grant shape rather than by execution, deliberately. In this database `postgres` holds its
-- `connector_runner` membership with `set_option = false`, so the harness cannot SET ROLE into the runner; only the dedicated
-- `connector_runner_login` can. Claiming to exercise the runner role here would be a lie, so the runner's access is asserted with
-- has_function_privilege and the function's LOGIC is exercised as the owner.

begin;

-- ── Fixtures ────────────────────────────────────────────────────────────────────────────────────────────────────────
insert into public.tenants (id, name, slug) values
  ('d0a70000-0000-4000-8000-00000000e001', 'Validation Tenant A', 'validation-tenant-a'),
  ('d0a70000-0000-4000-8000-00000000e002', 'Validation Tenant B', 'validation-tenant-b')
on conflict (id) do nothing;

insert into auth.users (id, email) values
  ('d0a70000-0000-4000-8000-0000000000a1', 'v-owner-a@example.test'),
  ('d0a70000-0000-4000-8000-0000000000a2', 'v-editor-a@example.test'),
  ('d0a70000-0000-4000-8000-0000000000a3', 'v-viewer-a@example.test')
on conflict (id) do nothing;

insert into public.profiles (id, email) values
  ('d0a70000-0000-4000-8000-0000000000a1', 'v-owner-a@example.test'),
  ('d0a70000-0000-4000-8000-0000000000a2', 'v-editor-a@example.test'),
  ('d0a70000-0000-4000-8000-0000000000a3', 'v-viewer-a@example.test')
on conflict (id) do nothing;

insert into public.tenant_memberships (tenant_id, user_id, role) values
  ('d0a70000-0000-4000-8000-00000000e001', 'd0a70000-0000-4000-8000-0000000000a1', 'owner'),
  ('d0a70000-0000-4000-8000-00000000e001', 'd0a70000-0000-4000-8000-0000000000a2', 'editor'),
  ('d0a70000-0000-4000-8000-00000000e001', 'd0a70000-0000-4000-8000-0000000000a3', 'viewer')
on conflict do nothing;

-- The connector + config via the ONLY sanctioned creation path (0063).
select set_config('request.jwt.claims', '{"sub":"d0a70000-0000-4000-8000-0000000000a1"}', false);
set role authenticated;
select public.create_okta_connector_configuration(
  'd0a70000-0000-4000-8000-00000000e001'::uuid,
  'trial-5294016.okta.com', '0oa15fcokefFqDREa698',
  'fe118591fa7bee3d662f3c5ddbac31a8b11968c7b5c4a8fbbf196cb974c7238a',
  '07c3712380ccf1b82150ebaab0757131d4091441bd450e04c5c9265c310dcac0',
  'd0a70000-0000-4000-8000-00000000f001'::uuid, 'Validation Fixture');
reset role;

-- ── V0: grant shape — the runner may execute, every browser role may not ────────────────────────────────────────────
-- `revoke ... from public` alone does NOT achieve this on Supabase: ALTER DEFAULT PRIVILEGES grants EXECUTE on new public
-- functions to anon/authenticated/service_role as EXPLICIT grantees, which a PUBLIC revoke leaves in place. Each must be named.
do $$
declare
  f constant text := 'public.runner_record_okta_connector_validation(uuid,uuid,uuid,text,text,text,text,text,text)';
begin
  assert has_function_privilege('connector_runner', f, 'EXECUTE'), 'V0 connector_runner must hold EXECUTE';
  assert not has_function_privilege('authenticated', f, 'EXECUTE'), 'V0 authenticated must NOT hold EXECUTE';
  assert not has_function_privilege('anon', f, 'EXECUTE'), 'V0 anon must NOT hold EXECUTE';
  assert not has_function_privilege('service_role', f, 'EXECUTE'), 'V0 service_role must NOT hold EXECUTE';
end $$;

-- ── V1: no browser role can assert success (proven by calling) ──────────────────────────────────────────────────────
select set_config('request.jwt.claims', '{"sub":"d0a70000-0000-4000-8000-0000000000a1"}', false);
set role authenticated;
do $$ declare v_connector uuid; begin
  select connector_id into v_connector from public.okta_connector_configs limit 1;
  begin
    perform public.runner_record_okta_connector_validation(
      'd0a70000-0000-4000-8000-00000000e001', v_connector, gen_random_uuid(), 'succeeded',
      'p7AyvDK0yI95_HdQBxdhBSOTt9mMYPczGL-4USxaMto', '1.1.0',
      'fe118591fa7bee3d662f3c5ddbac31a8b11968c7b5c4a8fbbf196cb974c7238a',
      '07c3712380ccf1b82150ebaab0757131d4091441bd450e04c5c9265c310dcac0', null);
    raise exception 'V1 an OWNER must not be able to record a validation result';
  exception when insufficient_privilege then null;
  end;
end $$;
reset role;

select set_config('request.jwt.claims', '{"sub":"d0a70000-0000-4000-8000-0000000000a2"}', false);
set role authenticated;
do $$ declare v_connector uuid; begin
  select connector_id into v_connector from public.okta_connector_configs limit 1;
  begin
    perform public.runner_record_okta_connector_validation(
      'd0a70000-0000-4000-8000-00000000e001', v_connector, gen_random_uuid(), 'succeeded',
      'p7AyvDK0yI95_HdQBxdhBSOTt9mMYPczGL-4USxaMto', '1.1.0',
      'fe118591fa7bee3d662f3c5ddbac31a8b11968c7b5c4a8fbbf196cb974c7238a',
      '07c3712380ccf1b82150ebaab0757131d4091441bd450e04c5c9265c310dcac0', null);
    raise exception 'V1 an EDITOR must not be able to record a validation result';
  exception when insufficient_privilege then null;
  end;
end $$;
reset role;

set role anon;
do $$ begin
  begin
    perform public.runner_record_okta_connector_validation(
      'd0a70000-0000-4000-8000-00000000e001', gen_random_uuid(), gen_random_uuid(), 'succeeded',
      'p7AyvDK0yI95_HdQBxdhBSOTt9mMYPczGL-4USxaMto', '1.1.0',
      'fe118591fa7bee3d662f3c5ddbac31a8b11968c7b5c4a8fbbf196cb974c7238a',
      '07c3712380ccf1b82150ebaab0757131d4091441bd450e04c5c9265c310dcac0', null);
    raise exception 'V1 ANON must not be able to record a validation result';
  exception when insufficient_privilege then null;
  end;
end $$;
reset role;

-- ── V2–V8: the function's logic, exercised as the owner ─────────────────────────────────────────────────────────────
do $$
declare
  v_connector uuid; v_run uuid; v_run2 uuid; v_res jsonb; v_n int; v_status text; v_ts timestamptz;
  KID constant text := 'p7AyvDK0yI95_HdQBxdhBSOTt9mMYPczGL-4USxaMto';
  FPO constant text := 'fe118591fa7bee3d662f3c5ddbac31a8b11968c7b5c4a8fbbf196cb974c7238a';
  FPS constant text := '07c3712380ccf1b82150ebaab0757131d4091441bd450e04c5c9265c310dcac0';
  TA  constant uuid := 'd0a70000-0000-4000-8000-00000000e001';
  TB  constant uuid := 'd0a70000-0000-4000-8000-00000000e002';
begin
  select connector_id into v_connector from public.okta_connector_configs where tenant_id = TA;

  -- Nothing in V1 changed anything.
  select validation_status into v_status from public.okta_connector_configs where connector_id = v_connector;
  assert v_status = 'never_validated', 'V1 a refused call must not change state, saw ' || v_status;

  v_run  := public.runner_open_connector_run(TA, v_connector);
  v_run2 := public.runner_open_connector_run(TA, v_connector);

  -- V2: a well-formed result is recorded.
  v_res := public.runner_record_okta_connector_validation(TA, v_connector, v_run, 'succeeded', KID, '1.2.0', FPO, FPS, null);
  assert v_res->>'outcome' = 'recorded', 'V2 expected recorded, got ' || (v_res->>'outcome');
  assert v_res->>'validation_status' = 'succeeded', 'V2 status';
  assert v_res->>'verified_kid' = KID, 'V2 kid';
  assert v_res->>'verified_contract_version' = '1.2.0', 'V2 contract version';

  select connection_state into v_status from public.connectors where id = v_connector;
  assert v_status = 'verified', 'V2 connector must become verified, saw ' || v_status;

  -- ...and NOTHING beyond verified. One authenticated read is not a working integration.
  select status into v_status from public.connectors where id = v_connector;
  assert v_status = 'pending', 'V2 status must stay pending, saw ' || v_status;
  select count(*) into v_n from public.okta_connector_configs
    where connector_id = v_connector and certification_only = true and production_enabled = false;
  assert v_n = 1, 'V2 governance flags must be preserved';

  -- V3: audit exactly once, precise action, no credential material.
  select count(*) into v_n from public.audit_logs
    where tenant_id = TA and action = 'okta_connector_validation_succeeded';
  assert v_n = 1, 'V3 expected exactly one success audit, saw ' || v_n;
  select count(*) into v_n from public.audit_logs
    where tenant_id = TA and after_json::text ~* '(bearer |eyJ|-----BEGIN|access_token|assertion|signature)';
  assert v_n = 0, 'V3 audit must carry no credential material, saw ' || v_n;

  -- V4: idempotent replay — no second transition, no second audit, no timestamp drift.
  select last_validated_at into v_ts from public.okta_connector_configs where connector_id = v_connector;
  v_res := public.runner_record_okta_connector_validation(TA, v_connector, v_run, 'succeeded', KID, '1.2.0', FPO, FPS, null);
  assert v_res->>'outcome' = 'idempotent_replay', 'V4 expected idempotent_replay, got ' || (v_res->>'outcome');
  select count(*) into v_n from public.audit_logs
    where tenant_id = TA and action = 'okta_connector_validation_succeeded';
  assert v_n = 1, 'V4 replay must not emit a second success audit, saw ' || v_n;
  select count(*) into v_n from public.okta_connector_configs
    where connector_id = v_connector and last_validated_at = v_ts;
  assert v_n = 1, 'V4 replay must not move last_validated_at';

  -- V5: a stale/late failure cannot demote an established success.
  begin
    perform public.runner_record_okta_connector_validation(TA, v_connector, v_run2, 'failed', KID, '1.2.0', null, null, 'invalid_client');
    raise exception 'V5 a failed result must not demote a succeeded validation';
  exception when sqlstate '22023' then null;
  end;
  select validation_status into v_status from public.okta_connector_configs where connector_id = v_connector;
  assert v_status = 'succeeded', 'V5 status must remain succeeded, saw ' || v_status;

  -- V6: pinned and bounded inputs are refused.
  begin
    perform public.runner_record_okta_connector_validation(TA, v_connector, v_run2, 'succeeded',
      'VDkZAQoJl_prLRU83WiPreOBGoP6Fib3qC0CG880wz0', '1.2.0', FPO, FPS, null);
    raise exception 'V6 a superseded KID must be refused';
  exception when sqlstate '22023' then null; end;

  begin
    -- 1.1.0 is now the SUPERSEDED version: 0065 moved the pin to 1.2.0 alongside the contract artifact.
    perform public.runner_record_okta_connector_validation(TA, v_connector, v_run2, 'succeeded', KID, '1.1.0', FPO, FPS, null);
    raise exception 'V6 a superseded contract version must be refused';
  exception when sqlstate '22023' then null; end;

  begin
    perform public.runner_record_okta_connector_validation(TA, v_connector, v_run2, 'succeeded', KID, '1.2.0', 'not-a-fingerprint', FPS, null);
    raise exception 'V6 a malformed fingerprint must be refused';
  exception when sqlstate '22023' then null; end;

  begin
    perform public.runner_record_okta_connector_validation(TA, v_connector, v_run2, 'healthy', KID, '1.2.0', FPO, FPS, null);
    raise exception 'V6 an out-of-vocabulary outcome must be refused';
  exception when sqlstate '22023' then null; end;

  begin
    perform public.runner_record_okta_connector_validation(TA, v_connector, gen_random_uuid(), 'succeeded', KID, '1.2.0', FPO, FPS, null);
    raise exception 'V6 a forged run id must be refused';
  exception when insufficient_privilege then null; end;

  begin
    perform public.runner_record_okta_connector_validation(TB, v_connector, v_run2, 'succeeded', KID, '1.2.0', FPO, FPS, null);
    raise exception 'V6 a cross-tenant result must be refused';
  exception when insufficient_privilege then null; end;

  -- V7: the pinned-KID CHECK is an INDEPENDENT enforcement point — it holds against a direct owner UPDATE.
  begin
    update public.okta_connector_configs set signing_key_id = 'VDkZAQoJl_prLRU83WiPreOBGoP6Fib3qC0CG880wz0'
      where connector_id = v_connector;
    raise exception 'V7 the pinned KID CHECK must reject a superseded KID even for the owner';
  exception when check_violation then null;
  end;

  -- V8: a succeeded row cannot survive losing its evidence.
  begin
    update public.okta_connector_configs set verified_service_app_fingerprint = null where connector_id = v_connector;
    raise exception 'V8 a succeeded row must not survive losing its evidence';
  exception when check_violation then null;
  end;
end $$;

-- ── V9: a request role still cannot write or delete this table directly ─────────────────────────────────────────────
select set_config('request.jwt.claims', '{"sub":"d0a70000-0000-4000-8000-0000000000a1"}', false);
set role authenticated;
do $$ declare n int; begin
  -- Hardened by BOTH an absent write grant (42501) and RLS with no write policy (zero rows). Accept either.
  begin
    update public.okta_connector_configs set validation_status = 'succeeded';
    get diagnostics n = row_count;
    assert n = 0, 'V9 direct UPDATE must affect zero rows, affected ' || n;
  exception when insufficient_privilege then null;
  end;
  begin
    delete from public.okta_connector_configs;
    get diagnostics n = row_count;
    assert n = 0, 'V9 direct DELETE must affect zero rows, affected ' || n;
  exception when insufficient_privilege then null;
  end;
end $$;
reset role;

select 'ALL O2C.2 VALIDATION-RESULT ASSERTIONS PASSED' as result;

rollback;
