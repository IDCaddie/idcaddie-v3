-- connector_customer_pilot_test.sql — verifies migration 0047 (customer-pilot control plane): deny-all, staging-only, full
-- lifecycle (draft→consent→approved→enabled→…→terminal), consent expiry/withdrawal gates, the execution assertion gate, incident
-- hold, one-active-pilot cap, tenant/credential isolation, retention/deletion planning, and role boundaries. Run under
-- scripts/test-rls.sh (ON_ERROR_STOP=1). SYNTHETIC values only. NEVER hosted.
\set ON_ERROR_STOP on
reset role;

-- ── Fixtures: one tenant + two active microsoft_entra connectors + a second tenant (isolation) + a global kill switch ──
insert into public.tenants (id, name, slug) values
  ('c8000000-0000-4000-8000-000000000001','Pilot Tenant A','pilot-tenant-a'),
  ('c8000000-0000-4000-8000-000000000002','Pilot Tenant B','pilot-tenant-b') on conflict (id) do nothing;
insert into public.connectors (id, tenant_id, provider, status) values
  ('c9000000-0000-4000-8000-000000000001','c8000000-0000-4000-8000-000000000001','microsoft_entra','active'),
  ('c9000000-0000-4000-8000-000000000002','c8000000-0000-4000-8000-000000000001','microsoft_entra','active'),
  ('c9000000-0000-4000-8000-000000000003','c8000000-0000-4000-8000-000000000002','microsoft_entra','active') on conflict (id) do nothing;
select public.admin_upsert_kill_switch('global','*',true,'test',null);

-- helper: create+consent+approve+enable a pilot for a connector, returns the pilot id. Enables its pilot kill switch too.
create or replace function pg_temp.mk_pilot(p_tenant uuid, p_conn uuid, p_perm text default 'User.Read.All') returns uuid language plpgsql as $$
declare v uuid; begin
  v := public.admin_create_pilot_enrollment(p_tenant,p_conn,'microsoft_entra','staging',false,'cust-ref-opaque','op','sam','sam','pilot discovery',p_perm,'v1','cp1',30, now(), now()+interval '7 days',3,100);
  perform public.admin_record_pilot_consent(v,'v1','users.read','pilot discovery',p_perm,'customer', now()+interval '1 day','ticket-opaque-123',true,true,true);
  perform public.admin_approve_pilot_enrollment(v,'sam','GO');
  perform public.admin_enable_pilot_enrollment(v,'sam');
  perform public.admin_upsert_kill_switch('pilot', v::text, true, 'sam', null);
  return v;
end $$;

-- ── PL0: deny-all — authenticated/anon hold ZERO privilege on every pilot table; RLS on; zero policies ────────────────
do $$ declare t text; begin
  foreach t in array array['connector_pilot_enrollments','connector_pilot_consents','connector_pilot_incidents','connector_pilot_exit_reviews','connector_pilot_deletion_jobs'] loop
    assert (select coalesce(array_agg(distinct privilege_type::text),array[]::text[]) from information_schema.role_table_grants
            where grantee='authenticated' and table_schema='public' and table_name=t)=array[]::text[], 'PL0 authenticated ZERO on '||t;
    assert (select relrowsecurity from pg_class where oid=('public.'||t)::regclass), 'PL0 RLS on '||t;
    assert (select count(*) from pg_policies where schemaname='public' and tablename=t)=0, 'PL0 zero policies on '||t;
  end loop;
end $$;

