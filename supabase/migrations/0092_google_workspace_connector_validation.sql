-- 0092 — GWS-E4a: the authorized write path for a LIVE Google Workspace connector validation result, and the ONLY route
-- from `configured` to `verified` for this provider.
--
-- ══ WHY THIS EXISTS ══════════════════════════════════════════════════════════════════════════════════════════════════
-- 0086 built the entire Google Workspace write path — facts, promotion, staleness — and it is unreachable. The persist
-- entrypoint opens with `runner_advance_connection_state(verified -> discovery_pending)`, whose optimistic check refuses
-- any other current state, and 0052's transition allowlist contains no `('configured','verified')` entry. So a Google
-- connector can be configured and can never become discoverable.
--
-- The Okta answer to exactly this problem was 0064: the runner observes the outside world, so the runner records what it
-- observed, and the transition is a CONSEQUENCE of that evidence rather than a separate assertion anyone can make. This
-- migration is that same boundary for Google. The alternative — an operator setting `connection_state = 'verified'` by
-- hand — is what it exists to make unnecessary, because a hand-set flag asserts a verification that nothing records, and
-- nothing downstream ever re-checks it: `runner_open_connector_run` tests only tenant ownership, and 0086's promote and
-- stale functions never re-read `connection_state`. An unevidenced `verified` is sufficient, on its own, to promote and
-- stale real directory rows.
--
-- ══ THE TRUST BOUNDARY ═══════════════════════════════════════════════════════════════════════════════════════════════
-- Validation success is a fact about the OUTSIDE WORLD. Only the runner observes it — it holds the KMS signature, the
-- token exchange and the Google response. So the producer is `connector_runner`, and this function is NEVER granted to
-- `authenticated`, `anon` or `service_role`. An owner or admin may configure a connector and may initiate a run; there
-- is no RPC, policy or grant by which they can assert that validation succeeded.
--
-- ══ WHAT THIS DOES NOT DO ════════════════════════════════════════════════════════════════════════════════════════════
--   * It creates NO connector row. That is a separate, explicitly authorized service_role write (GWS-E4b, see
--     docs/GOOGLE_WORKSPACE_CONNECTOR_ROW_RUNBOOK.md), because `connectors` is writable only by service_role or a
--     definer function and Google has no product connect flow — `google_workspace` is `enabled: false`, `status:
--     "future"` in the provider registry, so an `authenticated` creation RPC would be unreachable machinery.
--   * It does NOT widen 0052's transition allowlist. `runner_advance_connection_state` is not touched, so this function
--     is the sole route to `verified` and a caller cannot assemble the transition out of the generic state machine.
--   * It ACTIVATES nothing. No connector is enabled, no schedule armed, no sync authorized; `status` stays `pending`.
--
-- ══ THE DEFERRED CONTROL, NAMED SO IT IS NOT REDISCOVERED ════════════════════════════════════════════════════════════
-- 0064 pins the expected Okta KID in a CHECK constraint, so that even a superuser UPDATE cannot record a verified KID
-- other than the provisioned one. The Google equivalent is DELIBERATELY ABSENT: GWS-E1 is open and no Google
-- service-account key exists yet, so there is no value to pin. Pinning a placeholder would be a fiction that reads like
-- a control. Adding `google_workspace_validation_verified_kid_chk` is a one-line follow-up migration at the moment the
-- real key id exists — which is exactly 0064's stated intent that "rotating the key is a deliberate migration, not an
-- accident".
--
-- ADDITIVE ONLY: creates one table, one function, one index. Alters NO existing table, drops NO constraint, changes NO
-- existing policy, widens NO grant on any existing object, and invents NO new lifecycle vocabulary — `configured` and
-- `verified` both already exist in 0052's `connection_state` set.
--
-- NOT APPLIED TO HOSTED STAGING. Applying is a separate, explicitly authorized step, and execution additionally
-- requires GWS-E4 (0086 confirmed applied), GWS-E1 (a real signing key + bounded kms:Sign), GWS-E2 (domain-wide
-- delegation for the four approved scopes) and GWS-E3 (a live verification that actually succeeds).

begin;

