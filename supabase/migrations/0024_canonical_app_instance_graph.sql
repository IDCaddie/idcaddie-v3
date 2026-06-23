-- 0024_canonical_app_instance_graph.sql
--
-- CANONICAL VENDOR / PRODUCT / APP-INSTANCE GRAPH — schema/design foundation (docs/42 §59, docs/41 §70).
-- NET-NEW product moat work (NOT old-app parity restoration — the old app was also FLAT at the app-document
-- level and only had a MANUAL overlap-analysis grouping/report, never an automatic canonical graph).
--
-- THE HIERARCHY this enables: vendor → canonical app/product → app instance/site/workspace →
-- users/contracts/invoices/license facts/metrics. `apps` REMAINS the operational app instance/site/workspace
-- row; canonical grouping is layered ABOVE it (normalize by GROUPING, not by erasing). Distinct app instances
-- (e.g. Atlassian Jira "Flywheel" flywheel.atlassian.net vs Jira "Perpetua" perpetua.atlassian.net) MUST NOT
-- be collapsed into one `apps` row — they group under one canonical product but stay separate `apps` rows.
--
-- SCOPE: schema + RLS + indexes ONLY. It adds the three canonical tables + nullable `apps.canonical_app_id`
-- + structured instance-identity fields on `apps` (the resolver's FUTURE merge/no-merge discriminators). It
-- DOES NOT implement automatic canonical matching, run any resolver/merge job, write app-graph data, rebuild
-- `app_contracts` (the existing many-to-many already links one contract to many instances), or implement
-- one-invoice-split-across-orgs allocation (a documented future gap — docs/42 §59). There is NO
-- `identity_account_id` column (none exists; the match graph is app_user → person / identity_account →
-- person). No connector_secrets grant/policy, no provider API, no token/credential handling.
--
-- Tenant integrity mirrors `0005`: each new table has UNIQUE(id, tenant_id) + same-tenant composite FKs
-- (MATCH SIMPLE). RLS mirrors the `0004`-hardened evidence-table pattern: members read + editors INSERT +
-- editors UPDATE, and NO DELETE policy (canonical groupings are repointed, not erased — the resolver unmerges
-- by repointing aliases/canonical_app_id, never by rewriting historical users/contracts/invoices).
--
-- Migration-safety: CREATE TABLE / ALTER TABLE ADD COLUMN / CREATE INDEX / CREATE POLICY only — no table
-- teardown, no row purge, no RLS disable, no broad grant. Audit/review fields reuse the
-- `app_user_identity_matches` pattern (confidence numeric(5,2) / reviewed_by / reviewed_at + a review_status).

begin;

-- ── vendors (tenant-scoped) — the vendor family, e.g. "Atlassian" ───────────────────────────────────────
create table public.vendors (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  name text not null,
  normalized_name text not null,                          -- lower(trim(name)) — the per-tenant dedup key
  website_domain text,                                    -- e.g. 'atlassian.com' (a future deterministic key)
  source text,                                            -- provenance label (e.g. 'manual','okta'); never a secret
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint vendors_id_tenant_key unique (id, tenant_id),                 -- enables same-tenant composite FKs
  constraint vendors_tenant_normalized_name_key unique (tenant_id, normalized_name)
);

-- ── app_products (tenant-scoped) — the CANONICAL app/product, e.g. "Jira" / "Confluence" / "Bitbucket" ───
create table public.app_products (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  vendor_id uuid,                                         -- nullable; same-tenant via the composite FK below
  name text not null,
  normalized_name text not null,
  category text,
  source text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint app_products_id_tenant_key unique (id, tenant_id),
  -- a canonical product is unique per (tenant, vendor) by normalized name (null vendor rows stay distinct).
  constraint app_products_tenant_vendor_name_key unique (tenant_id, vendor_id, normalized_name),
  -- same-tenant: when vendor_id is set it MUST belong to the same tenant (MATCH SIMPLE skips null).
  constraint app_products_vendor_same_tenant
    foreign key (vendor_id, tenant_id) references public.vendors (id, tenant_id) match simple on delete set null
);

-- ── app_aliases (tenant-scoped) — source/provenance/alias mapping + the resolver's review record ────────
-- Maps an observed source identifier (a domain / external instance id / provider app id / a discovered name)
-- to a canonical app_product (and, when known, the operational `apps` instance it came from), with the
-- audit/review fields. This is provenance + the resolver's future decision log — NOT app-graph data yet.
create table public.app_aliases (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  app_product_id uuid not null,                           -- the canonical product this alias maps to
  app_id uuid,                                            -- the operational apps instance it came from (nullable)
  alias_type text not null
    check (alias_type in ('domain','instance_domain','external_instance_id','provider_app_id','oauth_client_id','sso_app_id','name')),
  alias_value text not null,                              -- the observed value (a label/id, never a secret/token)
  source text,                                            -- which provider/discovery surfaced it (provenance)
  confidence numeric(5,2),                                -- 0..100 match confidence (the app_user_identity_matches pattern)
  review_status text not null default 'pending'
    check (review_status in ('pending','confirmed','rejected','auto')),
  reviewed_by uuid references public.profiles (id) on delete set null,
  reviewed_at timestamptz,
  provenance jsonb,                                       -- safe provenance metadata (no secret/token payload)
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint app_aliases_id_tenant_key unique (id, tenant_id),
  constraint app_aliases_product_same_tenant
    foreign key (app_product_id, tenant_id) references public.app_products (id, tenant_id) match simple on delete cascade,
  constraint app_aliases_app_same_tenant
    foreign key (app_id, tenant_id) references public.apps (id, tenant_id) match simple on delete set null
);

-- ── apps: nullable canonical link + structured instance-identity discriminators ─────────────────────────
-- `apps` STAYS the operational instance row. canonical_app_id groups it under a canonical product WITHOUT
-- collapsing it. instance_domain / external_instance_id / instance_url are the resolver's FUTURE
-- merge/no-merge discriminators (the current v3 apps row has no safe instance discriminator).
alter table public.apps add column canonical_app_id uuid;
alter table public.apps add column instance_domain text;        -- e.g. 'flywheel.atlassian.net'
alter table public.apps add column external_instance_id text;   -- the provider's instance id
alter table public.apps add column instance_url text;           -- e.g. 'https://flywheel.atlassian.net/wiki'
-- same-tenant: an apps row may only be grouped under a canonical product in the SAME tenant.
alter table public.apps add constraint apps_canonical_app_same_tenant
  foreign key (canonical_app_id, tenant_id) references public.app_products (id, tenant_id) match simple on delete set null;

-- ── RLS — members read; editors INSERT + UPDATE; NO DELETE (the 0004-hardened evidence-table pattern) ───
alter table public.vendors enable row level security;
alter table public.app_products enable row level security;
alter table public.app_aliases enable row level security;

create policy "members read vendors" on public.vendors
  for select using (public.is_tenant_member(tenant_id));
create policy "editors insert vendors" on public.vendors
  for insert with check (public.has_tenant_role(tenant_id, array['owner','admin','editor']));
create policy "editors update vendors" on public.vendors
  for update using (public.has_tenant_role(tenant_id, array['owner','admin','editor']))
  with check (public.has_tenant_role(tenant_id, array['owner','admin','editor']));

create policy "members read app_products" on public.app_products
  for select using (public.is_tenant_member(tenant_id));
create policy "editors insert app_products" on public.app_products
  for insert with check (public.has_tenant_role(tenant_id, array['owner','admin','editor']));
create policy "editors update app_products" on public.app_products
  for update using (public.has_tenant_role(tenant_id, array['owner','admin','editor']))
  with check (public.has_tenant_role(tenant_id, array['owner','admin','editor']));

create policy "members read app_aliases" on public.app_aliases
  for select using (public.is_tenant_member(tenant_id));
create policy "editors insert app_aliases" on public.app_aliases
  for insert with check (public.has_tenant_role(tenant_id, array['owner','admin','editor']));
create policy "editors update app_aliases" on public.app_aliases
  for update using (public.has_tenant_role(tenant_id, array['owner','admin','editor']))
  with check (public.has_tenant_role(tenant_id, array['owner','admin','editor']));

-- ── indexes — the new tables + the new apps canonical/instance fields ───────────────────────────────────
create index vendors_tenant_idx              on public.vendors (tenant_id);
create index vendors_name_lower_idx           on public.vendors (lower(name));
create index app_products_tenant_idx          on public.app_products (tenant_id);
create index app_products_vendor_idx          on public.app_products (vendor_id);
create index app_products_name_lower_idx      on public.app_products (lower(name));
create index app_aliases_tenant_idx           on public.app_aliases (tenant_id);
create index app_aliases_product_idx          on public.app_aliases (app_product_id);
create index app_aliases_app_idx              on public.app_aliases (app_id);
create index app_aliases_type_value_lower_idx on public.app_aliases (alias_type, lower(alias_value));
create index apps_canonical_app_idx           on public.apps (canonical_app_id);
create index apps_instance_domain_lower_idx   on public.apps (lower(instance_domain));
create index apps_external_instance_id_idx    on public.apps (external_instance_id);

commit;
