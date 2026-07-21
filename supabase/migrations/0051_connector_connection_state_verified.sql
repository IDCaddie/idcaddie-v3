-- 0051_connector_connection_state_verified.sql
--
-- Widen the connectors.connection_state CHECK (provider-neutral) to allow `verified` — the state reached ONLY when a real, bounded
-- Okta API Services client_credentials verification succeeds (per the earlier GO-gated ceiling: 0050 allowed only
-- configured|verification_pending; this GO adds `verified`). `verified` means the credential minted a valid token exactly once and
-- the token was discarded — it is NOT connected/synced. status stays `pending`, last_sync_at stays null; no sync, no schedule, no
-- first-sync authorization. The further states (connected_unsynced, sync_authorized) remain DISALLOWED here and are added by their
-- own later GO-gated migrations.
--
-- NON-DESTRUCTIVE: only re-defines a CHECK to a SUPERSET (existing rows: null / configured / verification_pending → still pass).
-- No data/status change, no new grant. Okta stays certificationOnly; RISK-007 OPEN; Phase C BLOCKED.

begin;

alter table public.connectors drop constraint if exists connectors_connection_state_chk;
alter table public.connectors add constraint connectors_connection_state_chk
  check (connection_state is null or connection_state in ('configured', 'verification_pending', 'verified'));

commit;
