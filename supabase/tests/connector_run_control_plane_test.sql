-- connector_run_control_plane_test.sql — verifies migration 0044 (the connector execution control plane): deny-all RLS,
-- kill-switch fail-closed, admin/runner role boundaries, atomic claim + replay guard, distributed lock takeover + fencing,
-- lifecycle transitions + completed immutability, ambiguous durability, idempotent reconcile, sanitized alerts. Run under
-- scripts/test-rls.sh (ON_ERROR_STOP=1). SYNTHETIC values only. NEVER hosted.

\set ON_ERROR_STOP on
reset role;

-- ── Fixtures: one tenant + one active microsoft_entra connector ────────────────────────────────────────────────────────
insert into public.tenants (id, name, slug) values
  ('c4000000-0000-4000-8000-000000000001', 'Control Plane Tenant', 'control-plane-t') on conflict (id) do nothing;
insert into public.connectors (id, tenant_id, provider, status) values
  ('c5000000-0000-4000-8000-000000000001', 'c4000000-0000-4000-8000-000000000001', 'microsoft_entra', 'active') on conflict (id) do nothing;
-- a SECOND connector, isolated from the primary's accumulated lock/authorization state, for the recovery + concurrency tests.
insert into public.connectors (id, tenant_id, provider, status) values
  ('c5000000-0000-4000-8000-000000000002', 'c4000000-0000-4000-8000-000000000001', 'microsoft_entra', 'active') on conflict (id) do nothing;

-- ── CP0: deny-all — authenticated/anon hold EXACTLY ZERO privilege on every control-plane table ────────────────────────
do $$ declare t text; begin
  foreach t in array array['connector_run_authorizations','connector_run_attempts','connector_run_locks','connector_run_alerts','connector_schedule_policies','connector_kill_switches'] loop
    assert (select coalesce(array_agg(distinct privilege_type::text), array[]::text[]) from information_schema.role_table_grants
            where grantee='authenticated' and table_schema='public' and table_name=t) = array[]::text[], 'CP0 authenticated ZERO on '||t;
    assert not has_table_privilege('anon','public.'||t,'SELECT'), 'CP0 anon no SELECT on '||t;
    assert (select relrowsecurity from pg_class where oid=('public.'||t)::regclass), 'CP0 RLS enabled on '||t;
    assert (select count(*) from pg_policies where schemaname='public' and tablename=t)=0, 'CP0 zero policies on '||t;
  end loop;
end $$;

-- ── CP1: kill switch is fail-closed ──────────────────────────────────────────────────────────────────────────────────
do $$ begin
  assert public.connector_execution_permitted('c4000000-0000-4000-8000-000000000001','c5000000-0000-4000-8000-000000000001','microsoft_entra','staging') = false, 'CP1 blocked with no global switch (fail closed)';
  perform public.admin_upsert_kill_switch('global','*',true,'test',null);
  assert public.connector_execution_permitted('c4000000-0000-4000-8000-000000000001','c5000000-0000-4000-8000-000000000001','microsoft_entra','staging') = true, 'CP1 permitted with global enabled';
  perform public.admin_upsert_kill_switch('connector','c5000000-0000-4000-8000-000000000001',false,'test',null);
  assert public.connector_execution_permitted('c4000000-0000-4000-8000-000000000001','c5000000-0000-4000-8000-000000000001','microsoft_entra','staging') = false, 'CP1 blocked when the connector layer is disabled';
  perform public.admin_upsert_kill_switch('connector','c5000000-0000-4000-8000-000000000001',true,'test',null);
end $$;

-- ── CP2: config-hardening CHECKs — a direct authorization row with promotion enabled / not-one-shot is rejected ─────────
do $$ declare ok boolean := false; begin
  begin
    insert into public.connector_run_authorizations (tenant_id, connector_id, provider, plan_hash, idempotency_key, credential_version, schema_version, task_definition_family, task_definition_revision, image_digest, run_mode, discovery_only, promotion_disabled, one_shot, requested_by, expires_at)
      values ('c4000000-0000-4000-8000-000000000001','c5000000-0000-4000-8000-000000000001','microsoft_entra','planv1-xxxxxxxx','idemxxxxxxxx','v1','1','fam',4,'sha256:x','discovery_oneshot', true, false, true, 'op', now()+interval '1 hour');
    ok := false;
  exception when check_violation then ok := true; end;
  assert ok, 'CP2 promotion_disabled=false is rejected by CHECK';
