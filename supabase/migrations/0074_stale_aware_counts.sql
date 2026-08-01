-- 0074_stale_aware_counts.sql
--
-- Phase 6 — make the count contract explicit.
--
-- THE PROBLEM. `product_directory_access_counts` counts every row regardless of `sync_status`. That was a deliberate choice: it is
-- the conservative pre-gate for the too-large check, and a bound must never under-count. But the same number is what the
-- `too_large` FALLBACK displays on Home and /access, so a directory with 6 current groups and 1 retained stale group reports
-- "7 groups" to a customer who can see 6 everywhere else.
--
-- Both readings are legitimate and they are different questions:
--
--     current        — what the directory contains right now. The customer-facing answer.
--     totalEvidence  — every row we retain, including records last seen in an earlier discovery. The safety bound.
--
-- FOUR STATES, NOT TWO. `sync_status` is CHECK-constrained to ('current', 'stale', 'review_required', 'disconnected'). Only the
-- first two are written today — nothing in either repository writes the other two — but the contract must not pretend they cannot
-- exist. Folding them into `stale` would be a silent miscategorisation that only surfaces the day something starts writing them.
-- So the response carries `other` explicitly, and the invariant is:
--
--     totalEvidence = current + stale + other
--
-- With today's data `other` is 0 everywhere, and that is a fact the tests assert rather than an assumption they bake in.
--
-- BACKWARD COMPATIBILITY. The six flat keys are RETAINED with their existing meaning — total evidence — and are now documented as
-- deprecated aliases of `totalEvidence`. Nothing changes meaning under an existing caller; the two production callers move to the
-- explicit structure in the same change. Same function name and signature, so no argument contract shifts and no caller can get a
-- PGRST202 from this migration.
--
-- SCOPE IS UNCHANGED. Tenant, optional connector, optional provider, and the exclusion of superseded and disconnected connectors
-- are all identical to 0073 — every count below carries the same predicate. All-active mode sums distinct connector graphs and
-- deduplicates nothing: two organizations may legitimately contain the same person, and collapsing them by name, email or provider
-- external id would erase a real record.
--
-- Read-only. No write, no schema change, no new table. Staging only.

