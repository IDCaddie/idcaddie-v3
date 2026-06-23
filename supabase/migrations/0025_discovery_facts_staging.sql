-- 0025_discovery_facts_staging.sql
--
-- DISCOVERY FACT INGESTION STAGING BOUNDARY (docs/42 §64). The first safe, RLS-backed write path for
-- VALIDATED discovery facts: a tenant-scoped staging table that holds only `safeParse`-validated facts
-- (the PR #141 zod contract) for later resolver / human review. This is NOT a provider connector, NOT a live
-- resolver, NOT a sync.
--
-- SCOPE: ONE staging table + RLS + indexes. It does NOT write the canonical app graph (no apps.canonical_app_id
-- write, no app_aliases write, no app_user_identity_matches write), call a provider, exchange/store a token,
-- or touch connector_secrets. There is NO connector_runner grant and NO service-role path — the staging row is
-- inserted ONLY through the user-scoped (authenticated) RLS context by the server-only ingestion helper, after
-- the fact passes `safeParse` + the token/secret deny-list.
--
-- Tenant integrity + RLS mirror the rest of the schema: tenant_id FK + UNIQUE(id, tenant_id) (the `0005`
-- pattern), and the `0004`-hardened RLS posture — members read + editors INSERT + editors UPDATE, and
-- explicitly NO DELETE policy (staged facts are DURABLE review records; a rejected fact is marked
-- review_status='rejected' with rejected_reason, never deleted).
--
-- Migration-safety: CREATE TABLE / CREATE INDEX / CREATE POLICY only — no teardown, no row purge, no RLS
-- disable, no broad grant, no connector_secrets touch.

begin;

create table public.discovery_facts (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  schema_version text not null,                            -- the PR #141 contract version (e.g. "1")
  fact_type text not null,                                 -- one of the 13 #141 fact categories
  source_type text not null,                               -- e.g. identity_provider_discovery / unknown_source
  source_provider text not null,                           -- a provider/source label (e.g. "okta"); never a secret
  source_run_id uuid,                                      -- the ingestion run, if any (a free uuid — no FK)
  source_record_id text,
  signal_id text,                                          -- the source's deterministic signal id
  natural_key text,                                        -- a deterministic, NON-secret dedup/merge key
  observed_at timestamptz not null,
  confidence numeric(5,2),                                 -- the fact's confidence (0..1), denormalized for queries
  review_status text not null default 'pending'
    check (review_status in ('pending', 'confirmed', 'rejected', 'auto', 'needs_review')),
  reviewed_by uuid references public.profiles (id) on delete set null,
  reviewed_at timestamptz,
  fact_json jsonb not null,                                -- the ORIGINAL safeParse-validated fact (no secrets)
  provenance_json jsonb,                                   -- safe provenance metadata only (no secret/token payload)
  rejected_reason text,                                    -- why a fact was rejected at review (durable, not deleted)
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint discovery_facts_id_tenant_key unique (id, tenant_id)
);

-- ── RLS — members read; editors INSERT + UPDATE; NO DELETE (durable review records, the 0004-hardened pattern)
alter table public.discovery_facts enable row level security;

create policy "members read discovery_facts" on public.discovery_facts
  for select using (public.is_tenant_member(tenant_id));
create policy "editors insert discovery_facts" on public.discovery_facts
  for insert with check (public.has_tenant_role(tenant_id, array['owner', 'admin', 'editor']));
create policy "editors update discovery_facts" on public.discovery_facts
  for update using (public.has_tenant_role(tenant_id, array['owner', 'admin', 'editor']))
  with check (public.has_tenant_role(tenant_id, array['owner', 'admin', 'editor']));

-- ── indexes — tenant scoping + the review/dedup query paths ──────────────────────────────────────────────
create index discovery_facts_tenant_idx           on public.discovery_facts (tenant_id);
create index discovery_facts_tenant_fact_type_idx  on public.discovery_facts (tenant_id, fact_type);
create index discovery_facts_tenant_provider_idx   on public.discovery_facts (tenant_id, source_provider);
create index discovery_facts_tenant_review_idx     on public.discovery_facts (tenant_id, review_status);
create index discovery_facts_tenant_natural_key_idx on public.discovery_facts (tenant_id, natural_key);
create index discovery_facts_source_run_idx        on public.discovery_facts (source_run_id);

commit;
