# Connector customer-pilot model (P5E14 · Gate S3)

**Canonical source for: the provider-neutral customer-pilot control plane of migration `0047`.** Extends the
[authorization model](./CONNECTOR_RUN_AUTHORIZATION_MODEL.md), [locking/idempotency](./CONNECTOR_RUN_LOCKING_AND_IDEMPOTENCY.md), and
[schedule-policy model](./CONNECTOR_SCHEDULE_POLICY_MODEL.md). See also the [consent model](./CONNECTOR_CUSTOMER_CONSENT_MODEL.md)
and [retention & deletion](./CONNECTOR_PILOT_RETENTION_AND_DELETION.md). Staging only; `certificationOnly` unchanged; RISK-007 OPEN;
Phase C BLOCKED. **Activates nothing by itself** — it makes ONE controlled customer pilot *authorizable*, not *active*.

## Purpose

Answer, provably, before any real customer pilot is authorized: (1) can ONE customer tenant enroll without weakening isolation?
(2) are consent/scope/retention/ownership/deletion/incident/rollback controls durable and DB-enforced? (3) can the connector execute
*only* for an explicitly approved pilot tenant, discovery-only, promotion-disabled? (4) can all pilot activity be stopped
immediately and audited? The whole plane is deny-all + fail-closed: nothing runs unless every condition holds.

## Enrollment (`connector_pilot_enrollments`)

One row per pilot, per `(tenant, connector, provider)`. Binds: `environment` (CHECK `= 'staging'`), `is_synthetic` (default false),
`customer_account_reference` (opaque; CHECK required when `is_synthetic=false`), `pilot_status`, ownership (`requested_by`,
`approved_by`, `support_owner`, `incident_owner`), `data_processing_purpose`, `approved_permissions`, `credential_version`,
`schema_version`, `retention_days` (CHECK `1..90`), window (`pilot_start_at`/`pilot_end_at`, CHECK ordered), `maximum_runs`
(CHECK `1..3`), `maximum_records_per_run` (CHECK `1..1000`), `runs_used` (CHECK `0..maximum_runs`), and the S3 hard invariants
`discovery_only`/`promotion_disabled`/`manual_only`/`customer_kill_switch_required` (each CHECK `= true`) and `schedule_allowed`
(CHECK `= false`). Composite same-tenant FK `→ connectors(id, tenant_id)` makes cross-tenant enrollment structurally impossible.

**Lifecycle** (`pilot_status`): `draft → consent_pending → approved → enabled → {paused, completed, cancelled, expired, incident_hold}`.
Consent is required *before* approval; approval requires an active consent + all owners/bindings; enable requires the window open.
Terminal statuses are immutable. Structural caps: partial unique `cpe_one_enabled_pilot` on `(environment) WHERE status='enabled'`
(**one active pilot, period**) and `cpe_one_active_per_connector` on `(tenant, connector, provider) WHERE status` non-terminal.

## Admin functions (service_role only)

`admin_create_pilot_enrollment` (draft; validates staging + an active owned connector + customer-ref-when-real),
`admin_record_pilot_consent` (draft→consent_pending; opaque-evidence enforced — see consent model), `admin_approve_pilot_enrollment`
(consent_pending→approved; requires an active consent + owners + bindings), `admin_enable_pilot_enrollment` (approved→enabled; window
open; the one-enabled index is the structural cap), `admin_set_pilot_status` (paused/cancelled/completed/expired; terminal-immutable),
`admin_expire_stale_pilots`, `admin_withdraw_pilot_consent` (sets withdrawal + pauses), `admin_pilot_incident_hold` (→incident_hold;
sanitized), `admin_record_pilot_exit_review`, `admin_create_pilot_deletion_job` / `admin_approve_pilot_deletion_job` (planning +
approval ONLY — never executes a deletion; see retention & deletion doc).

## Runner functions (connector_runner only)

`runner_read_pilot` (sanitized status read), `runner_assert_pilot_authorized(pilot, tenant, connector, provider, cred_version,
approved_permissions, wants_schedule)` — **THE execution gate**: raises unless `status='enabled'` AND the exact config matches AND
owners present AND `now ∈ [start,end]` AND `runs_used < maximum_runs` AND `wants_schedule=false` (schedule disallowed) AND an active
non-withdrawn non-expired consent exists AND `connector_execution_permitted` (global/provider/env/tenant/connector kill switches) AND
the per-pilot `'pilot'`-scope kill switch is enabled; returns the approved permissions. `runner_record_pilot_run` increments
`runs_used` under the `0..maximum_runs` CHECK (the durable run cap). No admin_* function is reachable by connector_runner.

## Deny-all posture

All 5 tables (`connector_pilot_enrollments`, `_consents`, `_incidents`, `_exit_reviews`, `_deletion_jobs`) are Tier-2 deny-all:
RLS enabled, ZERO policies, revoke-all from anon/authenticated/connector_runner. All 14 functions are `SECURITY DEFINER` with
`set search_path=''` + schema-qualified references; EXECUTE is revoked from PUBLIC/anon/authenticated (the `0045` Supabase
`ALTER DEFAULT PRIVILEGES` fix), then granted `admin_*`→service_role, `runner_*`→connector_runner only. The `'pilot'` kill-switch
scope was added to `0044`'s `connector_kill_switches` CHECK. `scripts/test-rls.sh` masks all 5 tables + 14 functions in lockstep so
the RLS suite reflects the real hosted posture; `supabase/tests/connector_customer_pilot_test.sql` (PL0–PL8) proves every invariant.

## What this does NOT do

No production access. No customer token/secret/Graph call (the plane is metadata + gating only). No pilot is enabled. No promotion,
ever. No recurring/scheduled customer sync (`schedule_allowed=false`). No real deletion. Enabling one real pilot requires a separate,
explicit GO. RISK-007 remains OPEN; Phase C remains BLOCKED.