-- ══ A. the evidence table ════════════════════════════════════════════════════════════════════════════════════════════
-- WHY A NEW NARROW TABLE rather than columns on `connectors`: `connectors` carries a table-wide `authenticated` SELECT
-- grant (0018), and RLS filters ROWS, not COLUMNS — so a verification column added there becomes readable by every
-- tenant member. This is the same reasoning 0043 and 0063 record for their own tables.
--
-- WHY NOT a Google mirror of `okta_connector_configs`: that table exists because Okta's non-secret configuration (org
-- host, client id) is supplied by a tenant admin through the product and must be stored. Google's equivalent
-- configuration — service-account address, impersonated admin, customer id — arrives as task-definition environment and
-- is read by nothing in this database. A config table would be a table with no reader.
create table if not exists public.google_workspace_connector_validations (
  id                                  uuid primary key default gen_random_uuid(),
  tenant_id                           uuid not null references public.tenants (id) on delete cascade,
  connector_id                        uuid not null,

  validation_status                   text not null default 'never_validated',
  validation_error_category           text,
  last_validation_attempt_at          timestamptz,
  last_validated_at                   timestamptz,

  -- The evidence package. Every field is written together or not at all (see the CHECK pair below).
  verified_kid                        text,
  verified_contract_version           text,
  validation_run_id                   uuid,
  verified_customer_fingerprint       text,
  verified_service_account_fingerprint text,

  created_at                          timestamptz not null default now(),
  updated_at                          timestamptz not null default now(),

  -- One validation record per connector. The connector is the subject; a second row would be a second opinion.
  constraint google_workspace_validation_connector_unique unique (connector_id),

  -- Same-tenant composite FK against 0017's `connectors_id_tenant_key unique (id, tenant_id)`. A row cannot name a
  -- connector belonging to another tenant even if every check in the function below were removed.
  constraint google_workspace_validation_connector_same_tenant
    foreign key (connector_id, tenant_id) references public.connectors (id, tenant_id) on delete cascade,

  constraint google_workspace_validation_status_chk
    check (validation_status in ('never_validated', 'succeeded', 'failed')),

  -- The bounded category vocabulary. Held in lockstep with the runner adapter's TypeScript union: a value missing there
  -- fails at compile time, a value missing HERE fails at the database boundary, and the two together are why a category
  -- cannot be invented by accident. `delegation_not_granted` is Google-specific and load-bearing — Google answers an
  -- incomplete domain-wide-delegation grant with `unauthorized_client`, the same code as a bad client, and collapsing
  -- the two would send an operator to re-check credentials that are provably fine.
  constraint google_workspace_validation_error_category_chk
    check (validation_error_category is null or validation_error_category in (
      'invalid_key', 'invalid_client', 'invalid_scope', 'delegation_not_granted',
      'admin_impersonation_refused', 'permission_insufficient', 'wrong_customer',
      'network_failure', 'rate_limited', 'provider_error')),

  -- A category belongs to a failure and to nothing else.
  constraint google_workspace_validation_category_requires_failure_chk
    check (validation_error_category is null or validation_status = 'failed'),

  -- Evidence is ALL-OR-NOTHING in both directions.
  --  (a) success cannot appear without its evidence — no fingerprint without a KID, no KID without a run, no run
  --      without a timestamp;
  constraint google_workspace_validation_success_requires_evidence_chk
    check (validation_status <> 'succeeded' or (
      verified_kid is not null
      and verified_contract_version is not null
      and validation_run_id is not null
      and verified_customer_fingerprint is not null
      and verified_service_account_fingerprint is not null
      and last_validated_at is not null)),
  --  (b) and evidence cannot appear without success, so a `failed` or `never_validated` row cannot quietly carry a
  --      verified KID that a later reader mistakes for proof.
  constraint google_workspace_validation_evidence_requires_success_chk
    check (validation_status = 'succeeded' or (
      verified_kid is null
      and verified_contract_version is null
      and validation_run_id is null
      and verified_customer_fingerprint is null
      and verified_service_account_fingerprint is null
      and last_validated_at is null)),

  -- Fingerprints are sha256 hex. Derived by the runner from SERVER-VERIFIED configuration, never from a provider
  -- response, so they identify what we asked for rather than what we were told.
  constraint google_workspace_validation_customer_fp_chk
    check (verified_customer_fingerprint is null or verified_customer_fingerprint ~ '^[0-9a-f]{64}$'),
  constraint google_workspace_validation_service_account_fp_chk
    check (verified_service_account_fingerprint is null or verified_service_account_fingerprint ~ '^[0-9a-f]{64}$')
);

create index if not exists google_workspace_validation_tenant_idx
  on public.google_workspace_connector_validations (tenant_id);

-- DENY-ALL. The definer function below runs as owner and needs no grant; every request-path role and the runner itself
-- are refused the table outright, so the function is the only way in and PostgREST cannot serve these rows at all.
alter table public.google_workspace_connector_validations enable row level security;
revoke all on public.google_workspace_connector_validations from public, anon, authenticated, connector_runner;

