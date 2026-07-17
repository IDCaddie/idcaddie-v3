-- 0048_connector_okta_issuer_binding.sql
--
-- Adds the deferred per-organization Okta ISSUER BINDING (P5E18b, Phase 3). A binding records the NON-SECRET association between an
-- internal organization and an approved Okta issuer for a given environment: the normalized host, the canonical https issuer, the
-- exact approved scope, lifecycle status, and audit/correlation metadata. It contains NO secret of any kind (no client secret, no
-- access/refresh token, no authorization code, no PKCE verifier, no credential payload) — those live in the external secret store
-- behind their own boundary and are referenced only by connector_credential_references (0043).
--
-- This migration ACTIVATES nothing: it creates a table + RLS only, inserts no data, changes no status, and grants no write to any
-- request or runner role. Okta stays certificationOnly; a binding row does not make anything runnable. RISK-007 remains OPEN;
-- Phase C remains BLOCKED. Staging-only intent (environment CHECK = 'staging').
--
-- SECURITY MODEL: RLS-enabled. Ordinary/request roles cannot list all bindings. Only an ORGANIZATION MANAGER of the row's
-- organization may SELECT that organization's safe metadata (has_org_role, 0002). No request-role INSERT/UPDATE/DELETE — mutations
-- run only through the server-only service_role path (bypasses RLS). Cross-organization access is denied by the org-scoped policy;
-- an issuer cannot be actively bound to two organizations (partial unique index).

begin;

create table if not exists public.connector_okta_issuer_bindings (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  organization_id uuid not null,
  provider text not null,
  connector_id uuid,                      -- optional: a binding may pre-exist a connector row
  okta_hostname text not null,            -- normalized bare host, e.g. acme.okta.com
  issuer_url text not null,               -- canonical https issuer, e.g. https://acme.okta.com
  environment text not null,
  lifecycle_status text not null default 'certification_only',
  approved_scopes text[] not null,
  created_by text not null,
  approved_by text,
  correlation_ref text,                   -- non-secret correlation metadata
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  disabled_at timestamptz,
  -- provider is constrained to Okta for this table/model
  constraint okta_issuer_provider_chk check (provider = 'okta'),
  -- staging-only in this phase (mirrors the 0047 pilot environment CHECK)
  constraint okta_issuer_env_chk check (environment = 'staging'),
  -- lifecycle status is one of the known non-secret states
  constraint okta_issuer_lifecycle_chk check (lifecycle_status in ('certification_only', 'pilot_ready', 'enabled')),
  -- the issuer MUST be an https origin (no scheme downgrade, no path/query here)
  constraint okta_issuer_https_chk check (issuer_url ~ '^https://[a-z0-9.-]+$'),
  constraint okta_issuer_host_len_chk check (char_length(okta_hostname) between 1 and 255),
  constraint okta_issuer_url_len_chk check (char_length(issuer_url) between 9 and 512),
  constraint okta_issuer_created_by_len_chk check (char_length(created_by) between 1 and 256),
  -- the approved scope set is exactly okta.users.read (least privilege) — no broader scope may be recorded
  constraint okta_issuer_scope_chk check (approved_scopes = array['okta.users.read']::text[]),
  -- bind to the owning organization's composite key so a binding can exist only for a SAME-TENANT organization (0005 pattern)
  constraint okta_issuer_org_same_tenant
    foreign key (organization_id, tenant_id) references public.organizations (id, tenant_id) on delete cascade
);

-- One ACTIVE binding per organization + provider + environment (a disabled binding frees the slot).
create unique index if not exists connector_okta_issuer_bindings_active_org_uidx
  on public.connector_okta_issuer_bindings (organization_id, provider, environment)
  where disabled_at is null;

-- An issuer cannot be ACTIVELY reassigned across organizations: at most one active org per issuer + provider + environment.
create unique index if not exists connector_okta_issuer_bindings_active_issuer_uidx
  on public.connector_okta_issuer_bindings (issuer_url, provider, environment)
  where disabled_at is null;

create index if not exists connector_okta_issuer_bindings_org_idx
  on public.connector_okta_issuer_bindings (organization_id, provider, environment);

-- ── RLS: request roles get NOTHING to write; org managers read only their org's safe metadata ─────────────────────────────
alter table public.connector_okta_issuer_bindings enable row level security;
revoke all on public.connector_okta_issuer_bindings from anon, authenticated;
-- Org managers may READ their organization's non-secret binding metadata (rows scoped by has_org_role to the row's org).
grant select on public.connector_okta_issuer_bindings to authenticated;
create policy "org managers read their okta issuer bindings"
  on public.connector_okta_issuer_bindings
  for select
  to authenticated
  using (public.has_org_role(organization_id, array['manager']));
-- NO insert/update/delete policy and NO write grant for request roles — mutations run only via the server-only service_role
-- path (which bypasses RLS). anon gets nothing at all.

commit;
