-- 0081_oauth_completion_jobs.sql
--
-- Phase 8J — the durable, one-time OAuth completion job (docs/83 §6, remaining work item 1).
--
-- ══ WHY THIS TABLE EXISTS ═════════════════════════════════════════════════════════════════════════════════════════════
-- Slack returns the authorization code to a BROWSER redirect that lands on Vercel. The exchange that turns that code into
-- a bot token needs the client secret, KMS, and a database identity — none of which may live in the web tier (doc 46 §11,
-- `scripts/check-app-runtime-imports.sh`). So the web tier cannot complete the flow; it can only HAND IT OFF.
--
-- A hand-off across a process boundary needs somewhere durable to put the request, because the user's browser has already
-- returned and the code is valid for minutes. That is this table. It is the only new state on the critical path, and it
-- is deliberately the smallest thing that can be one-time, atomic and auditable.
--
-- ══ WHAT IT IS NOT ════════════════════════════════════════════════════════════════════════════════════════════════════
-- It is NOT a queue. There is no priority, no visibility timeout, no retry loop, no dead-letter. One row is one OAuth
-- callback, claimed once, resolved once, and then it is history. A job carries no capability of its own: `oauth_completer`
-- still holds ZERO table privileges (0079) and no `runner_*`/`product_*` grant, so working a job cannot open a discovery
-- run, write a fact, promote canonical evidence, or stale an account. That property is asserted, not assumed.
--
-- ══ THE AUTHORIZATION CODE ════════════════════════════════════════════════════════════════════════════════════════════
-- It is NEVER stored in plaintext and there is no column or parameter that could hold one. What is stored is an opaque
-- envelope sealed to the WORKER's public key: the web tier holds the public half and can only encrypt; only the isolated
-- worker holds the private half and can decrypt. The database — including `service_role`, a dashboard session, and a
-- backup — holds bytes it cannot open. `protected_payload` is opaque HERE on purpose: nothing in this migration parses
-- it, so nothing in this migration can leak a part of it.
--
-- ══ THE CLOCK BELONGS TO THE DATABASE ═════════════════════════════════════════════════════════════════════════════════
-- 0079's consume takes `p_now` from the caller, which is right for a wrapper whose whole job is one atomic UPDATE against
-- context the caller already owns. It is WRONG here: "short-lived" is the security property of this table, and a caller
-- that chooses the clock chooses the deadline. Every wrapper below reads `now()` itself and takes no time parameter.

begin;

