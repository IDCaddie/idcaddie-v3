# P5E10 — control-plane privilege-escalation P0: fix review package

**Status: PAUSED for review. Staging dormant. No authorization / lock / attempt / ECS task / secret read / token request / Graph
request has occurred.** This package is the pre-live-run review of the hosted privilege-escalation P0 found while applying the
control plane to staging, and the `0045` fix. `certificationOnly` unchanged; RISK-007 OPEN; Phase C BLOCKED; staging only.

Linked project ref: `ycdpz…` (staging — **not** the production ref `dzbf…`).

---

## 1. The exact 0044 privilege failure

`0044` created 25 `SECURITY DEFINER` functions in schema `public` and ended with:

```sql
revoke all on function public.admin_create_run_authorization(…), … , public.runner_latest_run_state(…) from public;
grant execute on function <7 admin fns> to service_role;
grant execute on function <17 runner fns> to connector_runner;
```

On a vanilla Postgres, a new function's only default grant is `EXECUTE` to `PUBLIC`, so `revoke … from public` is sufficient for
deny-all. **On hosted Supabase it is not.** Supabase configures schema-level default privileges (`pg_default_acl`) that grant
`EXECUTE` on every new `public` function directly to `anon`, `authenticated`, and `service_role`. Those are *explicit role grants*,
not the `PUBLIC` grant — so `revoke … from public` does not remove them.

**Observed on staging immediately after applying 0044** (actual ACLs):

```
admin_upsert_kill_switch   → {postgres=X, anon=X, authenticated=X, service_role=X}
runner_assert_fencing      → {postgres=X, anon=X, authenticated=X, service_role=X}   ← intended for NO grantee
runner_claim_authorization → {postgres=X, anon=X, authenticated=X, service_role=X, connector_runner=X}
```

`anon:25, authenticated:25` — the request roles held `EXECUTE` on **all 25** functions. Because `public` is a PostgREST-exposed
schema, these `SECURITY DEFINER` functions (which run as the definer/`postgres`, bypassing RLS) were callable as **RPC endpoints by
any holder of the staging anon key** — e.g. `POST /rest/v1/rpc/admin_upsert_kill_switch` to flip the global kill switch, forge an
authorization, or drive the runner lifecycle. That is a genuine privilege-escalation / control-plane-tamper surface (staging +
synthetic data limits blast radius, but it directly defeats the deny-all model the S1 run depends on).

## 2. Why local tests failed to expose it

Two compounding reasons — the local suite could not see a Supabase-only mechanism:

1. **Vanilla Postgres has no Supabase default privileges.** The `scripts/test-rls.sh` Docker Postgres never runs Supabase's
   `ALTER DEFAULT PRIVILEGES … GRANT EXECUTE … TO anon, authenticated`, so a newly-created function there is *not* granted to
   `anon`/`authenticated`, and `revoke … from public` looks sufficient.
2. **The harness re-creates the deny in a test-only lockstep.** `test-rls.sh` blanket-grants `EXECUTE` on all functions to
   `authenticated` (to emulate Supabase), then re-revokes a hard-coded list of the control-plane functions. So the suite's
   `anon`/`authenticated` deny came from the *harness lockstep*, not from the migration — `0044`'s own `revoke` was never the thing
   under test. (This is also how the earlier P2 "lockstep missed `runner_assert_fencing`" hid: the lockstep, not the migration, was
   the source of truth.)

Net: the local suite proved "these functions end up denied *in the harness*," never "the migration itself denies them on Supabase."

## 3. The exact 0045 revocations

`0045_control_plane_deny_request_role_execute.sql` (additive; GRANT/REVOKE only):

