-- 0046_connector_schedule_policy.sql
--
-- BOUNDED SCHEDULE POLICY for the connector execution control plane (P5E13, Gate S2). Extends 0044/0045 with a durable, approved,
-- bounded schedule policy + per-slot execution records + an ATOMIC slot-materialization function, so an EventBridge Scheduler can
-- launch a one-shot ECS task per slot that materializes exactly one authorization per slot, claims it, fences a lock, runs the
-- existing discovery path, and reconciles — with a hard, DB-enforced cap on the number of slots/executions. It ACTIVATES nothing:
-- a policy is `draft` by default; no slot materializes unless an admin has approved + enabled it, the time is inside the campaign
-- window, the slot number is within `max_slots`, and every applicable kill switch permits execution.
--
-- SECURITY MODEL (mirrors 0044/0045): request roles (anon/authenticated) get NOTHING (deny-all + revoke EXECUTE incl. the Supabase
-- default-privilege grant). service_role runs the ADMIN policy lifecycle; connector_runner runs ONLY the scheduler execution
-- functions (materialize/begin/finalize/read + stuck recovery is admin). All SECURITY DEFINER with a pinned empty search_path.
-- Reuses 0044's runner_claim_authorization / runner_acquire_lock / runner_mark_launch_attempted / runner_record_start /
-- runner_record_success|failure|timeout|ambiguous / runner_reconcile_result / connector_execution_permitted (no logic duplicated).
--
-- Migration-safety: ALTER ADD COLUMN / CREATE TABLE|INDEX|FUNCTION + GRANT/REVOKE only — additive; no teardown, no row purge, no
-- destructive ops. staging only (CHECK environment='staging'); microsoft_entra stays certificationOnly; RISK-007 OPEN; Phase C
-- BLOCKED. A production project ref must NEVER appear here.

begin;

-- ── 1. SCHEDULE POLICY — extend 0044's connector_schedule_policies with the campaign binding + lifecycle ──────────────────
alter table public.connector_schedule_policies
  add column if not exists environment text not null default 'staging',
  add column if not exists status text not null default 'draft',
  add column if not exists cadence_seconds integer,
  add column if not exists campaign_start_at timestamptz,
  add column if not exists campaign_end_at timestamptz,
  add column if not exists max_slots integer not null default 1,
  add column if not exists max_successful integer not null default 1,
  add column if not exists task_definition_family text,
  add column if not exists task_definition_revision integer,
  add column if not exists image_digest text,
  add column if not exists credential_version text,
  add column if not exists schema_version text,
  add column if not exists discovery_only boolean not null default true,
  add column if not exists promotion_disabled boolean not null default true,
  add column if not exists one_shot_per_slot boolean not null default true,
  add column if not exists kill_switch_required boolean not null default true,
  add column if not exists requested_by text,
  add column if not exists approved_by text,
  add column if not exists approved_at timestamptz,
  add column if not exists slots_materialized integer not null default 0,
  add column if not exists slots_succeeded integer not null default 0;

do $$ begin
  -- guard rails (idempotent add; ignore if already present)
  if not exists (select 1 from pg_constraint where conname='csp_environment_staging_only') then
    alter table public.connector_schedule_policies add constraint csp_environment_staging_only check (environment = 'staging'); end if;
  if not exists (select 1 from pg_constraint where conname='csp_status_check') then
    alter table public.connector_schedule_policies add constraint csp_status_check check (status in
      ('draft','approved','enabled','paused','completed','failed','cancelled','expired')); end if;
  if not exists (select 1 from pg_constraint where conname='csp_max_slots_bound') then
    alter table public.connector_schedule_policies add constraint csp_max_slots_bound check (max_slots between 1 and 24); end if;
  if not exists (select 1 from pg_constraint where conname='csp_max_successful_bound') then
    alter table public.connector_schedule_policies add constraint csp_max_successful_bound check (max_successful between 1 and 24 and max_successful <= max_slots); end if;
  if not exists (select 1 from pg_constraint where conname='csp_cadence_seconds_bound') then
    alter table public.connector_schedule_policies add constraint csp_cadence_seconds_bound check (cadence_seconds is null or cadence_seconds between 300 and 86400); end if;
  if not exists (select 1 from pg_constraint where conname='csp_discovery_only_true') then
    alter table public.connector_schedule_policies add constraint csp_discovery_only_true check (discovery_only = true); end if;
  if not exists (select 1 from pg_constraint where conname='csp_promotion_disabled_true') then
    alter table public.connector_schedule_policies add constraint csp_promotion_disabled_true check (promotion_disabled = true); end if;
  if not exists (select 1 from pg_constraint where conname='csp_one_shot_per_slot_true') then
    alter table public.connector_schedule_policies add constraint csp_one_shot_per_slot_true check (one_shot_per_slot = true); end if;
  if not exists (select 1 from pg_constraint where conname='csp_window_order') then
    alter table public.connector_schedule_policies add constraint csp_window_order check (campaign_start_at is null or campaign_end_at is null or campaign_end_at > campaign_start_at); end if;
