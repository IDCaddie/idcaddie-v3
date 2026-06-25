-- 0035_connector_app_secrets.sql
--
-- B2c-secret (docs/42 §90.3): the VAULT-GRADE store for the Slack OAuth CLIENT SECRET — the OAuth master credential.
-- It is APP-SCOPED (one per Slack app), NOT tenant-scoped, so it does NOT belong in `connector_secrets` (per-tenant)
-- and is NEVER bound to a tenant_id or protected by tenant RLS. This creates a dedicated, append-only/versioned
-- app-level table holding ONLY the AES-256-GCM envelope (ciphertext + wrapped DEK + metadata) — NEVER plaintext —
-- with the SAME runner-only `kms:Decrypt`/`SET ROLE connector_runner` access boundary as the bot-token vault.
--
-- SCOPE: synthetic only. NO real client secret, NO real token, NO Slack API call, NO production callback route, NO
-- live connector, NO request-path decrypt, NO production enablement. RISK-001 / RISK-007 remain OPEN.
--
-- check-migration-safety: only CREATE TABLE + GRANT + privilege-tightening REVOKE — no table teardown, no row purge,
-- no RLS disable on an existing table. The new table reflects into database.types.ts (it is a real table).

create table public.connector_app_secrets (
  id uuid primary key default gen_random_uuid(),
  -- APP-SCOPE identity (replaces tenant_id). The AAD binds all four — a staging ciphertext cannot decrypt as
  -- production, and a wrong provider/kind/version fails closed.
  app_env text not null,
  provider text not null,
  secret_kind text not null,
  version integer not null,
  -- AES-256-GCM envelope (the SAME scheme as connector_secrets; NEVER plaintext).
  ciphertext bytea not null,
  dek_wrapped bytea not null,        -- DEK wrapped by the KMS-held KEK
  aead_nonce bytea not null,         -- 12-byte GCM nonce (iv)
  aead_tag bytea not null,           -- 16-byte GCM auth tag
  aad_digest text not null,          -- sha256(canonical app-scope AAD) — non-authoritative convenience
  kek_id text not null,              -- which KEK wrapped the DEK (non-sensitive handle)
  envelope_version integer not null, -- payload format version
  aead_alg text not null,            -- 'AES-256-GCM'
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  constraint connector_app_secrets_provider_chk check (provider = 'slack'),
  constraint connector_app_secrets_kind_chk check (secret_kind = 'oauth_client_secret'),
  constraint connector_app_secrets_env_chk check (app_env in ('staging', 'production')),
  constraint connector_app_secrets_version_pos check (version > 0),
  constraint connector_app_secrets_alg_chk check (aead_alg = 'AES-256-GCM'),
  -- append-only/versioned: one row per (app, provider, kind, version).
  constraint connector_app_secrets_identity_key unique (app_env, provider, secret_kind, version)
);
create index connector_app_secrets_active_idx on public.connector_app_secrets (app_env, provider, secret_kind, version desc);

-- ── RLS: DENY-ALL to the request path. No tenant predicate exists (this is app-scoped) — and no policy is added, so
--    even a stray base privilege reaches ZERO rows. Only the BYPASSRLS `connector_runner` (below) can read it.
alter table public.connector_app_secrets enable row level security;
-- safety-ack: REVOKE here is privilege TIGHTENING (deny-all on an app-master-credential table), not a destructive
-- teardown; reviewed. anon/authenticated hold ZERO privilege; NO SELECT/INSERT/UPDATE/DELETE, NO policy.
revoke all on public.connector_app_secrets from anon, authenticated;

-- ── Runner grant (least privilege): the SAME `connector_runner` principal (NOLOGIN BYPASSRLS, reached only from
--    server-only runner code under SET ROLE) gets ONLY the column-scoped envelope access the store boundary uses.
revoke all on public.connector_app_secrets from connector_runner;
-- LOAD/DECRYPT (runner-only): identity/query + active filter + the encrypted envelope columns.
grant select (id, app_env, provider, secret_kind, version, is_active,
              ciphertext, dek_wrapped, aead_nonce, aead_tag, aad_digest, kek_id, envelope_version, aead_alg)
  on public.connector_app_secrets to connector_runner;
-- SAVE (runner-backed): identity/write + the encrypted envelope columns (id/is_active/created_at default).
grant insert (app_env, provider, secret_kind, version,
              ciphertext, dek_wrapped, aead_nonce, aead_tag, aad_digest, kek_id, envelope_version, aead_alg)
  on public.connector_app_secrets to connector_runner;
-- NO table-level select/insert, NO update, NO delete, NO truncate, NO references, NO trigger for the runner.
