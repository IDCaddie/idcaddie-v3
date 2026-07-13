-- 0044_connector_run_control_plane.sql
--
-- Provider-neutral CONNECTOR EXECUTION CONTROL PLANE (P5E10-P5E12) — the shared durable authorization / attempt /
-- distributed-lock / alert / schedule-policy / kill-switch substrate that gates every future connector run (S1 manual repeat
-- through S5). It ACTIVATES nothing: no connector runs because these tables exist; a run still requires the runner's operator
-- command + an approved, unexpired, claimed authorization + an acquired lock + every applicable kill switch enabled.
--
-- DESIGN (Ponytail: minimum tables for an explicit, enforceable lifecycle) — 6 tables:
--   connector_run_authorizations  the durable approval + full config binding + lifecycle (approval folded in: approved_by/at/reason)
--   connector_run_attempts        per-attempt execution + aggregate result (result folded in: no separate result table)
--   connector_run_locks           the distributed run lock: one row per (tenant, connector, provider), lease + fencing generation
--   connector_run_alerts          provider-neutral alert metadata (aggregate/sanitized only)
--   connector_schedule_policies   S2 schedule policy (disabled by default) + cadence/window/limits
--   connector_kill_switches       multi-layer kill switches (global/provider/environment/tenant/connector/schedule); fail-closed
--
-- SECURITY MODEL (mirrors 0041): request roles (anon/authenticated) get NOTHING (RLS-enabled + ZERO policies + revoke-all).
-- All mutation is via SECURITY DEFINER functions with a pinned empty search_path (schema-qualified). service_role executes the
-- ADMIN lifecycle (create/approve/cancel authorization; manage schedule-policy/kill-switch). connector_runner executes ONLY the
-- runner EXECUTION lifecycle (claim/lock/launch/result/reconcile) + narrow reads. Every mutation validates tenant+connector
-- ownership, provider, and (for the config-bound functions) the exact plan_hash/idempotency_key/credential_version/schema_version/
-- task-def family+revision/image_digest/discovery_only/promotion_disabled/one_shot; enforces lifecycle transitions; fails closed;
-- returns sanitized errors; prevents cross-tenant access, replay, and stale-fencing writes.
--
-- Migration-safety: CREATE TABLE/INDEX/FUNCTION + GRANT/REVOKE only — additive; no teardown, no row purge, no destructive ops.
-- microsoft_entra stays certificationOnly; RISK-007 remains OPEN; Phase C remains BLOCKED; staging only (never applied here).

begin;

-- ════════════════════════════════════════════ TABLES ════════════════════════════════════════════════════════════════

-- 1. AUTHORIZATION — the durable, human-approved run authorization + the exact config it binds.
create table if not exists public.connector_run_authorizations (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  connector_id uuid not null,
  provider text not null,
  plan_hash text not null,
  idempotency_key text not null,
  credential_version text not null,
  schema_version text not null,
  task_definition_family text not null,
  task_definition_revision integer not null,
  image_digest text not null,
  run_mode text not null,
  discovery_only boolean not null,
  promotion_disabled boolean not null,
  one_shot boolean not null,
  requested_by text not null,
  approved_by text,
  approval_reason text,
  approved_at timestamptz,
  expires_at timestamptz not null,
  status text not null default 'draft',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint cra_status_check check (status in (
    'draft','approved','claimed','launch_attempted','running','succeeded','failed','ambiguous','expired','cancelled','timed_out','blocked')),
  constraint cra_provider_len check (char_length(provider) between 1 and 128),
  constraint cra_plan_hash_len check (char_length(plan_hash) between 8 and 256),
  constraint cra_idem_len check (char_length(idempotency_key) between 8 and 256),
  constraint cra_run_mode_check check (run_mode in ('discovery_oneshot')),
  constraint cra_discovery_only_true check (discovery_only = true),          -- discovery-only is the ONLY authorized mode
  constraint cra_promotion_disabled_true check (promotion_disabled = true),  -- promotion is NEVER authorized
  constraint cra_one_shot_true check (one_shot = true),                      -- one-shot only
  constraint cra_idem_unique unique (idempotency_key),                        -- one idempotency key -> at most one authorization
  constraint cra_same_tenant_connector
    foreign key (connector_id, tenant_id) references public.connectors (id, tenant_id) on delete cascade
);
create index if not exists cra_owner_idx on public.connector_run_authorizations (tenant_id, connector_id, provider, status);
create index if not exists cra_plan_hash_idx on public.connector_run_authorizations (plan_hash);

