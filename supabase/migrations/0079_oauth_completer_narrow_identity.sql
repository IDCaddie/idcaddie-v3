-- 0079_oauth_completer_narrow_identity.sql
--
-- The least-privilege database identity that completes a real Slack OAuth callback from the web tier (docs/83).
--
-- ══ WHY THIS ROLE EXISTS ══════════════════════════════════════════════════════════════════════════════════════════════
-- Completing an OAuth callback needs exactly three capabilities: read the app client-secret ENVELOPE, consume the
-- single-use `oauth_pending` row, and store the returned bot-token ENVELOPE.
--
-- The existing code reaches all three through `RunnerConnection` as `connector_runner_login` — the connector runner's
-- identity, which can execute every `runner_*` function in the schema: open runs, insert discovery facts, promote
-- canonical evidence, mark accounts stale. Putting that in a public web tier means a request-path bug does not merely
-- leak a token, it lets an attacker FABRICATE DIRECTORY EVIDENCE. That is a worse outcome than the one we are
-- preventing, and it is why the web tier gets its own role instead.
--
-- ══ THE SHAPE ═════════════════════════════════════════════════════════════════════════════════════════════════════════
-- `oauth_completer` holds NO table grant, NO sequence grant, and EXECUTE on exactly THREE purpose-specific wrappers.
-- The wrappers are `security definer`, so the privilege lives in the function rather than in the caller: if the web tier
-- is fully compromised, the attacker can complete an OAuth flow for a connector that already has a pending row — and can
-- read no customer evidence, write no fact, and stale no account.
--
-- Each wrapper is deliberately NARROW: fixed provider, fixed purpose, no table name, no secret type and no SQL
-- expression as a parameter, no dynamic SQL, and bounded inputs and outputs. There is no generic reader and no generic
-- writer, because a generic one granted to a web tier is the same as a table grant with extra steps.

-- ══ 1. THE ROLE ═══════════════════════════════════════════════════════════════════════════════════════════════════════
-- LOGIN, and deliberately NO PASSWORD: the credential is set out of band so it never exists in a migration, a
-- repository, a diff, a log or a PR. Until it is set, the role cannot authenticate — which is the correct default.
do $$
begin
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'oauth_completer') then
    create role oauth_completer with login nosuperuser nocreatedb nocreaterole noreplication nobypassrls;
  else
    -- Idempotent re-assert. A re-run must never silently widen a role that already exists.
    alter role oauth_completer with login nosuperuser nocreatedb nocreaterole noreplication nobypassrls;
  end if;
end $$;

-- Belt and braces: revoke everything that could already have been granted, then grant back ONLY schema usage, which is
-- the minimum required to resolve `public.<function>` at all. `usage` on a schema conveys no read of any object in it.
revoke all on all tables in schema public from oauth_completer;
revoke all on all sequences in schema public from oauth_completer;
revoke all on all functions in schema public from oauth_completer;
revoke all on schema public from oauth_completer;
grant usage on schema public to oauth_completer;

-- The role must never inherit the runner's or the platform's authority through membership.
do $$
begin
  if exists (select 1 from pg_catalog.pg_roles where rolname = 'connector_runner') then
    revoke connector_runner from oauth_completer;
  end if;
  if exists (select 1 from pg_catalog.pg_roles where rolname = 'service_role') then
    revoke service_role from oauth_completer;
  end if;
end $$;