end $$;

-- ── 2. SLOTS — one durable record per scheduled execution slot (sanitized aggregate only) ──────────────────────────────
create table if not exists public.connector_schedule_slots (
  id uuid primary key default gen_random_uuid(),
  policy_id uuid not null references public.connector_schedule_policies (id) on delete cascade,
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  connector_id uuid not null,
  provider text not null,
  scheduled_at timestamptz not null,
  slot_number integer not null,
  idempotency_key text not null,
  authorization_id uuid references public.connector_run_authorizations (id) on delete set null,
  attempt_id uuid references public.connector_run_attempts (id) on delete set null,
  status text not null default 'materialized',
  records_seen integer,
  facts_written integer,
  pages_seen integer,
  retry_count integer not null default 0,
  throttle_count integer not null default 0,
  sanitized_summary text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint css_status_check check (status in ('materialized','running','succeeded','failed','ambiguous','timed_out','skipped')),
  constraint css_slot_number_positive check (slot_number >= 1),
  constraint css_summary_len check (sanitized_summary is null or char_length(sanitized_summary) <= 512),
  constraint css_idem_unique unique (idempotency_key),
  constraint css_one_per_slot unique (policy_id, slot_number),          -- at most ONE row per (policy, slot number)
  constraint css_one_per_scheduled unique (policy_id, scheduled_at),     -- at most ONE row per (policy, scheduled time)
  constraint css_same_tenant_connector
    foreign key (connector_id, tenant_id) references public.connectors (id, tenant_id) on delete cascade
);
create index if not exists css_policy_idx on public.connector_schedule_slots (policy_id, slot_number);

alter table public.connector_schedule_slots enable row level security;
revoke all on public.connector_schedule_slots from anon, authenticated, connector_runner;

commit;

-- ════════════════════════════════════════════ FUNCTIONS ═════════════════════════════════════════════════════════════
begin;

-- ── ADMIN: create a draft bounded schedule policy (service_role). CHECKs force staging/discovery/promotion/one-shot. ──
create or replace function public.admin_create_schedule_policy(
  p_tenant_id uuid, p_connector_id uuid, p_provider text, p_environment text, p_cadence_seconds integer,
  p_campaign_start_at timestamptz, p_campaign_end_at timestamptz, p_max_slots integer, p_max_successful integer,
  p_task_family text, p_task_revision integer, p_image_digest text, p_credential_version text, p_schema_version text,
  p_requested_by text
) returns uuid language plpgsql security definer set search_path = '' as $$
declare v_id uuid;
begin
  if p_environment <> 'staging' then raise exception 'schedule policy is staging-only'; end if;
  if not exists (select 1 from public.connectors c where c.id=p_connector_id and c.tenant_id=p_tenant_id and c.provider=p_provider and c.status='active') then
    raise exception 'schedule policy target is not an active owned connector';
  end if;
  insert into public.connector_schedule_policies (
    tenant_id, connector_id, provider, environment, enabled, status, cadence_seconds, campaign_start_at, campaign_end_at,
    max_slots, max_successful, min_cadence_seconds, max_cadence_seconds, task_definition_family, task_definition_revision,
    image_digest, credential_version, schema_version, discovery_only, promotion_disabled, one_shot_per_slot,
    kill_switch_required, requested_by, synthetic_only
  ) values (
    p_tenant_id, p_connector_id, p_provider, 'staging', false, 'draft', p_cadence_seconds, p_campaign_start_at, p_campaign_end_at,
    p_max_slots, p_max_successful, greatest(p_cadence_seconds, 300), p_cadence_seconds, p_task_family, p_task_revision,
    p_image_digest, p_credential_version, p_schema_version, true, true, true, true, p_requested_by, true
  )
  on conflict (tenant_id, connector_id, provider) do update set
    environment='staging', status='draft', enabled=false, cadence_seconds=excluded.cadence_seconds,
    campaign_start_at=excluded.campaign_start_at, campaign_end_at=excluded.campaign_end_at, max_slots=excluded.max_slots,
    max_successful=excluded.max_successful, task_definition_family=excluded.task_definition_family,
    task_definition_revision=excluded.task_definition_revision, image_digest=excluded.image_digest,
    credential_version=excluded.credential_version, schema_version=excluded.schema_version, requested_by=excluded.requested_by,
    slots_materialized=0, slots_succeeded=0, updated_at=now()
  returning id into v_id;
  return v_id;
