-- 0070_current_stale_since_invariant.sql
--
-- Phase 2.1 — enforce `sync_status = 'current'  ->  stale_since IS NULL` on the six Okta discovery tables.
--
-- THE BUG. Four of the six promote RPCs clear `stale_since` when they restore a row to `current`
-- (0056:239 memberships, 0057:257 applications, 0060:218 user assignments, 0060:317 group assignments). Two do not:
-- `runner_promote_okta_directory_users` (0053:303) and `runner_promote_okta_directory_groups` (0054:230). A person or group that
-- disappeared from Okta, was marked stale, and then reappeared therefore ends up:
--
--     sync_status = 'current'   AND   stale_since = <the timestamp from when it went missing>
--
-- Nothing crashes; the row simply carries a contradiction. Any reader that trusts `stale_since` instead of `sync_status` reports a
-- current record as having last been seen months ago. The Directory list pages work around this today by only rendering `stale_since`
-- on rows that are actually stale — a UI workaround for a database defect, which is the wrong place for the fix.
--
-- WHAT THIS MIGRATION DOES.
--   1. Repairs existing rows on every one of the six tables (not just the two that can produce the state — a repair that only covers
--      the paths we believe are broken cannot prove the others were clean).
--   2. Replaces the two promote functions, adding `stale_since = null` to their do-update-set. The bodies below are otherwise
--      BYTE-IDENTICAL to 0053/0054 — extracted from those files and edited on exactly one line each.
--   3. Adds a CHECK to all six tables so the invariant survives the next writer who forgets.
--
-- WHY A CHECK AND NOT A NORMALIZING TRIGGER. A BEFORE UPDATE trigger nulling `stale_since` whenever the row becomes `current` would
-- also work, and would cover paths that do not exist yet. It was rejected deliberately: it would SILENTLY repair every future
-- occurrence of this same bug, so the next promote function written without the clear would look correct forever. The CHECK makes
-- that mistake fail loudly at the moment it is written. Enforcement over self-healing.
--
-- WHAT THIS MIGRATION DOES NOT TOUCH. Stale thresholds, the mass-staleness circuit breaker, completeness/eligibility gates, the
-- latest-run supersession guard, connector scoping, discovery ordering, promotion budgets, and the 0068 stale-transition audit
-- triggers are all unchanged. The repair below moves no row between statuses, so it fires no audit trigger: those triggers carry
-- `when (old.sync_status = 'current' and new.sync_status = 'stale')`, and a repair that only nulls a timestamp never satisfies it.
--
-- Read-only surfaces are unaffected: the 0061 product RPCs project `stale_since` but filter on `sync_status`.
--
-- Staging only. No production apply. No data migration beyond the null-out. No new table, policy, grant, or role.


-- ══ 1. REPAIR ════════════════════════════════════════════════════════════════════════════════════════════════════════════
-- Idempotent and narrow: `stale_since is not null` keeps the write off every already-correct row, so re-running this
-- migration is a no-op and the UPDATE touches nothing on a clean database. `updated_at` is deliberately NOT advanced —
-- this corrects a value that was always wrong, it is not a change to the record's content.

update public.identity_accounts set stale_since = null where sync_status = 'current' and stale_since is not null;
update public.directory_groups set stale_since = null where sync_status = 'current' and stale_since is not null;
update public.directory_applications set stale_since = null where sync_status = 'current' and stale_since is not null;
update public.directory_group_memberships set stale_since = null where sync_status = 'current' and stale_since is not null;
update public.directory_application_user_assignments set stale_since = null where sync_status = 'current' and stale_since is not null;
update public.directory_application_group_assignments set stale_since = null where sync_status = 'current' and stale_since is not null;

-- ══ 2. THE TWO PROMOTE FUNCTIONS ═════════════════════════════════════════════════════════════════════════════════════
-- Reproduced from 0053/0054 with one line changed in each do-update-set. Same signature, so EXECUTE privileges are
-- preserved by CREATE OR REPLACE; the grants are re-asserted in section 4 regardless.