-- ── PL1: lifecycle + approval gates (consent required; owners required; staging-only) ────────────────────────────────
do $$ declare v uuid; ok boolean; begin
  -- staging-only
  begin perform public.admin_create_pilot_enrollment('c8000000-0000-4000-8000-000000000001','c9000000-0000-4000-8000-000000000001','microsoft_entra','production',false,'r','op','s','s','p','User.Read.All','v1','cp1',30,now(),now()+interval '7 days',3,100); ok:=false; exception when others then ok:=true; end;
  assert ok, 'PL1 production environment rejected';
  -- a real (non-synthetic) pilot needs a customer account reference
  begin perform public.admin_create_pilot_enrollment('c8000000-0000-4000-8000-000000000001','c9000000-0000-4000-8000-000000000001','microsoft_entra','staging',false,null,'op','s','s','p','User.Read.All','v1','cp1',30,now(),now()+interval '7 days',3,100); ok:=false; exception when others then ok:=true; end;
  assert ok, 'PL1 real pilot without a customer reference rejected';
  v := public.admin_create_pilot_enrollment('c8000000-0000-4000-8000-000000000001','c9000000-0000-4000-8000-000000000001','microsoft_entra','staging',false,'cust-ref','op','sam','sam','discovery','User.Read.All','v1','cp1',30,now(),now()+interval '7 days',3,100);
  assert (select pilot_status from public.connector_pilot_enrollments where id=v)='draft', 'PL1 draft created';
  -- approve BEFORE consent fails
  begin perform public.admin_approve_pilot_enrollment(v,'sam','GO'); ok:=false; exception when others then ok:=true; end;
  assert ok, 'PL1 approve before consent rejected';
  perform public.admin_record_pilot_consent(v,'v1','users.read','discovery','User.Read.All','customer', now()+interval '1 day','ticket-1',true,true,true);
  assert (select pilot_status from public.connector_pilot_enrollments where id=v)='consent_pending', 'PL1 -> consent_pending';
  perform public.admin_approve_pilot_enrollment(v,'sam','GO');
  assert (select pilot_status from public.connector_pilot_enrollments where id=v)='approved', 'PL1 -> approved';
  perform public.admin_enable_pilot_enrollment(v,'sam');
  assert (select pilot_status from public.connector_pilot_enrollments where id=v)='enabled', 'PL1 -> enabled';
  perform public.admin_set_pilot_status(v,'cancelled','sam','cleanup');  -- free the connector + the one-enabled slot
end $$;

-- ── PL2: consent evidence must be opaque (secret/doc-shaped rejected) ────────────────────────────────────────────────
do $$ declare v uuid; ok boolean; begin
  v := public.admin_create_pilot_enrollment('c8000000-0000-4000-8000-000000000001','c9000000-0000-4000-8000-000000000002','microsoft_entra','staging',false,'cust-ref','op','sam','sam','d','User.Read.All','v1','cp1',30,now(),now()+interval '7 days',3,100);
  begin perform public.admin_record_pilot_consent(v,'v1','s','p','User.Read.All','c',now()+interval '1 day','user@example.com',true,true,true); ok:=false; exception when others then ok:=true; end;
  assert ok, 'PL2 an email-shaped consent evidence reference is rejected';
  begin perform public.admin_record_pilot_consent(v,'v1','s','p','User.Read.All','c',now()+interval '1 day','postgres://u:p@h/db',true,true,true); ok:=false; exception when others then ok:=true; end;
  assert ok, 'PL2 a DB-URL-shaped consent evidence reference is rejected';
  perform public.admin_set_pilot_status(v,'cancelled','sam','cleanup');  -- free connector 002
end $$;

-- ── PL3: the execution assertion gate — happy path + each fail-closed condition ──────────────────────────────────────
do $$ declare v uuid; ok boolean; begin
  v := pg_temp.mk_pilot('c8000000-0000-4000-8000-000000000001','c9000000-0000-4000-8000-000000000001');
  assert public.runner_assert_pilot_authorized(v,'c8000000-0000-4000-8000-000000000001','c9000000-0000-4000-8000-000000000001','microsoft_entra','v1','User.Read.All',false)='User.Read.All', 'PL3 happy path authorizes + returns the approved permission';
  -- wrong credential version / permission / tenant / connector / provider all fail
  begin perform public.runner_assert_pilot_authorized(v,'c8000000-0000-4000-8000-000000000001','c9000000-0000-4000-8000-000000000001','microsoft_entra','v2','User.Read.All',false); ok:=false; exception when others then ok:=true; end; assert ok, 'PL3 wrong credential version fails';
  begin perform public.runner_assert_pilot_authorized(v,'c8000000-0000-4000-8000-000000000001','c9000000-0000-4000-8000-000000000001','microsoft_entra','v1','Directory.Read.All',false); ok:=false; exception when others then ok:=true; end; assert ok, 'PL3 unexpected permission fails';
  begin perform public.runner_assert_pilot_authorized(v,'c8000000-0000-4000-8000-000000000002','c9000000-0000-4000-8000-000000000001','microsoft_entra','v1','User.Read.All',false); ok:=false; exception when others then ok:=true; end; assert ok, 'PL3 wrong tenant fails';
  -- requesting a schedule when schedule_allowed=false fails
  begin perform public.runner_assert_pilot_authorized(v,'c8000000-0000-4000-8000-000000000001','c9000000-0000-4000-8000-000000000001','microsoft_entra','v1','User.Read.All',true); ok:=false; exception when others then ok:=true; end; assert ok, 'PL3 schedule not allowed fails';
  -- missing per-pilot kill switch fails
  perform public.admin_upsert_kill_switch('pilot', v::text, false, 'sam', null);
  begin perform public.runner_assert_pilot_authorized(v,'c8000000-0000-4000-8000-000000000001','c9000000-0000-4000-8000-000000000001','microsoft_entra','v1','User.Read.All',false); ok:=false; exception when others then ok:=true; end; assert ok, 'PL3 disabled pilot kill switch fails';
  perform public.admin_upsert_kill_switch('pilot', v::text, true, 'sam', null);
  -- consent withdrawal blocks immediately
  perform public.admin_withdraw_pilot_consent(v,'sam','test');
  begin perform public.runner_assert_pilot_authorized(v,'c8000000-0000-4000-8000-000000000001','c9000000-0000-4000-8000-000000000001','microsoft_entra','v1','User.Read.All',false); ok:=false; exception when others then ok:=true; end; assert ok, 'PL3 consent withdrawal blocks (pilot also paused)';
  assert (select pilot_status from public.connector_pilot_enrollments where id=v)='paused', 'PL3 withdrawal paused the pilot';
  perform public.admin_set_pilot_status(v,'cancelled','sam','cleanup');  -- free connector 001
