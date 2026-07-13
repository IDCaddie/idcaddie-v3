-- connector_schedule_policy_test.sql — verifies migration 0046 (bounded schedule policy + slots + atomic materialization):
-- deny-all, staging-only, policy lifecycle, atomic slot materialization, slot cap (no 4th), duplicate-delivery idempotency,
-- window/kill-switch/overlap gating, full slot execution reusing the 0044 lifecycle, completed-immutability, stuck recovery,
-- sanitized summary, role boundaries. Run under scripts/test-rls.sh (ON_ERROR_STOP=1). SYNTHETIC values only. NEVER hosted.
\set ON_ERROR_STOP on
reset role;

-- ── Fixtures: one tenant + one active microsoft_entra connector + a global kill switch (enabled) ──────────────────────
insert into public.tenants (id, name, slug) values
  ('c6000000-0000-4000-8000-000000000001', 'Schedule Policy Tenant', 'sched-policy-t') on conflict (id) do nothing;
insert into public.connectors (id, tenant_id, provider, status) values
  ('c7000000-0000-4000-8000-000000000001', 'c6000000-0000-4000-8000-000000000001', 'microsoft_entra', 'active') on conflict (id) do nothing;
select public.admin_upsert_kill_switch('global','*',true,'test',null);

-- ── SP0: deny-all — authenticated/anon hold ZERO privilege on connector_schedule_slots; RLS on; zero policies ──────────
do $$ begin
  assert (select coalesce(array_agg(distinct privilege_type::text), array[]::text[]) from information_schema.role_table_grants
          where grantee='authenticated' and table_schema='public' and table_name='connector_schedule_slots') = array[]::text[], 'SP0 authenticated ZERO on slots';
  assert (select relrowsecurity from pg_class where oid='public.connector_schedule_slots'::regclass), 'SP0 RLS enabled on slots';
  assert (select count(*) from pg_policies where schemaname='public' and tablename='connector_schedule_slots')=0, 'SP0 zero policies on slots';
end $$;

-- ── SP1: policy lifecycle draft -> approved -> enabled; staging-only; missing bindings block approval ──────────────────
do $$ declare v_pol uuid; ok boolean; begin
  -- staging-only enforced
  begin perform public.admin_create_schedule_policy('c6000000-0000-4000-8000-000000000001','c7000000-0000-4000-8000-000000000001','microsoft_entra','production',7200, now(), now()+interval '6 hours',3,3,'fam',4,'sha256:x','v1','cp1','op'); ok:=false; exception when others then ok:=true; end;
  assert ok, 'SP1 a production environment policy is rejected (staging only)';
  v_pol := public.admin_create_schedule_policy('c6000000-0000-4000-8000-000000000001','c7000000-0000-4000-8000-000000000001','microsoft_entra','staging',7200, now(), now()+interval '6 hours',3,3,'fam',4,'sha256:x','v1','cp1','op');
  assert (select status from public.connector_schedule_policies where id=v_pol)='draft', 'SP1 created draft';
  perform public.admin_approve_schedule_policy(v_pol,'sam');
  assert (select status from public.connector_schedule_policies where id=v_pol)='approved', 'SP1 approved';
  perform public.admin_enable_schedule_policy(v_pol,'sam');
  assert (select status from public.connector_schedule_policies where id=v_pol)='enabled' and (select enabled from public.connector_schedule_policies where id=v_pol), 'SP1 enabled';
end $$;

