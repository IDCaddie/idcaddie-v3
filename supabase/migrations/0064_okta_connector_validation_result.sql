-- 0064 — O2C.2: the authorized write path for a LIVE Okta connector validation result.
--
-- WHY THIS EXISTS. 0063 built the creation path and deliberately made it structurally incapable of writing a state that claims
-- verification. That left no way at all to record a validation that really happened: the O2C.2 live authentication succeeded
-- against Okta and the connector still read `never_validated`, because nothing in the database could say otherwise.
--
-- THE TRUST BOUNDARY. Validation success is a fact about the OUTSIDE WORLD. Only the runner observes it — it holds the KMS
-- signature, the token exchange and the API response. So the producer is `connector_runner`, the same narrow role used by every
-- other `runner_*` function, and this function is NEVER granted to `authenticated`. An owner or admin may configure a connector
-- (0063) and may initiate a run, but has no path — RPC, policy or grant — to assert that validation succeeded.
--
-- ADDITIVE ONLY. Creates NO table, drops NO constraint, changes NO existing policy, widens NO existing grant, and invents NO new
-- lifecycle vocabulary: `succeeded`/`failed` already exist in 0063's validation_status set and `verified` already exists in 0052's
-- connection_state set.

-- ── (a) The four genuinely-new columns ---------------------------------------------------------------------------------
-- Everything else the result needs already exists in 0063 and is REUSED, not duplicated. In particular `signing_key_id` is the
-- verified active KID: 0063 reserved it for exactly this ("stays NULL until O2B provisions the KMS key; a connection cannot be
-- live-validated" without it), so a separate `verified_kid` would be a second column meaning the same thing.
alter table public.okta_connector_configs
  add column if not exists last_validation_attempt_at timestamptz,
  add column if not exists verified_service_app_fingerprint text,
  add column if not exists verified_contract_version text,
  add column if not exists validation_run_id uuid;

-- ── (b) The PINNED expected KID — an INDEPENDENT database enforcement point --------------------------------------------
-- The runner already refuses to sign unless the contract KID matches its configured KID, and CI asserts the contract matches all
-- twelve task definitions across two repositories. This is a THIRD, separate check that does not trust any of them: even a
-- superuser UPDATE cannot record a verified KID other than the one pinned here. Mirrors how 0062 pins the exact scope set.
--
-- Rotating the key is therefore a deliberate migration, not an accident. That is the intent.
alter table public.okta_connector_configs
  add constraint okta_config_verified_kid_chk check (
    signing_key_id is null or signing_key_id = 'p7AyvDK0yI95_HdQBxdhBSOTt9mMYPczGL-4USxaMto'
  );

alter table public.okta_connector_configs
  add constraint okta_config_verified_service_fp_chk check (
    verified_service_app_fingerprint is null or verified_service_app_fingerprint ~ '^[0-9a-f]{64}$'
  );

-- Verified evidence is ALL-OR-NOTHING. A row claiming `succeeded` cannot carry a partial evidence package — no fingerprint
-- without a KID, no KID without a run, no run without a timestamp. The complement of 0063's
-- `okta_config_verified_requires_success_chk`, which stops evidence appearing without success; this stops success appearing
-- without evidence.
alter table public.okta_connector_configs
  add constraint okta_config_success_requires_evidence_chk check (
    validation_status <> 'succeeded' or (
      verified_organization_fingerprint is not null
      and verified_service_app_fingerprint is not null
      and signing_key_id is not null
      and verified_contract_version is not null
      and validation_run_id is not null
      and last_validated_at is not null
    )
  );

-- ── (c) Precise audit actions for validation outcomes ------------------------------------------------------------------
-- Replaces 0063's trigger body. Same trigger, same table, same security-definer posture; it now names the transition instead of
-- flattening every UPDATE to `okta_connector_state_changed`.
--
-- Deliberately NOT emitted: a `..._replayed` event (an idempotent replay performs no UPDATE, so adding an audit row would make
-- replay non-idempotent in the audit log — the property the GO asks us to prove) and a `..._rejected` event (a rejection RAISES,
-- so any audit row written first would roll back with it; persisting one needs an autonomous transaction, which is complexity
-- this does not need — and a rejection changes nothing, so there is no state drift to explain later).
create or replace function public.audit_okta_connector_config_write()
  returns trigger
  language plpgsql
  security definer
  set search_path = ''
as $$
declare
  v_action text;
begin
  if tg_op = 'INSERT' then
    v_action := 'okta_connector_configuration_created';
  elsif new.validation_status is distinct from old.validation_status and new.validation_status = 'succeeded' then
    v_action := 'okta_connector_validation_succeeded';
  elsif new.validation_status is distinct from old.validation_status and new.validation_status = 'failed' then
    v_action := 'okta_connector_validation_failed';
  else
    v_action := 'okta_connector_state_changed';
  end if;

  insert into public.audit_logs (tenant_id, actor_user_id, action, resource_type, resource_id, after_json)
  values (
    new.tenant_id,
    auth.uid(),   -- NULL for a runner-produced result: the producer is a machine role, not a person. Truthful.
    v_action,
    'okta_connector_config',
    new.id,
    -- BOUNDED, non-secret projection only. No token, assertion, signature, digest, provider body or key material.
    jsonb_build_object(
      'connector_id', new.connector_id,
      'provider', new.provider,
      'normalized_org_host', new.normalized_org_host,
      'proposed_organization_fingerprint', new.proposed_organization_fingerprint,
      'verified', (new.verified_organization_fingerprint is not null),
      'contract_version', new.contract_version,
      'verified_contract_version', new.verified_contract_version,
      'verified_kid', new.signing_key_id,
      'validation_run_id', new.validation_run_id,
      'fingerprint_version', new.fingerprint_version,
      'authentication_mode', new.authentication_mode,
      'public_key_delivery_mode', new.public_key_delivery_mode,
      'validation_status', new.validation_status,
      'validation_error_category', new.validation_error_category,
      'certification_only', new.certification_only,
      'production_enabled', new.production_enabled
    )
  );
  return new;
end;
$$;

-- ── (d) The ONLY path that can record a validation result --------------------------------------------------------------
-- Every authority is derived or pinned here, never taken on the caller's word:
--   * the RUN must already exist in `connector_runs` for this exact connector AND tenant — server-generated by
--     `runner_open_connector_run`, so the caller cannot invent a run identity;
--   * the KID and contract version must equal the pinned constants, and the value WRITTEN is the constant, not the argument;
--   * timestamps are `now()`, never supplied;
--   * governance flags are never written at all — 0063 CHECK-pins them and this function does not name them.
create or replace function public.runner_record_okta_connector_validation(
  p_tenant_id uuid,
  p_connector_id uuid,
  p_run_id uuid,
  p_outcome text,                      -- 'succeeded' | 'failed'
  p_verified_kid text,
  p_contract_version text,
  p_organization_fingerprint text,     -- required on success, must be NULL on failure
  p_service_app_fingerprint text,      -- required on success, must be NULL on failure
  p_error_category text default null   -- required on failure, must be NULL on success
) returns jsonb
  language plpgsql
  security definer
  set search_path = ''
as $$
declare
  c_kid      constant text := 'p7AyvDK0yI95_HdQBxdhBSOTt9mMYPczGL-4USxaMto';
  c_contract constant text := '1.1.0';
  v_cfg public.okta_connector_configs%rowtype;
begin
  if p_outcome is null or p_outcome not in ('succeeded', 'failed') then
    raise exception 'outcome must be succeeded or failed' using errcode = '22023';
  end if;

  -- The run is the anti-forgery binding. It must be a real, server-generated run for THIS connector and THIS tenant.
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
    raise exception 'no okta configuration for connector % in tenant %', p_connector_id, p_tenant_id
      using errcode = '42501';
  end if;
  if v_cfg.provider <> 'okta' then
    raise exception 'connector % is not an okta connector', p_connector_id using errcode = '42501';
  end if;
  if v_cfg.disabled_at is not null then
    raise exception 'configuration for connector % is disabled', p_connector_id using errcode = '42501';
  end if;

  -- Pinned identity. A result produced under a superseded key or contract is refused outright rather than recorded.
  if p_verified_kid is distinct from c_kid then
    raise exception 'result kid does not match the active contract kid' using errcode = '22023';
  end if;
  if p_contract_version is distinct from c_contract then
    raise exception 'result contract version does not match the active contract version' using errcode = '22023';
  end if;

  -- IDEMPOTENT REPLAY: the same run replayed performs NO update, so it emits no second audit event and moves no timestamp.
  if v_cfg.validation_run_id is not null and v_cfg.validation_run_id = p_run_id then
    return jsonb_build_object(
      'outcome', 'idempotent_replay',
      'connector_id', v_cfg.connector_id,
      'validation_status', v_cfg.validation_status,
      'last_validated_at', v_cfg.last_validated_at,
      'verified_kid', v_cfg.signing_key_id,
      'verified_contract_version', v_cfg.verified_contract_version,
      'fingerprint_version', v_cfg.fingerprint_version,
      'validation_run_id', v_cfg.validation_run_id
    );
  end if;

  -- A LATE OR STALE failure must never demote an established success. A genuine re-validation failure is a new observation and
  -- should arrive as its own run against a connector that is not already verified; refusing here keeps a delayed or duplicated
  -- message from silently un-verifying a working connector.
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
      validation_status                = 'succeeded',
      validation_error_category        = null,
      last_validation_attempt_at       = now(),
      last_validated_at                = now(),
      verified_organization_fingerprint = p_organization_fingerprint,
      verified_service_app_fingerprint  = p_service_app_fingerprint,
      signing_key_id                   = c_kid,        -- the PINNED value, not the argument
      verified_contract_version        = c_contract,   -- the PINNED value, not the argument
      validation_run_id                = p_run_id,
      updated_at                       = now()
    where id = v_cfg.id;

    -- The connector becomes `verified` and NOTHING further. Not healthy, not syncing, not ready for sync, not production.
    -- `status` stays `pending`: one authenticated read is not a working integration.
    update public.connectors set connection_state = 'verified', updated_at = now()
      where id = p_connector_id and tenant_id = p_tenant_id;
  else
    if p_error_category is null then
      raise exception 'a failed result requires a bounded error category' using errcode = '22023';
    end if;
    if p_organization_fingerprint is not null or p_service_app_fingerprint is not null then
      raise exception 'a failed result carries no verified fingerprint' using errcode = '22023';
    end if;

    -- Records the attempt and the bounded category ONLY. No verified evidence is written, and the connector stays `configured`.
    update public.okta_connector_configs set
      validation_status          = 'failed',
      validation_error_category  = p_error_category,   -- bounded by 0063's CHECK; an unknown category is rejected there
      last_validation_attempt_at = now(),
      validation_run_id          = p_run_id,
      updated_at                 = now()
    where id = v_cfg.id;
  end if;

  select * into v_cfg from public.okta_connector_configs where id = v_cfg.id;
  return jsonb_build_object(
    'outcome', 'recorded',
    'connector_id', v_cfg.connector_id,
    'validation_status', v_cfg.validation_status,
    'validation_error_category', v_cfg.validation_error_category,
    'last_validated_at', v_cfg.last_validated_at,
    'verified_kid', v_cfg.signing_key_id,
    'verified_contract_version', v_cfg.verified_contract_version,
    'fingerprint_version', v_cfg.fingerprint_version,
    'validation_run_id', v_cfg.validation_run_id
  );
end;
$$;

-- ── (e) Grants: the runner role ONLY -----------------------------------------------------------------------------------
-- `authenticated` must never reach this function. That is the whole authorization design: "owner claims success" is not a policy
-- question, it is an absent grant.
--
-- REVOKING FROM `public` IS NOT ENOUGH ON SUPABASE, and this is not a theoretical nicety — the test caught it. Supabase ships
-- ALTER DEFAULT PRIVILEGES that grant EXECUTE on new public functions to `anon`, `authenticated` and `service_role` as EXPLICIT
-- grantees. `revoke ... from public` removes only the PUBLIC pseudo-role and leaves those three untouched, so a function that
-- looks runner-only in the migration is in fact callable by any browser session. Each role must be named.
revoke all on function public.runner_record_okta_connector_validation(uuid, uuid, uuid, text, text, text, text, text, text) from public;
revoke all on function public.runner_record_okta_connector_validation(uuid, uuid, uuid, text, text, text, text, text, text) from anon;
revoke all on function public.runner_record_okta_connector_validation(uuid, uuid, uuid, text, text, text, text, text, text) from authenticated;
revoke all on function public.runner_record_okta_connector_validation(uuid, uuid, uuid, text, text, text, text, text, text) from service_role;
grant execute on function public.runner_record_okta_connector_validation(uuid, uuid, uuid, text, text, text, text, text, text) to connector_runner;
