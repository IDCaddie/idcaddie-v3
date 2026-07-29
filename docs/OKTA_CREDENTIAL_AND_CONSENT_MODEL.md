# Okta credential & consent model (P5E16)

**Canonical source for: the Okta credential METADATA + the future consent model.** Companion to the
[Okta connector model](./OKTA_CONNECTOR_MODEL.md). **Certification-only + synthetic.** No real credential is created or read this
phase; NO private key, API token, or OAuth token is stored or handled. `certificationOnly`; RISK-007 OPEN; Phase C BLOCKED.

## Credential model (metadata only — the raw material is never in the repo or in a result)

A future Okta connection is described by server-owned METADATA (`OktaCredentialMetadata`, `okta-auth.ts`): the Okta org host
reference, the authorization-server/issuer reference, the OAuth service-app client reference (opaque `0oa…`, not a secret), the
signing-key reference + version, the approved scopes, the credential type, and the owning tenant + connector. **Never stored in the
repo or returned by any function:** the private key, the API token, an OAuth access token, or a full secret value.

Two supported credential TYPES (preferred first):
- **`oauth_private_key_jwt`** — OAuth 2.0 client-credentials with a JWT client assertion signed by a server-held private key. The
  preferred, future-safe path: rotatable, revocable, per-org admin-consented, least-privilege scoped, no long-lived shared token.
- **`api_token`** (legacy SSWS) — modeled for completeness; NOT preferred (a long-lived static super-secret, coarse privilege, no
  scoping). Sent directly as an `SSWS` header at request time; no OAuth acquisition.

The secret DOCUMENT (a future AWS Secrets Manager value) is parsed by `okta-secret.ts` into non-sensitive METADATA only — the
`private_key` / `api_token` field is validated for presence + shape via a BOOLEAN and **never returned or retained** (leakage
defense). The secret ARN is pinned to `arn:…:secretsmanager:ca-central-1:833822972703:secret:/idcaddie/staging/connector/okta/…`
(staging only; no production account, no wildcard, no cross-region/service, no traversal, distinct from the Entra namespace).

## Ownership + isolation

The credential reference + org host are SERVER-DERIVED from an ownership-validated connection (`okta-connection.ts`): the resolver
requires exactly one owned, active, non-revoked, non-deleted row whose org/connection/provider/version MATCH the expected
server-derived identity — so a caller can never inject an ARN/host/issuer/org, a resolver can never substitute another tenant's
connection, an Okta credential can never authorize Entra/Slack (provider pinned `okta`), and a credential is never reused across
tenants. The token cache is keyed by the validated `(org, connection, provider="okta", version)` tuple — no cross-tenant or
cross-provider bleed.

## Future consent model (documented; nothing collected this phase)

A future Okta customer pilot reuses the P5E14/P5E15 provider-neutral customer-pilot control plane (migration `0047`) — the SAME
enrollment/consent/incident/exit/deletion tables, approval-before-enable, kill switches, discovery-only, and per-run authorization,
with `provider = okta`. Consent evidence stays an OPAQUE reference (no PII, no signed document in the DB). The customer explicitly
agrees to: staging-only processing; read-only user discovery; the exact approved scope set (`okta.users.read`, `okta.groups.read`, `okta.apps.read` — all read-only); no promotion; no
scheduling; bounded runs/records; a retention period + deletion process; incident notification; immediate withdrawal + pause; no
production. **No Okta customer, credential, or consent exists this phase.** Enabling one is a separate explicit GO.