-- ── runner_promote_okta_directory_users: `stale_since = null` added at the do-update-set (was 0053:303).
create or replace function public.runner_promote_okta_directory_users(p_run_id uuid, p_tenant_id uuid)
  returns jsonb
  language plpgsql security definer set search_path = ''
as $$
declare
  v_connector_id uuid;
  v_complete boolean; v_rejected integer; v_termination text; v_review boolean;
  v_created integer := 0; v_updated integer := 0;
begin
  -- 1-5: resolve run -> tenant -> connection; provider must be okta.
  select r.connector_id into v_connector_id
    from public.connector_runs r where r.id = p_run_id and r.tenant_id = p_tenant_id;
  if not found then raise exception 'run % does not belong to tenant %', p_run_id, p_tenant_id; end if;
  if not exists (select 1 from public.connectors c where c.id = v_connector_id and c.tenant_id = p_tenant_id and c.provider = 'okta') then
    raise exception 'connector for run % is not an okta connection', p_run_id;
  end if;

  -- 6-10: complete-run proof. metrics must exist and prove a full, clean read (no rejects, terminated on last_page, not flagged).
  select d.completeness, d.records_rejected, d.termination_reason, d.review_required
    into v_complete, v_rejected, v_termination, v_review
    from public.connector_run_discovery d where d.run_id = p_run_id and d.tenant_id = p_tenant_id;
  if not found then raise exception 'run % has no recorded discovery metrics; cannot promote', p_run_id; end if;
  if v_complete is not true or coalesce(v_rejected, 1) <> 0 or v_termination is distinct from 'last_page' or v_review is true then
    raise exception 'run % is not eligible for promotion (complete=%, rejected=%, termination=%, review=%)', p_run_id, v_complete, v_rejected, v_termination, v_review;
  end if;

  -- latest-run guard: never (re)promote a SUPERSEDED run. Reject if a DIFFERENT complete run for this connection started later.
  if exists (
    select 1 from public.connector_runs r2 join public.connector_run_discovery d2 on d2.run_id = r2.id
     where r2.connector_id = v_connector_id and r2.tenant_id = p_tenant_id and r2.id <> p_run_id
       and d2.completeness is true and d2.termination_reason = 'last_page'
       and r2.started_at > (select started_at from public.connector_runs where id = p_run_id)
  ) then
    raise exception 'run % is superseded by a later complete run; refusing to promote', p_run_id;
  end if;

  -- 11-19: upsert identity_accounts from THIS run's identity_account facts. connection_id is server-derived (v_connector_id), not
  -- trusted from fact_json; a fact is additionally required to CARRY the matching connection_id (defense vs a cross-connection
  -- signal_id collision) and DISTINCT-ON external_id (defense vs a duplicate). first_seen preserved; last_seen advanced; raw_payload
  -- NEVER set; sync_status=current.
  with existing as (
    -- snapshot of external_ids already promoted for THIS connection (evaluated pre-upsert) -> reliable created-vs-updated split.
    select ia.external_id as ext from public.identity_accounts ia
     where ia.tenant_id = p_tenant_id and ia.connection_id = v_connector_id and ia.provider = 'okta' and ia.external_id is not null
  ),
  src as (
    select distinct on (f.fact_json ->> 'external_id') f.fact_json as j, f.provenance_json as p
      from public.discovery_facts f
     where f.source_run_id = p_run_id and f.tenant_id = p_tenant_id
       and f.source_provider = 'okta' and f.fact_type = 'identity_account'
       and f.fact_json ->> 'external_id' is not null
       and (f.fact_json ->> 'connection_id') is not distinct from v_connector_id::text  -- fact must belong to THIS connection
     order by f.fact_json ->> 'external_id', f.observed_at desc
  ),
  upserted as (
    insert into public.identity_accounts (
      tenant_id, connection_id, provider, external_id,
      login, normalized_login, email, normalized_email, first_name, last_name, display_name, status, is_active,
      department, title, employee_number,
      provider_created_at, provider_activated_at, provider_last_login_at, provider_last_updated_at, provider_status_changed_at,
      first_seen_at, last_seen_at, sync_status, last_discovery_run_id,
      schema_version, sanitizer_version, normalizer_version, source_endpoint, created_at, updated_at
    )
    select
      p_tenant_id, v_connector_id, 'okta', j ->> 'external_id',
      j ->> 'login', j ->> 'normalized_login', j ->> 'email', j ->> 'normalized_email', j ->> 'first_name', j ->> 'last_name',
      j ->> 'display_name', j ->> 'status', (j ->> 'is_active')::boolean,
      j ->> 'department', j ->> 'title', j ->> 'employee_number',
      (j ->> 'provider_created_at')::timestamptz, (j ->> 'provider_activated_at')::timestamptz, (j ->> 'provider_last_login_at')::timestamptz,
      (j ->> 'provider_last_updated_at')::timestamptz, (j ->> 'provider_status_changed_at')::timestamptz,
      now(), now(), 'current', p_run_id,
      p ->> 'schema_version', p ->> 'sanitizer_version', p ->> 'normalizer_version', p ->> 'source_endpoint', now(), now()
    from src
    on conflict (tenant_id, connection_id, provider, external_id) where connection_id is not null and external_id is not null
    do update set
      login = excluded.login, normalized_login = excluded.normalized_login, email = excluded.email,
      normalized_email = excluded.normalized_email, first_name = excluded.first_name, last_name = excluded.last_name,
      display_name = excluded.display_name, status = excluded.status, is_active = excluded.is_active,
      department = excluded.department, title = excluded.title, employee_number = excluded.employee_number,
      provider_created_at = excluded.provider_created_at, provider_activated_at = excluded.provider_activated_at,
      provider_last_login_at = excluded.provider_last_login_at, provider_last_updated_at = excluded.provider_last_updated_at,
      provider_status_changed_at = excluded.provider_status_changed_at,
      last_seen_at = now(), sync_status = 'current', last_discovery_run_id = p_run_id, stale_since = null,
      schema_version = excluded.schema_version, sanitizer_version = excluded.sanitizer_version,
      normalizer_version = excluded.normalizer_version, source_endpoint = excluded.source_endpoint, updated_at = now()
      -- first_seen_at intentionally NOT updated (preserved); raw_payload intentionally NEVER referenced (stays null).
    returning external_id as ext
  )
  select count(*) filter (where not exists (select 1 from existing e where e.ext = u.ext)),
         count(*) filter (where exists (select 1 from existing e where e.ext = u.ext))
    into v_created, v_updated
    from upserted u;

  update public.connector_run_discovery set facts_inserted = v_created, facts_updated = v_updated where run_id = p_run_id;
  return jsonb_build_object('identitiesCreated', v_created, 'identitiesUpdated', v_updated);
