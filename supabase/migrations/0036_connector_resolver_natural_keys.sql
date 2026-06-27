-- 0036_connector_resolver_natural_keys.sql
-- Tenant-scoped NATURAL KEYS for idempotent connector-discovery resolver upserts (Slack P0 PR 4 / docs/47).
--
-- The resolver turns validated discovery facts into graph rows. Without a tenant-scoped unique key on the operational
-- tables, a re-run would INSERT duplicate apps/app_users/people. This migration adds the deterministic upsert keys so
-- re-running the same facts is idempotent at the DB layer (NOT only in app code):
--   * apps      : UNIQUE(tenant_id, external_instance_id)   — the connector instance identity (Slack workspace team_id,
--                 added by 0024). Manual apps keep external_instance_id NULL; NULLs are DISTINCT in a UNIQUE key, so
--                 manual apps stay unconstrained — only connector-discovered instances are deduped.
--   * app_users : UNIQUE(tenant_id, app_id, external_user_id) — one row per (tenant, app, provider user id).
--   * people    : UNIQUE(tenant_id, lower(primary_email))     — one person per (tenant, normalized email) [functional].
--
-- Tenant scope is in EVERY key (NO global provider uniqueness — a Slack user id may exist in two tenants as two rows).
-- NO RLS change, NO new/loosened policy, NO service-role path, NO column drop / row purge. Each key is preceded by a
-- defensive preflight that FAILS LOUD if pre-existing data would violate it (mirrors 0028).
-- check-migration-safety: only ALTER ADD CONSTRAINT + CREATE UNIQUE INDEX (additive).

-- ── apps (tenant_id, external_instance_id) ────────────────────────────────────────────────────────────────────────
do $$ declare n int; begin
  select count(*) into n from (
    select tenant_id, external_instance_id from public.apps
     where external_instance_id is not null
     group by tenant_id, external_instance_id having count(*) > 1
  ) d;
  if n > 0 then raise exception '0036: apps has % duplicate (tenant_id, external_instance_id) group(s) — resolve before adding the unique key', n; end if;
end $$;
alter table public.apps
  add constraint apps_tenant_external_instance_key unique (tenant_id, external_instance_id);

-- ── app_users (tenant_id, app_id, external_user_id) ───────────────────────────────────────────────────────────────
do $$ declare n int; begin
  select count(*) into n from (
    select tenant_id, app_id, external_user_id from public.app_users
     where external_user_id is not null
     group by tenant_id, app_id, external_user_id having count(*) > 1
  ) d;
  if n > 0 then raise exception '0036: app_users has % duplicate (tenant_id, app_id, external_user_id) group(s)', n; end if;
end $$;
alter table public.app_users
  add constraint app_users_tenant_app_external_key unique (tenant_id, app_id, external_user_id);

-- ── people (tenant_id, lower(primary_email)) — functional, so a UNIQUE INDEX (not a table constraint) ──────────────
do $$ declare n int; begin
  select count(*) into n from (
    select tenant_id, lower(primary_email) le from public.people
     group by tenant_id, lower(primary_email) having count(*) > 1
  ) d;
  if n > 0 then raise exception '0036: people has % duplicate (tenant_id, lower(primary_email)) group(s)', n; end if;
end $$;
create unique index people_tenant_email_lower_key on public.people (tenant_id, lower(primary_email));
