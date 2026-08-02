-- 0080_connector_secret_caller_version.sql
--
-- Phase 8I — the credential version becomes the CALLER's, because the encryption already made it so.
--
-- ══ THE DEFECT ═══════════════════════════════════════════════════════════════════════════════════════════════════════
-- `canonicalAad` (connector-vault crypto) seals the version into the AEAD additional data at ENCRYPT time:
--
--     [tenantId, connectorId, secretKind, String(version)]
--
-- 0079's store wrapper ignored the caller's version and derived its own (`max(version)+1`). On a FIRST store the two
-- agreed by luck. On a RE-AUTHORIZATION they diverge: the ciphertext is sealed with version 1, the row is written as
-- version 2, and the same statement marks the previously working credential inactive — so the connector's only active
-- token can never be opened again, and the write returns success. The failure surfaces far from its cause.
--
-- ══ THE DESIGN, AND WHY NOT THE OTHER ONE ════════════════════════════════════════════════════════════════════════════
-- Two shapes were considered.
--
--   (A) The wrapper RESERVES the next version by inserting a placeholder row; the worker encrypts against that
--       reservation and a second call fills it in.
--   (B) The worker ASKS for the next version, encrypts with it, and the store accepts it under an atomic uniqueness
--       precondition.
--
-- (B) is implemented. (A) needs a placeholder-row lifecycle and an extension of the `status` vocabulary
-- (0017 constrains it to 'active'|'revoked') to hold a row that is neither — new states, new cleanup, new ways to be
-- wrong. Its usual advantage is preventing a race, but both designs compute `max(version)+1`, so in both an abandoned
-- attempt merely burns a number and the next attempt takes the one after. Neither can permanently block a connector.
-- (A) therefore buys nothing here and costs a state machine, so it was not taken.
--
-- The race is handled where it actually lives: a UNIQUE constraint. Two concurrent re-authorizations that both read
-- version N have exactly one winner; the loser gets a unique violation, re-reads, re-encrypts under N+1 and stores.
-- Re-encrypting is the correct response, because the version it sealed is now wrong.

-- The whole file runs as ONE transaction. Without it, a failure partway (most plausibly the unique index below) would
-- leave the new store defined while the old one is already dropped, or vice versa.
begin;

-- ══ 1. UNIQUENESS — the thing that makes a caller-supplied version safe ══════════════════════════════════════════════
-- PRE-FLIGHT, before applying anywhere:
--     select tenant_id, connector_id, secret_kind, version, count(*)
--       from public.connector_secrets group by 1,2,3,4 having count(*) > 1;
-- must return zero rows. 0079 derived versions serially, but `connector_runner` also holds a column-scoped INSERT on
-- this table (0030), so this migration is not the only writer that could ever have produced a duplicate. If the query
-- returns anything, this index creation aborts the transaction — which is the correct outcome, but better known first.
-- Without this, two rows could share a version and "which envelope is version 2" would have no answer. Nothing has
-- ever written a duplicate (0079 derived versions serially), so this is safe to add now and impossible to add later.
create unique index if not exists connector_secrets_version_key
  on public.connector_secrets (tenant_id, connector_id, secret_kind, version);

-- ══ 2. WHICH VERSION SHOULD I SEAL? ══════════════════════════════════════════════════════════════════════════════════
-- The worker must know the version BEFORE it encrypts, and it holds no table grant, so it cannot look. This is the
-- smallest possible answer to that question: one integer, for one connector, for one purpose.
--
-- It reserves nothing. A caller that asks and never stores has changed no state at all — which is precisely why an
-- abandoned attempt cannot block anything.
create or replace function public.oauth_completer_next_connector_secret_version(
  p_tenant_id uuid, p_connector_id uuid
) returns integer language plpgsql security definer set search_path = '' stable as $$
declare v_next integer;
begin
  if not exists (
    select 1 from public.connectors c
     where c.id = p_connector_id and c.tenant_id = p_tenant_id and c.provider = 'slack'
  ) then
    raise exception 'connector does not belong to tenant' using errcode = '42501';
  end if;

  select coalesce(max(s.version), 0) + 1 into v_next
    from public.connector_secrets s
   where s.tenant_id = p_tenant_id and s.connector_id = p_connector_id and s.secret_kind = 'oauth_access';
  return v_next;
end $$;