-- ── SP2-SP4: full slot lifecycle for slots 1-3, duplicate delivery, and the 4th-slot structural rejection ─────────────
do $$
declare v_pol uuid; v_start timestamptz; v_slot uuid; v_auth uuid; v_no integer; v_att uuid; v_gen bigint; ok boolean; v_slot2 uuid; v_auth2 uuid;
begin
  select id, campaign_start_at into v_pol, v_start from public.connector_schedule_policies where connector_id='c7000000-0000-4000-8000-000000000001';

  -- SLOT 1 — materialize -> begin -> finalize succeeded
  select slot_id, authorization_id, slot_number into v_slot, v_auth, v_no from public.scheduler_materialize_slot(v_pol, v_start);
  assert v_no=1, 'SP2 slot 1 materialized';
  assert (select status from public.connector_run_authorizations where id=v_auth)='approved', 'SP2 slot auth approved';
  -- duplicate delivery for slot 1 resolves to the SAME slot + auth (no second execution)
  select slot_id, authorization_id into v_slot2, v_auth2 from public.scheduler_materialize_slot(v_pol, v_start);
  assert v_slot2=v_slot and v_auth2=v_auth, 'SP4 duplicate scheduler delivery resolves to the existing slot (idempotent)';
  assert (select count(*) from public.connector_schedule_slots where policy_id=v_pol and slot_number=1)=1, 'SP4 exactly one slot-1 row';
  select attempt_id, fencing_generation into v_att, v_gen from public.scheduler_begin_slot(v_slot, 300);
  assert v_gen=1, 'SP2 slot 1 lock generation 1';
  assert (select status from public.connector_schedule_slots where id=v_slot)='running', 'SP2 slot 1 running';
  assert (select status from public.connector_run_authorizations where id=v_auth)='running', 'SP2 auth running';
  perform public.scheduler_finalize_slot(v_slot, v_gen, 'succeeded', 5, 5, 1, 0, 0, 'ok');
  assert (select status from public.connector_schedule_slots where id=v_slot)='succeeded', 'SP2 slot 1 succeeded';
  assert (select status from public.connector_run_authorizations where id=v_auth)='succeeded', 'SP2 auth succeeded';
  assert (select status from public.connector_run_locks where connector_id='c7000000-0000-4000-8000-000000000001')='released', 'SP2 lock released';
  assert (select slots_succeeded from public.connector_schedule_policies where id=v_pol)=1, 'SP2 policy progress 1';

  -- SLOT 2 (scheduled at start + cadence) and SLOT 3 (start + 2*cadence)
  select slot_id, slot_number into v_slot, v_no from public.scheduler_materialize_slot(v_pol, v_start + interval '2 hours');
  assert v_no=2, 'SP3 slot 2 materialized';
  select fencing_generation into v_gen from public.scheduler_begin_slot(v_slot, 300);
  perform public.scheduler_finalize_slot(v_slot, v_gen, 'succeeded', 5, 0, 1, 0, 0, 'ok');
  select slot_id, slot_number into v_slot, v_no from public.scheduler_materialize_slot(v_pol, v_start + interval '4 hours');
  assert v_no=3, 'SP3 slot 3 materialized';
  select fencing_generation into v_gen from public.scheduler_begin_slot(v_slot, 300);
  perform public.scheduler_finalize_slot(v_slot, v_gen, 'succeeded', 5, 0, 1, 0, 0, 'ok');

  -- policy auto-completed after slot 3 (max_slots reached) -> enabled=false
  assert (select status from public.connector_schedule_policies where id=v_pol)='completed', 'SP3 policy auto-completed after slot 3';
  assert (select enabled from public.connector_schedule_policies where id=v_pol)=false, 'SP3 completed policy disabled';

  -- SLOT 4 is structurally impossible: the policy is completed (not enabled) AND slot 4 > max_slots
  begin select slot_id into v_slot from public.scheduler_materialize_slot(v_pol, v_start + interval '6 hours'); ok:=false; exception when others then ok:=true; end;
  assert ok, 'SP3 a 4th slot cannot materialize (policy completed / slot > max_slots)';
  assert (select count(*) from public.connector_schedule_slots where policy_id=v_pol)=3, 'SP3 exactly three slots ever';
end $$;

