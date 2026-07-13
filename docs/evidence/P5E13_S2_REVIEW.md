# P5E13 — S2 scheduled-campaign review findings + disposition

Three focused, adversarial, read-only reviews of the bounded S2 scheduled control plane (v3 `0046` + tests; runner dispatcher +
entrypoint + deploy templates + tests). Staging only; `certificationOnly` unchanged; RISK-007 OPEN; Phase C BLOCKED. **No P0.**

## Reviewer 1 — schedule-policy lifecycle / slot idempotency / distributed locking / fencing

Held (verified): 4th distinct execution structurally impossible (`slot > max_slots` reject + unique `(policy,slot_number)` /
`(policy,scheduled_at)` / idempotency_key); duplicate-delivery idempotent (policy-row FOR UPDATE serializes; resolve by
`scheduled_at`); overlap prevented (assert_no_active_run + the active-authorization partial unique index); fencing on every terminal
writer; stuck-slot recovery refuses a live lock; auto-complete atomic; deny-all + grants correct + in the harness lockstep.

| # | Sev | Finding | Disposition |
|---|-----|---------|-------------|
| 1 | **P1** | `max_successful` cap bypassable when `max_successful < max_slots`: `scheduler_begin_slot`/`_finalize_slot` didn't re-check the policy cap or `enabled`, so slots materialized ahead of the cap could still begin+finalize past it. | **FIXED** — `scheduler_begin_slot` now re-checks `status='enabled'` AND `slots_succeeded < max_successful` at execution time (serial execution makes the committed cap read reliable). New **SP12** proves the cap holds with `max_successful=2 < max_slots=3`. (The campaign uses `max_successful = max_slots = 3`, so it was never reachable there, but the general defect is closed.) |
| 2 | **P3** | A `completed`/paused/disabled policy could still begin an already-materialized slot (same root cause). | **FIXED** by the same `status='enabled'` re-check in `scheduler_begin_slot`. |
| 3 | **P3** | Lock lease is caller-supplied with no floor tied to task runtime; a too-short lease → real provider-level overlap (DB stays consistent via fencing). | **Accepted/documented** — the only caller (the dispatcher) pins `LOCK_LEASE_SECONDS = 900` > the 10-min task max; the lease is a general 0044 concern and a hard floor would break the unit tests' 300s. Mitigated. |
| — | test gaps | `max_successful<max_slots` untested; the null-binding approve guard was vacuous; grace/before-start untested. | **Addressed** — SP12 (cap) + SP13 (null-binding approve rejection) added; the grace path is moot under the new counter-based slot numbering. |

Also adopted proactively (robustness, not a review finding): `scheduler_materialize_slot` now numbers slots by a **materialization
counter** (Nth distinct `scheduled_at` = slot N) instead of `(scheduled_at − campaign_start)/cadence`, so it is robust to the exact
EventBridge rate-schedule / `StartDate` first-fire timing. Duplicates still resolve by `(policy, scheduled_at)`.

## Reviewer 2 — AWS Scheduler / IAM / task execution / failure containment

**No findings.** Verified: IAM least-privilege (exactly `ecs:RunTask` scoped to the scheduled family + cluster; `iam:PassRole` for
the 2 exact roles to ecs-tasks only; no SM/service/wildcard/production); schedule DISABLED / flex-window OFF / 0 retries / tight
event age / count 1 / bounded window / input carries only policy-id + scheduled-time; at-most-once (one discovery, never retried,
no run-task/nested launch); caps only tighten and can't be loosened by injected env; failures classified + never auto-retried;
tenant/connector loaded from the DB not the input; fail-closed entrypoint; no leaks.

| # | Sev | Finding | Disposition |
|---|-----|---------|-------------|
| 1 | P3 | Trust policy pins `aws:SourceAccount` but not `aws:SourceArn` (the specific schedule). | **Accepted** — mitigated by the tightly-scoped permission policy; SourceArn is a chicken-and-egg with schedule creation. |
| 2 | P3 | `ecs:RunTask` uses `:*` across the scheduled family (any revision). | **Accepted** — mitigated: registering a revision needs `ecs:RegisterTaskDefinition` (not granted) and the schedule pins a specific revision. |

## Reviewer 3 — no-promotion / tenant isolation / logging / governance

**No findings.** Verified: promotion structurally impossible (policy + authorization CHECK-force discovery_only/promotion_disabled/
one_shot; the scheduled path reuses the discovery whose only write is the 0041 fact insert; zero writes to app_users/people/
identity); `certificationOnly` unchanged + dedicated entrypoint off the ordinary registry; staging-only CHECK + production-ref
hard-block; slot records store only sanitized aggregates (secret/DB-URL summaries rejected); governance banners consistent; synthetic
-only, no customer/UI/API surface. One cosmetic note (schedule template `_comment` lacked the literal RISK-007 banner) — **added**.

## Net

- **Fixed:** the P1 (`max_successful` cap re-check) + the completed-policy P3, plus the proactive slot-numbering robustness change;
  SP12/SP13 added; schedule-template banner added.
- **Accepted (documented):** lock-lease floor (dispatcher pins 900s), SourceArn-not-pinned, `ecs:RunTask :*`-per-family — each
  low-impact and mitigated.
- **Re-verified after fixes:** migration-safety green; RLS Docker suite green (SP0–SP13); runner `typecheck` + full suite + deploy:check green.
