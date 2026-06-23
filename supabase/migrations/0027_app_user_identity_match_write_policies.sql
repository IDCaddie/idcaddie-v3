-- 0027_app_user_identity_match_write_policies.sql
--
-- DETERMINISTIC APP_USER → PERSON IDENTITY-MATCH WRITE — RLS write policies (docs/42 §72). The first canonical
-- USER-identity write path (the identity-match helper) connects app_users to people on DETERMINISTIC evidence
-- only. `app_user_identity_matches` had RLS enabled with ONLY a SELECT policy (the org-union read from
-- 0001/0003) — i.e. default-DENY for writes. To write through the authenticated user-scoped (RLS) path (never
-- service-role), it needs INSERT + UPDATE policies.
--
-- This adds the `0004`-hardened write surface: editors INSERT + editors UPDATE, and EXPLICITLY NO DELETE
-- policy. `0004` recorded this exact directive for this table: "The other 'core' tables (identity_accounts,
-- app_user_identity_matches, …) have RLS enabled but NO policy = default-deny already (incl. DELETE) …; their
-- future write policies must LIKEWISE OMIT DELETE." So the correction path is non-destructive REPOINT (UPDATE
-- person_id to the correct person), never a delete — a match is repointed, not erased; app_users / people /
-- identity_accounts / audit history are never deleted.
--
-- Migration-safety: CREATE POLICY only — no column/table/schema change (generated types are unaffected), no
-- grant, no RLS disable, no table teardown, no row purge. The existing SELECT policy is untouched.

begin;

-- editors may INSERT a deterministic identity match for their own tenant (RLS scopes the tenant boundary).
create policy "editors insert app_user_identity_matches" on public.app_user_identity_matches
  for insert with check (public.has_tenant_role(tenant_id, array['owner', 'admin', 'editor']));

-- editors may UPDATE a match for their own tenant — this is the non-destructive REPOINT path (change person_id
-- to the correct person, or update match_method/reviewed_by/reviewed_at). There is intentionally NO DELETE
-- policy (the 0004 directive): a wrong match is repointed, never erased.
create policy "editors update app_user_identity_matches" on public.app_user_identity_matches
  for update using (public.has_tenant_role(tenant_id, array['owner', 'admin', 'editor']))
  with check (public.has_tenant_role(tenant_id, array['owner', 'admin', 'editor']));

commit;
