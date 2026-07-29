-- 0062 — O1B: correct the Okta issuer-binding approved-scope CHECK to the authoritative three-scope read-only contract.
--
-- WHY THIS IS A BLOCKER, NOT A TIDY-UP
-- 0048 pinned the column with `check (approved_scopes = array['okta.users.read']::text[])`. That is exact ARRAY equality against a
-- one-element array, so it is both (a) users-only and (b) ORDER-SENSITIVE. The authoritative contract
-- (contracts/okta-provider-contract.v1.json, contract_version 1.0.0) is three read scopes:
--     okta.users.read, okta.groups.read, okta.apps.read
-- No binding carrying that set could be inserted AT ALL. The live connection flow would have failed at the first write, after the
-- customer had already configured their Okta application correctly.
--
-- WHAT THIS MIGRATION DOES
-- Replaces the constraint with an order-independent, duplicate-rejecting, NULL-rejecting EXACT-SET check. Least privilege is
-- unchanged in kind: all three scopes are READ scopes, no `.manage`/`.write` scope is permitted, and a broader set is still refused.
--
-- REVIEWED NON-DESTRUCTIVE: no table teardown, no truncation, no row deletion, no RLS change, no data rewrite. It drops and re-adds
-- ONE named CHECK constraint on one table and touches no other object. (Deliberately no `safety-ack` — the migration-safety
-- scanner has nothing to flag here, and an ack would misrepresent a constraint swap as a destructive change.)

-- The old constraint. `if exists` keeps this idempotent and safe to re-run.
alter table public.connector_okta_issuer_bindings
  drop constraint if exists okta_issuer_scope_chk;

-- The authoritative set, order-independent and duplicate-safe:
--   @>  every required scope is present
--   <@  no scope outside the required set is present
--   cardinality = 3  rejects duplicates (which @>/<@ alone would tolerate: {users,users,groups,apps} satisfies both)
--   array_position(..., null) is null  rejects a NULL element, for which containment semantics are not what they appear
--
-- ADDED `not valid` DELIBERATELY. Postgres still enforces this on every INSERT and UPDATE; `not valid` only skips the scan of
-- PRE-EXISTING rows. A staging binding created under 0048 necessarily holds the superseded users-only set, and a validating
-- constraint would make this migration FAIL on apply. Rewriting those rows is a governance decision about what an organization
-- approved — it is not a migration's call to make silently. See the operator note at the bottom.
alter table public.connector_okta_issuer_bindings
  add constraint okta_issuer_scope_chk check (
    approved_scopes @> array['okta.apps.read', 'okta.groups.read', 'okta.users.read']::text[]
    and approved_scopes <@ array['okta.apps.read', 'okta.groups.read', 'okta.users.read']::text[]
    and cardinality(approved_scopes) = 3
    and array_position(approved_scopes, null) is null
  ) not valid;

comment on constraint okta_issuer_scope_chk on public.connector_okta_issuer_bindings is
  'O1B: the approved scope set must EXACTLY equal the authoritative read-only contract {okta.users.read, okta.groups.read, okta.apps.read} as a SET — order-independent, no duplicates, no NULL element, no additional or write scope. Supersedes the 0048 users-only array-equality check.';

-- OPERATOR FOLLOW-UP (NOT performed here, and NOT required for new bindings)
-- Any binding row created under 0048 holds the superseded {okta.users.read} set and can never mint a working token, because the
-- runner requires all three scopes. Reconciling such a row is an explicit operator action:
--
--   1. Confirm the organization's Okta application actually grants all three scopes (live verification — still OUTSTANDING).
--   2. Update the binding's approved_scopes to the three-scope set, recording who approved it.
--   3. Then, and only then:  alter table public.connector_okta_issuer_bindings validate constraint okta_issuer_scope_chk;
--
-- Until step 3, pre-existing rows remain unchecked while every new or updated row is fully constrained.