-- 2. ATTEMPT — one execution attempt of an authorization + its aggregate, sanitized result.
create table if not exists public.connector_run_attempts (
  id uuid primary key default gen_random_uuid(),
  authorization_id uuid not null references public.connector_run_authorizations (id) on delete cascade,
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  connector_id uuid not null,
  provider text not null,
  attempt_number integer not null default 1,
  claimed_at timestamptz,
  claim_token_hash text,
  fencing_generation bigint,
  launch_attempted_at timestamptz,
  sanitized_task_id text,
  started_at timestamptz,
  finished_at timestamptz,
  result_status text,
  result_code text,
  records_seen integer,
  facts_written integer,
  pages_seen integer,
  retry_count integer not null default 0,
  throttle_count integer not null default 0,
  duration_ms integer,
  failure_category text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint crat_result_status_check check (result_status is null or result_status in (
    'running','succeeded','failed','ambiguous','timed_out')),
  constraint crat_sanitized_task_no_arn check (sanitized_task_id is null or sanitized_task_id not like 'arn:%'),
  constraint crat_attempt_unique unique (authorization_id, attempt_number),
  constraint crat_same_tenant_connector
    foreign key (connector_id, tenant_id) references public.connectors (id, tenant_id) on delete cascade
);
create index if not exists crat_owner_idx on public.connector_run_attempts (tenant_id, connector_id, provider);
create index if not exists crat_active_idx on public.connector_run_attempts (connector_id, result_status)
  where result_status = 'running';

-- 3. LOCK — the distributed run lock: at most one row per (tenant, connector, provider); lease + monotonic fencing generation.
create table if not exists public.connector_run_locks (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  connector_id uuid not null,
  provider text not null,
  generation bigint not null default 0,          -- monotonic fencing token; increments on every (re)acquire
  holder_authorization_id uuid references public.connector_run_authorizations (id) on delete set null,
  holder_attempt_id uuid references public.connector_run_attempts (id) on delete set null,
  acquired_at timestamptz,
  lease_expires_at timestamptz,
  released_at timestamptz,
  status text not null default 'released',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint crl_status_check check (status in ('held','released','expired')),
  constraint crl_one_per_connector unique (tenant_id, connector_id, provider),
  constraint crl_same_tenant_connector
    foreign key (connector_id, tenant_id) references public.connectors (id, tenant_id) on delete cascade
);

-- 4. ALERT — provider-neutral, aggregate/sanitized alert metadata (NEVER a secret/token/PII/raw payload).
create table if not exists public.connector_run_alerts (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  connector_id uuid not null,
  provider text not null,
  authorization_id uuid references public.connector_run_authorizations (id) on delete set null,
  attempt_id uuid references public.connector_run_attempts (id) on delete set null,
  severity text not null,
  category text not null,
  sanitized_summary text not null,
  created_at timestamptz not null default now(),
  acknowledged_at timestamptz,
  constraint crn_severity_check check (severity in ('info','warning','error','critical')),
  constraint crn_summary_len check (char_length(sanitized_summary) between 1 and 512),
  constraint crn_same_tenant_connector
    foreign key (connector_id, tenant_id) references public.connectors (id, tenant_id) on delete cascade
);
create index if not exists crn_owner_idx on public.connector_run_alerts (tenant_id, connector_id, created_at);

