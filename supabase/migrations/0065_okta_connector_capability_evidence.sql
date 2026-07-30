-- 0065 — O2C.3: per-capability validation evidence, and the contract pin move to 1.2.0.
--
-- WHY A TABLE AND NOT THREE BOOLEANS. 0064 records ONE validation outcome, which was right when there was one thing to prove.
-- There are now three read scopes, each proven by its own live call, and collapsing them into a single status would lose exactly
-- the fact that matters: WHICH scope was actually exercised. "The connector is verified" must never be able to mean "we tried
-- users and assumed the rest."
--
-- Each row binds its capability to a server-generated run, the active KID and the contract version it was proven under, so a
-- capability cannot borrow another's evidence.
--
-- ADDITIVE. Creates one table and one function, moves one pinned constant, and backfills the users_read row that the O2C.2 run
-- already earned. Drops nothing, widens no grant.

-- ── (a) The capability-evidence table ----------------------------------------------------------------------------------
create table public.okta_connector_capability_evidence (
  id                 uuid primary key default gen_random_uuid(),
  tenant_id          uuid not null references public.tenants(id) on delete cascade,
  connector_id       uuid not null,
  provider           text not null default 'okta',
  capability         text not null,
  status             text not null,
  verified_kid       text,
  contract_version   text,
  validation_run_id  uuid,
  error_category     text,
  first_verified_at  timestamptz,
  last_attempt_at    timestamptz not null default now(),
  last_verified_at   timestamptz,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),

  -- The connector must belong to the tenant on the row. Composite FK, so a row cannot be attached to another tenant's connector.
  constraint okta_cap_connector_tenant_fk foreign key (connector_id, tenant_id)
    references public.connectors (id, tenant_id) on delete cascade,

  -- ONE row per capability per connector. This is what makes replay idempotent and makes "which scopes are proven" a lookup
  -- rather than a reduction over history.
  constraint okta_cap_unique unique (connector_id, capability),

  constraint okta_cap_provider_chk   check (provider = 'okta'),
  constraint okta_cap_vocab_chk      check (capability in ('users_read', 'groups_read', 'apps_read')),
  constraint okta_cap_status_chk     check (status in ('verified', 'failed')),

  -- Bounded categories only — the same set 0063 pins, so a category cannot be introduced here that the rest of the system
  -- does not understand.
  constraint okta_cap_error_chk check (error_category is null or error_category in (
    'invalid_domain', 'invalid_client', 'invalid_key', 'invalid_scope', 'permission_insufficient',
    'wrong_organization', 'network_failure', 'rate_limited', 'provider_error', 'unsupported_custom_domain')),

  -- The pinned KID, as an INDEPENDENT enforcement point (as 0064 does). Not even a superuser can record a different one.
  constraint okta_cap_kid_chk check (
    verified_kid is null or verified_kid = 'p7AyvDK0yI95_HdQBxdhBSOTt9mMYPczGL-4USxaMto'),

  -- Verified is ALL-OR-NOTHING: no capability may claim success without the full evidence package.
  constraint okta_cap_verified_evidence_chk check (
    status <> 'verified' or (
      verified_kid is not null and contract_version is not null
      and validation_run_id is not null and last_verified_at is not null and error_category is null)),

  -- A failed row carries a category and NO success evidence of its own.
  constraint okta_cap_failed_shape_chk check (
    status <> 'failed' or error_category is not null)
);

create index okta_cap_tenant_connector_idx on public.okta_connector_capability_evidence (tenant_id, connector_id);

comment on table public.okta_connector_capability_evidence is
  'One row per proven-or-failed Okta read capability. Written ONLY by connector_runner through '
  'runner_record_okta_capability_evidence. A capability is verified only with a run, KID and contract version of its own.';

-- ── (b) RLS: tenant-scoped read, no write path for any request role -----------------------------------------------------
alter table public.okta_connector_capability_evidence enable row level security;

create policy okta_cap_select_tenant_members
  on public.okta_connector_capability_evidence
  for select to authenticated
  using (public.has_tenant_role(tenant_id, array['owner', 'admin', 'editor', 'viewer']));

-- SELECT only. No insert/update/delete policy and no write grant: writes go exclusively through the runner-only function below.
grant select on public.okta_connector_capability_evidence to authenticated;

-- ── (c) Audit, DB-side so it cannot be skipped by any caller ------------------------------------------------------------
create or replace function public.audit_okta_capability_evidence_write()
  returns trigger
  language plpgsql
  security definer
  set search_path = ''
