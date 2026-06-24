-- 0030_connector_secret_envelope_columns.sql
--
-- COMPLETE the at-rest encrypted-envelope SHAPE for connector_secrets (docs/42 §77, RISK-007 foundation). #154
-- added the vault save/load boundary, but `connector_secrets` (0017) had columns for only FIVE of the eight
-- `EncryptedConnectorSecret` fields (crypto.ts) — the GCM auth tag and the `v`/`alg` format metadata had NO
-- column, so a real encrypted secret could not be persisted + loaded as a COMPLETE envelope. This adds the
-- three missing columns and extends the runner's COLUMN-scoped grant to cover them — and NOTHING else.
--
-- THE EncryptedConnectorSecret -> connector_secrets MAPPING (now complete):
--   ciphertext  -> ciphertext (0017)      wrappedDek -> dek_wrapped (0017)    iv  -> aead_nonce (0017)
--   aadDigest   -> aad_digest (0017)      kekId      -> key_id (0017)
--   tag         -> aead_tag         (NEW: the 16-byte GCM auth tag — REQUIRED to decrypt)
--   v           -> envelope_version (NEW: the payload format version, e.g. 1)
--   alg         -> aead_alg         (NEW: the AEAD algorithm label, e.g. 'AES-256-GCM')
--
-- NON-DESTRUCTIVE / DEFAULT-SAFE. The three columns are NULLABLE (no default) — any existing row (only test/
-- synthetic rows exist; no real secret has ever been stored — #155/#156 verified the grant surface, they did
-- NOT write a secret) stays valid with NULLs. CHECK constraints are scoped so a NULL always passes: a future
-- secret either sets a complete envelope or leaves these NULL. No column is dropped, renamed, or retyped.
--
-- RUNNER GRANT: column-scoped only (the #154 correction). REVOKE ALL then re-GRANT the SELECT/INSERT COLUMN
-- sets EXTENDED with the three new columns — NO table-level SELECT/INSERT, NO UPDATE/DELETE/TRUNCATE/REFERENCES/
-- TRIGGER. authenticated/anon keep EXACTLY zero privilege (re-asserted). No policy is added; connector_secrets
-- stays RLS-enabled with zero policies. T50 asserts the exact post-0030 column grants.
--
-- This completes the SCHEMA SHAPE for encrypted-envelope persistence ONLY. It does NOT add a real KMS client,
-- hosted KMS/IAM grant separation, audit, rotation/revocation, a service-role path, live provider token
-- storage, or any request-path access. RISK-007 stays OPEN; cutover stays BLOCKED.
--
-- check-migration-safety: only ADD COLUMN (additive) + GRANT + a privilege-tightening `revoke all` — no table
-- teardown, no row purge, no RLS disable. Generated types DO change (new columns) — regenerated in this PR.

begin;

-- The three missing envelope columns (nullable; narrow CHECKs that a NULL always passes).
alter table public.connector_secrets
  add column if not exists aead_tag bytea,
  add column if not exists envelope_version smallint,
  add column if not exists aead_alg text;

-- Defense-in-depth integrity (NULL-permissive so existing rows pass): the GCM tag is exactly 16 bytes; the
-- format version is positive; the algorithm is the one supported AEAD label.
alter table public.connector_secrets
  add constraint connector_secrets_aead_tag_len_check
    check (aead_tag is null or octet_length(aead_tag) = 16),
  add constraint connector_secrets_envelope_version_check
    check (envelope_version is null or envelope_version >= 1),
  add constraint connector_secrets_aead_alg_check
    check (aead_alg is null or aead_alg = 'AES-256-GCM');

-- Runner grant: column-scoped, extended with the three new envelope columns (the #154 column-scoped posture).
revoke all on public.connector_secrets from connector_runner;
-- LOAD/DECRYPT (runner-only): identity/query + active/expiry + the COMPLETE encrypted envelope columns.
grant select (id, tenant_id, connector_id, secret_kind, version, status, expires_at,
              ciphertext, dek_wrapped, aead_nonce, aad_digest, key_id, aead_tag, envelope_version, aead_alg)
  on public.connector_secrets to connector_runner;
-- SAVE (runner-backed): identity/write + the COMPLETE encrypted envelope columns (id/is_active/status default).
grant insert (tenant_id, connector_id, secret_kind, version,
              ciphertext, dek_wrapped, aead_nonce, aad_digest, key_id, aead_tag, envelope_version, aead_alg)
  on public.connector_secrets to connector_runner;
-- NO table-level select/insert, NO update, NO delete, NO truncate, NO references, NO trigger for the runner.

-- Re-assert the request-path deny-all defensively (idempotent; the 0017/0021/0029 pattern). anon/authenticated
-- hold ZERO privilege on connector_secrets; NO policy is added.
-- safety-ack: REVOKE here is privilege TIGHTENING (deny-all on the secret table), not a destructive teardown; reviewed.
revoke all on public.connector_secrets from anon, authenticated;

commit;