-- ══ 1. THE JOB ════════════════════════════════════════════════════════════════════════════════════════════════════════
create table public.oauth_completion_jobs (
  id uuid primary key default gen_random_uuid(),

  -- Tenant-bound and connector-bound, with the SAME-TENANT composite FK the vault has used since 0056: a job can only
  -- ever reference a connector that really belongs to its own tenant.
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  connector_id uuid not null,

  -- Provider is PINNED, not classified. A second provider is a new decision, not a new row value.
  provider text not null,

  -- The state JTI from the authorize half. This is the job's identity: unique, so one authorize can produce at most one
  -- completion job, forever.
  correlation_id text not null,

  -- The exact callback the code was issued against, and the workspace the token must belong to. Both are re-asserted at
  -- completion time; both are stored so a job cannot be worked against a redirect or workspace it was not created for.
  redirect_uri text not null,
  expected_team_id text not null,

  -- The sealed authorization code. Nullable ONLY because a terminal job has had it irreversibly cleared.
  protected_payload bytea,
  payload_scheme text,
  payload_key_id text,

  -- sha256 over the whole enqueue request INCLUDING the sealed bytes. This is what makes idempotency mean something —
  -- see the enqueue wrapper for why a digest over the bound fields alone would be a tautology.
  body_digest text not null,

  status text not null default 'pending',
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  claimed_at timestamptz,
  completed_at timestamptz,
  terminal_reason text,
  attempt_count integer not null default 0,

  constraint oauth_completion_jobs_correlation_key unique (correlation_id),
  constraint oauth_completion_jobs_connector_same_tenant
    foreign key (connector_id, tenant_id) references public.connectors (id, tenant_id) on delete cascade,

  -- ── Bounded values. Every one of these is also checked in the wrapper, so a bad input produces a bounded static
  -- refusal instead of a constraint-violation message carrying a constraint name into a redirect. The constraints are
  -- here anyway: a wrapper check protects the wrapper's callers, a constraint protects the table.
  constraint oauth_completion_jobs_provider_check check (provider = 'slack'),
  constraint oauth_completion_jobs_redirect_check
    check (redirect_uri = 'https://idcaddie-v3.vercel.app/connectors/oauth/callback'),
  -- Matches `connector-oauth-config.ts` (`/^T[A-Z0-9]{2,}$/`) with a length ceiling, because a database column needs one.
  constraint oauth_completion_jobs_team_check check (expected_team_id ~ '^T[A-Z0-9]{2,30}$'),
  constraint oauth_completion_jobs_correlation_check check (correlation_id ~ '^[A-Za-z0-9_.:-]{1,64}$'),
  constraint oauth_completion_jobs_digest_check check (body_digest ~ '^[0-9a-f]{64}$'),
  constraint oauth_completion_jobs_status_check
    check (status in ('pending', 'claimed', 'completed', 'failed', 'expired')),
  -- The ENTIRE terminal vocabulary. A provider error string, a database error, or a host can never appear here because
  -- there is no value in this list that could carry one.
  constraint oauth_completion_jobs_terminal_reason_check
    check (terminal_reason is null or terminal_reason in
      ('expired', 'exchange_failed', 'workspace_mismatch', 'state_consume_failed', 'store_failed', 'internal')),
  -- Honest about what this counts today: a job goes `pending -> claimed` once and never returns to `pending`, so this
  -- only ever reaches 1. It is a bound, not a retry budget, and there is no re-arm path. It exists because a terminal
  -- row has had its payload cleared, and this is then the only surviving evidence that a worker ever picked the job up.
  constraint oauth_completion_jobs_attempt_bound check (attempt_count between 0 and 3),
  constraint oauth_completion_jobs_payload_scheme_check
    check (payload_scheme is null or payload_scheme = 'X25519-HKDF-SHA256-AES-256-GCM'),
  constraint oauth_completion_jobs_payload_key_check
    check (payload_key_id is null or payload_key_id ~ '^[A-Za-z0-9_.:-]{1,128}$'),
  -- A floor (an X25519 header alone is 60 bytes) and a ceiling, so neither an empty seal nor an unbounded blob lands.
  constraint oauth_completion_jobs_payload_bound
    check (protected_payload is null or octet_length(protected_payload) between 60 and 8192),

  -- ── SHORT-LIVED, structurally. The wrapper writes a 10-minute deadline; this is the ceiling no writer may exceed,
  -- including a privileged one inserting directly.
  constraint oauth_completion_jobs_ttl
    check (expires_at > created_at and expires_at <= created_at + interval '15 minutes'),

  -- ── LIFECYCLE INVARIANTS. The 0070 rule — state a row cannot be in is a CHECK, not a convention.
  constraint oauth_completion_jobs_pending_shape check (
    status <> 'pending' or (
      claimed_at is null and completed_at is null and terminal_reason is null
      and protected_payload is not null and payload_scheme is not null and payload_key_id is not null)),
  -- A claimed job MAY have a null payload: the sweep clears a stale claim's sealed code without stealing the terminal
  -- transition from the worker that owns it.
  constraint oauth_completion_jobs_claimed_shape check (
    status <> 'claimed' or (
      claimed_at is not null and completed_at is null and terminal_reason is null and attempt_count > 0)),
  -- THE headline invariant: a terminal row holds no sealed material. Not "should not" — cannot.
  constraint oauth_completion_jobs_terminal_shape check (
    status not in ('completed', 'failed', 'expired') or (
      completed_at is not null
      and protected_payload is null and payload_scheme is null and payload_key_id is null)),
  constraint oauth_completion_jobs_completed_reason check (status <> 'completed' or terminal_reason is null),
  constraint oauth_completion_jobs_unhappy_reason check (status not in ('failed', 'expired') or terminal_reason is not null)
);

