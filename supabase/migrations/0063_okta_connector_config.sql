-- 0063 — O2A: metadata-only Okta connector configuration (docs/78).
--
-- THE ARCHITECTURE THIS ENCODES. IDCaddie owns the Okta signing key; it lives in an asymmetric AWS KMS key and is never exported.
-- The customer creates their own Okta API Services app, trusts IDCaddie's PUBLIC key, and supplies exactly two NON-SECRET values:
-- the normalized organization host and the service-app client id. Therefore an Okta connector HAS NO SECRET, and this migration
-- creates no secret column, no key material column, and no credential-reference requirement.
--
-- WHY A NEW NARROW TABLE rather than columns on `connectors`:
--   * `connectors` carries a table-wide `authenticated` SELECT grant, so every Okta-specific column added there becomes readable by
--     every tenant member. A narrow table gets its own, tighter policy.
--   * `connectors` is provider-neutral; accreting provider columns turns it into an unbounded per-provider record.
--
-- WHY NOT `connector_okta_issuer_bindings` (0048/0062): that table is an OPERATOR-APPROVED ISSUER ALLOWLIST — scoped to an internal
-- organization, readable by an org MANAGER, and writable ONLY by service_role. It records "this org may use this issuer". This table
-- records "this tenant's connector is configured for this Okta org", is tenant-scoped, and is written by an owner/admin through a
-- narrow RPC. Different concept, owner, and lifecycle. They coexist: the config gate consults the binding as a precondition.
--
-- REVIEWED NON-DESTRUCTIVE and ADDITIVE ONLY: creates one table + its indexes + RLS + one audit trigger + two functions. It alters
-- NO existing table, drops NO constraint, changes NO cascade, removes NO policy, and widens NO grant on an existing object. No table
-- teardown, no truncation, no row deletion.
--
-- NOT APPLIED TO HOSTED STAGING.

begin;

-- ── (a) The connector lifecycle is DELIBERATELY NOT CHANGED ----------------------------------------------------------
-- An earlier draft of this migration rewrote `connectors_connection_state_chk` to add O2A-specific states. That was wrong twice
-- over, and the pgTAP suite caught it:
--
--   1. `0052` — not `0050` — holds the authoritative vocabulary ('configured', 'verification_pending', 'verified',
--      'discovery_pending', 'discovering', 'discovered', 'partial_failure', 'error', 'disconnected', 'revoked', 'disabled').
--      Rewriting from the `0050` definition silently dropped eight values and would have broken the whole discovery lifecycle
--      plus `runner_advance_connection_state`'s transition allowlist.
--   2. The state O2A needs ALREADY EXISTS. `configured` means exactly "configuration recorded, nothing verified" — which is
--      precisely O2A's terminal state. Adding `configuration_saved` alongside it would have created two states with one meaning:
--      a permanent drift hazard, and a second value every future consumer would have to handle.
--
-- So O2A adds NO state and touches NO existing constraint. `verified` and everything downstream remain reachable only through
-- the existing runner-only transition RPC, which O2A does not modify.