```sql
revoke execute on function
  public.admin_create_run_authorization(uuid,uuid,text,text,text,text,text,text,integer,text,text,timestamptz),
  public.admin_approve_run_authorization(uuid,text,text), public.admin_cancel_run_authorization(uuid,text,text),
  public.admin_expire_stale_authorizations(), public.admin_reconcile_stuck_run(uuid,text,text),
  public.admin_upsert_schedule_policy(uuid,uuid,text,boolean), public.admin_upsert_kill_switch(text,text,boolean,text,text),
  public.connector_execution_permitted(uuid,uuid,text,text),
  public.runner_read_authorization(uuid,uuid,uuid,text,text,text,text,text,text,integer,text),
  public.runner_assert_no_active_run(uuid,uuid,text),
  public.runner_claim_authorization(uuid,uuid,uuid,text,text,text,text,text,text,integer,text,text),
  public.runner_acquire_lock(uuid,uuid,text,uuid,uuid,integer), public.runner_assert_fencing(uuid,bigint),
  public.runner_renew_lock(uuid,bigint,integer), public.runner_release_lock(uuid,bigint),
  public.runner_mark_launch_attempted(uuid,bigint), public.runner_record_task_identity(uuid,bigint,text),
  public.runner_record_start(uuid,bigint), public.runner_record_success(uuid,bigint,integer,integer,integer,integer),
  public.runner_record_failure(uuid,bigint,text,text,integer), public.runner_record_timeout(uuid,bigint,integer),
  public.runner_record_ambiguous(uuid,bigint,text), public.runner_reconcile_result(uuid,integer,integer,integer,integer,integer),
  public.runner_record_alert(uuid,uuid,text,uuid,uuid,text,text,text), public.runner_latest_run_state(uuid,uuid,text)
  from public, anon, authenticated;
```

All 25 functions; revoked from `public, anon, authenticated`. `service_role` (trusted backend key) and `connector_runner`
(execution role, explicit grants from `0044`) are deliberately left untouched. `0044` is immutable (already applied), so the fix is
a forward-only migration — it repairs the live staging DB now and every fresh DB via `0044 → 0045`.

## 4. Hosted proof — anon + authenticated now hold ZERO EXECUTE on all 25

After applying `0045` (re-query):

```
exec_grants_by_role      = "connector_runner:17, service_role:25"   (anon / authenticated absent entirely)
request_role_execute_count = 0                                      (ACL-level count of anon|authenticated EXECUTE across all 25)
```

Sample ACLs after `0045` (compare to §1):

```
admin_upsert_kill_switch   → {postgres=X, service_role=X}
runner_assert_fencing      → {postgres=X, service_role=X}
runner_claim_authorization → {postgres=X, service_role=X, connector_runner=X}
```

## 5. Hosted proof — connector_runner + service_role remain only as intended

`connector_runner` holds `EXECUTE` on **exactly the intended 17** (and nothing else):

```
connector_execution_permitted, runner_read_authorization, runner_assert_no_active_run, runner_claim_authorization,
runner_acquire_lock, runner_renew_lock, runner_release_lock, runner_mark_launch_attempted, runner_record_task_identity,
runner_record_start, runner_record_success, runner_record_failure, runner_record_timeout, runner_record_ambiguous,
runner_reconcile_result, runner_record_alert, runner_latest_run_state
```

— **no `admin_*`, and not `runner_assert_fencing`** (the internal fencing helper, intended for no direct grantee: its post-fix ACL
is `{postgres, service_role}`, with `connector_runner` correctly absent).

`service_role` holds `EXECUTE` on all 25 (via Supabase default privileges). **Disposition: accepted.** `service_role` is the trusted
server-side key (never exposed to browsers; already bypasses RLS); the design assigns it the admin lifecycle. Its default-privilege
`EXECUTE` on the runner/internal functions is an over-grant with no untrusted exposure. Tightening it (an explicit
`revoke … from service_role` on the runner/internal set) is available if you want strict least-privilege — say the word and I will
add it to `0045` scope; it is not required to close the untrusted-role exposure.

## 6. Should ALTER DEFAULT PRIVILEGES be corrected?

The staging default privileges for `public` functions (`pg_default_acl`), for both creating roles:

```
creating role = postgres        → {postgres=X, anon=X, authenticated=X, service_role=X}
creating role = supabase_admin  → {postgres=X, anon=X, authenticated=X, service_role=X}
```

So **yes — a future function created in `public` by a migration re-acquires the `anon`/`authenticated` EXECUTE grant** unless that
migration explicitly revokes it.

**Recommendation: do NOT globally mutate `ALTER DEFAULT PRIVILEGES`.** These are Supabase platform defaults that exist so
*intentionally-public* RPC functions are callable by `anon`/`authenticated` without boilerplate; the whole rest of the app (and
future work) relies on them. A blanket `ALTER DEFAULT PRIVILEGES … REVOKE EXECUTE … FROM anon, authenticated` would silently break
every intended-public function, must be set for two creating roles, and can be reasserted by Supabase on platform upgrades — high
blast radius, low predictability.

