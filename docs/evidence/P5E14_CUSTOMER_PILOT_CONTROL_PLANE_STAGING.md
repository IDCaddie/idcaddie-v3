# P5E14 — customer-pilot control plane: S3 readiness (evidence)

**Status: implementation + local validation + 3-reviewer review + HOSTED STAGING VERIFICATION all COMPLETE and GREEN. Migration
`0047` is applied to staging and every hosted check passed. Gate S3 = READY FOR ONE PILOT** (never PASS). Date 2026-07-14. Staging ref
`ycdpz…`; production `dzbf…` **untouched**; `certificationOnly` unchanged; RISK-007 OPEN; Phase C BLOCKED. No customer data, no
customer execution, no pilot enabled, no S4. Enabling one real pilot is a further, separate explicit GO.

Canonical model: [`CONNECTOR_CUSTOMER_PILOT_MODEL.md`](../CONNECTOR_CUSTOMER_PILOT_MODEL.md),
[`CONNECTOR_CUSTOMER_CONSENT_MODEL.md`](../CONNECTOR_CUSTOMER_CONSENT_MODEL.md),
[`CONNECTOR_PILOT_RETENTION_AND_DELETION.md`](../CONNECTOR_PILOT_RETENTION_AND_DELETION.md).

## What was built (staging only; activates nothing)

- **Migration `0047`** — the provider-neutral customer-pilot control plane: 5 Tier-2 deny-all tables
  (`connector_pilot_enrollments`/`_consents`/`_incidents`/`_exit_reviews`/`_deletion_jobs`) + 16 `SECURITY DEFINER` functions
  (11 `admin_*` → service_role; 4 `runner_*` → connector_runner; 1 internal opaque-reference guard). Adds the `'pilot'` scope to
  `0044`'s `connector_kill_switches` CHECK. One enabled pilot (partial unique index); one active per connector; manual-only;
  discovery-only; promotion-disabled; `schedule_allowed=false`; retention 1..90; ≤3 runs; composite same-tenant FK for isolation.
- **Runner** (connector-runner) — the fail-closed pilot gate (`microsoft-entra-pilot-gate.ts`), the permission/consent validator
  (`microsoft-entra-pilot-permission.ts`; NO customer token acquired — synthetic claim fixtures), the pilot-run orchestrator
  (`microsoft-entra-pilot-run.ts`; gate → reserve-run → ONE bounded discovery → never retried), the manual entrypoint's
  customer-pilot mode + the scheduled entrypoint's manual-only refusal, and the mandatory-gate assertion on the synthetic path.

## Local validation — GREEN

- `scripts/check-migration-safety.sh` — passed (forward-only; `0047` sole new migration).
- **Docker RLS suite** (`scripts/test-rls.sh` — applies ALL migrations incl. `0047` to a throwaway postgres:16, runs the pilot
  test) — **passed**; `connector_customer_pilot_test.sql` **PL0–PL9 all assertions pass**: deny-all posture, lifecycle +
  consent-before-approval gates, opaque evidence + opaque customer reference, the execution assertion gate + each fail-closed
  condition, run-limit + counting + incident hold, one-enabled + one-active + terminal-immutability, cross-tenant composite-FK
  rejection, retention bounds + deletion planning (no auto-execute), role boundaries (anon/authenticated = 0 EXECUTE;
  connector_runner = exactly the 4 runner functions, 0 admin), and the review-hardening cases (opaque customer ref, generic
  credential-URL + PEM sanitizers, mandatory pilot gate).
- **connector-runner** — `tsc` clean; **733 tests pass**; `vendor:verify` OK (28 files); `deploy:check` OK (19 files).

## Review (Phase 13) — 3 adversarial reviewers; all confirmed findings FIXED

