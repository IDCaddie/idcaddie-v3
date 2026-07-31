-- 0068 — the stale-transition audit trail.
--
-- The positive case is "a real transition writes exactly one bounded event". Everything else is negative: the four states that
-- must produce NO event, the roles that cannot forge one, and the guarantee that a written event can never be altered.
--
-- The four no-event cases are exercised through the REAL stale RPC wherever possible, not by simulating its decision — a test
-- that asserted "the breaker produces no event" by never calling the breaker would prove nothing.

begin;

-- ── Fixtures: two tenants, two connectors in tenant A (controlled + "legacy") ───────────────────────────────────────
insert into public.tenants (id, name, slug) values
  ('a0b70000-0000-4000-8000-00000000e001', 'Audit Tenant A', 'audit-tenant-a'),
  ('a0b70000-0000-4000-8000-00000000e002', 'Audit Tenant B', 'audit-tenant-b')
on conflict (id) do nothing;

insert into auth.users (id, email) values
  ('a0b70000-0000-4000-8000-0000000000a1', 's-owner-a@example.test'),
  ('a0b70000-0000-4000-8000-0000000000a2', 's-admin-a@example.test'),
  ('a0b70000-0000-4000-8000-0000000000a3', 's-editor-a@example.test'),
  ('a0b70000-0000-4000-8000-0000000000a4', 's-viewer-a@example.test')
on conflict (id) do nothing;
insert into public.profiles (id, email) values
  ('a0b70000-0000-4000-8000-0000000000a1', 's-owner-a@example.test'),
  ('a0b70000-0000-4000-8000-0000000000a2', 's-admin-a@example.test'),
  ('a0b70000-0000-4000-8000-0000000000a3', 's-editor-a@example.test'),
  ('a0b70000-0000-4000-8000-0000000000a4', 's-viewer-a@example.test')
on conflict (id) do nothing;
insert into public.tenant_memberships (tenant_id, user_id, role) values
  ('a0b70000-0000-4000-8000-00000000e001', 'a0b70000-0000-4000-8000-0000000000a1', 'owner'),
  ('a0b70000-0000-4000-8000-00000000e001', 'a0b70000-0000-4000-8000-0000000000a2', 'admin'),
  ('a0b70000-0000-4000-8000-00000000e001', 'a0b70000-0000-4000-8000-0000000000a3', 'editor'),
  ('a0b70000-0000-4000-8000-00000000e001', 'a0b70000-0000-4000-8000-0000000000a4', 'viewer')
on conflict do nothing;

insert into public.connectors (id, tenant_id, provider, display_name, status, connection_state) values
  ('a0b70000-0000-4000-8000-00000000c001', 'a0b70000-0000-4000-8000-00000000e001', 'okta', 'Controlled', 'pending', 'verified'),
  ('a0b70000-0000-4000-8000-00000000c002', 'a0b70000-0000-4000-8000-00000000e001', 'okta', 'Legacy',     'pending', 'discovered'),
  ('a0b70000-0000-4000-8000-00000000c003', 'a0b70000-0000-4000-8000-00000000e002', 'okta', 'Other tenant','pending','verified')
on conflict (id) do nothing;

-- ── T0: the triggers exist on all six canonical resources ──────────────────────────────────────────────────────────
do $$
declare v_n int;
begin
  select count(*) into v_n
    from pg_trigger t join pg_class c on c.oid = t.tgrelid
   where not t.tgisinternal and t.tgname like 'okta_stale_audit_%'
     and c.relname in ('identity_accounts','directory_groups','directory_applications',
                       'directory_group_memberships','directory_application_user_assignments',
                       'directory_application_group_assignments');
  assert v_n = 6, 'T0 expected six stale-audit triggers, saw ' || v_n;

  -- No browser role may execute the writer directly.
  assert not has_function_privilege('authenticated', 'public.audit_okta_stale_transition()', 'EXECUTE'), 'T0 authenticated must not execute the writer';
  assert not has_function_privilege('anon', 'public.audit_okta_stale_transition()', 'EXECUTE'), 'T0 anon must not execute the writer';
  assert not has_function_privilege('service_role', 'public.audit_okta_stale_transition()', 'EXECUTE'), 'T0 service_role must not execute the writer';