as $$
begin
  insert into public.audit_logs (tenant_id, actor_user_id, action, resource_type, resource_id, after_json)
  values (
    new.tenant_id,
    auth.uid(),   -- NULL for a runner-produced result: the producer is a machine role, not a person.
    case when new.status = 'verified' then 'okta_connector_capability_verified'
         else 'okta_connector_capability_failed' end,
    'okta_connector_capability_evidence',
    new.id,
    -- BOUNDED, non-secret projection. No token, assertion, signature, digest, provider body or provider object.
    jsonb_build_object(
      'connector_id', new.connector_id,
      'provider', new.provider,
      'capability', new.capability,
      'status', new.status,
      'verified_kid', new.verified_kid,
      'contract_version', new.contract_version,
      'validation_run_id', new.validation_run_id,
      'error_category', new.error_category
    )
  );
  return new;
end;
$$;

create trigger okta_capability_evidence_audit
  after insert or update on public.okta_connector_capability_evidence
  for each row execute function public.audit_okta_capability_evidence_write();

-- ── (d) The ONLY write path -----------------------------------------------------------------------------------------
-- Mirrors 0064: run must be server-generated and bound to this connector AND tenant; KID and contract version are pinned and the
-- value WRITTEN is the constant, not the argument; timestamps are now(); the caller names no other authority.
--
-- A FAILED capability updates only its OWN row. It cannot touch another capability's evidence, so a groups failure can never
-- erase a users success — that isolation is the reason one row per capability exists.
create or replace function public.runner_record_okta_capability_evidence(
  p_tenant_id uuid,
  p_connector_id uuid,
  p_run_id uuid,
  p_capability text,
  p_outcome text,                      -- 'verified' | 'failed'
  p_verified_kid text,
  p_contract_version text,
  p_error_category text default null
) returns jsonb
  language plpgsql
  security definer
  set search_path = ''
as $$
declare
  c_kid      constant text := 'p7AyvDK0yI95_HdQBxdhBSOTt9mMYPczGL-4USxaMto';
  c_contract constant text := '1.2.0';
  v_row public.okta_connector_capability_evidence%rowtype;
begin
  if p_capability is null or p_capability not in ('users_read', 'groups_read', 'apps_read') then
    raise exception 'unknown capability' using errcode = '22023';
  end if;
  if p_outcome is null or p_outcome not in ('verified', 'failed') then
    raise exception 'outcome must be verified or failed' using errcode = '22023';
  end if;

  -- The anti-forgery binding: a real, server-generated run for THIS connector and THIS tenant.
  if p_run_id is null or not exists (
    select 1 from public.connector_runs r
    where r.id = p_run_id and r.connector_id = p_connector_id and r.tenant_id = p_tenant_id
  ) then
    raise exception 'run % is not a run of connector % for tenant %', p_run_id, p_connector_id, p_tenant_id
      using errcode = '42501';
  end if;

  if not exists (
    select 1 from public.okta_connector_configs k
    where k.connector_id = p_connector_id and k.tenant_id = p_tenant_id and k.provider = 'okta' and k.disabled_at is null
  ) then
    raise exception 'no active okta configuration for connector %', p_connector_id using errcode = '42501';
  end if;

  if p_verified_kid is distinct from c_kid then
    raise exception 'result kid does not match the active contract kid' using errcode = '22023';
  end if;
  if p_contract_version is distinct from c_contract then
    raise exception 'result contract version does not match the active contract version' using errcode = '22023';
  end if;

  select * into v_row from public.okta_connector_capability_evidence
    where connector_id = p_connector_id and capability = p_capability;

  -- IDEMPOTENT REPLAY: the same run for the same capability performs NO write, so no second audit and no timestamp drift.
  if found and v_row.validation_run_id is not null and v_row.validation_run_id = p_run_id then
    return jsonb_build_object('outcome', 'idempotent_replay', 'capability', v_row.capability,
      'status', v_row.status, 'validation_run_id', v_row.validation_run_id);
  end if;

  -- A late or stale failure must not demote an established capability, for the same reason as 0064.
  if found and v_row.status = 'verified' and p_outcome = 'failed' then
    raise exception 'refusing to demote a verified capability with run %', p_run_id using errcode = '22023';
  end if;

  if p_outcome = 'verified' then
    if p_error_category is not null then
      raise exception 'a verified capability carries no error category' using errcode = '22023';
    end if;
    insert into public.okta_connector_capability_evidence as e
      (tenant_id, connector_id, capability, status, verified_kid, contract_version, validation_run_id,
       error_category, first_verified_at, last_attempt_at, last_verified_at)
    values (p_tenant_id, p_connector_id, p_capability, 'verified', c_kid, c_contract, p_run_id,
       null, now(), now(), now())
    on conflict (connector_id, capability) do update set
      status = 'verified', verified_kid = c_kid, contract_version = c_contract,
      validation_run_id = p_run_id, error_category = null,
      first_verified_at = coalesce(e.first_verified_at, now()),   -- the ORIGINAL proof date is never overwritten
      last_attempt_at = now(), last_verified_at = now(), updated_at = now();
  else
    if p_error_category is null then
      raise exception 'a failed capability requires a bounded error category' using errcode = '22023';
    end if;
    insert into public.okta_connector_capability_evidence as e
      (tenant_id, connector_id, capability, status, error_category, last_attempt_at)
    values (p_tenant_id, p_connector_id, p_capability, 'failed', p_error_category, now())
    on conflict (connector_id, capability) do update set
      status = 'failed', error_category = p_error_category, last_attempt_at = now(), updated_at = now();
      -- This branch can only ever run on a row that is NOT verified: the demotion guard above refuses verified -> failed
      -- outright, so a proven capability never reaches here. Erasure of verified evidence is therefore prevented one level
      -- earlier than this UPDATE, which is why this statement touches no verified_* column — there is none to preserve.
  end if;

  select * into v_row from public.okta_connector_capability_evidence
    where connector_id = p_connector_id and capability = p_capability;
  return jsonb_build_object('outcome', 'recorded', 'capability', v_row.capability, 'status', v_row.status,
    'validation_run_id', v_row.validation_run_id, 'contract_version', v_row.contract_version);