end $$;

-- ── CP3–CP6: full lifecycle happy path + claim/lock/fencing/immutability (as the definer=postgres) ────────────────────
do $$
declare v_auth uuid; v_attempt uuid; v_gen bigint; v_gen2 bigint; ok boolean;
begin
  -- create + approve
  v_auth := public.admin_create_run_authorization('c4000000-0000-4000-8000-000000000001','c5000000-0000-4000-8000-000000000001','microsoft_entra','planv1-aaaaaaaa','idem-aaaaaaaa','v1','1','fam',4,'sha256:abc','op', now()+interval '1 hour');
  assert (select status from public.connector_run_authorizations where id=v_auth)='draft', 'CP3 created draft';
  perform public.admin_approve_run_authorization(v_auth,'sam','GO'); -- draft -> approved
  assert (select status from public.connector_run_authorizations where id=v_auth)='approved', 'CP3 approved';

  -- read for plan mode (no claim): valid match returns 'approved'; a wrong plan_hash raises
  assert public.runner_read_authorization(v_auth,'c4000000-0000-4000-8000-000000000001','c5000000-0000-4000-8000-000000000001','microsoft_entra','planv1-aaaaaaaa','idem-aaaaaaaa','v1','1','fam',4,'sha256:abc')='approved', 'CP3 plan-mode sees approved';
  begin perform public.runner_read_authorization(v_auth,'c4000000-0000-4000-8000-000000000001','c5000000-0000-4000-8000-000000000001','microsoft_entra','planv1-WRONG','idem-aaaaaaaa','v1','1','fam',4,'sha256:abc'); ok:=false; exception when others then ok:=true; end;
  assert ok, 'CP3 plan-mode rejects a config mismatch';

  -- claim (atomic, approved->claimed) + open attempt
  v_attempt := public.runner_claim_authorization(v_auth,'c4000000-0000-4000-8000-000000000001','c5000000-0000-4000-8000-000000000001','microsoft_entra','planv1-aaaaaaaa','idem-aaaaaaaa','v1','1','fam',4,'sha256:abc','claimtok');
  assert (select status from public.connector_run_authorizations where id=v_auth)='claimed', 'CP3 claimed';
  -- second claim of the same authorization fails (replay/one-claim guard)
  begin perform public.runner_claim_authorization(v_auth,'c4000000-0000-4000-8000-000000000001','c5000000-0000-4000-8000-000000000001','microsoft_entra','planv1-aaaaaaaa','idem-aaaaaaaa','v1','1','fam',4,'sha256:abc','claimtok2'); ok:=false; exception when others then ok:=true; end;
  assert ok, 'CP3 a claimed authorization cannot be re-claimed';

  -- acquire the lock -> generation 1
  v_gen := public.runner_acquire_lock('c4000000-0000-4000-8000-000000000001','c5000000-0000-4000-8000-000000000001','microsoft_entra',v_auth,v_attempt,300);
  assert v_gen = 1, 'CP4 first acquire -> generation 1';
  -- a second acquire while held+valid conflicts
  begin perform public.runner_acquire_lock('c4000000-0000-4000-8000-000000000001','c5000000-0000-4000-8000-000000000001','microsoft_entra',v_auth,v_attempt,300); ok:=false; exception when others then ok:=true; end;
  assert ok, 'CP4 a held+valid lock cannot be re-acquired (conflict)';

  -- lifecycle: launch_attempted -> start
  perform public.runner_mark_launch_attempted(v_attempt, v_gen);
  assert (select launch_attempted_at is not null from public.connector_run_attempts where id=v_attempt), 'CP5 launch attempted persisted';
  begin perform public.runner_mark_launch_attempted(v_attempt, v_gen); ok:=false; exception when others then ok:=true; end;
  assert ok, 'CP5 no double launch';
  perform public.runner_record_start(v_attempt, v_gen);
  assert (select result_status from public.connector_run_attempts where id=v_attempt)='running', 'CP5 running';

  -- FENCING: simulate a lock takeover (expire the lease, re-acquire -> generation 2); the old generation is now STALE.
  update public.connector_run_locks set lease_expires_at = now() - interval '1 second' where tenant_id='c4000000-0000-4000-8000-000000000001' and connector_id='c5000000-0000-4000-8000-000000000001';
  v_gen2 := public.runner_acquire_lock('c4000000-0000-4000-8000-000000000001','c5000000-0000-4000-8000-000000000001','microsoft_entra',v_auth,v_attempt,300);
  assert v_gen2 = 2, 'CP4 expired-lease takeover -> generation increments to 2';
  begin perform public.runner_record_success(v_attempt, v_gen, 5,5,1,1000); ok:=false; exception when others then ok:=true; end;
  assert ok, 'CP4 a STALE fencing generation cannot write a result';

  -- the CURRENT generation finalizes success (+ releases the lock)
  perform public.runner_record_success(v_attempt, v_gen2, 5,5,1,1000);
  assert (select result_status from public.connector_run_attempts where id=v_attempt)='succeeded', 'CP5 succeeded';
  assert (select status from public.connector_run_authorizations where id=v_auth)='succeeded', 'CP5 authorization succeeded';
  assert (select status from public.connector_run_locks where tenant_id='c4000000-0000-4000-8000-000000000001' and connector_id='c5000000-0000-4000-8000-000000000001')='released', 'CP5 lock released on success';

  -- completed immutability: a second success on the terminal attempt fails
  begin perform public.runner_record_success(v_attempt, v_gen2, 9,9,9,9); ok:=false; exception when others then ok:=true; end;
  assert ok, 'CP5 a terminal attempt is immutable';

  -- reconcile is idempotent (safe audit annotation on the terminal attempt)
  perform public.runner_reconcile_result(v_attempt, 5,5,1,0,0);
  perform public.runner_reconcile_result(v_attempt, 5,5,1,0,0);
  assert (select records_seen from public.connector_run_attempts where id=v_attempt)=5, 'CP6 reconcile idempotent';
