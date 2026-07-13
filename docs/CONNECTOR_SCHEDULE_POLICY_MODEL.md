# Connector schedule-policy model (P5E13 · Gate S2)

**Canonical source for: the bounded schedule policy + execution slots + atomic slot materialization of migration `0046`.** Extends
the [authorization model](./CONNECTOR_RUN_AUTHORIZATION_MODEL.md) and [locking/idempotency](./CONNECTOR_RUN_LOCKING_AND_IDEMPOTENCY.md).
Staging only; `certificationOnly` unchanged; RISK-007 OPEN; Phase C BLOCKED. Activates nothing by itself.

## Purpose

Let ONE EventBridge Scheduler schedule launch a one-shot ECS task per slot that materializes exactly one authorization, claims it,
fences a lock, runs the existing discovery, and reconciles — with a **hard, DB-enforced cap** on the number of slots/executions.
No ECS service, no long-running worker, no permanent schedule.

## The schedule policy (`connector_schedule_policies`, extended by `0046`)

Binds, per `(tenant, connector, provider)` (one policy per connector): `environment` (CHECK `= 'staging'`), `cadence_seconds`,
`campaign_start_at`/`campaign_end_at`, `max_slots`, `max_successful` (CHECK `≤ max_slots`), the task-def `family`/`revision` +
`image_digest`, `credential_version`, `schema_version`, `discovery_only`/`promotion_disabled`/`one_shot_per_slot`/
`kill_switch_required` (each CHECK `= true`), `requested_by`/`approved_by`/`approved_at`, and `slots_materialized`/`slots_succeeded`
progress counters.

**Lifecycle** (`status`): `draft → approved → enabled → {paused, completed, failed, cancelled, expired}`. Admin functions
(service_role): `admin_create_schedule_policy` (draft; upsert), `admin_approve_schedule_policy` (requires all bindings non-null),
`admin_enable_schedule_policy` (requires the window still open; sets `enabled=true`), `admin_disable_schedule_policy`
(→ paused/completed/failed/cancelled; clears `enabled`). Fail-closed: nothing runs unless `status='enabled'`.

## Execution slots (`connector_schedule_slots`)

One durable record per scheduled execution: `policy_id`, `scheduled_at`, `slot_number`, `idempotency_key`, `authorization_id`,
`attempt_id`, terminal `status`, and **sanitized aggregate** result (`records_seen`/`facts_written`/`pages_seen`/`retry_count`/
`throttle_count`/`sanitized_summary`). Deny-all (RLS + zero policies + revoke from anon/authenticated/connector_runner). Stores **no**
secret/token/ARN/DB-URL/PII/raw-Graph/raw-task-ARN. Unique on `idempotency_key`, `(policy_id, slot_number)`, `(policy_id, scheduled_at)`.

## Atomic slot materialization (`scheduler_materialize_slot`, connector_runner)

Policy-row `FOR UPDATE` (serializes concurrent/duplicate deliveries), then: validate `status='enabled'` + window + kill switch;
**resolve a duplicate delivery** of the same `scheduled_at` → return the existing slot (no second execution); otherwise
`slot_number = slots_materialized + 1` (a **counter** — the Nth distinct fire is slot N, robust to the exact rate-schedule /
`StartDate` first-fire timing), reject if `> max_slots` or `slots_succeeded ≥ max_successful`; assert no active run (no overlap);
create ONE `approved` authorization (0044 CHECK-forced discovery-only) + the slot, keyed by a deterministic idempotency key binding
`policy/scheduled_at/slot/tenant/connector/provider/schema/cred/revision/digest`.

**Execution** (`scheduler_begin_slot`): re-checks `status='enabled'` + the success cap at execution time (so the cap holds even when
`max_successful < max_slots`), then claim + fenced lock + launch/start via the reused 0044 `runner_*`. **Finalize**
(`scheduler_finalize_slot`): records the terminal via the fenced `runner_record_*`, releases the lock, advances the counter, and
auto-completes the policy at `max_slots`/`max_successful`. **Recovery** (`admin_reconcile_stuck_slot`): only when the lock lease has
expired; refuses a live run.

## Why a fourth execution is structurally impossible

`max_slots = 3` + `slot_number` counter rejecting `> max_slots` + unique `(policy, slot_number)` + unique `(policy, scheduled_at)` +
unique `idempotency_key` + the `slots_succeeded ≥ max_successful` reject (at materialize AND begin) + the schedule `EndDate` +
Scheduler shutdown after slot 3. Both the DB and the scheduler cap independently; neither alone is trusted.

## Deny-all / grants

All new functions `revoke execute from public, anon, authenticated` (the Supabase default-privilege deny, per `0045`); admin_* →
service_role; scheduler_* → connector_runner (never admin_* to connector_runner). Verified on staging: request-role EXECUTE = 0.