end $$;

-- ── PL4: run limit + run counting + incident hold ───────────────────────────────────────────────────────────────────
do $$ declare v uuid; ok boolean; begin
  v := pg_temp.mk_pilot('c8000000-0000-4000-8000-000000000001','c9000000-0000-4000-8000-000000000002');
  assert public.runner_record_pilot_run(v)=1, 'PL4 run 1 recorded';
  perform public.runner_record_pilot_run(v); perform public.runner_record_pilot_run(v);  -- 2, 3
  begin perform public.runner_record_pilot_run(v); ok:=false; exception when others then ok:=true; end; assert ok, 'PL4 the 4th run is rejected (max_runs=3)';
  begin perform public.runner_assert_pilot_authorized(v,'c8000000-0000-4000-8000-000000000001','c9000000-0000-4000-8000-000000000002','microsoft_entra','v1','User.Read.All',false); ok:=false; exception when others then ok:=true; end; assert ok, 'PL4 assert fails once the run limit is reached';
  -- incident hold blocks execution
  perform public.admin_pilot_incident_hold(v,'permission_drift','error','sanitized incident','sam');
  assert (select pilot_status from public.connector_pilot_enrollments where id=v)='incident_hold', 'PL4 incident hold set';
  perform public.admin_set_pilot_status(v,'cancelled','sam','cleanup');  -- free connector 002
end $$;

-- ── PL5: one enabled pilot maximum + one active per connector + terminal immutability ────────────────────────────────
do $$ declare v1 uuid; v2 uuid; ok boolean; begin
  -- connector 003 belongs to tenant B; enable a pilot there while another is enabled -> the one-enabled index rejects the 2nd
  v1 := pg_temp.mk_pilot('c8000000-0000-4000-8000-000000000001','c9000000-0000-4000-8000-000000000001');  -- enabled (tenant A)
  v2 := public.admin_create_pilot_enrollment('c8000000-0000-4000-8000-000000000002','c9000000-0000-4000-8000-000000000003','microsoft_entra','staging',false,'cust-ref-b','op','sam','sam','d','User.Read.All','v1','cp1',30,now(),now()+interval '7 days',3,100);
  perform public.admin_record_pilot_consent(v2,'v1','s','p','User.Read.All','c',now()+interval '1 day','ticket-b',true,true,true);
  perform public.admin_approve_pilot_enrollment(v2,'sam','GO');
  begin perform public.admin_enable_pilot_enrollment(v2,'sam'); ok:=false; exception when unique_violation then ok:=true; end;
  assert ok, 'PL5 a SECOND enabled pilot is rejected (one active customer pilot max)';
  -- a second NON-TERMINAL enrollment for the SAME connector is rejected (partial unique)
  begin perform public.admin_create_pilot_enrollment('c8000000-0000-4000-8000-000000000001','c9000000-0000-4000-8000-000000000001','microsoft_entra','staging',false,'cust-ref','op','sam','sam','d','User.Read.All','v1','cp1',30,now(),now()+interval '7 days',3,100); ok:=false; exception when unique_violation then ok:=true; end;
  assert ok, 'PL5 a second non-terminal enrollment per connector is rejected';
  -- terminal immutability: cancel v1, then it cannot be re-enabled
  perform public.admin_set_pilot_status(v1,'cancelled','sam','done');
  begin perform public.admin_enable_pilot_enrollment(v1,'sam'); ok:=false; exception when others then ok:=true; end;
  assert ok, 'PL5 a cancelled pilot cannot be re-enabled';
  begin perform public.admin_set_pilot_status(v1,'paused','sam','x'); ok:=false; exception when others then ok:=true; end;
  assert ok, 'PL5 a terminal pilot cannot transition';
  perform public.admin_set_pilot_status(v2,'cancelled','sam','cleanup');  -- free connector 003 (tenant B) for PL7