-- ══ 2. READ THE APP CLIENT-SECRET ENVELOPE ════════════════════════════════════════════════════════════════════════════
-- Returns the ENCRYPTED envelope and the bounded KMS metadata the approved decrypt path needs. It cannot return
-- plaintext because plaintext is not stored — the decrypt happens in the caller against KMS, which is the boundary this
-- preserves rather than replaces.
--
-- provider and purpose are PINNED to the Slack OAuth client secret. They are not parameters: a parameterised secret type
-- is a generic secret reader, and a generic secret reader in a web tier is the thing being avoided.
--
-- p_tenant_id / p_connector_id are not used to select the row (an app secret is app-level, not tenant-level) but ARE
-- verified: the caller must name a real connector that really belongs to that tenant and really is a Slack connector.
-- Without that, any holder of this role could pull the app secret with no context at all.
create or replace function public.oauth_completer_read_app_client_secret_envelope(
  p_app_env text,
  p_tenant_id uuid,
  p_connector_id uuid
) returns table (
  secret_id uuid,
  version integer,
  ciphertext bytea,
  dek_wrapped bytea,
  aead_nonce bytea,
  aead_tag bytea,
  aad_digest text,
  kek_id text,
  envelope_version integer,
  aead_alg text
) language plpgsql security definer set search_path = '' stable as $$
begin
  -- Bounded input. `staging` is the only environment this role is provisioned in; anything else is a misconfiguration
  -- rather than a request to serve.
  if p_app_env is distinct from 'staging' then
    raise exception 'app_env not permitted' using errcode = '42501';
  end if;

  -- Tenant + connector + provider binding, all three, before anything is read.
  if not exists (
    select 1 from public.connectors c
     where c.id = p_connector_id and c.tenant_id = p_tenant_id and c.provider = 'slack'
  ) then
    raise exception 'connector does not belong to tenant' using errcode = '42501';
  end if;

  return query
    select s.id, s.version, s.ciphertext, s.dek_wrapped, s.aead_nonce, s.aead_tag,
           s.aad_digest, s.kek_id, s.envelope_version, s.aead_alg
      from public.connector_app_secrets s
     where s.app_env = 'staging'
       and s.provider = 'slack'
       and s.secret_kind = 'oauth_client_secret'   -- PINNED purpose
       and s.is_active
     order by s.version desc
     limit 1;
end $$;

-- ══ 3. CONSUME THE SINGLE-USE OAUTH PENDING ROW ═══════════════════════════════════════════════════════════════════════
-- The SAME atomic single-use semantics as the existing consume (0020/0021, `oauth-pending-executor.ts`): one UPDATE
-- that sets `consumed_at` only where the row is unconsumed and unexpired, matching on the full key. Reproduced here
-- rather than re-granted, so this role gets the operation and not the table.
--
-- Replay returns the SAME bounded refusal vocabulary the existing consumer classifies: zero rows changed → the caller
-- learns `already_consumed` / `not_found` / `expired` and nothing else. The state-validation contract is NOT duplicated
-- and NOT weakened — the signed state is validated upstream, and this is the durable half of the same gate.
create or replace function public.oauth_completer_consume_oauth_pending(
  p_tenant_id uuid,
  p_connector_id uuid,
  p_state_jti text,
  p_nonce_hash text,
  p_subject uuid,
  p_redirect_uri text,
  p_now timestamptz
) returns table (consumed boolean, reason text) language plpgsql security definer set search_path = '' volatile as $$
declare v_consumed timestamptz; v_expires timestamptz; v_exists boolean;
begin
  -- The redirect is bound in the signed state and re-asserted here against the ONE permitted callback. A mismatch is
  -- refused before the row is touched, so a wrong-redirect attempt cannot burn a legitimate pending row.
  if p_redirect_uri is distinct from 'https://idcaddie-v3.vercel.app/connectors/oauth/callback' then
    return query select false, 'redirect_uri_mismatch'::text; return;
  end if;
  if p_state_jti is null or length(p_state_jti) = 0 or p_nonce_hash is null or length(p_nonce_hash) = 0 then
    return query select false, 'not_found'::text; return;
  end if;

  -- THE atomic consume. Every field of the trusted context is in the WHERE; a row that disagrees on any of them is
  -- simply not matched, which is why a wrong tenant, connector or subject can never consume someone else's row.
  update public.oauth_pending p
     set consumed_at = p_now
   where p.state_jti = p_state_jti
     and p.nonce_hash = p_nonce_hash
     and p.tenant_id = p_tenant_id
     and p.provider = 'slack'                                   -- PINNED provider
     and p.connector_id is not distinct from p_connector_id
     and p.subject is not distinct from p_subject
     and p.consumed_at is null
     and p.expires_at > p_now
   returning p.consumed_at into v_consumed;

  if v_consumed is not null then
    return query select true, null::text; return;
  end if;

  -- Classify the refusal from the row's own state, never from the caller's claim. Read-only, and bounded: the three
  -- codes below are the entire vocabulary this function can emit.
  select (p.consumed_at is not null), p.expires_at into v_exists, v_expires
    from public.oauth_pending p where p.state_jti = p_state_jti;
  if not found then return query select false, 'not_found'::text; return; end if;
  if v_exists then return query select false, 'already_consumed'::text; return; end if;
  if v_expires is not null and v_expires <= p_now then return query select false, 'expired'::text; return; end if;
  return query select false, 'not_found'::text;
