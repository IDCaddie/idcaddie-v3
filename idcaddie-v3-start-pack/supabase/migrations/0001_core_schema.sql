-- ID Caddie v3 core schema skeleton
-- Review before applying to production.

create extension if not exists pgcrypto;

create table public.tenants (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  slug text not null unique,
  status text not null default 'active' check (status in ('active','paused','disabled')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text not null,
  full_name text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.tenant_memberships (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  role text not null check (role in ('owner','admin','editor','viewer')),
  status text not null default 'active' check (status in ('active','invited','disabled')),
  created_at timestamptz not null default now(),
  unique (tenant_id, user_id)
);

create table public.organizations (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  parent_org_id uuid references public.organizations(id) on delete set null,
  name text not null,
  type text not null default 'agency',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.organization_memberships (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  role text not null check (role in ('manager','viewer')),
  created_at timestamptz not null default now(),
  unique (organization_id, user_id)
);

create table public.apps (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  name text not null,
  vendor_name text,
  category text,
  status text not null default 'active',
  source_of_truth_type text default 'manual',
  technical_owner_user_id uuid references public.profiles(id) on delete set null,
  business_owner_user_id uuid references public.profiles(id) on delete set null,
  procurement_owner_org_id uuid references public.organizations(id) on delete set null,
  paying_org_id uuid references public.organizations(id) on delete set null,
  responsible_org_id uuid references public.organizations(id) on delete set null,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.contracts (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  vendor_name text,
  contract_name text not null,
  status text not null default 'active',
  start_date date,
  end_date date,
  renewal_date date,
  notice_deadline date,
  total_cost numeric(14,2),
  currency text default 'USD',
  billing_frequency text,
  owner_user_id uuid references public.profiles(id) on delete set null,
  procurement_org_id uuid references public.organizations(id) on delete set null,
  paying_org_id uuid references public.organizations(id) on delete set null,
  renewal_responsibility text default 'unknown',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.app_contracts (
  app_id uuid not null references public.apps(id) on delete cascade,
  contract_id uuid not null references public.contracts(id) on delete cascade,
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  relationship_type text default 'primary',
  created_at timestamptz not null default now(),
  primary key (app_id, contract_id)
);

create table public.people (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  primary_email text not null,
  full_name text,
  employee_status text,
  department text,
  title text,
  manager_email text,
  source text,
  raw_payload jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.identity_accounts (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  person_id uuid references public.people(id) on delete set null,
  provider text not null,
  external_id text,
  email text not null,
  status text,
  raw_payload jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.app_users (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  app_id uuid not null references public.apps(id) on delete cascade,
  external_user_id text,
  email text,
  display_name text,
  status text,
  license_type text,
  last_active_at timestamptz,
  source text,
  raw_payload jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.app_user_identity_matches (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  app_user_id uuid not null references public.app_users(id) on delete cascade,
  person_id uuid not null references public.people(id) on delete cascade,
  match_method text not null,
  confidence numeric(5,2),
  reviewed_by uuid references public.profiles(id) on delete set null,
  reviewed_at timestamptz,
  created_at timestamptz not null default now(),
  unique (app_user_id, person_id)
);

create table public.license_rules (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  app_id uuid not null references public.apps(id) on delete cascade,
  name text not null,
  license_type text,
  expression_json jsonb not null default '{}'::jsonb,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.license_evaluations (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  app_id uuid not null references public.apps(id) on delete cascade,
  app_user_id uuid not null references public.app_users(id) on delete cascade,
  license_rule_id uuid references public.license_rules(id) on delete set null,
  license_type text,
  is_billable boolean not null default false,
  evaluated_at timestamptz not null default now(),
  explanation text
);

create table public.files (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  storage_path text not null,
  original_filename text not null,
  file_type text,
  document_type text,
  uploaded_by uuid references public.profiles(id) on delete set null,
  processing_status text not null default 'pending',
  created_at timestamptz not null default now()
);

create table public.invoices (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  vendor_name text,
  invoice_number text,
  invoice_date date,
  amount numeric(14,2),
  currency text default 'USD',
  file_id uuid references public.files(id) on delete set null,
  app_id uuid references public.apps(id) on delete set null,
  contract_id uuid references public.contracts(id) on delete set null,
  created_at timestamptz not null default now()
);

create table public.audit_logs (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  actor_user_id uuid references public.profiles(id) on delete set null,
  action text not null,
  resource_type text not null,
  resource_id uuid,
  before_json jsonb,
  after_json jsonb,
  ip_address inet,
  user_agent text,
  created_at timestamptz not null default now()
);

-- Helpers
create or replace function public.is_tenant_member(target_tenant_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.tenant_memberships tm
    where tm.tenant_id = target_tenant_id
      and tm.user_id = auth.uid()
      and tm.status = 'active'
  );
$$;

create or replace function public.has_tenant_role(target_tenant_id uuid, allowed_roles text[])
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.tenant_memberships tm
    where tm.tenant_id = target_tenant_id
      and tm.user_id = auth.uid()
      and tm.status = 'active'
      and tm.role = any(allowed_roles)
  );
$$;

-- Enable RLS
alter table public.tenants enable row level security;
alter table public.profiles enable row level security;
alter table public.tenant_memberships enable row level security;
alter table public.organizations enable row level security;
alter table public.organization_memberships enable row level security;
alter table public.apps enable row level security;
alter table public.contracts enable row level security;
alter table public.app_contracts enable row level security;
alter table public.people enable row level security;
alter table public.identity_accounts enable row level security;
alter table public.app_users enable row level security;
alter table public.app_user_identity_matches enable row level security;
alter table public.license_rules enable row level security;
alter table public.license_evaluations enable row level security;
alter table public.files enable row level security;
alter table public.invoices enable row level security;
alter table public.audit_logs enable row level security;

-- Basic tenant policies. Tighten further per table before production.
create policy "members can read tenant" on public.tenants
for select using (public.is_tenant_member(id));

create policy "users can read own profile" on public.profiles
for select using (id = auth.uid());

create policy "members can read tenant memberships" on public.tenant_memberships
for select using (public.is_tenant_member(tenant_id));

create policy "admins manage tenant memberships" on public.tenant_memberships
for all using (public.has_tenant_role(tenant_id, array['owner','admin']))
with check (public.has_tenant_role(tenant_id, array['owner','admin']));

-- Repeatable pattern for operational tables.
create policy "members read organizations" on public.organizations
for select using (public.is_tenant_member(tenant_id));
create policy "editors manage organizations" on public.organizations
for all using (public.has_tenant_role(tenant_id, array['owner','admin','editor']))
with check (public.has_tenant_role(tenant_id, array['owner','admin','editor']));

create policy "members read apps" on public.apps
for select using (public.is_tenant_member(tenant_id));
create policy "editors manage apps" on public.apps
for all using (public.has_tenant_role(tenant_id, array['owner','admin','editor']))
with check (public.has_tenant_role(tenant_id, array['owner','admin','editor']));

create policy "members read contracts" on public.contracts
for select using (public.is_tenant_member(tenant_id));
create policy "editors manage contracts" on public.contracts
for all using (public.has_tenant_role(tenant_id, array['owner','admin','editor']))
with check (public.has_tenant_role(tenant_id, array['owner','admin','editor']));

create policy "members read app_contracts" on public.app_contracts
for select using (public.is_tenant_member(tenant_id));
create policy "editors manage app_contracts" on public.app_contracts
for all using (public.has_tenant_role(tenant_id, array['owner','admin','editor']))
with check (public.has_tenant_role(tenant_id, array['owner','admin','editor']));

create policy "members read people" on public.people
for select using (public.is_tenant_member(tenant_id));
create policy "editors manage people" on public.people
for all using (public.has_tenant_role(tenant_id, array['owner','admin','editor']))
with check (public.has_tenant_role(tenant_id, array['owner','admin','editor']));

create policy "members read app users" on public.app_users
for select using (public.is_tenant_member(tenant_id));
create policy "editors manage app users" on public.app_users
for all using (public.has_tenant_role(tenant_id, array['owner','admin','editor']))
with check (public.has_tenant_role(tenant_id, array['owner','admin','editor']));

create policy "members read audit logs" on public.audit_logs
for select using (public.is_tenant_member(tenant_id));
-- No update/delete policies for audit logs.