end;
$$;

-- Runner-only. `revoke ... from public` alone is NOT sufficient on Supabase — ALTER DEFAULT PRIVILEGES grants EXECUTE on new
-- public functions to anon/authenticated/service_role as EXPLICIT grantees. Each is named. (0064 learned this the hard way: its
-- first test run showed an OWNER recording a result.)
revoke all on function public.runner_record_okta_capability_evidence(uuid, uuid, uuid, text, text, text, text, text) from public;
revoke all on function public.runner_record_okta_capability_evidence(uuid, uuid, uuid, text, text, text, text, text) from anon;
revoke all on function public.runner_record_okta_capability_evidence(uuid, uuid, uuid, text, text, text, text, text) from authenticated;
revoke all on function public.runner_record_okta_capability_evidence(uuid, uuid, uuid, text, text, text, text, text) from service_role;
grant execute on function public.runner_record_okta_capability_evidence(uuid, uuid, uuid, text, text, text, text, text) to connector_runner;

-- ── (e) Move the 0064 pin to 1.2.0 -------------------------------------------------------------------------------------
-- The contract artifact moves to 1.2.0 to record that live KID verification is complete, and this pin must move with it or every
-- future validation would fail at the boundary. Only the constant changes; the body is otherwise 0064's.
create or replace function public.runner_record_okta_connector_validation(
  p_tenant_id uuid, p_connector_id uuid, p_run_id uuid, p_outcome text, p_verified_kid text, p_contract_version text,
  p_organization_fingerprint text, p_service_app_fingerprint text, p_error_category text default null
) returns jsonb
  language plpgsql security definer set search_path = ''
as $$
declare
  c_kid      constant text := 'p7AyvDK0yI95_HdQBxdhBSOTt9mMYPczGL-4USxaMto';
  c_contract constant text := '1.2.0';
  v_cfg public.okta_connector_configs%rowtype;