| # | Sev | Finding | Resolution |
|---|---|---|---|
| R1-F1 | **P1** | `customer_account_reference` had no opacity guard (could hold an email/name) | shared `connector_pilot_ref_is_sensitive` applied to the customer ref (PL9) |
| R2-F2 | P2 | pilot gate not mandatory — a customer connector could run via the synthetic path | `runner_assert_not_pilot_governed` + wired into the synthetic discovery (PL9) |
| R2-F1 | P2 | run cap counted, didn't bound executions | reserve-before-run (atomic slot consume, fatal on fail) |
| R1-F2 | P2 | DB-URL reject postgres-only | generic `scheme://user:pass@` in the shared guard (PL9) |
| R1-F3 | P2 | incident/exit sanitizers dropped the PEM branch (drift) | single shared guard restores it (PL9) |
| R3-D1 | P2 | secret-expiry validator failed open on a malformed timestamp | fail-closed on malformed input |
| R1-F4 | P3 | window check not NULL-safe | explicit null guard |

Everything else the reviewers tried to break held (isolation FK, consent-before-approval, all six kill-switch layers,
no-promotion, no-retry, incident/rollback with no path back to enabled, deny-all + role boundaries, RLS-harness lockstep).

## Phase 14 — hosted staging validation (TO RUN — small, reviewable, read-only except the one apply)

> Requires the staging DB credential. Production ref `dzbf…` must never appear. Run each as its own reviewable command.

1. **Confirm sole pending:** `supabase migration list` → `0043/0044/0045/0046` applied, **`0047` the only pending**.
2. **Apply (the one write):** `supabase db push` → applies `0047` only.
3. **Verify (read-only), record results in the table below:**
   - 5 pilot tables: `relrowsecurity=true`, `0` policies, `0` request-role table grants each.
   - `anon`+`authenticated` EXECUTE on the 16 pilot functions = **0**; `connector_runner` EXECUTE = exactly the 4 `runner_*`
     (`runner_read_pilot`/`runner_assert_pilot_authorized`/`runner_record_pilot_run`/`runner_assert_not_pilot_governed`), 0 `admin_*`.
   - constraints/indexes present: `cpe_one_enabled_pilot`, `cpe_one_active_per_connector`, `cpe_same_tenant_connector` FK,
     `cpe_schedule_disallowed`/`_discovery_only_true`/`_promotion_disabled_true`/`_manual_only_true`, retention/runs bounds;
     `'pilot'` in `cks_scope_check`.
   - **no customer pilot exists:** `select count(*) from connector_pilot_enrollments where is_synthetic=false` = **0**.
4. **Synthetic lifecycle proof (fixtures, cleaned up after):** create → consent → approve → enable a SYNTHETIC pilot; prove a
   SECOND enabled pilot is rejected; a cross-tenant enrollment is rejected; a scheduled pilot (`wants_schedule=true`) is rejected;
   the mandatory-gate assertion refuses a governed connector on the synthetic path. **Delete all fixtures** — no runnable pilot remains.
5. **Inertness:** ECS running/pending/services = 0/0/0; entra `connector_runs`/`discovery_facts` unchanged; no secret read / token
   request / Graph request / customer execution; enabled pilot kill switches = 0.

### Hosted results (2026-07-14 — applied + verified)

Verification run as the pooler `postgres` role via `psql -w` (`PGPASSFILE`; no secret printed), each script separately with
`ON_ERROR_STOP=1`. Scripts (reviewable): `hosted-verify-{1-schema,2-acl,3-lifecycle,4-dormancy}.sql`, each pre-validated against a
local throwaway Postgres with all migrations applied before running on staging.

