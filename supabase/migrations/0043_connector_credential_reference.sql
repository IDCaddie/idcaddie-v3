-- 0043_connector_credential_reference.sql
--
-- Adds provider-neutral CREDENTIAL-REFERENCE METADATA in a DEDICATED, server-only (deny-all) table so the background runner
-- can resolve an ownership-validated connection's EXTERNAL secret reference (e.g. an AWS Secrets Manager ARN) + version. The
-- reference is a POINTER, NEVER a credential value; the actual secret lives in the external store behind its own IAM/role
-- boundary.
--
-- WHY a SEPARATE table (NOT columns on public.connectors): connectors carries a table-wide `authenticated` SELECT grant, and a
-- table-level grant covers EVERY column (RLS filters rows, not columns) — so putting the reference on connectors would let any
-- tenant member read the ARN directly via PostgREST, bypassing the server-only DAL. This table therefore MIRRORS the Tier-2
-- connector_secrets isolation model (migrations 0017/0018/0029/0030): RLS-enabled with ZERO policies (default deny-all) + an
-- explicit `revoke all` from anon/authenticated + a NARROW COLUMN-scoped SELECT to the background `connector_runner` role only.
-- Request-path roles (anon/authenticated) get NOTHING here.
--
-- ENV-NEUTRAL: the schema hardcodes NO account/region/namespace (env-specific ARN validation stays in the runner). Columns are
-- NOT NULL, so a ROW IS a present reference; an absent row (no reference provisioned yet) is INELIGIBLE / fails closed
-- downstream. No backfill / no fabricated reference. This migration ACTIVATES/ENABLES nothing (no status change, no write grant,
-- no client-facing policy). Controlled provisioning (the WRITE path) is deferred to a separate GO-gated PR. RISK-007 remains OPEN.

begin;

create table if not exists public.connector_credential_references (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  connector_id uuid not null,
  provider text not null,
  credential_secret_ref text not null,   -- an EXTERNAL secret POINTER (e.g. an ARN); NEVER a credential value
  credential_version text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint connector_credential_references_ref_len     check (char_length(credential_secret_ref) between 1 and 512),
  constraint connector_credential_references_version_len check (char_length(credential_version) between 1 and 256),
  -- exactly one reference per owned connector + provider
  constraint connector_credential_references_unique unique (tenant_id, connector_id, provider),
  -- bind to the owning connector's composite key so a reference can only exist for a SAME-TENANT connector (cascade on delete)
  constraint connector_credential_references_connector_same_tenant
    foreign key (connector_id, tenant_id) references public.connectors (id, tenant_id) on delete cascade
);

create index if not exists connector_credential_references_owner_idx
  on public.connector_credential_references (tenant_id, connector_id, provider);

-- Tier-2 posture: RLS-enabled with ZERO policies (default deny-all) + explicit revoke (counters hosted default grants). NO
-- request-path (anon/authenticated) privilege — a tenant member cannot read the reference/ARN through Supabase/PostgREST.
alter table public.connector_credential_references enable row level security;
revoke all on public.connector_credential_references from anon, authenticated;

-- The background runner reads ONLY the reference metadata for the EXACT owned connector (tenant-bound WHERE; BYPASSRLS makes a
-- `to connector_runner` policy a no-op, so isolation is the runner's tenant+connector+provider WHERE). Revoke-then-grant-narrow.
-- No write grant (the runner cannot set/rotate the reference). It also gets a NARROW identity+status SELECT on connectors for
-- the eligibility JOIN (NO credential column) — connectors' member-readable grant is unchanged (no new column on connectors).
revoke all on public.connector_credential_references from connector_runner;
grant select (tenant_id, connector_id, provider, credential_secret_ref, credential_version)
  on public.connector_credential_references to connector_runner;
revoke all on public.connectors from connector_runner;
grant select (id, tenant_id, provider, status) on public.connectors to connector_runner;

commit;