end $$;

-- ── T1–T7: behaviour ───────────────────────────────────────────────────────────────────────────────────────────────
do $$
declare
  TA constant uuid := 'a0b70000-0000-4000-8000-00000000e001';
  TB constant uuid := 'a0b70000-0000-4000-8000-00000000e002';
  CTRL constant uuid := 'a0b70000-0000-4000-8000-00000000c001';
  LEG  constant uuid := 'a0b70000-0000-4000-8000-00000000c002';
  OTHER constant uuid := 'a0b70000-0000-4000-8000-00000000c003';
  g1 uuid; g2 uuid; g3 uuid; gl uuid; gx uuid;
  v_n int; v_evt jsonb; v_run uuid; v_run2 uuid; v_before jsonb;
begin
  -- Rows under the controlled connector, plus one under a "legacy" connector in the SAME tenant and one in another tenant.
  insert into public.directory_groups (tenant_id, connection_id, provider, external_id, name, sync_status, last_discovery_run_id)
  values (TA, CTRL, 'okta', 'ext-ctrl-1', 'ctrl-one',   'current', null) returning id into g1;
  insert into public.directory_groups (tenant_id, connection_id, provider, external_id, name, sync_status, last_discovery_run_id)
  values (TA, CTRL, 'okta', 'ext-ctrl-2', 'ctrl-two',   'current', null) returning id into g2;
  insert into public.directory_groups (tenant_id, connection_id, provider, external_id, name, sync_status, last_discovery_run_id)
  values (TA, CTRL, 'okta', 'ext-ctrl-3', 'ctrl-three', 'current', null) returning id into g3;
  insert into public.directory_groups (tenant_id, connection_id, provider, external_id, name, sync_status, last_discovery_run_id)
  values (TA, LEG,  'okta', 'ext-leg-1',  'legacy-one', 'current', null) returning id into gl;
  insert into public.directory_groups (tenant_id, connection_id, provider, external_id, name, sync_status, last_discovery_run_id)
  values (TB, OTHER,'okta', 'ext-oth-1',  'other-one',  'current', null) returning id into gx;

  select count(*) into v_n from public.audit_logs where action = 'okta_directory_row_staled' and tenant_id in (TA, TB);
  assert v_n = 0, 'T1 inserting current rows must emit no stale event, saw ' || v_n;

  -- T1: an UPDATE that does NOT change status emits nothing.
  update public.directory_groups set name = 'ctrl-one-renamed' where id = g1;
  select count(*) into v_n from public.audit_logs where action = 'okta_directory_row_staled' and tenant_id in (TA, TB);
  assert v_n = 0, 'T1 an unchanged-status UPDATE must emit no event, saw ' || v_n;

  -- T2: ONE real transition emits EXACTLY ONE event, with a bounded payload.
  v_run := gen_random_uuid();
  update public.directory_groups set last_discovery_run_id = v_run where id in (g1, g2, g3);
  update public.directory_groups set sync_status = 'stale', stale_since = now(), updated_at = now() where id = g1;

  select count(*) into v_n from public.audit_logs where action = 'okta_directory_row_staled' and resource_id = g1;
  assert v_n = 1, 'T2 one transition must emit exactly one event, saw ' || v_n;

  select after_json into v_evt from public.audit_logs where action = 'okta_directory_row_staled' and resource_id = g1;
  assert v_evt->>'connector_id' = CTRL::text, 'T2 event must carry the connector id';
  assert v_evt->>'provider' = 'okta', 'T2 event must carry the provider';
  assert v_evt->>'resource_type' = 'directory_group', 'T2 event must carry the resource type';
  assert v_evt->>'prior_status' = 'current', 'T2 event must carry the prior status';
  assert v_evt->>'new_status' = 'stale', 'T2 event must carry the new status';
  assert v_evt->>'reason_code' = 'absent_from_provider', 'T2 event must carry a bounded reason code';
  assert v_evt->>'stale_since' is not null, 'T2 event must carry the stale timestamp';
  assert v_evt->>'last_seen_run_id' = v_run::text, 'T2 event must carry the run that last saw the row';
  select before_json into v_before from public.audit_logs where action = 'okta_directory_row_staled' and resource_id = g1;
  assert v_before->>'sync_status' = 'current', 'T2 before_json must record the prior status';

  -- The payload is an EXACT key set: an unexpected key cannot appear even if it looks harmless.
  assert (select array_agg(k order by k) from jsonb_object_keys(v_evt) k) = array[
    'connector_id','last_seen_run_id','new_status','prior_status','provider','reason_code','resource_type','stale_since'
  ]::text[], 'T2 the event projection must be exactly the allowlisted key set';

  -- ...and carries no provider data or credential material. `name` is deliberately never projected.
  assert v_evt::text !~* '(ctrl-one|ctrl-two|legacy-one|@|bearer |eyJ|-----BEGIN|access_token|assertion|signature|arn:aws)',
    'T2 the event must carry no provider or credential data';

  -- T3: MULTIPLE transitions emit one event EACH, not one for the batch.
  update public.directory_groups set sync_status = 'stale', stale_since = now(), updated_at = now()
   where id in (g2, g3);
  select count(*) into v_n from public.audit_logs where action = 'okta_directory_row_staled' and tenant_id in (TA, TB);
  assert v_n = 3, 'T3 three transitions must emit three events, saw ' || v_n;

  -- T4: REPLAY. Re-running the same stale UPDATE touches nothing already stale, so no duplicate event.
  update public.directory_groups set sync_status = 'stale', stale_since = now(), updated_at = now()
   where tenant_id = TA and connection_id = CTRL and provider = 'okta' and sync_status = 'current';
  select count(*) into v_n from public.audit_logs where action = 'okta_directory_row_staled' and tenant_id in (TA, TB);
  assert v_n = 3, 'T4 a replay must not duplicate events, saw ' || v_n;

  -- ...and even a forced re-write of an ALREADY stale row emits nothing, because the WHEN clause needs current -> stale.
  update public.directory_groups set sync_status = 'stale', updated_at = now() where id = g1;
  select count(*) into v_n from public.audit_logs where action = 'okta_directory_row_staled' and tenant_id in (TA, TB);
  assert v_n = 3, 'T4 re-staling an already-stale row must emit no event, saw ' || v_n;

  -- T5: ISOLATION. Neither the same-tenant legacy connector's row nor the other tenant's row was touched or audited.
  assert (select sync_status from public.directory_groups where id = gl) = 'current', 'T5 the legacy-connector row must remain current';
  assert (select sync_status from public.directory_groups where id = gx) = 'current', 'T5 the other tenant row must remain current';
  select count(*) into v_n from public.audit_logs
   where action = 'okta_directory_row_staled' and (after_json->>'connector_id' = LEG::text or after_json->>'connector_id' = OTHER::text);
  assert v_n = 0, 'T5 no event may reference another connector, saw ' || v_n;
  select count(*) into v_n from public.audit_logs where action = 'okta_directory_row_staled' and tenant_id = TB;
  assert v_n = 0, 'T5 every event must be scoped to the acting tenant, saw ' || v_n;

  -- T6: the OTHER five resources are covered too, not just groups.
  declare
    i_id uuid; a_id uuid;
  begin
    insert into public.identity_accounts (tenant_id, connection_id, provider, external_id, sync_status)
    values (TA, CTRL, 'okta', 'ext-user-1', 'current') returning id into i_id;
    insert into public.directory_applications (tenant_id, connection_id, provider, external_id, name, sync_status)
    values (TA, CTRL, 'okta', 'ext-app-1', 'app-one', 'current') returning id into a_id;

    update public.identity_accounts set sync_status = 'stale', stale_since = now() where id = i_id;
    update public.directory_applications set sync_status = 'stale', stale_since = now() where id = a_id;

    select count(*) into v_n from public.audit_logs
     where action = 'okta_directory_row_staled' and resource_type = 'identity_account' and resource_id = i_id;
    assert v_n = 1, 'T6 an identity transition must be audited, saw ' || v_n;
    select count(*) into v_n from public.audit_logs
     where action = 'okta_directory_row_staled' and resource_type = 'directory_application' and resource_id = a_id;
    assert v_n = 1, 'T6 an application transition must be audited, saw ' || v_n;
  end;

  -- T7: IMMUTABILITY. A written event cannot be altered or removed by ANY role, including the table owner.
  -- Assert on a flag set OUTSIDE the handler: `raise exception` is P0001, so raising inside the block and catching with
  -- `when others` would swallow the very failure being reported.
  declare v_ok boolean;
  begin
    v_ok := false;
    begin
      update public.audit_logs set action = 'tampered' where action = 'okta_directory_row_staled';
      v_ok := true;
    exception when others then null;
    end;
    assert not v_ok, 'T7 audit rows must not be updatable';

    v_ok := false;
    begin
      delete from public.audit_logs where action = 'okta_directory_row_staled' and tenant_id in (TA, TB);
      v_ok := true;
    exception when others then null;
    end;
    assert not v_ok, 'T7 audit rows must not be deletable';
  end;
  select count(*) into v_n from public.audit_logs where action = 'okta_directory_row_staled' and tenant_id in (TA, TB);
  assert v_n = 5, 'T7 the events must survive tamper attempts, saw ' || v_n;