end $$;

-- ── CP7: expiry + cancellation block claiming ────────────────────────────────────────────────────────────────────────
do $$ declare v_auth uuid; ok boolean; begin
  v_auth := public.admin_create_run_authorization('c4000000-0000-4000-8000-000000000001','c5000000-0000-4000-8000-000000000001','microsoft_entra','planv1-bbbbbbbb','idem-bbbbbbbb','v1','1','fam',4,'sha256:abc','op', now()+interval '1 hour');
  perform public.admin_approve_run_authorization(v_auth,'sam','GO');
  update public.connector_run_authorizations set expires_at = now() - interval '1 second' where id=v_auth; -- simulate expiry
  begin perform public.runner_claim_authorization(v_auth,'c4000000-0000-4000-8000-000000000001','c5000000-0000-4000-8000-000000000001','microsoft_entra','planv1-bbbbbbbb','idem-bbbbbbbb','v1','1','fam',4,'sha256:abc','tok'); ok:=false; exception when others then ok:=true; end;
  assert ok, 'CP7 an expired approval cannot be claimed';
  assert public.admin_expire_stale_authorizations() >= 1, 'CP7 admin_expire marks stale approvals expired';
  assert (select status from public.connector_run_authorizations where id=v_auth)='expired', 'CP7 -> expired';

  v_auth := public.admin_create_run_authorization('c4000000-0000-4000-8000-000000000001','c5000000-0000-4000-8000-000000000001','microsoft_entra','planv1-cccccccc','idem-cccccccc','v1','1','fam',4,'sha256:abc','op', now()+interval '1 hour');
  perform public.admin_cancel_run_authorization(v_auth,'sam','cancelled');
  begin perform public.runner_claim_authorization(v_auth,'c4000000-0000-4000-8000-000000000001','c5000000-0000-4000-8000-000000000001','microsoft_entra','planv1-cccccccc','idem-cccccccc','v1','1','fam',4,'sha256:abc','tok'); ok:=false; exception when others then ok:=true; end;
  assert ok, 'CP7 a cancelled approval cannot be claimed';
end $$;