-- 5. SCHEDULE POLICY — S2 scheduled-run policy; DISABLED by default (enabled=false is the schedule kill switch).
create table if not exists public.connector_schedule_policies (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  connector_id uuid not null,
  provider text not null,
  enabled boolean not null default false,        -- fail-closed: a policy launches nothing until explicitly enabled
  min_cadence_seconds integer not null default 3600,
  max_cadence_seconds integer not null default 86400,
  window_start time,
  window_end time,
  max_concurrent_runs integer not null default 1,
  max_pages integer not null default 200,
  max_records integer not null default 100000,
  max_runtime_seconds integer not null default 300,
  retry_budget integer not null default 2,
  synthetic_only boolean not null default true,  -- staging synthetic tenants only until a future customer gate
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint csp_cadence_check check (min_cadence_seconds >= 300 and max_cadence_seconds >= min_cadence_seconds),
  constraint csp_concurrency_check check (max_concurrent_runs = 1),          -- zero overlapping runs
  constraint csp_limits_check check (max_pages between 1 and 1000 and max_records between 1 and 1000000 and max_runtime_seconds between 30 and 900),
  constraint csp_one_per_connector unique (tenant_id, connector_id, provider),
  constraint csp_same_tenant_connector
    foreign key (connector_id, tenant_id) references public.connectors (id, tenant_id) on delete cascade
);

-- 6. KILL SWITCHES — multi-layer; fail-closed (execution permitted ONLY when the global switch is explicitly enabled AND no
--    applicable layer is disabled). scope_key: '*' for global, else the provider / environment / tenant-id / connector-id.
create table if not exists public.connector_kill_switches (
  id uuid primary key default gen_random_uuid(),
  scope text not null,
  scope_key text not null default '*',
  enabled boolean not null default false,
  reason text,
  updated_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint cks_scope_check check (scope in ('global','provider','environment','tenant','connector','schedule')),
  constraint cks_scope_unique unique (scope, scope_key)
);

-- ─────────────────────────────── RLS: request roles get NOTHING (deny-all: RLS on + zero policies + revoke) ──────────────
alter table public.connector_run_authorizations enable row level security;
alter table public.connector_run_attempts       enable row level security;
alter table public.connector_run_locks          enable row level security;
alter table public.connector_run_alerts         enable row level security;
alter table public.connector_schedule_policies  enable row level security;
alter table public.connector_kill_switches      enable row level security;

revoke all on public.connector_run_authorizations from anon, authenticated;
revoke all on public.connector_run_attempts       from anon, authenticated;
revoke all on public.connector_run_locks          from anon, authenticated;
revoke all on public.connector_run_alerts         from anon, authenticated;
revoke all on public.connector_schedule_policies  from anon, authenticated;
revoke all on public.connector_kill_switches      from anon, authenticated;
-- connector_runner reaches these tables ONLY through the EXECUTE-granted functions below (never direct DML).
revoke all on public.connector_run_authorizations from connector_runner;
revoke all on public.connector_run_attempts       from connector_runner;
revoke all on public.connector_run_locks          from connector_runner;
revoke all on public.connector_run_alerts         from connector_runner;
revoke all on public.connector_schedule_policies  from connector_runner;
revoke all on public.connector_kill_switches      from connector_runner;

commit;

-- ════════════════════════════════════════════ FUNCTIONS ═════════════════════════════════════════════════════════════
-- All SECURITY DEFINER, pinned empty search_path (schema-qualified). Fail-closed; sanitized errors; tenant/connector/provider +
-- exact-config validation; lifecycle-enforced; fencing-protected. service_role = admin lifecycle; connector_runner = execution.

begin;

-- ── KILL SWITCH: fail-closed. Permitted ONLY when the global switch is explicitly enabled AND no applicable layer is disabled. ─
create or replace function public.connector_execution_permitted(
  p_tenant_id uuid, p_connector_id uuid, p_provider text, p_environment text
) returns boolean language plpgsql security definer set search_path = '' as $$
begin
  if not exists (select 1 from public.connector_kill_switches where scope='global' and enabled=true) then
    return false; -- fail closed: execution must be explicitly enabled globally
  end if;
  if exists (
    select 1 from public.connector_kill_switches
     where enabled = false and (
       (scope='provider'    and scope_key = p_provider) or
       (scope='environment' and scope_key = p_environment) or
       (scope='tenant'      and scope_key = p_tenant_id::text) or
       (scope='connector'   and scope_key = p_connector_id::text))
  ) then
    return false; -- any applicable layer disabled -> blocked
  end if;
  return true;
end; $$;

