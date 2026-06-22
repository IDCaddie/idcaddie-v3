-- 0022_connector_runner_oauth_pending_insert.sql
--
-- The narrow authorize-time INSERT grant for the connector runner (docs/42 §51, gated vault). It grants
-- `connector_runner` a COLUMN-LEVEL INSERT on `public.oauth_pending` — ONLY the authorize-time replay-row
-- columns the PR #128 inserter writes — so the future runner-backed inserter can create the single-use
-- replay-protection row at authorize-time. This is the grant `0021` DELIBERATELY DEFERRED ("NO INSERT —
-- authorize-time create is a later PR"); this is that later PR.
--
-- SCOPE (least privilege). The grant is exactly the 9 columns of the §50/§32.3 authorize-time row:
--   tenant_id, organization_id, connector_id, provider, subject, state_jti, nonce_hash, intent, expires_at.
-- The runner CANNOT supply any other column on INSERT — `id`/`created_at`/`attempt_count` fall back to their
-- DEFAULTs and `consumed_at`/`last_rejected_code` to NULL, and an attempt to INSERT a value into a
-- non-granted column (e.g. `consumed_at`, `attempt_count`, `last_rejected_code`) is permission-denied. The
-- runner's existing surface is otherwise UNCHANGED: SELECT + the 3-column UPDATE (consumed_at/attempt_count/
-- last_rejected_code) from `0021`; still NO DELETE / no row-purge / no REFERENCES / no TRIGGER.
--
-- NOT GRANTED (unchanged): the runner gets NO grant on `connector_secrets` (no INSERT/UPDATE/SELECT/DELETE/
-- row-purge/REFERENCES/TRIGGER) and NO grant on `connectors`/`connector_runs`. anon/authenticated privileges
-- are NOT changed (deny-all on oauth_pending + connector_secrets preserved; SELECT-only on the metadata
-- tables). NO policy is added to oauth_pending or connector_secrets (they stay RLS-on, zero-policy deny-all).
--
-- Migration-safety: only a column-scoped GRANT + a privilege-tightening `revoke all` here — no table teardown,
-- no row purge, no RLS disable. The deny-all posture is re-asserted, not weakened.

begin;

-- The authorize-time column-level INSERT grant (the 9 §50 row columns only).
grant insert (tenant_id, organization_id, connector_id, provider, subject, state_jti, nonce_hash, intent, expires_at)
  on public.oauth_pending to connector_runner;

-- Defensive re-assert (idempotent — the 0017/0018/0021 pattern): the runner holds NO connector_secrets
-- privilege, and anon/authenticated remain deny-all on the secret tables. NO policy is added for any role.
revoke all on public.connector_secrets from connector_runner;
revoke all on public.oauth_pending, public.connector_secrets from anon, authenticated;

commit;
