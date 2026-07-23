-- 0052_connector_discovery_lifecycle.sql
--
-- Phase 4 (Okta directory discovery) — connection LIFECYCLE. Widen the provider-neutral connectors.connection_state CHECK to the
-- full discovery vocabulary and add a narrow runner-only transition RPC. Per the approved corrected design: for THIS phase only
-- verified -> discovery_pending -> discovering -> discovered is executable; failure recovers to partial_failure/error/verified. The
-- ceiling states (connected_unsynced/ready, sync_authorized, active) remain DB-DISALLOWED here (added by their own later GO), so
-- there is NO route to active, NO recurring-sync authorization, NO schedule enablement, NO FRAMEWORK_REGISTRY activation.
--
-- WHY A TRANSITION RPC. connection_state is otherwise mutated only by service_role off-box. The runner (connector_runner: nologin
-- BYPASSRLS, 0021) has ONLY a narrow SELECT (id,tenant_id,provider,status) on connectors (0043) and NO write. So a SECURITY DEFINER
-- function is the least-privilege way to let the runner advance the lifecycle: it validates connector->tenant ownership, enforces an
-- explicit allowed-transition allowlist (rejecting any path to active/sync/schedule), and applies the change optimistically
-- (current state must equal p_from). EXECUTE is granted ONLY to connector_runner; no direct connectors write grant is added.
--
-- NON-DESTRUCTIVE: re-defines a CHECK to a SUPERSET (existing null/configured/verification_pending/verified rows still pass) +
-- CREATE FUNCTION + GRANT/REVOKE only. No data change, no table drop, no row purge. Staging only; RISK-007 OPEN; Phase C BLOCKED.

begin;

-- ── 1. widen the provider-neutral connection_state vocabulary ──────────────────────────────────────────────────────────
alter table public.connectors drop constraint if exists connectors_connection_state_chk;
alter table public.connectors add constraint connectors_connection_state_chk
  check (connection_state is null or connection_state in (
    'configured', 'verification_pending', 'verified',
    'discovery_pending', 'discovering', 'discovered',
    'partial_failure', 'error', 'disconnected', 'revoked', 'disabled'));

-- ── 2. runner-only transition RPC: ownership + explicit allowed-transition allowlist + optimistic current-state check ───
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
    ('error',             'verified')     -- operator/runner re-arm
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

-- ── 3. least privilege. On hosted Supabase, ALTER DEFAULT PRIVILEGES grants EXECUTE on every new public function DIRECTLY to
-- anon/authenticated, and `revoke from public` alone leaves those intact (see 0045). Revoke from public + anon + authenticated so
-- ONLY connector_runner (a trusted backend principal) can drive the lifecycle; no direct connectors write grant is added.
revoke execute on function public.runner_advance_connection_state(uuid, uuid, text, text) from public, anon, authenticated;
grant execute on function public.runner_advance_connection_state(uuid, uuid, text, text) to connector_runner;

commit;
