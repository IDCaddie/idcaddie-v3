-- 0026_app_alias_natural_key.sql
--
-- DETERMINISTIC RESOLVER WRITE — natural-key idempotency for app_aliases (docs/42 §69). The first canonical
-- graph mutation path (the resolver write helper) upserts an `app_alias` for each DETERMINISTIC observed
-- identifier. For that upsert to be IDEMPOTENT at the persisted-state layer — "re-running the same staged fact
-- set does not increase app_alias row count" — an observed identifier must resolve to exactly ONE alias row.
--
-- This adds the alias NATURAL KEY: UNIQUE(tenant_id, alias_type, alias_value). A given (tenant, alias_type,
-- alias_value) — e.g. (A, instance_domain, "flywheel.atlassian.net") — exists at most once, so an
-- `insert ... on conflict (tenant_id, alias_type, alias_value) do nothing/update` re-run adds NO row. The
-- vendor (UNIQUE tenant_id, normalized_name) and app_product (UNIQUE tenant_id, vendor_id, normalized_name)
-- natural keys already exist (0024), so the whole deterministic write is idempotent on natural keys.
--
-- `app_aliases` is currently EMPTY (nothing writes it before this PR), so adding the UNIQUE is safe — there
-- are no existing rows to violate it. This is a CONSTRAINT only: no column/table/RLS/grant change (generated
-- types are unaffected), and it is purely additive (no table teardown, no row purge, no RLS disable).

begin;

alter table public.app_aliases
  add constraint app_aliases_tenant_type_value_key unique (tenant_id, alias_type, alias_value);

commit;