begin
  if p_outcome is null or p_outcome not in ('succeeded', 'failed') then
    raise exception 'outcome must be succeeded or failed' using errcode = '22023';
  end if;
  if p_run_id is null or not exists (
    select 1 from public.connector_runs r
    where r.id = p_run_id and r.connector_id = p_connector_id and r.tenant_id = p_tenant_id
  ) then
    raise exception 'run % is not a run of connector % for tenant %', p_run_id, p_connector_id, p_tenant_id
      using errcode = '42501';
  end if;
  select * into v_cfg from public.okta_connector_configs
    where connector_id = p_connector_id and tenant_id = p_tenant_id;
  if not found then
    raise exception 'no okta configuration for connector % in tenant %', p_connector_id, p_tenant_id using errcode = '42501';
  end if;
  if v_cfg.provider <> 'okta' then
    raise exception 'connector % is not an okta connector', p_connector_id using errcode = '42501';
  end if;
  if v_cfg.disabled_at is not null then
    raise exception 'configuration for connector % is disabled', p_connector_id using errcode = '42501';
  end if;
  if p_verified_kid is distinct from c_kid then
    raise exception 'result kid does not match the active contract kid' using errcode = '22023';
  end if;
  if p_contract_version is distinct from c_contract then
    raise exception 'result contract version does not match the active contract version' using errcode = '22023';
  end if;
  if v_cfg.validation_run_id is not null and v_cfg.validation_run_id = p_run_id then
    return jsonb_build_object('outcome', 'idempotent_replay', 'connector_id', v_cfg.connector_id,
      'validation_status', v_cfg.validation_status, 'last_validated_at', v_cfg.last_validated_at,
      'verified_kid', v_cfg.signing_key_id, 'verified_contract_version', v_cfg.verified_contract_version,
      'fingerprint_version', v_cfg.fingerprint_version, 'validation_run_id', v_cfg.validation_run_id);
  end if;
  if v_cfg.validation_status = 'succeeded' and p_outcome = 'failed' then
    raise exception 'refusing to demote a succeeded validation with run %', p_run_id using errcode = '22023';
  end if;

  if p_outcome = 'succeeded' then
    if p_organization_fingerprint !~ '^[0-9a-f]{64}$' or p_service_app_fingerprint !~ '^[0-9a-f]{64}$' then
      raise exception 'malformed verified fingerprint' using errcode = '22023';
    end if;
    if p_error_category is not null then
      raise exception 'a succeeded result carries no error category' using errcode = '22023';
    end if;
    update public.okta_connector_configs set
      validation_status = 'succeeded', validation_error_category = null,
      last_validation_attempt_at = now(), last_validated_at = now(),
      verified_organization_fingerprint = p_organization_fingerprint,
      verified_service_app_fingerprint = p_service_app_fingerprint,
      signing_key_id = c_kid, verified_contract_version = c_contract,
      validation_run_id = p_run_id, updated_at = now()
    where id = v_cfg.id;
    update public.connectors set connection_state = 'verified', updated_at = now()
      where id = p_connector_id and tenant_id = p_tenant_id;
  else
    if p_error_category is null then
      raise exception 'a failed result requires a bounded error category' using errcode = '22023';
    end if;
    if p_organization_fingerprint is not null or p_service_app_fingerprint is not null then
      raise exception 'a failed result carries no verified fingerprint' using errcode = '22023';
    end if;
    update public.okta_connector_configs set
      validation_status = 'failed', validation_error_category = p_error_category,
      last_validation_attempt_at = now(), validation_run_id = p_run_id, updated_at = now()
    where id = v_cfg.id;
  end if;

  select * into v_cfg from public.okta_connector_configs where id = v_cfg.id;
  return jsonb_build_object('outcome', 'recorded', 'connector_id', v_cfg.connector_id,
    'validation_status', v_cfg.validation_status, 'validation_error_category', v_cfg.validation_error_category,
    'last_validated_at', v_cfg.last_validated_at, 'verified_kid', v_cfg.signing_key_id,
    'verified_contract_version', v_cfg.verified_contract_version, 'fingerprint_version', v_cfg.fingerprint_version,
    'validation_run_id', v_cfg.validation_run_id);
end;
$$;

revoke all on function public.runner_record_okta_connector_validation(uuid, uuid, uuid, text, text, text, text, text, text) from public;
revoke all on function public.runner_record_okta_connector_validation(uuid, uuid, uuid, text, text, text, text, text, text) from anon;
revoke all on function public.runner_record_okta_connector_validation(uuid, uuid, uuid, text, text, text, text, text, text) from authenticated;
revoke all on function public.runner_record_okta_connector_validation(uuid, uuid, uuid, text, text, text, text, text, text) from service_role;
grant execute on function public.runner_record_okta_connector_validation(uuid, uuid, uuid, text, text, text, text, text, text) to connector_runner;

-- ── (f) Backfill users_read from the validation that already happened ---------------------------------------------------
-- The O2C.2 run really did prove users_read; that evidence must not be re-earned by another live call. It is transcribed, not
-- invented: the run id, KID and timestamp are the ones actually recorded, and the contract version stays 1.1.0 because that is
-- what it was proven under. Making it read 1.2.0 would be tidier and false.
insert into public.okta_connector_capability_evidence
  (tenant_id, connector_id, capability, status, verified_kid, contract_version, validation_run_id,
   first_verified_at, last_attempt_at, last_verified_at)
select k.tenant_id, k.connector_id, 'users_read', 'verified',
       k.signing_key_id, k.verified_contract_version, k.validation_run_id,
       k.last_validated_at, k.last_validated_at, k.last_validated_at
from public.okta_connector_configs k
where k.provider = 'okta'
  and k.validation_status = 'succeeded'
  and k.signing_key_id is not null
  and k.validation_run_id is not null
  and k.last_validated_at is not null
on conflict (connector_id, capability) do nothing;