-- ── CP8: alert sanitation — a secret-shaped summary is rejected ───────────────────────────────────────────────────────
do $$ declare ok boolean; begin
  begin perform public.runner_record_alert('c4000000-0000-4000-8000-000000000001','c5000000-0000-4000-8000-000000000001','microsoft_entra',null,null,'error','test','token eyJabcdefghij leaked'); ok:=false; exception when others then ok:=true; end;
  assert ok, 'CP8 a secret-shaped alert summary is rejected';
  perform public.runner_record_alert('c4000000-0000-4000-8000-000000000001','c5000000-0000-4000-8000-000000000001','microsoft_entra',null,null,'warning','failed_run','run failed: category=timeout');
  assert (select count(*) from public.connector_run_alerts where category='failed_run')=1, 'CP8 a sanitized alert is stored';
end $$;

-- ── CP9: role boundaries — request roles denied EXECUTE; connector_runner runs runner_* but NOT admin_* ────────────────
do $$ declare ok boolean; begin
  set local role authenticated;
  begin perform public.runner_latest_run_state('c4000000-0000-4000-8000-000000000001','c5000000-0000-4000-8000-000000000001','microsoft_entra'); ok:=false; exception when insufficient_privilege then ok:=true; end;
  assert ok, 'CP9 authenticated cannot EXECUTE a runner function';
  reset role;
end $$;
do $$ declare ok boolean; begin
  set local role connector_runner;
  assert public.runner_latest_run_state('c4000000-0000-4000-8000-000000000001','c5000000-0000-4000-8000-000000000001','microsoft_entra') in ('succeeded','expired','cancelled','none'), 'CP9 connector_runner can EXECUTE a runner function';
  begin perform public.admin_create_run_authorization('c4000000-0000-4000-8000-000000000001','c5000000-0000-4000-8000-000000000001','microsoft_entra','p','i','v1','1','f',4,'d','op',now()+interval '1 hour'); ok:=false; exception when insufficient_privilege then ok:=true; end;
  assert ok, 'CP9 connector_runner CANNOT EXECUTE an admin function';
  begin insert into public.connector_run_authorizations (tenant_id,connector_id,provider,plan_hash,idempotency_key,credential_version,schema_version,task_definition_family,task_definition_revision,image_digest,run_mode,discovery_only,promotion_disabled,one_shot,requested_by,expires_at) values ('c4000000-0000-4000-8000-000000000001','c5000000-0000-4000-8000-000000000001','microsoft_entra','p2','i2','v1','1','f',4,'d','discovery_oneshot',true,true,true,'op',now()); ok:=false; exception when insufficient_privilege then ok:=true; end;
  assert ok, 'CP9 connector_runner has NO direct table INSERT';
  reset role;
end $$;

-- ── CP9b: deny-all EXECUTE — anon + authenticated hold ZERO EXECUTE on ALL control-plane functions (ACL-level, all 25). ──
-- Regression guard for the Supabase default-privilege gap 0045 fixes, and for any incomplete harness re-revoke lockstep.
do $$ declare v_bad integer; begin
  select count(*) into v_bad
  from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  cross join lateral aclexplode(p.proacl) a join pg_roles r on r.oid=a.grantee
  where n.nspname='public' and a.privilege_type='EXECUTE' and r.rolname in ('anon','authenticated')
    and p.proname in ('admin_create_run_authorization','admin_approve_run_authorization','admin_cancel_run_authorization',
      'admin_expire_stale_authorizations','admin_reconcile_stuck_run','admin_upsert_schedule_policy','admin_upsert_kill_switch',
      'connector_execution_permitted','runner_read_authorization','runner_assert_no_active_run','runner_claim_authorization',
      'runner_acquire_lock','runner_assert_fencing','runner_renew_lock','runner_release_lock','runner_mark_launch_attempted',
      'runner_record_task_identity','runner_record_start','runner_record_success','runner_record_failure','runner_record_timeout',
      'runner_record_ambiguous','runner_reconcile_result','runner_record_alert','runner_latest_run_state');
  assert v_bad = 0, 'CP9b anon/authenticated hold ZERO EXECUTE on control-plane functions (found '||v_bad||')';
end $$;

