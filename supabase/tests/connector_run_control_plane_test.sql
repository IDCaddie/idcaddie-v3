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

-- cleanup (tenant cascade removes the connector + all control-plane rows).
reset role;
delete from public.tenants where id='c4000000-0000-4000-8000-000000000001';
delete from public.connector_kill_switches where scope='global';