end;
$$;

-- ── runner_promote_okta_directory_groups: `stale_since = null` added at the do-update-set (was 0054:230).
create or replace function public.runner_promote_okta_directory_groups(p_run_id uuid, p_tenant_id uuid)
  returns jsonb
  language plpgsql security definer set search_path = ''
as $$
declare
  v_connector_id uuid;
  v_complete boolean; v_rejected integer; v_termination text; v_review boolean;
  v_created integer := 0; v_updated integer := 0;
begin
  -- resolve run -> tenant -> connection; provider must be okta.
  select r.connector_id into v_connector_id
    from public.connector_runs r where r.id = p_run_id and r.tenant_id = p_tenant_id;
  if not found then raise exception 'run % does not belong to tenant %', p_run_id, p_tenant_id; end if;
  if not exists (select 1 from public.connectors c where c.id = v_connector_id and c.tenant_id = p_tenant_id and c.provider = 'okta') then
    raise exception 'connector for run % is not an okta connection', p_run_id;
  end if;

  -- complete-run proof: metrics must exist and prove a full, clean read (no rejects, terminated on last_page, not flagged).
  select d.completeness, d.records_rejected, d.termination_reason, d.review_required
    into v_complete, v_rejected, v_termination, v_review
    from public.connector_run_discovery d where d.run_id = p_run_id and d.tenant_id = p_tenant_id;
  if not found then raise exception 'run % has no recorded discovery metrics; cannot promote', p_run_id; end if;
  if v_complete is not true or coalesce(v_rejected, 1) <> 0 or v_termination is distinct from 'last_page' or v_review is true then
    raise exception 'run % is not eligible for promotion (complete=%, rejected=%, termination=%, review=%)', p_run_id, v_complete, v_rejected, v_termination, v_review;
  end if;

  -- latest-run guard: never (re)promote a SUPERSEDED run. Reject if a DIFFERENT complete run for this connection started later.
  if exists (
    select 1 from public.connector_runs r2 join public.connector_run_discovery d2 on d2.run_id = r2.id
     where r2.connector_id = v_connector_id and r2.tenant_id = p_tenant_id and r2.id <> p_run_id
       and d2.completeness is true and d2.termination_reason = 'last_page'
       and r2.started_at > (select started_at from public.connector_runs where id = p_run_id)
  ) then
    raise exception 'run % is superseded by a later complete run; refusing to promote', p_run_id;
  end if;

  -- upsert directory_groups from THIS run's directory_group facts. connection_id is server-derived (v_connector_id), not trusted from
  -- fact_json; a fact is additionally required to CARRY the matching connection_id (defense vs a cross-connection signal_id collision)
  -- and DISTINCT-ON external_id (defense vs a duplicate). first_seen preserved; last_seen advanced; sync_status=current; no raw_payload.
  with existing as (
    select dg.external_id as ext from public.directory_groups dg
     where dg.tenant_id = p_tenant_id and dg.connection_id = v_connector_id and dg.provider = 'okta' and dg.external_id is not null
  ),
  src as (
    select distinct on (f.fact_json ->> 'external_id') f.fact_json as j, f.provenance_json as p
      from public.discovery_facts f
     where f.source_run_id = p_run_id and f.tenant_id = p_tenant_id
       and f.source_provider = 'okta' and f.fact_type = 'directory_group'
       and f.fact_json ->> 'external_id' is not null
       and (f.fact_json ->> 'connection_id') is not distinct from v_connector_id::text  -- fact must belong to THIS connection
     order by f.fact_json ->> 'external_id', f.observed_at desc
  ),
  upserted as (
    insert into public.directory_groups (
      tenant_id, connection_id, provider, external_id,
      name, normalized_name, description, group_type_category,
      provider_created_at, provider_last_updated_at,
      first_seen_at, last_seen_at, sync_status, last_discovery_run_id,
      schema_version, sanitizer_version, normalizer_version, source_endpoint, created_at, updated_at
    )
    select
      p_tenant_id, v_connector_id, 'okta', j ->> 'external_id',
      j ->> 'name', j ->> 'normalized_name', j ->> 'description', j ->> 'group_type_category',
      (j ->> 'provider_created_at')::timestamptz, (j ->> 'provider_last_updated_at')::timestamptz,
      now(), now(), 'current', p_run_id,
      p ->> 'schema_version', p ->> 'sanitizer_version', p ->> 'normalizer_version', p ->> 'source_endpoint', now(), now()
    from src
    on conflict (tenant_id, connection_id, provider, external_id) where connection_id is not null and external_id is not null
    do update set
      name = excluded.name, normalized_name = excluded.normalized_name, description = excluded.description,
      group_type_category = excluded.group_type_category,
      provider_created_at = excluded.provider_created_at, provider_last_updated_at = excluded.provider_last_updated_at,
      last_seen_at = now(), sync_status = 'current', last_discovery_run_id = p_run_id, stale_since = null,
      schema_version = excluded.schema_version, sanitizer_version = excluded.sanitizer_version,
      normalizer_version = excluded.normalizer_version, source_endpoint = excluded.source_endpoint, updated_at = now()
      -- first_seen_at intentionally NOT updated (preserved); there is no raw_payload column.
    returning external_id as ext
  )
  select count(*) filter (where not exists (select 1 from existing e where e.ext = u.ext)),
         count(*) filter (where exists (select 1 from existing e where e.ext = u.ext))
    into v_created, v_updated
    from upserted u;

  update public.connector_run_discovery set facts_inserted = v_created, facts_updated = v_updated where run_id = p_run_id;
  return jsonb_build_object('groupsCreated', v_created, 'groupsUpdated', v_updated);