-- ── CP9c: connector_runner holds EXACTLY the intended execution set — no admin_*, no internal fencing helper (ACL-level). ──
do $$ declare v_exec integer; v_admin integer; v_fencing integer; begin
  select count(*) into v_exec from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    cross join lateral aclexplode(p.proacl) a join pg_roles r on r.oid=a.grantee
   where n.nspname='public' and a.privilege_type='EXECUTE' and r.rolname='connector_runner'
     and p.proname in ('connector_execution_permitted','runner_read_authorization','runner_assert_no_active_run',
       'runner_claim_authorization','runner_acquire_lock','runner_renew_lock','runner_release_lock','runner_mark_launch_attempted',
       'runner_record_task_identity','runner_record_start','runner_record_success','runner_record_failure','runner_record_timeout',
       'runner_record_ambiguous','runner_reconcile_result','runner_record_alert','runner_latest_run_state');
  assert v_exec = 17, 'CP9c connector_runner holds EXECUTE on exactly the 17 intended execution functions (got '||v_exec||')';
  select count(*) into v_admin from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    cross join lateral aclexplode(p.proacl) a join pg_roles r on r.oid=a.grantee
   where n.nspname='public' and a.privilege_type='EXECUTE' and r.rolname='connector_runner'
     and p.proname in ('admin_create_run_authorization','admin_approve_run_authorization','admin_cancel_run_authorization',
       'admin_expire_stale_authorizations','admin_reconcile_stuck_run','admin_upsert_schedule_policy','admin_upsert_kill_switch');
  assert v_admin = 0, 'CP9c connector_runner has NO EXECUTE on any admin_* function (got '||v_admin||')';
  select count(*) into v_fencing from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    cross join lateral aclexplode(p.proacl) a join pg_roles r on r.oid=a.grantee
   where n.nspname='public' and a.privilege_type='EXECUTE' and r.rolname='connector_runner' and p.proname='runner_assert_fencing';
  assert v_fencing = 0, 'CP9c connector_runner CANNOT EXECUTE the internal fencing helper';
end $$;

-- ── CP10: the kill switch fails closed at the DB — a disabled layer blocks an ACTUAL claim, not just the helper's return. ──
do $$ declare v_auth uuid; ok boolean; begin
  v_auth := public.admin_create_run_authorization('c4000000-0000-4000-8000-000000000001','c5000000-0000-4000-8000-000000000002','microsoft_entra','planv1-dddddddd','idem-dddddddd','v1','1','fam',4,'sha256:abc','op', now()+interval '1 hour');
  perform public.admin_approve_run_authorization(v_auth,'sam','GO');
  perform public.admin_upsert_kill_switch('connector','c5000000-0000-4000-8000-000000000002',false,'test',null); -- disable this connector's layer
  begin perform public.runner_claim_authorization(v_auth,'c4000000-0000-4000-8000-000000000001','c5000000-0000-4000-8000-000000000002','microsoft_entra','planv1-dddddddd','idem-dddddddd','v1','1','fam',4,'sha256:abc','tok'); ok:=false; exception when others then ok:=true; end;
  assert ok, 'CP10 a disabled kill switch blocks the CLAIM (fail-closed at the DB, not merely caller discipline)';
  assert (select status from public.connector_run_authorizations where id=v_auth)='approved', 'CP10 the blocked claim left the authorization approved (no partial transition)';
  perform public.admin_upsert_kill_switch('connector','c5000000-0000-4000-8000-000000000002',true,'test',null); -- restore
  -- now it claims (global + connector both enabled)
  perform public.runner_claim_authorization(v_auth,'c4000000-0000-4000-8000-000000000001','c5000000-0000-4000-8000-000000000002','microsoft_entra','planv1-dddddddd','idem-dddddddd','v1','1','fam',4,'sha256:abc','tok');
  assert (select status from public.connector_run_authorizations where id=v_auth)='claimed', 'CP10 claim succeeds once the switch permits';
  update public.connector_run_locks set lease_expires_at = now() - interval '1 second' where connector_id='c5000000-0000-4000-8000-000000000002'; -- (no lock yet; harmless)
  perform public.admin_reconcile_stuck_run(v_auth,'sam','cp10-cleanup'); -- clear the active auth for later blocks
end $$;