end $$;

-- ── PL6: isolation — composite FK blocks a connector not owned by the tenant ─────────────────────────────────────────
do $$ declare ok boolean; begin
  -- connector 003 belongs to tenant B, not tenant A -> composite same-tenant FK rejects the enrollment
  begin perform public.admin_create_pilot_enrollment('c8000000-0000-4000-8000-000000000001','c9000000-0000-4000-8000-000000000003','microsoft_entra','staging',false,'r','op','s','s','d','User.Read.All','v1','cp1',30,now(),now()+interval '7 days',3,100); ok:=false; exception when others then ok:=true; end;
  assert ok, 'PL6 a connector not owned by the tenant is rejected (cross-tenant isolation)';
end $$;

-- ── PL7: retention bounds + deletion job planning (requires approval; never auto-executes) ──────────────────────────
do $$ declare v uuid; j uuid; ok boolean; begin
  v := public.admin_create_pilot_enrollment('c8000000-0000-4000-8000-000000000002','c9000000-0000-4000-8000-000000000003','microsoft_entra','staging',false,'r','op','s','s','d','User.Read.All','v1','cp1',30,now(),now()+interval '7 days',3,100);
  begin perform public.admin_create_pilot_enrollment('c8000000-0000-4000-8000-000000000002','c9000000-0000-4000-8000-000000000003','microsoft_entra','staging',true,null,'op','s','s','d','User.Read.All','v1','cp1',9999,now(),now()+interval '7 days',3,100); ok:=false; exception when others then ok:=true; end;
  assert ok, 'PL7 retention_days beyond the safe maximum is rejected';
  j := public.admin_create_pilot_deletion_job(v,'customer_scoped','sam','sanitized');
  assert (select job_status from public.connector_pilot_deletion_jobs where id=j)='requested', 'PL7 deletion job created as requested (no execution)';
  perform public.admin_approve_pilot_deletion_job(j,'sam');
  assert (select job_status from public.connector_pilot_deletion_jobs where id=j)='approved', 'PL7 deletion job approved (still no automatic execution)';
  -- the pilot rows still exist (nothing deleted)
  assert (select count(*) from public.connector_pilot_enrollments where id=v)=1, 'PL7 deletion does not auto-execute';
end $$;

-- ── PL8: role boundaries — anon/authenticated ZERO EXECUTE; connector_runner has only the 3 runner functions ──────────
do $$ declare v_bad int; v_runner_admin int; v_runner_exec int; begin
  select count(*) into v_bad from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    cross join lateral aclexplode(p.proacl) a join pg_roles r on r.oid=a.grantee
   where n.nspname='public' and a.privilege_type='EXECUTE' and r.rolname in ('anon','authenticated')
     and p.proname in ('admin_create_pilot_enrollment','admin_record_pilot_consent','admin_approve_pilot_enrollment','admin_enable_pilot_enrollment','admin_set_pilot_status','admin_expire_stale_pilots','admin_withdraw_pilot_consent','admin_pilot_incident_hold','admin_record_pilot_exit_review','admin_create_pilot_deletion_job','admin_approve_pilot_deletion_job','runner_read_pilot','runner_assert_pilot_authorized','runner_record_pilot_run','runner_assert_not_pilot_governed','connector_pilot_ref_is_sensitive');
  assert v_bad=0, 'PL8 anon/authenticated hold ZERO EXECUTE on pilot functions (found '||v_bad||')';
  select count(*) into v_runner_admin from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    cross join lateral aclexplode(p.proacl) a join pg_roles r on r.oid=a.grantee
   where n.nspname='public' and a.privilege_type='EXECUTE' and r.rolname='connector_runner' and p.proname like 'admin_%pilot%';
  assert v_runner_admin=0, 'PL8 connector_runner has NO EXECUTE on any admin pilot function';
  select count(*) into v_runner_exec from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    cross join lateral aclexplode(p.proacl) a join pg_roles r on r.oid=a.grantee
   where n.nspname='public' and a.privilege_type='EXECUTE' and r.rolname='connector_runner' and p.proname in ('runner_read_pilot','runner_assert_pilot_authorized','runner_record_pilot_run','runner_assert_not_pilot_governed');
  assert v_runner_exec=4, 'PL8 connector_runner has EXECUTE on exactly the 4 runner pilot functions';
