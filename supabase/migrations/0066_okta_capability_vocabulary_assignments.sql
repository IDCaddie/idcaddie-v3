-- 0066 — O2C.4: widen the bounded capability vocabulary to the membership and assignment read surfaces.
--
-- The ONLY change is the vocabulary CHECK. The table, its RLS, the audit trigger, the runner-only write function, the pinned KID,
-- the pinned contract version, the idempotency behaviour and the direct-write denial are all untouched and continue to apply to
-- the new capabilities exactly as they do to the existing three.
--
-- Existing evidence is preserved by construction: widening an IN-list rejects nothing that was previously accepted, and no row is
-- rewritten — `users_read` keeps `contract_version = 1.1.0`, which is what it was proven under.

alter table public.okta_connector_capability_evidence
  drop constraint okta_cap_vocab_chk;

-- Three ADDITIONAL capabilities, each its own row with its own run, scope evidence and audit. They are deliberately NOT collapsed
-- into a single "assignments" flag: app-USER assignments and app-GROUP assignments are separate Okta endpoints that can fail
-- independently (an administrator role can permit one and refuse the other), so a combined flag could claim access that does not
-- exist.
alter table public.okta_connector_capability_evidence
  add constraint okta_cap_vocab_chk check (capability in (
    'users_read',
    'groups_read',
    'apps_read',
    'group_memberships_read',
    'app_user_assignments_read',
    'app_group_assignments_read'
  ));

-- The write function's own vocabulary guard must widen with the CHECK, or the new capabilities would be refused at the function
-- boundary before the constraint ever saw them. Only the IN-list changes; every other line is 0065's.
create or replace function public.runner_record_okta_capability_evidence(
  p_tenant_id uuid,
  p_connector_id uuid,
  p_run_id uuid,
  p_capability text,
  p_outcome text,
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
  if p_capability is null or p_capability not in (
    'users_read', 'groups_read', 'apps_read',
    'group_memberships_read', 'app_user_assignments_read', 'app_group_assignments_read'
  ) then
    raise exception 'unknown capability' using errcode = '22023';
  end if;
  if p_outcome is null or p_outcome not in ('verified', 'failed') then
    raise exception 'outcome must be verified or failed' using errcode = '22023';
  end if;

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

  if found and v_row.validation_run_id is not null and v_row.validation_run_id = p_run_id then
    return jsonb_build_object('outcome', 'idempotent_replay', 'capability', v_row.capability,
      'status', v_row.status, 'validation_run_id', v_row.validation_run_id);
  end if;

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
      first_verified_at = coalesce(e.first_verified_at, now()),
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
      -- Unreachable for a verified row: the demotion guard above refuses verified -> failed, so erasure of proven evidence is
      -- prevented a level earlier than this UPDATE.
  end if;

  select * into v_row from public.okta_connector_capability_evidence
    where connector_id = p_connector_id and capability = p_capability;
  return jsonb_build_object('outcome', 'recorded', 'capability', v_row.capability, 'status', v_row.status,
    'validation_run_id', v_row.validation_run_id, 'contract_version', v_row.contract_version);
end;
$$;

-- Re-assert the grant surface. `create or replace function` preserves the existing ACL, but Supabase's default privileges apply to
-- new functions and this file must be safe to reason about in isolation: browser roles named explicitly, runner only.
revoke all on function public.runner_record_okta_capability_evidence(uuid, uuid, uuid, text, text, text, text, text) from public;
revoke all on function public.runner_record_okta_capability_evidence(uuid, uuid, uuid, text, text, text, text, text) from anon;
revoke all on function public.runner_record_okta_capability_evidence(uuid, uuid, uuid, text, text, text, text, text) from authenticated;
revoke all on function public.runner_record_okta_capability_evidence(uuid, uuid, uuid, text, text, text, text, text) from service_role;
grant execute on function public.runner_record_okta_capability_evidence(uuid, uuid, uuid, text, text, text, text, text) to connector_runner;
