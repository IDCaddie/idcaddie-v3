-- 0092 — GWS-E4a: the Google Workspace validation-result write path.
--
-- The load-bearing property is NEGATIVE: no browser role, at any privilege level, can assert that validation succeeded,
-- and therefore no browser role can reach `verified`. That is proven by CALLING the function as each of those roles and
-- requiring a privilege error — not by reading a grant table.
--
-- The POSITIVE side is asserted by grant shape rather than by execution, deliberately. In this database `postgres` holds
-- its `connector_runner` membership with `set_option = false`, so the harness cannot SET ROLE into the runner; only the
-- dedicated `connector_runner_login` can. Claiming to exercise the runner role here would be a lie, so the runner's
-- access is asserted with has_function_privilege and the function's LOGIC is exercised as the owner.
--
-- There is no sanctioned creation RPC for a Google connector (GWS-E4b is an authorized service_role write), so the
-- fixture inserts the connector row directly AS THE OWNER at `connection_state = 'configured'` — which is exactly the
-- shape that write takes, and which G9 below proves no request role can perform.

begin;

-- ── Fixtures ────────────────────────────────────────────────────────────────────────────────────────────────────────
insert into public.tenants (id, name, slug) values
  ('9a570000-0000-4000-8000-00000000e001', 'GWS Tenant A', 'gws-tenant-a'),
  ('9a570000-0000-4000-8000-00000000e002', 'GWS Tenant B', 'gws-tenant-b')
on conflict (id) do nothing;

insert into auth.users (id, email) values
  ('9a570000-0000-4000-8000-0000000000a1', 'gws-owner-a@example.test'),
  ('9a570000-0000-4000-8000-0000000000a2', 'gws-editor-a@example.test'),
  ('9a570000-0000-4000-8000-0000000000a3', 'gws-viewer-a@example.test')
on conflict (id) do nothing;

insert into public.profiles (id, email) values
  ('9a570000-0000-4000-8000-0000000000a1', 'gws-owner-a@example.test'),
  ('9a570000-0000-4000-8000-0000000000a2', 'gws-editor-a@example.test'),
  ('9a570000-0000-4000-8000-0000000000a3', 'gws-viewer-a@example.test')
on conflict (id) do nothing;

insert into public.tenant_memberships (tenant_id, user_id, role) values
  ('9a570000-0000-4000-8000-00000000e001', '9a570000-0000-4000-8000-0000000000a1', 'owner'),
  ('9a570000-0000-4000-8000-00000000e001', '9a570000-0000-4000-8000-0000000000a2', 'editor'),
  ('9a570000-0000-4000-8000-00000000e001', '9a570000-0000-4000-8000-0000000000a3', 'viewer')
on conflict do nothing;