-- ══ 3. THE STORE, NOW HONOURING THE SEALED VERSION ═══════════════════════════════════════════════════════════════════
-- Replaces 0079's version-deriving store. The old signature is DROPPED below rather than left beside this one: leaving
-- it would leave the defect reachable, and a wrapper that silently rewrites the version is worse than no wrapper.
--
-- Ordering is the safety property. The new row is inserted FIRST and only a successful insert supersedes the previous
-- credential, so any failure — bad envelope, unique violation, connector mismatch — leaves the working token active.
-- The old code superseded in the same breath as writing, which is how a failed store could disarm a connector.
create or replace function public.oauth_completer_store_connector_secret_envelope(
  p_tenant_id uuid,
  p_connector_id uuid,
  p_version integer,            -- the version SEALED INTO THE AAD by the caller; authoritative
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
declare v_prev_id uuid; v_prev_version integer; v_id uuid;
        v_existing_id uuid; v_existing_nonce bytea; v_existing_tag bytea;
begin
  if not exists (
    select 1 from public.connectors c
     where c.id = p_connector_id and c.tenant_id = p_tenant_id and c.provider = 'slack'
  ) then
    raise exception 'connector does not belong to tenant' using errcode = '42501';
  end if;

  if p_version is null or p_version < 1 then
    raise exception 'invalid version' using errcode = '22023';
  end if;
  if p_ciphertext is null or p_dek_wrapped is null or p_aead_nonce is null or p_aead_tag is null
     or p_aad_digest is null or length(p_aad_digest) = 0 or p_key_id is null or length(p_key_id) = 0
     or p_envelope_version is null or p_aead_alg is null or length(p_aead_alg) = 0 then
    raise exception 'incomplete envelope' using errcode = '22023';
  end if;
  if octet_length(p_aead_tag) <> 16 or p_aead_alg <> 'AES-256-GCM' or p_envelope_version < 1 then
    raise exception 'invalid envelope' using errcode = '22023';
  end if;

  -- IDEMPOTENCY, keyed on something that actually identifies the envelope.
  --
  -- NOT `aad_digest`. That is sha256 over (tenant, connector, secret_kind, version) and NOTHING ELSE — crypto.ts says
  -- so in its own comment: "a caller must NEVER treat a matching aadDigest as proof of context binding". This lookup
  -- already pins the version, so for a given connector at a given version the digest is a CONSTANT: comparing it is a
  -- tautology, and two envelopes wrapping two completely different Slack tokens would be indistinguishable.
  --
  -- That is not a theoretical collision. Two concurrent re-authorizations both read version N; the first stores
  -- token A; the second would match on the constant digest, be told `created = false`, and report success while its
  -- token B — which Slack has already issued — is silently discarded. We would hold the wrong credential and say the
  -- connection worked.
  --
  -- The GCM nonce is freshly random per seal (crypto.ts `randomBytes(IV_BYTES)`) and the tag authenticates the
  -- ciphertext, so (nonce, tag) is a genuine envelope identity. A true retry sends identical bytes and is idempotent;
  -- a second, different seal at the same version is refused, which is what a caller needs in order to know to re-read
  -- the version, re-encrypt and try again.
  select s.id, s.aead_nonce, s.aead_tag into v_existing_id, v_existing_nonce, v_existing_tag
    from public.connector_secrets s
   where s.tenant_id = p_tenant_id and s.connector_id = p_connector_id
     and s.secret_kind = 'oauth_access' and s.version = p_version;
  if v_existing_id is not null then
    if v_existing_nonce = p_aead_nonce and v_existing_tag = p_aead_tag then
      return query select v_existing_id, p_version, false; return;
    end if;
    raise exception 'version % already holds a different envelope', p_version using errcode = '23505';
  end if;

  -- The credential this one replaces, resolved BEFORE the insert but superseded only after it.
  select s.id, s.version into v_prev_id, v_prev_version
    from public.connector_secrets s
   where s.tenant_id = p_tenant_id and s.connector_id = p_connector_id
     and s.secret_kind = 'oauth_access' and s.is_active and s.status = 'active'
   order by s.version desc limit 1;

  -- INSERT FIRST. A unique violation here (a concurrent re-authorization won the race) aborts before anything is
  -- superseded; the caller re-reads the next version, re-encrypts and retries.
  insert into public.connector_secrets
    (tenant_id, connector_id, secret_kind, version, is_active, ciphertext, dek_wrapped, aead_nonce, aead_tag,
     aad_digest, key_id, envelope_version, aead_alg, status)
  values
    (p_tenant_id, p_connector_id, 'oauth_access', p_version, true, p_ciphertext, p_dek_wrapped, p_aead_nonce,
     p_aead_tag, p_aad_digest, p_key_id, p_envelope_version, p_aead_alg, 'active')
  returning id into v_id;

  -- Only now. Nothing is deleted; the old envelope is retained and marked, which is what makes an incident
  -- reconstructable.
  if v_prev_id is not null then
    update public.connector_secrets s set is_active = false where s.id = v_prev_id;
    insert into public.connector_secret_lifecycle_events
      (tenant_id, connector_id, secret_kind, version, lifecycle_event_type, reason_class, actor_type, correlation_id)
    values
      (p_tenant_id, p_connector_id, 'oauth_access', v_prev_version, 'superseded', 'reauthorized', 'oauth_completer',
       case when p_correlation_id ~ '^[A-Za-z0-9_.:-]{1,64}$' then p_correlation_id else null end);
  end if;

  return query select v_id, p_version, true;
end $$;

-- The version-deriving store is REMOVED. Leaving it callable would leave the defect reachable.
drop function if exists public.oauth_completer_store_connector_secret_envelope(
  uuid, uuid, bytea, bytea, bytea, bytea, text, text, integer, text, text);

-- ══ 4. LEAST PRIVILEGE — unchanged posture, one more narrow function ══════════════════════════════════════════════════
-- The granted surface goes from three operations to four. It stays NARROW in the sense that matters: every one is
-- purpose-pinned, takes no table name or SQL, and the role still holds no table or sequence privilege. The new reader
-- returns a single integer about one connector.
--
-- On hosted Supabase, ALTER DEFAULT PRIVILEGES grants EXECUTE on new public functions straight to anon/authenticated/
-- service_role (0045), and `revoke from public` alone does not remove it — every role is named.
do $$
declare f text;
begin
  foreach f in array array[
    'public.oauth_completer_next_connector_secret_version(uuid, uuid)',
    'public.oauth_completer_store_connector_secret_envelope(uuid, uuid, integer, bytea, bytea, bytea, bytea, text, text, integer, text, text)'
  ] loop
    execute format('revoke execute on function %s from public, anon, authenticated, service_role, connector_runner', f);
    execute format('grant execute on function %s to oauth_completer', f);
  end loop;
end $$;

commit;
