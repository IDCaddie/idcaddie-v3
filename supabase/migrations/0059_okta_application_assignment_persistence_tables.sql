-- 0059_okta_application_assignment_persistence_tables.sql
--
-- Phase 12 (Migration A) — durable, tenant/connection-scoped Okta application-ASSIGNMENT persistence: the TWO canonical
-- provider-neutral EDGE tables. Assignments are kept SEPARATE (different endpoint, different canonical target, different
-- lifecycle), so there are two tables, never one with a nullable endpoint:
--   directory_application_user_assignments   (identity_accounts <-> directory_applications) — DIRECT (scope=USER) user grants
--   directory_application_group_assignments  (directory_groups  <-> directory_applications) — group-to-app grants
-- These are the assignment analogues of the 0056 membership EDGE, verbatim in shape with the endpoint swapped. They do NOT
-- compute effective access, do NOT infer inheritance, do NOT expand memberships — a group-to-app grant is stored as an edge,
-- never fanned out to the group's members. All ADDITIVE. This migration (A) adds the ONE missing FULL parent unique constraint
-- (directory_applications, so the edges can composite-FK the application endpoint — identity_accounts + directory_groups already
-- got theirs at 0056:21-24); (B) creates both edges (canonical ROW-id references only — NO raw_payload, NO app label / group name /
-- user login / email / assignment id / scope metadata) with the immutable relationship key + the 0056 freshness/sync_status shape;
-- (C) enables deny-all RLS + revokes direct DML incl. connector_runner (writes go ONLY through the 0060 SECURITY DEFINER RPCs; NO
-- direct table grant, NO SELECT policy — a reviewed UI read is deferred). The fact types + promotion/stale RPCs are Migration B
-- (0060). Keeps connection_state = discovered (no advance). ACTIVATES nothing. Staging only; RISK-007 OPEN; Phase C BLOCKED;
-- no schedule, no active, no registry, no effective-access, no license analytics.

begin;

-- ══ A. the ONE missing FULL (non-partial) unique constraint = the application composite-FK target. Additive-safe: `id` is the PK,
-- so (id, tenant_id, connection_id, provider) is already unique for every existing/future row. 0057 gave directory_applications
-- only a PARTIAL provider-identity index (on the external_id tuple), which Postgres cannot use as an FK target. identity_accounts
-- and directory_groups already carry their *_id_scope_key from 0056:21-24. ══════════════════════════════════════════════════════════
alter table public.directory_applications drop constraint if exists directory_applications_id_scope_key;
alter table public.directory_applications add constraint directory_applications_id_scope_key unique (id, tenant_id, connection_id, provider);

-- ══ B1. CREATE the canonical provider-neutral USER-assignment EDGE (identity_accounts <-> directory_applications) ════════════════════
create table if not exists public.directory_application_user_assignments (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  connection_id uuid not null,
  provider text not null,
  directory_application_id uuid not null,  -- canonical ROW ref = directory_applications.id (resolved from the app external_id at promotion)
  identity_account_id uuid not null,       -- canonical ROW ref = identity_accounts.id (resolved from the user external_id at promotion)
  first_seen_at timestamptz,
  last_seen_at timestamptz,
  stale_since timestamptz,
  sync_status text not null default 'current',
  last_discovery_run_id uuid,
  schema_version text,
  sanitizer_version text,
  normalizer_version text,
  source_endpoint text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- sync_status vocabulary (identical to directory_applications / directory_group_memberships).
  constraint daua_sync_status_chk check (sync_status in ('current', 'stale', 'review_required', 'disconnected')),
  -- IMMUTABLE relationship key (the ON CONFLICT target). All five columns are NOT NULL -> a PLAIN (non-partial) unique constraint.
  constraint daua_edge_key unique (tenant_id, connection_id, provider, directory_application_id, identity_account_id),
  -- same-tenant connection binding (reuses connectors_id_tenant_key, 0017:59).
  constraint daua_connection_same_tenant foreign key (connection_id, tenant_id) references public.connectors (id, tenant_id) on delete cascade,
  -- APPLICATION endpoint: DB-enforces the app belongs to this exact tenant+connection+provider.
  constraint daua_application_fk foreign key (directory_application_id, tenant_id, connection_id, provider)
    references public.directory_applications (id, tenant_id, connection_id, provider) on delete cascade,
  -- IDENTITY endpoint: DB-enforces the identity belongs to this exact tenant+connection+provider (all four cols NOT NULL -> always checked).
  constraint daua_identity_fk foreign key (identity_account_id, tenant_id, connection_id, provider)
    references public.identity_accounts (id, tenant_id, connection_id, provider) on delete cascade
);
create index if not exists daua_connection_idx on public.directory_application_user_assignments (tenant_id, connection_id);
create index if not exists daua_application_idx on public.directory_application_user_assignments (tenant_id, connection_id, directory_application_id);
create index if not exists daua_identity_idx on public.directory_application_user_assignments (tenant_id, connection_id, identity_account_id);
create index if not exists daua_sync_status_idx on public.directory_application_user_assignments (tenant_id, connection_id, sync_status);