comment on table public.oauth_completion_jobs is
  'One durable, single-use Slack OAuth callback hand-off. The authorization code exists here only as an envelope sealed to the worker''s public key; a terminal row holds none of it.';
comment on column public.oauth_completion_jobs.protected_payload is
  'Opaque envelope sealed to the worker public key. The database never parses it and cannot open it. Cleared on every terminal transition.';
comment on column public.oauth_completion_jobs.body_digest is
  'sha256 over the whole enqueue request INCLUDING the sealed bytes — computed by the wrapper, never supplied. Two different seals for one correlation are different requests.';

-- The only scan in this design that would otherwise grow without bound. Partial, so it holds open jobs only and shrinks
-- as they terminalize.
create index oauth_completion_jobs_open_key on public.oauth_completion_jobs (expires_at)
  where status in ('pending', 'claimed');

-- ══ 2. TIER-2 DENY-ALL ════════════════════════════════════════════════════════════════════════════════════════════════
-- RLS on with ZERO policies, and every grant revoked — the 0018/0076 posture. Reads go through the bounded product RPC;
-- writes go through the definer wrappers. `oauth_completer` is named explicitly: the identity that WORKS these jobs still
-- holds no privilege on the table that holds them.
alter table public.oauth_completion_jobs enable row level security;
revoke all on public.oauth_completion_jobs from public, anon, authenticated, connector_runner, oauth_completer;

-- ══ 3. ENQUEUE — idempotent on the REQUEST, not merely on the correlation ═════════════════════════════════════════════
-- Called by the worker's hand-off entrypoint, never by the web tier: v3 is pg-free and must never hold
-- `OAUTH_COMPLETER_DB_URL` (doc 83 §2).
--
-- ══ WHY THE DIGEST COVERS THE SEALED BYTES ════════════════════════════════════════════════════════════════════════════
-- This is the 0080 lesson applied one layer up. `aad_digest` failed as an idempotency key because it was sha256 over
-- fields the lookup had already pinned — a tautology, so two different tokens were indistinguishable. A digest over
-- (tenant, connector, provider, redirect, workspace, correlation) would fail the same way: the correlation lookup pins
-- every one of them, so every request for a given correlation would compare equal, and a SUBSTITUTED authorization code
-- under a replayed correlation would be accepted as "the same request" and reported as success.
--
-- So the digest covers `protected_payload` too. The consequence is deliberate and worth stating plainly: a caller that
-- RE-SEALS is making a NEW request (the ephemeral key and nonce are fresh per seal) and is refused. Idempotency here
-- means "the same bytes, sent again" — a lost response retried with the buffer it already had — which is exactly what a
-- transport retry is. A caller that genuinely re-sealed should read the job's status, not enqueue a second one.
create or replace function public.oauth_completer_enqueue_oauth_completion_job(
  p_tenant_id uuid,
  p_connector_id uuid,
  p_correlation_id text,
  p_redirect_uri text,
  p_expected_team_id text,
  p_protected_payload bytea,
  p_payload_scheme text,
  p_payload_key_id text
) returns table (job_id uuid, was_created boolean, job_expires_at timestamptz)
language plpgsql security definer set search_path = '' volatile as $$
declare
  v_now timestamptz := now();
  v_digest text;
  v_existing public.oauth_completion_jobs%rowtype;
  v_id uuid;
  v_expires timestamptz;
