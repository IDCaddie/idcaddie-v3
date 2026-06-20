-- ============================================================================
-- staging_apps_people_verification.sql
-- STAGING-ONLY synthetic fixture for Apps / People populated-path verification.
--
--   ⚠️  NEVER apply to production (dzbfxulvxchdemcettrx).
--   ⚠️  Apply ONLY to staging (ycdpzduxugdsffjqyoai), via scripts/seed-staging-apps-fixture.sh
--       (which fails closed unless the linked ref is staging and requires an explicit
--       confirmation phrase) OR by pasting this file into the STAGING Supabase SQL editor.
--   ⚠️  This is SYNTHETIC verification data — NOT customer data. Applying + verifying it does
--       NOT close RISK-001 and does NOT approve cutover.
--
-- What it creates (all in Tenant A `aaaa1111-1111-1111-1111-111111111111`, all in the obvious
-- synthetic `5a9a0000-…` id namespace, all names beginning "Staging Apps Verification"):
--   • 1 app                                    → /apps row + /apps/[id] summary
--   • 1 app_contract → existing Tenant A contract `cccca111-…a1` → linked-contract count = 1
--   • 2 app_users                              → app-user count = 2; /people roster (2 accounts)
--   • 1 person  (required: matches.person_id is NOT NULL)
--   • 1 app_user_identity_match (user 1)       → /people shows 1 matched + 1 unmatched
--
-- Tables touched (INSERT only): public.apps, public.app_contracts, public.app_users,
-- public.people, public.app_user_identity_matches. NO Storage, NO storage.objects, NO RLS
-- policy change, NO migration. Idempotent (`on conflict do nothing`) — safe to re-run.
-- Applied as the privileged role (RLS bypassed for SEED only; the app's RLS still governs
-- every read). Deletes NOTHING — see the optional CLEANUP block at the bottom.
-- ============================================================================

-- 1) The synthetic app (Tenant A).
insert into public.apps (id, tenant_id, name, vendor_name, category, status) values
  ('5a9a0000-0000-0000-0000-000000000a01', 'aaaa1111-1111-1111-1111-111111111111',
   'Staging Apps Verification — App', 'Synthetic Vendor', 'Verification', 'active')
on conflict (id) do nothing;

-- 2) Link the synthetic app to an EXISTING Tenant A contract (same-tenant composite FK, 0005).
insert into public.app_contracts (app_id, contract_id, tenant_id) values
  ('5a9a0000-0000-0000-0000-000000000a01', 'cccca111-0000-0000-0000-0000000000a1',
   'aaaa1111-1111-1111-1111-111111111111')
on conflict (app_id, contract_id) do nothing;

-- 3) Two synthetic app users on the app (one will be matched, one will not).
insert into public.app_users
  (id, tenant_id, app_id, email, display_name, status, license_type, last_active_at) values
  ('5a9a0000-0000-0000-0000-000000000e01', 'aaaa1111-1111-1111-1111-111111111111',
   '5a9a0000-0000-0000-0000-000000000a01', 'verify-user-1@staging-apps-verification.local',
   'Staging Apps Verification User 1', 'active', 'Pro', now() - interval '5 days'),
  ('5a9a0000-0000-0000-0000-000000000e02', 'aaaa1111-1111-1111-1111-111111111111',
   '5a9a0000-0000-0000-0000-000000000a01', 'verify-user-2@staging-apps-verification.local',
   'Staging Apps Verification User 2', 'inactive', 'Free', now() - interval '200 days')
on conflict (id) do nothing;

-- 4) One synthetic person (required only because app_user_identity_matches.person_id is NOT NULL).
--    The match read surface exposes match STATUS only — no person PII is ever shown in the UI.
insert into public.people (id, tenant_id, primary_email, full_name) values
  ('5a9a0000-0000-0000-0000-000000000f01', 'aaaa1111-1111-1111-1111-111111111111',
   'verify-person-1@staging-apps-verification.local', 'Staging Apps Verification Person 1')
on conflict (id) do nothing;

-- 5) One identity match (User 1 ↔ Person) so /people shows exactly one matched + one unmatched.
insert into public.app_user_identity_matches
  (id, tenant_id, app_user_id, person_id, match_method, confidence) values
  ('5a9a0000-0000-0000-0000-000000000d01', 'aaaa1111-1111-1111-1111-111111111111',
   '5a9a0000-0000-0000-0000-000000000e01', '5a9a0000-0000-0000-0000-000000000f01', 'email', 95.00)
on conflict (app_user_id, person_id) do nothing;

-- ============================================================================
-- OPTIONAL CLEANUP — run ONLY if a human intentionally wants to remove this fixture.
-- Deletes EXACTLY the synthetic `5a9a0000-…` rows above (no unrelated rows). Order respects FKs.
-- The PREFERRED disposition is to LEAVE these rows in staging for repeatable verification.
-- (Left commented so a normal apply never deletes anything.)
-- ----------------------------------------------------------------------------
-- delete from public.app_user_identity_matches where id = '5a9a0000-0000-0000-0000-000000000d01';
-- delete from public.app_users      where id in ('5a9a0000-0000-0000-0000-000000000e01','5a9a0000-0000-0000-0000-000000000e02');
-- delete from public.app_contracts  where app_id = '5a9a0000-0000-0000-0000-000000000a01';
-- delete from public.apps           where id = '5a9a0000-0000-0000-0000-000000000a01';
-- delete from public.people         where id = '5a9a0000-0000-0000-0000-000000000f01';
-- ============================================================================