alter table public.directory_application_user_assignments enable row level security; -- deny-all to anon/authenticated; only SECURITY DEFINER reads/writes

-- ══ B2. CREATE the canonical provider-neutral GROUP-assignment EDGE (directory_groups <-> directory_applications) ════════════════════
-- Identical shape to B1 with the second endpoint retargeted group->application. A group-to-app grant; NEVER expanded to members.
create table if not exists public.directory_application_group_assignments (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  connection_id uuid not null,
  provider text not null,
  directory_application_id uuid not null,  -- canonical ROW ref = directory_applications.id (resolved from the app external_id at promotion)
  directory_group_id uuid not null,        -- canonical ROW ref = directory_groups.id (resolved from the group external_id at promotion)
  first_seen_at timestamptz,
  last_seen_at timestamptz,
  stale_since timestamptz,
  sync_status text not null default 'current',
  last_discovery_run_id uuid,
  schema_version text,
  sanitizer_version text,
  normalizer_version text,
  source_endpoint text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint daga_sync_status_chk check (sync_status in ('current', 'stale', 'review_required', 'disconnected')),
  -- IMMUTABLE relationship key (the ON CONFLICT target). All five columns are NOT NULL -> a PLAIN (non-partial) unique constraint.
  constraint daga_edge_key unique (tenant_id, connection_id, provider, directory_application_id, directory_group_id),
  constraint daga_connection_same_tenant foreign key (connection_id, tenant_id) references public.connectors (id, tenant_id) on delete cascade,
  -- APPLICATION endpoint: DB-enforces the app belongs to this exact tenant+connection+provider.
  constraint daga_application_fk foreign key (directory_application_id, tenant_id, connection_id, provider)
    references public.directory_applications (id, tenant_id, connection_id, provider) on delete cascade,
  -- GROUP endpoint: DB-enforces the group belongs to this exact tenant+connection+provider (all four cols NOT NULL -> always checked).
  constraint daga_group_fk foreign key (directory_group_id, tenant_id, connection_id, provider)
    references public.directory_groups (id, tenant_id, connection_id, provider) on delete cascade
);
create index if not exists daga_connection_idx on public.directory_application_group_assignments (tenant_id, connection_id);
create index if not exists daga_application_idx on public.directory_application_group_assignments (tenant_id, connection_id, directory_application_id);
create index if not exists daga_group_idx on public.directory_application_group_assignments (tenant_id, connection_id, directory_group_id);
create index if not exists daga_sync_status_idx on public.directory_application_group_assignments (tenant_id, connection_id, sync_status);

alter table public.directory_application_group_assignments enable row level security; -- deny-all to anon/authenticated; only SECURITY DEFINER reads/writes

-- ══ C. least privilege. Both edge tables are runner-internal: reachable ONLY through the 0060 SECURITY DEFINER functions. Deny every
-- request role + the runner direct DML (RLS enabled with no policy; revoke belt-and-suspenders since connector_runner is BYPASSRLS).
-- A future authorized UI assignment-read SELECT policy + grant would be added when a reviewed consumer exists — deferred. ════════════
revoke all on public.directory_application_user_assignments from public, anon, authenticated, connector_runner;
revoke all on public.directory_application_group_assignments from public, anon, authenticated, connector_runner;

commit;