end; $$;

create or replace function public.admin_approve_schedule_policy(p_id uuid, p_approved_by text)
returns void language plpgsql security definer set search_path = '' as $$
declare v record;
begin
  select * into v from public.connector_schedule_policies where id=p_id;
  if v.id is null then raise exception 'schedule policy not found'; end if;
  if v.status <> 'draft' then raise exception 'only a draft policy can be approved'; end if;
  if v.cadence_seconds is null or v.campaign_start_at is null or v.campaign_end_at is null
     or v.task_definition_family is null or v.task_definition_revision is null or v.image_digest is null
     or v.credential_version is null or v.schema_version is null then
    raise exception 'schedule policy is missing required bindings';
  end if;
  update public.connector_schedule_policies set status='approved', approved_by=p_approved_by, approved_at=now(), updated_at=now()
   where id=p_id and status='draft';
end; $$;

create or replace function public.admin_enable_schedule_policy(p_id uuid, p_by text)
returns void language plpgsql security definer set search_path = '' as $$
declare v record;
begin
  select * into v from public.connector_schedule_policies where id=p_id;
  if v.id is null then raise exception 'schedule policy not found'; end if;
  if v.status <> 'approved' then raise exception 'only an approved policy can be enabled'; end if;
  if v.campaign_end_at <= now() then raise exception 'campaign window already ended'; end if;
  update public.connector_schedule_policies set status='enabled', enabled=true, updated_at=now()
   where id=p_id and status='approved';
end; $$;

-- ADMIN: pause / complete / fail / cancel a policy (fail-closed: also clears enabled). Terminal for completed/failed/cancelled.
create or replace function public.admin_disable_schedule_policy(p_id uuid, p_new_status text, p_by text)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if p_new_status not in ('paused','completed','failed','cancelled') then raise exception 'invalid disable status'; end if;
  update public.connector_schedule_policies set status=p_new_status, enabled=false, updated_at=now()
   where id=p_id and status in ('enabled','paused','approved','draft');
  if not found then raise exception 'schedule policy not disable-able (missing / already terminal)'; end if;
end; $$;