begin
  -- Bounded inputs BEFORE anything is read, so a malformed request never becomes a lookup.
  if p_redirect_uri is distinct from 'https://idcaddie-v3.vercel.app/connectors/oauth/callback' then
    raise exception 'redirect_uri not permitted' using errcode = '42501';
  end if;
  if p_correlation_id is null or p_correlation_id !~ '^[A-Za-z0-9_.:-]{1,64}$' then
    raise exception 'invalid correlation' using errcode = '22023';
  end if;
  if p_expected_team_id is null or p_expected_team_id !~ '^T[A-Z0-9]{2,30}$' then
    raise exception 'invalid workspace' using errcode = '22023';
  end if;
  if p_payload_scheme is distinct from 'X25519-HKDF-SHA256-AES-256-GCM' then
    raise exception 'unsupported payload scheme' using errcode = '22023';
  end if;
  if p_payload_key_id is null or p_payload_key_id !~ '^[A-Za-z0-9_.:-]{1,128}$' then
    raise exception 'invalid payload key' using errcode = '22023';
  end if;
  if p_protected_payload is null
     or octet_length(p_protected_payload) < 60 or octet_length(p_protected_payload) > 8192 then
    raise exception 'invalid protected payload' using errcode = '22023';
  end if;

  if not exists (
    select 1 from public.connectors c
     where c.id = p_connector_id and c.tenant_id = p_tenant_id and c.provider = 'slack'
  ) then
    raise exception 'connector does not belong to tenant' using errcode = '42501';
  end if;

  -- Every field above is either a uuid, a pinned literal, or grammar-bounded to characters that exclude the separator,
  -- so a newline-joined digest cannot be forged by shifting a boundary between two fields.
  v_digest := encode(sha256(
    convert_to(
      p_tenant_id::text || E'\n' || p_connector_id::text || E'\n' || 'slack' || E'\n' ||
      p_redirect_uri || E'\n' || p_expected_team_id || E'\n' || p_correlation_id || E'\n' ||
      p_payload_scheme || E'\n' || p_payload_key_id || E'\n', 'UTF8'
    ) || p_protected_payload), 'hex');

  -- IDEMPOTENCY is resolved BEFORE the authorize-half gate below, so a retry still works after the pending row has been
  -- consumed by the completion this job already drove.
  select * into v_existing from public.oauth_completion_jobs j where j.correlation_id = p_correlation_id;
  if found then
    -- DEATH OUTRANKS IDENTITY. An expired correlation is not revived by anything, so it is answered before the request
    -- is even compared: a caller retrying its own bytes against a dead correlation needs to be told the correlation is
    -- dead (re-authorize), not that its request looks different. Both are refusals either way.
    if v_existing.status = 'expired' then
      raise exception 'correlation expired' using errcode = '42501';
    end if;
    if v_existing.tenant_id <> p_tenant_id or v_existing.connector_id <> p_connector_id
       or v_existing.body_digest <> v_digest then
      raise exception 'correlation already used by a different request' using errcode = '23505';
    end if;
    return query select v_existing.id, false, v_existing.expires_at; return;
  end if;

  -- A completion job may only exist for a correlation that really came from the authorize half, and only while that
  -- authorization is still live. This does not replace the atomic consume at completion time (0079) — it moves the
  -- refusal earlier so a fabricated correlation never becomes a durable row.
  --
  -- The connector must MATCH, not merely be compatible, which means the pending row's `connector_id` must be set. That
  -- is the re-authorization shape, and it is the only shape this flow has: doc 83 §3.3 pins
  -- `CONNECTOR_OAUTH_EXPECTED_CONNECTOR_ID` and 0079's consume already requires the same equality. A future
  -- fresh-connect flow (`oauth_pending.connector_id is null`) would need a deliberate change here, not a looser
  -- comparison — a job whose connector is unknown cannot be bound to one.
  if not exists (
    select 1 from public.oauth_pending p
     where p.state_jti = p_correlation_id
       and p.tenant_id = p_tenant_id
       and p.provider = 'slack'
       and p.connector_id = p_connector_id
       and p.consumed_at is null
       and p.expires_at > v_now
  ) then
    raise exception 'no live authorization for this correlation' using errcode = '42501';
  end if;

  v_expires := v_now + interval '10 minutes';

  begin
    insert into public.oauth_completion_jobs
      (tenant_id, connector_id, provider, correlation_id, redirect_uri, expected_team_id,
       protected_payload, payload_scheme, payload_key_id, body_digest, status, created_at, expires_at)
    values
      (p_tenant_id, p_connector_id, 'slack', p_correlation_id, p_redirect_uri, p_expected_team_id,
       p_protected_payload, p_payload_scheme, p_payload_key_id, v_digest, 'pending', v_now, v_expires)
    returning oauth_completion_jobs.id into v_id;
  exception when unique_violation then
    -- A concurrent enqueue won the correlation between the lookup and the insert. Re-resolve against what it wrote,
    -- rather than surfacing a raw constraint violation: two honest retries of the same request must both succeed.
    select * into v_existing from public.oauth_completion_jobs j where j.correlation_id = p_correlation_id;
    if not found or v_existing.body_digest <> v_digest
       or v_existing.tenant_id <> p_tenant_id or v_existing.connector_id <> p_connector_id then
      raise exception 'correlation already used by a different request' using errcode = '23505';
    end if;
    return query select v_existing.id, false, v_existing.expires_at; return;
  end;

  return query select v_id, true, v_expires;