-- ── (b) The Okta configuration record --------------------------------------------------------------------------------
create table if not exists public.okta_connector_configs (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  connector_id uuid not null,
  provider text not null default 'okta',

  -- Customer-supplied, NON-SECRET. The canonical host is produced by the O1C server-side validator
  -- (canonicalizeOktaOrgHost); the CHECK below is a structural backstop, deliberately NOT a second, weaker validator.
  normalized_org_host text not null,
  client_id text not null,

  -- IDENTITY. `proposed_*` is derived at configuration time from host + client id. It is NOT evidence of anything: no token has
  -- been minted, so no organization has been proven. `verified_organization_fingerprint` stays NULL until a real token exchange
  -- succeeds (O2B/O2D). Keeping them in separate columns is what stops an unverified value from later being read as verified.
  proposed_organization_fingerprint text not null,
  service_app_fingerprint text not null,
  verified_organization_fingerprint text,
  fingerprint_version integer not null default 1,

  -- Platform signing key REFERENCE ONLY — never key material. NULL until O2B provisions the KMS key.
  signing_key_id text,
  signing_key_version text,

  contract_version text not null default '1.0.0',
  authentication_mode text not null default 'private_key_jwt',
  -- How the customer trusts our PUBLIC key. `not_configured` until O2C actually publishes; claiming `jwks_uri` now would assert a
  -- published endpoint that does not exist.
  public_key_delivery_mode text not null default 'not_configured',
  approved_scopes text[] not null,

  -- Governance, mirroring the runner manifest. Pinned by CHECK so no write path can flip them.
  certification_only boolean not null default true,
  production_enabled boolean not null default false,

  validation_status text not null default 'never_validated',
  validation_error_category text,
  last_validated_at timestamptz,

  -- Retry safety. Unique per tenant, so a double-click or network retry returns the existing row instead of creating a second.
  idempotency_key uuid not null,

  created_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  disabled_at timestamptz,

  constraint okta_config_provider_chk check (provider = 'okta'),
  constraint okta_config_auth_mode_chk check (authentication_mode = 'private_key_jwt'),
  -- Governance cannot be flipped by ANY write path, including a future one that forgets to check.
  constraint okta_config_certification_chk check (certification_only = true),
  constraint okta_config_production_chk check (production_enabled = false),
  constraint okta_config_contract_version_chk check (contract_version = '1.0.0'),

  -- Structural host backstop: lower-case, no scheme/path/query/port/credentials, single org label, documented Okta apex.
  constraint okta_config_host_chk check (
    normalized_org_host = lower(normalized_org_host)
    and normalized_org_host ~ '^[a-z0-9]([a-z0-9-]*[a-z0-9])?\.(okta\.com|oktapreview\.com|okta-emea\.com)$'
    and char_length(normalized_org_host) between 8 and 255
  ),
  -- Okta client ids are opaque ASCII (`0oa…`). Bounded charset; no control chars, no Unicode confusables.
  -- Length is checked with char_length rather than a `{5,256}` quantifier: Postgres caps regex repetition counts at 255, so the
  -- quantifier form fails to compile at 256 (the runner's CLIENT_ID_MAX).
  constraint okta_config_client_id_chk check (
    client_id ~ '^[A-Za-z0-9._-]+$' and char_length(client_id) between 5 and 256
  ),

  -- EXACT approved scope set — order-independent, duplicate-rejecting, NULL-rejecting (the 0062 idiom).
  constraint okta_config_scopes_chk check (
    approved_scopes @> array['okta.apps.read', 'okta.groups.read', 'okta.users.read']::text[]
    and approved_scopes <@ array['okta.apps.read', 'okta.groups.read', 'okta.users.read']::text[]
    and cardinality(approved_scopes) = 3
    and array_position(approved_scopes, null) is null
  ),

  constraint okta_config_delivery_mode_chk check (public_key_delivery_mode in ('not_configured', 'jwks_uri', 'static_jwk')),
  constraint okta_config_validation_status_chk check (validation_status in ('never_validated', 'pending', 'succeeded', 'failed')),
  constraint okta_config_error_category_chk check (validation_error_category is null or validation_error_category in (
    'invalid_domain', 'invalid_client', 'invalid_key', 'invalid_scope', 'permission_insufficient',
    'wrong_organization', 'network_failure', 'rate_limited', 'provider_error', 'unsupported_custom_domain'
  )),
  -- A verified fingerprint may exist ONLY alongside a successful validation. This is the constraint that makes
  -- "verified" un-fakeable by a partial write.
  constraint okta_config_verified_requires_success_chk check (
    verified_organization_fingerprint is null or (validation_status = 'succeeded' and last_validated_at is not null)
  ),
  constraint okta_config_fingerprint_shape_chk check (
    proposed_organization_fingerprint ~ '^[0-9a-f]{64}$'
    and service_app_fingerprint ~ '^[0-9a-f]{64}$'
    and (verified_organization_fingerprint is null or verified_organization_fingerprint ~ '^[0-9a-f]{64}$')
  ),

  -- One config per connector.
  constraint okta_config_connector_unique unique (connector_id),
  -- Same-tenant binding to the owning connector (0005 composite pattern); cascades with the connector.
  constraint okta_config_connector_same_tenant
    foreign key (connector_id, tenant_id) references public.connectors (id, tenant_id) on delete cascade
);

-- Retry safety: one logical creation per (tenant, idempotency_key).
create unique index if not exists okta_config_idempotency_uidx
  on public.okta_connector_configs (tenant_id, idempotency_key);

-- PRE-verification duplicate guard: one ACTIVE config per (tenant, host, client id). A disabled or failed row frees the slot so a
-- customer can correct a mistake and retry.
create unique index if not exists okta_config_active_target_uidx
  on public.okta_connector_configs (tenant_id, normalized_org_host, client_id)
  where disabled_at is null and validation_status <> 'failed';

-- POST-verification guard: one ACTIVE connector per (tenant, VERIFIED organization). Deliberately NOT cross-tenant — two IDCaddie
-- tenants may legitimately connect the same Okta org, and blocking that would leak the existence of another tenant's connection.
create unique index if not exists okta_config_verified_org_uidx
  on public.okta_connector_configs (tenant_id, verified_organization_fingerprint)
  where disabled_at is null and verified_organization_fingerprint is not null;

create index if not exists okta_config_owner_idx on public.okta_connector_configs (tenant_id, connector_id);

-- ── (c) RLS -----------------------------------------------------------------------------------------------------------
-- Read: any tenant MEMBER may read their tenant's config (it is non-secret metadata, and viewers need status).
-- Write: NO request-role INSERT/UPDATE/DELETE policy and no write grant. All writes go through the SECURITY DEFINER RPC below,
-- which performs its own owner/admin check. This mirrors `connectors`, which likewise has no request-role write policy.
alter table public.okta_connector_configs enable row level security;
revoke all on public.okta_connector_configs from anon, authenticated;
grant select on public.okta_connector_configs to authenticated;
revoke all on public.okta_connector_configs from connector_runner;
-- The runner reads Okta metadata DIRECTLY from this row — it no longer needs a per-connector secret document.
grant select (tenant_id, connector_id, provider, normalized_org_host, client_id, signing_key_id, signing_key_version,
              contract_version, authentication_mode, approved_scopes, verified_organization_fingerprint)
  on public.okta_connector_configs to connector_runner;

create policy "members read tenant okta connector configs" on public.okta_connector_configs
  for select using (public.is_tenant_member(tenant_id));

-- ── (d) Append-only audit on write -------------------------------------------------------------------------------------
-- DB-SIDE for the same reason as 0042: `audit_logs` has no `authenticated` INSERT, so an app-layer write cannot be trusted to
-- happen. The trigger runs as the table owner and cannot be skipped by any caller.
create or replace function public.audit_okta_connector_config_write()
  returns trigger
  language plpgsql
  security definer
  set search_path = ''
as $$
begin
  insert into public.audit_logs (tenant_id, actor_user_id, action, resource_type, resource_id, after_json)
  values (
    new.tenant_id,
    auth.uid(),
    case when tg_op = 'INSERT' then 'okta_connector_configuration_created' else 'okta_connector_state_changed' end,
    'okta_connector_config',
    new.id,
    -- BOUNDED, non-secret projection only. No raw payload, no free text, no provider response, no key material.
    jsonb_build_object(
      'connector_id', new.connector_id,
      'provider', new.provider,
      'normalized_org_host', new.normalized_org_host,
      'proposed_organization_fingerprint', new.proposed_organization_fingerprint,
      'verified', (new.verified_organization_fingerprint is not null),
      'contract_version', new.contract_version,
      'authentication_mode', new.authentication_mode,
      'public_key_delivery_mode', new.public_key_delivery_mode,
      'validation_status', new.validation_status,
      'certification_only', new.certification_only,
      'production_enabled', new.production_enabled
    )
  );
  return new;
end;
$$;

create trigger okta_connector_config_audit
  after insert or update on public.okta_connector_configs
  for each row execute function public.audit_okta_connector_config_write();

-- ── (e) The ONLY write path -------------------------------------------------------------------------------------------
-- Creates the connector + its Okta configuration atomically, for an OWNER/ADMIN of the target tenant.
--
-- Every authoritative value is DERIVED HERE, never accepted from the caller: tenant comes from the caller's membership check,
-- actor from auth.uid(), scopes/contract/auth-mode/governance from constants, and the connection state is pinned to the existing
-- `configured` — this function is structurally incapable of writing a state that claims verification.
--
-- Fingerprints ARE caller-supplied because the derivation lives in reviewed TypeScript (O1C) and must not be duplicated in PL/pgSQL
-- as a second, drifting implementation. They are bounded to a sha256 shape by CHECK, and — crucially — the caller can only supply
-- the PROPOSED fingerprint; `verified_organization_fingerprint` is not a parameter and cannot be set by this path at all.
create or replace function public.create_okta_connector_configuration(
  p_tenant_id uuid,
  p_normalized_org_host text,
  p_client_id text,
  p_proposed_organization_fingerprint text,
  p_service_app_fingerprint text,
  p_idempotency_key uuid,
  p_display_name text default null
) returns jsonb
  language plpgsql
  security definer
  set search_path = ''
as $$
declare
  v_actor uuid := auth.uid();
  v_existing public.okta_connector_configs%rowtype;
  v_connector_id uuid;
  v_config_id uuid;
begin
  if v_actor is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;
  -- OWNER/ADMIN of THIS tenant. Independent of any browser-supplied role claim.
  if not public.has_tenant_role(p_tenant_id, array['owner', 'admin']) then
    raise exception 'insufficient role for tenant %', p_tenant_id using errcode = '42501';
  end if;
  if p_idempotency_key is null then
    raise exception 'idempotency_key is required' using errcode = '22023';
  end if;

  -- IDEMPOTENT REPLAY: return the existing row, emit NO second created event.
  select * into v_existing from public.okta_connector_configs
    where tenant_id = p_tenant_id and idempotency_key = p_idempotency_key;
  if found then
    return jsonb_build_object(
      'outcome', 'idempotent_replay',
      'connector_id', v_existing.connector_id,
      'config_id', v_existing.id,
      'connection_state', 'configured'
    );
  end if;

  insert into public.connectors (tenant_id, provider, display_name, status, connection_state, granted_scopes_safe, connected_by)
  values (
    p_tenant_id, 'okta', coalesce(p_display_name, 'Okta'),
    'pending',      -- NOT 'active' — nothing has been verified
    'configured',   -- pinned. The EXISTING 0052 state meaning "configuration recorded, nothing verified". This function is
                    -- structurally incapable of writing 'verified' or any discovery/sync state.
    array['okta.users.read', 'okta.groups.read', 'okta.apps.read']::text[],
    v_actor
  )
  returning id into v_connector_id;

  insert into public.okta_connector_configs (
    tenant_id, connector_id, normalized_org_host, client_id,
    proposed_organization_fingerprint, service_app_fingerprint,
    approved_scopes, idempotency_key, created_by
  )
  values (
    p_tenant_id, v_connector_id, p_normalized_org_host, p_client_id,
    p_proposed_organization_fingerprint, p_service_app_fingerprint,
    array['okta.users.read', 'okta.groups.read', 'okta.apps.read']::text[],
    p_idempotency_key, v_actor
  )
  returning id into v_config_id;

  return jsonb_build_object(
    'outcome', 'created',
    'connector_id', v_connector_id,
    'config_id', v_config_id,
    'connection_state', 'configured'
  );
exception
  -- A concurrent request that won the idempotency race: return ITS row rather than failing the retry.
  when unique_violation then
    select * into v_existing from public.okta_connector_configs
      where tenant_id = p_tenant_id and idempotency_key = p_idempotency_key;
    if found then
      return jsonb_build_object(
        'outcome', 'idempotent_replay',
        'connector_id', v_existing.connector_id,
        'config_id', v_existing.id,
        'connection_state', 'configured'
      );
    end if;
    -- A different uniqueness rule was violated (duplicate active target for this tenant) — report it as a safe category.
    return jsonb_build_object('outcome', 'duplicate_configuration');
end;
$$;

revoke all on function public.create_okta_connector_configuration(uuid, text, text, text, text, uuid, text) from public;
grant execute on function public.create_okta_connector_configuration(uuid, text, text, text, text, uuid, text) to authenticated;

commit;

-- OPERATOR NOTES
--  * NOT applied to hosted staging. Applying is a separate, explicitly authorized step.
--  * No DELETE path is exposed for connectors or configs. `connectors` is the parent of 19 `on delete cascade` FKs across 12
--    tables, so deleting one would silently destroy that tenant's canonical directory graph. Disconnect is a future LIFECYCLE
--    TRANSITION (O6), never a row deletion.
--  * No credential reference is created for Okta, and none is required: the approved model has no per-connector secret.
--    `connector_credential_references` is unchanged and remains correct for providers with genuine tenant-specific credentials.
--  * `signing_key_id`/`signing_key_version` stay NULL until O2B provisions the KMS key; a connection cannot be live-validated
--    while they are absent.