-- ── ADMIN: create a draft authorization (service_role only). CHECK constraints enforce discovery_only/promotion_disabled/one_shot. ─
create or replace function public.admin_create_run_authorization(
  p_tenant_id uuid, p_connector_id uuid, p_provider text, p_plan_hash text, p_idempotency_key text,
  p_credential_version text, p_schema_version text, p_task_family text, p_task_revision integer, p_image_digest text,
  p_requested_by text, p_expires_at timestamptz
) returns uuid language plpgsql security definer set search_path = '' as $$
declare v_id uuid;
begin
  if not exists (select 1 from public.connectors c where c.id=p_connector_id and c.tenant_id=p_tenant_id and c.provider=p_provider and c.status='active') then
    raise exception 'authorization target is not an active owned connector';
  end if;
  insert into public.connector_run_authorizations (
    tenant_id, connector_id, provider, plan_hash, idempotency_key, credential_version, schema_version,
    task_definition_family, task_definition_revision, image_digest, run_mode, discovery_only, promotion_disabled,
    one_shot, requested_by, expires_at, status
  ) values (
    p_tenant_id, p_connector_id, p_provider, p_plan_hash, p_idempotency_key, p_credential_version, p_schema_version,
    p_task_family, p_task_revision, p_image_digest, 'discovery_oneshot', true, true, true, p_requested_by, p_expires_at, 'draft'
  ) returning id into v_id;
  return v_id;
end; $$;

create or replace function public.admin_approve_run_authorization(
  p_id uuid, p_approved_by text, p_reason text
) returns void language plpgsql security definer set search_path = '' as $$
begin
  update public.connector_run_authorizations
     set status='approved', approved_by=p_approved_by, approval_reason=p_reason, approved_at=now(), updated_at=now()
   where id=p_id and status='draft' and expires_at > now();
  if not found then raise exception 'authorization not approvable (missing / not draft / expired)'; end if;
end; $$;

create or replace function public.admin_cancel_run_authorization(p_id uuid, p_by text, p_reason text)
returns void language plpgsql security definer set search_path = '' as $$
begin
  update public.connector_run_authorizations
     set status='cancelled', approval_reason=coalesce(p_reason, approval_reason), approved_by=coalesce(approved_by,p_by), updated_at=now()
   where id=p_id and status in ('draft','approved');
  if not found then raise exception 'authorization not cancellable (missing / already claimed or terminal)'; end if;
end; $$;

create or replace function public.admin_expire_stale_authorizations() returns integer
language plpgsql security definer set search_path = '' as $$
declare v_n integer;
begin
  update public.connector_run_authorizations set status='expired', updated_at=now()
   where status in ('draft','approved') and expires_at <= now();
  get diagnostics v_n = row_count; return v_n;
end; $$;

create or replace function public.admin_upsert_schedule_policy(
  p_tenant_id uuid, p_connector_id uuid, p_provider text, p_enabled boolean
) returns uuid language plpgsql security definer set search_path = '' as $$
declare v_id uuid;
begin
  if not exists (select 1 from public.connectors c where c.id=p_connector_id and c.tenant_id=p_tenant_id and c.provider=p_provider) then
    raise exception 'schedule policy target is not an owned connector';
  end if;
  insert into public.connector_schedule_policies (tenant_id, connector_id, provider, enabled)
    values (p_tenant_id, p_connector_id, p_provider, coalesce(p_enabled,false))
  on conflict (tenant_id, connector_id, provider) do update set enabled=excluded.enabled, updated_at=now()
  returning id into v_id;
  return v_id;
end; $$;

create or replace function public.admin_upsert_kill_switch(p_scope text, p_scope_key text, p_enabled boolean, p_by text, p_reason text)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_id uuid;
begin
  insert into public.connector_kill_switches (scope, scope_key, enabled, updated_by, reason)
    values (p_scope, coalesce(p_scope_key,'*'), coalesce(p_enabled,false), p_by, p_reason)
  on conflict (scope, scope_key) do update set enabled=excluded.enabled, updated_by=excluded.updated_by, reason=excluded.reason, updated_at=now()
  returning id into v_id;
  return v_id;
end; $$;