-- ══ B. the recording command ═════════════════════════════════════════════════════════════════════════════════════════
-- Mirrors 0064's arity and argument order deliberately, so the two providers' evidence boundaries read as one pattern
-- rather than two inventions.
create or replace function public.runner_record_google_workspace_validation(
  p_tenant_id                   uuid,
  p_connector_id                uuid,
  p_run_id                      uuid,
  p_outcome                     text,           -- 'succeeded' | 'failed'
  p_verified_kid                text,           -- the service-account key id actually signed with
  p_contract_version            text,           -- must equal the pinned active contract version
  p_customer_fingerprint        text,           -- required on success, must be NULL on failure
  p_service_account_fingerprint text,           -- required on success, must be NULL on failure
  p_error_category              text default null  -- required on failure, must be NULL on success
) returns jsonb
  language plpgsql
  security definer
  set search_path = ''
as $$
declare
  -- The active Google Workspace provider contract version, byte-identical in both repositories and hash-pinned by a
  -- test in each. An independent enforcement point: the runner already refuses a mismatched contract, and this does not
  -- trust it.
  c_contract constant text := '1.0.0';
  v_row      public.google_workspace_connector_validations%rowtype;
  v_state    text;
begin
  if p_outcome is null or p_outcome not in ('succeeded', 'failed') then
    raise exception 'outcome must be succeeded or failed' using errcode = '22023';
  end if;

  -- The run must be a run OF THIS CONNECTOR FOR THIS TENANT. A forged or borrowed run id is the cheapest way to
  -- attribute someone else's evidence, so it is checked before anything is read or written.

  if not exists (
    select 1 from public.connector_runs r
     where r.id = p_run_id and r.tenant_id = p_tenant_id and r.connector_id = p_connector_id
  ) then
    raise exception 'run % is not a run of connector % for tenant %', p_run_id, p_connector_id, p_tenant_id
      using errcode = '42501';
  end if;

  -- Ownership + PROVIDER. The connector's ACTUAL provider must be google_workspace: a caller cannot record Google
  -- evidence against an Okta connection, and this function cannot reach an Okta row even by mistake. The row is locked
  -- so the start-state read and the transition below are atomic.
  select c.connection_state into v_state
    from public.connectors c
   where c.id = p_connector_id and c.tenant_id = p_tenant_id and c.provider = 'google_workspace'
   for update;
  if not found then
    raise exception 'connector % is not a google_workspace connection for tenant %', p_connector_id, p_tenant_id
      using errcode = '42501';
  end if;

  if p_contract_version is distinct from c_contract then
    raise exception 'result contract version does not match the active contract version' using errcode = '22023';
  end if;

  -- Seed the record on first contact. `never_validated` is the honest starting claim: a connector that has never been
  -- validated must read as such rather than as an absent row that a reader could interpret either way.
  insert into public.google_workspace_connector_validations (tenant_id, connector_id)
    values (p_tenant_id, p_connector_id)
    on conflict (connector_id) do nothing;

  select * into v_row from public.google_workspace_connector_validations where connector_id = p_connector_id;

  -- IDEMPOTENT REPLAY: the same run resubmitting its own result performs NO update, emits NO second audit row, and
  -- moves no timestamp. Replay must be observably inert, not merely harmless.
  if v_row.validation_run_id is not null and v_row.validation_run_id = p_run_id then
    return jsonb_build_object(
      'outcome', 'idempotent_replay',
      'connector_id', v_row.connector_id,
      'validation_status', v_row.validation_status,
      'last_validated_at', v_row.last_validated_at,
      'verified_kid', v_row.verified_kid,
      'verified_contract_version', v_row.verified_contract_version,
      'validation_run_id', v_row.validation_run_id);
  end if;

  -- A late or stale failure cannot demote an established success.
  if v_row.validation_status = 'succeeded' and p_outcome = 'failed' then
    raise exception 'refusing to demote a succeeded validation with run %', p_run_id using errcode = '22023';
  end if;

  if p_outcome = 'succeeded' then
    if p_verified_kid is null or length(btrim(p_verified_kid)) = 0 then
      raise exception 'a succeeded result requires the verified key id' using errcode = '22023';
    end if;
    if p_customer_fingerprint !~ '^[0-9a-f]{64}$' or p_service_account_fingerprint !~ '^[0-9a-f]{64}$' then
      raise exception 'malformed verified fingerprint' using errcode = '22023';
    end if;
    if p_error_category is not null then
      raise exception 'a succeeded result carries no error category' using errcode = '22023';
    end if;

    -- THE START-STATE GATE. `configured` and nothing else. Not `verified` — re-verifying an already-verified connector
    -- would let a second run silently re-assert the transition; not a discovery state — a connector mid-sweep is not a
    -- connector awaiting verification. This is also what makes a hand-set `verified` useless rather than merely
    -- discouraged: a connector already forced to `verified` cannot then have evidence recorded against it, so the
    -- forced flag can never acquire the backing it lacks.

    if v_state is distinct from 'configured' then
      raise exception 'connection_state is not configured (validation refused for state %)', coalesce(v_state, '<null>')
        using errcode = '22023';
    end if;

    update public.google_workspace_connector_validations set
      validation_status = 'succeeded',
      validation_error_category = null,
      last_validation_attempt_at = now(),
      last_validated_at = now(),
      verified_kid = p_verified_kid,
      verified_contract_version = c_contract,
      validation_run_id = p_run_id,
      verified_customer_fingerprint = p_customer_fingerprint,
      verified_service_account_fingerprint = p_service_account_fingerprint,
      updated_at = now()
    where connector_id = p_connector_id;

    -- The transition, in the same statement sequence as the evidence and inside the same transaction: there is no
    -- window in which one exists without the other. `status` stays `pending`, `last_sync_at` stays untouched — one
    -- successful authentication is not a working integration.
    update public.connectors set connection_state = 'verified', updated_at = now()
      where id = p_connector_id and tenant_id = p_tenant_id;

    insert into public.audit_logs (tenant_id, action, resource_type, resource_id, after_json)
      values (p_tenant_id, 'google_workspace_connector_validation_succeeded', 'connector', p_connector_id,
              jsonb_build_object('connection_state', 'verified', 'validation_run_id', p_run_id,
                                 'contract_version', c_contract));
  else
    if p_error_category is null then
      raise exception 'a failed result requires a bounded error category' using errcode = '22023';
    end if;
    if p_customer_fingerprint is not null or p_service_account_fingerprint is not null then
      raise exception 'a failed result carries no verified fingerprint' using errcode = '22023';
    end if;

    -- A recorded failure leaves `connection_state` exactly where it was. Recording a failure is a successful recording,
    -- not an error, so this branch raises nothing.
    update public.google_workspace_connector_validations set
      validation_status = 'failed',
      validation_error_category = p_error_category,
      last_validation_attempt_at = now(),
      updated_at = now()
    where connector_id = p_connector_id;

    insert into public.audit_logs (tenant_id, action, resource_type, resource_id, after_json)
      values (p_tenant_id, 'google_workspace_connector_validation_failed', 'connector', p_connector_id,
              jsonb_build_object('error_category', p_error_category));
  end if;

  select * into v_row from public.google_workspace_connector_validations where connector_id = p_connector_id;
  return jsonb_build_object(
    'outcome', 'recorded',
    'connector_id', v_row.connector_id,
    'validation_status', v_row.validation_status,
    'validation_error_category', v_row.validation_error_category,
    'last_validated_at', v_row.last_validated_at,
    'verified_kid', v_row.verified_kid,
    'verified_contract_version', v_row.verified_contract_version,
    'validation_run_id', v_row.validation_run_id);
