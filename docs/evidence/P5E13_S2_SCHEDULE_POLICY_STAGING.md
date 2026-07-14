# P5E13 — S2 schedule policy: staging apply + disabled proof (evidence)

**Status: implementation complete; S2 remains FAIL (live campaign not yet run — gated on the operator/CI-built scheduled image).**
Migration `0046` applied to staging; the DISABLED policy + scheduler role + DISABLED schedule are scaffolded and inert. Date
2026-07-13. Staging ref `ycdpz…` (production `dzbf…` untouched); `certificationOnly` unchanged; RISK-007 OPEN; Phase C BLOCKED.

## Migration 0046 applied to staging (sole pending migration)

`supabase migration list` showed `0043/0044/0045` applied, `0046` the only pending; `db push` applied `0046` (schedule-policy
extension + `connector_schedule_slots` + `scheduler_materialize_slot`/`_begin_slot`/`_finalize_slot`/`scheduler_policy_state` +
`admin_*_schedule_policy` + `admin_reconcile_stuck_slot`).

## Hosted verification (post-apply)

| Check | Result |
|---|---|
| `connector_schedule_slots` RLS on / 0 policies / 0 request-role table grants | ✓ true / 0 / 0 |
| slot unique constraints (`css_idem_unique`, `css_one_per_slot`, `css_one_per_scheduled`) | ✓ 3 |
| `csp_environment_staging_only` CHECK present | ✓ 1 |
| anon + authenticated EXECUTE on the 9 new functions | ✓ **0** (0045 deny-all pattern held) |
| connector_runner EXECUTE = exactly the 4 `scheduler_*` (no `admin_*`) | ✓ 4 / 0 |
| service_role admin lifecycle | ✓ (default-priv) |

## Disabled resources created (inert)

- **Schedule policy** `fe0dcc62…` — `status=draft`, `enabled=false`; `max_slots=3`, `max_successful=3`, `cadence_seconds=7200`,
  `discovery_only`/`promotion_disabled`/`one_shot_per_slot`/`kill_switch_required` all true, `environment=staging`. Task-def
  revision/digest + window are **placeholders**, re-bound to the approved digest + real window at activation.
- **Scheduler IAM role** `idcaddie-staging-entra-s2-scheduler` — trust: only `scheduler.amazonaws.com` + `aws:SourceAccount`;
  inline policy `entra-s2-runtask-passrole`: exactly `ecs:RunTask` (scoped to the scheduled family + cluster) + `iam:PassRole`
  (the 2 exact roles, to ecs-tasks). No Secrets Manager / service / wildcard / production.
- **EventBridge Scheduler schedule** `idcaddie-staging-entra-s2-schedule` — `State=DISABLED`, `rate(2 hours)`, `FlexibleTimeWindow
  OFF`, `RetryPolicy {MaximumRetryAttempts:0, MaximumEventAgeInSeconds:60}`, universal `ecs:runTask` target, `Count:1`, input carries
  **only** `IDCADDIE_RUNNER_SCHEDULE_POLICY_ID` + `IDCADDIE_RUNNER_SCHEDULED_AT` (`<aws.scheduler.scheduled-time>`) — no secret,
  tenant id, connector id, DB URL, or production value. Target task-def `…scheduled:1` is a placeholder repointed at activation.

## Disabled proof — nothing runnable, nothing executed

| Check | Result |
|---|---|
| schedule State | DISABLED |
| enabled schedules | 0 |
| schedule policy | draft / disabled |
| materialized slots | 0 |
| runnable authorizations | 0 |
| held locks | 0 |
| enabled kill switches | 0 |
| entra `connector_runs` | 2 (Phase 7 + S1; **unchanged** — no S2 run) |
| entra `discovery_facts` | 5 (**unchanged** — zero secret read / token request / Graph request) |
| ECS running / pending / services | 0 / 0 / 0 |

## What remains (blocked on the operator/CI image)

The scheduled entrypoint is new code and not in the S1 image; the operator/CI builds + scans + publishes the scheduled image and
returns the approved digest (see connector-runner `docs/evidence/P5E13_IMAGE_BUILD_HANDOFF.md`). Then the activation sequence runs:
register the scheduled task-def revision → repoint the disabled schedule target + re-bind the digest/window into the policy →
approve the policy → enable narrow kill switches → enable policy → enable schedule → observe ≤3 slots → disable → reconcile.
**S2 stays FAIL until that live campaign completes.** S3–S5 remain BLOCKED.

---

## Campaign results — S2 = PASS (2026-07-14)

The bounded live campaign ran end-to-end on staging: **exactly 3 scheduled slots, all succeeded, one ECS task each**, launched
solely by the EventBridge Scheduler (no manual `run-task`). Approved image `@sha256:f4563ad8…`, scheduled task-def revision 1.

| | Slot 1 | Slot 2 | Slot 3 |
|---|---|---|---|
| scheduled (UTC) | ~23:49 | ~01:49 | ~03:49 |
| status | succeeded | succeeded | succeeded |
| records_seen | 5 | 5 | 5 |
| pages | 1 | 1 | 1 |
| fencing generation | 2 | 3 | 4 |
| idempotency key | `slot-76cf0f74…` | `slot-7ff31b4d…` | `slot-895aaada…` |
| retry / throttle | 0 / 0 | 0 / 0 | 0 / 0 |
| lock released | yes | yes | yes |

- **Activation** `2026-07-13T23:44:49Z`; schedule window `23:49:24Z → 05:49:24Z`; **campaign ended ~`03:52Z`** (shutdown after slot 3).
- **Tasks:** 3 (one per slot). **Secret reads / token requests / Graph pages:** 1 each per slot (3 / 3 / 3). **Aggregate records seen:** 15 (5 × 3).
- **Idempotency:** total Entra `discovery_facts` stayed **5** across all 3 runs (each run emitted 5, all deduped by 0041 `ON CONFLICT DO NOTHING`); each slot has a distinct deterministic idempotency key. **No-promotion:** all facts `review_status=pending`.
- **No overlap:** `running=0` between slots; one attempt/task per slot; each slot's authorization terminal before the next.
- **Logs:** each task emitted only the redacted `ENTRA_SCHEDULED_SLOT_SUMMARY {slotNumber,status,usersSeen,factsEmitted,pages}`; leak scans clean (no email/UPN/uuid/token/DB-URL/ARN).
- **Shutdown:** AWS schedule DISABLED; policy auto-completed (`completed`); global kill switch disabled (`connector_execution_permitted=false`); a 4th slot materialization was **rejected** (structurally impossible); 0 runnable authorizations, 0 held locks, 0 ambiguous; ECS idle 0/0/0; no other enabled schedule.

**Gate S2 = PASS.** Every Phase-16 criterion met. S3–S5 remain BLOCKED; `microsoft_entra` `certificationOnly`; RISK-007 OPEN; Phase C
BLOCKED; staging only; no production access. The disabled schedule + terminal policy are kept for audit.