-- ── RUNNER: read one authorization for plan-mode validation (NO claim / NO write). Full exact-config + ownership match. ──
create or replace function public.runner_read_authorization(
  p_id uuid, p_tenant_id uuid, p_connector_id uuid, p_provider text, p_plan_hash text, p_idempotency_key text,
  p_credential_version text, p_schema_version text, p_task_family text, p_task_revision integer, p_image_digest text
) returns text language plpgsql security definer set search_path = '' as $$
declare v_status text;
begin
  select status into v_status from public.connector_run_authorizations
   where id=p_id and tenant_id=p_tenant_id and connector_id=p_connector_id and provider=p_provider
     and plan_hash=p_plan_hash and idempotency_key=p_idempotency_key and credential_version=p_credential_version
     and schema_version=p_schema_version and task_definition_family=p_task_family
     and task_definition_revision=p_task_revision and image_digest=p_image_digest
     and discovery_only=true and promotion_disabled=true and one_shot=true;
  if v_status is null then raise exception 'no matching authorization'; end if; -- sanitized: no config echoed
  return v_status; -- 'approved' (+ unexpired, checked by caller/claim) means a valid matching approval exists
end; $$;

-- ── RUNNER: assert no active run already exists for this connector (fail closed before claim). ──
create or replace function public.runner_assert_no_active_run(p_tenant_id uuid, p_connector_id uuid, p_provider text)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if exists (select 1 from public.connector_run_authorizations
              where tenant_id=p_tenant_id and connector_id=p_connector_id and provider=p_provider
                and status in ('claimed','launch_attempted','running')) then
    raise exception 'an active run authorization already exists for this connector';
  end if;
  if exists (select 1 from public.connector_run_attempts
              where tenant_id=p_tenant_id and connector_id=p_connector_id and result_status='running') then
    raise exception 'an attempt is already running for this connector';
  end if;
end; $$;

-- ── RUNNER: atomically CLAIM an approved authorization exactly once (replay/one-claim guard) + open attempt #1. ──
create or replace function public.runner_claim_authorization(
  p_id uuid, p_tenant_id uuid, p_connector_id uuid, p_provider text, p_plan_hash text, p_idempotency_key text,
  p_credential_version text, p_schema_version text, p_task_family text, p_task_revision integer, p_image_digest text,
  p_claim_token_hash text
) returns uuid language plpgsql security definer set search_path = '' as $$
declare v_attempt uuid;
begin
  perform public.runner_assert_no_active_run(p_tenant_id, p_connector_id, p_provider);
  -- atomic transition approved -> claimed with the FULL exact-config match; not-found = expired/cancelled/already-claimed/mismatch
  update public.connector_run_authorizations set status='claimed', updated_at=now()
   where id=p_id and status='approved' and expires_at > now()
     and tenant_id=p_tenant_id and connector_id=p_connector_id and provider=p_provider and plan_hash=p_plan_hash
     and idempotency_key=p_idempotency_key and credential_version=p_credential_version and schema_version=p_schema_version
     and task_definition_family=p_task_family and task_definition_revision=p_task_revision and image_digest=p_image_digest
     and discovery_only=true and promotion_disabled=true and one_shot=true;
  if not found then raise exception 'authorization not claimable (missing / not approved / expired / config mismatch)'; end if;
  insert into public.connector_run_attempts (authorization_id, tenant_id, connector_id, provider, attempt_number, claimed_at, claim_token_hash)
    values (p_id, p_tenant_id, p_connector_id, p_provider, 1, now(), p_claim_token_hash)
  returning id into v_attempt;
  return v_attempt;
end; $$;

-- ── RUNNER: distributed lock — atomic acquire (with expired-lease takeover) + fencing generation increment. ──
create or replace function public.runner_acquire_lock(
  p_tenant_id uuid, p_connector_id uuid, p_provider text, p_authorization_id uuid, p_attempt_id uuid, p_lease_seconds integer
) returns bigint language plpgsql security definer set search_path = '' as $$
declare v_gen bigint;
begin
  insert into public.connector_run_locks (tenant_id, connector_id, provider, generation, holder_authorization_id, holder_attempt_id, acquired_at, lease_expires_at, status)
    values (p_tenant_id, p_connector_id, p_provider, 1, p_authorization_id, p_attempt_id, now(), now() + make_interval(secs => p_lease_seconds), 'held')
  on conflict (tenant_id, connector_id, provider) do update
    set generation = public.connector_run_locks.generation + 1, holder_authorization_id = excluded.holder_authorization_id,
        holder_attempt_id = excluded.holder_attempt_id, acquired_at = now(), lease_expires_at = excluded.lease_expires_at,
        released_at = null, status='held', updated_at=now()
    where public.connector_run_locks.status <> 'held' or public.connector_run_locks.lease_expires_at <= now() -- takeover only if free/expired
  returning generation into v_gen;
  if v_gen is null then raise exception 'lock is held (concurrent run)'; end if; -- currently held + lease valid -> conflict
  update public.connector_run_attempts set fencing_generation = v_gen, updated_at=now() where id=p_attempt_id;
  return v_gen;