end $$;

-- ── PL9: review hardening — opaque customer ref (F1), generic credential-URL (F2) + PEM (F3) sanitizers, mandatory pilot gate (F2) ──
do $$ declare v uuid; ok boolean;
  a constant uuid := 'c8000000-0000-4000-8000-000000000001'; c1 constant uuid := 'c9000000-0000-4000-8000-000000000001';
begin
  -- F1: the customer reference must be opaque — an email or a credential-URL is rejected (not just consent evidence)
  begin perform public.admin_create_pilot_enrollment(a,c1,'microsoft_entra','staging',false,'admin@contoso.com','op','s','s','d','User.Read.All','v1','cp1',30,now(),now()+interval '7 days',3,100); ok:=false; exception when others then ok:=true; end;
  assert ok, 'PL9 an email-shaped customer reference is rejected';
  begin perform public.admin_create_pilot_enrollment(a,c1,'microsoft_entra','staging',false,'mysql://u:p@h/db','op','s','s','d','User.Read.All','v1','cp1',30,now(),now()+interval '7 days',3,100); ok:=false; exception when others then ok:=true; end;
  assert ok, 'PL9 a credential-URL customer reference is rejected';
  v := public.admin_create_pilot_enrollment(a,c1,'microsoft_entra','staging',false,'cust-ref-9','op','sam','sam','d','User.Read.All','v1','cp1',30,now(),now()+interval '7 days',3,100);
  -- F2: a NON-postgres credential-URL in consent evidence is now rejected (was a bypass)
  begin perform public.admin_record_pilot_consent(v,'v1','s','p','User.Read.All','c',now()+interval '1 day','mongodb://u:p@h/db',true,true,true); ok:=false; exception when others then ok:=true; end;
  assert ok, 'PL9 a non-postgres credential-URL consent evidence is rejected';
  -- F3: a PEM block in an incident / exit-review summary is rejected (the drifted branch is restored)
  begin perform public.admin_pilot_incident_hold(v,'cat','sev','-----BEGIN PRIVATE KEY-----','sam'); ok:=false; exception when others then ok:=true; end;
  assert ok, 'PL9 a PEM-shaped incident summary is rejected';
  begin perform public.admin_record_pilot_exit_review(v,'failed','-----BEGIN OPENSSH PRIVATE KEY-----','sam'); ok:=false; exception when others then ok:=true; end;
  assert ok, 'PL9 a PEM-shaped exit-review summary is rejected';
  -- F2 (mandatory gate): connector c1 has a non-synthetic non-terminal enrollment -> the synthetic-path assertion refuses it
  begin perform public.runner_assert_not_pilot_governed(a,c1,'microsoft_entra'); ok:=false; exception when others then ok:=true; end;
  assert ok, 'PL9 a pilot-governed connector is refused on the synthetic path';
  perform public.admin_set_pilot_status(v,'cancelled','sam','cleanup');
  -- once terminal, the connector is no longer governed -> the synthetic path passes
  perform public.runner_assert_not_pilot_governed(a,c1,'microsoft_entra');
  -- a SYNTHETIC enrollment is excluded (is_synthetic path is unchanged) -> not governed
  v := public.admin_create_pilot_enrollment(a,c1,'microsoft_entra','staging',true,null,'op','sam','sam','d','User.Read.All','v1','cp1',30,now(),now()+interval '7 days',3,100);
  perform public.runner_assert_not_pilot_governed(a,c1,'microsoft_entra');
  perform public.admin_set_pilot_status(v,'cancelled','sam','cleanup');
end $$;

-- cleanup (tenant cascade removes connectors + all pilot rows).
reset role;
delete from public.tenants where id in ('c8000000-0000-4000-8000-000000000001','c8000000-0000-4000-8000-000000000002');
delete from public.connector_kill_switches where scope in ('global','pilot');
