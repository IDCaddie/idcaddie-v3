-- 0039_connector_runner_login_provision.sql
--
-- VERSIONED provisioning for the `connector_runner_login` LOGIN CHAIN SHAPE (docs/45 §4; RLS T57; doc 44 §5
-- production-prereq "versioned runner-login DDL"). Until now this role existed only as out-of-band operator DDL
-- (staging) + a T57 test fixture — the staging incident (the login had to be repaired out-of-band during the runner
-- proof) showed the shape must be reproducible from a reviewed migration, especially before any production
-- provisioning is considered.
--
-- ROLE MODEL (least privilege, unchanged from the documented DDL):
--   * `connector_runner`        — the existing runtime privilege role (0021): NOLOGIN, BYPASSRLS (justified/constrained
--                                 there), narrow column-scoped grants (0021/0029/0030/0031/0032/0033/0035…). UNCHANGED here.
--   * `connector_runner_login`  — the CONNECTION identity: LOGIN + NOINHERIT, member of connector_runner with SET
--                                 capability ONLY. It can do NOTHING except `SET ROLE connector_runner`:
--                                 no ambient privilege (NOINHERIT + inherit false membership), ZERO direct table
--                                 grants, NOT superuser / createdb / createrole / replication / bypassrls.
--
-- NO PASSWORD HERE (never in a migration / the repo): the password is OPERATOR-SET out-of-band
-- (`alter role connector_runner_login password '…'` from a no-echo source) and lives only in the AWS Secrets Manager
-- DB-URL secret. This migration provisions the ROLE SHAPE only. On a database where the role already exists (hosted
-- staging), every statement is idempotent and does NOT touch the password.
--
-- APPLYING TO HOSTED (staging re-assert or production provisioning) REMAINS A SEPARATE, EXPLICITLY-APPROVED OPERATOR
-- STEP — nothing applies automatically. RISK-007 remains OPEN; Phase C remains BLOCKED.
--
-- Migration-safety: CREATE ROLE (if missing) + attribute hardening + one membership grant + a defensive revoke —
-- no table changes, no row changes, no RLS/policy changes, no browser-role (anon/authenticated) change.
--
-- REQUIRES PostgreSQL 16+ (the `grant … with set true, inherit false` membership options). The local CI suite runs
-- postgres:16 and hosted STAGING is verified PG 17.x; CONFIRM the production Postgres major is 16+ before the
-- (separately-approved) hosted apply — on PG15 this fails loudly at the GRANT (fail-safe, nothing partial: the
-- transaction rolls back).

begin;

-- The connection identity (idempotent). LOGIN so the runner can connect; NOINHERIT so membership grants confer NO
-- ambient privilege — capability arrives ONLY via an explicit `SET ROLE connector_runner`.
do $$ begin
  if not exists (select from pg_roles where rolname = 'connector_runner_login') then
    create role connector_runner_login login noinherit;
  end if;
end $$;

-- Harden/normalize the attributes even when the role pre-exists (idempotent; does NOT touch the password):
-- exactly LOGIN + NOINHERIT, and none of the dangerous attributes.
alter role connector_runner_login login noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls;

-- Membership: may SET ROLE connector_runner — and NOTHING else. Explicit PG16+ options: SET TRUE (can assume the
-- runner role) + INHERIT FALSE (belt-and-braces with NOINHERIT: never ambient). Re-granting is idempotent (updates
-- options in place if they ever drifted).
grant connector_runner to connector_runner_login with set true, inherit false;

-- Defensive zero-direct-privilege sweep (idempotent; normally a no-op): the login role must hold NO direct table
-- privilege of its own — everything flows through SET ROLE connector_runner's narrow column grants.
revoke all on all tables in schema public from connector_runner_login;

commit;
