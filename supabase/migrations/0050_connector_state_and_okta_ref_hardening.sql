-- 0050_connector_state_and_okta_ref_hardening.sql
--
-- Defense-in-depth hardening from the API Services config-lifecycle adversarial review (all P2, applied proactively):
--
-- (a) DB-ENFORCE THE PHASE CEILING. 0049's connection_state CHECK allowed the full future vocabulary
--     (configured|verification_pending|verified|connected_unsynced|sync_authorized). Only `configured`/`verification_pending` are
--     reachable in this API Services config phase (no token mint / no verification). Narrow the CHECK so the DB itself rejects any
--     write to a post-verification ("connected") state — the later GO-gated migration that first persists each higher state widens
--     the allowlist then. This makes "max = verification_pending" a schema invariant, not just operator discipline.
--
-- (b) PIN THE OKTA CREDENTIAL-REFERENCE NAMESPACE. 0043 stores credential_secret_ref with only a length CHECK. Add a
--     provider-conditional CHECK so an okta reference MUST point into the pinned staging okta Secrets Manager namespace/account —
--     an errant service_role write cannot aim the runner at an arbitrary ARN. Non-okta providers are unaffected.
--
-- NON-DESTRUCTIVE: only CHECK constraints (existing rows: connection_state is null or 'verification_pending' → pass; the one okta
-- reference already targets the pinned namespace → passes). No data/status change, no new grant, activates nothing. Okta stays
-- certificationOnly; RISK-007 OPEN; Phase C BLOCKED.

begin;

-- (a)
alter table public.connectors drop constraint if exists connectors_connection_state_chk;
alter table public.connectors add constraint connectors_connection_state_chk
  check (connection_state is null or connection_state in ('configured', 'verification_pending'));

-- (b)
alter table public.connector_credential_references drop constraint if exists connector_cred_ref_okta_namespace_chk;
alter table public.connector_credential_references add constraint connector_cred_ref_okta_namespace_chk
  check (
    provider <> 'okta'
    or credential_secret_ref like 'arn:aws:secretsmanager:%:833822972703:secret:/idcaddie/staging/connector/okta/%'
  );

commit;
