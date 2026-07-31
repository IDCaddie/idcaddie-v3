-- 0069 — O2E cleanup: close the connector runs abandoned by the bounded verification smokes.
--
-- WHAT THEY ARE. The O2C.2/O2C.3/O2C.4 smokes each call `runner_open_connector_run` to obtain a server-generated run id to bind
-- their capability evidence to, then exit without calling `runner_finish_connector_run` — they are one-shot probes, not discovery
-- sweeps, and nothing in their path closes a run. Seven were left `running` on the controlled staging connector.
--
-- WHY THEY ARE HARMLESS BUT NOT ACCEPTABLE. None carries a `connector_run_discovery` row, so none can satisfy the stale gate
-- (`completeness is true` etc.) and none can ever authorise staling. But a permanently-`running` run is a lie about system state,
-- it will confuse any future "is a sync in flight?" check, and it is exactly the sort of residue that makes an operator hesitate
-- during an incident.
--
-- CLOSED, NOT DELETED. They become `canceled` — an existing terminal status, and the truthful one: these runs never completed.
-- `abandoned_smoke_validation` is recorded as the bounded FAILURE CODE rather than invented as a new status value, because the
-- run-status vocabulary is a lifecycle contract (`queued|running|succeeded|failed|canceled|timed_out`) and adding a value to it
-- for a housekeeping event would widen that contract permanently.
--
-- SCOPING. Three independent predicates, each of which alone makes this a no-op outside the controlled staging connector:
--   * the exact controlled connector id — this row does not exist in any other environment;
--   * `status = 'running'` — a finished run is never touched;
--   * NO `connector_run_discovery` row — a real discovery sweep, however old or stuck, is never touched.
-- The third is the load-bearing one: it distinguishes "opened a run id and exited" from "was actually discovering".

do $$
declare
  v_closed integer;
  v_tenant uuid;
begin
  select tenant_id into v_tenant from public.connectors
   where id = 'cdf19b61-6f22-4e61-8784-99a453396805';

  if v_tenant is null then
    -- Not the staging database. Nothing to do, and nothing that could match.
    raise notice '0069: controlled connector absent; no abandoned smoke runs to close';
    return;
  end if;

  with abandoned as (
    select r.id
      from public.connector_runs r
     where r.connector_id = 'cdf19b61-6f22-4e61-8784-99a453396805'
       and r.status = 'running'
       and not exists (
         select 1 from public.connector_run_discovery d where d.run_id = r.id
       )
  ),
  closed as (
    update public.connector_runs r
       set status       = 'canceled',
           completed_at = now(),
           failure_code = 'abandoned_smoke_validation'
      from abandoned a
     where r.id = a.id
    returning r.id, r.tenant_id, r.connector_id, r.started_at
  )
  -- One bounded audit event per closed run. Ids, statuses and a fixed reason code only — no payload, no provider data.
  insert into public.audit_logs (tenant_id, actor_user_id, action, resource_type, resource_id, before_json, after_json)
  select c.tenant_id,
         null,                                   -- housekeeping performed by a migration, not by a person
         'connector_run_closed_abandoned',
         'connector_run',
         c.id,
         jsonb_build_object('status', 'running'),
         jsonb_build_object(
           'connector_id',  c.connector_id,
           'prior_status',  'running',
           'new_status',    'canceled',
           'failure_code',  'abandoned_smoke_validation',
           'started_at',    c.started_at,
           'reason',        'bounded verification smoke opened a run id and exited without finishing it'
         )
    from closed c;

  get diagnostics v_closed = row_count;
  raise notice '0069: closed % abandoned smoke run(s)', v_closed;
end $$;
