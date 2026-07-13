# P5E10–P5E12 control-plane review — findings + disposition

Three focused, adversarial, read-only reviews of the connector execution control plane (v3 migration `0044` + tests + harness
lockstep) and the runner S1/S2 integration (operator `microsoft-entra-controlled-run.mjs`, `microsoft-entra-live.ts`, prep docs).
Staging only; `certificationOnly` unchanged; RISK-007 OPEN; Phase C BLOCKED. **No P0 in any dimension.**

## Reviewer 1 — DB lifecycle / locking / idempotency / fencing / tenant isolation

Held (verified, not asserted): atomic single-claim; atomic lock acquire with expired-lease takeover + monotonic fencing; every
lifecycle writer fencing-guarded; terminal immutability; ambiguous durable + never re-claimable; tenant isolation (composite FK +
config-bound checks); `search_path=''` on all definer functions; deny-all RLS on all 6 tables; idempotency (unique key + reconcile).

| # | Sev | Finding | Disposition |
|---|-----|---------|-------------|
| 1 | **P1** | Crash mid-run bricks a connector: a stuck `claimed`/`launch_attempted`/`running` authorization blocks every future claim; the timeout writer needs a live fenced lock the dead runner no longer holds; no function-only recovery existed (only a raw `service_role` UPDATE). | **FIXED** — added `admin_reconcile_stuck_run` (service_role): refuses a live run (held lock + valid lease), else marks the active attempt + authorization `timed_out` and expires the lock. Proven by **CP11**. |
| 2 | **P2** | Kill switch was advisory: `connector_execution_permitted` was never called by any durable transition — a `connector_runner` could claim/lock/launch with the switch off. | **FIXED** — `runner_claim_authorization` now calls `connector_execution_permitted` first and raises `execution blocked by kill switch`. Fail-closed at the DB. Proven by **CP10**. |
| 3 | **P2** | Harness lockstep (`test-rls.sh`) omitted `runner_assert_fencing`, so the RLS suite did not mirror the real deny for 1/24 functions. | **FIXED** — added `runner_assert_fencing` (and the new `admin_reconcile_stuck_run`) to the re-revoke list. |
| 4 | **P2** | `assert_no_active_run` is a non-locking SELECT (TOCTOU): two distinct approved authorizations for one connector could both reach `claimed` (the lock still blocks double *execution*, but the loser is orphaned — the P1 brick). | **FIXED** — added partial unique index `cra_one_active_per_connector` on active statuses. Only one authorization can hold an active status; a raced second claim's commit fails. Proven by **CP12**. |
| 5 | **P3** | `runner_acquire_lock`/`runner_renew_lock` did not validate `p_lease_seconds` (null → un-takeover-able lock; negative → instantly expired). | **FIXED** — both raise `lease seconds must be positive` on null/≤0. |
| 6 | **P3** | CP5 immutability assertion passes via fencing (lock already released), so the terminal `result_status in ('running')` guard is not independently exercised. | **Documented** — the guard is belt-and-suspenders behind fencing; new CP10–CP12 add independent coverage of the claim/recovery/uniqueness paths. Left as-is. |
| 7 | **P3** | `runner_reconcile_result` / `runner_record_alert` are not fencing-guarded; alert `attempt_id`/`authorization_id` are plain (non-composite) FKs — a confused runner could annotate aggregates or attach an alert referencing a cross-tenant id. | **Documented (accept)** — both are terminal-only/`coalesce`-`greatest` (reconcile) or audit-metadata inserts (alert); no execution effect, no secret stored. Tenant/connector on the alert row are still composite-FK-checked. Low risk; deferred. |

## Reviewer 2 — operator execution / ambiguity / retries / timeouts / throttling / kill switches

Held: durable-run order (kill-switch → read-approved → claim → lock → mark-launch **before** ECS → one run-task → record); no
retry on ambiguous/failed (durable `runner_record_ambiguous`); fail-closed kill switch before any claim/launch; authorization
binding (plan_hash/idempotency/credential/schema/revision/digest); fencing threaded into every record call; masked output;
`s2-plan` is a disabled dry-run (zero run-task, no schedule/service); `classifyEntraFailure.retryable` is advisory and unread.