-- ── RUNNER: ATOMIC slot materialization. Creates-or-resolves EXACTLY one approved authorization per slot; the policy-row lock
--    serializes concurrent/duplicate scheduler deliveries; unique (policy_id, slot_number) + unique idempotency_key backstop it.
create or replace function public.scheduler_materialize_slot(p_policy_id uuid, p_scheduled_at timestamptz)
returns table(slot_id uuid, authorization_id uuid, slot_number integer)
language plpgsql security definer set search_path = '' as $$
declare v record; v_slot_no integer; v_idem text; v_plan text; v_auth uuid; v_slot uuid;
begin
  select * into v from public.connector_schedule_policies where id=p_policy_id for update;   -- serialize per policy
  if v.id is null then raise exception 'schedule policy not found'; end if;
  if v.status <> 'enabled' then raise exception 'schedule policy not enabled'; end if;
  if p_scheduled_at < v.campaign_start_at - interval '5 minutes' or p_scheduled_at > v.campaign_end_at then
    raise exception 'scheduled time outside campaign window';
  end if;
  -- Resolve a DUPLICATE scheduler delivery of the SAME fire (same scheduled_at) -> return the existing slot; no 2nd execution.
  -- The unique (policy_id, scheduled_at) index backstops this against a TOCTOU (the policy-row FOR UPDATE also serializes it).
  select id, connector_schedule_slots.authorization_id, connector_schedule_slots.slot_number into v_slot, v_auth, v_slot_no
    from public.connector_schedule_slots where policy_id=p_policy_id and scheduled_at=p_scheduled_at;
  if v_slot is not null then slot_id := v_slot; authorization_id := v_auth; slot_number := v_slot_no; return next; return; end if;
  -- A NEW distinct fire: the Nth materialization is slot N (a counter, NOT derived from cadence alignment) — robust to the exact
  -- rate-schedule / StartDate first-fire timing. slots_materialized only advances on a committed new slot (below).
  v_slot_no := v.slots_materialized + 1;
  if v_slot_no > v.max_slots then raise exception 'slot number out of range (max slots reached)'; end if;
  if v.slots_succeeded >= v.max_successful then raise exception 'maximum successful executions reached'; end if;
  if v.kill_switch_required and not public.connector_execution_permitted(v.tenant_id, v.connector_id, v.provider, v.environment) then
    raise exception 'execution blocked by kill switch';
  end if;
  perform public.runner_assert_no_active_run(v.tenant_id, v.connector_id, v.provider);   -- no overlap
  v_idem := 'slot-' || md5(concat_ws('|', p_policy_id::text,
              to_char(p_scheduled_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS'), v_slot_no::text,
              v.tenant_id::text, v.connector_id::text, v.provider, v.schema_version, v.credential_version,
              v.task_definition_revision::text, v.image_digest));
  v_plan := 'planv1-sched-' || md5(concat_ws('|', p_policy_id::text, v.task_definition_family,
              v.task_definition_revision::text, v.image_digest, v.credential_version, v.schema_version));
  insert into public.connector_run_authorizations (
    tenant_id, connector_id, provider, plan_hash, idempotency_key, credential_version, schema_version,
    task_definition_family, task_definition_revision, image_digest, run_mode, discovery_only, promotion_disabled, one_shot,
    requested_by, approved_by, approval_reason, approved_at, expires_at, status
  ) values (
    v.tenant_id, v.connector_id, v.provider, v_plan, v_idem, v.credential_version, v.schema_version,
    v.task_definition_family, v.task_definition_revision, v.image_digest, 'discovery_oneshot', true, true, true,
    coalesce(v.requested_by,'scheduler'), coalesce(v.approved_by,'scheduler'), 'scheduled slot '||v_slot_no, now(),
    v.campaign_end_at + interval '1 hour', 'approved'
  ) returning id into v_auth;
  insert into public.connector_schedule_slots (policy_id, tenant_id, connector_id, provider, scheduled_at, slot_number, idempotency_key, authorization_id, status)
    values (p_policy_id, v.tenant_id, v.connector_id, v.provider, p_scheduled_at, v_slot_no, v_idem, v_auth, 'materialized')
    returning id into v_slot;
  update public.connector_schedule_policies set slots_materialized = slots_materialized + 1, updated_at=now() where id=p_policy_id;
  slot_id := v_slot; authorization_id := v_auth; slot_number := v_slot_no; return next;
end; $$;

-- ── RUNNER: begin a materialized slot — atomic claim + fenced lock + launch/start (reuses the 0044 runner_* lifecycle). ──
create or replace function public.scheduler_begin_slot(p_slot_id uuid, p_lease_seconds integer)
returns table(attempt_id uuid, fencing_generation bigint, cfg_tenant text, cfg_connector text, cfg_provider text, cfg_credential_version text)
language plpgsql security definer set search_path = '' as $$
declare v record; v_ph text; v_ik text; v_cv text; v_sv text; v_tf text; v_tr integer; v_dg text; v_att uuid; v_gen bigint;
begin
  select s.*, p.status as pol_status, p.slots_succeeded as pol_succeeded, p.max_successful as pol_max_succ into v
    from public.connector_schedule_slots s join public.connector_schedule_policies p on p.id=s.policy_id
   where s.id=p_slot_id for update of s;
  if v.id is null then raise exception 'slot not found'; end if;
  if v.status <> 'materialized' then raise exception 'slot not in a startable state'; end if;
  -- re-check the policy at EXECUTION time (not just at materialize): a completed/paused/disabled policy launches nothing, and the
  -- success cap holds even when max_successful < max_slots (slots may be materialized ahead of the cap). Executions are serial
  -- (assert_no_active_run + the active-authorization unique index), so the committed slots_succeeded here is a reliable cap read.
  if v.pol_status <> 'enabled' then raise exception 'schedule policy not enabled'; end if;
  if v.pol_succeeded >= v.pol_max_succ then raise exception 'maximum successful executions reached'; end if;
  select plan_hash, idempotency_key, credential_version, schema_version, task_definition_family, task_definition_revision, image_digest
    into v_ph, v_ik, v_cv, v_sv, v_tf, v_tr, v_dg
    from public.connector_run_authorizations where id=v.authorization_id;
  -- claim (kill-switch + no-active + config-bound approved->claimed + open attempt) via the 0044 runner function
  v_att := public.runner_claim_authorization(v.authorization_id, v.tenant_id, v.connector_id, v.provider, v_ph, v_ik, v_cv, v_sv, v_tf, v_tr, v_dg, 'slot:'||v.slot_number);
  v_gen := public.runner_acquire_lock(v.tenant_id, v.connector_id, v.provider, v.authorization_id, v_att, p_lease_seconds);
  perform public.runner_mark_launch_attempted(v_att, v_gen);
  perform public.runner_record_start(v_att, v_gen);
  update public.connector_schedule_slots set attempt_id=v_att, status='running', updated_at=now() where id=p_slot_id;
  attempt_id := v_att; fencing_generation := v_gen;
  cfg_tenant := v.tenant_id::text; cfg_connector := v.connector_id::text; cfg_provider := v.provider; cfg_credential_version := v_cv;
  return next;
end; $$;

-- ── RUNNER: finalize a slot — record the terminal result (reuses runner_record_*), release the lock, advance policy. ──
create or replace function public.scheduler_finalize_slot(
  p_slot_id uuid, p_generation bigint, p_status text, p_records_seen integer, p_facts_written integer, p_pages_seen integer,
  p_retry_count integer, p_throttle_count integer, p_summary text
) returns text language plpgsql security definer set search_path = '' as $$
declare v record;
begin
  if p_status not in ('succeeded','failed','ambiguous','timed_out') then raise exception 'invalid slot terminal status'; end if;
  -- defense in depth: refuse a secret/DB-URL-shaped summary
  if p_summary is not null and p_summary ~* '(arn:aws|eyj[a-z0-9]|bearer |access_token|client_secret|postgres(ql)?://|[a-z][a-z0-9+.-]*://[^ ]*@)' then
    raise exception 'slot summary must be sanitized';
  end if;
  select * into v from public.connector_schedule_slots where id=p_slot_id for update;
  if v.id is null then raise exception 'slot not found'; end if;
  if v.attempt_id is null then raise exception 'slot has no attempt'; end if;
  if v.status <> 'running' then raise exception 'slot not in a finalizable state'; end if;
  if p_status='succeeded' then
    perform public.runner_record_success(v.attempt_id, p_generation, coalesce(p_records_seen,0), coalesce(p_facts_written,0), coalesce(p_pages_seen,0), 0);
    perform public.runner_reconcile_result(v.attempt_id, coalesce(p_records_seen,0), coalesce(p_facts_written,0), coalesce(p_pages_seen,0), coalesce(p_retry_count,0), coalesce(p_throttle_count,0));
  elsif p_status='timed_out' then
    perform public.runner_record_timeout(v.attempt_id, p_generation, 0);
  elsif p_status='ambiguous' then
    perform public.runner_record_ambiguous(v.attempt_id, p_generation, left(coalesce(p_summary,'ambiguous'),64));
  else
    perform public.runner_record_failure(v.attempt_id, p_generation, 'slot_failed', left(coalesce(p_summary,'failed'),64), 0);
  end if;
  update public.connector_schedule_slots set status=p_status, records_seen=p_records_seen, facts_written=p_facts_written,
         pages_seen=p_pages_seen, retry_count=coalesce(p_retry_count,0), throttle_count=coalesce(p_throttle_count,0),
         sanitized_summary=left(coalesce(p_summary,''),512), updated_at=now() where id=p_slot_id;
  update public.connector_schedule_policies set slots_succeeded = slots_succeeded + case when p_status='succeeded' then 1 else 0 end,
         updated_at=now() where id=v.policy_id;
  -- auto-complete when the last slot is reached or the success cap is hit (fail-closed: also clears enabled)
  update public.connector_schedule_policies set status='completed', enabled=false, updated_at=now()
   where id=v.policy_id and status='enabled' and (slots_succeeded >= max_successful or v.slot_number >= max_slots);
  return p_status;
end; $$;

-- ── RUNNER: read policy progress (no write). ──
create or replace function public.scheduler_policy_state(p_policy_id uuid)
returns text language plpgsql security definer set search_path = '' as $$
declare v text;
begin
  select status||':'||slots_materialized::text||'/'||slots_succeeded::text||' of '||max_slots::text
    into v from public.connector_schedule_policies where id=p_policy_id;
  return coalesce(v, 'none');
end; $$;

-- ── ADMIN: recover a slot stuck 'running' after a crash (mirrors admin_reconcile_stuck_run; refuses a live lock). ──
create or replace function public.admin_reconcile_stuck_slot(p_slot_id uuid, p_by text, p_reason text)
returns text language plpgsql security definer set search_path = '' as $$
declare v record;
begin
  select * into v from public.connector_schedule_slots where id=p_slot_id;
  if v.id is null then raise exception 'slot not found'; end if;
  if v.status <> 'running' then raise exception 'slot is not stuck-running'; end if;
  if exists (select 1 from public.connector_run_locks where tenant_id=v.tenant_id and connector_id=v.connector_id and provider=v.provider and status='held' and lease_expires_at > now()) then
    raise exception 'run is still live (lock lease valid); refusing to reconcile';
  end if;
  if v.authorization_id is not null then perform public.admin_reconcile_stuck_run(v.authorization_id, p_by, p_reason); end if;
  update public.connector_schedule_slots set status='timed_out', sanitized_summary=left('reconciled_stuck:'||coalesce(p_reason,''),512), updated_at=now() where id=p_slot_id;
  return 'timed_out';
end; $$;

-- ── GRANTS: EXECUTE revoked from PUBLIC + anon + authenticated (Supabase default-privilege deny, per 0045). ────────────
revoke execute on function
  public.admin_create_schedule_policy(uuid,uuid,text,text,integer,timestamptz,timestamptz,integer,integer,text,integer,text,text,text,text),
  public.admin_approve_schedule_policy(uuid,text), public.admin_enable_schedule_policy(uuid,text),
  public.admin_disable_schedule_policy(uuid,text,text), public.admin_reconcile_stuck_slot(uuid,text,text),
  public.scheduler_materialize_slot(uuid,timestamptz), public.scheduler_begin_slot(uuid,integer),
  public.scheduler_finalize_slot(uuid,bigint,text,integer,integer,integer,integer,integer,text),
  public.scheduler_policy_state(uuid)
  from public, anon, authenticated;

grant execute on function
  public.admin_create_schedule_policy(uuid,uuid,text,text,integer,timestamptz,timestamptz,integer,integer,text,integer,text,text,text,text),
  public.admin_approve_schedule_policy(uuid,text), public.admin_enable_schedule_policy(uuid,text),
  public.admin_disable_schedule_policy(uuid,text,text), public.admin_reconcile_stuck_slot(uuid,text,text)
  to service_role;

grant execute on function
  public.scheduler_materialize_slot(uuid,timestamptz), public.scheduler_begin_slot(uuid,integer),
  public.scheduler_finalize_slot(uuid,bigint,text,integer,integer,integer,integer,integer,text),
  public.scheduler_policy_state(uuid)
  to connector_runner;

commit;
