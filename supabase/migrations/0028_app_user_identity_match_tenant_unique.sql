-- 0028_app_user_identity_match_tenant_unique.sql
--
-- DETERMINISTIC IDENTITY MATCH — tenant-scoped app_user uniqueness (docs/42 §72). The deterministic identity
-- invariant is: ONE app_user may resolve to AT MOST ONE person per tenant. The existing
-- UNIQUE(app_user_id, person_id) (0001) only prevents a duplicate (app_user, person) PAIR — it does NOT stop
-- the same app_user from being matched to TWO DIFFERENT people. With 0027 granting authenticated editor
-- INSERT/UPDATE on `app_user_identity_matches`, that invalid state must be blocked at the DB/RLS layer, not
-- only by the helper's in-code conflict check.
--
-- This adds the app_user natural key: UNIQUE(tenant_id, app_user_id). A given (tenant, app_user) appears at
-- most ONCE, so: a second match for the same app_user to a DIFFERENT person is REJECTED (unique_violation —
-- the false-double-match guard); re-running the SAME deterministic match is idempotent via
-- `ON CONFLICT (tenant_id, app_user_id) DO NOTHING`; and a correction is a non-destructive UPDATE of person_id
-- (the SAME row — the unique is on (tenant, app_user), not on person, so repoint does not add a row). The
-- existing UNIQUE(app_user_id, person_id) is KEPT, but THIS (tenant_id, app_user_id) constraint is the one that
-- backs the write/idempotency invariant and prevents false person double-matches.
--
-- `app_user_identity_matches` holds at most one persisted row per (tenant, app_user) in the current fixtures
-- (the only multi-row app_user cases are across DIFFERENT tenants), so adding the UNIQUE is safe. CONSTRAINT
-- only: no column/table/RLS/grant change (generated types unaffected), purely additive (no table teardown, no
-- row purge, no RLS disable). The migration does NOT delete or dedupe rows and does NOT pick a winner — if a
-- duplicate (tenant_id, app_user_id) already exists it FAILS LOUDLY (the preflight below) and a human reviews
-- it, rather than the ALTER failing with an opaque unique-constraint error.

begin;

-- PREFLIGHT (executable, not just the comment above): fail loudly with a clear reason if any duplicate
-- (tenant_id, app_user_id) rows already exist — they need manual review (no auto-dedupe / no silent winner).
do $$
begin
  if exists (
    select 1
    from public.app_user_identity_matches
    group by tenant_id, app_user_id
    having count(*) > 1
  ) then
    raise exception 'Cannot add app_user_identity_matches_tenant_app_user_key: duplicate (tenant_id, app_user_id) rows exist and require manual review';
  end if;
end $$;

alter table public.app_user_identity_matches
  add constraint app_user_identity_matches_tenant_app_user_key unique (tenant_id, app_user_id);

commit;