end $$;

-- ══ 4. CLAIM — atomic, one winner ═════════════════════════════════════════════════════════════════════════════════════
-- The single UPDATE is the whole mechanism. Under READ COMMITTED a second concurrent claimer blocks on the row lock,
-- re-evaluates the WHERE against the row the winner just wrote, sees `status = 'claimed'`, and matches nothing. There is
-- no advisory lock, no SELECT ... FOR UPDATE, and no window between deciding and writing.
create or replace function public.oauth_completer_claim_oauth_completion_job(
  p_tenant_id uuid,
  p_connector_id uuid,
  p_correlation_id text
) returns table (
  claimed boolean,
  job_id uuid,
  refusal text,
  sealed_payload bytea,
  sealed_scheme text,
  sealed_key_id text,
  expected_workspace_id text,
  attempts integer
) language plpgsql security definer set search_path = '' volatile as $$
declare
  v_now timestamptz := now();
  v_id uuid; v_payload bytea; v_scheme text; v_key text; v_team text; v_attempts integer;
  v_status text;
begin
  -- THE claim, and the ONLY gate on it. Every field of the trusted context is in the WHERE, so a wrong tenant,
  -- connector or provider simply does not match — it cannot claim, and it cannot burn, someone else's job. The deadline
  -- is in the same WHERE rather than in a preceding statement, so the claim's safety does not depend on anything having
  -- run before it.
  update public.oauth_completion_jobs j
     set status = 'claimed', claimed_at = v_now, attempt_count = j.attempt_count + 1
   where j.correlation_id = p_correlation_id
     and j.tenant_id = p_tenant_id
     and j.connector_id = p_connector_id
     and j.provider = 'slack'
     and j.status = 'pending'
     and j.expires_at > v_now
  returning j.id, j.protected_payload, j.payload_scheme, j.payload_key_id, j.expected_team_id, j.attempt_count
       into v_id, v_payload, v_scheme, v_key, v_team, v_attempts;

  if v_id is not null then
    return query select true, v_id, null::text, v_payload, v_scheme, v_key, v_team, v_attempts; return;
  end if;

  -- Classify from the ROW's own state, never from the caller's claim, and only within the caller's own tenant and
  -- connector — so a cross-tenant probe learns `not_found` and nothing else.
  select j.status into v_status
    from public.oauth_completion_jobs j
   where j.correlation_id = p_correlation_id
     and j.tenant_id = p_tenant_id
     and j.connector_id = p_connector_id;

  if v_status is null then
    return query select false, null::uuid, 'not_found'::text,
                        null::bytea, null::text, null::text, null::text, null::integer;
    return;
  end if;

  -- A job still `pending` after the claim above declined it has a deadline that has passed. Retire it HERE rather than
  -- leaving it for the sweep: whoever discovers an expired job is the right moment to clear its sealed authorization
  -- code, and doing it on the discovery path means an abandoned flow does not hold one until the next sweep runs.
  if v_status = 'pending' then
    update public.oauth_completion_jobs j
       set status = 'expired', completed_at = v_now, terminal_reason = 'expired',
           protected_payload = null, payload_scheme = null, payload_key_id = null
     where j.correlation_id = p_correlation_id
       and j.tenant_id = p_tenant_id
       and j.connector_id = p_connector_id
       and j.status = 'pending'
       and j.expires_at <= v_now;
    -- Re-read rather than assume: a concurrent session may have been the one that moved it, and reporting `expired`
    -- for a job somebody else just claimed would be a comfortable lie.
    select j.status into v_status
      from public.oauth_completion_jobs j
     where j.correlation_id = p_correlation_id
       and j.tenant_id = p_tenant_id
       and j.connector_id = p_connector_id;
  end if;

  return query select false, null::uuid,
    case v_status when 'claimed' then 'already_claimed'
                  when 'expired' then 'expired'
                  when 'pending' then 'not_claimable'
                  else 'terminal' end,
    null::bytea, null::text, null::text, null::text, null::integer;
