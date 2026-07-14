# P5E14 — customer-pilot control plane: S3 readiness (evidence)

**Status: implementation + local validation + 3-reviewer review COMPLETE; hosted staging apply of `0047` PENDING (needs the staging
DB credential — the CLI is linked to `ycdpz…` but not authenticated for a `db push` write). Gate S3 = BLOCKED** (cannot move to
READY FOR ONE PILOT until the hosted apply + verification below pass). Date 2026-07-14. Staging ref `ycdpz…`; production `dzbf…`
**untouched**; `certificationOnly` unchanged; RISK-007 OPEN; Phase C BLOCKED. No customer data, no pilot enabled, no S4.

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

### Hosted results (fill on apply)

| Check | Result |
|---|---|
| `0047` sole pending → applied | _pending_ |
| 5 tables: RLS on / 0 policies / 0 request grants | _pending_ |
| anon+authenticated EXECUTE on 16 pilot fns | _pending_ (expect 0) |
| connector_runner EXECUTE = exactly 4 runner fns / 0 admin | _pending_ |
| indexes/constraints/`'pilot'` scope present | _pending_ |
| non-synthetic enrollments | _pending_ (expect 0) |
| synthetic lifecycle + 2nd-pilot/cross-tenant/schedule rejections | _pending_ |
| fixtures cleaned; ECS idle; runs/facts unchanged; no secret/token/Graph | _pending_ |

## S3 acceptance criteria (Phase 11) — current standing

| # | Question | Standing |
|---|---|---|
| 1 | One customer tenant can enroll without weakening isolation? | **Yes (local-proven)** — composite same-tenant FK + deny-all; cross-tenant rejected (PL6). Hosted re-proof pending. |
| 2 | Consent/scope/retention/ownership/deletion/incident/rollback durable + enforceable? | **Yes (local-proven)** — DB-enforced (PL1–PL9). Hosted re-proof pending. |
| 3 | Connector executes ONLY for an explicitly approved pilot tenant? | **Yes (local-proven)** — mandatory gate + `runner_assert_not_pilot_governed` closes the synthetic bypass. Hosted re-proof pending. |
| 4 | Discovery-only + promotion-disabled? | **Yes** — CHECK-forced at DB + forced in the runner. |
| 5 | All pilot activity stoppable immediately + auditable? | **Yes (local-proven)** — 6-layer kill + incident hold + status; reconstructable from the tables. |
| 6 | Ready for one controlled pilot, or stay blocked? | **BLOCKED** — pending the hosted apply + verification above; then a separate pilot GO. Never PASS. |

**Gate S3 = BLOCKED** (implementation + local proof + review COMPLETE; hosted validation is the remaining gate). Moving S3 to
**READY FOR ONE PILOT** requires the hosted results above to pass. Enabling a real pilot is a further, separate explicit GO. S4/S5
remain BLOCKED; no production access.