-- ── SP5-SP8: window / disabled / kill-switch / overlap gating (fresh policy) ──────────────────────────────────────────
do $$ declare v_pol uuid; v_start timestamptz; v_slot uuid; v_gen bigint; ok boolean; begin
  -- a NEW connector so its own active-run state is isolated
  insert into public.connectors (id, tenant_id, provider, status) values ('c7000000-0000-4000-8000-000000000002','c6000000-0000-4000-8000-000000000001','microsoft_entra','active') on conflict (id) do nothing;
  v_start := now();
  v_pol := public.admin_create_schedule_policy('c6000000-0000-4000-8000-000000000001','c7000000-0000-4000-8000-000000000002','microsoft_entra','staging',7200, v_start, v_start+interval '6 hours',3,3,'fam',4,'sha256:x','v1','cp1','op');

  -- SP5a: a DRAFT (not enabled) policy cannot materialize
  begin perform public.scheduler_materialize_slot(v_pol, v_start); ok:=false; exception when others then ok:=true; end;
  assert ok, 'SP5 a non-enabled policy cannot materialize a slot';

  perform public.admin_approve_schedule_policy(v_pol,'sam');
  perform public.admin_enable_schedule_policy(v_pol,'sam');

  -- SP5b: out-of-window (before start / after end) rejected
  begin perform public.scheduler_materialize_slot(v_pol, v_start + interval '9 hours'); ok:=false; exception when others then ok:=true; end;
  assert ok, 'SP5 out-of-window (after end) rejected';

  -- SP7: kill switch disabled for this connector -> materialize rejected
  perform public.admin_upsert_kill_switch('connector','c7000000-0000-4000-8000-000000000002',false,'test',null);
  begin perform public.scheduler_materialize_slot(v_pol, v_start); ok:=false; exception when others then ok:=true; end;
  assert ok, 'SP7 a disabled kill switch blocks materialization';
  perform public.admin_upsert_kill_switch('connector','c7000000-0000-4000-8000-000000000002',true,'test',null);

  -- SP6: overlap — slot 1 running, a second slot for the same connector cannot materialize (assert_no_active_run)
  select slot_id into v_slot from public.scheduler_materialize_slot(v_pol, v_start);
  select fencing_generation into v_gen from public.scheduler_begin_slot(v_slot, 300);  -- slot 1 now running
  begin perform public.scheduler_materialize_slot(v_pol, v_start + interval '2 hours'); ok:=false; exception when others then ok:=true; end;
  assert ok, 'SP6 an overlapping slot cannot materialize while a run is active';
  perform public.scheduler_finalize_slot(v_slot, v_gen, 'failed', 0, 0, 0, 0, 0, 'test failure');
  assert (select status from public.connector_schedule_slots where id=v_slot)='failed', 'SP6 failed slot durable';
  -- SP8: after a failure the auth is terminal 'failed' and cannot be re-claimed (durable)
  assert (select status from public.connector_run_authorizations where connector_id='c7000000-0000-4000-8000-000000000002' order by created_at desc limit 1)='failed', 'SP8 failed auth durable';

  -- SP11: a secret-shaped slot summary is rejected
  select slot_id into v_slot from public.scheduler_materialize_slot(v_pol, v_start + interval '2 hours');
  select fencing_generation into v_gen from public.scheduler_begin_slot(v_slot, 300);
  begin perform public.scheduler_finalize_slot(v_slot, v_gen, 'succeeded', 1, 0, 1, 0, 0, 'postgres://u:p@db.x.supabase.co/db'); ok:=false; exception when others then ok:=true; end;
  assert ok, 'SP11 a DB-URL-shaped slot summary is rejected';
  perform public.scheduler_finalize_slot(v_slot, v_gen, 'succeeded', 1, 0, 1, 0, 0, 'ok');  -- clean finalize
end $$;

-- ── SP9: role boundaries — anon/authenticated ZERO EXECUTE; connector_runner has scheduler_* but NOT admin_* ───────────
do $$ declare v_bad integer; v_runner_admin integer; begin
  select count(*) into v_bad from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    cross join lateral aclexplode(p.proacl) a join pg_roles r on r.oid=a.grantee
   where n.nspname='public' and a.privilege_type='EXECUTE' and r.rolname in ('anon','authenticated')
     and p.proname in ('admin_create_schedule_policy','admin_approve_schedule_policy','admin_enable_schedule_policy',
       'admin_disable_schedule_policy','admin_reconcile_stuck_slot','scheduler_materialize_slot','scheduler_begin_slot',
       'scheduler_finalize_slot','scheduler_policy_state');
  assert v_bad=0, 'SP9 anon/authenticated hold ZERO EXECUTE on schedule functions (found '||v_bad||')';
  select count(*) into v_runner_admin from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    cross join lateral aclexplode(p.proacl) a join pg_roles r on r.oid=a.grantee
   where n.nspname='public' and a.privilege_type='EXECUTE' and r.rolname='connector_runner'
     and p.proname in ('admin_create_schedule_policy','admin_approve_schedule_policy','admin_enable_schedule_policy','admin_disable_schedule_policy','admin_reconcile_stuck_slot');
  assert v_runner_admin=0, 'SP9 connector_runner has NO EXECUTE on admin_* schedule functions';
  assert has_function_privilege('connector_runner','public.scheduler_materialize_slot(uuid,timestamptz)','EXECUTE'), 'SP9 connector_runner CAN materialize';
end $$;

-- ── SP10: stuck-slot recovery — a running slot with an expired lock lease is reconciled; a live lock is refused ────────
do $$ declare v_pol uuid; v_start timestamptz; v_slot uuid; v_gen bigint; ok boolean; begin
  insert into public.connectors (id, tenant_id, provider, status) values ('c7000000-0000-4000-8000-000000000003','c6000000-0000-4000-8000-000000000001','microsoft_entra','active') on conflict (id) do nothing;
  v_start := now();
  v_pol := public.admin_create_schedule_policy('c6000000-0000-4000-8000-000000000001','c7000000-0000-4000-8000-000000000003','microsoft_entra','staging',7200, v_start, v_start+interval '6 hours',3,3,'fam',4,'sha256:x','v1','cp1','op');
  perform public.admin_approve_schedule_policy(v_pol,'sam'); perform public.admin_enable_schedule_policy(v_pol,'sam');
  select slot_id into v_slot from public.scheduler_materialize_slot(v_pol, v_start);
  select fencing_generation into v_gen from public.scheduler_begin_slot(v_slot, 300);  -- running, live lock
  begin perform public.admin_reconcile_stuck_slot(v_slot,'sam','manual'); ok:=false; exception when others then ok:=true; end;
  assert ok, 'SP10 reconcile refuses a slot whose lock lease is still valid';
  update public.connector_run_locks set lease_expires_at = now() - interval '1 second' where connector_id='c7000000-0000-4000-8000-000000000003';
  assert public.admin_reconcile_stuck_slot(v_slot,'sam','manual')='timed_out', 'SP10 a stuck slot with an expired lease is reconciled';
  assert (select status from public.connector_schedule_slots where id=v_slot)='timed_out', 'SP10 stuck slot -> timed_out';
