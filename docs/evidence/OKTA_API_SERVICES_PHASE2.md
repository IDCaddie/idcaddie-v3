# Okta API Services — Phase 2 config lifecycle (evidence)

**Status: the Okta API Services connection is CONFIGURED and persisted at the maximum state `verification_pending` for one staging
organization (A1 Procurement).** No token was minted, no key was signed, no Okta API was called, no secret value was read. The
durable credential is the signing key in AWS Secrets Manager (runner-read); the app DB stores only a NON-SECRET reference pointer.
Date 2026-07-20. Staging Supabase `ycdpzduxugdsffjqyoai`, AWS `833822972703` / `ca-central-1`.

## Operator inputs (this session's record)
API Services app · Client Credentials · private_key_jwt · client id `0oa15fcokefFqDREa698` · issuer `https://trial-5294016.okta.com`.
A fresh keypair was generated; the private key (PKCS#8 PEM) was placed by the operator into the existing secret; the old Web App is
retired. **The secret value was not retrieved or inspected** (metadata only: a fresh AWSCURRENT version exists, last changed
2026-07-20T21:34).

## Code (PR)
- **Migration `0049_connector_connection_state.sql`** — adds a NULLABLE, provider-neutral `connection_state` column to
  `public.connectors` (CHECK: `configured|verification_pending|verified|connected_unsynced|sync_authorized`). Non-destructive; no
  new grant; the runner's column-scoped SELECT is NOT widened. Validated: `check-migration-safety` + the RLS harness (all
  migrations on throwaway Postgres) green before hosted apply. Applied to staging (only `0049` pending; ref confirmed).
- **`okta-config-gate.ts`** — the configuration-only gate. Permits ONLY non-secret config persistence for staging + okta +
  approved org (A1) + approved issuer + exact `okta.users.read` + admin. `oktaConfigGatePermitsExecution()` is **always false** —
  it never authorizes token minting, private_key_jwt signing, Okta API calls, sync, scheduling, or first-sync. Tested (15 cases).

## Hosted config persisted (staging, service_role path; redacted)
- **Issuer binding** (A1 Procurement): provider `okta`, host `trial-5294016.okta.com`, issuer `https://trial-5294016.okta.com`,
  environment `staging`, lifecycle `certification_only`, scope `okta.users.read`, active. No secret fields.
- **Connector** (A1, okta): `status=pending`, **`connection_state=verification_pending`**, `granted_scopes_safe={okta.users.read}`,
  `last_sync_at=NULL`. Never `active`/`connected`.
- **Credential reference**: points at the pinned `/idcaddie/staging/connector/okta/…` Secrets Manager ARN + the current version.
  Stores a POINTER only — verified `no_secret_material=true` (no PEM/token/okta_domain in the row).

## Security / isolation verified
- `connector_credential_references`: RLS on, **0 request-path policies → deny-all** to anon/authenticated; only the runner's
  column-scoped SELECT + service_role can resolve it. The full ARN is never exposed to a request role.
- `connector_okta_issuer_bindings`: 1 policy — org-managers read only their own org's binding (no cross-org listing).
- Tenant isolation via composite same-tenant FKs (`(organization_id, tenant_id)`, `(connector_id, tenant_id)`); the secret
  namespace is pinned (runner ARN regex). No production identifiers.

## Blocked (unchanged)
Token minting · private_key_jwt signing · Okta API calls · connector sync · scheduling · first-sync authorization · Phase C
execution · production · other organizations. Okta `certificationOnly`; RISK-007 OPEN; Phase C BLOCKED.

## Safety
No secret value retrieved; secret contents not inspected; no private key printed; no assertion signed; no token acquired; no Okta
API call; no sync; no schedule; no production access.
