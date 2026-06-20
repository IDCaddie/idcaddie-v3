-- 0017_connector_vault_schema_foundation.sql
--
-- PR A of the accepted connector credential vault gated sequence (docs/42 §20). SCHEMA FOUNDATION ONLY,
-- NO EXECUTION PATH. This creates the conceptual docs/42 §4 tables and their RLS/grant posture — and
-- nothing else. There is NO encryption/decryption wrapper, NO runner, NO provider connector, NO OAuth
-- callback, NO connector UI, NO DAL, NO route, NO service-role path, and NO credential is stored. The
-- vault is NOT usable after this migration: the secret table is unreadable/unwritable from any request
-- path, and the metadata table has only a tenant-member READ policy (no connect/write path yet — that is
-- a later gated PR). **Connector implementation remains blocked. RISK-001 stays OPEN; cutover BLOCKED.**
--
-- TWO-TIER SPLIT (docs/42 §1/§4), the load-bearing decision:
--   * Tier-1 metadata (public.connectors, public.connector_runs): RLS-readable by tenant members, holds
--     NO secret and NO ciphertext. SELECT only — no INSERT/UPDATE/DELETE policy or grant (writes are a
--     future server-only gated PR; the request-path role cannot mutate them).
--   * Tier-2 secret (public.connector_secrets): RLS-enabled with ZERO policies (default deny-all) AND
--     `authenticated`/`anon` are REVOKEd of all privileges. There is NO SQL a logged-in user can run that
--     returns, writes, or deletes a secret. Reached only by a FUTURE server-only wrapper (PR C), never
--     here. ciphertext/dek_wrapped/aead_nonce/aad_digest/key_id columns exist for that future wrapper but
--     stay empty (no credential is stored by this PR).
--
-- AUDIT reuses the existing APPEND-ONLY public.audit_logs (reject_audit_mutation, 0002) per docs/42 §10 —
-- NO separate connector_audit_events table is created (fewer surfaces; the proven append-only guarantee).
--
-- SAME-TENANT INTEGRITY (the 0005 pattern): connector_secrets/connector_runs reference connectors by the
-- COMPOSITE (connector_id, tenant_id) -> connectors(id, tenant_id), so a tenant-B secret/run can NEVER be
-- attached to a tenant-A connector at the constraint layer, not merely hidden by RLS. connectors.org link
-- uses the same-tenant (organization_id, tenant_id) -> organizations(id, tenant_id) (organizations_id_
-- tenant_key from 0005); organization_id is OPTIONAL (per-tenant vs per-org scoping is docs/42 §17 open).
--
-- updated_at: default-only + writer-bumped (the project convention; no moddatetime trigger — files 0012).
-- PRIVILEGE LESSON (0016/T37): the deny-all on connector_secrets is asserted at the PRIVILEGE surface
-- (has_table_privilege) in org_rls_test.sql T39, and test-rls.sh re-asserts the revoke after its blanket
-- grant crutch so the suite reflects the REAL hosted surface (the masking gap 0015/0016 caught).
--
-- check-migration-safety: no DROP TABLE / TRUNCATE / DISABLE RLS. `revoke all` is privilege TIGHTENING.

begin;

-- ── Tier-1 metadata: public.connectors (RLS-readable by tenant members; holds NO secret) ─────────────
create table public.connectors (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  organization_id uuid,                                   -- optional; same-tenant composite FK below
  provider text not null,                                 -- e.g. 'slack' (a label, never a secret)
  display_name text,
  status text not null default 'pending',
  granted_scopes_safe text[],                             -- NON-sensitive scope labels only (docs/42 §12)
  connected_by uuid references public.profiles (id) on delete set null,
  last_sync_at timestamptz,
  health text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint connectors_status_check
    check (status in ('pending','active','error','revoked','disabled')),
  -- same-tenant org link (0005 pattern; organizations_id_tenant_key). NULL org stays valid (MATCH SIMPLE).
  constraint connectors_org_same_tenant
    foreign key (organization_id, tenant_id) references public.organizations (id, tenant_id),
  -- composite key so child tables can bind (connector_id, tenant_id) same-tenant.
  constraint connectors_id_tenant_key unique (id, tenant_id)
);