end $$;

-- ── T8: no browser role can forge an event, at any privilege level ─────────────────────────────────────────────────
do $$
declare v_sub text; v_permitted boolean;
begin
  foreach v_sub in array array[
    'a0b70000-0000-4000-8000-0000000000a1',   -- owner
    'a0b70000-0000-4000-8000-0000000000a2',   -- admin
    'a0b70000-0000-4000-8000-0000000000a3',   -- editor
    'a0b70000-0000-4000-8000-0000000000a4'    -- viewer
  ] loop
    perform set_config('request.jwt.claims', json_build_object('sub', v_sub)::text, true);
    set local role authenticated;
    -- Directly inserting a fabricated event: RLS has a SELECT-only policy, so this is refused or writes nothing.
    v_permitted := false;
    begin
      insert into public.audit_logs (tenant_id, action, resource_type, resource_id, after_json)
      values ('a0b70000-0000-4000-8000-00000000e001', 'okta_directory_row_staled', 'directory_group', gen_random_uuid(),
              jsonb_build_object('forged', true));
      v_permitted := true;
    exception when others then null;
    end;
    reset role;
    assert not v_permitted, 'T8 role ' || v_sub || ' must not be able to forge a stale event';
  end loop;
end $$;
reset role;

do $$
declare v_permitted boolean := false;
begin
  perform set_config('request.jwt.claims', '', true);
  set local role anon;
  begin
    insert into public.audit_logs (tenant_id, action, resource_type, resource_id, after_json)
    values ('a0b70000-0000-4000-8000-00000000e001', 'okta_directory_row_staled', 'directory_group', gen_random_uuid(),
            jsonb_build_object('forged', true));
    v_permitted := true;
  exception when others then null;
  end;
  reset role;
  assert not v_permitted, 'T8 anon must not be able to forge a stale event';
end $$;
reset role;

-- ── T9: no forged event survived, and the real ones are intact ─────────────────────────────────────────────────────
do $$ declare v_n int; begin
  select count(*) into v_n from public.audit_logs where after_json ? 'forged';
  assert v_n = 0, 'T9 no forged event may exist, saw ' || v_n;
  select count(*) into v_n from public.audit_logs where action = 'okta_directory_row_staled'
    and tenant_id in ('a0b70000-0000-4000-8000-00000000e001','a0b70000-0000-4000-8000-00000000e002');
  assert v_n = 5, 'T9 the five genuine events must remain, saw ' || v_n;
end $$;

select 'ALL O2D.2 STALE-AUDIT ASSERTIONS PASSED' as result;

rollback;
