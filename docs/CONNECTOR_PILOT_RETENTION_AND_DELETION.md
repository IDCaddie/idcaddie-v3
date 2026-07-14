# Connector pilot retention & deletion (P5E14 · Gate S3)

**Canonical source for: pilot data retention bounds + the fail-closed, review-gated deletion workflow of migration `0047`.**
Companion to the [customer-pilot model](./CONNECTOR_CUSTOMER_PILOT_MODEL.md). Staging only; RISK-007 OPEN; Phase C BLOCKED. **No real
deletion happens in S3** — this phase models and proves the *plan*, not the act.

## Retention

Each enrollment carries `retention_days` (CHECK `1..90`) — the agreed window for any discovery artifacts a pilot would produce.
The bound is a column CHECK, so no admin function can set a value outside `1..90`. Retention is agreed at consent
(`data_retention_agreement` flag) and bound to the enrollment, so the retention promise is durable and auditable.

## Deletion is planned + approved, NEVER auto-executed

`connector_pilot_deletion_jobs`: one row per deletion request (`pilot_enrollment_id`, `tenant_id`, `scope` CHECK
`run_scoped | customer_scoped`, `job_status` CHECK `requested | approved | rejected | completed` default `requested`,
`requested_by`, `approved_by`, `approved_at`, `sanitized_summary`). Deny-all (RLS + zero policies + revoke from
anon/authenticated/connector_runner).

Two admin functions, both non-executing:
- `admin_create_pilot_deletion_job` → creates a `requested` job. Records intent; deletes nothing.
- `admin_approve_pilot_deletion_job` → moves `requested → approved`. Authorizes a future deletion; **still deletes nothing**.

**No function in `0047` performs a `DELETE` of customer data.** Reaching `completed` (and any actual erasure) is deliberately left to
a separate, explicitly-authorized operation under a future GO — so an approval can never silently destroy data, and every deletion
is two-person-reviewable (requester ≠ approver by procedure) and audit-logged. Test `PL7` proves the `requested → approved` path and
that no auto-execution occurs.

## Incident, exit review, and rollback

- `connector_pilot_incidents` + `admin_pilot_incident_hold`: opening a hold moves the pilot to `incident_hold`, which the execution
  gate treats as not-enabled — execution stops immediately. Summaries are `sanitized_summary` free text (caller-sanitized: no
  PII/token/secret/ARN/DB-URL/raw payload).
- `connector_pilot_exit_reviews` + `admin_record_pilot_exit_review`: the durable pilot outcome (`passed | failed | inconclusive |
  withdrawn`) with a sanitized summary — the audit artifact a pilot decision is based on.
- **Rollback** = `admin_set_pilot_status(…, 'cancelled'|'paused')` and/or the per-pilot kill switch; a paused/incident_hold pilot
  cannot be re-enabled without passing approval + active-consent checks again. All pilot activity can be stopped in one statement
  (kill switch or status change) and the whole lifecycle is reconstructable from these tables.

## What this does NOT do

No real deletion, no retention-sweep job, no production access, no customer data touched. The deletion/retention controls are
modeled + enforced + proven, not executed against real data. Any real erasure requires a separate explicit GO.
