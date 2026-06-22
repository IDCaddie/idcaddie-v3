-- 0021_connector_runner_grants.sql
--
-- The dedicated server-side CONNECTOR RUNNER DB principal + its least-privilege grant FOUNDATION (docs/42
-- §39.1/§39.2, gated vault). This is grant plumbing only — it creates a narrow privilege-holding role and
-- grants it ONLY what the OAuth `oauth_pending` single-use consume (PR #116) needs. It wires NO app request
-- path to the runner, stores NO credential, touches NO `connector_secrets`, and changes NO browser-role
-- (anon/authenticated) privilege. **The vault stays NOT usable for real credentials.**
--
-- WHY A DEDICATED ROLE (not service_role). The runner is the §3 "separate server-side principal, not the
-- user" — a background worker reached ONLY from the server-only runner entrypoint, never request/browser
-- code. It is NOT the broad `service_role` on a request path (the standing "no service-role on request
-- paths" rule + check-auth-safety still hold): `connector_runner` is a NARROW role whose ONLY grant is on
-- `oauth_pending`, SELECT + a 3-column UPDATE. NOLOGIN (a privilege role like anon/authenticated, not a
-- login).
--
-- WHY BYPASSRLS (justified + constrained). `oauth_pending` is RLS-enabled with ZERO policies (deny-all to
-- every non-bypass role — `0020`/T42), so a plain grant alone would still be RLS-denied. The runner is a
-- trusted server principal that re-derives + verifies the tenant SERVER-SIDE per action: its consume query
-- CONTRACT is tenant-bound (PR #116 §38: `update … where tenant_id = $tid and state_jti = $jti and
-- nonce_hash = $nh and consumed_at is null and expires_at > now()`), so cross-tenant rows are excluded by
-- the WHERE, not by RLS. The blast radius is tiny by construction: even with BYPASSRLS the role can ONLY
-- read `oauth_pending` and flip `consumed_at`/`attempt_count`/`last_rejected_code` — it has NO grant on
-- `connector_secrets`/`connectors`/`connector_runs` and NO INSERT/DELETE on `oauth_pending`. (T43 proves
-- both the exact privilege surface and the constrained query shape.)
--
-- LEAST PRIVILEGE (the 0017/0018 REVOKE-then-GRANT-narrow lesson). Defensive `revoke all` first, then the
-- minimum verbs on the minimum columns. NO INSERT (authorize-time create is a later PR), NO row delete /
-- no row purge (the expiry sweep is a later PR), NO REFERENCES, NO TRIGGER, and NO UPDATE on the immutable
-- identity columns (`tenant_id`/`state_jti`/`nonce_hash`/`provider`/…).
--
-- DEFERRED to later gated PRs (docs/42 §39.2/§39.7): the runner gets NO grant on `connector_secrets` (secret
-- read/write is a later, separately-reviewed PR — tombstone/version, never a row delete) and NO grant on
-- `connectors`/`connector_runs` (the lifecycle metadata write is a later PR). This PR is the consume-grant
-- foundation only.
--
-- Migration-safety: only CREATE ROLE + GRANT + a privilege-tightening `revoke all` here — no table teardown,
-- no row purge, no RLS disable. anon/authenticated deny-all on the secret tables is re-asserted, not weakened.

begin;

-- The narrow server-side runner principal (idempotent; nologin; bypassrls — see the header rationale).
do $$ begin
  if not exists (select from pg_roles where rolname = 'connector_runner') then
    create role connector_runner nologin bypassrls;
  end if;
end $$;

-- Clear any inherited/default privilege, then grant ONLY the oauth_pending consume privileges:
--   SELECT                                  — the read-only classify lookup (PR #116)
--   UPDATE (consumed_at, attempt_count, last_rejected_code) — the atomic single-use consume + a safe
--                                             rejected-attempt record (column-level; immutable identity
--                                             columns are NOT grantable to the runner).
revoke all on public.oauth_pending from connector_runner;
grant select on public.oauth_pending to connector_runner;
grant update (consumed_at, attempt_count, last_rejected_code) on public.oauth_pending to connector_runner;

-- anon/authenticated UNCHANGED: deny-all on oauth_pending + connector_secrets, SELECT-only on
-- connectors/connector_runs (0017/0018/0020). Re-assert the secret-table deny-all defensively (idempotent;
-- counters any hosted-default — the 0017/0018 pattern). NO policy is added for any browser role.
revoke all on public.oauth_pending, public.connector_secrets from anon, authenticated;

commit;
