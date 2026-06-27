-- 0038 — concurrent-run lock for manual_sync_runs (docs/47 PR 7+). DB-enforced: AT MOST ONE active ('running') manual
-- sync run may exist per (tenant_id, source, connector_id). Additive (CREATE INDEX only) — no column/RLS/data change.
--
-- The key includes tenant_id, so the lock is TENANT-SCOPED — tenant A's active run never blocks tenant B's. Enforcement
-- is at the DB (a partial unique index), not app code, so there is NO check-then-insert race window: a concurrent
-- second `start()` INSERT of a 'running' row hits this index → unique_violation (23505) → the recorder returns the safe
-- `run_already_active` (no Slack call, no resolver write, no new record). A run leaving 'running' (succeeded/failed, incl.
-- stale reconciliation) drops out of the partial index, releasing the lock for the next run.
create unique index manual_sync_runs_one_active_idx
  on public.manual_sync_runs (tenant_id, source, connector_id)
  where status = 'running';