end; $$;

-- ── RUNNER: fencing guard used by every result-writing function — the caller's generation MUST equal the lock's current gen. ──
create or replace function public.runner_assert_fencing(p_attempt_id uuid, p_generation bigint)
returns void language plpgsql security definer set search_path = '' as $$
declare v_ok boolean;
begin
  select (l.generation = p_generation and l.status='held' and l.lease_expires_at > now() and a.fencing_generation = p_generation)
    into v_ok
    from public.connector_run_attempts a
    join public.connector_run_locks l on l.tenant_id=a.tenant_id and l.connector_id=a.connector_id and l.provider=a.provider
   where a.id=p_attempt_id;
  if v_ok is not true then raise exception 'stale fencing token (lost the lock)'; end if;
end; $$;

create or replace function public.runner_renew_lock(p_attempt_id uuid, p_generation bigint, p_lease_seconds integer)
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform public.runner_assert_fencing(p_attempt_id, p_generation);
  update public.connector_run_locks l set lease_expires_at = now() + make_interval(secs => p_lease_seconds), updated_at=now()
    from public.connector_run_attempts a
   where a.id=p_attempt_id and l.tenant_id=a.tenant_id and l.connector_id=a.connector_id and l.provider=a.provider and l.generation=p_generation;
end; $$;

create or replace function public.runner_release_lock(p_attempt_id uuid, p_generation bigint)
returns void language plpgsql security definer set search_path = '' as $$
begin
  update public.connector_run_locks l set status='released', released_at=now(), holder_attempt_id=null, updated_at=now()
    from public.connector_run_attempts a
   where a.id=p_attempt_id and l.tenant_id=a.tenant_id and l.connector_id=a.connector_id and l.provider=a.provider and l.generation=p_generation and l.status='held';
  -- a stale holder (wrong generation) silently affects 0 rows — it cannot release a lock it no longer owns
end; $$;

-- ── RUNNER: lifecycle result writers — each fencing-guarded; each enforces the valid prior state; completed = immutable. ──
create or replace function public.runner_mark_launch_attempted(p_attempt_id uuid, p_generation bigint)
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform public.runner_assert_fencing(p_attempt_id, p_generation);
  update public.connector_run_attempts set launch_attempted_at=now(), updated_at=now() where id=p_attempt_id and launch_attempted_at is null;
  if not found then raise exception 'launch already attempted (no double launch)'; end if;
  update public.connector_run_authorizations a set status='launch_attempted', updated_at=now()
    from public.connector_run_attempts t where t.id=p_attempt_id and a.id=t.authorization_id and a.status='claimed';
end; $$;

create or replace function public.runner_record_task_identity(p_attempt_id uuid, p_generation bigint, p_sanitized_task_id text)
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform public.runner_assert_fencing(p_attempt_id, p_generation);
  if p_sanitized_task_id like 'arn:%' then raise exception 'task id must be sanitized (no ARN)'; end if;
  update public.connector_run_attempts set sanitized_task_id=p_sanitized_task_id, updated_at=now() where id=p_attempt_id;
end; $$;

create or replace function public.runner_record_start(p_attempt_id uuid, p_generation bigint)
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform public.runner_assert_fencing(p_attempt_id, p_generation);
  update public.connector_run_attempts set started_at=now(), result_status='running', updated_at=now() where id=p_attempt_id and result_status is null;
  update public.connector_run_authorizations a set status='running', updated_at=now()
    from public.connector_run_attempts t where t.id=p_attempt_id and a.id=t.authorization_id and a.status='launch_attempted';