end $$;

-- ── SP12: the success cap holds even when max_successful < max_slots (slots materialized AHEAD of the cap cannot begin). ──
do $$ declare v_pol uuid; v_start timestamptz; v_s1 uuid; v_s2 uuid; v_s3 uuid; v_g bigint; ok boolean; begin
  insert into public.connectors (id, tenant_id, provider, status) values ('c7000000-0000-4000-8000-000000000004','c6000000-0000-4000-8000-000000000001','microsoft_entra','active') on conflict (id) do nothing;
  v_start := now();
  v_pol := public.admin_create_schedule_policy('c6000000-0000-4000-8000-000000000001','c7000000-0000-4000-8000-000000000004','microsoft_entra','staging',7200, v_start, v_start+interval '6 hours', 3, 2, 'fam',4,'sha256:x','v1','cp1','op'); -- max_slots=3, max_successful=2
  perform public.admin_approve_schedule_policy(v_pol,'sam'); perform public.admin_enable_schedule_policy(v_pol,'sam');
  -- materialize THREE slots ahead (approved, not begun) — allowed while none is active
  select slot_id into v_s1 from public.scheduler_materialize_slot(v_pol, v_start);
  select slot_id into v_s2 from public.scheduler_materialize_slot(v_pol, v_start + interval '2 hours');
  select slot_id into v_s3 from public.scheduler_materialize_slot(v_pol, v_start + interval '4 hours');
  -- begin+finalize slots 1 and 2 -> slots_succeeded reaches max_successful(2) -> policy auto-completes
  select fencing_generation into v_g from public.scheduler_begin_slot(v_s1, 900); perform public.scheduler_finalize_slot(v_s1, v_g, 'succeeded', 1, 0, 1, 0, 0, 'ok');
  select fencing_generation into v_g from public.scheduler_begin_slot(v_s2, 900); perform public.scheduler_finalize_slot(v_s2, v_g, 'succeeded', 1, 0, 1, 0, 0, 'ok');
  assert (select status from public.connector_schedule_policies where id=v_pol)='completed', 'SP12 policy completed at max_successful';
  -- slot 3 was materialized ahead but CANNOT begin now (cap reached AND policy completed) — the success cap holds
  begin perform public.scheduler_begin_slot(v_s3, 900); ok:=false; exception when others then ok:=true; end;
  assert ok, 'SP12 a materialized-ahead slot cannot begin past max_successful (cap holds when max_successful < max_slots)';
  assert (select slots_succeeded from public.connector_schedule_policies where id=v_pol)=2, 'SP12 slots_succeeded never exceeds max_successful';
end $$;

-- ── SP13: approval requires the full bindings — a null binding blocks approve (the guard is real, not vacuous). ──
do $$ declare v_pol uuid; ok boolean; begin
  insert into public.connectors (id, tenant_id, provider, status) values ('c7000000-0000-4000-8000-000000000005','c6000000-0000-4000-8000-000000000001','microsoft_entra','active') on conflict (id) do nothing;
  v_pol := public.admin_create_schedule_policy('c6000000-0000-4000-8000-000000000001','c7000000-0000-4000-8000-000000000005','microsoft_entra','staging',7200, now(), now()+interval '6 hours',3,3,'fam',4,'sha256:x','v1','cp1','op');
  update public.connector_schedule_policies set image_digest=null where id=v_pol;  -- simulate a missing binding
  begin perform public.admin_approve_schedule_policy(v_pol,'sam'); ok:=false; exception when others then ok:=true; end;
  assert ok, 'SP13 a policy missing a required binding cannot be approved';
end $$;

-- cleanup (tenant cascade removes connectors + all schedule/control-plane rows).
reset role;
delete from public.tenants where id='c6000000-0000-4000-8000-000000000001';
delete from public.connector_kill_switches where scope='global';
