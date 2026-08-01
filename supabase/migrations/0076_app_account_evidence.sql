-- 0076_app_account_evidence.sql
--
-- Phase 8 — canonical persistence for SaaS APP-ACCOUNT evidence, and per-capability freshness.
--
-- The gap this closes: the connector framework already emits `app_user_account` and `group` facts (the Slack manifest declares
-- users.list → app_user_account and usergroups.list → group; the Okta and Entra normalizers emit the same shapes), the generic
-- executor already runs them with cursor pagination, rate limits and budgets — and the sink is IN-MEMORY. There is nowhere for a
-- SaaS account to land, so no amount of Slack work could reach a product surface.
--
-- PROVIDER-AGNOSTIC ON PURPOSE. Slack-specific tables would defeat the point of Phase 7B: a new connector should light up every
-- compatible surface without new schema. These tables are keyed on connector + provider, and the Slack columns are the generic
-- ones the manifest already field-maps to.
--
-- SLACK IS NOT AN IDENTITY PROVIDER. Nothing here writes to `identity_accounts`, and there is no foreign key that would let it.
-- A Slack member is an APP ACCOUNT — evidence that somebody has access to a SaaS application. It may LATER match an identity, as
-- a recorded judgement with confidence (mirroring 0075's application matching); it never becomes one.
--
-- Bots and service accounts get their own `account_kind`. Forcing them into a human category is how a workspace of 40 people
-- reports 55 "users", and how a bot ends up in an access review.
--
-- Staging only. Additive: three tables, no change to any existing model.

-- ══ 1. APP ACCOUNTS ══════════════════════════════════════════════════════════════════════════════════════════════════════
create table if not exists public.app_accounts (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  connection_id uuid not null references public.connectors (id) on delete cascade,
  provider text not null,

  -- The provider's own id for the account. Never displayed; the unique key that makes upserts idempotent.
  external_id text not null,
  -- The workspace / tenant / instance WITHIN the provider. One connector reads one workspace, but recording it makes a
  -- cross-workspace bug visible instead of silent.
  workspace_external_id text,

  display_name text,
  email text,
  normalized_email text,

  -- What KIND of account this is. `unknown` is a real answer for a provider that does not say.
  account_kind text not null default 'unknown',
  constraint app_accounts_kind_chk check (account_kind in ('human', 'bot', 'service', 'unknown')),

  -- Provider-side status, bucketed. The RAW provider status is deliberately NOT stored: Okta taught us that an unbucketed
  -- lifecycle token (PROVISIONED, PASSWORD_EXPIRED) reaches a customer with no label map and no bounded vocabulary.
  account_status text not null default 'unknown',
  constraint app_accounts_status_chk check (account_status in ('active', 'inactive', 'deleted', 'unknown')),
  is_admin boolean,

  -- Evidence freshness, identical in meaning to the directory model (0053) so one vocabulary covers the whole product.
  sync_status text not null default 'current',
  constraint app_accounts_sync_status_chk check (sync_status in ('current', 'stale', 'review_required', 'disconnected')),
  stale_since timestamptz,
  -- Phase 2.1's invariant, applied from the start rather than retrofitted: a current row carries no stale timestamp.
  constraint app_accounts_current_no_stale_since_chk check (sync_status <> 'current' or stale_since is null),

  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  last_discovery_run_id uuid,
  schema_version text, sanitizer_version text, normalizer_version text, source_endpoint text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- One account per (connector, provider, external id). Connector-scoped, so two workspaces never collide.
  constraint app_accounts_identity_key unique (tenant_id, connection_id, provider, external_id),
  constraint app_accounts_id_tenant_key unique (id, tenant_id),
  constraint app_accounts_endpoint_key unique (id, tenant_id, connection_id, provider)
);
comment on column public.app_accounts.email is
  'Provider-observed email, stored only where the scope granting it was justified. It is the ONLY viable match key to an identity; display names are never used because two people share a name and one person changes theirs.';

create index if not exists app_accounts_connection_idx on public.app_accounts (tenant_id, connection_id, sync_status);
create index if not exists app_accounts_match_idx on public.app_accounts (tenant_id, normalized_email) where normalized_email is not null;

-- ══ 2. APP ACCOUNT GROUPS + MEMBERSHIPS ══════════════════════════════════════════════════════════════════════════════════
create table if not exists public.app_account_groups (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  connection_id uuid not null references public.connectors (id) on delete cascade,
  provider text not null,
  external_id text not null,
  workspace_external_id text,
  name text, handle text, description text,
  member_count integer,
  is_active boolean,
  sync_status text not null default 'current',
  constraint app_account_groups_sync_status_chk check (sync_status in ('current', 'stale', 'review_required', 'disconnected')),
  stale_since timestamptz,
  constraint app_account_groups_current_no_stale_since_chk check (sync_status <> 'current' or stale_since is null),
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  last_discovery_run_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint app_account_groups_identity_key unique (tenant_id, connection_id, provider, external_id),
  constraint app_account_groups_endpoint_key unique (id, tenant_id, connection_id, provider)
);

create table if not exists public.app_account_group_memberships (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  connection_id uuid not null references public.connectors (id) on delete cascade,
  provider text not null,
  app_account_group_id uuid not null,
  app_account_id uuid not null,
  sync_status text not null default 'current',
  constraint aagm_sync_status_chk check (sync_status in ('current', 'stale', 'review_required', 'disconnected')),
  stale_since timestamptz,
  constraint aagm_current_no_stale_since_chk check (sync_status <> 'current' or stale_since is null),
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  last_discovery_run_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint aagm_edge_key unique (tenant_id, connection_id, provider, app_account_group_id, app_account_id),
  -- COMPOSITE endpoint FKs, the pattern proven in 0056/0059 and defended in 0072: an edge can only ever reference rows from its
  -- OWN connector, so two workspaces cannot bleed into one another even if a writer gets it wrong.
  constraint aagm_group_fk foreign key (app_account_group_id, tenant_id, connection_id, provider)
    references public.app_account_groups (id, tenant_id, connection_id, provider) on delete cascade,
  constraint aagm_account_fk foreign key (app_account_id, tenant_id, connection_id, provider)
    references public.app_accounts (id, tenant_id, connection_id, provider) on delete cascade
);

-- ══ 3. IDENTITY MATCHING — a judgement, never a merge ════════════════════════════════════════════════════════════════════
-- Mirrors 0075's application matching exactly. An app account may MATCH an identity; it never becomes one.
create table if not exists public.app_account_identity_matches (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  app_account_id uuid not null,
  identity_account_id uuid not null references public.identity_accounts (id) on delete cascade,

  -- `normalized_email` is the ONLY automated method. There is deliberately no display-name method: two people share a name, one
  -- person changes theirs, and a wrong match here attributes someone else's access to a person in a review.
  method text not null,
  constraint aaim_method_chk check (method in ('manual', 'normalized_email')),
  confidence text not null,
  constraint aaim_confidence_chk check (confidence in ('high', 'medium', 'low')),
  status text not null default 'proposed',
  constraint aaim_status_chk check (status in ('proposed', 'accepted', 'rejected')),
  rationale text,
  decided_by uuid references auth.users (id),
  decided_at timestamptz,
  constraint aaim_decided_chk check (
    (status = 'proposed' and decided_at is null) or (status in ('accepted', 'rejected') and decided_at is not null)),
  created_at timestamptz not null default now(),
  constraint aaim_account_fk foreign key (app_account_id, tenant_id)
    references public.app_accounts (id, tenant_id) on delete cascade
);
-- One accepted identity per app account. NOT unique on the identity side: one person legitimately holds accounts in many
-- applications, and in more than one workspace of the same application.
create unique index if not exists aaim_one_accepted_idx
  on public.app_account_identity_matches (tenant_id, app_account_id) where status = 'accepted';

-- ══ 4. CAPABILITY FRESHNESS ══════════════════════════════════════════════════════════════════════════════════════════════
-- What each connector last proved it could read, and when. This is what lets the Phase-7B capability model report `available`
-- from evidence instead of from a hardcoded matrix — and lets a plan-limited or permission-denied capability be recorded as
-- exactly that rather than failing the whole connector.
create table if not exists public.connector_capability_state (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  connection_id uuid not null references public.connectors (id) on delete cascade,
  capability text not null,

  state text not null,
  constraint ccs_state_chk check (state in ('available', 'incomplete', 'failed', 'plan_dependent', 'permission_dependent', 'unavailable')),
  -- A capability the workspace's PLAN or the granted SCOPES do not allow is not a connector failure. Recording it distinctly is
  -- what stops one unavailable endpoint marking an otherwise-healthy connector as broken.
  reason_code text,
  last_success_at timestamptz,
  last_attempt_at timestamptz,
  last_run_id uuid,
  observed_count integer,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint ccs_key unique (tenant_id, connection_id, capability)
);

-- ══ 5. LEAST PRIVILEGE ═══════════════════════════════════════════════════════════════════════════════════════════════════
-- RLS on, NO policy: every read goes through a product RPC or not at all, exactly as the directory tables do. The runner writes
-- through SECURITY DEFINER promote RPCs (a later step), never directly — so it gets no grant here either.
alter table public.app_accounts enable row level security;
alter table public.app_account_groups enable row level security;
alter table public.app_account_group_memberships enable row level security;
alter table public.app_account_identity_matches enable row level security;
alter table public.connector_capability_state enable row level security;

revoke all on public.app_accounts from public, anon, authenticated, connector_runner;
revoke all on public.app_account_groups from public, anon, authenticated, connector_runner;
revoke all on public.app_account_group_memberships from public, anon, authenticated, connector_runner;
revoke all on public.app_account_identity_matches from public, anon, authenticated, connector_runner;
revoke all on public.connector_capability_state from public, anon, authenticated, connector_runner;
