-- 0067 — O2D.1: the lifecycle re-arm that makes discovery REPEATABLE.
--
-- WHY. 0052's transition table has recovery paths out of `partial_failure` and `error`, and a rollback out of
-- `discovery_pending` — every way OUT of a discovery that did not succeed. It has none out of `discovered`. A connector that
-- COMPLETES discovery is therefore terminal: the second sweep fails at `verified -> discovery_pending` with "connection_state is
-- not verified", because the connector is sitting in `discovered`.
--
-- That was found by the O2D.1 baseline run, which died before opening a run or contacting Okta. It means repeat discovery — and
-- therefore stale marking, and therefore any scheduled sync — is not representable today. This adds exactly one edge.
--
--   discovered -> verified
--
-- and NOT `discovered -> discovery_pending` or `discovered -> discovering`. The invariant that EVERY discovery begins from
-- `verified` is preserved, `discovery_pending` keeps a single entry path, and the re-arm reuses the identical idiom already used
-- to recover from partial_failure/error rather than inventing a second one.
--
-- The re-arm moves a state flag and NOTHING else. It creates no connector run, writes no discovery row, touches no canonical
-- data, and cannot alter provider, KID, contract version or governance flags — the function does not name those columns at all.

create or replace function public.runner_advance_connection_state(
  p_connector_id uuid, p_tenant_id uuid, p_from text, p_to text
) returns void
  language plpgsql
  security definer
  set search_path = ''
as $$
declare
  v_current text;
begin
  -- NULL guard FIRST: `(p_from, p_to) not in (...)` is 3-valued — a NULL endpoint would make it NULL (not true), skipping the
  -- allowlist raise and permitting an unauthorized/blank transition. Reject null endpoints outright.
  if p_from is null or p_to is null then
    raise exception 'connection_state transition endpoints must not be null';
  end if;
  -- The ONLY transitions executable this phase. Every entry is explicit; anything else (esp. any path to active/sync_authorized/
  -- connected_unsynced/ready/scheduled) is rejected. Failure recovers to partial_failure/error and re-arms via verified.
  if (p_from, p_to) not in (
    ('verified',          'discovery_pending'),
    ('discovery_pending', 'discovering'),
    ('discovering',       'discovered'),
    ('discovering',       'partial_failure'),
    ('discovering',       'error'),
    ('discovery_pending', 'partial_failure'),
    ('discovery_pending', 'error'),
    ('discovery_pending', 'verified'),   -- rollback before discovery started
    ('partial_failure',   'verified'),   -- operator/runner re-arm
    ('error',             'verified'),   -- operator/runner re-arm
    -- O2D.1: re-arm after a SUCCESSFUL discovery, so discovery can happen more than once. Deliberately lands on `verified`, not
    -- on `discovery_pending`/`discovering`: a repeat sweep must re-enter through the same front door as the first one.
    ('discovered',        'verified')
  ) then
    raise exception 'connection_state transition % -> % is not authorized in this phase', p_from, p_to;
  end if;

  -- connector must belong to the tenant (id + tenant_id), and lock the row so the optimistic check + update are atomic.
  select c.connection_state into v_current
    from public.connectors c
   where c.id = p_connector_id and c.tenant_id = p_tenant_id
   for update;
  if not found then
    raise exception 'connector % does not belong to tenant %', p_connector_id, p_tenant_id;
  end if;

  -- optimistic concurrency: the current state must match the claimed p_from (no blind overwrite).
  if v_current is distinct from p_from then
    raise exception 'connection_state is not % (optimistic transition rejected)', p_from;
  end if;

  update public.connectors
     set connection_state = p_to, updated_at = now()
   where id = p_connector_id and tenant_id = p_tenant_id;
end;
$$;

-- Grants are unchanged from 0052: the trusted runner path ONLY. Re-asserted explicitly because `revoke ... from public` does not
-- remove Supabase's default-privilege grants to anon/authenticated/service_role, so a `create or replace` in a fresh database
-- must name them (0064 found this the hard way).
revoke all on function public.runner_advance_connection_state(uuid, uuid, text, text) from public;
revoke all on function public.runner_advance_connection_state(uuid, uuid, text, text) from anon;
revoke all on function public.runner_advance_connection_state(uuid, uuid, text, text) from authenticated;
revoke all on function public.runner_advance_connection_state(uuid, uuid, text, text) from service_role;
grant execute on function public.runner_advance_connection_state(uuid, uuid, text, text) to connector_runner;