end; $$;

-- terminal writers (succeeded/failed/timed_out): fencing-guarded, from a non-terminal attempt, then release the lock atomically.
create or replace function public.runner_record_success(
  p_attempt_id uuid, p_generation bigint, p_records_seen integer, p_facts_written integer, p_pages_seen integer, p_duration_ms integer
) returns void language plpgsql security definer set search_path = '' as $$
begin
  perform public.runner_assert_fencing(p_attempt_id, p_generation);
  update public.connector_run_attempts set result_status='succeeded', finished_at=now(), records_seen=p_records_seen,
         facts_written=p_facts_written, pages_seen=p_pages_seen, duration_ms=p_duration_ms, updated_at=now()
   where id=p_attempt_id and result_status in ('running');
  if not found then raise exception 'attempt not in a finalizable running state'; end if;
  update public.connector_run_authorizations a set status='succeeded', updated_at=now()
    from public.connector_run_attempts t where t.id=p_attempt_id and a.id=t.authorization_id;
  perform public.runner_release_lock(p_attempt_id, p_generation);
end; $$;

create or replace function public.runner_record_failure(
  p_attempt_id uuid, p_generation bigint, p_failure_category text, p_result_code text, p_duration_ms integer
) returns void language plpgsql security definer set search_path = '' as $$
begin
  perform public.runner_assert_fencing(p_attempt_id, p_generation);
  update public.connector_run_attempts set result_status='failed', finished_at=now(), failure_category=p_failure_category,
         result_code=p_result_code, duration_ms=p_duration_ms, updated_at=now()
   where id=p_attempt_id and result_status in ('running');
  if not found then raise exception 'attempt not in a finalizable running state'; end if;
  update public.connector_run_authorizations a set status='failed', updated_at=now()
    from public.connector_run_attempts t where t.id=p_attempt_id and a.id=t.authorization_id;
  perform public.runner_release_lock(p_attempt_id, p_generation);
end; $$;

create or replace function public.runner_record_timeout(p_attempt_id uuid, p_generation bigint, p_duration_ms integer)
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform public.runner_assert_fencing(p_attempt_id, p_generation);
  update public.connector_run_attempts set result_status='timed_out', finished_at=now(), failure_category='timeout', duration_ms=p_duration_ms, updated_at=now()
   where id=p_attempt_id and result_status in ('running');
  if not found then raise exception 'attempt not in a finalizable running state'; end if;
  update public.connector_run_authorizations a set status='timed_out', updated_at=now()
    from public.connector_run_attempts t where t.id=p_attempt_id and a.id=t.authorization_id;
  perform public.runner_release_lock(p_attempt_id, p_generation);
end; $$;

-- ambiguous launch: DURABLE state that blocks automatic retry; release the lock but leave the authorization 'ambiguous'
-- (not 'approved') so it can never be re-claimed — only an admin may investigate/annotate.
create or replace function public.runner_record_ambiguous(p_attempt_id uuid, p_generation bigint, p_result_code text)
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform public.runner_assert_fencing(p_attempt_id, p_generation);
  update public.connector_run_attempts set result_status='ambiguous', finished_at=now(), failure_category='ambiguous_launch',
         result_code=p_result_code, updated_at=now()
   where id=p_attempt_id and result_status is distinct from 'succeeded' and result_status is distinct from 'failed';
  update public.connector_run_authorizations a set status='ambiguous', updated_at=now()
    from public.connector_run_attempts t where t.id=p_attempt_id and a.id=t.authorization_id;
  perform public.runner_release_lock(p_attempt_id, p_generation);
end; $$;

-- reconcile: idempotent safe-audit annotation of aggregate metadata on a terminal attempt (duplicate reconcile is a no-op).
create or replace function public.runner_reconcile_result(
  p_attempt_id uuid, p_records_seen integer, p_facts_written integer, p_pages_seen integer, p_retry_count integer, p_throttle_count integer
) returns void language plpgsql security definer set search_path = '' as $$
begin
  update public.connector_run_attempts
     set records_seen=coalesce(records_seen,p_records_seen), facts_written=coalesce(facts_written,p_facts_written),
         pages_seen=coalesce(pages_seen,p_pages_seen), retry_count=greatest(retry_count,coalesce(p_retry_count,0)),
         throttle_count=greatest(throttle_count,coalesce(p_throttle_count,0)), updated_at=now()
   where id=p_attempt_id and result_status in ('succeeded','failed','timed_out','ambiguous'); -- terminal only; idempotent
