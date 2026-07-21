-- 0049_connector_connection_state.sql
--
-- Adds a PROVIDER-NEUTRAL, EXPLICIT connection lifecycle sub-state to public.connectors (P5E — Okta API Services onboarding).
-- The existing `status` column (pending|active|error|revoked|disabled) is the coarse connector status; `connection_state` records
-- the finer onboarding lifecycle so a "configured but not yet verified" connection is NEVER silently encoded as active. For Okta
-- API Services (Client Credentials + private_key_jwt, no browser OAuth) the maximum state reachable without a real token mint is
-- `verification_pending`.
--
-- NON-DESTRUCTIVE: adds one NULLABLE column + a CHECK (null allowed, so all existing rows pass). No data change, no status change,
-- no new grant. It ACTIVATES nothing and makes nothing runnable — a connection_state row does not mint a token, sign, call a
-- provider API, sync, or schedule. Okta stays certificationOnly; RISK-007 remains OPEN; Phase C remains BLOCKED.
--
-- SECURITY MODEL: RLS on public.connectors is unchanged (members read tenant connectors; no request-role write). The new column is
-- non-secret metadata; the column-scoped connector_runner SELECT grant (id, tenant_id, provider, status) is NOT widened, so the
-- runner does not even see this column. Writes run only through the server-only service_role path (bypasses RLS).

begin;

alter table public.connectors
  add column if not exists connection_state text;

-- The known non-secret onboarding lifecycle states (provider-neutral). null = not applicable (legacy / non-onboarded rows).
alter table public.connectors
  drop constraint if exists connectors_connection_state_chk;
alter table public.connectors
  add constraint connectors_connection_state_chk
  check (connection_state is null or connection_state in
    ('configured', 'verification_pending', 'verified', 'connected_unsynced', 'sync_authorized'));

commit;