end;
$$;

-- ══ 3. THE INVARIANT ═════════════════════════════════════════════════════════════════════════════════════════════════
-- `sync_status <> 'current' or stale_since is null`, i.e. only a CURRENT row is constrained. `stale`, `review_required`
-- and `disconnected` may all legitimately carry a timestamp, and this says nothing about them.
--
-- Added NOT VALID then validated as a separate statement: that is the form that takes SHARE UPDATE EXCLUSIVE rather than
-- ACCESS EXCLUSIVE for the scan, so the same file stays safe to apply to a large table later. Section 1 has already
-- repaired every row, so the validation cannot fail on clean data.

alter table public.identity_accounts
  add constraint identity_accounts_current_no_stale_since_chk check (sync_status <> 'current' or stale_since is null) not valid;
alter table public.identity_accounts validate constraint identity_accounts_current_no_stale_since_chk;
alter table public.directory_groups
  add constraint directory_groups_current_no_stale_since_chk check (sync_status <> 'current' or stale_since is null) not valid;
alter table public.directory_groups validate constraint directory_groups_current_no_stale_since_chk;
alter table public.directory_applications
  add constraint directory_applications_current_no_stale_since_chk check (sync_status <> 'current' or stale_since is null) not valid;
alter table public.directory_applications validate constraint directory_applications_current_no_stale_since_chk;
alter table public.directory_group_memberships
  add constraint directory_group_memberships_current_no_stale_since_chk check (sync_status <> 'current' or stale_since is null) not valid;