-- The Google connector at `configured` (GWS-E4b's shape), plus an OKTA connector in the same tenant used to prove the
-- provider gate, and a second-tenant Google connector used to prove cross-tenant refusal.
insert into public.connectors (id, tenant_id, provider, display_name, status, connection_state, granted_scopes_safe) values
  ('9a570000-0000-4000-8000-00000000c001', '9a570000-0000-4000-8000-00000000e001', 'google_workspace', 'Google Workspace', 'pending', 'configured',
    array['https://www.googleapis.com/auth/admin.directory.user.readonly',
          'https://www.googleapis.com/auth/admin.directory.group.readonly',
          'https://www.googleapis.com/auth/admin.directory.group.member.readonly',
          'https://www.googleapis.com/auth/apps.licensing']::text[]),
  ('9a570000-0000-4000-8000-00000000c002', '9a570000-0000-4000-8000-00000000e001', 'okta', 'Okta', 'pending', 'configured', null),
  ('9a570000-0000-4000-8000-00000000c003', '9a570000-0000-4000-8000-00000000e002', 'google_workspace', 'Google Workspace B', 'pending', 'configured', null)
on conflict (id) do nothing;

-- ── G0: grant shape — the runner may execute, every browser role may not ────────────────────────────────────────────
-- `revoke ... from public` alone does NOT achieve this on Supabase: ALTER DEFAULT PRIVILEGES grants EXECUTE on new
-- public functions to anon/authenticated/service_role as EXPLICIT grantees, which a PUBLIC revoke leaves in place.
do $$
declare
  f constant text := 'public.runner_record_google_workspace_validation(uuid,uuid,uuid,text,text,text,text,text,text)';
begin
  assert has_function_privilege('connector_runner', f, 'EXECUTE'), 'G0 connector_runner must hold EXECUTE';
  assert not has_function_privilege('authenticated', f, 'EXECUTE'), 'G0 authenticated must NOT hold EXECUTE';
  assert not has_function_privilege('anon', f, 'EXECUTE'), 'G0 anon must NOT hold EXECUTE';
  assert not has_function_privilege('service_role', f, 'EXECUTE'), 'G0 service_role must NOT hold EXECUTE';

  -- The evidence table is deny-all: not even the runner may touch it directly. The definer function is the only way in.
  assert not has_table_privilege('authenticated', 'public.google_workspace_connector_validations', 'SELECT'),
    'G0 authenticated must NOT read the evidence table';
  assert not has_table_privilege('anon', 'public.google_workspace_connector_validations', 'SELECT'),
    'G0 anon must NOT read the evidence table';
  assert not has_table_privilege('connector_runner', 'public.google_workspace_connector_validations', 'SELECT'),
    'G0 connector_runner must NOT read the evidence table directly';
  assert not has_table_privilege('connector_runner', 'public.google_workspace_connector_validations', 'INSERT'),
    'G0 connector_runner must NOT write the evidence table directly';
end $$;

-- ── G1: no browser role can assert success (proven by calling, at three privilege levels) ───────────────────────────
select set_config('request.jwt.claims', '{"sub":"9a570000-0000-4000-8000-0000000000a1"}', false);
set role authenticated;
do $$ begin
  begin
    perform public.runner_record_google_workspace_validation(
      '9a570000-0000-4000-8000-00000000e001', '9a570000-0000-4000-8000-00000000c001', gen_random_uuid(), 'succeeded',
      'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678', '1.0.0',
      repeat('a', 64), repeat('b', 64), null);
    raise exception 'G1 an OWNER must not be able to record a validation result';
  exception when insufficient_privilege then null;
  end;
end $$;
reset role;

select set_config('request.jwt.claims', '{"sub":"9a570000-0000-4000-8000-0000000000a2"}', false);
set role authenticated;
do $$ begin
  begin
    perform public.runner_record_google_workspace_validation(
      '9a570000-0000-4000-8000-00000000e001', '9a570000-0000-4000-8000-00000000c001', gen_random_uuid(), 'succeeded',
      'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678', '1.0.0', repeat('a', 64), repeat('b', 64), null);
    raise exception 'G1 an EDITOR must not be able to record a validation result';
  exception when insufficient_privilege then null;
  end;
end $$;
reset role;

set role anon;
do $$ begin
  begin
    perform public.runner_record_google_workspace_validation(
      '9a570000-0000-4000-8000-00000000e001', '9a570000-0000-4000-8000-00000000c001', gen_random_uuid(), 'succeeded',
      'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678', '1.0.0', repeat('a', 64), repeat('b', 64), null);
    raise exception 'G1 ANON must not be able to record a validation result';
  exception when insufficient_privilege then null;
  end;
end $$;
reset role;

-- G1b: service_role is a DIRECT grantee of Supabase's default privileges, so it is named explicitly in the revoke and
-- must be proven refused by call, not only by grant shape.
set role service_role;
do $$ begin
  begin
    perform public.runner_record_google_workspace_validation(
      '9a570000-0000-4000-8000-00000000e001', '9a570000-0000-4000-8000-00000000c001', gen_random_uuid(), 'succeeded',
      'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678', '1.0.0', repeat('a', 64), repeat('b', 64), null);
    raise exception 'G1b SERVICE_ROLE must not be able to record a validation result';
  exception when insufficient_privilege then null;
  end;
end $$;
reset role;

-- ── G2–G8: the function's logic, exercised as the owner ─────────────────────────────────────────────────────────────
do $$
declare
  v_run uuid; v_run2 uuid; v_run3 uuid; v_runB uuid; v_res jsonb; v_n int; v_status text; v_ts timestamptz;
  KID  constant text := 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';
  FPC  constant text := 'c58ad1ce5a1b6e0e4f2fd1f0e9d8c7b6a594837261504f3e2d1c0b9a8f7e6d5c';
  FPS  constant text := '1f0e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c4b5a69788796a5b4c3d2e1f0';
  TA   constant uuid := '9a570000-0000-4000-8000-00000000e001';
  TB   constant uuid := '9a570000-0000-4000-8000-00000000e002';
  CG   constant uuid := '9a570000-0000-4000-8000-00000000c001';  -- google, tenant A
  CO   constant uuid := '9a570000-0000-4000-8000-00000000c002';  -- okta,   tenant A
  CB   constant uuid := '9a570000-0000-4000-8000-00000000c003';  -- google, tenant B
begin
  -- Nothing in G1 changed anything: no evidence row, and the connector is untouched.
  select count(*) into v_n from public.google_workspace_connector_validations where connector_id = CG;
  assert v_n = 0, 'G1 a refused call must create no evidence row, saw ' || v_n;
  select connection_state into v_status from public.connectors where id = CG;
  assert v_status = 'configured', 'G1 a refused call must not advance state, saw ' || v_status;

  v_run  := public.runner_open_connector_run(TA, CG);
  v_run2 := public.runner_open_connector_run(TA, CG);
  v_run3 := public.runner_open_connector_run(TA, CG);
  v_runB := public.runner_open_connector_run(TB, CB);

  -- ── G2: a FAILED result is recorded and does NOT advance state ────────────────────────────────────────────────────
  v_res := public.runner_record_google_workspace_validation(TA, CG, v_run, 'failed', KID, '1.0.0', null, null, 'delegation_not_granted');
  assert v_res->>'outcome' = 'recorded', 'G2 expected recorded, got ' || (v_res->>'outcome');
  assert v_res->>'validation_status' = 'failed', 'G2 status';
  assert v_res->>'validation_error_category' = 'delegation_not_granted', 'G2 category';
  select connection_state into v_status from public.connectors where id = CG;
  assert v_status = 'configured', 'G2 a FAILED validation must not advance state, saw ' || v_status;
  -- and it carries no evidence it did not earn
  select count(*) into v_n from public.google_workspace_connector_validations
    where connector_id = CG and verified_kid is null and validation_run_id is null and last_validated_at is null;
  assert v_n = 1, 'G2 a failed row must carry no evidence fields';

  -- ── G3: a well-formed SUCCESS is recorded and earns `verified` ────────────────────────────────────────────────────
  v_res := public.runner_record_google_workspace_validation(TA, CG, v_run2, 'succeeded', KID, '1.0.0', FPC, FPS, null);
  assert v_res->>'outcome' = 'recorded', 'G3 expected recorded, got ' || (v_res->>'outcome');
  assert v_res->>'validation_status' = 'succeeded', 'G3 status';
  assert v_res->>'verified_kid' = KID, 'G3 kid';
  assert v_res->>'verified_contract_version' = '1.0.0', 'G3 contract version';
  assert (v_res->>'validation_run_id')::uuid = v_run2, 'G3 run id';

  select connection_state into v_status from public.connectors where id = CG;
  assert v_status = 'verified', 'G3 connector must become verified, saw ' || v_status;

  -- ...and NOTHING beyond verified. One successful authentication is not a working integration.
  select status into v_status from public.connectors where id = CG;
  assert v_status = 'pending', 'G3 status must stay pending, saw ' || v_status;
  select count(*) into v_n from public.connectors where id = CG and last_sync_at is null;
  assert v_n = 1, 'G3 last_sync_at must stay null';

  -- The failure category is cleared by the success that supersedes it.
  select count(*) into v_n from public.google_workspace_connector_validations
    where connector_id = CG and validation_error_category is null;
  assert v_n = 1, 'G3 a superseding success must clear the error category';

  -- ── G4: audit exactly once, precise action, no credential material ────────────────────────────────────────────────
  select count(*) into v_n from public.audit_logs
    where tenant_id = TA and action = 'google_workspace_connector_validation_succeeded';
  assert v_n = 1, 'G4 expected exactly one success audit, saw ' || v_n;
  select count(*) into v_n from public.audit_logs
    where tenant_id = TA and action = 'google_workspace_connector_validation_failed';
  assert v_n = 1, 'G4 expected exactly one failure audit, saw ' || v_n;
  select count(*) into v_n from public.audit_logs
    where tenant_id = TA and after_json::text ~* '(bearer |eyJ|-----BEGIN|access_token|assertion|signature|private)';
  assert v_n = 0, 'G4 audit must carry no credential material, saw ' || v_n;

  -- ── G5: idempotent replay — no second transition, no second audit, no timestamp drift ─────────────────────────────
  select last_validated_at into v_ts from public.google_workspace_connector_validations where connector_id = CG;
  v_res := public.runner_record_google_workspace_validation(TA, CG, v_run2, 'succeeded', KID, '1.0.0', FPC, FPS, null);
  assert v_res->>'outcome' = 'idempotent_replay', 'G5 expected idempotent_replay, got ' || (v_res->>'outcome');
  select count(*) into v_n from public.audit_logs
    where tenant_id = TA and action = 'google_workspace_connector_validation_succeeded';
  assert v_n = 1, 'G5 replay must not emit a second success audit, saw ' || v_n;
  select count(*) into v_n from public.google_workspace_connector_validations
    where connector_id = CG and last_validated_at = v_ts;
  assert v_n = 1, 'G5 replay must not move last_validated_at';

  -- ── G6: a stale/late failure cannot demote an established success ─────────────────────────────────────────────────
  begin
    perform public.runner_record_google_workspace_validation(TA, CG, v_run3, 'failed', KID, '1.0.0', null, null, 'invalid_client');
    raise exception 'G6 a failed result must not demote a succeeded validation';
  exception when sqlstate '22023' then null;
  end;
  select validation_status into v_status from public.google_workspace_connector_validations where connector_id = CG;
  assert v_status = 'succeeded', 'G6 status must remain succeeded, saw ' || v_status;

  -- ── G7: THE START-STATE GATE — a connector already `verified` cannot be re-verified ───────────────────────────────
  -- This is also what makes a hand-set `verified` useless: evidence can never be attached to it afterwards.
  begin
    perform public.runner_record_google_workspace_validation(TA, CG, v_run3, 'succeeded', KID, '1.0.0', FPC, FPS, null);
    raise exception 'G7 a connector that is already verified must not accept a second validation';
  exception when sqlstate '22023' then null;
  end;

  -- ── G8: bounded and pinned inputs are refused ─────────────────────────────────────────────────────────────────────
  begin
    perform public.runner_record_google_workspace_validation(TB, CB, v_runB, 'succeeded', KID, '2.0.0', FPC, FPS, null);
    raise exception 'G8 a mismatched contract version must be refused';
  exception when sqlstate '22023' then null; end;

  begin
    perform public.runner_record_google_workspace_validation(TB, CB, v_runB, 'succeeded', KID, '1.0.0', 'not-a-fingerprint', FPS, null);
    raise exception 'G8 a malformed fingerprint must be refused';
  exception when sqlstate '22023' then null; end;

  begin
    perform public.runner_record_google_workspace_validation(TB, CB, v_runB, 'healthy', KID, '1.0.0', FPC, FPS, null);
    raise exception 'G8 an out-of-vocabulary outcome must be refused';
  exception when sqlstate '22023' then null; end;

  begin
    perform public.runner_record_google_workspace_validation(TB, CB, v_runB, 'succeeded', null, '1.0.0', FPC, FPS, null);
    raise exception 'G8 a success with no verified kid must be refused';
  exception when sqlstate '22023' then null; end;

  begin
    perform public.runner_record_google_workspace_validation(TB, CB, v_runB, 'succeeded', KID, '1.0.0', FPC, FPS, 'invalid_client');
    raise exception 'G8 a success carrying an error category must be refused';
  exception when sqlstate '22023' then null; end;

  begin
    perform public.runner_record_google_workspace_validation(TB, CB, v_runB, 'failed', KID, '1.0.0', FPC, FPS, 'invalid_client');
    raise exception 'G8 a failure carrying a fingerprint must be refused';
  exception when sqlstate '22023' then null; end;

  begin
    perform public.runner_record_google_workspace_validation(TB, CB, v_runB, 'failed', KID, '1.0.0', null, null, null);
    raise exception 'G8 a failure with no error category must be refused';
  exception when sqlstate '22023' then null; end;

  begin
    perform public.runner_record_google_workspace_validation(TB, CB, v_runB, 'failed', KID, '1.0.0', null, null, 'made_up_category');
    raise exception 'G8 an out-of-vocabulary error category must be refused';
  exception when check_violation then null; end;

  -- a forged run id
  begin
    perform public.runner_record_google_workspace_validation(TB, CB, gen_random_uuid(), 'succeeded', KID, '1.0.0', FPC, FPS, null);
    raise exception 'G8 a forged run id must be refused';
  exception when insufficient_privilege then null; end;

  -- CROSS-TENANT: tenant A claiming tenant B's connector, and B's run against A's connector
  begin
    perform public.runner_record_google_workspace_validation(TA, CB, v_runB, 'succeeded', KID, '1.0.0', FPC, FPS, null);
    raise exception 'G8 a cross-tenant result must be refused';
  exception when insufficient_privilege then null; end;

  -- WRONG PROVIDER: the Okta connector in the SAME tenant, with a run that genuinely belongs to it
  declare v_okta_run uuid;
  begin
    v_okta_run := public.runner_open_connector_run(TA, CO);
    begin
      perform public.runner_record_google_workspace_validation(TA, CO, v_okta_run, 'succeeded', KID, '1.0.0', FPC, FPS, null);
      raise exception 'G8 an OKTA connector must not accept a google_workspace validation';
    exception when insufficient_privilege then null; end;
    -- and the Okta connector is untouched by the attempt
    select connection_state into v_status from public.connectors where id = CO;
    assert v_status = 'configured', 'G8 the okta connector must be untouched, saw ' || v_status;
  end;

  -- ── G9: ABSENT EVIDENCE CANNOT CREATE VERIFIED TRUTH ──────────────────────────────────────────────────────────────
  -- The CHECK pair holds against a direct OWNER update, independently of the function.
  begin
    update public.google_workspace_connector_validations set verified_service_account_fingerprint = null where connector_id = CG;
    raise exception 'G9 a succeeded row must not survive losing its evidence';
  exception when check_violation then null;
  end;
  begin
    update public.google_workspace_connector_validations set verified_kid = null where connector_id = CG;
    raise exception 'G9 a succeeded row must not survive losing its kid';
  exception when check_violation then null;
  end;
  -- and the complement: evidence cannot be attached to a row that did not succeed
  begin
    update public.google_workspace_connector_validations
       set validation_status = 'never_validated', verified_kid = KID, validation_run_id = v_run2
     where connector_id = CG;
    raise exception 'G9 evidence must not appear without success';
  exception when check_violation then null;
  end;
  -- nor a category attached to a success
  begin
    update public.google_workspace_connector_validations set validation_error_category = 'invalid_client' where connector_id = CG;
    raise exception 'G9 an error category must not attach to a succeeded row';
  exception when check_violation then null;
  end;
end $$;

-- ── G10: the generic lifecycle machine still offers NO route to verified ────────────────────────────────────────────
-- If `('configured','verified')` were ever added to 0052's allowlist, this function would stop being the only route and
-- every guard above could be walked around.
do $$
declare v_state text; v_refused boolean := false;
begin
  begin
    perform public.runner_advance_connection_state(
      '9a570000-0000-4000-8000-00000000c003', '9a570000-0000-4000-8000-00000000e002', 'configured', 'verified');
  exception when others then v_refused := true;
  end;
  assert v_refused, 'G10 runner_advance_connection_state must offer no configured -> verified route';
  select connection_state into v_state from public.connectors where id = '9a570000-0000-4000-8000-00000000c003';
  assert v_state = 'configured', 'G10 the connector must remain configured, saw ' || v_state;
end $$;

-- ── G11: a request role still cannot write connectors or the evidence table directly ────────────────────────────────
-- This is what "manual/direct verified bypass" means at the request layer, and what makes GWS-E4b a service_role-only
-- action rather than something the product can do.
select set_config('request.jwt.claims', '{"sub":"9a570000-0000-4000-8000-0000000000a1"}', false);
set role authenticated;
do $$ declare n int; begin
  -- Hardened by BOTH an absent write grant (42501) and RLS with no write policy (zero rows). Accept either.
  begin
    update public.connectors set connection_state = 'verified' where provider = 'google_workspace';
    get diagnostics n = row_count;
    assert n = 0, 'G11 a request role must not set verified, affected ' || n;
  exception when insufficient_privilege then null;
  end;
  begin
    insert into public.connectors (tenant_id, provider, display_name, status, connection_state)
      values ('9a570000-0000-4000-8000-00000000e001', 'google_workspace', 'Forged', 'pending', 'verified');
    raise exception 'G11 a request role must not insert a connector row';
  exception when insufficient_privilege then null;
  end;
  begin
    update public.google_workspace_connector_validations set validation_status = 'succeeded';
    get diagnostics n = row_count;
    assert n = 0, 'G11 direct UPDATE of the evidence table must affect zero rows, affected ' || n;
  exception when insufficient_privilege then null;
  end;
  begin
    delete from public.google_workspace_connector_validations;
    get diagnostics n = row_count;
    assert n = 0, 'G11 direct DELETE of the evidence table must affect zero rows, affected ' || n;
  exception when insufficient_privilege then null;
  end;
end $$;
reset role;

select 'ALL GWS-E4a VALIDATION-BOUNDARY ASSERTIONS PASSED' as result;

rollback;