-- ── CP11: admin recovery — a runner crash (stuck active + expired lock lease) is recoverable via function only; a LIVE run is refused. ──
do $$ declare v_auth uuid; v_attempt uuid; v_gen bigint; ok boolean; begin
  v_auth := public.admin_create_run_authorization('c4000000-0000-4000-8000-000000000001','c5000000-0000-4000-8000-000000000002','microsoft_entra','planv1-eeeeeeee','idem-eeeeeeee','v1','1','fam',4,'sha256:abc','op', now()+interval '1 hour');
  perform public.admin_approve_run_authorization(v_auth,'sam','GO');
  v_attempt := public.runner_claim_authorization(v_auth,'c4000000-0000-4000-8000-000000000001','c5000000-0000-4000-8000-000000000002','microsoft_entra','planv1-eeeeeeee','idem-eeeeeeee','v1','1','fam',4,'sha256:abc','tok');
  v_gen := public.runner_acquire_lock('c4000000-0000-4000-8000-000000000001','c5000000-0000-4000-8000-000000000002','microsoft_entra',v_auth,v_attempt,300);
  perform public.runner_mark_launch_attempted(v_attempt, v_gen);
  perform public.runner_record_start(v_attempt, v_gen); -- 'running' with a LIVE lock lease
  begin perform public.admin_reconcile_stuck_run(v_auth,'sam','manual'); ok:=false; exception when others then ok:=true; end;
  assert ok, 'CP11 reconcile REFUSES a run whose lock lease is still valid (never aborts a live task)';
  update public.connector_run_locks set lease_expires_at = now() - interval '1 second' where connector_id='c5000000-0000-4000-8000-000000000002'; -- runner crashed: lease expires
  assert public.admin_reconcile_stuck_run(v_auth,'sam','manual')='timed_out', 'CP11 a stuck run with an expired lease is reconciled';
  assert (select status from public.connector_run_authorizations where id=v_auth)='timed_out', 'CP11 stuck authorization -> timed_out';
  assert (select result_status from public.connector_run_attempts where id=v_attempt)='timed_out', 'CP11 stuck attempt -> timed_out';
  assert (select status from public.connector_run_locks where connector_id='c5000000-0000-4000-8000-000000000002')='expired', 'CP11 the dead lock -> expired';
end $$;
do $$ declare v_auth uuid; ok boolean; begin -- a terminal auth cannot be reconciled again
  select id into v_auth from public.connector_run_authorizations where idempotency_key='idem-eeeeeeee';
  begin perform public.admin_reconcile_stuck_run(v_auth,'sam','again'); ok:=false; exception when others then ok:=true; end;
  assert ok, 'CP11 a non-stuck (terminal) authorization is not reconcilable';
end $$;

-- ── CP12: at most one ACTIVE authorization per connector — the partial-unique index backstops the claim TOCTOU. ──
do $$ declare v_a uuid; v_b uuid; v_att uuid; ok boolean; begin
  v_a := public.admin_create_run_authorization('c4000000-0000-4000-8000-000000000001','c5000000-0000-4000-8000-000000000002','microsoft_entra','planv1-ffffffff','idem-ffffffff','v1','1','fam',4,'sha256:abc','op', now()+interval '1 hour');
  perform public.admin_approve_run_authorization(v_a,'sam','GO');
  v_att := public.runner_claim_authorization(v_a,'c4000000-0000-4000-8000-000000000001','c5000000-0000-4000-8000-000000000002','microsoft_entra','planv1-ffffffff','idem-ffffffff','v1','1','fam',4,'sha256:abc','tok'); -- A -> 'claimed' (active)
  v_b := public.admin_create_run_authorization('c4000000-0000-4000-8000-000000000001','c5000000-0000-4000-8000-000000000002','microsoft_entra','planv1-gggggggg','idem-gggggggg','v1','1','fam',4,'sha256:abc','op', now()+interval '1 hour');
  perform public.admin_approve_run_authorization(v_b,'sam','GO');
  -- a raw second transition to an active status (the TOCTOU window) is refused by cra_one_active_per_connector
  begin update public.connector_run_authorizations set status='claimed' where id=v_b; ok:=false; exception when unique_violation then ok:=true; end;
  assert ok, 'CP12 a second active authorization for one connector is rejected (partial unique index)';
  update public.connector_run_locks set lease_expires_at = now() - interval '1 second' where connector_id='c5000000-0000-4000-8000-000000000002';
  perform public.admin_reconcile_stuck_run(v_a,'sam','cp12-cleanup');
end $$;

-- cleanup (tenant cascade removes both connectors + all control-plane rows).
reset role;
delete from public.tenants where id='c4000000-0000-4000-8000-000000000001';
delete from public.connector_kill_switches where scope='global';
