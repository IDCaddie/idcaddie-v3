-- 0033_connector_runner_lifecycle_insert_grant.sql
--
-- The narrow INSERT grant for the runner on connector_secret_lifecycle_events, enabling the revoke/tombstone WRITE
-- helpers (docs/42 §87, RISK-007). #169 gave the runner SELECT-only on this table (read for the lifecycle-aware
-- load); this PR adds the COLUMN-scoped INSERT it needs to APPEND revoked/tombstoned events. The SELECT grant
-- (0032) is kept. The runner still gets NO UPDATE and NO DELETE — the 0032 append-only trigger
-- (`connector_secret_lifecycle_no_mutation`, `before update or delete`) still rejects mutation for EVERY role,
-- including the runner now that it holds INSERT (proven under `set role connector_runner` in T54).
--
-- SCOPE — connector_secret_lifecycle_events ONLY, INSERT ONLY, exactly the EIGHT safe-metadata columns the
-- revoke/tombstone helpers write: tenant_id, connector_id, secret_kind, version, lifecycle_event_type,
-- reason_class, actor_type, correlation_id. NOT `id`/`created_at` (server defaults), NOT `audit_log_id` (the
-- helpers do not set a back-link in this PR). No grant on any other table; `connector_secrets` is UNTOUCHED
-- (no UPDATE/DELETE, no new constraint) — its append-only invariant (T50) is preserved.
--
-- ORPHAN PREVENTION is enforced by the HELPERS in-transaction (a clean composite FK would require adding a
-- UNIQUE constraint to the append-only `connector_secrets` table, which is awkward; the helpers instead INSERT
-- the lifecycle row + its audit row with a `WHERE EXISTS (connector_secrets row)` guard inside ONE runner
-- transaction, so a revoke/tombstone of a nonexistent version commits NO lifecycle row and NO audit row).
--
-- This adds NO real credential, NO provider token, NO OAuth/token exchange, NO live connector, NO request-path
-- decrypt, NO service-role path, NO rotation. RISK-007 remains OPEN.

grant insert (tenant_id, connector_id, secret_kind, version, lifecycle_event_type, reason_class, actor_type, correlation_id)
  on public.connector_secret_lifecycle_events to connector_runner;
