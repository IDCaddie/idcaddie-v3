-- 0029_connector_runner_secret_grants.sql
--
-- The CONNECTOR_SECRETS storage grant for the runner — the narrowly-scoped privilege `0021` explicitly
-- DEFERRED ("the runner gets NO grant on connector_secrets; secret read/write is a later, separately-reviewed
-- PR — tombstone/version, never a row delete"). This is that PR (docs/42 §76, RISK-007 foundation). It grants
-- the existing dedicated `connector_runner` principal ONLY the COLUMN-SCOPED access the vault save/load boundary
-- needs — NOT table-level.
--
-- WHY COLUMN-SCOPED (not table-level). `connector_runner` is BYPASSRLS, so a table-level SELECT/INSERT would let
-- it read/write EVERY column of EVERY row — including columns added by FUTURE migrations — with no row filter.
-- That is too broad. Instead the grant is pinned to the EXACT columns the vault store interface uses, bound to
-- the actual `0017` schema and `secret-vault.ts` (`insertEncryptedSecret`/`findEncryptedSecret`) + the
-- `crypto.ts` `EncryptedConnectorSecret` envelope:
--   EncryptedConnectorSecret.ciphertext -> ciphertext ; .wrappedDek -> dek_wrapped ; .iv -> aead_nonce ;
--   .aadDigest -> aad_digest ; .kekId -> key_id .
--
--   * SELECT (load/decrypt one ACTIVE, non-expired secret): the identity/query columns (id, tenant_id,
--     connector_id, secret_kind, version), the active/expiry filter (status, expires_at), and the envelope
--     columns to decrypt (ciphertext, dek_wrapped, aead_nonce, aad_digest, key_id).
--   * INSERT (save a new encrypted secret): the identity/write columns (tenant_id, connector_id, secret_kind,
--     version) and the envelope columns (ciphertext, dek_wrapped, aead_nonce, aad_digest, key_id). `id` /
--     `is_active` / `status` / `created_at` are NOT granted — they fall to their column defaults.
--
-- DELIBERATELY NOT GRANTED (remaining RISK-007 work, documented): NO UPDATE, NO DELETE (revocation / rotation /
-- tombstone is a separately-designed, separately-tested path). NO TRUNCATE, NO REFERENCES, NO TRIGGER. NO
-- table-level SELECT/INSERT. NO grant on the non-envelope columns (is_active, created_at, revoked_at) or on `id`
-- for INSERT.
--
-- DOCUMENTED SCHEMA GAP (not fixed here). `crypto.ts`'s `EncryptedConnectorSecret` also carries the GCM auth
-- `tag` and the `v`/`alg` format metadata, but `connector_secrets` (0017) has NO column for them — so a real
-- secret cannot yet be stored and round-tripped end to end. Adding the at-rest tag/format columns (and granting
-- them) is a later schema PR and part of remaining RISK-007 work; this PR grants only columns that exist.
--
-- THE REQUEST-PATH DENY-ALL IS PRESERVED, NOT WEAKENED. `connector_secrets` stays RLS-enabled with ZERO
-- policies; `authenticated`/`anon` keep EXACTLY zero privilege (re-asserted below). No browser role gains any
-- privilege; no policy is added. The only principal that can touch the secret table remains a NOLOGIN,
-- BYPASSRLS server role reached solely from server-only runner code under `SET ROLE connector_runner` — never a
-- request/browser path, never the broad service_role. T50 asserts the exact column-level grant from the catalog.
--
-- This migration stores NO credential, wires NO live provider, exchanges NO OAuth code, and adds NO route/UI.
--
-- check-migration-safety: only GRANT + a privilege-tightening `revoke all` — no table teardown, no row purge,
-- no RLS disable. Generated types are unaffected (grants are not columns).

begin;

-- Defensive least-privilege (the 0017/0018/0021 revoke-then-grant-narrow lesson): clear any privilege the runner
-- may hold on the secret table, then grant ONLY the exact columns the vault save/load boundary uses.
revoke all on public.connector_secrets from connector_runner;

-- LOAD/DECRYPT (runner-only): identity/query + active/expiry filter + the encrypted envelope columns.
grant select (id, tenant_id, connector_id, secret_kind, version, status, expires_at,
              ciphertext, dek_wrapped, aead_nonce, aad_digest, key_id)
  on public.connector_secrets to connector_runner;

-- SAVE (runner-backed): identity/write + the encrypted envelope columns (id/is_active/status/created_at default).
grant insert (tenant_id, connector_id, secret_kind, version,
              ciphertext, dek_wrapped, aead_nonce, aad_digest, key_id)
  on public.connector_secrets to connector_runner;
-- NO table-level select/insert, NO update, NO delete, NO truncate, NO references, NO trigger for the runner.

-- Re-assert the request-path deny-all defensively (idempotent; counters any hosted-default grant — the
-- 0017/0021 pattern). anon/authenticated hold ZERO privilege on connector_secrets; NO policy is added.
-- safety-ack: REVOKE here is privilege TIGHTENING (deny-all on the secret table), not a destructive teardown; reviewed.
revoke all on public.connector_secrets from anon, authenticated;

commit;
