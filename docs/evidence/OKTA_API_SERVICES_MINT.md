# Okta API Services — bounded staging verification (mint) evidence

**Context:** the single authorized bounded Okta `client_credentials` verification for staging org A1 Procurement. The runner mints
exactly ONE token in the Fargate task (task role `idcaddie-staging-slack-taskread`), validates it, discards it, and — on success
only — the connection advances `verification_pending → verified`. No Okta Management API, no sync, no scheduling, no
`FRAMEWORK_REGISTRY` registration. Okta stays `certificationOnly`; RISK-007 OPEN; Phase C BLOCKED.

## Migration
- **`0051_connector_connection_state_verified.sql`** — widens the provider-neutral `connectors.connection_state` CHECK to allow
  `verified` (0050 allowed only `configured|verification_pending`). Non-destructive superset. `status` stays `pending`,
  `last_sync_at` stays null; the further states (`connected_unsynced`, `sync_authorized`) remain disallowed here (later GO-gated
  migrations). Validated: `check-migration-safety` + the RLS harness green before hosted apply.

## Hosted verification (redacted evidence — filled at run time)
- timestamp: _(recorded at run)_
- result: _(success / failure)_
- sanitized classification: _(on failure only, {failureClass, code})_
- issuer: `https://trial-5294016.okta.com`
- client ID suffix: `…Ea698` (the API Services client `0oa…Ea698`)
- granted scope: `okta.users.read`
- expires_in: _(recorded on success)_
- lifecycle transition: `verification_pending → verified` (success) / stays `verification_pending` (failure)
- token discarded: yes (never persisted/returned; runner memory only)

Never recorded: private key, secret value, assertion, access token, raw response, error_description.