| Check | Result |
|---|---|
| `0047` recorded remotely (`0047 connector_customer_pilot`) | ✓ applied; sole new migration |
| 5 tables: RLS on / 0 policies / 0 request-role table grants | ✓ 5 / RLS=t / 0 policies / 0 grants |
| 13 enrollment CHECKs (staging-only, discovery/promotion/manual=true, schedule=false, kill-switch=true, retention 1..90, runs 1..3, runs_used bound, window order, customer-ref-when-real) | ✓ all present |
| composite same-tenant FK `→ connectors(id,tenant_id)` + partial-unique `cpe_one_enabled_pilot` + `cpe_one_active_per_connector` | ✓ present |
| `'pilot'` scope in `0044` `cks_scope_check` | ✓ present |
| **anon + authenticated + PUBLIC EXECUTE on the 16 pilot fns** | ✓ **0** (Supabase default privileges did NOT reintroduce request-role EXECUTE) |
| connector_runner EXECUTE = exactly the 4 `runner_*` / 0 `admin_*` / 0 table DML | ✓ exactly 4 / 0 / 0 |
| service_role EXECUTE on the 11 `admin_*` fns | ✓ 11 |
| every pilot SECURITY DEFINER fn has empty search_path | ✓ 0 unsafe |
| synthetic lifecycle — all 20 proofs (draft→consent→approval gates, owners, pause/withdrawal/expiry/incident block, cancel/expiry/completed terminal, 2nd-enabled + cross-tenant + one-active-per-connector rejected, mandatory-gate refusal, schedule disallowed, discovery-only/promotion-disabled/run-limit) | ✓ 20/20 PASS |
| lifecycle transactions end in ROLLBACK; **zero synthetic fixtures persist** | ✓ all 3 parts ROLLED BACK; total pilot enrollments = 0 |
| no customer pilot / enabled pilot / runnable pilot / pilot kill switch / consent / open incident / deletion job | ✓ 0 each |
| S2 schedule policy | ✓ `completed`, enabled=false (unchanged) |
| discovery_facts / connector_runs / promoted | 12 / 6 / 7 — **pre-existing baseline** from prior S1/S2/C-2c/promotion work; **P5E14 added 0** (all writes rolled back; no execution) |
| AWS: EventBridge Scheduler state / other enabled schedules | ✓ DISABLED / none |
| AWS: ECS running / pending / services / running-tasks | ✓ 0 / 0 / 0 / [] |
| no secret read / token / Graph / ECS launch / customer execution / production access | ✓ none (read-only SQL + rolled-back synthetic lifecycle + read-only AWS describe/get only) |

## S3 acceptance criteria (Phase 11) — current standing

| # | Question | Standing |
|---|---|---|
| 1 | One customer tenant can enroll without weakening isolation? | **Yes — hosted-proven** — composite same-tenant FK + deny-all; cross-tenant + one-active-per-connector rejected on staging (HV14/15/16). |
| 2 | Consent/scope/retention/ownership/deletion/incident/rollback durable + enforceable? | **Yes — hosted-proven** — DB-enforced end to end (HV1–HV20); consent-before-approval, expiry/withdrawal/incident block, deletion plan+approve only. |
| 3 | Connector executes ONLY for an explicitly approved pilot tenant? | **Yes — hosted-proven** — the fail-closed gate + `runner_assert_not_pilot_governed` refuse a governed connector on the synthetic path (HV mandatory-gate). |
| 4 | Discovery-only + promotion-disabled? | **Yes — hosted-proven** — CHECK-forced at the DB + forced in the runner (HV18/19); 0 promotion by P5E14. |
| 5 | All pilot activity stoppable immediately + auditable? | **Yes — hosted-proven** — 6-layer kill + incident hold + status all block execution (HV6/7/8/9); reconstructable from the tables. |
| 6 | Ready for one controlled pilot, or stay blocked? | **READY FOR ONE PILOT** — every hosted check passed; the plane is dormant (nothing enabled). Enabling one real pilot is a further separate GO. Never PASS. |

**Gate S3 = READY FOR ONE PILOT** (never PASS). Implementation + local proof + 3-reviewer review + hosted staging verification all
COMPLETE and GREEN; the control plane is applied and provably dormant. Enabling a real customer pilot requires a further, separate
explicit GO (a specific tenant, consent, credential provisioning, and a per-run authorization). S4/S5 remain BLOCKED; RISK-007 OPEN;
Phase C BLOCKED; no production access.