**Instead, make the deny explicit and enforced:**
- Every migration that adds a Tier-2 / deny-all function **must** `revoke execute … from public, anon, authenticated`. Codified as a
  convention alongside the existing "RLS on + zero policies + revoke-all" table pattern.
- Enforce it with tests that assert zero `anon`/`authenticated` EXECUTE at the ACL level, independent of the harness lockstep:
  **CP9b** (asserts it on the real 25 functions) and the new default-privilege regression test in §7 (asserts the *pattern* against
  the real Supabase mechanism). Either fails CI if a future function forgets the revoke.

This keeps intended-public RPC working while making deny-all functions fail-closed and test-guarded.

## 7. New regression test (fails against Supabase-style default privileges, not only the harness)

`supabase/tests/control_plane_default_privilege_test.sql` — self-contained; reproduces the Supabase condition itself:

1. `alter default privileges in schema public grant execute on functions to anon, authenticated;` (emulates the platform default,
   independent of `test-rls.sh`).
2. Creates a representative `SECURITY DEFINER` probe function.
3. **DP1** — applies the *0044 pattern* (`revoke … from public`) and asserts `anon` **still** holds EXECUTE → reproduces the exact
   failure mode. (If a future function's revoke were sufficient-by-accident, this assert flips and the test tells you why.)
4. **DP2** — applies the *0045 pattern* (`revoke … from anon, authenticated`) and asserts `anon`/`authenticated` EXECUTE is gone.
5. Cleans up (drops the probe, reverts the default-privilege change).

Verified green in the Docker suite under `ON_ERROR_STOP=1` — DP1's assert only passes because the failure is genuinely reproduced,
so this is a true regression guard, not a harness artifact. Unlike CP9b, it does **not** depend on the `test-rls.sh` lockstep.

## 8. Confirmation — nothing executed

Hosted control-plane state (read-only query):

```
authorizations = 0   attempts = 0   locks = 0   alerts = 0   schedule_policies = 0
kill_switches_total = 0   kill_switches_enabled = 0
```

Every durable run flows authorization → claim → lock → attempt → launch. **All are zero**, so no claim, lock, attempt, ECS
`run-task`, secret read, token request, or Graph request occurred via the control plane in this session. My action log for the
session is exclusively: file edits, local `npm`/`vitest`/`tsc`/RLS-Docker runs, read-only `supabase db query`, and
`supabase db push` (migrations `0044`, `0045`). I never invoked the operator `authorize`/`durable-run` modes or `aws ecs run-task`.

There is **1 pre-existing** `microsoft_entra` `connector_runs` row: `status=succeeded`, 5 discovery facts, created ~3.1 h ago, with
`cp_attempts_for_connector = 0` (not linked to the control plane). That is the earlier **Phase 7** controlled discovery run (the
pre-control-plane direct path), unrelated to and not launched by this session.

---

## What remains, gated on your explicit go

Synthetic approval/cancel/expiry records → confirm nothing runnable → create the exact S1 authorization → all preflights (incl.
first-time AWS/ECS credential verification) → **exactly one** live ECS discovery task → reconcile + release lock → verify ECS idle
/ no service / no schedule / no promotion → S2 disabled dry-run evidence → honest gate matrix (S1 PASS only if the run + every
durable-control proof pass; S2 FAIL/BLOCKED; S3–S5 BLOCKED) → final gates both repos → commit both locally (no push).

## Resolution (2026-07-13, after approval)

The fix and the "explicit revoke in every deny-all migration" pattern were **approved**; global default privileges left unchanged;
`service_role` not tightened this phase; the ACL regression tests retained (anon/authenticated zero EXECUTE; `connector_runner`
exactly the intended set; no `admin_*`; no internal fencing helper). The above sequence then **completed**: one durable S1 run
executed on staging (exit 0, `records_seen=5`, terminal `succeeded`, lock released, **no promotion**), ECS idle afterward, kill
switch returned to fail-closed; S2 disabled dry-run proven; S3–S5 BLOCKED. **Gate S1 = PASS.** Evidence: connector-runner
`docs/evidence/P5E10_ENTRA_S1_REPEAT_RUN.md` + `P5E11_ENTRA_S2_DRY_RUN.md`.
