-- 0020_oauth_pending_replay_store.sql
--
-- PR (gated vault) — the single-use OAuth `oauth_pending` replay store (docs/42 §4/§16/§32.3). It is the
-- remaining hard gate BEFORE any real OAuth token may be stored (docs/42 §32.4 gate 1): the stateless,
-- HMAC-signed `state` from PR F (§31) proves tamper/expiry/binding but CANNOT enforce cross-request
-- single-use on its own — that needs this shared, server-only store.
--
-- This migration creates ONLY the table + its RLS/grant posture. NO EXECUTION PATH, NO consume function,
-- NO server route, NO token exchange, NO credential storage. The Tier-2 secret table `connector_secrets`
-- is NOT touched. **The vault stays NOT usable for real credentials.**
--
-- SAFE-METADATA-ONLY (docs/42 §32.3). This table stores NO secret: no raw nonce (only `nonce_hash` =
-- sha256), no raw `state` payload, no authorization code, no access/refresh token, no API key, no webhook
-- secret, no provider raw payload. `state_jti` is a random non-secret correlation id; `nonce_hash` is a
-- one-way hash. A future server-only consume path (a later gated PR) does the atomic single-use UPDATE.
--
-- POSTURE — near Tier-2 / like `connector_secrets`: RLS-ENABLED with ZERO policies (default deny-all) AND
-- `revoke all` from anon + authenticated (countering the hosted-default grants — the 0015/0016/0017/0018
-- masking lesson). The request path can NEVER read or write `oauth_pending`; only the future connector
-- runner identity / a `SECURITY DEFINER` consume accessor reaches it. `service_role` is never used on a
-- request path. SAME-TENANT integrity via the composite `(connector_id, tenant_id)` FK (the 0005/0017
-- pattern), so a pending row can never bind a cross-tenant connector.
--
-- Migration-safety: only CREATE TABLE + indexes + RLS-enable + a privilege-tightening `revoke all` here —
-- no table teardown, no row purge, no RLS disable. `revoke all` removes hosted-default grants only.

begin;

create table public.oauth_pending (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  organization_id uuid,                                   -- optional; same-tenant connector via composite FK below
  connector_id uuid,                                      -- nullable: a fresh connect has no connector yet (re-auth only)
  provider text not null,
  subject uuid,                                           -- initiating user (auth.uid()); nullable
  state_jti text not null,                                -- random non-secret correlation id embedded in the signed state
  nonce_hash text not null,                               -- sha256(nonce) hex — the RAW nonce is NEVER stored (docs/42 §32.3)
  intent text not null,                                   -- redirect/callback intent (a short safe label)
  expires_at timestamptz not null,                        -- required: short TTL (docs/42 §16); a pending row always expires
  consumed_at timestamptz,                                -- single-use marker (nullable; set by the future server-only consume)
  created_at timestamptz not null default now(),
  attempt_count integer not null default 0,               -- safe counter of rejected callback attempts (no secret)
  last_rejected_code text,                                -- a safe reason CODE only (mirrors PR F's OAuthStateReason); never a secret
  -- Single-use: a state_jti / nonce_hash may exist at most once across the store.
  constraint oauth_pending_state_jti_key unique (state_jti),
  constraint oauth_pending_nonce_hash_key unique (nonce_hash),
  constraint oauth_pending_attempt_nonneg check (attempt_count >= 0),
  constraint oauth_pending_last_rejected_code_check
    check (last_rejected_code is null or last_rejected_code in
      ('missing_state','malformed_state','bad_signature','missing_nonce','expired','replayed',
       'tenant_mismatch','provider_mismatch','connector_mismatch')),
  -- SAME-TENANT integrity (composite FK, MATCH SIMPLE): when connector_id is set it MUST belong to the
  -- same tenant; when null (fresh connect) the FK is skipped. A cross-tenant connector can never bind.
  constraint oauth_pending_connector_same_tenant
    foreign key (connector_id, tenant_id)
    references public.connectors (id, tenant_id) on delete cascade
);

-- Indexes for the FUTURE server-only consume + expiry sweep (not surfaced yet). state_jti/nonce_hash are
-- already indexed by their UNIQUE constraints.
create index oauth_pending_expires_idx     on public.oauth_pending (expires_at);
create index oauth_pending_tenant_conn_idx on public.oauth_pending (tenant_id, connector_id);

-- ── RLS / grants: deny-all, server-only (mirrors connector_secrets, 0017/0018) ───────────────────────
-- RLS-enabled with ZERO policies (default deny-all). NO authenticated read/write policy — the design is
-- server-only, never browser-accessible. There is no SQL a logged-in user can run that reads or writes it.
alter table public.oauth_pending enable row level security;

-- REVOKE the hosted-default grants from BOTH request-path roles. Nothing is granted back. After this,
-- authenticated + anon hold EXACTLY zero privileges on oauth_pending (asserted by org_rls_test.sql T42).
revoke all on public.oauth_pending from anon, authenticated;

commit;
