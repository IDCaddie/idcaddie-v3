-- 0019_connector_run_audit_lifecycle.sql
--
-- PR D of the accepted connector credential vault gated sequence (docs/42 §20). Widens the existing
-- `public.connector_runs` table (created in `0017`) to the safe run-LIFECYCLE shape needed before any
-- connector execution or credential storage exists — and NOTHING else. NO connector execution, NO runner,
-- NO provider call, NO credential read/write, NO `connector_secrets` change, NO service-role path, NO UI,
-- NO new route. Audit reuses the existing APPEND-ONLY `public.audit_logs` (`reject_audit_mutation`, `0002`)
-- — this migration creates NO new audit table. **The vault stays NOT usable for real credentials.**
--
-- WHY a migration: the `0017` status CHECK only allowed `queued|running|success|failed`; the lifecycle
-- model (docs/42 §9, this PR) needs six states — `queued, running, succeeded, failed, canceled,
-- timed_out` — plus safe completion/counter/failure fields. These are SAFE METADATA only (a status, two
-- timestamps, three non-negative counters, a machine failure CODE, and a safe human failure LABEL). NO
-- secret, NO token/key, NO raw provider payload is added — `0017`'s "connector_runs holds no secret
-- column" invariant (org_rls_test.sql T39) still holds.
--
-- GRANTS — UNCHANGED. `connector_runs` keeps the `0018` least-privilege surface: `authenticated` holds
-- table-level SELECT only (new columns inherit it automatically); `anon` holds nothing. This migration
-- adds NO grant and NO write policy — connector_runs writes remain FUTURE server-only/runner work, never a
-- request-path write. (T40's exact `authenticated = [SELECT]` / `anon = []` invariant is the backstop.)
--
-- SAFE because the vault has zero rows (not usable): renaming `success`->`succeeded` and the columns below
-- rewrites no surprising data. `provider` is deliberately NOT denormalized onto each run — it lives on the
-- parent `connectors` row and is joined (immutable per connector; runs cascade-delete with the connector),
-- avoiding drift. Migration-safety: only ALTER statements here — no table teardown, no row purge, no RLS disable.

begin;

-- Six-state lifecycle (docs/42 §9). Drop the 0017 4-state check, add the 6-state one. 'queued' default kept.
alter table public.connector_runs drop constraint connector_runs_status_check;
alter table public.connector_runs
  add constraint connector_runs_status_check
    check (status in ('queued','running','succeeded','failed','canceled','timed_out'));

-- Rename to the lifecycle field names (same concepts, spec naming). Constraints/grants follow the column.
alter table public.connector_runs rename column finished_at to completed_at;  -- terminal timestamp
alter table public.connector_runs rename column items_seen  to records_seen;  -- safe counter
alter table public.connector_runs rename column error_class to failure_code;  -- a stable machine CODE, never a provider message

-- Add the remaining safe lifecycle columns (all nullable; counters non-negative; a SAFE human label).
alter table public.connector_runs
  add column records_imported integer,
  add column records_failed integer,
  add column failure_label text;                          -- a short SAFE label, never a secret/payload

alter table public.connector_runs
  add constraint connector_runs_records_imported_nonneg check (records_imported is null or records_imported >= 0),
  add constraint connector_runs_records_failed_nonneg   check (records_failed is null or records_failed >= 0);

commit;