alter table public.directory_group_memberships validate constraint directory_group_memberships_current_no_stale_since_chk;
alter table public.directory_application_user_assignments
  add constraint daua_current_no_stale_since_chk check (sync_status <> 'current' or stale_since is null) not valid;
alter table public.directory_application_user_assignments validate constraint daua_current_no_stale_since_chk;
alter table public.directory_application_group_assignments
  add constraint daga_current_no_stale_since_chk check (sync_status <> 'current' or stale_since is null) not valid;
alter table public.directory_application_group_assignments validate constraint daga_current_no_stale_since_chk;

-- ══ 4. LEAST PRIVILEGE (re-asserted) ═════════════════════════════════════════════════════════════════════════════════
-- CREATE OR REPLACE preserves the existing ACL, but on hosted Supabase ALTER DEFAULT PRIVILEGES has historically granted
-- EXECUTE on new public functions directly to anon/authenticated (see 0045), and `revoke from public` alone does not
-- remove those. Naming each role is the only reliable form. Identical to 0053:401-405 / 0054:326.

revoke execute on function public.runner_promote_okta_directory_users(uuid, uuid) from public, anon, authenticated;
grant execute on function public.runner_promote_okta_directory_users(uuid, uuid) to connector_runner;
revoke execute on function public.runner_promote_okta_directory_groups(uuid, uuid) from public, anon, authenticated;
grant execute on function public.runner_promote_okta_directory_groups(uuid, uuid) to connector_runner;