| # | Sev | Finding | Disposition |
|---|-----|---------|-------------|
| 1 | **P2→fixed** | `run-task` had no `--client-token`; the AWS CLI's internal throttle/timeout retry could launch a **second** task inside one invocation, defeating at-most-once (the durable `mark_launch_attempted`/`claim` only guard a second *operator* invocation). | **FIXED** — `runTaskClientToken(attemptId, gen)` derives a deterministic ≤64-char idempotency token; `buildRunTaskArgs` appends `--client-token`; a CLI-internal retry returns the same task. New operator test asserts presence + determinism. |
| 2 | **P3** | `realAws`/`realDb` `spawnSync` have no `timeout`; a wedged CLI hangs the operator (durable `mark_launch_attempted` still preserves at-most-once). | **Documented (accept)** — liveness only; the operator is a manual one-shot; a hung CLI is operator-visible (Ctrl-C). Deferred. |
| 3 | **P3** | On ambiguous/throw the lock is not explicitly released; relies on `record_ambiguous` (terminal → releases) or the 600 s TTL. | **Documented** — `runner_record_ambiguous` **does** release the lock (verified in `0044`); the TTL is the fallback. No change. |
| 4 | **P3** | `authorize` mode creates + self-approves in one invocation (`approvedBy` defaults `"sam"`). | **Documented (accept)** — intentional for the single-operator staging synthetic run; the named-approval-chain separation is a required control for S3+ (customer/production) per the prep docs. |

## Reviewer 3 — governance / customer boundary / production separation / no-promotion / leakage

Held: no canonical-promotion path (CHECK-forced discovery_only/promotion_disabled/one_shot + no `app_users`/`people`/identity
write anywhere; ECS task's sole write remains the `0041` discovery functions); `certificationOnly` unchanged in the registry;
S3/S4/S5 docs are preparation-only and keep those gates BLOCKED; no secret/PII/DB-URL/real-id leak; production ref appears only as
a hard-block anti-target; governance banners (RISK-007 OPEN, Phase C BLOCKED, staging-only) consistent across all artifacts.

| # | Sev | Finding | Disposition |
|---|-----|---------|-------------|
| 1 | **P3** | Staging AWS account id + two staging IAM role ARNs are hardcoded pinned constants; the account id is emitted (unmasked) in the plan summary. | **Documented (accept)** — non-secret pinned *validation* constants (fail-closed target allow-list); ARNs are never printed, the digest is masked. By design. |
| 2 | **P3** | `runner_record_alert` DB-URL sanitizer missed `postgresql://` and Supabase `.co` hosts. | **FIXED** — regex now catches `postgres(ql)?://`, any `scheme://user@host`, and `.co`/`.io`/`.dev` hosts. Defense-in-depth (runner passes only aggregate summaries; no column holds raw values). |

## Hosted verification finding (caught applying to staging — the static reviews could not see it)

| # | Sev | Finding | Disposition |
|---|-----|---------|-------------|
| H1 | **P0** | After `0044` was applied to staging, `anon` and `authenticated` held EXECUTE on **all 25** control-plane `SECURITY DEFINER` functions (incl. `admin_upsert_kill_switch`) — reachable via PostgREST RPC. Cause: Supabase's `ALTER DEFAULT PRIVILEGES` grants EXECUTE to `anon`/`authenticated` on function creation; `0044`'s `revoke … from public` removed only the PUBLIC grant, not the explicit role grants. The local RLS harness masked it (it re-revokes from `anon`/`authenticated` in a **test-only** lockstep, so `0044` alone was never tested against the real Supabase default-privilege behavior). | **FIXED** — migration `0045_control_plane_deny_request_role_execute.sql` revokes EXECUTE from `public, anon, authenticated` on all 25 functions. Applied to staging; re-verified: `request_role_execute_count = 0`. New **CP9b** asserts zero anon/authenticated EXECUTE at the ACL level (also catches lockstep incompleteness). `service_role`'s default-privilege EXECUTE is left as-is (trusted server-only key). |

**This is the highest-severity finding of the pass, and it existed in the already-committed `0044` (`d84cc00`).** It was invisible to the three static reviewers and to the local Docker suite; only hosted role-boundary verification exposed it — which is precisely why the GO mandates that step before any live run.

## Net

- **Fixed:** the P1 (crash recovery) + three P2s (DB-enforced kill switch, active-authorization uniqueness backstop, harness
  lockstep) + three P3s (lease validation, client-token idempotency, alert-sanitizer regex).
- **Documented / accepted:** four P3s (terminal-guard coverage, subprocess timeout, authorize self-approve, staging pinned constants)
  — each low-impact, deferred with rationale above.
- **Re-verified after fixes:** migration-safety green; RLS Docker suite green (CP0–CP12); runner `typecheck` + `test` (670) +
  `vendor:verify` + `deploy:check` green.
