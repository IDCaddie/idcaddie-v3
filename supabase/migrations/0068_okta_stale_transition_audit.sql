-- 0068 — O2D.2: an immutable audit trail for every real current -> stale transition.
--
-- WHY. O2D.1 staled a controlled group correctly and left no `audit_logs` row: the canonical directory tables carry no audit
-- trigger. Forensic evidence existed (`stale_since`, `updated_at`, run metrics) but nothing recorded a row LEAVING `current`.
-- Staleness feeds access decisions, so that transition is exactly the thing that must be reconstructable later — and it becomes
-- more important, not less, once staling runs unattended.
--
-- WHY A TRIGGER RATHER THAN AN INSERT INSIDE THE SIX RPCs.
--   * It fires on the ACTUAL transition. Requirement "no event unless a row really moved current -> stale" is then structural —
--     enforced by the trigger's WHEN clause — rather than something each of six functions has to remember to get right.
--   * The six `runner_mark_absent_okta_*_stale` functions are ~80 lines each across four migrations. Reproducing ~490 lines to
--     insert six audit calls would put every threshold and completeness gate in the diff, which is the opposite of "keep the
--     existing behaviour unchanged". Those functions are NOT touched by this migration.
--   * It covers any future path that performs the transition, not only today's six callers.
--
-- The four "no event" cases fall out for free, because in each of them no row is updated at all:
--   * circuit breaker triggered -> the RPC returns before its UPDATE
--   * incomplete/ineligible run  -> the RPC returns before its UPDATE
--   * row already stale          -> excluded by the RPC's `sync_status = 'current'` predicate
--   * replay with no new absence -> the UPDATE matches zero rows
-- and a row that stays `current` never satisfies the WHEN clause.

-- ── (a) The audit writer ------------------------------------------------------------------------------------------------
-- SECURITY DEFINER so it can write `audit_logs`, which has RLS with a SELECT-only policy and no INSERT policy: no browser role
-- can write that table directly, and no browser role can UPDATE these directory tables either, so this event cannot be forged
-- from a session. `audit_logs`' own append-only trigger then makes the row immutable for EVERY role once written.
create or replace function public.audit_okta_stale_transition()
  returns trigger
  language plpgsql
  security definer
  set search_path = ''
as $$
begin
  insert into public.audit_logs (tenant_id, actor_user_id, action, resource_type, resource_id, before_json, after_json)
  values (
    new.tenant_id,
    auth.uid(),   -- NULL for a runner-produced transition: the producer is a machine role, not a person. Truthful either way.
    'okta_directory_row_staled',
    tg_argv[0],   -- the canonical resource type, fixed per trigger below — never caller-supplied
    new.id,
    jsonb_build_object('sync_status', old.sync_status),
    -- BOUNDED, non-secret projection ONLY. Deliberately absent: provider payload, user email/login, group or application name,
    -- token, assertion, signature, digest, exception text, secret ARN. Every value here is an id, a status, a timestamp, or a
    -- fixed constant.
    jsonb_build_object(
      'connector_id',     new.connection_id,
      'provider',         new.provider,
      'resource_type',    tg_argv[0],
      'prior_status',     old.sync_status,
      'new_status',       new.sync_status,
      'stale_since',      new.stale_since,
      -- The run that last SAW this row present, named for exactly that. It is NOT the run that performed the staling: the stale
      -- UPDATE deliberately leaves `last_discovery_run_id` alone, which is what makes an absent row identifiable in the first
      -- place. The staling run is recoverable by correlating `stale_since` against `connector_run_discovery`; recording a
      -- guessed value here instead would put inference into an audit record, which is worse than a precise narrower fact.
      'last_seen_run_id', new.last_discovery_run_id,
      'reason_code',      'absent_from_provider'   -- the only reason these paths stale a row
    )
  );
  return new;
end;
$$;

revoke all on function public.audit_okta_stale_transition() from public;
revoke all on function public.audit_okta_stale_transition() from anon;
revoke all on function public.audit_okta_stale_transition() from authenticated;
revoke all on function public.audit_okta_stale_transition() from service_role;

-- ── (b) One trigger per canonical resource ------------------------------------------------------------------------------
-- The WHEN clause is the load-bearing part: the trigger body cannot run unless the row REALLY moved current -> stale. An
-- UPDATE that leaves the status alone, or re-stales an already-stale row, never reaches it.
--
-- `app_users` also carries `sync_status` but is not an Okta discovery target and is deliberately out of scope.

create trigger okta_stale_audit_identity_accounts
  after update on public.identity_accounts
  for each row when (old.sync_status = 'current' and new.sync_status = 'stale')
  execute function public.audit_okta_stale_transition('identity_account');

create trigger okta_stale_audit_directory_groups
  after update on public.directory_groups
  for each row when (old.sync_status = 'current' and new.sync_status = 'stale')
  execute function public.audit_okta_stale_transition('directory_group');

create trigger okta_stale_audit_directory_applications
  after update on public.directory_applications
  for each row when (old.sync_status = 'current' and new.sync_status = 'stale')
  execute function public.audit_okta_stale_transition('directory_application');

create trigger okta_stale_audit_group_memberships
  after update on public.directory_group_memberships
  for each row when (old.sync_status = 'current' and new.sync_status = 'stale')
  execute function public.audit_okta_stale_transition('directory_group_membership');

create trigger okta_stale_audit_app_user_assignments
  after update on public.directory_application_user_assignments
  for each row when (old.sync_status = 'current' and new.sync_status = 'stale')
  execute function public.audit_okta_stale_transition('application_user_assignment');

create trigger okta_stale_audit_app_group_assignments
  after update on public.directory_application_group_assignments
  for each row when (old.sync_status = 'current' and new.sync_status = 'stale')
  execute function public.audit_okta_stale_transition('application_group_assignment');