-- ── Tier-2 secret: public.connector_secrets (NO authenticated path — deny-all, no grant) ─────────────
create table public.connector_secrets (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  connector_id uuid not null,
  secret_kind text not null,
  version integer not null default 1,
  is_active boolean not null default true,
  ciphertext bytea,                                       -- envelope-encrypted blob (future wrapper writes)
  dek_wrapped bytea,                                      -- DEK wrapped by the KMS-held KEK (docs/42 §1.2)
  aead_nonce bytea,
  aad_digest text,                                        -- binds {tenant,connector,kind,version} (docs/42 §4)
  key_id text,                                            -- opaque, non-sensitive KMS key handle
  status text not null default 'active',
  expires_at timestamptz,
  created_at timestamptz not null default now(),
  revoked_at timestamptz,
  constraint connector_secrets_kind_check
    check (secret_kind in ('oauth_access','oauth_refresh','api_key','pat','webhook_signing')),
  constraint connector_secrets_status_check
    check (status in ('active','revoked')),
  constraint connector_secrets_version_pos check (version > 0),
  constraint connector_secrets_connector_same_tenant
    foreign key (connector_id, tenant_id)
    references public.connectors (id, tenant_id) on delete cascade
);

-- ── Tier-1 metadata: public.connector_runs (safe summary only; NO secret) ────────────────────────────
create table public.connector_runs (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  connector_id uuid not null,
  status text not null default 'queued',
  started_at timestamptz,
  finished_at timestamptz,
  items_seen integer,
  error_class text,                                       -- a CLASS, never a raw provider message (docs/42 §9)
  created_at timestamptz not null default now(),
  constraint connector_runs_status_check
    check (status in ('queued','running','success','failed')),
  constraint connector_runs_items_nonneg
    check (items_seen is null or items_seen >= 0),
  constraint connector_runs_connector_same_tenant
    foreign key (connector_id, tenant_id)
    references public.connectors (id, tenant_id) on delete cascade
);

-- ── Tenant-scoped indexes for FUTURE reads/sweeps (not surfaced yet) ─────────────────────────────────
create index connectors_tenant_idx               on public.connectors (tenant_id);
create index connectors_tenant_provider_idx      on public.connectors (tenant_id, provider);
create index connector_secrets_tenant_conn_idx   on public.connector_secrets (tenant_id, connector_id);
create index connector_secrets_conn_kind_idx     on public.connector_secrets (connector_id, secret_kind);
create index connector_runs_tenant_conn_idx      on public.connector_runs (tenant_id, connector_id);
create index connector_runs_tenant_status_idx    on public.connector_runs (tenant_id, status);

-- ── RLS ──────────────────────────────────────────────────────────────────────────────────────────
-- Tier-1: tenant members READ only. No INSERT/UPDATE/DELETE policy (writes are a later server-only PR).
alter table public.connectors enable row level security;
create policy "members read tenant connectors" on public.connectors
for select using (public.is_tenant_member(tenant_id));

alter table public.connector_runs enable row level security;
create policy "members read tenant connector runs" on public.connector_runs
for select using (public.is_tenant_member(tenant_id));

-- Tier-2: RLS enabled with NO policy → default deny-all for every non-bypass role. The future server-only
-- wrapper (PR C) reaches it via a dedicated narrow path, never the request-path role.
alter table public.connector_secrets enable row level security;

-- ── Grants (least privilege) ─────────────────────────────────────────────────────────────────────
-- RLS still filters rows; the base privilege only lets the policy be reached (the 0015 lesson).
grant select on public.connectors     to authenticated;
grant select on public.connector_runs to authenticated;
-- Secret table: explicit deny-all. authenticated/anon hold NO privilege (no SELECT/INSERT/UPDATE/DELETE).
-- This counters any hosted/default grant; the request path can never touch a secret.
-- safety-ack: REVOKE here is privilege TIGHTENING (deny-all on the secret table), not a destructive teardown; reviewed.
revoke all on public.connector_secrets from authenticated, anon;

commit;
