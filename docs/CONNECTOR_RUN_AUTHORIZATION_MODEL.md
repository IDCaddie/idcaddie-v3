# Connector run authorization model (P5E10 control plane)

**Canonical source for: the provider-neutral connector execution control plane (migration `0044`).** A run is never a bare
`aws ecs run-task` — it is gated by a durable, human-approved **authorization** that binds the exact run configuration, is
**claimed** exactly once, protected by a **distributed lock with fencing**, and finalized through **lifecycle-enforced,
fencing-guarded** result functions. This activates nothing: `microsoft_entra` stays `certificationOnly`; RISK-007 remains OPEN;
Phase C remains BLOCKED; staging only (`0044` not applied to production).

## Tables (6 — the minimum for an explicit, enforceable lifecycle)

| Table | Purpose |
|---|---|
| `connector_run_authorizations` | the durable approval + full config binding + lifecycle (approval folded in: `approved_by`/`approved_at`/`approval_reason`) |
| `connector_run_attempts` | one execution attempt + its aggregate, sanitized result (result folded in — no separate result table) |
| `connector_run_locks` | the distributed run lock: one row per `(tenant, connector, provider)`, lease + monotonic **fencing generation** |
| `connector_run_alerts` | provider-neutral alert metadata (aggregate/sanitized only) |
| `connector_schedule_policies` | S2 schedule policy (DISABLED by default = the schedule kill switch) + cadence/window/limits |
| `connector_kill_switches` | multi-layer kill switches (global/provider/environment/tenant/connector/schedule); **fail-closed** |

All six are **Tier-2 deny-all**: RLS-enabled, ZERO policies, revoke-all from `anon`/`authenticated`/`connector_runner`. Every
mutation is via a `SECURITY DEFINER` function with a pinned empty `search_path` (schema-qualified refs).

## Authorization lifecycle (statuses)

```
draft ─approve─▶ approved ─claim─▶ claimed ─launch─▶ launch_attempted ─start─▶ running ─┬─▶ succeeded
   │                │                                                                     ├─▶ failed
   ├─cancel─▶ cancelled                                                                   ├─▶ timed_out
   └─expire─▶ expired                                                                     └─▶ ambiguous (durable)
```

- **`draft`** — created by `admin_create_run_authorization` (service_role). Config is hardened by CHECK constraints:
  `discovery_only = true`, `promotion_disabled = true`, `one_shot = true`, `run_mode = 'discovery_oneshot'` — a row that violates
  any is rejected.
- **`approved`** — `admin_approve_run_authorization` sets `approved_by`/`approved_at`/`approval_reason`; only from `draft`, only
  while unexpired. `expires_at` is mandatory.
- **`claimed`** — `runner_claim_authorization` (connector_runner) atomically transitions `approved → claimed` **only** with the
  full exact-config match (tenant/connector/provider/plan_hash/idempotency_key/credential_version/schema_version/task-def
  family+revision/image_digest + discovery_only/promotion_disabled/one_shot) and while unexpired, then opens attempt #1. A second
  claim of the same authorization fails (one-claim replay guard). `idempotency_key` is globally unique — one key → at most one
  authorization → at most one effective execution.
- **`launch_attempted` / `running` / terminal** — the runner result functions (below), each fencing-guarded.
- **`expired`** (approval TTL passed; `admin_expire_stale_authorizations` batch-marks) and **`cancelled`**
  (`admin_cancel_run_authorization`) can never be claimed.
- **`ambiguous`** — a launch whose outcome is unknown; **durable**, blocks automatic retry, and can never be re-claimed (only an
  admin investigates). Terminal states (`succeeded`/`failed`/`timed_out`/`ambiguous`) are **immutable** except idempotent safe-audit
  reconciliation (`runner_reconcile_result`).

## Config binding

The authorization stores the exact `plan_hash`, `idempotency_key`, `credential_version`, `schema_version`,
`task_definition_family`, `task_definition_revision`, `image_digest`, and the `discovery_only`/`promotion_disabled`/`one_shot`
flags. The runner recomputes the plan hash and passes the full config to `runner_read_authorization` (plan mode — no claim/write)
and `runner_claim_authorization` (run mode); any drift → the function fails closed. This is what makes a stale plan or a changed
image/revision unrunnable.

## Roles

- **`service_role`** — the admin lifecycle: create/approve/cancel/expire authorizations, upsert schedule policies + kill switches.
- **`connector_runner`** — the execution lifecycle only: read (plan-mode), assert-no-active-run, claim, lock (acquire/renew/release),
  launch/start/result/reconcile, alert, latest-state. No direct table DML on any control-plane table.
- **`anon` / `authenticated` / customer users / ordinary routes / UI** — **nothing** (RLS deny-all + revoked function EXECUTE).
  There is no public HTTP route and no customer UI over the control plane.

## Kill switches (fail-closed)

`connector_execution_permitted(tenant, connector, provider, environment)` returns true **only** when a `global` kill switch is
explicitly `enabled = true` **and** no applicable `provider`/`environment`/`tenant`/`connector` switch is `enabled = false`. Absence
of the global switch → blocked. The runner refuses execution unless permitted at every applicable layer. See
[locking + idempotency](./CONNECTOR_RUN_LOCKING_AND_IDEMPOTENCY.md) for the lock + fencing details.

## What this does NOT do

No connector runs because these tables exist. No RLS/BYPASSRLS change to existing tables. No canonical promotion (the control
plane has no path to `app_users`/`people`/identity matches). No schedule, service, or trigger. `certificationOnly` unchanged.
Migration `0044` is additive (CREATE/GRANT/REVOKE only) and is **not** hosted-applied to production.