end $$;

-- ══ 5. TERMINAL: COMPLETED ════════════════════════════════════════════════════════════════════════════════════════════
-- `status = 'claimed'` in the WHERE is what makes this terminal EXACTLY once and unreachable from `pending`: a job that
-- was never claimed cannot be completed, and a job already completed no longer matches. The payload is cleared in the
-- same statement, so there is no window in which a terminal row still holds a sealed code.
--
-- This wrapper touches ONLY this table. Storing the token is a separate, separately-granted operation (0080), and
-- nothing here can supersede, revoke or otherwise disturb a connector's existing credentials.
create or replace function public.oauth_completer_complete_oauth_completion_job(
  p_tenant_id uuid,
  p_connector_id uuid,
  p_correlation_id text
) returns table (completed boolean, refusal text)
language plpgsql security definer set search_path = '' volatile as $$
declare v_now timestamptz := now(); v_id uuid; v_status text;
begin
  update public.oauth_completion_jobs j
     set status = 'completed', completed_at = v_now,
         protected_payload = null, payload_scheme = null, payload_key_id = null
   where j.correlation_id = p_correlation_id
     and j.tenant_id = p_tenant_id
     and j.connector_id = p_connector_id
     and j.provider = 'slack'
     and j.status = 'claimed'
  returning j.id into v_id;

  if v_id is not null then return query select true, null::text; return; end if;

  select j.status into v_status from public.oauth_completion_jobs j
   where j.correlation_id = p_correlation_id and j.tenant_id = p_tenant_id and j.connector_id = p_connector_id;
  if v_status is null then return query select false, 'not_found'::text; return; end if;
  return query select false,
    case v_status when 'pending' then 'not_claimed' else 'already_terminal' end;
end $$;

-- ══ 6. TERMINAL: FAILED ═══════════════════════════════════════════════════════════════════════════════════════════════
-- Same gate, same clearing. The reason is drawn from a fixed vocabulary and validated before the row is touched, so a
-- provider message, a database error or a host can never be written here — there is no argument value that could carry
-- one. `expired` is deliberately NOT in the accepted set: only the deadline may declare a job expired.
create or replace function public.oauth_completer_fail_oauth_completion_job(
  p_tenant_id uuid,
  p_connector_id uuid,
  p_correlation_id text,
  p_terminal_reason text
) returns table (failed boolean, refusal text)
language plpgsql security definer set search_path = '' volatile as $$
declare v_now timestamptz := now(); v_id uuid; v_status text;
begin
  if p_terminal_reason is null or p_terminal_reason not in
     ('exchange_failed', 'workspace_mismatch', 'state_consume_failed', 'store_failed', 'internal') then
    raise exception 'terminal reason not permitted' using errcode = '22023';
  end if;

  update public.oauth_completion_jobs j
     set status = 'failed', completed_at = v_now, terminal_reason = p_terminal_reason,
         protected_payload = null, payload_scheme = null, payload_key_id = null
   where j.correlation_id = p_correlation_id
     and j.tenant_id = p_tenant_id
     and j.connector_id = p_connector_id
     and j.provider = 'slack'
     and j.status = 'claimed'
  returning j.id into v_id;

  if v_id is not null then return query select true, null::text; return; end if;

  select j.status into v_status from public.oauth_completion_jobs j
   where j.correlation_id = p_correlation_id and j.tenant_id = p_tenant_id and j.connector_id = p_connector_id;
  if v_status is null then return query select false, 'not_found'::text; return; end if;
  return query select false,
    case v_status when 'pending' then 'not_claimed' else 'already_terminal' end;