create or replace function public.product_directory_access_counts(
  p_tenant_id uuid, p_connection_id uuid default null, p_provider text default null
) returns jsonb language plpgsql security definer set search_path = public stable as $$
begin
  if not public.has_tenant_role(p_tenant_id, array['owner', 'admin']) then return null; end if; -- verify, never trust; non-owner/admin -> not-found
  return jsonb_build_object(
    -- ── DEPRECATED flat keys. Unchanged meaning: TOTAL EVIDENCE, every retained row. Kept so no existing caller changes behaviour
    -- silently. New callers must read `current` or `totalEvidence` and say which they mean.
    'identities', (select count(*) from public.identity_accounts x where x.tenant_id = p_tenant_id and (p_connection_id is null or x.connection_id = p_connection_id) and (p_provider is null or x.provider = p_provider) and not exists (select 1 from public.connectors sc where sc.id = x.connection_id and (sc.superseded_by is not null or sc.disconnected_at is not null))),
    'groups', (select count(*) from public.directory_groups x where x.tenant_id = p_tenant_id and (p_connection_id is null or x.connection_id = p_connection_id) and (p_provider is null or x.provider = p_provider) and not exists (select 1 from public.connectors sc where sc.id = x.connection_id and (sc.superseded_by is not null or sc.disconnected_at is not null))),
    'applications', (select count(*) from public.directory_applications x where x.tenant_id = p_tenant_id and (p_connection_id is null or x.connection_id = p_connection_id) and (p_provider is null or x.provider = p_provider) and not exists (select 1 from public.connectors sc where sc.id = x.connection_id and (sc.superseded_by is not null or sc.disconnected_at is not null))),
    'memberships', (select count(*) from public.directory_group_memberships x where x.tenant_id = p_tenant_id and (p_connection_id is null or x.connection_id = p_connection_id) and (p_provider is null or x.provider = p_provider) and not exists (select 1 from public.connectors sc where sc.id = x.connection_id and (sc.superseded_by is not null or sc.disconnected_at is not null))),
    'userAssignments', (select count(*) from public.directory_application_user_assignments x where x.tenant_id = p_tenant_id and (p_connection_id is null or x.connection_id = p_connection_id) and (p_provider is null or x.provider = p_provider) and not exists (select 1 from public.connectors sc where sc.id = x.connection_id and (sc.superseded_by is not null or sc.disconnected_at is not null))),
    'groupAssignments', (select count(*) from public.directory_application_group_assignments x where x.tenant_id = p_tenant_id and (p_connection_id is null or x.connection_id = p_connection_id) and (p_provider is null or x.provider = p_provider) and not exists (select 1 from public.connectors sc where sc.id = x.connection_id and (sc.superseded_by is not null or sc.disconnected_at is not null))),

    -- ── The customer-facing answer: what this directory contains now.
    'current', jsonb_build_object(
      'identities', (select count(*) from public.identity_accounts x where x.tenant_id = p_tenant_id and (p_connection_id is null or x.connection_id = p_connection_id) and (p_provider is null or x.provider = p_provider) and not exists (select 1 from public.connectors sc where sc.id = x.connection_id and (sc.superseded_by is not null or sc.disconnected_at is not null)) and x.sync_status = 'current'),
      'groups', (select count(*) from public.directory_groups x where x.tenant_id = p_tenant_id and (p_connection_id is null or x.connection_id = p_connection_id) and (p_provider is null or x.provider = p_provider) and not exists (select 1 from public.connectors sc where sc.id = x.connection_id and (sc.superseded_by is not null or sc.disconnected_at is not null)) and x.sync_status = 'current'),
      'applications', (select count(*) from public.directory_applications x where x.tenant_id = p_tenant_id and (p_connection_id is null or x.connection_id = p_connection_id) and (p_provider is null or x.provider = p_provider) and not exists (select 1 from public.connectors sc where sc.id = x.connection_id and (sc.superseded_by is not null or sc.disconnected_at is not null)) and x.sync_status = 'current'),
      'memberships', (select count(*) from public.directory_group_memberships x where x.tenant_id = p_tenant_id and (p_connection_id is null or x.connection_id = p_connection_id) and (p_provider is null or x.provider = p_provider) and not exists (select 1 from public.connectors sc where sc.id = x.connection_id and (sc.superseded_by is not null or sc.disconnected_at is not null)) and x.sync_status = 'current'),
      'userAssignments', (select count(*) from public.directory_application_user_assignments x where x.tenant_id = p_tenant_id and (p_connection_id is null or x.connection_id = p_connection_id) and (p_provider is null or x.provider = p_provider) and not exists (select 1 from public.connectors sc where sc.id = x.connection_id and (sc.superseded_by is not null or sc.disconnected_at is not null)) and x.sync_status = 'current'),
      'groupAssignments', (select count(*) from public.directory_application_group_assignments x where x.tenant_id = p_tenant_id and (p_connection_id is null or x.connection_id = p_connection_id) and (p_provider is null or x.provider = p_provider) and not exists (select 1 from public.connectors sc where sc.id = x.connection_id and (sc.superseded_by is not null or sc.disconnected_at is not null)) and x.sync_status = 'current')
    ),
    -- ── Retained but not current: last seen in an earlier discovery, kept as evidence rather than deleted.
    'stale', jsonb_build_object(
      'identities', (select count(*) from public.identity_accounts x where x.tenant_id = p_tenant_id and (p_connection_id is null or x.connection_id = p_connection_id) and (p_provider is null or x.provider = p_provider) and not exists (select 1 from public.connectors sc where sc.id = x.connection_id and (sc.superseded_by is not null or sc.disconnected_at is not null)) and x.sync_status = 'stale'),
      'groups', (select count(*) from public.directory_groups x where x.tenant_id = p_tenant_id and (p_connection_id is null or x.connection_id = p_connection_id) and (p_provider is null or x.provider = p_provider) and not exists (select 1 from public.connectors sc where sc.id = x.connection_id and (sc.superseded_by is not null or sc.disconnected_at is not null)) and x.sync_status = 'stale'),
      'applications', (select count(*) from public.directory_applications x where x.tenant_id = p_tenant_id and (p_connection_id is null or x.connection_id = p_connection_id) and (p_provider is null or x.provider = p_provider) and not exists (select 1 from public.connectors sc where sc.id = x.connection_id and (sc.superseded_by is not null or sc.disconnected_at is not null)) and x.sync_status = 'stale'),
      'memberships', (select count(*) from public.directory_group_memberships x where x.tenant_id = p_tenant_id and (p_connection_id is null or x.connection_id = p_connection_id) and (p_provider is null or x.provider = p_provider) and not exists (select 1 from public.connectors sc where sc.id = x.connection_id and (sc.superseded_by is not null or sc.disconnected_at is not null)) and x.sync_status = 'stale'),
      'userAssignments', (select count(*) from public.directory_application_user_assignments x where x.tenant_id = p_tenant_id and (p_connection_id is null or x.connection_id = p_connection_id) and (p_provider is null or x.provider = p_provider) and not exists (select 1 from public.connectors sc where sc.id = x.connection_id and (sc.superseded_by is not null or sc.disconnected_at is not null)) and x.sync_status = 'stale'),
      'groupAssignments', (select count(*) from public.directory_application_group_assignments x where x.tenant_id = p_tenant_id and (p_connection_id is null or x.connection_id = p_connection_id) and (p_provider is null or x.provider = p_provider) and not exists (select 1 from public.connectors sc where sc.id = x.connection_id and (sc.superseded_by is not null or sc.disconnected_at is not null)) and x.sync_status = 'stale')
    ),
    -- ── Any other row-level state the CHECK permits (`review_required`, `disconnected`). Nothing writes these today, so this is 0
    -- everywhere — but it is reported rather than folded into `stale`, so the day something does write one it appears honestly
    -- instead of silently inflating a category it does not belong to.
    'other', jsonb_build_object(
      'identities', (select count(*) from public.identity_accounts x where x.tenant_id = p_tenant_id and (p_connection_id is null or x.connection_id = p_connection_id) and (p_provider is null or x.provider = p_provider) and not exists (select 1 from public.connectors sc where sc.id = x.connection_id and (sc.superseded_by is not null or sc.disconnected_at is not null)) and x.sync_status not in ('current', 'stale')),
      'groups', (select count(*) from public.directory_groups x where x.tenant_id = p_tenant_id and (p_connection_id is null or x.connection_id = p_connection_id) and (p_provider is null or x.provider = p_provider) and not exists (select 1 from public.connectors sc where sc.id = x.connection_id and (sc.superseded_by is not null or sc.disconnected_at is not null)) and x.sync_status not in ('current', 'stale')),
      'applications', (select count(*) from public.directory_applications x where x.tenant_id = p_tenant_id and (p_connection_id is null or x.connection_id = p_connection_id) and (p_provider is null or x.provider = p_provider) and not exists (select 1 from public.connectors sc where sc.id = x.connection_id and (sc.superseded_by is not null or sc.disconnected_at is not null)) and x.sync_status not in ('current', 'stale')),
      'memberships', (select count(*) from public.directory_group_memberships x where x.tenant_id = p_tenant_id and (p_connection_id is null or x.connection_id = p_connection_id) and (p_provider is null or x.provider = p_provider) and not exists (select 1 from public.connectors sc where sc.id = x.connection_id and (sc.superseded_by is not null or sc.disconnected_at is not null)) and x.sync_status not in ('current', 'stale')),
      'userAssignments', (select count(*) from public.directory_application_user_assignments x where x.tenant_id = p_tenant_id and (p_connection_id is null or x.connection_id = p_connection_id) and (p_provider is null or x.provider = p_provider) and not exists (select 1 from public.connectors sc where sc.id = x.connection_id and (sc.superseded_by is not null or sc.disconnected_at is not null)) and x.sync_status not in ('current', 'stale')),
      'groupAssignments', (select count(*) from public.directory_application_group_assignments x where x.tenant_id = p_tenant_id and (p_connection_id is null or x.connection_id = p_connection_id) and (p_provider is null or x.provider = p_provider) and not exists (select 1 from public.connectors sc where sc.id = x.connection_id and (sc.superseded_by is not null or sc.disconnected_at is not null)) and x.sync_status not in ('current', 'stale'))
    ),
    -- ── The conservative bound. Identical to the deprecated flat keys, and the ONLY count the too-large gate may use: a stale row
    -- still occupies a row in any response that includes stale evidence, so gating on `current` would under-count the worst case.
    'totalEvidence', jsonb_build_object(
      'identities', (select count(*) from public.identity_accounts x where x.tenant_id = p_tenant_id and (p_connection_id is null or x.connection_id = p_connection_id) and (p_provider is null or x.provider = p_provider) and not exists (select 1 from public.connectors sc where sc.id = x.connection_id and (sc.superseded_by is not null or sc.disconnected_at is not null))),
      'groups', (select count(*) from public.directory_groups x where x.tenant_id = p_tenant_id and (p_connection_id is null or x.connection_id = p_connection_id) and (p_provider is null or x.provider = p_provider) and not exists (select 1 from public.connectors sc where sc.id = x.connection_id and (sc.superseded_by is not null or sc.disconnected_at is not null))),
      'applications', (select count(*) from public.directory_applications x where x.tenant_id = p_tenant_id and (p_connection_id is null or x.connection_id = p_connection_id) and (p_provider is null or x.provider = p_provider) and not exists (select 1 from public.connectors sc where sc.id = x.connection_id and (sc.superseded_by is not null or sc.disconnected_at is not null))),
      'memberships', (select count(*) from public.directory_group_memberships x where x.tenant_id = p_tenant_id and (p_connection_id is null or x.connection_id = p_connection_id) and (p_provider is null or x.provider = p_provider) and not exists (select 1 from public.connectors sc where sc.id = x.connection_id and (sc.superseded_by is not null or sc.disconnected_at is not null))),
      'userAssignments', (select count(*) from public.directory_application_user_assignments x where x.tenant_id = p_tenant_id and (p_connection_id is null or x.connection_id = p_connection_id) and (p_provider is null or x.provider = p_provider) and not exists (select 1 from public.connectors sc where sc.id = x.connection_id and (sc.superseded_by is not null or sc.disconnected_at is not null))),
      'groupAssignments', (select count(*) from public.directory_application_group_assignments x where x.tenant_id = p_tenant_id and (p_connection_id is null or x.connection_id = p_connection_id) and (p_provider is null or x.provider = p_provider) and not exists (select 1 from public.connectors sc where sc.id = x.connection_id and (sc.superseded_by is not null or sc.disconnected_at is not null)))
    )
  );
end $$;

-- Same signature, so CREATE OR REPLACE preserves the ACL. Re-asserted anyway: hosted Supabase's ALTER DEFAULT PRIVILEGES grants
-- EXECUTE on public functions straight to anon/authenticated (0045), and `revoke from public` alone does not remove that.
revoke execute on function public.product_directory_access_counts(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.product_directory_access_counts(uuid, uuid, text) to authenticated;