end $$;

-- ══ 4. STORE THE CONNECTOR-SECRET ENVELOPE ════════════════════════════════════════════════════════════════════════════
-- Accepts an ALREADY-ENCRYPTED envelope. There is deliberately no plaintext parameter of any kind: the encryption
-- happens in the caller against KMS, and a wrapper that accepted a token would be a plaintext token crossing a
-- privilege boundary and landing in a query log.
--
-- provider and purpose are PINNED (slack / oauth_access). Versioning, lifecycle and audit are preserved: the previous
-- active secret is superseded rather than overwritten, and the supersession is recorded in the lifecycle table with the
-- same bounded metadata the runner writes.
--
-- RETRY-SAFE: a repeated call with the SAME aad_digest returns the existing row rather than minting a second version.
-- A callback retried after a lost response must not leave two active credentials.
create or replace function public.oauth_completer_store_connector_secret_envelope(
  p_tenant_id uuid,
  p_connector_id uuid,
  p_ciphertext bytea,
  p_dek_wrapped bytea,
  p_aead_nonce bytea,
  p_aead_tag bytea,
  p_aad_digest text,
  p_key_id text,
  p_envelope_version integer,
  p_aead_alg text,
  p_correlation_id text
) returns table (secret_id uuid, version integer, created boolean)
language plpgsql security definer set search_path = '' volatile as $$
declare v_prev_id uuid; v_prev_version integer; v_next integer; v_id uuid; v_existing uuid; v_existing_v integer;
begin
  if not exists (
    select 1 from public.connectors c
     where c.id = p_connector_id and c.tenant_id = p_tenant_id and c.provider = 'slack'
  ) then
    raise exception 'connector does not belong to tenant' using errcode = '42501';
  end if;

  -- Every envelope component must be present. A partially-supplied envelope is unopenable, and storing one would create
  -- a credential that looks active and can never be used.
  if p_ciphertext is null or p_dek_wrapped is null or p_aead_nonce is null or p_aead_tag is null
     or p_aad_digest is null or length(p_aad_digest) = 0 or p_key_id is null or length(p_key_id) = 0
     or p_envelope_version is null or p_aead_alg is null or length(p_aead_alg) = 0 then
    raise exception 'incomplete envelope' using errcode = '22023';
  end if;
  -- The GCM tag is exactly 16 bytes and the algorithm is the one supported label. Both are already table constraints;
  -- checking here too means a malformed envelope produces a bounded error instead of a constraint-violation message
  -- carrying a constraint name into a redirect.
  if octet_length(p_aead_tag) <> 16 or p_aead_alg <> 'AES-256-GCM' or p_envelope_version < 1 then
    raise exception 'invalid envelope' using errcode = '22023';
  end if;

  -- Idempotency: same envelope digest for this connector -> return what is already stored.
  select s.id, s.version into v_existing, v_existing_v
    from public.connector_secrets s
   where s.tenant_id = p_tenant_id and s.connector_id = p_connector_id
     and s.secret_kind = 'oauth_access' and s.aad_digest = p_aad_digest
   order by s.version desc limit 1;
  if v_existing is not null then
    return query select v_existing, v_existing_v, false; return;
  end if;

  select s.id, s.version into v_prev_id, v_prev_version
    from public.connector_secrets s
   where s.tenant_id = p_tenant_id and s.connector_id = p_connector_id
     and s.secret_kind = 'oauth_access' and s.is_active and s.status = 'active'
   order by s.version desc limit 1;

  select coalesce(max(s.version), 0) + 1 into v_next
    from public.connector_secrets s
   where s.tenant_id = p_tenant_id and s.connector_id = p_connector_id and s.secret_kind = 'oauth_access';

  insert into public.connector_secrets
    (tenant_id, connector_id, secret_kind, version, is_active, ciphertext, dek_wrapped, aead_nonce, aead_tag,
     aad_digest, key_id, envelope_version, aead_alg, status)
  values
    (p_tenant_id, p_connector_id, 'oauth_access', v_next, true, p_ciphertext, p_dek_wrapped, p_aead_nonce, p_aead_tag,
     p_aad_digest, p_key_id, p_envelope_version, p_aead_alg, 'active')
  returning id into v_id;

  -- Supersede the previous active credential and record it. Nothing is deleted; the old envelope is retained and
  -- marked, which is what makes an incident reconstructable.
  if v_prev_id is not null then
    update public.connector_secrets s set is_active = false where s.id = v_prev_id;
    insert into public.connector_secret_lifecycle_events
      (tenant_id, connector_id, secret_kind, version, lifecycle_event_type, reason_class, actor_type, correlation_id)
    values
      (p_tenant_id, p_connector_id, 'oauth_access', v_prev_version, 'superseded', 'reauthorized', 'oauth_completer',
       -- Grammar-safe or nothing: a correlation id is metadata, and free-form text here would be an injection surface
       -- into an audit record.
       case when p_correlation_id ~ '^[A-Za-z0-9_.:-]{1,64}$' then p_correlation_id else null end);
  end if;

  return query select v_id, v_next, true;