end $$;

-- ══ 7. EXPIRY SWEEP ═══════════════════════════════════════════════════════════════════════════════════════════════════
-- The claim wrapper already makes an expired job unusable. This exists for the other half of the requirement: a sealed
-- authorization code must not sit in the table after its deadline just because nobody came back for it.
--
-- A CLAIMED job past its deadline keeps its status. Its terminal transition belongs to the worker that claimed it, and
-- expiring it underneath that worker would report `expired` to a customer whose connection actually completed. Its
-- sealed code is still cleared, because the code is worthless at Slack by then and the row must not keep holding it.
create or replace function public.oauth_completer_expire_oauth_completion_jobs()
returns integer language plpgsql security definer set search_path = '' volatile as $$
declare v_now timestamptz := now(); v_n integer;
begin
  update public.oauth_completion_jobs j
     set status = 'expired', completed_at = v_now, terminal_reason = 'expired',
         protected_payload = null, payload_scheme = null, payload_key_id = null
   where j.status = 'pending' and j.expires_at <= v_now;
  get diagnostics v_n = row_count;

  update public.oauth_completion_jobs j
     set protected_payload = null, payload_scheme = null, payload_key_id = null
   where j.status = 'claimed' and j.expires_at <= v_now and j.protected_payload is not null;

  return v_n;
end $$;

-- ══ 8. THE CUSTOMER-SAFE STATUS READ ══════════════════════════════════════════════════════════════════════════════════
-- The ONE read a browser may perform, and the only wrapper here granted to `authenticated`. It returns five bounded,
-- non-secret fields and there is no argument that could widen it: no payload, no scheme, no key id, no body digest, no
-- attempt count, no claim time, no connector internals, and no raw provider or database error — `terminal_reason` is
-- CHECK-constrained to a six-value vocabulary.
--
-- A caller without the role gets an EMPTY SET rather than an error (the 0061 convention), so a denied read is
-- indistinguishable from a job that does not exist, and another tenant's job is indistinguishable from both.
create or replace function public.product_oauth_completion_job_status(
  p_tenant_id uuid,
  p_correlation_id text
) returns table (
  job_status text,
  job_created_at timestamptz,
  job_expires_at timestamptz,
  job_completed_at timestamptz,
  job_terminal_reason text
) language plpgsql security definer set search_path = '' stable as $$
begin
  if not public.has_tenant_role(p_tenant_id, array['owner', 'admin']) then return; end if;
  return query
    select j.status, j.created_at, j.expires_at, j.completed_at, j.terminal_reason
      from public.oauth_completion_jobs j
     where j.tenant_id = p_tenant_id and j.correlation_id = p_correlation_id;
end $$;