end;
$$;

-- ══ C. least privilege ═══════════════════════════════════════════════════════════════════════════════════════════════
-- On hosted Supabase, ALTER DEFAULT PRIVILEGES grants EXECUTE on every new public function DIRECTLY to anon,
-- authenticated and service_role as EXPLICIT grantees. `revoke ... from public` removes only the PUBLIC pseudo-role and
-- leaves those three intact, so each must be named — this is the trap 0064 records, and it is the difference between a
-- runner-only function and one the browser can call.
revoke all on function public.runner_record_google_workspace_validation(uuid, uuid, uuid, text, text, text, text, text, text) from public;
revoke all on function public.runner_record_google_workspace_validation(uuid, uuid, uuid, text, text, text, text, text, text) from anon;
revoke all on function public.runner_record_google_workspace_validation(uuid, uuid, uuid, text, text, text, text, text, text) from authenticated;
revoke all on function public.runner_record_google_workspace_validation(uuid, uuid, uuid, text, text, text, text, text, text) from service_role;
grant execute on function public.runner_record_google_workspace_validation(uuid, uuid, uuid, text, text, text, text, text, text) to connector_runner;

commit;

-- OPERATOR NOTES
--  * NOT applied to hosted staging. Applying is a separate, explicitly authorized step.
--  * Execution additionally requires GWS-E4 (0086 confirmed applied to hosted staging), GWS-E1 (a real Google signing
--    key and bounded kms:Sign wiring), GWS-E2 (domain-wide delegation for the four approved scopes) and GWS-E3 (a live
--    verification that actually succeeds).
--  * The connector row itself is created separately and BEFORE any recording, at `connection_state = 'configured'`:
--    docs/GOOGLE_WORKSPACE_CONNECTOR_ROW_RUNBOOK.md.
--  * The pinned-KID CHECK is deferred until GWS-E1 produces a real key id. See the header.
