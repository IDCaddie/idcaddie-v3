# Connector run locking + idempotency (P5E10 control plane)

**Canonical source for: the distributed run lock, fencing, and idempotency semantics of migration `0044`.** Companion to the
[authorization model](./CONNECTOR_RUN_AUTHORIZATION_MODEL.md). Staging only; `certificationOnly` unchanged; RISK-007 OPEN;
Phase C BLOCKED.

## The distributed run lock (`connector_run_locks`)

One row per `(tenant_id, connector_id, provider)` (unique). Fields: `generation` (monotonic **fencing token**), `holder_*`,
`acquired_at`, `lease_expires_at`, `released_at`, `status ∈ {held, released, expired}`.

- **Acquire** (`runner_acquire_lock`) — an upsert that either creates the row (`generation = 1`) or, on conflict, takes it over
  **only if it is free/expired** (`status <> 'held'` OR `lease_expires_at <= now()`), incrementing `generation` and setting a fresh
  lease + holder. If the lock is currently **held with a valid lease**, the conflicting update matches zero rows → the function
  raises `lock is held (concurrent run)`. This is atomic (a single conditional `INSERT … ON CONFLICT DO UPDATE … WHERE`), so two
  concurrent acquirers cannot both win. The acquiring attempt's `fencing_generation` is stamped with the new generation.
- **Lease / TTL** — every acquire sets `lease_expires_at = now() + lease_seconds`. `runner_renew_lock` extends it; a crashed holder's
  lease simply expires, so the lock is not permanently deadlocked — a later acquirer takes it over (incrementing the generation).
- **Fencing** — `runner_assert_fencing(attempt, generation)` requires the caller's `generation` to equal **both** the lock's current
  `generation` and the attempt's stamped `fencing_generation`, with the lock `held` and the lease live. Every result-writing
  function (`runner_mark_launch_attempted`, `runner_record_task_identity`/`_start`/`_success`/`_failure`/`_timeout`/`_ambiguous`,
  `runner_renew_lock`, `runner_release_lock`) is fencing-guarded. **Consequence:** once a lock is taken over (generation bumped), the
  previous holder's generation is stale — it can no longer write a result, renew, or release. A stale holder that tries to release
  matches zero rows (it targets `generation = <old>`), so it cannot free a lock it no longer owns.
- **Release** — a terminal result (`succeeded`/`failed`/`timed_out`/`ambiguous`) releases the lock atomically as part of the same
  function, only for the matching generation.

### Concurrency proof

`connector_run_control_plane_test.sql` (CP4) proves: first acquire → generation 1; a held+valid lock re-acquire → conflict; an
expired-lease takeover → generation 2; a result write with the **stale** generation 1 → rejected (`stale fencing token`); the
current generation 2 finalizes + releases. Run against local Postgres under `scripts/test-rls.sh` (not mocks).

## Idempotency

Three layers, so one logical run has at most one effect:

1. **Authorization idempotency key** — `connector_run_authorizations.idempotency_key` is globally UNIQUE: one key → at most one
   authorization → at most one claim → at most one attempt.
2. **One active run per connector** — `runner_assert_no_active_run` (called inside `runner_claim_authorization`) rejects a claim if
   any authorization for the connector is in `claimed`/`launch_attempted`/`running`, or any attempt is `running`. `max_concurrent_runs`
   is CHECK-pinned to 1 in `connector_schedule_policies`.
3. **Discovery-fact idempotency** — the underlying `0041` `runner_insert_discovery_fact` uses `ON CONFLICT DO NOTHING` on
   `(tenant_id, source_provider, fact_type, signal_id)`, so a re-run (e.g. after a partial write) does not duplicate facts.

## Ambiguity + retry

A launch whose ECS outcome is unknown is recorded via `runner_record_ambiguous`: the attempt + authorization become **`ambiguous`**
(durable), the lock is released (so the connector is not deadlocked), and the authorization can **never** be re-claimed (it is not
`approved`). There is **no automatic retry** — a re-run requires a fresh admin-approved authorization under a new GO. Terminal
records are immutable except idempotent `runner_reconcile_result` (safe aggregate audit annotation).

## Sanitization

Alerts (`runner_record_alert`) reject a secret/token/ARN/DB-URL-shaped summary. `sanitized_task_id` is CHECK-constrained to not
begin with `arn:`. No control-plane column stores a secret, token, full ARN, DB URL, credential, or raw payload — only masked/hashed
identifiers and aggregate metadata.