-- ══ 9. LEAST PRIVILEGE ════════════════════════════════════════════════════════════════════════════════════════════════
-- On hosted Supabase, ALTER DEFAULT PRIVILEGES grants EXECUTE on every new public function straight to anon,
-- authenticated and service_role (0045), and Postgres itself grants EXECUTE to PUBLIC — so `revoke from public` alone
-- removes neither. Every role is named. `connector_runner` is named too: the runner has its own path and must not
-- acquire a second one.
do $$
declare f text;
begin
  foreach f in array array[
    'public.oauth_completer_enqueue_oauth_completion_job(uuid, uuid, text, text, text, bytea, text, text)',
    'public.oauth_completer_claim_oauth_completion_job(uuid, uuid, text)',
    'public.oauth_completer_complete_oauth_completion_job(uuid, uuid, text)',
    'public.oauth_completer_fail_oauth_completion_job(uuid, uuid, text, text)',
    'public.oauth_completer_expire_oauth_completion_jobs()'
  ] loop
    execute format('revoke execute on function %s from public, anon, authenticated, service_role, connector_runner', f);
    execute format('grant execute on function %s to oauth_completer', f);
  end loop;
end $$;

-- The product read is the mirror image, and `oauth_completer` is named in the REVOKE: the identity that works a job must
-- not hold the customer's read. 0079's blanket revoke loop ran before this function existed and would not have covered
-- it — the PUBLIC grant Postgres creates with every function is removed here, explicitly.
revoke execute on function public.product_oauth_completion_job_status(uuid, text)
  from public, anon, service_role, connector_runner, oauth_completer;
grant execute on function public.product_oauth_completion_job_status(uuid, text) to authenticated;

-- ══ 10. CLOSE THE INHERITED `PUBLIC` DEFINER SURFACE ON TRIGGER FUNCTIONS ═════════════════════════════════════════════
-- 0079 §6 removed the implicit PUBLIC EXECUTE from nine SECURITY DEFINER RLS predicate helpers, because the point of the
-- narrow role is that its reachable surface is a list you can read in one glance. It did not cover TRIGGER functions,
-- and four of those are SECURITY DEFINER audit writers. On hosted staging they carry `=X/postgres` — a live PUBLIC
-- grant — so `oauth_completer` can execute all four today:
--
--     audit_contract_write · audit_discovery_fact_review
--     audit_okta_connector_config_write · audit_okta_capability_evidence_write
--
-- That is not theoretical. `TEMPORARY` is a PUBLIC database privilege, a role owns the temp tables it creates and so
-- holds TRIGGER on them, and CREATE TRIGGER checks EXECUTE on the function. So a role with ZERO table privileges can
-- attach one of these definer writers to a temp table of its own shape and insert a forged `public.audit_logs` row —
-- arbitrary tenant, attacker-chosen `after_json` — under `postgres`'s authority. The threat model in doc 83 §2 is
-- precisely a compromised completion worker, and this lets one pollute the append-only trail that exists to
-- reconstruct such an incident.
--
-- 0081 is where this is fixed because 0081 is where the assertion "no OTHER security-definer function is reachable"
-- first appears (`oauth_completion_jobs_test.sql` J0). That assertion was green only because `scripts/test-rls.sh`
-- revoked trigger functions from PUBLIC itself — a harness statement whose comment claimed to restore "the
-- migration-intended posture", which existed in no migration. Shipping a test that certifies a property the database
-- does not have is worse than not having the test, so the posture is made real here and the harness line removed.
--
-- SAFE BY CONSTRUCTION: a trigger fires with the privileges of the table owner and does NOT consult the invoker's
-- EXECUTE privilege. Revoking EXECUTE therefore breaks no existing trigger; it only stops an unprivileged role from
-- CREATING a new trigger that borrows a definer function's authority. `postgres` (the owner) keeps its own grant.
-- Every trigger-returning function is covered rather than the four definer ones, so a future definer trigger writer
-- inherits the posture instead of re-opening the hole.
do $$
declare f record;
begin
  for f in
    select p.oid::regprocedure as sig
      from pg_catalog.pg_proc p
      join pg_catalog.pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.prorettype = 'pg_catalog.trigger'::regtype
  loop
    execute format('revoke execute on function %s from public, anon, authenticated, service_role', f.sig);
  end loop;
end $$;

commit;