end; $$;

create or replace function public.runner_record_alert(
  p_tenant_id uuid, p_connector_id uuid, p_provider text, p_authorization_id uuid, p_attempt_id uuid,
  p_severity text, p_category text, p_summary text
) returns uuid language plpgsql security definer set search_path = '' as $$
declare v_id uuid;
begin
  -- defense in depth: refuse an obviously-sensitive summary (a secret/token/ARN/DB-URL shape)
  if p_summary ~* '(arn:aws|eyj[a-z0-9]|bearer |access_token|client_secret|postgres://|@[a-z0-9.-]+\.(com|net))' then
    raise exception 'alert summary must be sanitized';
  end if;
  insert into public.connector_run_alerts (tenant_id, connector_id, provider, authorization_id, attempt_id, severity, category, sanitized_summary)
    values (p_tenant_id, p_connector_id, p_provider, p_authorization_id, p_attempt_id, p_severity, p_category, p_summary)
  returning id into v_id;
  return v_id;
end; $$;

create or replace function public.runner_latest_run_state(p_tenant_id uuid, p_connector_id uuid, p_provider text)
returns text language plpgsql security definer set search_path = '' as $$
declare v_status text;
begin
  select status into v_status from public.connector_run_authorizations
   where tenant_id=p_tenant_id and connector_id=p_connector_id and provider=p_provider
   order by created_at desc limit 1;
  return coalesce(v_status, 'none');
end; $$;

-- ── GRANTS: EXECUTE revoked from PUBLIC; admin lifecycle -> service_role; execution lifecycle -> connector_runner. ─────────
revoke all on function
  public.admin_create_run_authorization(uuid,uuid,text,text,text,text,text,text,integer,text,text,timestamptz),
  public.admin_approve_run_authorization(uuid,text,text), public.admin_cancel_run_authorization(uuid,text,text),
  public.admin_expire_stale_authorizations(), public.admin_upsert_schedule_policy(uuid,uuid,text,boolean),
  public.admin_upsert_kill_switch(text,text,boolean,text,text),
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
  from public;

grant execute on function
  public.admin_create_run_authorization(uuid,uuid,text,text,text,text,text,text,integer,text,text,timestamptz),
  public.admin_approve_run_authorization(uuid,text,text), public.admin_cancel_run_authorization(uuid,text,text),
  public.admin_expire_stale_authorizations(), public.admin_upsert_schedule_policy(uuid,uuid,text,boolean),
  public.admin_upsert_kill_switch(text,text,boolean,text,text)
  to service_role;

grant execute on function
  public.connector_execution_permitted(uuid,uuid,text,text),
  public.runner_read_authorization(uuid,uuid,uuid,text,text,text,text,text,text,integer,text),
  public.runner_assert_no_active_run(uuid,uuid,text),
  public.runner_claim_authorization(uuid,uuid,uuid,text,text,text,text,text,text,integer,text,text),
  public.runner_acquire_lock(uuid,uuid,text,uuid,uuid,integer),
  public.runner_renew_lock(uuid,bigint,integer), public.runner_release_lock(uuid,bigint),
  public.runner_mark_launch_attempted(uuid,bigint), public.runner_record_task_identity(uuid,bigint,text),
  public.runner_record_start(uuid,bigint), public.runner_record_success(uuid,bigint,integer,integer,integer,integer),
  public.runner_record_failure(uuid,bigint,text,text,integer), public.runner_record_timeout(uuid,bigint,integer),
  public.runner_record_ambiguous(uuid,bigint,text), public.runner_reconcile_result(uuid,integer,integer,integer,integer,integer),
  public.runner_record_alert(uuid,uuid,text,uuid,uuid,text,text,text), public.runner_latest_run_state(uuid,uuid,text)
  to connector_runner;
-- internal fencing helper: not granted to connector_runner directly (called only via SECURITY DEFINER siblings, definer=owner).

commit;