end $$;

-- ══ 5. LEAST PRIVILEGE ON THE THREE WRAPPERS ══════════════════════════════════════════════════════════════════════════
-- On hosted Supabase, ALTER DEFAULT PRIVILEGES grants EXECUTE on every new public function straight to anon,
-- authenticated and service_role (0045), and `revoke from public` alone does NOT remove that. Every role is named.
-- `connector_runner` is named too: the runner has its own path and must not acquire a second one.
do $$
declare f text;
begin
  foreach f in array array[
    'public.oauth_completer_read_app_client_secret_envelope(text, uuid, uuid)',
    'public.oauth_completer_consume_oauth_pending(uuid, uuid, text, text, uuid, text, timestamptz)',
    'public.oauth_completer_store_connector_secret_envelope(uuid, uuid, bytea, bytea, bytea, bytea, text, text, integer, text, text)'
  ] loop
    execute format('revoke execute on function %s from public, anon, authenticated, service_role, connector_runner', f);
    execute format('grant execute on function %s to oauth_completer', f);
  end loop;
end $$;

-- Re-assert the deny posture AFTER creating the functions: `grant execute on all functions` style statements elsewhere,
-- and any default privilege, must not have handed this role anything beyond the three above.
do $$
declare f record;
begin
  for f in
    select p.oid::regprocedure as sig
      from pg_catalog.pg_proc p
      join pg_catalog.pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.proname not like 'oauth\_completer\_%'
  loop
    execute format('revoke all on function %s from oauth_completer', f.sig);
  end loop;
end $$;

-- ══ 6. CLOSE THE INHERITED `PUBLIC` DEFINER SURFACE ═══════════════════════════════════════════════════════════════════
-- Postgres grants EXECUTE on every new function to PUBLIC, so nine SECURITY DEFINER RLS predicate helpers were reachable
-- by ANY role — including a brand-new one that was just given no privileges at all. Revoking them from
-- `oauth_completer` does nothing, because the grant is to PUBLIC, not to the role.
--
-- In practice the escalation value is near zero: each returns a BOOLEAN about `auth.uid()`, and a direct Postgres
-- connection has no JWT, so they all answer `false`. But "near zero" is a property of today's implementation, and the
-- point of this role is that its reachable surface is a list you can read in one glance.
--
-- `authenticated` and `service_role` ALREADY hold explicit grants on all nine, and `anon` is re-granted explicitly here,
-- so this removes the implicit PUBLIC path WITHOUT changing what any existing role can do. RLS policies that call these
-- predicates are unaffected.
do $$
declare f text;
begin
  foreach f in array array[
    'public.has_tenant_role(uuid, text[])',
    'public.is_tenant_member(uuid)',
    'public.is_tenant_participant(uuid)',
    'public.has_org_role(uuid, text[])',
    'public.has_org_role_in_tenant(uuid, uuid, text[])',
    'public.is_org_member(uuid)',
    'public.can_write_contract(uuid, uuid)',
    'public.can_read_contract_file(uuid, uuid)',
    'public.can_write_contract_file(uuid, uuid)'
  ] loop
    execute format('revoke execute on function %s from public', f);
    execute format('grant execute on function %s to anon, authenticated, service_role', f);
  end loop;
end $$;
