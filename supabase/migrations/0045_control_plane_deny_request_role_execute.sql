-- 0045_control_plane_deny_request_role_execute.sql
--
-- CORRECTIVE deny-all hardening for the 0044 control plane. On hosted Supabase, `ALTER DEFAULT PRIVILEGES` grants EXECUTE on every
-- new public-schema function DIRECTLY to anon, authenticated (and service_role). 0044's `revoke ... from public` removed only the
-- PUBLIC grant, so the request roles (anon/authenticated) retained EXECUTE on all 25 control-plane functions — a deny-all violation:
-- the SECURITY DEFINER functions (incl. admin_upsert_kill_switch) were reachable by anon via PostgREST RPC. The local RLS harness
-- masked this (it re-revokes from anon/authenticated in a test-only lockstep). This migration revokes EXECUTE from public, anon,
-- authenticated on all 25 functions so the request roles get NOTHING, matching 0044's stated security model. service_role (trusted
-- backend key) and connector_runner (execution role, explicit grant) are intentionally unchanged.
--
-- Migration-safety: GRANT/REVOKE only — additive posture tightening; no teardown, no row purge, no destructive ops. Staging only;
-- microsoft_entra stays certificationOnly; RISK-007 remains OPEN; Phase C remains BLOCKED.

begin;

revoke execute on function
  public.admin_create_run_authorization(uuid,uuid,text,text,text,text,text,text,integer,text,text,timestamptz),
  public.admin_approve_run_authorization(uuid,text,text), public.admin_cancel_run_authorization(uuid,text,text),
  public.admin_expire_stale_authorizations(), public.admin_reconcile_stuck_run(uuid,text,text),
  public.admin_upsert_schedule_policy(uuid,uuid,text,boolean), public.admin_upsert_kill_switch(text,text,boolean,text,text),
  public.connector_execution_permitted(uuid,uuid,text,text),
  public.runner_read_authorization(uuid,uuid,uuid,text,text,text,text,text,text,integer,text),
  public.runner_assert_no_active_run(uuid,uuid,text),
  public.runner_claim_authorization(uuid,uuid,uuid,text,text,text,text,text,text,integer,text,text),
  public.runner_acquire_lock(uuid,uuid,text,uuid,uuid,integer), public.runner_assert_fencing(uuid,bigint),
  public.runner_renew_lock(uuid,bigint,integer), public.runner_release_lock(uuid,bigint),
  public.runner_mark_launch_attempted(uuid,bigint), public.runner_record_task_identity(uuid,bigint,text),
  public.runner_record_start(uuid,bigint), public.runner_record_success(uuid,bigint,integer,integer,integer,integer),
  public.runner_record_failure(uuid,bigint,text,text,integer), public.runner_record_timeout(uuid,bigint,integer),
  public.runner_record_ambiguous(uuid,bigint,text), public.runner_reconcile_result(uuid,integer,integer,integer,integer,integer),
  public.runner_record_alert(uuid,uuid,text,uuid,uuid,text,text,text), public.runner_latest_run_state(uuid,uuid,text)
  from public, anon, authenticated;

commit;
