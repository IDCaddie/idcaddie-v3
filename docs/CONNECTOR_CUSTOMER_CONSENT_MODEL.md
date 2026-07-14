# Connector customer-consent model (P5E14 · Gate S3)

**Canonical source for: the pilot consent record + its enforcement in migration `0047`.** Companion to the
[customer-pilot model](./CONNECTOR_CUSTOMER_PILOT_MODEL.md). Staging only; RISK-007 OPEN; Phase C BLOCKED. Consent gates *whether a
pilot may be approved and may execute* — it is not a checkbox; it is a DB-enforced precondition.

## The consent record (`connector_pilot_consents`)

One or more rows per enrollment (`pilot_enrollment_id` FK, `tenant_id`). Captures: `consent_version`, `consent_scope`,
`consent_purpose`, `approved_permissions` (the exact scope the customer agreed to), `consented_by`, `consented_at`, `expiry_at`
(CHECK `> consented_at`), `withdrawal_at` (nullable), an opaque `evidence_reference` (len `1..256`), and the acknowledgement flags
`data_retention_agreement` / `deletion_agreement` / `incident_contact_ack`. Deny-all (RLS + zero policies + revoke from
anon/authenticated/connector_runner); all writes via `SECURITY DEFINER` admin functions.

## Opaque evidence (no secret can be smuggled in)

`evidence_reference` is an OPAQUE pointer (a ticket id, a signed-agreement hash, a doc reference) — never the agreement itself and
never a credential. `admin_record_pilot_consent` **rejects** any evidence matching a secret/token/ARN/DB-URL/PEM/email shape
(`arn:aws`, `eyj…` JWT, `bearer `, `access_token`, `client_secret`, `postgres(ql)://`, `-----BEGIN`, an `@host.tld` email). This
keeps the audit trail free of secrets and PII while still binding the pilot to durable proof of consent.

## Enforcement (consent is a hard gate, twice)

1. **Approval gate** — `admin_approve_pilot_enrollment` requires an *active* consent for the enrollment: one that exists, is not
   withdrawn, and is not expired, whose `approved_permissions` match the enrollment. No consent (or an expired/withdrawn one) → the
   pilot cannot leave `consent_pending`, so it can never be enabled.
2. **Execution gate** — `runner_assert_pilot_authorized` re-checks, at run time, that an active non-withdrawn non-expired consent
   still exists. A consent that lapses or is withdrawn *after* enable immediately fails the next execution closed.

`admin_withdraw_pilot_consent` sets `withdrawal_at` **and** pauses the pilot in one call — withdrawal is both recorded and
enforced atomically. Consent expiry needs no job to take effect: the execution gate's `expiry_at > now()` predicate is authoritative
(a stale pilot is also swept by `admin_expire_stale_pilots`).

## Runner-side permission/consent validation

The runner's `microsoft-entra-pilot-permission.ts` is the connector-side companion (staging; NO customer token acquired this phase —
validated against synthetic claim fixtures). At the point a customer token would be acquired (future GO), it validates the token
CLAIMS against the enrolled `approved_permissions`: Graph audience, single-tenant `tid` = enrolled tenant, admin consent present
(app roles non-empty), the *exact* approved permission present, and **no unexpected permission** (drift). Any mismatch —
`permission_drift`, `consent_lost`, `unexpected_role`, wrong tenant/audience, expired consent/secret — **blocks + alerts**, returning
only a static reason class (never a claim value). `validatePilotFreshness` fails closed on a malformed/absent/withdrawn/expired
consent or an expired secret.

## What this does NOT do

No customer token is acquired, no consent UI, no email/notification is sent, no production access. Consent is modeled + enforced +
proven (test `PL1`/`PL2`/`PL3`), not exercised against a real customer. Enabling a real pilot requires a separate explicit GO.
