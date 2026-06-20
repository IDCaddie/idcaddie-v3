-- 0018_harden_connector_vault_grants.sql
--
-- PRIVILEGE CORRECTION for the connector vault Tier-1 tables — the 0015/0016 lesson, again. Migration
-- `0017` created public.connectors / public.connector_runs / public.connector_secrets and did
-- `grant select ... to authenticated` on the two Tier-1 metadata tables, but it NEVER `revoke`d — so it
-- relied on a freshly-created table holding no other grants. On HOSTED Supabase that assumption is FALSE:
-- the project's default privileges grant `anon`/`authenticated` broad table access on new `public` tables.
-- STAGING VERIFICATION of 0017 (project `ycdpzduxugdsffjqyoai`) found `anon`/`authenticated` holding broad
-- INSERT/UPDATE/DELETE/TRUNCATE/REFERENCES/TRIGGER/SELECT on connectors AND connector_runs. The local
-- `test-rls.sh` harness MASKED it: it blanket-grants then re-asserts only `insert,update,delete,truncate`
-- away (not REFERENCES/TRIGGER, not a full `revoke all`), so the over-broad grant slipped through — the
-- exact masking class 0015/0016 was written to defend against. `connector_secrets` was already correct
-- (RLS-enabled, zero policies, deny-all — `0017` did `revoke all` on it).
--
-- This migration REVOKEs ALL request-path-role privileges from all three vault tables, then GRANTs back
-- ONLY the minimum intended privilege: `SELECT` to `authenticated` on the two Tier-1 metadata tables
-- (matching their existing tenant-member SELECT RLS policy, `0017`). Nothing is granted to `anon` on any
-- vault table. `connector_secrets` stays DENY-ALL (RLS-enabled, zero policies, no grant). `service_role`
-- (trusted, BYPASSRLS, never a request path) is NOT touched.
--
-- After 0018, the `authenticated` privilege surface is EXACTLY: connectors=SELECT, connector_runs=SELECT,
-- connector_secrets=(none); `anon`=(none) on all three. No INSERT/UPDATE/DELETE/TRUNCATE/REFERENCES/
-- TRIGGER for the request-path roles anywhere in the vault. Proven by org_rls_test.sql T40 (exact
-- per-role privilege arrays + TRUNCATE/REFERENCES/TRIGGER negatives + tenant-scoped SELECT still works +
-- cross-tenant SELECT still denied). The harness re-assert is updated to mirror this (revoke all + grant
-- select) so the suite reflects the REAL hosted surface.
--
-- SCOPE — privilege-only. NO table/column/policy/index change, NO new RLS policy (no write policy added),
-- NO function/trigger/runner, NO encryption, NO service-role path, NO UI, NO DAL. The vault stays NOT
-- usable; connector implementation stays blocked. Idempotent: REVOKE/GRANT converge to the same end state
-- regardless of prior grants, so re-applying it (e.g. to the staging project that already has the broad
-- grants) fixes it. check-migration-safety: no DROP TABLE / no TRUNCATE statement / no DISABLE RLS —
-- `revoke all` is privilege TIGHTENING (it removes TRUNCATE/etc., it does not run a TRUNCATE).
-- safety-ack: this REVOKEs broad privileges (incl. TRUNCATE) from anon/authenticated on the connector
-- vault tables — privilege tightening to least privilege, the opposite of a destructive teardown; reviewed.

begin;

-- Tier-2 secret table: re-assert DENY-ALL for the request-path roles (idempotent; 0017 already did this,
-- and staging confirmed it correct — re-asserting here keeps all three vault tables hardened in one place).
revoke all on public.connector_secrets from anon, authenticated;

-- Tier-1 metadata tables: REVOKE the broad (hosted-default) grants, then GRANT back ONLY SELECT to
-- authenticated (matching the 0017 tenant-member SELECT RLS policy). anon gets nothing.
revoke all on public.connectors     from anon, authenticated;
revoke all on public.connector_runs from anon, authenticated;
grant select on public.connectors     to authenticated;
grant select on public.connector_runs to authenticated;

commit;
