-- 0008_org_scoped_app_user_identity_matches_read.sql
--
-- Org-scoped READ for `app_user_identity_matches` (narrows RISK-002 for this one link table — READ
-- ONLY). Implements the design recommended in
-- docs/12_IDENTITY_MATCHING_READ_SCOPE.md §5 (validated empirically in PR #22).
--
-- Before this, `app_user_identity_matches` had NO policy at all (default-deny), so no one but
-- service-role / SECURITY DEFINER paths could read it. This adds ONE permissive SELECT policy: a user
-- may read a match row iff they can ALREADY read the linked **`app_users`** row under their existing
-- RLS (which is itself org-scoped by `0007`). We reuse `app_users` RLS via an EXISTS subquery that
-- ALSO pins `au.tenant_id = app_user_identity_matches.tenant_id` explicitly (mirroring `0003`/`0007`),
-- so the policy is self-sufficient for tenant isolation — even a (normally-impossible) FK-bypassed
-- corrupt cross-tenant row is denied. `tenant_id` is NOT NULL and the `0005` same-tenant FKs
-- (`auim_app_user_same_tenant`) already force the pair to match on every write.
--
-- This exposes match *status* (a match row exists for an app_user, plus `match_method`/`confidence`/
-- `reviewed_at`) for app_users the actor can read. It exposes NO person PII: `person_id` stays an
-- opaque uuid (the actor cannot read the `people` row it points at — `people` is unchanged,
-- tenant-only), and `identity_accounts` is untouched (default-deny).
--
-- Scope guardrails:
--   * SELECT only. `app_user_identity_matches` had no read/write policy and still has none for writes —
--     the matching job writes via service-role / SECURITY DEFINER, NOT org users. **No `DELETE`**
--     policy is added.
--   * Touches ONLY `app_user_identity_matches`. `people` (tenant-only) and `identity_accounts`
--     (default-deny) are unchanged. No identity matching algorithm, no people merge, no UAR /
--     orphaned / deactivated status, no provisioning. RISK-002 is NARROWED, not closed.

begin;

create policy "org members read related app_user_identity_matches"
on public.app_user_identity_matches
for select using (
  exists (
    select 1 from public.app_users au
    where au.id = app_user_identity_matches.app_user_id
      and au.tenant_id = app_user_identity_matches.tenant_id   -- explicit tenant-bind (mirror 0007)
  )
);

commit;
